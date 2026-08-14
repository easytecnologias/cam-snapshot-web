# Solicitacao Para Claude - Correcoes Da Auditoria SightOps

## Contexto

Projeto: `cam-snapshot-web-v2` / SightOps.

Foi feita uma auditoria inicial do sistema com foco em seguranca, autorizacao, isolamento por tenant, Docker/deploy e integracoes operacionais. O nucleo principal do SightOps esta funcional: compilacao Python passou, checagens JS passaram e os testes de isolamento SaaS/schema/OLT passaram.

Porem foram encontrados riscos que precisam ser corrigidos antes de considerar o ambiente pronto para uso mais amplo.

Importante: nao expor, copiar ou registrar valores reais de senhas, tokens, chaves privadas ou `.env`. Se encontrar segredo, mascarar o valor e citar apenas arquivo/tipo.

## Objetivo

Corrigir os achados da auditoria abaixo, mantendo o escopo pequeno, sem refatoracoes desnecessarias e sem reverter mudancas de trabalho em andamento.

## Prioridade 1 - Segredos

### 1. Remover senha real do teste Hikvision

Arquivo:

- `scripts/sightops_hikvision_switch_test.py`

Problema:

- O teste contem uma senha real de switch em texto puro.

Tarefa:

- Substituir a senha real por valor sintetico/fixture segura.
- Se o teste depender de uma captura real, mover os dados sensiveis para variavel de ambiente ou fixture sanitizada.
- Garantir que o teste continue validando a logica sem segredo real.
- Recomendar rotacao da senha real usada anteriormente.

Aceite:

- `rg -n "password=.*cam|cam!|senha real" scripts app` nao encontra a credencial real.
- `python scripts/sightops_hikvision_switch_test.py` passa.

### 2. Tratar chave SSH privada local na raiz

Arquivo local observado:

- `_tmp_sightops_deploy_ed25519`

Problema:

- Chave SSH privada temporaria existe na raiz do repositorio local.

Tarefa:

- Confirmar que `.gitignore`/`.dockerignore` continuam bloqueando `_tmp_*`.
- Recomendar mover a chave para local seguro fora do repo ou remover se nao for mais usada.
- Nao apagar automaticamente sem confirmacao do usuario.
- Se a chave ja foi usada em ambiente real, recomendar rotacao.

Aceite:

- Documento/nota de seguranca atualizado ou comentario no relatorio indicando acao manual necessaria.
- Nenhum valor da chave deve aparecer em logs ou docs.

## Prioridade 2 - Autorizacao

### 3. Proteger `/api/network/tools/run`

Arquivos:

- `app/api/endpoints/network_tools.py`
- `app/core/security.py`

Problema:

- A rota `POST /api/network/tools/run` permite ping, TCP scan, HTTP probe, DNS e traceroute.
- Hoje qualquer usuario autenticado pode acessar se `AUTH_REQUIRED=1`, pois nao ha regra de papel minimo especifica.

Tarefa:

- Adicionar regra RBAC para exigir ao menos `operator` em `POST /api/network/`.
- Considerar `admin` se o projeto tratar ferramentas de rede como recurso mais sensivel.
- Manter compatibilidade com o frontend atual.

Aceite:

- Viewer recebe `403` ao chamar `POST /api/network/tools/run`.
- Operator/admin continuam conseguindo executar.
- Adicionar teste simples se houver padrao local para middleware/RBAC.

### 4. Proteger `/api/system/bootstrap`

Arquivos:

- `app/api/endpoints/system.py`
- `app/core/security.py`

Problema:

- `POST /api/system/bootstrap` chama `init_db()`.
- A rota nao aparece explicitamente nas regras admin.

Tarefa:

- Adicionar regra RBAC admin para `POST /api/system/bootstrap`.
- Avaliar se a rota deve existir em producao ou se deveria ser bloqueada por `APP_ENV=production`.

Aceite:

- Viewer/operator recebem `403`.
- Admin/owner conseguem executar quando apropriado.

## Prioridade 3 - Easy Backup

### 5. Remover defaults fracos do compose

Arquivo:

- `docker-compose.platform.yml`

Problema:

- Easy Backup usa defaults previsiveis:
  - `EASY_BACKUP_DB_PASSWORD`
  - `EASY_BACKUP_JWT_SECRET`

Tarefa:

