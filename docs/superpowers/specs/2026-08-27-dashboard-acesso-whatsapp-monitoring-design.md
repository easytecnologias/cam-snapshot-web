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

Um novo processo em segundo plano (mesmo formato do sync de status do
Zabbix que ja existe hoje) testa cada controladora ativa periodicamente,
por tenant, reaproveitando a MESMA logica de teste que o botao "Testar" ja
usa (incluindo o caminho via conector, para controladoras atras de tunel).
Intervalo padrao de 180 segundos (3 minutos), configuravel por variavel de
ambiente, para nao sobrecarregar controladoras nem conectores. O mesmo
ciclo tambem consulta o WhatsApp a cada execucao -- poucos sites por
tenant, entao nao ha risco real de estourar limite de taxa da Graph API
nesse intervalo.

O resultado atualiza `access_devices.status` e `last_seen_at` pela mesma
funcao que o botao "Testar" ja usa hoje (`update_device_health`) -- ou seja,
o botao manual continua funcionando exatamente igual, so passa a nao ser
mais a unica forma de atualizar o status.

### Verificacao automatica do WhatsApp

O mesmo processo em segundo plano consulta `get_access_whatsapp_connection`
para cada site com canal configurado, por tenant.

### Entrada no Dashboard

`refresh_from_inventory()` ganha dois blocos novos, no mesmo formato dos
blocos existentes de connector/olt/onu:

- `entity_type="controladora"`: uma linha por controladora ativa, status
  espelhando `access_devices.status`.
- `entity_type="whatsapp"`: uma linha por site com canal configurado, status
  espelhando o resultado de `get_access_whatsapp_connection`.

### Card no Dashboard

Dois cards novos, no mesmo estilo visual dos existentes:

- "Controladoras de Acesso": total, quantas online, quantas offline.
- "WhatsApp": total de canais configurados, quantos conectados (ex.: "3
  conectados de 4 configurados").

### Zabbix

`sync_monitoring_to_zabbix` passa a incluir tambem `controladora` e
`whatsapp` na lista de tipos enviados (hoje so envia `olt` e `onu`). Cada
controladora e cada canal WhatsApp ganham um host no grupo
`SIGHTOPS - {TENANT} - CONTROLADORA` / `SIGHTOPS - {TENANT} - WHATSAPP`,
seguindo exatamente o mesmo formato ja usado para OLT/ONU.

## Fora de escopo

- Mudar como Cameras, OLT, ONU, Conectores ou Gravadores sao monitorados
  hoje.
- Adicionar controladoras/WhatsApp nos widgets "Alertas do parque" ou
  "Prioridades" do Dashboard -- fica so no card de contagem por enquanto,
  igual comecou o de Conectores.
- Trocar a forma como o botao "Testar" funciona na tela de Controle de
  Acesso.

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
