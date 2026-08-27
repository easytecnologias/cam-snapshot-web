# Dashboard - Monitoramento de Controle de Acesso e WhatsApp

## Contexto

O Dashboard ja mostra contagem online/offline para Cameras IP, Gravadores,
ONUs/ONTs, OLTs e Conectores. Esses numeros vem de uma tabela generica
`monitoring_entities` (entity_type/status), alimentada pela funcao
`refresh_from_inventory()` em `app/services/monitoring_service.py`. Qualquer
entity_type novo aparece automaticamente no card certo do Dashboard assim
que existir uma linha para ele nessa tabela.

Hoje existem dois modulos prontos, mas que NAO aparecem no Dashboard nem no
Zabbix:

- **Controle de Acesso**: controladoras ficam na tabela `access_devices`
  (`app/services/access_control_store.py`), com coluna `status`
  (`online`/`offline`/`unknown`) e `host`. O status so atualiza quando
  alguem clica "Testar" na tela ou quando a propria controladora manda um
  evento -- nao existe verificacao automatica periodica.
- **WhatsApp**: a integracao oficial com a Meta Cloud API ja tem uma funcao
  de status real, `get_access_whatsapp_connection()`
  (`app/services/access_control_notifications.py`), que consulta a Graph API
  e devolve se o canal esta conectado. E configuracao por site (um cliente
  pode ter varios canais), nao um unico numero para a empresa toda.

O pedido: os dois aparecerem no Dashboard com contagem online/offline, do
mesmo jeito que OLTs e Conectores ja aparecem, e "monitorados pelo Zabbix
igual aos outros equipamentos".

## Decisao: qual padrao de Zabbix usar

O sistema ja tem dois padroes de integracao com Zabbix:

- **Cameras**: o Zabbix e quem pinga o equipamento; o SightOps so importa o
  resultado de volta periodicamente.
- **OLT/ONU**: o SightOps mesmo faz a verificacao ativa (via seus proprios
  metodos de acesso ao equipamento) e envia o resultado para o Zabbix como
  historico. E o Zabbix quem guarda e alerta, mas quem verifica e o
  SightOps.

Controladoras de acesso e WhatsApp vao seguir o padrao OLT/ONU, porque:

- Varias controladoras so sao alcancadas por tunel via conector RouterOS;
  um host Zabbix com ping direto nao funcionaria para elas.
- WhatsApp nao tem IP nenhum para o Zabbix pingar -- so faz sentido o
  SightOps consultar a Graph API e informar o resultado.

## Comportamento desejado

### Verificacao automatica de controladoras

Investigando o codigo pra fechar o plano, achei que JA EXISTE um processo em
segundo plano rodando a cada 15 segundos que consulta eventos de toda
controladora ativa (`_access_control_sync_loop`), reaproveitando a mesma
logica de acesso do botao "Testar" (inclusive o caminho via conector, para
controladoras atras de tunel). O problema e menor do que parecia: esse
processo ja marca a controladora como "online" quando a consulta da certo,
mas NUNCA marca "offline" quando falha -- so fica registrado num log que
ninguem ve. Em vez de criar um processo novo, a correcao e fechar essa
lacuna dentro do que ja roda, o que e mais simples e mais seguro (reaproveita
infraestrutura ja testada em vez de duplicar).

O resultado continua atualizando `access_devices.status` e `last_seen_at`
pela mesma funcao que o botao "Testar" ja usa hoje (`update_device_health`)
-- ou seja, o botao manual continua funcionando exatamente igual, so passa a
nao ser mais a unica forma de atualizar o status.

### Verificacao automatica do WhatsApp

Aqui nao havia nada parecido, entao esta parte usa o processo em segundo
plano que ja existe para o Dashboard em geral (`refresh_from_inventory`,
hoje a cada 120 segundos, por tenant) -- ele passa a consultar
`get_access_whatsapp_connection` para cada site com canal configurado.
Poucos sites por tenant, entao nao ha risco real de estourar limite de taxa
da Graph API nesse intervalo.

### Entrada no Dashboard

`refresh_from_inventory()` ganha dois blocos novos, no mesmo formato dos
blocos existentes de connector/olt/onu:

- `entity_type="access_device"` (nome tecnico interno, para ficar no mesmo
  padrao em ingles de connector/olt/onu/camera -- o rotulo em portugues
  "Controladoras de Acesso" e so o que aparece na tela): uma linha por
  controladora ativa, status espelhando `access_devices.status`.
- `entity_type="whatsapp"`: uma linha por site com canal configurado, status
  espelhando o resultado de `get_access_whatsapp_connection`.

### Card no Dashboard

Dois cards novos, no mesmo estilo visual dos existentes:

- "Controladoras de Acesso": total, quantas online, quantas offline.
- "WhatsApp": total de canais configurados, quantos conectados (ex.: "3
  conectados de 4 configurados").

### Zabbix

`sync_monitoring_to_zabbix` passa a incluir tambem `access_device` e
`whatsapp` na lista de tipos enviados (hoje so envia `olt` e `onu`). Cada
controladora e cada canal WhatsApp ganham um host no grupo
`SIGHTOPS - {TENANT} - ACCESS_DEVICE` / `SIGHTOPS - {TENANT} - WHATSAPP`,
seguindo exatamente o mesmo formato ja usado para OLT/ONU.

## Fora de escopo

- Mudar como Cameras, OLT, ONU, Conectores ou Gravadores sao monitorados
  hoje.
- Trocar a forma como o botao "Testar" funciona na tela de Controle de
  Acesso.
- Nao vou escrever codigo novo pro widget "Pendencias" do Dashboard contar
  controladora/WhatsApp com problema -- mas ele ja conta TUDO que esta no
  monitoramento generico automaticamente (e assim que Conectores e
  Gravadores ja entram hoje), entao controladora offline ou canal
  desconectado vai aparecer ali como consequencia natural da mesma
  arquitetura, sem eu precisar (nem poder, sem reescrever o widget) excluir
  os dois tipos novos dessa contagem.

## Testes e validacao

- Rodar a verificacao automatica contra uma controladora online e uma
  offline (ou desligada de proposito) e confirmar que `access_devices`
  reflete o estado real sem precisar clicar em "Testar".
- Confirmar que uma controladora atras de conector RouterOS tambem e
  verificada corretamente (nao so as com IP direto).
- Confirmar no Dashboard que o card de Controladoras mostra o numero certo
  de online/offline.
- Confirmar no Dashboard que o card de WhatsApp mostra "conectados /
  configurados" corretamente para um tenant com mais de um site.
- Confirmar em producao que os hosts novos aparecem no Zabbix, no grupo
  certo, sem duplicar host jah existente de outro tipo.
- Confirmar que nenhum tenant sem Controle de Acesso ou WhatsApp configurado
  quebra (card deve mostrar zero, nao erro).
