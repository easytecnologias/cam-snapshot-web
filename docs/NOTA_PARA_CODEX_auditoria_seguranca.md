# Nota para o Codex — correções de segurança da auditoria (12/08/2026)

Contexto: rodei uma auditoria completa do sistema (código local + comparação
com produção real) e corrigi os achados em dois commits:
`ab05124` e `30f64c4` (ambos em `origin/main`).

## O que mudou

- `app/api/endpoints/maintenance.py`: o proxy web de câmera
  (`/api/maintenance/web/{ip}/...`) agora exige que o IP pertença ao
  inventário do tenant atual (`_ip_belongs_to_current_tenant`), bloqueia
  loopback/link-local, e encaminha o header `Authorization` pro upstream.
  **Se for mexer nesse proxy, mantenha essa checagem** — sem ela, um
  cliente volta a poder acessar câmera/serviço HTTP privado de outro.
- `app/api/endpoints/cameras.py` (`api_snapshot_save`): não aceita mais
  path absoluto arbitrário como fallback. Se precisar importar um
  snapshot de um caminho fora do padrão, adicione o diretório numa
  allowlist explícita — não reabra o `cand.is_absolute()`.
- `app/services/photo_store.py`: fallback pros diretórios globais de
  snapshot só roda quando o tenant é vazio ou `"default"` (mesmo guard que
  `app/main.py` já tinha). Se criar um novo caminho de snapshot, siga esse
  padrão.
- `app/services/auth_store.py` (`delete_tenant`): agora também apaga
  `tenant_data_dir(slug)` do disco.
- `app/api/endpoints/auth.py`: `update_tenant`/`delete_tenant` respondem
  403 (não 400) quando quem chama não é admin de plataforma.
- `app/services/pdf_inventory_report.py`: pasta de relatórios agora é
  tenant-scoped (`_reports_dir()`).
- `app/core/security.py`: `POST /api/network/tools/run` exige `operator`,
  `POST /api/system/bootstrap` exige `admin` (antes qualquer autenticado
  passava).
- `app/services/windows_inventory_service.py`: token legado global do
  Windows Agent agora é controlado por
  `WINDOWS_AGENT_LEGACY_TOKEN_ENABLED` (default ligado).
- `scripts/sightops_hikvision_switch_test.py`: senha real de switch de
  cliente trocada por valores sintéticos.
- `Dockerfile`: uvicorn com `--no-access-log` (evitava vazar `live_token`
  no log do container) — **isso ainda não foi aplicado em produção**,
  precisa de rebuild de imagem, não só hotfix. Se você mexer no processo
  de build/deploy, essa mudança já está commitada esperando o rebuild.

## O que ainda está em aberto (não mexi)

- `_tmp_sightops_deploy_ed25519` (chave SSH solta na raiz) — fora do git,
  decisão de remover/rotacionar é do usuário.
- Easy Backup (`easy-backup-manager/`): CORS aberto e defaults fracos no
  compose — usuário confirmou que é descontinuado, não vale corrigir.

## Testes

`sightops_camera_web_proxy_test.py` foi ajustado pra checagem nova de
posse de IP (mock de `_ip_belongs_to_current_tenant`). `scripts/check.py`
local: só os 5 testes que já falhavam antes (bug de `sys.path` em arquivos
de teste recentes seus — `sightops_camera_recorder_fallback_test.py`,
`sightops_dashboard_snapshot_count_test.py`,
`sightops_kmz_layer_actions_test.py`,
`sightops_zabbix_access_service_test.py`,
`sightops_zabbix_status_sync_autoupsert_test.py` — faltam o
`sys.path.insert(0, str(Path(__file__).resolve().parents[1]))` que os
outros testes têm) continuam falhando; não relacionado a este commit.
