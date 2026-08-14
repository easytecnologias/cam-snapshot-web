from __future__ import annotations

from collections import Counter

from app.api.endpoints.maintenance import (
    _as_str,
    _load_ip_rows_by_mode,
    _normalize_zabbix_url,
    _zabbix_api_call,
    _zabbix_effective_sync_config,
    _zabbix_host_belongs_to_tenant,
    _zabbix_host_safe,
    _zabbix_login,
    _zabbix_tenant_slug,
    scripts_zabbix_status_sync,
)
from app.core.tenant_context import set_current_tenant_slug
from app.services.db_store import load_app_settings


def main() -> None:
    tenant = "easy-tecnologias"
    set_current_tenant_slug(tenant)
    payload = {"source": "ip", "mode": "all", "site": ""}
    sync = scripts_zabbix_status_sync(payload)
    print("STATUS_SYNC", sync)

    rows_by_mode = _load_ip_rows_by_mode(site="", mode="all")
    inventory_ips: set[str] = set()
    for mode, rows in rows_by_mode.items():
        ips = {
            _as_str((row or {}).get("ip") or (row or {}).get("IP"))
            for row in rows
            if isinstance(row, dict)
        }
        ips.discard("")
        inventory_ips.update(ips)
        print("INV_MODE", mode, len(ips))
    print("INV_TOTAL_UNIQUE", len(inventory_ips))

    settings = load_app_settings()
    saved = settings.get("zabbix_ip_sync") if isinstance(settings.get("zabbix_ip_sync"), dict) else {}
    cfg = _zabbix_effective_sync_config(saved)
    url = _normalize_zabbix_url(cfg.get("url"))
    auth = _zabbix_login(url, _as_str(cfg.get("user")), _as_str(cfg.get("pass") or cfg.get("password")))
    tenant_slug = _zabbix_tenant_slug()
    hosts = _zabbix_api_call(
        url,
        "host.get",
        {
            "output": ["hostid", "host", "name", "status", "available"],
            "selectInterfaces": ["interfaceid", "ip", "available", "error"],
            "search": {"host": f"{_zabbix_host_safe(tenant_slug)}-"},
            "startSearch": True,
        },
        auth,
        2,
    ) or []
    tenant_hosts = [h for h in hosts if _zabbix_host_belongs_to_tenant(h, tenant_slug)]
    host_ips: set[str] = set()
    for host in tenant_hosts:
        for iface in host.get("interfaces") or []:
            ip = _as_str((iface or {}).get("ip"))
            if ip:
                host_ips.add(ip)
    missing = sorted(inventory_ips - host_ips, key=lambda ip: tuple(int(p) if p.isdigit() else 999 for p in ip.split(".")))
    extra = sorted(host_ips - inventory_ips, key=lambda ip: tuple(int(p) if p.isdigit() else 999 for p in ip.split(".")))
    print("ZBX_HOSTS_TENANT", len(tenant_hosts), "ZBX_IPS", len(host_ips))
    print("MISSING_IN_ZABBIX", len(missing), missing[:30])
    print("EXTRA_IN_ZABBIX", len(extra), extra[:30])
    print("HOST_PREFIXES", Counter(_as_str(h.get("host")).split("-CAM-", 1)[0] for h in tenant_hosts).most_common(10))
    for host in tenant_hosts[:10]:
        print("HOST_SAMPLE", host.get("host"), host.get("name"), [(i or {}).get("ip") for i in host.get("interfaces") or []])


if __name__ == "__main__":
    main()
