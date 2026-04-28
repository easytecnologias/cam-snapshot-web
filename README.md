# SightOps Cam Snapshot

SightOps Cam Snapshot is a FastAPI-based operations console for CCTV and network teams. It inventories IP cameras, DVRs and NVRs, captures visual evidence, enriches assets with OLT/switch data, and exports reports for field and management workflows.

The project includes a backend API, a browser UI, Docker deployment files, PostgreSQL support, tenant-aware storage, authentication, health checks, and helper tools for integrations such as ImgBB, MikroTik Netwatch, Zabbix, Grafana and KMZ/GeoJSON maps.

## Main Features

- Camera inventory by IP, range or CIDR.
- Snapshot capture for IP cameras, DVR channels and NVR channels.
- Multi-tenant authentication with roles: `viewer`, `operator`, `admin` and `owner`.
- Tenant-aware inventory, report logo, snapshot and KMZ storage.
- PostgreSQL or SQLite runtime storage.
- Live scan progress through WebSocket endpoints.
- Maintenance actions for supported cameras, including ping, reboot, rename, NTP, PTZ and password workflows.
- OLT and switch enrichment for network context.
- PDF, XLSX, KMZ, Grafana, Zabbix and MikroTik helper exports.
- Docker Compose deployment with Nginx reverse proxy and health checks.

## Project Structure

```text
app/
  api/endpoints/        FastAPI route modules
  core/                 settings, security, observability and path helpers
  services/             inventory, scans, reports, storage and device services
  cli/tools/            command-line utilities
web/
  pages/                HTML pages served by the backend
  static/               shared JavaScript and CSS
deploy/nginx/           Nginx reverse proxy configuration
config/                 example input files
docs/                   architecture, security and deployment notes
scripts/                cleanup and support scripts
tools/                  integration generators and import helpers
```

Runtime folders such as `data/`, `output/`, generated reports, snapshots, databases and local `.env` files are intentionally ignored by Git.

## Requirements

- Python 3.11 recommended.
- Docker and Docker Compose for production-style deployment.
- `ffmpeg` for live/snapshot workflows that depend on video streams.
- PostgreSQL 16 when using the Compose stack.

Python dependencies are listed in `requirements.txt`.

## Local Setup

Create a local environment file:

```bash
cp .env.example .env
```

Install dependencies and run the API:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

On Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Open `http://localhost:8000`.

## Docker Compose

For a complete stack with API, Nginx and PostgreSQL:

```bash
cp .env.example .env
docker compose up --build
```

The default Compose layout exposes:

- Web/Nginx: `http://localhost`
- API container: `127.0.0.1:8000`
- PostgreSQL: `127.0.0.1:5432`

Before using this in production, edit `.env` and set real passwords, hostnames and origins.

## Configuration

Important environment variables:

| Variable | Purpose |
| --- | --- |
| `APP_ENV` | Runtime mode, usually `development` or `production`. |
| `ENABLE_DOCS` | Enables `/docs`, `/redoc` and `/openapi.json`. Keep disabled in production unless needed. |
| `DATABASE_BACKEND` | `sqlite` or `postgres`. |
| `DATABASE_URL` | Full database URL. If empty, the app builds one from host/user/password variables. |
| `DATA_DIR` | Runtime data directory. Defaults to `data`. |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins. Avoid `*` in production. |
| `AUTH_ENABLED` | Enables authentication layer. |
| `AUTH_REQUIRED` | Requires login for protected API routes. |
| `AUTH_LEGACY_OPEN` | Legacy compatibility flag. Use `0` in production. |
| `AUTH_TOKEN_TTL_HOURS` | Access token lifetime. |
| `IMGBB_API_KEY` | Optional ImgBB API key for snapshot publishing. |

Never commit `.env`, databases, generated reports, snapshots or customer inventory files.

## Initial Authentication

When the auth database has no users, bootstrap the first admin:

```bash
curl -X POST http://localhost:8000/api/auth/bootstrap-admin \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"change-this-password\",\"tenant_slug\":\"default\",\"tenant_name\":\"Default\"}"
```

Then log in:

```bash
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"change-this-password\",\"label\":\"web\"}"
```

Use the returned bearer token in authenticated API calls.

## Health Checks

The application exposes:

- `GET /api/system/health/live` for process liveness.
- `GET /api/system/health/ready` for database/runtime readiness.
- `GET /api/system/info` for non-secret runtime information.

## Production Checklist

- Set `APP_ENV=production`.
- Set `ENABLE_DOCS=0`.
- Set `AUTH_ENABLED=1`, `AUTH_REQUIRED=1` and `AUTH_LEGACY_OPEN=0`.
- Replace every default password in `.env`.
- Restrict `ALLOWED_ORIGINS` to the real application domain.
- Keep API port `8000` bound to localhost or an internal network.
- Serve public traffic through Nginx or another reverse proxy.
- Keep `.env` permissions restricted, for example `chmod 600 .env`.
- Keep `data/` and `output/` backed up, but outside Git.
- Use Git tags/releases instead of editing production code directly.

## Common Commands

Run syntax validation:

```bash
python -B -m py_compile app/main.py app/core/*.py app/api/endpoints/*.py app/services/*.py app/services/camsnapshot/*.py
```

Clean generated artifacts:

```bash
./scripts/maintenance/cleanup.sh --dry-run
./scripts/maintenance/cleanup.sh --force
```

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\maintenance\cleanup.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File .\scripts\maintenance\cleanup.ps1 -Force
```

## Security Notes

This application handles camera credentials, bearer tokens, network inventory, snapshots and operational reports. Treat the host and the runtime data directory as sensitive infrastructure.

- Do not store real credentials in source files.
- Do not commit `.env`, `data/`, `output/`, snapshots, PDFs or database files.
- Rotate credentials if a local environment file was ever exposed.
- Prefer private GitHub repositories for operational deployments.
- Review generated exports before sharing them outside the operations team.

## License

See `LICENSE`.
