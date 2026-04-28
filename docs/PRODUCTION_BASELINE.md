# Production Baseline

Esta etapa introduz a primeira camada de maturidade operacional sem reescrever o sistema:

- configuracao centralizada via ambiente
- endpoints de healthcheck e info
- logging HTTP com `X-Request-ID`
- artefatos de container para deploy

## Endpoints novos

- `GET /api/system/health/live`
- `GET /api/system/health/ready`
- `GET /api/system/info`
- `POST /api/system/bootstrap`

## Variaveis principais

- `APP_ENV`
- `APP_VERSION`
- `LOG_LEVEL`
- `LOG_JSON`
- `ENABLE_DOCS`
- `SIGHTOPS_DB_PATH`
- `DATABASE_BACKEND`
- `DATABASE_URL`
- `DATABASE_HOST`
- `DATABASE_PORT`
- `DATABASE_NAME`
- `DATABASE_USER`

## Proximo passo recomendado

Depois desta base, a evolucao natural e:

1. autenticacao e usuarios
2. PostgreSQL com migrations
3. testes automatizados dos endpoints criticos
4. fila assincrona para scans e snapshots
