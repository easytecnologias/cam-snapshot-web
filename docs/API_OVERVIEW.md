# API and Architecture Overview

SightOps Cam Snapshot is organized as a FastAPI application with a service-oriented backend and a static browser UI served by the same app.

## Runtime Flow

```text
Browser UI
  -> Nginx reverse proxy
  -> FastAPI app
  -> API endpoint module
  -> service layer
  -> runtime storage, camera/NVR/DVR/OLT/switch integrations
```

In Docker, Nginx exposes port `80` and proxies traffic to the API container on port `8000`.

## Application Entry Point

`app/main.py` is the canonical entry point:

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

`api.py` remains as a compatibility shim for older deployments that still run `uvicorn api:app`.

## Core Modules

- `app/core/settings.py`: reads environment variables and builds runtime settings.
- `app/core/security.py`: API authentication middleware, role checks and tenant context setup.
- `app/core/observability.py`: logging and request context.
- `app/core/paths.py`: canonical runtime paths.
- `app/core/tenant_context.py`: tenant scoping helper.
- `app/core/database_runtime.py`: database connectivity status.

## Endpoint Groups

- `/api/auth/*`: login, bootstrap, users, tokens and audit.
- `/api/system/*`: health and runtime status.
- `/api/cameras/*`: camera inventory and camera actions.
- `/api/scan`: camera scan workflow.
- `/api/olt/*`: OLT collection and enrichment.
- `/api/switch/*`: switch collection and enrichment.
- `/api/dvr/*`: DVR inventory, reports and maintenance.
- `/api/nvr/*`: NVR inventory, reports and maintenance.
- `/api/maintenance/*`: operational camera actions.
- `/api/tools/*`: utility endpoints and integrations.
- `/ws/*`: WebSocket workflows for scan and live progress.

## Authentication Model

Authentication is controlled by environment variables:

- `AUTH_ENABLED=1` enables auth.
- `AUTH_REQUIRED=1` requires login for API routes that are not explicitly public.
- `AUTH_LEGACY_OPEN=0` disables legacy open writes.

The middleware accepts bearer tokens and attaches the current user and tenant to request state.

Roles are ranked:

```text
viewer < operator < admin < owner
```

Route-level rules in `app/core/security.py` define the minimum role for sensitive write operations.

## Tenant-Aware Storage

Authenticated operations use the user's tenant slug to isolate runtime files:

```text
data/tenants/<tenant_slug>/
```

This applies to inventory, settings, snapshots, report logos and KMZ inputs/outputs where the feature has been migrated to tenant-aware storage.

## Public Health Endpoints

These endpoints are intentionally public for reverse proxy and container health checks:

```text
GET /api/system/health/live
GET /api/system/health/ready
GET /api/system/info
```

`/docs`, `/redoc` and `/openapi.json` are controlled by `ENABLE_DOCS`.

## Frontend Contract

The UI is intentionally simple: HTML pages plus shared JavaScript and CSS.

- Pages live in `web/pages/`.
- Shared UI logic lives in `web/static/app.js`.
- Shared styling lives in `web/static/style.css`.
- Authenticated requests use bearer tokens from the login flow.
- WebSocket auth sends a token frame instead of relying only on query-string tokens.

## Data Safety

This project handles sensitive operational data. Do not commit:

- `.env`
- databases
- snapshots
- generated reports
- customer inventories
- exported KMZ/GeoJSON files
- logs or deployment bundles

The `.gitignore` and `.dockerignore` files are part of the security boundary for the repository.
