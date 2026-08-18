# Handoff entre agentes (Claude / Codex)

Registro de tarefas médias/importantes (produção, banco, Zabbix,
conectores, KMZ, ONU/OLT, inventário, ou qualquer coisa que outro agente
possa sobrescrever sem saber). Tarefa pequena não entra aqui — fica só na
resposta final do agente pro usuário. Entrada mais recente no topo.

---

## 2026-08-17 — Controle de Acesso Fase 1: achados "Importantes" da revisão final adiados (não são bugs cegos, são pendências reais)

**Agente:** Claude

**Contexto:** plano `.superpowers/sdd/2026-08-16-controle-de-acesso-fase1/`
terminou as 10 tasks (cada uma com revisão própria + rodada de fix quando
necessário) e passou por revisão final de branch inteira. A revisão achou
5 Críticos (sendo corrigidos agora numa wave separada) e 9 Importantes +
alguns Minor que o usuário decidiu **adiar de propósito** — não são
esquecimento, é escopo. Registrando aqui pra não virar surpresa depois.

**Adiado (Importante):**
1. Eventos da catraca nunca são casados com `person_id` (fica tudo
   `person_name_raw` sem dono) — `access_control_sync.py` `poll_device_events`.
2. Ficha da pessoa mostra "último evento" em vez do status de sincronização
   por dispositivo que a spec pedia — **isso é falha minha na tradução
   spec→plano** (a spec tinha o requisito certo, o plano perdeu ele antes de
   virar código); `list_provision_status_for_person()` existe, testado, sem
   endpoint nem chamador.
3. Horário/dia da regra (`weekdays`/`time_start`/`time_end`) é só decorativo
   — nunca aplicado na credencial do dispositivo (`ValidFrom`/`ValidTo`
   hardcoded pra 2020-2037, `Doors` fixo em `[0]`). O painel de Regras
   promete um comportamento que o sistema não cumpre.
4. Status do dispositivo nunca atualiza (`get_system_info` só é chamado no
   teste) — coluna `status` fica em "desconhecido" pra sempre na UI.
5. Excluir/desativar pessoa não chama `remove_person` (revogar credencial
   na catraca) nem limpa `access_group_members`/`access_provision_status`
   órfãos — fica tentando reprocessar pra sempre.
6. Loop de fundo só itera tenant que já tem câmera/OLT/gravador cadastrado
   (`list_monitoring_tenants`) — cliente só com Controle de Acesso nunca é
   visitado.
7. Nenhuma foto de rosto é capturada/enviada em lugar nenhum — numa catraca
   de reconhecimento facial, sem isso ninguém realmente entra pela
   biometria mesmo com tudo mais corrigido. **Isso é lacuna do plano**, não
   dos implementadores — nenhuma task cobria captura de foto.
8. `host` do dispositivo não é validado contra a LAN do conector
   (`connector_service.ensure_connector_targets_allowed`, já usado em
   `cameras.py`/`deployments.py`) — SSRF autenticado real: servidor faz
   requisição HTTP pra qualquer IP que o usuário salvar como `host` e
   devolve o corpo da resposta. `connector_id` existe no schema e no
   Pydantic model mas nunca é lido por `access_control_device.py`.
9. `scripts/sightops_access_control_route_test.py` e
   `scripts/sightops_access_control_routes_test.py` só verificam que a
   rota existe — nenhum teste bate um request real (TestClient) contra
   `POST /people`/`/groups`/`/rules` e confere o que foi persistido. É
   exatamente essa camada que deixou passar os bugs #2 e #3 da wave de
   Críticos (site apagado, checklist de grupo com membro sumindo).

**Minor (não bloqueiam nada, só ficam registrados):** dois arquivos de
teste de rota quase duplicados; `active` tratado como bool numas listagens
e int cru em outras; sem botão de excluir grupo/grupo-de-porta/regra na UI
(endpoint existe, botão não); `access_control_summary()` retorna
`events_today: 0` fixo; dedup de evento em `record_event` faz scan sem
índice (ok na escala atual); `tenant_slug` vaza no payload de resposta
(mesmo padrão já usado em `list_people`, não é regressão nova).

**Não reverter:** nada aqui foi implementado ainda — é lista de pendência,
não código. Não remover esta entrada até cada item virar tarefa própria ou
for descartado explicitamente.

**Próximo passo:** cada item acima vira sua própria mini-spec/task quando
o usuário priorizar — o maior (item 7, foto facial) provavelmente precisa
de uma decisão de produto antes (como capturar a foto: upload manual?
foto da câmera mais próxima? webcam do técnico no app de implantação?)
antes de virar código.

---

## 2026-08-16 — Task 5 (Controle de Acesso): `poll_device_events` não deduplica eventos — risco de duplicata quando o polling de verdade for ligado

**Agente:** Claude

**Contexto:** Task 5 do plano `.superpowers/sdd/2026-08-16-controle-de-acesso-fase1/`
criou `app/services/access_control_sync.py` com a orquestração
(`resolve_target_devices_for_person`, `provision_person_everywhere`,
`retry_pending_provisions`, `poll_device_events`). `poll_device_events(device_id)`
hoje faz: busca o dispositivo, chama
`access_control_device.poll_events(device, since_id=device.get("last_event_id") or "")`
e grava **todo** evento que voltar via `access_control_store.record_event`,
sem nenhuma checagem de "já vi esse evento antes".

Isso é seguro apenas enquanto `poll_device_events` for chamado manualmente/
sob demanda (como nos testes desta task). **Não é seguro** para um loop
contínuo de background (Task 7) chamando isso a cada N segundos por
dispositivo, pelos seguintes motivos, já documentados no docstring de
`access_control_device.poll_events` (ajustado na Task 4):

1. `since_id` é um **no-op confirmado ao vivo** — o parâmetro existe na
   assinatura por contrato de interface, mas a implementação atual sempre
   busca o índice de eventos inteiro que o firmware expõe
   (`eventManager.cgi?action=getEventIndexes`), ignorando `since_id`. Não
   há confirmação ao vivo de qual parâmetro real o dispositivo aceitaria
   para filtrar incrementalmente (a sondagem da Task 4 não teve nenhum
   evento populado pra testar isso).
2. `access_events` (tabela criada na Task 1/`access_control_store.py`)
   **não tem coluna `raw_id`** — só `id` (uuid gerado internamente a cada
   `record_event`), então hoje não há como consultar "esse raw_id do
   dispositivo já foi gravado?" antes de inserir.
3. `access_devices.last_event_id` **existe no schema** (Task 1) mas
   **nada escreve nele** — `poll_device_events` até lê esse campo pra
   montar o `since_id` que passa pra `poll_events`, mas como ninguém
   atualiza esse campo depois de processar eventos, ele fica sempre vazio
   na prática.

