
- [2026-01-06] Inventory: nova opção **Incluir no inventário (somar nesta rodada)** (append_inventory) para mesclar e salvar no `data/cam-inventory.json` a cada novo range.
# Changelog - cam-snapshot-web

Todas as mudanças notáveis deste projeto serão documentadas aqui.

O formato é baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/)
e este projeto segue versionamento semântico.

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

### Planejado para v2.0.0
- Melhorias na interface web (UI/UX) e feedback visual de progresso.
- Integrações adicionais com Telegram/Zabbix para alertas automatizados.
- Módulos de IA opcional para análise de qualidade das câmeras.
- Refino do fluxo de enriquecimento com OLT/GPON.
