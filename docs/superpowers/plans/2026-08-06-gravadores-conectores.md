# Gravadores Com Conectores Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Gravadores inventory scan follow the same connector/VPN/site/mode behavior used by Cameras IP.

**Architecture:** Reuse the existing connector reachability decision from `app.services.ws_scan_service` for NVR/DVR scans. Keep current recorder endpoints and frontend modal, adding connector context and cache clearing instead of introducing a new scanner.

**Tech Stack:** FastAPI, Python service helpers, vanilla frontend JavaScript, nginx-served `/v2` assets.

## Global Constraints

- Do not mix tenants or clients that share private IPs; preserve `remote_connector_id` on remote recorder rows.
- Keep recorder source separate: `nvr` and `dvr` are distinct inventories.
- Keep recorder modes separate: `basico`, `olt`, and `switch` are views, not interchangeable data stores.
- Publish only changed files to `sightops-api` and `sightops-nginx` after local syntax validation.

---

### Task 1: Backend Connector Context For Recorder Scans

**Files:**
- Modify: `app/models/requests.py`
- Modify: `app/api/endpoints/nvr.py`
- Modify: `app/api/endpoints/dvr.py`

**Interfaces:**
- Consumes: `_connector_from_payload`, `_connector_has_tunnel`, `_pick_probe_targets`, `_decide_remote_only` from `app.services.ws_scan_service`.
- Produces: NVR/DVR scan rows tagged with `remote`, `remote_connector_id`, `remote_connector_name`, `site`, `site_name`, and `inventory_mode`.

- [ ] Add connector fields to `DVRScanRequest`.
- [ ] Add a small helper in each endpoint to reject scans that would fall back to MikroTik-only discovery, because recorder scan needs HTTP access to the recorder.
- [ ] Tag returned rows with connector/site/mode metadata before writing inventory.
- [ ] Compile both endpoint files.

### Task 2: Frontend Recorder Modal Connector Controls

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/bootstrap.js`
- Modify: `frontend/js/recorders.js`

**Interfaces:**
- Consumes: `_networkContextForSite`, `refreshScanConnectors`, `_connectorLabel`, `clearApiJsonCache`, `_loadRecForMode`.
- Produces: NVR/DVR scan payload with `scan_origin`, `connector_id`, `remote_connector_id`, `remote_only`, `inventory_mode`, and site.

- [ ] Add Origin/Connector/Status controls to the NVR/DVR scan modal.
- [ ] Populate connector choices using the same connector list already used by Cameras IP.
- [ ] Include connector context in `_nvrPayload`.
- [ ] Keep Básico/OLT/Switch tabs visible even when empty.
- [ ] Clear recorder API/session cache after scans and reload selected mode.

### Task 3: Validation And Deploy

**Files:**
- Test: `python -m py_compile app/models/requests.py app/api/endpoints/nvr.py app/api/endpoints/dvr.py`
- Test: `node --check frontend/js/bootstrap.js frontend/js/recorders.js`

- [ ] Run local syntax checks.
- [ ] Copy backend files into `sightops-api` and restart it.
- [ ] Copy frontend files into `/usr/share/nginx/html/v2` and reload nginx.
- [ ] Verify `/v2/` references bumped script versions.
- [ ] Verify authenticated `/api/nvr/inventory` and `/api/dvr/inventory` still respond.