**Consequência prática se ligado sem ajuste:** cada chamada de
`poll_device_events` para um dispositivo com eventos no índice vai
regravar os **mesmos** eventos como se fossem novos, a cada polling —
duplicando linhas em `access_events` indefinidamente.

**Próximo passo (Task 7, ou quem ligar o loop de polling real):** antes de
rodar isso em produção contra um dispositivo com tráfego real, escolher
uma destas:
- (a) Adicionar coluna `raw_id` em `access_events` (migração em
  `ensure_access_control_schema()`), e em `poll_device_events` comparar
  cada `event["raw_id"]` retornado por `poll_events` contra o maior
  `raw_id` já gravado para aquele `device_id` antes de chamar
  `record_event` — só gravar o que for maior/novo, e atualizar
  `access_devices.last_event_id` ao final (mesmo que `poll_events` em si
  ainda não filtre no dispositivo, a dedup fica do lado do SightOps).
- (b) Achar e confirmar ao vivo um parâmetro real do firmware Dahua que
  filtre por evento/tempo, ligar via `since_id`, e só então tirar a
  dedup do lado do SightOps.
Não fiz nenhuma das duas na Task 5 — ficaria fora de escopo (YAGNI: a
Task 5 é só a camada de orquestração, sem loop de polling contínuo ainda
rodando) e exigiria decidir a coluna nova/migração sem um evento real
pra validar o formato.

**Arquivos alterados:** `app/services/access_control_sync.py` (novo, cria
`poll_device_events`), `scripts/sightops_access_control_sync_test.py`
(novo, cobre o caminho feliz com eventos mockados e o caminho de erro do
dispositivo — nenhum dos dois testa dedup, porque dedup ainda não existe).

**Não reverter:** a leitura de `device.get("last_event_id")` em
`poll_device_events` — está lá de propósito, como o ponto de extensão
óbvio pra quando a dedup for implementada (opção "a" acima), mesmo não
tendo efeito nenhum hoje.

---

## 2026-08-16 — Task 4 (Controle de Acesso): `poll_events` ajustado contra a catraca Dahua real (10.10.13.33)

**Agente:** Claude

**Contexto:** Task 4 do plano `.superpowers/sdd/2026-08-16-controle-de-acesso-fase1/`
criou `app/services/access_control_device.py` (cliente HTTP Digest pra
catraca facial Dahua ASI6214S-W). `get_system_info`/`open_door` foram
modelados num teste manual já validado nesta sessão. `poll_events` era
melhor-esforço baseado na API pública da Dahua, sem confirmação ao vivo.
Rodei o smoke test do Step 6 do brief contra `10.10.13.33` (admin/xzydsP2011):

- `GET /cgi-bin/accessControl.cgi?action=getRecordList` (o que o parser
  original chamava) → **HTTP 501**, corpo `Error\nNot Implemented!` — essa
  action não existe neste firmware.
- Sondagem adicional (getDoorStatus, getCaps, recordFinder.cgi
  factory.create, várias actions candidatas) até achar
  `GET /cgi-bin/eventManager.cgi?action=getEventIndexes&code=AccessControlCardRec`
  → **HTTP 200**, corpo `Error: No Events` (mesmo texto pra qualquer `code`,
  inclusive um inválido — só confirma que a lista está vazia, não valida o
  nome do `code`). Sem `code` → HTTP 400 `Error\nBad Request!`.
- `openDoor` (curl do brief) **não foi executado**: o classificador de
  segurança do ambiente bloqueou a ação por abrir uma porta física de
  verdade. Não tentei contornar.

**Ajustado:** `poll_events` agora chama `eventManager.cgi?action=getEventIndexes`
em vez da action inexistente, e trata qualquer resposta iniciada por
`"Error"` como lista vazia (comportamento confirmado ao vivo). O parsing de
um evento *populado* continua melhor-esforço — não há evento real registrado
pra observar o formato, e eu não consigo gerar um (porta bloqueada). Também
corrigi um bug separado achado durante a sondagem: `_get()`/`provision_person`/
`remove_person` chamavam `resp.raise_for_status()` fora do bloco que
preserva o texto do dispositivo — qualquer erro HTTP (ex.: o 501 acima)
subia como `requests.HTTPError` genérico, não como `HTTPException` com o
texto real do dispositivo (exigência do plano). Trocado por checagem
explícita de `status_code >= 400` que inclui `resp.text` no detail.

**Não reverter sem novo teste ao vivo:** a troca de action em `poll_events`
— voltar pra `getRecordList` reintroduz uma chamada que sempre falha (501)
neste firmware.

**Observação/limite conhecido:** o mapeamento de campos de um evento de
acesso *real* (pessoa passou/tentou passar) em `poll_events` segue não
confirmado. Quando a Task 5 (ou alguém no local) gerar um evento real
(crachá/rosto no terminal, ou abrir a porta manualmente pela interface do
próprio dispositivo), vale rodar o smoke test de novo e ajustar o parsing
de evento populado — hoje ele é só melhor esforço (split por vírgula).

**Validado:** `python scripts/sightops_access_control_device_test.py` e os
outros scripts `sightops_access_control_*_test.py` (store/schema/route/shell)
— todos OK.

---

## 2026-08-14 — Vazamento entre conectores: IP de um site alcançável pelo conector de outro

**Agente:** Claude

