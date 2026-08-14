# SightOps Production Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a separate, stable SightOps production stack with its own app database, Zabbix, Grafana, network, ports, and volumes while leaving the homologation stack untouched.

**Architecture:** Production runs as a parallel Docker Compose project using `sightops-prod-*`, `zabbix-prod-*`, and `grafana-prod` container names. It uses independent named volumes and a separate Docker network so homologation data and production customer data never share Postgres, Zabbix, Grafana, or app output directories.

**Tech Stack:** Docker Compose, FastAPI SightOps image, Nginx, PostgreSQL 16, Zabbix 7.0, Grafana OSS.

## Global Constraints

- Homologation containers named `sightops-*`, `zabbix-*`, and `grafana` must keep running.
- Production containers must use `sightops-prod-*`, `zabbix-prod-*`, and `grafana-prod`.
- Production volumes must be new named volumes and must not reuse homologation volumes.
- Production app must require authentication: `AUTH_REQUIRED=1` and `AUTH_LEGACY_OPEN=0`.
- Production must use PostgreSQL for SightOps and Zabbix.
- Production frontend must be served from a repeatable release path, not copied manually into an existing container.

---

### Task 1: Production Compose

**Files:**
- Create: `docker-compose.production.yml`
- Create: `.env.production.example`

**Interfaces:**
- Consumes: `deploy/nginx/default.conf`, `frontend/`, and the SightOps Docker image.
- Produces: a complete production stack runnable with `docker compose --env-file .env.production -f docker-compose.production.yml up -d`.

- [x] **Step 1: Define production-only container names**

Use names:

```yaml
sightops-prod-api
sightops-prod-nginx
sightops-prod-postgres
zabbix-prod-postgres
zabbix-prod-server
zabbix-prod-web
zabbix-prod-agent2
grafana-prod
```

- [x] **Step 2: Define non-conflicting ports**

Use defaults:

```env
SIGHTOPS_HTTP_PORT=8088
SIGHTOPS_POSTGRES_PORT=5435
ZABBIX_WEB_PORT=8089
ZABBIX_SERVER_PORT=10052
GRAFANA_PORT=3002
```

- [x] **Step 3: Define isolated volumes**

Use volumes:

```yaml
sightops_prod_data:
sightops_prod_output:
sightops_prod_postgres:
zabbix_prod_postgres:
grafana_prod_data:
```

- [x] **Step 4: Mount frontend read-only**

Mount:

```yaml
- ./frontend:/usr/share/nginx/html/v2:ro
```

This avoids a manual `docker cp` step for production.

- [ ] **Step 5: Copy `.env.production.example` to `.env.production` on the server**

Run on the server inside the release directory:

```bash
cp .env.production.example .env.production
chmod 600 .env.production
```

- [ ] **Step 6: Replace all production secrets**

Generate values with:

```bash
openssl rand -base64 36
```

Replace:

```env
SIGHTOPS_DB_PASSWORD=
ZABBIX_DB_PASSWORD=
GRAFANA_ADMIN_PASSWORD=
SIGHTOPS_SECRET_KEY=
```

### Task 2: First Production Boot

**Files:**
- Use: `docker-compose.production.yml`
- Use: `.env.production`

**Interfaces:**
- Consumes: production compose and env.
- Produces: healthy production containers.

- [ ] **Step 1: Pull production images**

Run:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml pull
```

- [ ] **Step 2: Start the stack**

Run:

```bash
docker compose --env-file .env.production -f docker-compose.production.yml up -d
```

- [ ] **Step 3: Validate health**

Run:

```bash
docker ps --format '{{.Names}} {{.Status}}' | grep -E 'sightops-prod|zabbix-prod|grafana-prod'
curl -fsS http://127.0.0.1:8088/api/system/health/live
```

Expected:

```text
HTTP 200 from SightOps production health endpoint
```

### Task 3: Production Bootstrap

**Files:**
- Use: production database.
- Use: production UI.

**Interfaces:**
- Consumes: healthy stack.
- Produces: first owner/admin and empty customer-ready system.

- [ ] **Step 1: Create the production owner user**

Use the existing auth bootstrap mechanism or admin UI if already enabled. The first user must be an internal owner, not a customer user.

- [ ] **Step 2: Create first tenant**

Create a customer tenant, for example:

```text
Cliente: San Marine
Papel inicial: owner/admin interno
```

- [ ] **Step 3: Confirm tenant isolation**

Create a second test tenant and add the same camera IP in both tenants:

```text
Tenant A: 10.10.10.10
Tenant B: 10.10.10.10
```

Expected: each tenant sees only its own camera.

### Task 4: Production Monitoring

**Files:**
- Use: production Zabbix at `http://HOST:8089`.
- Use: production Grafana at `http://HOST:3002`.

**Interfaces:**
- Consumes: production SightOps tenant/customer inventory.
- Produces: isolated Zabbix and Grafana data for production only.

- [ ] **Step 1: Login to production Zabbix**

Open:

```text
http://10.10.12.7:8089
```

- [ ] **Step 2: Login to production Grafana**

Open:

```text
http://10.10.12.7:3002
```

- [ ] **Step 3: Sync only production inventory**

From production SightOps, run the Zabbix sync after selecting the production tenant/customer.

Expected: homologation Zabbix at `8081` remains unchanged.

### Task 5: Backup And Go-Live Gate

**Files:**
- Use: Docker named volumes.
- Create: backup procedure document or script in a later task.

**Interfaces:**
- Consumes: running production stack.
- Produces: a restore-tested production backup routine.

- [ ] **Step 1: Backup production volumes**

Back up:

```text
sightops_prod_postgres
sightops_prod_data
sightops_prod_output
zabbix_prod_postgres
grafana_prod_data
```

- [ ] **Step 2: Restore into a temporary stack**

Restore backups into temporary volumes and verify:

```bash
curl -fsS http://127.0.0.1:8088/api/system/health/live
```

- [ ] **Step 3: Go-live checklist**

Confirm:

```text
Authentication required
Owner user exists
Customer tenants isolated
Zabbix production has no homologation hosts
Grafana production has no homologation dashboards unless intentionally imported
Backup restore tested
Domain/HTTPS decided
```
