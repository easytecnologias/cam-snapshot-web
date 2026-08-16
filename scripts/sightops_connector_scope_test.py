from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.connector_service import connector_target_scope, connector_trusted_lans
from app.services.inventory_json import inventory_row_key


def assert_equal(actual, expected, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def assert_true(value, label: str) -> None:
    if not value:
        raise AssertionError(label)


def main() -> None:
    connector = {
        "id": "conn-telha",
        "name": "TELHA",
        "inventory": {
            "address_sample": "10.50.11.1/24|bridge-cameras;192.168.50.1/30|wan-uplink",
            "lan_networks": ["10.50.11.0/24"],
        },
        "tunnel": {"client_lans": ["10.50.11.0/24"]},
    }

    lans = connector_trusted_lans(connector)
    assert_true("10.50.11.0/24" in lans, "trusted LANs keep saved LAN networks")

    scope = connector_target_scope(connector, ["10.50.11.33", "100.65.11.11"])
    assert_equal(scope["allowed"], ["10.50.11.33"], "target inside connector LAN is allowed")
    assert_equal(scope["blocked"], ["100.65.11.11"], "target outside connector LAN is blocked")

    telha_key = inventory_row_key({
        "ip": "100.65.11.11",
        "remote_connector_id": "conn-shared",
        "site": "TELHA",
    })
    barra_key = inventory_row_key({
        "ip": "100.65.11.11",
        "remote_connector_id": "conn-shared",
        "site": "BARRA DE SAO MIGUEL",
    })
    assert_true(telha_key != barra_key, "remote inventory key includes site when available")

    print("connector scope regression ok")


if __name__ == "__main__":
    main()