- Trocar defaults por variaveis obrigatorias no padrao `${VAR:?set VAR in .env.platform}`.
- Atualizar `.env.platform.example` se necessario.
- Garantir que o compose falhe claramente se segredo nao for definido.

Aceite:

- `EASY_BACKUP_DB_PASSWORD` e `EASY_BACKUP_JWT_SECRET` nao possuem fallback fraco.
- Exemplo documenta como preencher valores fortes.

### 6. Restringir CORS do Easy Backup

Arquivos:

- `easy-backup-manager/backend/src/app.ts`
- `easy-backup-manager/backend/src/server.ts`
- `easy-backup-manager/backend/src/config.ts`

Problema:

- `app.use(cors())` abre CORS geral.
- Socket.IO usa `origin: '*'`.
- `config.corsOrigin` existe, mas nao e aplicado.

Tarefa:

- Aplicar `cors({ origin: config.corsOrigin })`.
- Aplicar o mesmo limite no Socket.IO.
- Manter desenvolvimento local funcionando com env adequada.

Aceite:

- CORS nao fica aberto por padrao em producao.
- `CORS_ORIGIN`/`EASY_BACKUP_CORS_ORIGIN` controla origem permitida.

## Prioridade 4 - Fallbacks Legados

### 7. Revisar fallback global de snapshots

Arquivo:

- `app/main.py`

Problema:

- Rotas de snapshot tentam pasta tenant primeiro, mas depois fazem fallback para pastas globais legadas:
  - `DATA_DIR / "snapshot"`
  - `SAIDA_DIR / "snapshot"`
  - `SAIDA_DIR / "snapshot_manual"`
  - `DATA_DIR / "dvr_snapshot"`
  - `DATA_DIR / "nvr_snapshot"`

Tarefa:

- Em producao, evitar fallback global entre tenants.
- Alternativa: permitir fallback apenas quando nao houver tenant autenticado ou via flag explicita de compatibilidade.
- Nao quebrar instalacoes legadas sem documentar migracao.

Aceite:

- Usuario de um tenant nao consegue acessar midia global/legada de outro cliente sabendo o nome do arquivo.
- Fluxo legado tem comportamento controlado por env flag, se necessario.

### 8. Revisar token legado do Windows Agent

Arquivo:

- `app/services/windows_inventory_service.py`

Problema:

- `validate_windows_agent_token()` ainda aceita token global legado e mapeia para tenant `default`.

Tarefa:

- Criar flag para permitir/desabilitar compatibilidade legada.
- Em producao, preferir desabilitado por padrao.
- Documentar migracao dos agentes para token por tenant.

Aceite:

- Com flag desabilitada, token legado global nao autentica.
- Tokens por tenant continuam funcionando.

## Prioridade 5 - Live Stream

### 9. Reduzir exposicao de `live_token` em URL

Arquivo:

- `app/api/endpoints/live.py`

Problema:

- `api_live_session()` retorna `mjpeg_url` e `jpeg_url` com `live_token` na query string.
- Query string pode aparecer em logs, historico e referer.

Tarefa:

- Avaliar alternativa via cookie HttpOnly curto, header ou session id menos sensivel.
- Se mantiver query string por compatibilidade, reduzir TTL e garantir que logs nao registrem token.

Aceite:

- Novo fluxo evita token sensivel em URL ou documenta mitigacao.
- Frontend continua abrindo MJPEG/JPEG.

## Validacoes Esperadas

Rodar no minimo:

```powershell
python -m compileall -q app
node --check frontend\js\core.js
node --check frontend\js\bootstrap.js
node --check frontend\js\network.js
python scripts\sightops_saas_smoke.py
python scripts\sightops_schema_migration_test.py
python scripts\sightops_olt_registry_test.py
python scripts\sightops_hikvision_switch_test.py
```

Se Docker estiver disponivel:

```powershell
docker compose config
docker compose -f docker-compose.platform.yml config
```

## Observacoes Importantes

- Nao reverter mudancas nao relacionadas.
- Nao apagar arquivos sensiveis sem confirmacao do usuario.
- Nao publicar valores reais de `.env`, senhas, tokens ou chaves.
- Antes de alterar regras de auth, verificar impacto nas telas do frontend.
- Se adicionar env flags, atualizar `.env.example`, `.env.platform.example` e documentacao curta.

