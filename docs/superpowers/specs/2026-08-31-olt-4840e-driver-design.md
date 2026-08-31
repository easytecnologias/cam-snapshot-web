# Driver OLT Intelbras 4840E (EPON) — Design

## Contexto

O SightOps já tem um driver funcional pra Intelbras 8820i (GPON) e um pra VSOL
(EPON). A Intelbras 4840E (também EPON) só tem, hoje, a coleta de MACs em
massa (`collect_macs_4840e`, em `app/cli/tools/olt_4840e_collect_macs.py`).
Tudo o mais que envolve provisionar/consultar/excluir/reiniciar ONU nessa OLT
nunca foi implementado de verdade: `app/services/olt_service.py` já importa e
tenta chamar `collect_onu_telemetry_4840e`, `discover_onus_4840e`,
`find_onu_4840e`, `delete_onu_4840e`, `onu_signal_4840e` — nenhuma dessas
funções existe no driver. É o import quebrado documentado como pré-existente
nesta base (trabalho do Codex que ficou pela metade, nunca foi implantado em
produção). `app/services/olt_capabilities.py` também já afirma, incorretamente,
que a 4840E suporta `discover_onus`/`find_onu`/`delete_onu`/`onu_signal`.

Há duas OLTs 4840E reais em produção, ambas do cliente RADS (prefeitura):
"OLT - SANTANA" (100.64.10.5, ~50 ONUs autorizadas hoje) e "OLT - BARRA DE
SÃO MIGUEL" (100.65.10.200). Há uma terceira OLT do RADS (Japaratinga) que é
VSOL EPON — driver separado, fora de escopo aqui.

**Objetivo desta entrega:** implementar de verdade o núcleo operacional do
driver 4840E (consultar, autorizar, excluir, reiniciar ONU), isolado dos
outros drivers, e estender a tela de Implantação > ONU pra atender a
semântica EPON dessa OLT (identidade por MAC, endereçamento
`slot/pon/onu`, VLAN por porta ethernet da ONU).

## Fontes primárias usadas neste design

Toda a sintaxe de comando abaixo veio de duas fontes reais, não de suposição:

- Roteiro operacional do próprio técnico do cliente RADS
  (`ROTEIRO OLT 4840E INTELBRAS.txt`), cobrindo o fluxo real de autorizar,
  aplicar VLAN e excluir ONU nessa OLT específica.
- Manual oficial Intelbras 4840E em português (seções 9.1–9.11), cobrindo
  reinicialização de ONU e diagnóstico óptico por ONU.
- Exploração ao vivo, somente leitura, contra a OLT SANTANA (confirmando
  formato real de saída de `show onu-status`, `show white-list`, e a
  disponibilidade de `show mac-address-table interface pon <n>`).

Durante essa exploração houve um incidente relevante pro design: o comando
`reboot ?` (só pra ver a ajuda) fez a OLT exibir o prompt de confirmação real
de reboot da OLT inteira, não só a ajuda. O comando seguinte da fila (`conf
t`) funcionou como resposta implícita "n" (cancela — é o default `[n]`), e a
OLT não reiniciou (confirmado: a sessão continuou respondendo normalmente
por vários comandos depois; um reboot real desse hardware embarcado teria
derrubado a sessão SSH por bem mais tempo). Isso vira uma restrição de design
explícita abaixo (ver "Reiniciar ONU").

## Diferenças de modelo: GPON 8820i vs EPON 4840E

