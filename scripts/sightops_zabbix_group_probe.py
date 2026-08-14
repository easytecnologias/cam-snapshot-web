from __future__ import annotations

from collections import Counter

from app.api.endpoints.maintenance import (
    _as_str,
    _normalize_zabbix_url,
    _zabbix_api_call,
    _zabbix_effective_sync_config,
    _zabbix_host_belongs_to_tenant,
    _zabbix_host_safe,
    _zabbix_login,
    _zabbix_tenant_slug,
)
from app.core.tenant_context import set_current_tenant_slug
from app.services.db_store import load_app_settings


def main() -> None:
    tenant = "easy-tecnologias"
    set_current_tenant_slug(tenant)
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
            "output": ["hostid", "host", "name"],
            "selectHostGroups": ["groupid", "name"],
            "search": {"host": f"{_zabbix_host_safe(tenant_slug)}-"},
            "startSearch": True,
        },
        auth,
        1,
    ) or []
    tenant_hosts = [h for h in hosts if _zabbix_host_belongs_to_tenant(h, tenant_slug)]
    counts = Counter()
    samples = []
    for host in tenant_hosts:
        group_names = [_as_str(group.get("name")) for group in host.get("hostgroups") or []]
        for name in group_names:
            counts[name] += 1
        if len(samples) < 10:
            samples.append((host.get("host"), group_names))
    print("TENANT", tenant_slug)
    print("HOSTS", len(tenant_hosts))
    print("GROUP_COUNTS", counts.most_common())
    for host, groups in samples:
        print("SAMPLE", host, groups)


if __name__ == "__main__":
    main()
