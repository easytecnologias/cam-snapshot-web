# Handoff entre agentes (Claude / Codex)

Registro de tarefas médias/importantes (produção, banco, Zabbix,
conectores, KMZ, ONU/OLT, inventário, ou qualquer coisa que outro agente
possa sobrescrever sem saber). Tarefa pequena não entra aqui — fica só na
resposta final do agente pro usuário. Entrada mais recente no topo.

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