| | 8820i (GPON) | 4840E (EPON) |
|---|---|---|
| Identidade da ONU | número de série (`ITBS2C96E6A7`) | endereço MAC da ONU |
| Endereçamento | `pon` (1–8) + `onu`/posição, dois inteiros | trio `slot/pon/onu` (slot sempre `0`; pon 1–4; onu 1–64) |
| Autorização | um comando (`onu set gpon X onu Y serial-number ...`) | sequência com estado: garantir modo whitelist na PON → `white-list add mac` → ler de volta o onu-id atribuído |
| Descoberta de não-autorizada | comando dedicado, lista seriais novos | `show onu-status` lista todo MAC já visto na PON (autorizado ou não); os não-autorizados aparecem com `State: Down`, sem RTT/RegisterTime — cruzar com `show white-list` pra achar as candidatas |
| VLAN/serviço | um comando na ONU toda (`bridge add ... downlink\|tls`) | por porta ethernet da ONU: entra em `onu <endereço>` → `interface ethernet <n>` → `onu-vlan-mode tag vlan <N>` |
| Uso p/ câmera | não precisa de passo extra | precisa de `onu-p2p` (achado no roteiro do cliente como "liberando câmeras pra transmitir") |
| Telemetria/sinal | comando próprio já implementado | `show onu-status` (RTT/distância/estado) + `show onu-opm-diagnosis` dentro do contexto da ONU (RX/TX power em dBm, temperatura, tensão, corrente do laser) |
| Excluir | um fluxo | dois passos: `no onu-binding onu <endereço>` (desvincula posição) + `white-list del mac <MAC>` (tira da permissão) — os dois são necessários |
| Reiniciar | já implementado (`onu reboot gpon X onu Y`) | dentro do contexto `onu <endereço>`: `onu-reboot`, que pede confirmação `(y/n)?[n]` — precisa responder `y` explicitamente |
| Persistência | não precisa de passo explícito | toda mudança de config precisa de `copy running-config startup-config`, senão some num reboot da OLT |

## Decisões de escopo (confirmadas com o usuário)

- **Núcleo operacional completo** nesta entrega: consultar status/sinal,
  autorizar (whitelist + VLAN por porta), excluir, reiniciar. Paridade com o
  que a 8820i já tem.
- **Sem posicionamento explícito de ONU** — a OLT auto-atribui o próximo
  onu-id livre na PON ao dar `white-list add mac`; não expomos escolha manual
  de posição nesta entrega.
- **`onu-p2p` automático** ao autorizar — SightOps é focado em CFTV, então
  toda ONU autorizada por aqui já sai liberada pra transmitir, sem passo
  extra na tela.
- **Porta ethernet editável, com múltiplas linhas porta+VLAN** — por padrão
  1 linha (porta 1 + VLAN), com opção de adicionar mais linhas pra ONT
  multi-porta. Mesmo padrão que a 8820i já usa pra múltiplos serviços.
- **Otimização de performance da coleta de MACs fica de fora** — medido ao
  vivo: 27,7s pra 50 ONUs na SANTANA (mesma taxa por-ONU que a 8820i tinha
  antes da otimização, ~0,55s/ONU). Existe uma opção mais rápida
  (`show mac-address-table interface pon <n>`, ~2,5x mais rápida) mas ela
  perde a atribuição de qual ONU é dona de cada MAC — decidido manter o
  método atual (por ONU) pra não perder essa atribuição.
- **Fora de escopo**: posição explícita de ONU, upgrade de firmware da ONU,
  alarmes/thresholds de parâmetros ópticos, modos de autenticação
  LOID/híbrido (só MAC-auth whitelist, que é o que o roteiro do cliente
  usa), tela separada dedicada (decidido: mesmo menu, blocos condicionais
  por driver).

## Arquitetura

### Backend — novo arquivo, driver isolado

`app/cli/tools/olt_4840e_add_onu.py` (novo arquivo, espelhando o padrão já
usado pela 8820i: `olt_8820i_collect_macs.py` só coleta MAC,
`olt_8820i_add_onu.py` tem todo o provisionamento). O arquivo
`olt_4840e_collect_macs.py` não é tocado — o novo arquivo importa dele os
helpers de conexão já prontos e testados (`_open_shell`, `_cli`,
`_ensure_logged_in`, `_ensure_enable`, suporte a SSH legado).

Funções expostas:

- `discover_onus_4840e(olt_ip, user, password, pon="all", timeout=...)` —
  roda `show onu-status` + `show white-list` por PON, cruza os dois: MAC que
  aparece "Down"/sem RTT no primeiro e não está no segundo = candidata nova.
