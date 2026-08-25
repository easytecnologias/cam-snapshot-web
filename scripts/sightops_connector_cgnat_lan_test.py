from __future__ import annotations

import sys
from pathlib import Path
from tempfile import TemporaryDirectory


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
from app.services import connector_service
from app.services.connector_service import (
    _extract_connector_lans,
    build_routeros_script,
    create_connector,
    register_connector_known_targets,
)
from app.services.ws_scan_service import _targets_for_connector_scan


def main() -> None:
    row = {
        "inventory": {
            "lan_networks": "100.64.8.0/22;10.250.0.0/24;",
            "address_sample": (
                "100.64.10.1/22|BRIDGE DAS CAMERAS;"
                "10.250.0.4/24|sightops-wg;"
                "138.219.201.123/32|INTERNET TELECOM;"
            ),
        }
    }
    lans = _extract_connector_lans(row)
    assert "100.64.8.0/22" in lans, lans
    assert "10.250.0.0/24" not in lans, lans
    assert all(not item.startswith("138.219.") for item in lans), lans

    with TemporaryDirectory() as tmp:
        old_connectors = connector_service.CONNECTORS_PATH
        old_jobs = connector_service.CONNECTOR_JOBS_PATH
        connector_service.CONNECTORS_PATH = Path(tmp) / "connectors.json"
        connector_service.CONNECTOR_JOBS_PATH = Path(tmp) / "connector-jobs.json"
        connector_service._write_json(connector_service.CONNECTORS_PATH, [
            {
                "id": "perucaba",
                "tenant_slug": "perucaba",
                "name": "PERUCABA",
                "inventory": {"known_targets": []},
                "tunnel": {
                    "enabled": True,
                    "type": "wireguard",
                    "client_public_key": "perucaba-pub",
                    "client_address": "10.250.0.2/32",
                    "client_lans": ["192.168.1.0/24"],
                },
            },
            {
                "id": "dutra",
                "tenant_slug": "rads",
                "name": "DUTRA",
                "inventory": {"known_targets": []},
                "tunnel": {
                    "enabled": True,
                    "type": "wireguard",
                    "client_public_key": "dutra-pub",
                    "client_address": "10.250.0.8/32",
                    "client_lans": ["192.168.1.0/24"],
                },
            },
        ])
        token = set_current_tenant_slug("rads")
        try:
            result = register_connector_known_targets("dutra", ["192.168.1.101", "8.8.8.8", "192.168.1.101"])
            cgnat = create_connector({
                "id": "dutra-cgnat",
                "type": "routeros",
                "name": "DUTRA CGNAT",
                "client": "RADS",
                "site": "DUTRA",
                "access_mode": "cgnat",
            })["connector"]
            public = create_connector({
                "id": "dutra-public",
                "type": "routeros",
                "name": "DUTRA PUBLIC",
                "client": "RADS",
                "site": "DUTRA",
                "access_mode": "public",
            })["connector"]
            cgnat_script = build_routeros_script("https://sightops.example/v2", cgnat["id"])
            public_script = build_routeros_script("https://sightops.example/v2", public["id"])
        finally:
            reset_current_tenant_slug(token)
            connector_service.CONNECTORS_PATH = old_connectors
            connector_service.CONNECTOR_JOBS_PATH = old_jobs

        assert result["added"] == ["192.168.1.101"], result
        assert cgnat["access_mode"] == "cgnat", cgnat
        assert public["access_mode"] == "public", public
        assert "/interface wireguard add" in cgnat_script, cgnat_script
        assert "/system scheduler add name=\"sightops-connector\"" in cgnat_script, cgnat_script
        assert "/interface wireguard add" not in public_script, public_script
        assert "/system scheduler add name=\"sightops-connector\"" in public_script, public_script
        rows = connector_service._read_json(Path(tmp) / "connectors.json", [])
        perucaba = next(item for item in rows if item["id"] == "perucaba")
        dutra = next(item for item in rows if item["id"] == "dutra")
        auto_targets = _targets_for_connector_scan("", dutra, limit=260)
        assert "192.168.1.101" in auto_targets, auto_targets[:10]
        assert len(auto_targets) == 254, len(auto_targets)
        assert perucaba["inventory"]["known_targets"] == [], perucaba
        assert dutra["inventory"]["known_targets"] == ["192.168.1.101"], dutra
    print("OK connector CGNAT LAN detection", lans)


if __name__ == "__main__":
    main()
