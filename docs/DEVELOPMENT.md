# Development Guide

This document explains how to work on SightOps Cam Snapshot as a developer. The goal is to keep the repository clean, predictable and safe for a system that handles operational credentials, network inventory and camera evidence.

## Local Workflow

Use a local `.env` file for development:

```bash
cp .env.example .env
```

Create a Python environment:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

On Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Run the application:

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Open:

```text
http://localhost:8000
```

## Docker Workflow

The Compose stack starts API, Nginx and PostgreSQL:

```bash
docker compose up --build
```

The API listens inside the stack on port `8000`; Nginx exposes the UI and API on port `80`.

## Code Organization

- `app/main.py` wires the FastAPI application, middleware, routes and static pages.
- `app/core/` contains cross-cutting concerns such as settings, security, paths and observability.
- `app/api/endpoints/` contains HTTP and WebSocket route modules grouped by domain.
- `app/services/` contains business logic, integrations, persistence helpers and device operations.
- `web/pages/` contains page templates served by the backend.
- `web/static/` contains the shared UI JavaScript and CSS.
- `tools/` and `app/cli/tools/` contain operational generators and command-line utilities.

## Development Principles

- Keep route handlers thin. Put reusable behavior in `app/services/`.
- Keep runtime data out of Git. Use `data/`, `output/` and `.env` locally only.
- Prefer explicit environment variables over hard-coded operational values.
- Do not log passwords, bearer tokens, API keys or camera credentials.
- Keep public endpoints intentional and listed in the auth middleware.
- Preserve tenant-aware behavior when touching inventory, reports, snapshots or settings.

## Validation

Fast import check:

```bash
python -B -c "import app.main; print('app.main ok')"
```

Frontend syntax check:

```bash
node -e "new Function(require('fs').readFileSync('web/static/app.js','utf8')); console.log('app.js syntax ok')"
```

Docker build check:

```bash
docker compose build
```

## Git Hygiene

The repository intentionally ignores:

- `.env` and local environment files.
- `data/` and `output/`.
- SQLite/PostgreSQL dumps and journals.
- Snapshots, PDFs, XLSX/CSV exports, KMZ/GeoJSON runtime files.
- Temporary files, archives and deployment bundles.

Before pushing, check:

```bash
git status --short
git diff --cached --name-only
```

If a credential was committed by mistake, rotate it. Removing it from a later commit is not enough for production safety.

## Release Process

1. Validate the app locally.
2. Update `README.md` or docs when behavior changes.
3. Commit with a clear message.
4. Tag stable releases:

```bash
git tag v1.1.0
git push origin main --tags
```

5. Deploy from a tag or a reviewed commit, not from untracked production edits.