- `find_onu_4840e(olt_ip, user, password, mac, timeout=...)` — usa
  `show onu-status mac <mac>` pra resolver pon/onu a partir do MAC.
- `onu_signal_4840e(olt_ip, user, password, pon, onu, timeout=...)` —
  `show onu-status` (RTT/distância/tipo/estado) + entra em
  `onu <endereço>` e roda `show onu-opm-diagnosis` (RX/TX power,
  temperatura, tensão, corrente do laser).
- `collect_onu_telemetry_4840e(...)` — versão leve reaproveitando
  `onu_signal_4840e` por ONU já listada (preenche o que
  `collect_onu_telemetry` em `olt_service.py` já espera).
- `add_onu_4840e(olt_ip, user, password, pon, mac, description, ports, timeout=...)`
  — `ports` é uma lista de `{port, vlan}`. Sequência: confere
  `show onu-authenticate mode` da PON (só seta `mac-auth white-list` se não
  estiver assim — se estiver em outro esquema, retorna erro claro em vez de
  sobrescrever), `white-list add mac <MAC>`, lê de volta o onu-id atribuído
  (via `show white-list` ou `show onu-status mac <mac>`), entra em
  `onu <endereço>`, seta `onu-description`, pra cada entrada de `ports` faz
  `interface ethernet <n>` → `onu-vlan-mode tag vlan <N>` → `exit`, ativa
  `onu-p2p`, sai e roda `copy running-config startup-config`.
- `delete_onu_4840e(olt_ip, user, password, pon, onu, mac, timeout=...)` —
  `no onu-binding onu <endereço>` + `white-list del mac <mac>` na PON,
  depois salva.
- `reboot_onu_4840e(olt_ip, user, password, pon, onu, timeout=...)` — entra
  em `onu <endereço>`, manda `onu-reboot`, **espera explicitamente** o
  prompt de confirmação e manda `y` na mesma leitura (nunca depende do
  próximo comando da fila). Em nenhuma hipótese este driver envia o comando
  `reboot` (sem `onu-`) — só o reboot por-ONU.

### Backend — encaixe no `olt_service.py`

Sem modelos Pydantic novos. Os que já existem (`OltAddOnuRequest`,
`OltDeleteOnuRequest`, `OltOnuSignalRequest`, `OltRebootOnuRequest`,
`OltDiscoverOnusRequest`) já servem:

- `req.serial` carrega o MAC quando o driver é 4840E.
- `req.services[i].port` (`OnuServiceEntry.port: int = 0`, já existe e nunca
  foi usado) vira a porta ethernet de cada entrada porta+VLAN.
- `req.pon`/`req.onu` continuam os dois inteiros separados; o `slot` (sempre
  `0`) fica escondido dentro do driver.

Cada função (`add_onu`, `delete_onu`, `find_onu`, `onu_signal`,
`reboot_onu`) ganha um `elif _is_intelbras_4840e(req):` chamando as novas
funções — mesmo padrão que `discover_onus`/`collect_onu_telemetry` já usam
hoje pra essa checagem.

### Backend — capabilities

`olt_capabilities.py`: o bloco `intelbras_4840e` passa a ter
`discover_onus`, `find_onu`, `delete_onu`, `onu_signal` de verdade (hoje
afirmam suporte sem ter implementação), mais `add_onu: True` e
`reboot_onu: True`, novos. Nota atualizada de "autorização ainda bloqueada"
pra refletir que passa a funcionar.

### Frontend — mesmo menu, blocos condicionais por driver

Cada painel da sanfona em Implantação > ONU (Descobrir, Autorizar, Consultar
sinal, Reiniciar, Excluir) ganha um segundo conjunto de campos, escondido
por padrão, que aparece no lugar do conjunto atual quando a OLT escolhida é
4840E — mesmo mecanismo que já existe hoje pra trocar as opções de
"Serviço" por driver (`onuServiceOptionsHtmlForDriver`), agora aplicado ao
formulário inteiro do passo:

