# PostgreSQL Deployment Prep

Esta etapa prepara o projeto para subir em `Linux + Docker + docker compose` com PostgreSQL, sem forcar a migracao completa do storage legado no mesmo passo.

## O que ja esta pronto

- `docker-compose.yml` sobe:
  - `cam-snapshot-api`
  - `postgres`
- variaveis de ambiente para PostgreSQL em `.env`
- `psycopg` nas dependencias do backend
- health/info do sistema agora mostram:
  - backend configurado
  - se o PostgreSQL esta alcancavel
  - host/porta/banco configurados

## Importante nesta fase

O sistema ainda usa partes legadas em SQLite para persistencia operacional e auth.

Ou seja:

- o ambiente de PostgreSQL ja pode ser provisionado
- o app ja consegue validar conectividade com o banco
- a migracao real das tabelas/repositorios para PostgreSQL ainda sera o proximo passo

Isso foi proposital para evitar regressao enquanto fechamos a arquitetura.

## Exemplo de `.env` para Linux

```env
APP_ENV=production
APP_PORT=8000
LOG_LEVEL=INFO
LOG_JSON=1
ENABLE_DOCS=0

DATABASE_BACKEND=postgres
DATABASE_HOST=postgres
DATABASE_PORT=5432
DATABASE_NAME=sightops
DATABASE_USER=sightops
DATABASE_PASSWORD=troque-essa-senha
DATABASE_URL=postgresql://sightops:troque-essa-senha@postgres:5432/sightops

DATA_DIR=data
SIGHTOPS_DB_PATH=data/sightops.db
AUTH_DB_PATH=data/auth.db
```

## Como subir

```bash
docker compose up --build
```

## Hardening inicial de producao

O `docker-compose.yml` agora inclui:

- `nginx` na porta `80` como proxy reverso para a API
- healthcheck da API
- healthcheck do `nginx`
- API publicada apenas em `127.0.0.1:8000`
- PostgreSQL exposto somente em `127.0.0.1:5432`

Isso reduz exposicao desnecessaria do banco e melhora a observabilidade do stack.

## Como validar

- `GET /api/system/health/live`
- `GET /api/system/health/ready`
- `GET /api/system/info`

Quando `DATABASE_BACKEND=postgres`, o retorno de readiness/info deve mostrar:

- `configured: true`
- `reachable: true`

## Proximo passo recomendado

1. criar a camada de engine/session para PostgreSQL
2. migrar schema do `db_store` para SQLAlchemy + Alembic
3. migrar auth para o mesmo banco com separacao logica por tabelas/schema
4. remover dependencia operacional do SQLite em producao

## Migracao incremental ja disponivel

- `POST /api/auth/storage/migrate`
- `POST /api/db/storage/migrate`

Recomendacao:

1. migrar auth
2. migrar storage principal
3. validar contagens no PostgreSQL
4. so depois trocar o runtime do app para `DATABASE_BACKEND=postgres`
