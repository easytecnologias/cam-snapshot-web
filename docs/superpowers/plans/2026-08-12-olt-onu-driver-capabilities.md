# OLT ONU Driver Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Implantacao > ONU choose safe behavior per OLT vendor/model, so unsupported models do not call the wrong driver.

**Architecture:** Add one backend capability registry that classifies OLTs by vendor/model and exposes the supported operations. Service functions must require a capability before touching live equipment, and the ONU UI must disable unsupported actions with a clear status.

**Tech Stack:** FastAPI/Pydantic backend, existing SightOps OLT services, vanilla frontend JS/CSS.

## Global Constraints

- No manual server-only fix; changes must live in code and deploy artifacts.
- Keep tenant and connector scope intact; private IPs can repeat between customers.
- Keep 4840E inventory sync working, but do not route provisioning calls to the 8820i driver.
- Keep existing 8820i and FiberHome flows working.

---

### Task 1: Backend Capabilities Contract

**Files:**
- Create: `app/services/olt_capabilities.py`
- Modify: `app/services/olt_registry.py`
- Modify: `app/api/endpoints/olt.py`
- Test: `scripts/sightops_olt_capabilities_test.py`

**Interfaces:**
- Produces: `normalize_olt_driver(vendor, model) -> str`
- Produces: `olt_capabilities(vendor, model) -> dict`
- Produces: `require_olt_capability(req_or_dict, capability, action_label) -> dict`

- [ ] Add capability mapping for Intelbras 8820i, Intelbras 4840E, FiberHome AN5516/AN6000, and unknown OLTs.
- [ ] Include `driver` and `capabilities` in public OLT registry responses.
- [ ] Add read endpoints for capabilities.
- [ ] Add tests proving 4840E supports collect only and unsupported operations raise HTTP 422 before network access.

### Task 2: Service Guardrails

**Files:**
- Modify: `app/services/olt_service.py`
- Test: `scripts/sightops_olt_capabilities_test.py`

**Interfaces:**
- Consumes: `require_olt_capability`.

- [ ] Gate `collect_macs`, `collect_onu_telemetry`, `discover_onus`, `add_onu`, `find_onu`, `delete_onu`, and `onu_signal`.
- [ ] Keep current branches for 8820i and FiberHome after the gate.
- [ ] Return clear messages for unsupported 4840E actions.

### Task 3: ONU UI Capability Awareness

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/deploy.js`
- Modify: `frontend/styles.css` if a new visual state is needed.

**Interfaces:**
- Consumes: `capabilities` from `/api/olt/registry`.

- [ ] Show a compact model/capability status under the selected OLT.
- [ ] Disable unsupported accordion actions and buttons.
- [ ] Prevent accidental click calls when a selected driver lacks the needed capability.
- [ ] Bump the `deploy.js` cache version.

### Task 4: Verification And Production Deploy

**Files:**
- No source changes unless validation exposes a defect.

- [ ] Run Python compile for changed backend files.
- [ ] Run `node --check frontend/js/deploy.js`.
- [ ] Run focused OLT tests.
- [ ] Backup production changed files.
- [ ] Deploy only changed backend/frontend files.
- [ ] Compile backend inside the production API container.
- [ ] Restart API, reload nginx, and commit the API image tag so restart preserves changes.
- [ ] Validate production capability behavior for Intelbras 4840E and at least one supported non-4840E driver.