| Passo | 8820i (hoje) | 4840E (novo) |
|---|---|---|
| Descobrir | lista seriais novos | lista MACs vistos na PON e fora da whitelist |
| Autorizar | serial + perfil + serviço/VLAN | MAC + descrição + lista porta+VLAN (1 linha padrão, "+ adicionar porta") |
| Consultar sinal | serial/pon/onu | pon/onu (ou MAC) → RTT/distância/estado + RX/TX power/temperatura/tensão |
| Reiniciar | pon/onu | pon/onu (mesmo campo, comando muda por trás) |
| Excluir | pon/onu, modal de confirmação | pon/onu, modal de confirmação mostrando MAC/nome antes de excluir |

As funções JS existentes (`onuAdd`, `onuDelete`, `onuQuery`, `onuReboot`,
`loadOnuHistory`, o ticker de "ainda processando", o modal de confirmação)
continuam as mesmas — passam a checar o driver da OLT selecionada pra
decidir de qual conjunto de campos ler e qual payload montar, do mesmo jeito
que `onuUpdateServiceOptions` já faz hoje. O histórico de ações não muda: o
MAC entra no campo `serial` que já existe, a VLAN das portas entra no campo
`vlan` implementado na sessão anterior.

O seletor de PON (1–4 pra 4840E) já existe e não muda
(`onuPonCountForRow`).

## Tratamento de erro

- **Detecção de falha**: essa OLT responde erro como
  `% Invalid parameter, and error detected at '^' marker` /
  `% Incomplete command` / `% Unrecognized command` — vira o equivalente ao
  `command_failed()` que a 8820i já tem, adaptado a esse texto real.
- **Modo de autenticação da PON**: nunca sobrescreve silenciosamente um modo
  de autenticação diferente de `mac-auth white-list` já configurado numa
  PON — retorna erro claro pedindo confirmação manual nesse caso raro.
- **Salvar config**: se `copy running-config startup-config` falhar depois
  de uma ação que já teve sucesso na OLT, a ação NÃO é desfeita — o retorno
  avisa que a config pode não sobreviver a um reboot da OLT, mas a ação em
  si é reportada como bem-sucedida (ela já está em vigor).
- **Reiniciar ONU**: confirmação `y` sempre enviada de forma controlada,
  aguardando o prompt exato antes de responder — nunca inferida do próximo
  comando da fila.

## Testes

`scripts/sightops_olt_4840e_add_onu_test.py`, mesmo padrão de mock já usado
em `scripts/sightops_olt_8820i_add_onu_test.py` (FakeChannel/FakeSSHClient,
sem framework externo). Cobre: autorização idempotente do modo de
autenticação, leitura de posição após o whitelist, VLAN por porta (múltiplas
entradas), `onu-p2p` automático, ordem dos dois passos da exclusão,
confirmação explícita do reboot (com um teste que garante que o comando
`reboot` sozinho nunca é enviado pelo driver), e a lógica de descoberta
(Down + fora da whitelist = candidata).

## Validação em equipamento real

Antes de ir pra produção, o fluxo completo (autorizar → consultar →
reiniciar → excluir → autorizar de novo) é testado contra uma ONU real da
OLT SANTANA — o usuário autorizou usar a ONU `0/4/6` ("Caixa-20", MAC
`30:e1:f1:73:a7:19`, atualmente `Up`) pra rodar todos os testes (excluir,
adicionar, reiniciar). Por ser uma ONU real e em serviço, cada etapa
destrutiva (excluir) é confirmada e verificada (a ONU volta a ficar `Up`
depois de reautorizada) antes de seguir pra próxima, no mesmo padrão de
cuidado já usado nesta sessão para a 8820i.

## Efeito colateral

Implementar essas 5 funções resolve, de brinde, o import quebrado
pré-existente em `olt_service.py` que hoje impede rodar
`import app.main` localmente (documentado como dívida técnica desde antes
desta sessão) — deixa de existir ao final desta entrega.
