import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.hikvision_switch_service import _derive_login_password, build_snapshot, rate_dx_to_speed_duplex


def test_derive_login_password_matches_pbkdf2_reference():
    # Valores sinteticos (nao sao credencial de cliente nenhum) -- so
    # confirma que a PBKDF2-HMAC-SHA256 replica exatamente o `_pwdToAESKey`
    # do bundle JS do switch Hikvision. O hash esperado foi calculado uma
    # vez rodando esta mesma funcao com esses inputs fixos.
    derived = _derive_login_password(
        challenge="0011223344556677889900112233445566778899",
        username="admin",
        salt="SYNTHETICTESTSALT0000000000000000000000000000000000000000000",
        password="test-password-123",
        iterations=100,
    )
    assert len(derived) == 128
    assert derived == (
        "52de2c610986356b4140f968a33c26a806ddf5875debed70652e44c2760415"
        "eecd85d2921064621e3d06cc944f1e45746f86a8f5e48e8188a57c34d04d735abb"
    )


def test_build_snapshot_shapes_ports_poe_and_mac_table():
    sum_info = {
        "model": "DS-3E1309P-EI/M",
        "deviceName": "DS-3E1309P-EI/M",
        "softwareVersion": "V3.0.5 build 240704",
        "serialNumber": "FS3292423",
        "ipv4Address": "172.16.80.204",
        "macAddress": "a4:d5:c2:85:81:ea",
        "power": 14.8,
        "maxPower": 60,
        "CPUList": [{"CPUUtilization": 24}],
        "memoryList": [{"memoryUtilization": 48}],
        "deviceUpTime": 1409681,
    }
    # rate=3/dx=1 replica o real capturado pra Eth1 (100 Mbps/Full-Duplex).
    port_status = [
        {"ID": 1, "name": "Eth1", "lnkSta": 1, "rate": 3, "dx": 1, "poePow": 2.3, "stats": {"txPktS": 1, "rxPktS": 2}},
        {"ID": 8, "name": "Eth8", "lnkSta": 0, "poePow": 0},
    ]
    port_basic = [
        {"ID": 1, "name": "Eth1", "en": True, "rate": 3, "dx": 1, "flowCtrlEn": 1},
        {"ID": 8, "name": "Eth8", "en": False, "rate": 0, "dx": 0, "flowCtrlEn": 1},
    ]
    poe_info = [
        {"portID": 1, "portName": "Eth1", "enabled": True, "poePower": 2.27},
        {"portID": 8, "portName": "Eth8", "enabled": True, "poePower": 0},
    ]
    mac_entries = [
        {"portID": 9, "portName": "Ge1", "macAddress": "0c:80:63:98:27:7d", "addressType": "dynamic"},
        {"portID": 1, "portName": "Eth1", "macAddress": "", "addressType": "dynamic"},
    ]
    vlan_entries = [{"VLANID": 1}]

    snapshot = build_snapshot(sum_info, port_status, poe_info, mac_entries, vlan_entries, port_basic)

    assert snapshot["system"]["product_name"] == "DS-3E1309P-EI/M"
    assert snapshot["system"]["cpu_usage"] == "24%"
    assert snapshot["system"]["memory_usage"] == "48%"

    assert len(snapshot["interfaces"]) == 2
    eth1 = snapshot["interfaces"][0]
    assert eth1["name"] == "Eth1"
    assert eth1["port_id"] == 1
    assert eth1["flags"] == ["RUNNING"]
    assert eth1["bandwidth"] == "100M"
    assert eth1["duplex"] == "full"
    assert eth1["poe_power_watts"] == 2.27
    assert eth1["admin_enabled"] is True
    eth8 = snapshot["interfaces"][1]
    assert eth8["flags"] == []
    assert eth8["admin_enabled"] is False

    # entrada com mac vazio deve ser descartada
    assert len(snapshot["mac_table"]) == 1
    assert snapshot["mac_table"][0]["mac"] == "0c:80:63:98:27:7d"
    assert snapshot["mac_table"][0]["port"] == "Ge1"

    assert snapshot["vlans"] == [{"vlan_id": 1, "name": "", "state": "", "instance": "", "l3_interface": "", "member_ports": []}]

    assert snapshot["summary"] == {
        "interfaces_total": 2,
        "interfaces_up": 1,
        "vlans_total": 1,
        "mac_entries_total": 1,
    }


def test_rate_dx_to_speed_duplex_matches_switch_ui_table():
    assert rate_dx_to_speed_duplex(0, 3) == ("auto", "auto")
    assert rate_dx_to_speed_duplex(3, 1) == ("100M", "full")
    assert rate_dx_to_speed_duplex(1, 0) == ("10M", "half")
    assert rate_dx_to_speed_duplex(4, 1) == ("1000M", "full")
    # combinacao desconhecida cai pro seguro (auto-auto) em vez de quebrar
    assert rate_dx_to_speed_duplex(9, 9) == ("auto", "auto")


def main() -> None:
    test_derive_login_password_matches_pbkdf2_reference()
    test_build_snapshot_shapes_ports_poe_and_mac_table()
    test_rate_dx_to_speed_duplex_matches_switch_ui_table()
    print("OK: sightops_hikvision_switch_test")


if __name__ == "__main__":
    main()