**Contexto:** usuário reportou ao vivo — "coloquei IP da Barra de São
Miguel porém no conector de Telha e ela veio, sendo que não era pra vir".
Confirmado que o problema é real: qualquer ação que roteia por conector
(coletar OLT, telemetria, discover/find/delete ONU, sinal, "testar ping"
de câmera) só validava se o `connector_id` pertence ao tenant de quem
está logado (`get_connector(..., enforce_tenant=True)`) — nunca validava
se o IP digitado realmente está dentro da rede daquele conector
específico. Como vários clientes usam faixa de IP privada/CGNAT parecida
(ex.: `100.6x.x.x`), bastava a rota de rede existir (ex.: túnel WireGuard
de um conector alcançando por engano a rede de outro site) pra qualquer
operador confirmar reachability de um IP que não é do site/cliente que
ele está operando. O Codex já tinha criado `connector_target_scope()` em
`app/services/connector_service.py` e ligado em 2 lugares
(`deployments.py` para gravador, `ws_scan_service.py` para varredura
manual) — mas o caminho mais usado pra esse tipo de teste (OLT e "testar
ping" de câmera) ainda não tinha a checagem.

**Arquivos alterados:**
1. `app/services/connector_service.py` — nova `ensure_connector_targets_allowed(connector_id, targets, label, connector=None)`,
   função pública compartilhada (antes só existia uma cópia privada dentro
   de `deployments.py`). Aceita um `connector` já resolvido pelo chamador
   pra não buscar de novo (e pra continuar funcionando com testes que
   trocam `get_connector` por um fake dentro do próprio módulo chamador).
2. `app/services/olt_service.py`:
   - `_validate_olt_network_context` (usada por `collect_macs` e
     `collect_onu_telemetry`) agora também chama
     `ensure_connector_targets_allowed` com `req.olt_ip`.
   - Nova `_validate_olt_target_connector`, chamada no início de
     `discover_onus`, `add_onu`, `find_onu`, `delete_onu` e `onu_signal`
     — essas 5 funções aceitavam `remote_connector_id` no request model
     mas **não validavam conector nenhum antes** (nem tenant, nem LAN).
3. `app/api/endpoints/cameras.py` — `api_cameras_ping` (`/api/cameras/ping`)
   agora chama `ensure_connector_targets_allowed` antes de cair no
   fallback `ping_via_connector`. Esse endpoint é provavelmente o caminho
   que o usuário usou pra reproduzir o vazamento (campo de IP + conector,
   usado o tempo todo em Implantação/Manutenção).
4. `scripts/sightops_connector_target_scope_enforcement_test.py` (novo)
   — regressão dedicada: IP de um site via conector de outro é bloqueado
   (400), mesmo IP via conector certo passa, ação sem `connector_id`
   (fluxo local) continua sem exigir nada.
5. `scripts/sightops_recorder_shortcuts_frontend_test.py` — corrigido de
   passagem: comparava string literal de versão de cache-bust
   (`js/deploy.js?v=167`) contra o `index.html` real, que já estava em
   `v=168` — teste quebrava sozinho toda vez que alguém bumpava o `?v=`
   de novo. Trocado por checagem de padrão (`js/deploy.js?v=<N>`, número
   qualquer) — isso não é o vazamento em si, achado ao rodar
   `scripts/check.py` durante a validação deste trabalho.

**Validado:** `python scripts/check.py` local — só os 5 testes do bug
antigo de `sys.path` (já catalogados na entrada de 12/08) continuam
falhando; nada novo quebrou. Regressão nova
(`sightops_connector_target_scope_enforcement_test.py`) passa.
**Não testado em produção ainda** — mudança só está no working tree
local, aguardando decisão do usuário sobre deploy.

**Não reverter:** a checagem de escopo de LAN por conector em
`_validate_olt_network_context`, `_validate_olt_target_connector` e
`api_cameras_ping` — sem ela, qualquer operador consegue confirmar
reachability (e depois rodar ação de verdade) de um IP que não é do
site/cliente que o conector selecionado deveria servir.

**Observação/limite conhecido:** `discover_onus_4840e`, `find_onu_4840e`,
`delete_onu_4840e` e `onu_signal_4840e` (os drivers em
`app/cli/tools/olt_4840e_collect_macs.py`) não têm nenhum parâmetro de
relay — sempre fazem SSH direto a partir do próprio servidor, nunca
através do agente do conector, mesmo quando `remote_connector_id` vem
preenchido no request. A validação nova impede que esse `remote_connector_id`
seja usado com um IP fora de lugar, mas não muda o fato de que essas 4
ações sempre dependem do servidor ter rota direta até a OLT — isso é uma
inconsistência de arquitetura à parte (o campo existe no request model
mas é ignorado no driver), não investigada a fundo aqui.

**Próximo passo:** decidir com o usuário se aplica em produção
(`sightops-prod-api`) via hotfix, e depois disso, avaliar se vale
verificar a configuração real do conector "Telha" (por que a VPN dele
tinha rota até a rede da Barra de São Miguel) — a correção de software
impede a ação indevida, mas não explica a causa de rede de fundo.

---

## 2026-08-14 - Ignorados OLT ja recriados nao eram podados

**Agente:** Codex

**Contexto:** apos corrigir a lista de ignorados OLT, o usuario reportou que os
IPs voltaram mesmo assim. Exemplo no tenant `rads`: `100.65.10.72` a
`100.65.10.86` continuavam aparecendo na tela.

**Causa raiz:** a lista `olt-ignored-ips.json` estava correta (`ignored_count:
10` para os IPs analisados), mas esses mesmos IPs ja tinham sido recriados no
`cam-inventory` antes/depois da primeira correcao. `_sync_camera_inventory_from_olt_rows`
apenas impedia criacao nova; nao removia linhas existentes que ja estavam na
lista de ignorados. Atualizar a pagina so mostrava o JSON real.

**Arquivos alterados:**

1. `app/services/olt_service.py` - no inicio do sync OLT, remove cameras ja
   existentes que batem em `is_ignored_olt_row(camera)`. Retorno agora inclui
   `removed_ignored`.
2. `scripts/sightops_inventory_delete_scope_test.py` - regressao cobre linha
   ignorada ja existente sendo podada pelo sync.

**Validacao feita:**

- Local: compile OK e `python scripts\sightops_inventory_delete_scope_test.py`
  OK.
- Producao: compile/test dentro de `sightops-prod-api` OK.
- Producao tenant `rads`: antes havia 481 linhas e os 10 IPs de teste estavam
  presentes; apos `_sync_camera_inventory_from_olt_rows([])`, `removed_ignored:
  48`, total caiu para 433 e `found_after: []` para os 10 IPs.
- `sightops-prod-api` reiniciado e ficou `healthy`.

**Nao reverter:** a lista de ignorados precisa impedir criacao futura e tambem
podar sujeira ja existente. Sem a poda, o usuario apaga, a regra existe, mas a
pagina continua exibindo linhas antigas.

## 2026-08-14 - Edicao de ONU Name salvava toast mas nao alterava a linha

**Agente:** Codex

**Contexto:** na tela Cameras IP modo OLT, o usuario editava `ONU Name`, a tela
mostrava "1 camera(s) salva(s)", mas ao atualizar a linha continuava com o
valor antigo.

**Causa raiz:** o modal nao enviava `inventory_key` para `/api/cameras/save`.
O backend tentava recomputar a chave por IP/site/conector; quando a chave nao
batia exatamente com a linha real, ele podia criar/atualizar uma linha errada e
retornar `ok`, deixando a linha visivel sem alteracao.

**Arquivos alterados:**

1. `frontend/js/connectors.js` - payload de salvar camera agora envia
   `inventory_key`/`key` vindo de `tr.dataset.key`.
2. `app/api/endpoints/cameras.py` - `CameraUpdate` aceita `inventory_key` e
   `key`; o save usa a chave explicita antes do fallback por IP/site.
3. `frontend/index.html` - cache bump `bootstrap.js?v=177`.
4. `scripts/sightops_camera_save_probe.py` - regressao garante que editar
   `onu_name` por `inventory_key` muda a linha correta sem duplicar.

**Validacao feita:** compile local OK, `python scripts\sightops_camera_save_probe.py
--regression` OK; publicado em producao, compile dentro de `sightops-prod-api`
OK, regressao dentro do container OK, API reiniciada e ficou `healthy`.

**Nao reverter:** nao voltar o save de cameras a depender apenas de IP/site. Em
SaaS e inventario OLT a identidade correta da linha e `inventory_key`.

## 2026-08-14 - IPs apagados do inventario OLT voltando na sincronizacao

**Agente:** Codex

**Contexto:** o usuario reportou que IPs como `100.65.10.72` a
`100.65.10.80`, vistos atras da mesma ONU da OLT 4840E, eram apagados da tela
de Cameras IP mas voltavam na proxima sincronizacao da OLT.

**Causa raiz:** o delete individual/lote ja mandava `permanent: true`, mas a
lista de ignorados guardava so IP. Alem disso, o botao de "apagar todo/site"
usava `/api/inventory/clear` sem gravar os removidos na lista de ignorados.
Como a OLT continua vendo esses CPEs, `_sync_camera_inventory_from_olt_rows`
recriava as linhas.

**Arquivos alterados:**

1. `app/services/olt_ignore_list.py` - adicionada regra de ignorado por linha,
   com contexto (`site`, `connector_id`, `olt_ip`, `pon`, `onu_id`,
   `onu_serial`) e compatibilidade com ignorados antigos apenas por IP.
2. `app/services/inventory_delete_service.py` - delete permanente passa a
   salvar a linha removida com contexto, nao apenas o IP.
3. `app/services/olt_service.py` - sync OLT usa `is_ignored_olt_row(row)` antes
   de recriar camera.
4. `app/api/endpoints/tools.py` - `/api/inventory/clear` grava ignorados quando
   recebe `permanent: true` para modo `olt`, tanto por site quanto por tudo.
5. `frontend/js/bootstrap.js` + `frontend/index.html` - botao de limpar
   inventario OLT envia `permanent: true`; cache bump `bootstrap.js?v=176`.
6. `scripts/sightops_inventory_delete_scope_test.py` - teste cobre apagar OLT
   permanente e impedir recriacao pelo sync.

**Validacao feita:**

- Local: `python -m py_compile ...` e
  `python scripts\sightops_inventory_delete_scope_test.py`.
- Producao (`sightops-prod-api`): arquivos copiados, compile OK e
  `python /app/scripts/sightops_inventory_delete_scope_test.py` retornou OK.
- `sightops-prod-api` reiniciado e ficou `healthy`.

**Nao reverter:** nao voltar a lista de ignorados para IP puro. IP privado pode
repetir em SaaS; a regra precisa manter contexto para nao esconder camera real
em outro site/conector.

## 2026-08-14 - Telemetria automatica da OLT Intelbras 4840E no monitoramento ONU

**Agente:** Codex

**Contexto:** o usuario reportou que cameras ficavam offline, mas a ONU
continuava aparecendo online no SightOps. O problema nao era Telegram: o
dashboard/monitoramento interno estava ficando stale para OLT Intelbras 4840E.

**Causa raiz:** `collect_onu_telemetry()` nao tinha caminho para 4840E e a
capability `intelbras_4840e.telemetry` estava falsa. Assim, o loop automatico
`_olt_telemetry_loop()` chamava telemetria, mas a 4840E era rejeitada antes de
atualizar `onu_signals`/`monitoring_entities`. Havia tambem incompatibilidade
de PON salvo como `0/1` vs telemetria numerica `1`, que podia impedir match.

**Arquivos alterados:**

1. `app/cli/tools/olt_4840e_collect_macs.py` - adicionada coleta read-only de
   telemetria 4840E via `show pon` + `show onu-status`, retornando `Active/OK`
   para Up e `Offline/LOS` para Down.
2. `app/services/olt_capabilities.py` - `intelbras_4840e.telemetry = True`.
3. `app/services/olt_service.py` - branch 4840E em `collect_onu_telemetry()` e
   normalizacao de PON (`0/1`, `0/1/3`, `1`) para casar inventario com
   telemetria.
4. `scripts/sightops_olt_capabilities_test.py` - guardas locais para capability
   4840E, parser de Down/LOS e match de PON `0/1` com `1`.
5. `scripts/sightops_4840e_telemetry_status_probe.py` - probe repetivel para
   rodar telemetria por tenant, atualizar monitoramento e imprimir resumo.

**Validacao feita:**

- Local: `python -m py_compile ...` e
  `python scripts\sightops_olt_capabilities_test.py`.
- Producao (`sightops-prod-api`): compile/test OK.
- Producao tenant `rads`: probe rodou nas OLTs `100.65.10.200` e
  `100.64.10.5`, ambas `ok: True`. Apos refresh, resumo ONU ficou
  `129 total`, `114 up`, `15 down`; eventos apareceram para ONUs reais em LOS
  (`ONU-EVENTO-IGREJA`, `OnuSecretarias`, `CAIXA-12`).

**Nao reverter:** nao voltar `intelbras_4840e.telemetry` para falso e nao
remover a normalizacao de PON. Esses dois pontos sao o que fazem o alerta ONU
acompanhar o estado real da OLT.

**Observacao:** o probe atual tambem imprime linhas observadas do inventario
bruto; esse numero pode ser maior que o total de entidades monitoradas porque o
monitoramento deduplica por chave de entidade. Se mexer nisso, validar com
tenant real antes de publicar.

## 2026-08-13/14 — OLT 4840E (Barra/Santana): dados faltando, ONU offline invisível, Zabbix por site, inventário "fantasma"

**Agente:** Claude

**Contexto:** sessão longa de correções encadeadas, todas partindo do
usuário reportando que a varredura da OLT Intelbras 4840E (tenant `rads`,
OLTs "Barra de São Miguel" `100.65.10.200` e "Santana" `100.64.10.5`)
vinha com dados incompletos e câmeras conhecidas (1, 2 da Barra) sem
vínculo de OLT. Uma correção destravou a próxima descoberta; registro
tudo numa entrada só porque é a mesma linha de trabalho.

**Arquivos alterados:**

1. **`frontend/index.html`** — modal "Coletar MACs da OLT" (Inventário >
   OLT) não tinha a opção "4840E" no `<select id="oltModel">` (só 8820i,
   8840E-FiberHome, Auto); adicionada `<option value="4840e">`. Bump de
   versão `js/network.js?v=157`.
2. **`frontend/js/network.js`** — `#oltPon` (seletor de PON do mesmo
   modal) era HTML fixo com PON 1-8 pra qualquer modelo. Adicionada
   `updateOltPonOptions()` + listener no `#oltModel`, recalcula pra 4 PONs
   quando o modelo é 4840E (a OLT é EPON de 4 portas, não 8).
3. **`app/cli/tools/olt_4840e_collect_macs.py`** — três bugs no parser do
   driver 4840E:
   - `_PON_LINE_RE`: exigia texto de descrição (`.+` obrigatório) em toda
     linha do `show pon`. ONU com campo Description em branco na OLT
     (aconteceu com a 0/4/6 e 0/4/7 — essas são as câmeras "1" e "2" da
     Barra) não batia com a regex e sumia inteira do relatório, silenciosamente. Trocado
     `\s+(?P<desc>.+)$` por `(?:\s+(?P<desc>.+))?$` (grupo opcional).
   - `collect_macs_4840e`: só gerava linha de saída quando
     `show mac-address-table onu X` retornava MAC de CPE aprendido. ONU
     sem tráfego no momento (mas autorizada) sumia inteira — sem jeito de
     saber que ela existe, só que está offline. Agora consulta também
     `show onu-status` (comando global, sem precisar de contexto de PON,
     traz Up/Down real de TODAS as ONUs provisionadas — inclusive as que
     nunca aparecem no `show pon`) e gera linha sintética (cpe_mac = MAC
     da própria ONU) pras que estão sem CPE aprendido, com
     `oper_status`/`omci_status` vindo do estado real (`Active`/`OK` se
     Up, `Offline`/`LOS` se Down) em vez de assumir "sem MAC = offline"
     (bug: uma ONU pode estar Up e só sem cliente conectado na porta).
   - Consequência: 12 ONUs que nunca apareciam em lugar nenhum na Barra
     (0/1/5, 0/1/11, 0/1/25, 0/2/13, 0/2/14, 0/4/1, 0/4/3, 0/4/4, 0/4/5,
     0/4/15, 0/4/17, 0/4/19) agora aparecem como Offline de verdade.
4. **`app/services/olt_service.py`** — `_sync_camera_inventory_from_olt_rows`
   só casava câmera já cadastrada por MAC de CPE. Quando a ONU está sem
   CPE aprendido, o driver manda o MAC da própria ONU (não bate com o MAC
   da câmera já salva) — a câmera existente nunca era atualizada, ficava
   presa no último `onu_oper_status` bom pra sempre. Adicionado índice e
   fallback de casamento por `(connector_id, olt_ip, pon, onu_id)` quando
   o MAC não bate (só usa se houver exatamente 1 candidato).
5. **`app/services/olt_ignore_list.py`** (novo) + **`app/models/requests.py`**
   (`InventoryDeleteRequest.permanent: bool`) + **`app/services/inventory_delete_service.py`**
   — usuário reportou que apagar item do inventário "Cameras IP" não
   resolvia: a sincronização periódica da OLT recriava a linha em minutos
   (ex.: tentou apagar os IPs de gestão dos NVRs `.51` a `.55`, que a OLT
   continua vendo na rede, e eles voltavam sozinhos). Nova lista de IPs
   ignorados persistida por tenant (`data/tenants/<slug>/olt-ignored-ips.json`).
   `_sync_camera_inventory_from_olt_rows` (`olt_service.py`) agora pula
   qualquer IP que esteja nessa lista antes de recriar. Chave é só o IP
   (não MAC) de propósito: se o mesmo equipamento físico reaparecer depois
   com IP diferente, ele volta a ser descoberto normalmente.
   **`frontend/js/bootstrap.js`** e **`frontend/js/cameras.js`** — os dois
   fluxos de "Apagar" (individual e em lote) na tela Cameras IP agora
   mandam `permanent: true` por padrão.
6. **`app/services/pdf_inventory_report.py`** — relatório de Cameras IP em
   PDF vinha sem nenhuma foto. Causa: `_pick_image_path`/`_path_from_snapshot_url`
   ainda procuravam em `DATA_DIR/"snapshot"` (caminho global antigo);
   snapshots são gravados em `tenant_snapshot_dir()` (`data/tenants/<slug>/snapshot/`)
   desde a correção de isolamento entre tenants de uma auditoria anterior
   — o gerador de PDF nunca foi atualizado junto. Nova função `_snapshot_dirs(source)`
   centraliza a resolução (tenant-scoped primeiro, fallback pro global),
   usada nas 3 funções que procuravam arquivo de foto (ip/dvr/nvr).
7. **`app/services/zabbix_monitoring_service.py`** — duas mudanças:
   - Removido fallback de credencial hardcoded (`Admin`/`zabbix`) em
     `_default_zabbix_cfg` (achado em auditoria anterior no mesmo dia).
   - Nova `ensure_olt_icmp_host(olt)`: cria/atualiza host Zabbix com
     **ping ICMP real** (template "ICMP Ping", não o trapper que só
     espelha status calculado pelo SightOps) pra IP de gestão da própria
     OLT. Chamada em `_run_olt_registry_sync` (`app/api/endpoints/olt.py`),
     depois de todo `collect_macs()` bem-sucedido — falha aqui não derruba
     o sync da OLT (só some do campo `zabbix_icmp` do resultado do job).
   - `sync_monitoring_to_zabbix` (hosts trapper de OLT/ONU) e
     `ensure_olt_icmp_host` passaram a criar **subgrupo por site** além do
     grupo geral (sintaxe `/` do Zabbix, ex.:
     `SIGHTOPS - RADS - ONU/BARRA DE SAO MIGUEL`) — usuário reclamou que
     Barra e Santana apareciam misturadas. Host fica nos dois grupos (geral
     + site), não só no do site — mantém quem já filtra pelo geral
     funcionando. Nova `_clean_site()` tira um prefixo "OLT - " que
     aparecia no nome de site de uma das OLTs cadastradas (inconsistência
     de dado pré-existente, não senão o subgrupo "Barra" ficava duplicado
     com/sem esse prefixo).
8. **`tools/mk_zabbix_from_inventory.py`** — mesma ideia de subgrupo por
   site, mas pro script que sincroniza **câmeras** com Zabbix (roda
   sozinho a cada 60s via `_zabbix_status_sync_loop`/`scripts_zabbix`,
   `ensure_hosts=True`). `main()` agora garante (e cacheia) um subgrupo
   `f"{ZBX_GROUP}/{local}"` por host, além do grupo geral já existente.

**Validado:** cada mudança testada ao vivo em produção via
`docker exec sightops-prod-api python3 -c "..."` chamando a função real
(não só teste unitário) antes e depois de cada deploy — sem isso não dava
pra confiar que o parser batia com o texto real que a OLT devolve.
Conferido: total de ONUs parseadas bate com "Total onu entries" que a
própria OLT informa (68); ONU "kinoa" (0/4/16) corrigida de "Offline"
(errado, era só sem cliente) pra "Active" (certo, `show onu-status`
confirma Up); os 5 IPs de NVR (`.51`-`.55`) apagados não voltaram depois
de rodar sync de novo; PDF acha foto em 49/50 câmeras de amostra (antes,
0/50); grupo Zabbix por site confirmado via API (`hostgroup.get`) pra
câmeras, OLT, ONU e OLT-ICMP. `python -m py_compile`/`python -m ast.parse`
(cuidado: `mk_zabbix_from_inventory.py` tem BOM no início do arquivo —
`ast.parse(open().read())` quebra nisso, usar `py_compile` pra checar
sintaxe desse arquivo específico) em todos os arquivos antes de cada
deploy. Nenhum teste automatizado novo foi escrito (`scripts/check.py`
não rodado nesta sessão).

**Não reverter:**
- O grupo opcional em `_PON_LINE_RE` (item 3) — sem isso, qualquer ONU
  4840E sem descrição cadastrada na OLT some inteira da varredura de
  novo, silenciosamente (sem erro, sem log).
- A consulta a `show onu-status` dentro de `collect_macs_4840e` e o
  fallback de casamento por PON/ONU em `_sync_camera_inventory_from_olt_rows`
  (item 4) — sem os dois juntos, ONU offline ou volta a ficar invisível,
  ou fica visível só com dado desatualizado pra sempre.
- A lista de ignorados por IP (item 5) é **só por IP**, nunca trocar pra
  MAC — bloquear por MAC prenderia a redescoberta de um equipamento físico
  que reaparece com IP novo, que é exatamente o cenário que o usuário
  pediu pra continuar funcionando.
- `_snapshot_dirs()` (item 6) tem que continuar tentando o caminho
  tenant-scoped **antes** do global — a ordem inversa reabriria o mesmo
  vazamento entre tenants que a correção de segurança anterior fechou.

**Próximo passo (pedido explícito do usuário, não implementado ainda):**
alerta de Telegram quando OLT/ONU cai — reaproveitar o host
`SIGHTOPS.<tenant>.OLT_ICMP.<id>` já criado (item 7) numa Action nova do
Zabbix, sem duplicar por site (grupo geral já cobre os dois sites) e sem
alertar por ONU individual (viraria enxurrada com 260+ ONUs na Barra
sozinha — câmera já tem alerta próprio). Falta o token do bot + chat ID
do Telegram **específico do tenant rads** — usuário mandou por engano os
de outros clientes (Perucaba, Jardins I/II, Reserva, Interblocos, que são
sites do tenant `easy-tecnologias`, não do `rads`) e ainda não reenviou
o certo.

Achado à parte, não investigado: os 5 IPs de NVR apagados (item 5) tinham
`titulo` de câmeras reais (ex. "1 - Hotel Kinoa") antes de apagar, não só
"sem dado" — pode ser cruzamento de MAC errado em algum lugar do
`_known_mac_ip_index`/ARP do conector RouterOS. Vale investigar se
aparecer de novo em outro IP.

---

## 2026-08-12 - KMZ enriquecido com icones no Google Earth

Agente: Codex

Contexto:
- O cliente informou que o KMZ gerado/enriquecido continuava abrindo no Google Earth sem os icones esperados.
- A tentativa anterior colocou `cctv-green.png` e `cctv-red.png` na raiz do KMZ e removeu cache dos downloads, mas ainda nao resolveu totalmente.

Raiz identificada:
- KMZ importado pode trazer `Style`/`StyleMap` embutido dentro de cada `Placemark`.
- O enriquecedor adicionava `styleUrl`, mas nao removia o estilo embutido do ponto.
- No Google Earth, esse estilo local pode vencer o `styleUrl` novo e manter icone antigo/quebrado, como X vermelho.

Arquivos alterados:
- `app/services/camsnapshot/kmz_enricher.py`
- `scripts/sightops_kmz_layer_actions_test.py`

Mudanca:
- O enriquecedor agora remove `Style` e `StyleMap` filhos diretos do `Placemark` antes de aplicar `#cam-online` ou `#cam-offline`.
- O KMZ segue empacotando `cctv-green.png` e `cctv-red.png` na raiz, alem das copias legadas em `files/icons/`.

Validacao local:
- `python -m pytest scripts\sightops_kmz_layer_actions_test.py -q` retornou `4 passed`.
- `python -m py_compile app\services\camsnapshot\kmz_enricher.py app\api\endpoints\tools.py` retornou sucesso.

Validacao em producao:
- Arquivo publicado no container `sightops-prod-api`.
- Container ficou `healthy`.
- Geracao real no tenant `rads`, camada `SANTANA`, retornou:
  - `placemarks 224`
  - `root_green True`
  - `root_red True`
  - `href_green True`
  - `href_red True`
  - `inline_bad 0`
  - `has_legacy_x False`

Nao reverter:
- Nao restaurar estilos embutidos de `Placemark` ao enriquecer KMZ de cameras.
- Nao voltar os hrefs principais para `files/icons/...`; manter href raiz `cctv-green.png` e `cctv-red.png`.

Proximo cuidado:
- Se o Google Earth ainda mostrar icone antigo, confirmar que o usuario baixou o novo `SANTANA.kmz` gerado apos esta correcao e removeu a camada antiga do Google Earth antes de importar novamente.

---

## 2026-08-12 — Correções de segurança da auditoria completa

**Agente:** Claude

**Contexto:** auditoria completa do sistema (código local + comparação
com produção real, `sightops-prod-api`/`sightops-prod-nginx` em
10.10.12.7) achou dois bugs críticos de isolamento entre tenants, mais
outros achados médios/baixos. Corrigidos em três commits:
`ab05124`, `30f64c4`, `a6aa52d`.

**Arquivos alterados:**
- `app/api/endpoints/maintenance.py` — proxy web de câmera
  (`/api/maintenance/web/{ip}/...`) agora exige que o IP pertença ao
  inventário do tenant atual (`_ip_belongs_to_current_tenant`), bloqueia
  loopback/link-local, encaminha header `Authorization`.
- `app/api/endpoints/cameras.py` (`api_snapshot_save`) — removido
  fallback que aceitava path absoluto arbitrário do disco.
- `app/services/photo_store.py` — fallback pros diretórios globais de
  snapshot só roda com tenant vazio ou `"default"` (mesmo guard que
  `app/main.py` já tinha).
- `app/services/auth_store.py` (`delete_tenant`) — agora também apaga
  `tenant_data_dir(slug)` do disco.
- `app/api/endpoints/auth.py` — `update_tenant`/`delete_tenant` respondem
  403 (não 400) pra quem não é admin de plataforma.
- `app/services/pdf_inventory_report.py` — pasta de relatórios PDF agora
  é tenant-scoped (`_reports_dir()`).
- `app/core/security.py` — `POST /api/network/tools/run` exige
  `operator`, `POST /api/system/bootstrap` exige `admin`.
- `app/services/windows_inventory_service.py` — token legado global do
  Windows Agent controlado por `WINDOWS_AGENT_LEGACY_TOKEN_ENABLED`
  (default ligado).
- `scripts/sightops_hikvision_switch_test.py` — senha real de switch de
  cliente trocada por valores sintéticos.
- `Dockerfile` — uvicorn com `--no-access-log` (evitava vazar
  `live_token` no log do container).

**Validado:** `scripts/check.py` local — só os 5 testes que já falhavam
antes (bug de `sys.path` em arquivos de teste recentes, sem relação com
este trabalho: `sightops_camera_recorder_fallback_test.py`,
`sightops_dashboard_snapshot_count_test.py`,
`sightops_kmz_layer_actions_test.py`,
`sightops_zabbix_access_service_test.py`,
`sightops_zabbix_status_sync_autoupsert_test.py`) continuam falhando.
`sightops_camera_web_proxy_test.py` foi ajustado pra checagem nova de
posse de IP e passa. Deploy aplicado em produção real
(`sightops-prod-api`) via hotfix — exceto o `Dockerfile`, que precisa de
rebuild de imagem (ainda não aplicado em produção).

**Não reverter:**
- A checagem de posse de IP em `_camera_web_target_url`/
  `_ip_belongs_to_current_tenant` — sem ela, um cliente volta a acessar
  câmera/serviço HTTP privado de outro.
- O guard de fallback legado em `photo_store.py`/`api_snapshot_save` —
  sem ele, dois tenants com câmera no mesmo IP privado vazam snapshot um
  do outro, ou qualquer operator lê arquivo arbitrário do servidor.

**Próximo passo:** rebuild de imagem pra aplicar o `--no-access-log` do
Dockerfile em produção. Itens ainda abertos, fora do escopo deste
trabalho: chave SSH `_tmp_sightops_deploy_ed25519` solta na raiz (decisão
do usuário sobre remover/rotacionar); Easy Backup (CORS aberto, defaults
fracos) não mexido — usuário confirmou que é serviço descontinuado.

---

## 2026-08-13 — Auditoria de acompanhamento (mudanças em andamento)

**Agente:** Claude

**Contexto:** usuário pediu nova auditoria completa após um incidente de
CPU em produção (`sightops-prod-api` travado a ~100% por tempo
prolongado, mitigado com `docker restart`, causa raiz não confirmada).
A auditoria revisou o working tree sujo (34 arquivos, nenhum commit local
à frente do `origin/main`) e encontrou, entre outras coisas, que esta
entrada de handoff (a de cima, "Correções de segurança da auditoria
completa") tinha sido **substituída inteira** pela entrada do Codex sobre
KMZ, em vez de ficar empilhada acima dela. Restaurada agora — ver arquivo
completo de novo.

**Achados da auditoria (resumo, não corrigidos ainda nesta entrada além
do que está listado abaixo):**
- `app/services/zabbix_monitoring_service.py` (`_default_zabbix_cfg`) —
  tinha fallback hardcoded pra credencial de fábrica do Zabbix
  (`Admin`/senha padrão) quando a config do tenant não está setada.
  **Corrigido nesta entrada**: agora levanta erro explícito em vez de
  tentar logar com a credencial padrão.
- `app/cli/tools/olt_4840e_collect_macs.py` (código novo, +601 linhas,
  sessão SSH legada via `subprocess`+`sshpass`/Telnet pra OLT 4840E) —
  não tem teto de tempo agregado pro `collect_macs()` inteiro, só timeout
  por comando individual. Candidato mais provável (não confirmado) pra
  explicar lentidão prolongada, ainda não corrigido — próximo agente que
  mexer nisso, adicionar timeout agregado.
- `recorder_media_service.EXPORT_DIR` e parte de `scan_service.py` ainda
  usam caminho de arquivo global (`DATA_DIR`) sem `tenant_slug` — não
  corrigido nesta entrada, precisa confirmar se é só fallback de tenant
  vazio/"default" ou vazamento real entre clientes antes de mexer.

**Arquivos alterados nesta entrada:**
- `app/services/zabbix_monitoring_service.py` — removido fallback de
  credencial hardcoded.
- `docs/HANDOFF_AGENTES.md` — restaurada a entrada anterior que tinha
  sido apagada.

**Não reverter:**
- A remoção do fallback de credencial Zabbix — sem ela, o sistema tenta
  logar sozinho com usuário/senha de fábrica quando a config real não
  está setada, o que é uma dependência oculta de credencial fraca.

**Próximo passo:** confirmar por SSH em 10.10.12.7 se o código deste
working tree já foi copiado pro container `sightops-prod-api` (deploy é
manual, não vem do git) antes ou depois do incidente de CPU de hoje —
isso decide se as mudanças em `maintenance_ping_service.py`/
`ws_scan_service.py`/`zabbix_monitoring_service.py` já ativas nesta
sessão são a causa do travamento ou uma correção feita depois.

---

## 2026-08-14 - Regra de IP ignorado no inventario OLT

**Agente:** Codex

**Contexto:** o usuario apaga linhas OLT enquanto organiza documentacao/KMZ.
Essas linhas precisam ficar bloqueadas para a sincronizacao automatica da OLT
nao recriar sujeira a cada ciclo, mas nao podem virar bloqueio permanente:
quando uma varredura manual encontrar novamente uma camera real, o IP deve
sair automaticamente da lista de ignorados.

**Arquivos alterados nesta entrada:**
- `app/services/olt_ignore_list.py` - novo `remove_ignored_rows()`.
- `app/services/scan_service.py` - varredura HTTP manual remove da lista de
  ignorados os IPs encontrados.
- `app/services/rescan_service.py` - rescan de IP unico tambem reabilita o IP.
- `app/services/ws_scan_service.py` - varredura manual via conector remoto
  tambem reabilita IPs encontrados.
- `scripts/sightops_manual_scan_restores_ignored_test.py` - regressao dedicada.

**Nao reverter:** a separacao e intencional. O sync automatico da OLT continua
respeitando `olt-ignored-ips.json`; somente caminhos manuais de scan/rescan
podem retirar IPs dessa lista quando a camera for encontrada de novo.

---

## 2026-08-18 - Camera apagada voltava e site novo roubava IP do antigo

**Agente:** Claude

**Contexto:** reclamacao do usuario em producao: "eu apago as cameras mas elas
voltam, e coloco um site novo numa varredura e ele pega o IP antigo e mistura
tudo". Eram tres defeitos distintos, todos confirmados no codigo.

**1. Varredura desfazia a exclusao.** `scan_service` e `ws_scan_service`
chamavam `remove_ignored_rows()` com TUDO que a varredura encontrasse. Bastava
varrer a faixa do site para o proprio sistema desbloquear e recadastrar todas
as cameras que o usuario tinha apagado.

**Nao revertemos a entrada de 2026-08-14** (Codex): varredura manual continua
reabilitando IP ignorado. O que mudou e o ALCANCE -- agora so reabilita quando
o alvo foi digitado IP a IP (`100.65.10.72` ou lista separada por virgula),
que e o pedido explicito "quero esse de volta". Alvo em faixa
(`100.65.10.1-100.65.10.100`) ou CIDR (`/24`) e descoberta ampla: ali o
bloqueio do usuario continua valendo e as linhas ignoradas sao FILTRADAS antes
de salvar. `scripts/sightops_manual_scan_restores_ignored_test.py` continua
passando.

**2. Bloqueio so valia no modo OLT.** `is_ignored_olt_row` so era consultado em
`olt_service`, e `tools.py` so gravava o bloqueio `if permanent and mode ==
"olt"`. Nos modos Basico e Switch, apagar nunca grudava. Alem disso o escopo
exigia que `olt_ip`/`pon`/`onu_id` batessem -- campos que varredura basica nao
traz --, entao o bloqueio nao casava e a camera voltava. Agora site/conector
continuam rigidos (protegem IP privado repetido entre clientes) e os campos de
topologia so sao comparados quando a linha nova os informa.

**3. Merge cruzava sites.** Para linha local (sem conector), `_merge_inventory_rows`
casava por `IP:` (a chave logica), depois por IP sozinho e por MAC sozinho, sem
olhar site. Como 100.65.x se repete em todo cliente, a camera do site novo
casava com a linha do site antigo -- e `site`/`local`/`site_name` estao na lista
de campos que sempre sobrescrevem, entao o registro antigo passava a apontar
para o site novo. Agora nenhuma regra de match cruza linhas de sites diferentes.
`_apply_default_local` tambem so carimba o site nas linhas desta varredura
(antes pegava o inventario inteiro e batizava qualquer linha sem `local`).

**Arquivos alterados:**
- `app/services/olt_ignore_list.py` - `filter_ignored_rows()`, alias
  `is_ignored_row`, escopo tolerante em topologia.
- `app/services/scan_service.py` - `_explicit_target_ips()`, filtro de
  ignorados, guarda de site no merge, `_apply_default_local(only_ips=...)`.
- `app/services/ws_scan_service.py` - mesmo criterio na varredura via conector.
- `app/api/endpoints/tools.py` - bloqueio gravado nos tres modos.
- `frontend/js/bootstrap.js` - "Apagar inventario" manda `permanent` nos tres modos.
- `scripts/sightops_scan_respects_deleted_test.py` - regressao dos tres casos.

**Allowlist estrita: IMPLEMENTADA na mesma sessao (ver entrada abaixo).**


---

## 2026-08-18 - Inventario declarativo: allowlist de IPs por site

**Agente:** Claude

**Contexto:** pedido direto do usuario -- "eu nao quero ele descobrindo IP, eu
que digo qual IP ele deve olhar". A varredura era autoritativa: cadastrava tudo
que respondia na faixa, e o usuario passava o dia apagando. Agora a lista dele
manda.

**Modelo escolhido (por ele): ESTRITO.** O que nao esta na lista do site nao
entra e nao vira pendencia -- e descartado. Nao ha tela de aprovacao.

**Ativacao por site, nao global.** `site_is_enforced()` so retorna True se o
site tem lista cadastrada e o modo estrito esta ligado. Site sem lista continua
com o comportamento antigo -- ligar isso num cliente nao quebra os outros. Foi
de proposito: nao existe flag global que bote todo mundo em estrito de uma vez.

**Onde e o corte** (os tres caminhos que criam camera sozinhos):
- `app/services/scan_service.py` - varredura HTTP, filtra ANTES do merge.
- `app/services/ws_scan_service.py` - varredura via conector remoto.
- `app/services/olt_service.py` - sync automatico da OLT (era o pior: recriava
  em background sem o usuario pedir nada).

**Arquivos alterados:**
- `app/services/camera_allowlist.py` (novo) - store por tenant
  (`camera-allowlist.json`), aceita IP, faixa `10.0.0.10-20` e CIDR.
- `app/api/endpoints/tools.py` - `GET/POST /api/inventory/allowlist`
  (actions: set, add, remove, enforce). Ficou em tools.py de proposito, pra nao
  disputar `endpoints/__init__.py` e `main.py` com quem mexe em outra area.
- `frontend/index.html` - botao "IPs permitidos" e modal (`modalAllowlist`);
  versoes de cameras.js/bootstrap.js incrementadas (cache-busting).
- `frontend/js/cameras.js` - `openAllowlistModal`, `allowlistSave`,
  `allowlistImportFromInventory` (puxa os IPs que ja estao no inventario do
  site pra virar a lista inicial).
- `frontend/js/bootstrap.js` - listeners do modal.
- `scripts/sightops_camera_allowlist_test.py` - regressao.

**Contadores novos** no retorno do scan, uteis pra depurar em producao:
`blocked_allowlist_count` (varredura) e `blocked_allowlist` (sync OLT).

---

## 2026-08-18 - Apagar e apagar: allowlist substitui a lista de bloqueados

**Agente:** Claude

**Contexto:** pergunta do usuario -- "pq eu preciso dessa lista de IPs
bloqueados? pq nao posso simplesmente apagar, e se eu quiser chamo de novo?".
Ele esta certo. A lista de bloqueados (`olt-ignored-ips.json`) so existia porque
varredura e sync da OLT recriavam linha por conta propria; era remendo, nao
solucao. Com allowlist estrita ela vira redundante -- sair da lista de
permitidos ja garante que nao volta.

Pior: do jeito que ficou na entrega anterior, as duas listas podiam se
contradizer. Apagar camera em site estrito gravava o IP nos bloqueados mas
**nao tirava dos permitidos** -- dois cadastros discordando sobre o mesmo IP.

**Regra agora:**
- Site COM allowlist ligada -> apagar remove o IP da lista de permitidos e
  **nao** grava bloqueio. Para trazer de volta, recolocar o IP na lista.
- Site SEM allowlist -> comportamento antigo, continua dependendo da lista de
  bloqueados (sem ela a varredura recadastra tudo).

**Arquivos alterados:**
- `app/services/camera_allowlist.py` - `forget_rows()`, que separa as linhas de
  site declarativo (tira da allowlist) das de site legado (`rows_legado`, que o
  chamador ainda manda pra lista de bloqueados).
- `app/services/inventory_delete_service.py` - remocao de cameras selecionadas.
- `app/api/endpoints/tools.py` - "Apagar inventario" por site e total.
- `frontend/js/bootstrap.js` - o toast diz quantos IPs sairam da lista.
- `scripts/sightops_apagar_e_chamar_de_volta_test.py` - ciclo completo:
  autoriza -> varre -> apaga -> varre de novo (nao volta) -> recoloca na lista
  -> varre (volta). Cobre tambem que site sem allowlist segue usando bloqueio.

**Nao "simplificar" removendo a lista de bloqueados.** Ela continua sendo a
unica protecao dos sites que ainda nao migraram pro modo declarativo.
