# Changelog - cam-snapshot-web

Todas as mudanças notáveis deste projeto serão documentadas aqui.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/)
e este projeto segue versionamento semântico.

## [1.1.0] - 2026-07-23

Consolidação da plataforma SightOps: de um script de inventário para uma
aplicação web multiempresa de operação de CFTV, redes e infraestrutura.

### Adicionado
- **Backend FastAPI modular** em `app/` (`api/endpoints/`, `services/`, `core/`,
  `models/`, `cli/tools/`), substituindo o `api.py` monolítico.
- **Autenticação multiempresa** com perfis `viewer`, `operator`, `admin` e
  `owner`, bearer token e `bootstrap-admin` para o primeiro acesso.
- **Isolamento por tenant** de inventários, snapshots, logos, relatórios,
  conectores e configurações.
- **Persistência em PostgreSQL ou SQLite** (`DATABASE_BACKEND`), com migrações.
- **Inventário de câmeras** por IP, intervalo ou CIDR, com opção *Incluir no
  inventário (somar nesta rodada)* (`append_inventory`) para mesclar rodadas.
- **Captura de snapshot** para câmeras IP, canais de DVR e canais de NVR.
- **Manutenção de câmeras**: ping, reboot, renomeação, NTP, PTZ e troca de senha.
- **Registro e sincronização de OLTs**:
  - Intelbras 8820i e 4840E (coleta de MACs, telemetria, autorização de ONU).
  - FiberHome AN5516-04/06 e AN6000-15/17 (driver telnet: descoberta, coleta,
    autorização, remoção e sinal de ONU).
- **Enriquecimento** de inventário com dados de OLT/GPON e switches gerenciáveis.
- **Planejamento de projetos de CFTV**: catálogo editável, montagem de caixa
  GPON, importação hierárquica por CSV e exportação do projeto em **KMZ** e em
  **PDF de documento de rede**.
- **Monitoramento e alertas**: sincronização com **Zabbix**, painéis **Grafana**
  e notificações via **Telegram**.
- **Live view** de câmeras (MJPEG/WebRTC) e acompanhamento de varreduras em
  tempo real via WebSocket.
- **Busca por IA em gravações de NVR** e enriquecimento com detecção de
  marca/modelo, qualidade e phash.
- **Inventário de estações Windows** via agente, com relatório em PDF.
- **Conectores** para RouterOS/WireGuard (VPN entre sites) e agentes remotos.
- **Dashboard** operacional e exportações para PDF, XLSX, KMZ, Grafana, Zabbix
  e MikroTik Netwatch.
- **Deploy com Docker Compose**, Nginx como proxy reverso, PostgreSQL e stack de
  observabilidade, com health checks `live`/`ready`.
- **Cabeçalhos de segurança** (X-Content-Type-Options, X-Frame-Options,
  Referrer-Policy, Permissions-Policy, HSTS condicional).

### Ajustado
- Relatório PDF de inventário passou a rodar fora do event loop e sem
  rasterizar a galeria de fotos, evitando picos de memória (>1 GB) em
  inventários grandes.
- Fluxo de registro de câmera unificado (título + inventário em ação única);
  separação de "IP atual" (conectar/puxar dados) e "Novo IP" (registrado).

### Removido
- Frontend legado em `web/pages` aposentado — `/v2/` é a única UI.
- Mounts estáticos de pasta inteira (`/saida`, `/data/nvr_ai`) que não tinham
  escopo de tenant; mídia agora é servida por endpoints que resolvem o arquivo
  dentro do tenant do usuário.

## [1.0.0] - Release inicial estável

### Adicionado
- Backend FastAPI (`api.py`) com:
  - Endpoint HTTP para inventário (`/api/scan`, `/api/cameras`).
  - WebSocket `/ws/scan` para execução de varredura com logs em tempo real.
- Integração com scripts de inventário e snapshot:
  - `tools/inventory_scan.py`
  - `tools/inventory_dry.py`
  - `tools/snapshot_only.py`
- Captura de snapshot de câmeras IP e armazenamento em `saida/snapshot/`.
- Upload de snapshot para **ImgBB**:
  - Novo `tools/publish_images.py` simplificado, que:
    - Lê snapshot em `saida/snapshot/`.
    - Faz upload via API oficial do ImgBB.
    - Atualiza o `cam-inventory.csv` com colunas `snapshot_url` e `thumb_url`.
    - Gera `saida/links_imgbb.txt` no formato `ip,url`.
- Geração de inventário em CSV e Excel:
  - Scripts em `tools/` para formatar e gerar `cam-inventory.xlsx`.
- Base para enriquecimento de inventário com dados de OLT/GPON.
- Estrutura modular em `camsnapshot/` para reaproveitamento de lógica.

### Ajustado
- Padronização do uso de variáveis de ambiente via `.env` (ImgBB, thumbs, etc).
- Tratamento mais robusto de erros e timeouts em uploads ImgBB.
- Organização da pasta `saida/` para concentrar toda a saída gerada (CSV, XLSX, snapshot, links).
