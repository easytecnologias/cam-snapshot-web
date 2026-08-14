from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.api.endpoints.maintenance import (
    _zabbix_host_belongs_to_tenant,
    _zabbix_tenant_group,
    _zabbix_tmp_inventory_path,
)
from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug


def main() -> int:
    token = set_current_tenant_slug("san-marine")
    try:
        group = _zabbix_tenant_group("Cameras")
        tmp_path = str(_zabbix_tmp_inventory_path("ip", "switch"))
        same = _zabbix_host_belongs_to_tenant({"host": "SAN-MARINE-CAM-172.16.49.6"}, "san-marine")
        other = _zabbix_host_belongs_to_tenant({"host": "OUTRO-CAM-172.16.49.6"}, "san-marine")
    finally:
        reset_current_tenant_slug(token)
    if group != "Cameras - SAN-MARINE":
        raise RuntimeError(f"grupo inesperado: {group}")
    if "/tenants/san-marine/" not in tmp_path.replace("\\", "/"):
        raise RuntimeError(f"tmp path sem tenant: {tmp_path}")
    if not same or other:
        raise RuntimeError(f"filtro de host falhou: same={same} other={other}")
    print("OK zabbix tenant probe: grupo, tmp e filtro de host isolados")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
