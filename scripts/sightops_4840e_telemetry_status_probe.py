from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.core.tenant_context import set_current_tenant_slug
from app.api.endpoints.olt import api_olt_registry_telemetry
from app.services.monitoring_service import monitoring_summary, refresh_from_inventory
from app.services.olt_registry import list_olts


def main() -> int:
    tenant = sys.argv[1] if len(sys.argv) > 1 else "rads"
    set_current_tenant_slug(tenant)
    olts = list_olts(False)
    print("TENANT", tenant)
    print("OLTS", [(o.get("id"), o.get("name"), o.get("host"), o.get("model"), o.get("active")) for o in olts])
    telemetry = []
    for olt in olts:
        try:
            telemetry.append(api_olt_registry_telemetry(int(olt["id"])))
        except Exception as exc:
            telemetry.append({"ok": False, "olt_id": olt.get("id"), "error": str(exc)})
    print("TELEMETRY", telemetry)
    print("REFRESH", refresh_from_inventory())
    print("SUMMARY", monitoring_summary())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
