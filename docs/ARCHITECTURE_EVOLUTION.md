# cam-snapshot-web: Arquitetura Atual e Plano de Evolucao

## Objetivo

Evoluir o `cam-snapshot-web` para um sistema profissional de monitoramento de cameras sem quebrar as funcionalidades existentes de:

- leitura de cameras
- snapshots
- importacao de KMZ
- visualizacao em mapa
- integracao com Zabbix
- integracao com DVR/NVR Intelbras
- deteccao de status

Este documento parte da arquitetura real do repositorio atual. Nao assume migracao imediata para outra stack.

## Stack atual do projeto

### Backend

- Python
- FastAPI
- WebSocket nativo via FastAPI
- SQLite como persistencia principal
- JSON legado como fallback/compatibilidade

### Frontend

- HTML multipage
- JavaScript vanilla centralizado em `web/static/app.js`
- CSS global em `web/static/style.css`
- Leaflet para mapa/KMZ

## Diagnostico da arquitetura atual

### 1. Backend

O backend ja esta relativamente bem separado por dominios:

- `app/main.py`
  Responsavel pelo bootstrap do FastAPI, registro de routers e exposicao das paginas HTML.
- `app/api/endpoints/*.py`
  Rotas por contexto de negocio, incluindo `cameras`, `dvr`, `nvr`, `maintenance`, `tools`, `scan`, `ws` e `database`.
- `app/services/*.py`
  Servicos utilitarios e de integracao, incluindo persistencia, snapshot, scan e KMZ.
- `app/core/paths.py`
  Centraliza paths e diretorios do sistema.

### 2. Persistencia

O sistema esta em uma fase de transicao bem importante:

- `SQLite` em `data/sightops.db` ja e a persistencia principal
- `cam-inventory.json`, `dvr-inventory.json` e `nvr-inventory.json` ainda existem como compatibilidade/fallback
- ha funcoes de migracao e leitura hibrida entre DB e JSON

Isso e positivo, porque reduz risco de quebra, mas exige disciplina para nao duplicar regra de negocio em dois lugares.

### 3. Frontend

O frontend atual funciona, mas o principal gargalo arquitetural esta aqui:

- `web/static/app.js` concentra grande parte da logica de inventario, snapshot, manutencao, KMZ, Zabbix, OLT, portscan e handlers de paginas
- varias paginas HTML compartilham o mesmo bundle JS
- ha pouca separacao formal entre:
  - camada de API
  - estado de tela
  - renderizacao
  - componentes reutilizaveis

Consequencia pratica:

- o sistema evolui, mas cada nova funcionalidade aumenta o risco de regressao
- testes de regressao ficam mais dificeis
- reaproveitamento visual e comportamental depende de convencoes manuais

### 4. Integracoes existentes que precisam ser preservadas

As integracoes mais sensiveis do sistema atual sao:

- captura de snapshot por HTTP/RTSP via backend
- WebSocket de scan e snapshot
- APIs de DVR/NVR para Intelbras e equipamentos com CGI compativel
- importacao e enriquecimento de KMZ
- gerenciamento de inventario com dados persistidos
- integracoes de automacao com scripts e Zabbix

Essas areas devem ser tratadas como contratos estaveis.

## Decisoes arquiteturais recomendadas

### 1. Nao reescrever a stack agora

Migrar agora para `React + Node + TypeScript` quebraria a principal vantagem do projeto atual: ele ja entrega operacao real com multiplas integracoes.

A estrategia correta e:

- estabilizar contratos de API
- modularizar o frontend atual
- isolar responsabilidades
- so depois decidir se uma migracao parcial de frontend faz sentido

### 2. Definir contratos de dominio antes de refatorar UI

Os seguintes dominios devem ser tratados como modulos oficiais do produto:

- inventario IP
- DVR
- NVR
- snapshot
- mapa/KMZ
- manutencao
- alertas/status
- integracoes externas

Cada dominio deve ter:

- endpoints claramente agrupados
- formato de resposta consistente
- modelo de dados minimamente estavel

### 3. Transformar o frontend em modulos incrementais

Antes de qualquer migracao de framework, o frontend deve sair do modelo "um arquivo JS enorme" para um modelo por modulos:

- shell/layout
- api client
- estado compartilhado
- paginas
- componentes reutilizaveis

Mesmo se continuar em JavaScript vanilla por enquanto, isso ja reduz risco.

## Arquitetura alvo incremental

### Backend alvo

Manter FastAPI e organizar por dominios:

```text
app/
  api/
    endpoints/
      cameras.py
      dvr.py
      nvr.py
      snapshot.py
      map_kmz.py
      alerts.py
      maintenance.py
      integrations.py
  services/
    inventory/
    snapshot/
    recorders/
    map/
    monitoring/
    integrations/
  repositories/
    inventory_repo.py
    recorder_repo.py
    settings_repo.py
  schemas/
    camera.py
    recorder.py
    alert.py
    map.py
```

Observacao:
nao e necessario mover tudo de uma vez. A primeira meta e reduzir acoplamento e padronizar resposta.

### Frontend alvo

Sem quebrar as paginas atuais, a evolucao recomendada e:

```text
web/
  pages/
  static/
    app/
      core/
      services/
      state/
      components/
      pages/
```

Estrutura sugerida:

```text
web/static/app/
  core/
    dom.js
    events.js
    format.js
    shell.js
  services/
    api.js
    cameras.js
    dvr.js
    nvr.js
    kmz.js
    zabbix.js
    snapshot.js
  state/
    inventory-state.js
    maintenance-state.js
    snapshot-state.js
  components/
    status-badge.js
    snapshot-card.js
    table-toolbar.js
    sidebar.js
  pages/
    inventory-page.js
    maintenance-page.js
    kmz-page.js
    snapshot-page.js
  main.js
```

Esse passo prepara o terreno para, no futuro, migrar partes especificas para React sem reescrever tudo.

## Mapeamento dos componentes de produto

Mesmo antes de React, a interface deve convergir para componentes de produto estaveis:

- `CameraCard`
- `CameraStatus`
- `SnapshotViewer`
- `MapCameraMarker`
- `CameraTable`
- `AlertBadge`
- `SidebarMenu`

No contexto atual, isso significa criar funcoes/modulos reutilizaveis com markup e comportamento padronizados.

## Roadmap recomendado

### Fase 1: estabilizacao estrutural

Objetivo:
reduzir risco de regressao e preparar o sistema para crescer.

Entregas:

- separar `web/static/app.js` por modulos
- criar um `api client` unico para `fetch`
- padronizar tratamento de erro e status visual
- centralizar helpers de renderizacao de status e tabelas
- consolidar uso de SQLite como fonte principal

### Fase 2: dashboard operacional

Objetivo:
entregar a visao executiva e operacional que hoje o sistema ainda nao tem como pagina principal.

Entregas:

- pagina `Dashboard`
- cards com:
  - total de cameras
  - online
  - offline
  - instaveis
  - snapshots desatualizados
- lista de ultimos eventos/falhas
- indicadores por site

Backend necessario:

- endpoint agregado de metricas
- endpoint de falhas/alertas recentes

### Fase 3: mapa profissional

Objetivo:
transformar `kmz.html` em tela operacional de mapa, nao apenas importador/preview.

Entregas:

- marcadores por status
- popup com snapshot, nome, IP, local e ultimo status
- filtros por site, tipo e status
- clusterizacao para alto volume
- destaque visual para offline/instavel

### Fase 4: monitoramento e alertas

Objetivo:
adicionar camada real de observabilidade do parque.

Entregas:

- historico de falhas
- tempo offline por camera
- alertas recentes
- correlacao com ping/Zabbix
- classificacao visual: online, offline, instavel

### Fase 5: transicao opcional de frontend

Objetivo:
permitir adocao progressiva de `React + TypeScript` sem apagar o sistema atual.

Estrategia:

- manter o backend FastAPI
- manter as rotas existentes
- introduzir uma nova SPA apenas para telas novas, se necessario
- reaproveitar os mesmos endpoints

Nao recomendado neste momento:

- migrar backend inteiro para Node/Express
- reescrever todas as paginas de uma vez
- trocar contratos de dados existentes sem camada de compatibilidade

## Prioridades tecnicas

### Performance

Para suportar `100`, `500` e `1000` cameras:

- cachear ping/status e snapshots recentes
- evitar recarregar inventario completo sem necessidade
- usar filtros e renderizacao incremental no frontend
- clusterizar marcadores no mapa
- reduzir duplicidade de consultas entre JSON e DB

### Estabilidade

- padronizar timeouts e retries nas integracoes com cameras e DVR/NVR
- registrar erros por integracao
- isolar falhas externas da experiencia da UI
- manter respostas com campos previsiveis

### Compatibilidade

- nao remover endpoints atuais
- nao mudar paths de snapshot ja usados pela UI
- manter suporte a JSON legado durante a transicao
- preservar WebSockets atuais

## Primeiras entregas praticas recomendadas

As proximas entregas de implementacao devem seguir esta ordem:

1. criar endpoint agregado de dashboard
2. criar pagina `dashboard.html` como nova tela inicial operacional
3. extrair o frontend atual para modulos pequenos sem alterar comportamento
4. evoluir `kmz.html` para mapa operacional com status
5. adicionar camada de alertas/historico

## Conclusao

O projeto atual ja tem base funcional suficiente para virar um produto operacional mais profissional sem reescrita total.

O ponto mais importante agora nao e trocar stack.
O ponto mais importante e:

- modularizar o frontend
- consolidar contratos de dados
- criar um dashboard real
- transformar o mapa em tela operacional

Essa abordagem mantem compatibilidade, reduz risco e abre caminho para uma migracao futura de frontend, se ela realmente continuar fazendo sentido.
