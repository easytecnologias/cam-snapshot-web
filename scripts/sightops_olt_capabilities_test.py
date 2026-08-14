from __future__ import annotations

import sys
from pathlib import Path

from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.models.requests import OltAddOnuRequest, OltCollectMacsRequest, OltOnuSignalRequest
from app.cli.tools.olt_4840e_collect_macs import (
    collect_onu_telemetry_4840e_from_outputs,
    discover_onus_4840e_from_show_pon,
    find_onu_4840e_from_show_pon,
    onu_signal_4840e_from_outputs,
)
from app.services.olt_capabilities import normalize_olt_driver, olt_capabilities, require_olt_capability
from app.services.olt_service import _same_onu_position, add_onu, onu_signal


def check(cond: bool, msg: str, failures: list[str]) -> None:
    if not cond:
        failures.append(msg)


def expect_422(fn, msg: str, failures: list[str]) -> None:
    try:
        fn()
    except HTTPException as exc:
        check(exc.status_code == 422, f"{msg}: status esperado 422, veio {exc.status_code}", failures)
        check("4840E" in str(exc.detail), f"{msg}: detalhe nao cita 4840E: {exc.detail}", failures)
    else:
        failures.append(f"{msg}: nao bloqueou")


def main() -> int:
    failures: list[str] = []

    caps_4840 = olt_capabilities("Intelbras", "4840E")
    check(caps_4840["driver"] == "intelbras_4840e", f"driver 4840E errado: {caps_4840}", failures)
    check(caps_4840["capabilities"]["collect_macs"] is True, "4840E precisa sincronizar inventario", failures)
    check(caps_4840["capabilities"]["telemetry"] is True, "4840E precisa atualizar telemetria automatica", failures)
    check(caps_4840["capabilities"]["discover_onus"] is True, "4840E deve listar ONUs/posicoes livres", failures)
    check(caps_4840["capabilities"]["find_onu"] is True, "4840E deve localizar ONU autorizada", failures)
    check(caps_4840["capabilities"]["onu_signal"] is True, "4840E deve consultar ONU/MACs", failures)
    check(caps_4840["capabilities"]["add_onu"] is False, "4840E nao pode autorizar ainda", failures)
    check(caps_4840["capabilities"]["delete_onu"] is False, "4840E nao pode excluir ainda", failures)

    caps_8820 = olt_capabilities("Intelbras", "8820i")
    check(caps_8820["capabilities"]["add_onu"] is True, "8820i deve autorizar", failures)
    check(caps_8820["capabilities"]["onu_signal"] is True, "8820i deve consultar sinal", failures)

    caps_fiberhome = olt_capabilities("FiberHome", "AN5516-06")
    check(caps_fiberhome["driver"] == "fiberhome", f"driver FiberHome errado: {caps_fiberhome}", failures)
    check(caps_fiberhome["capabilities"]["offline_audit"] is True, "FiberHome deve auditar offline", failures)

    caps_unknown = olt_capabilities("Acme", "XPTO")
    check(caps_unknown["capabilities"]["collect_macs"] is False, "desconhecida nao pode coletar", failures)

    collect_req = OltCollectMacsRequest(
        olt_ip="192.168.50.2",
        user="admin",
        password="secret",
        olt_vendor="Intelbras",
        olt_model="4840E",
    )
    check(require_olt_capability(collect_req, "collect_macs")["driver"] == "intelbras_4840e", "guard 4840E collect falhou", failures)

    add_req = OltAddOnuRequest(
        olt_ip="192.168.50.2",
        user="admin",
        password="secret",
        olt_vendor="Intelbras",
        olt_model="4840E",
        pon=1,
        serno_id=1,
        vlan=3000,
    )
    expect_422(lambda: add_onu(add_req), "add_onu 4840E", failures)

    signal_req = OltOnuSignalRequest(
        olt_ip="192.168.50.2",
        user="admin",
        password="secret",
        olt_vendor="Intelbras",
        olt_model="4840E",
        pon=1,
        onu=1,
    )
    sample_show_pon = """
ONU      MAC               LLID type     config Caixa
0/1/1    30:e1:f1:73:a7:19 0004 other    enable Caixa-20
0/1/3    80:85:44:5f:32:ca 0005 other    enable SenhoraSantana
Total onu entries: 2 .
"""
    sample_mac = """
MAC Address           VLAN ID  ONU      status
d8:36:5f:66:3a:35     3000     0/1/1    dynamic
Total entries: 1 .
"""
    sample_status = """
ONU Mac Address Dis(m) RegisterTime Type Software State
0/1/1 30:e1:f1:73:a7:19 2654 26/07/29 06:09:43 other 1.3-220719 Up
0/1/3 80:85:44:5f:32:ca - - - - Down
Total onu entries: 2 .
"""
    sample_opm = """
ONU: 0/1/1
Optical Transceiver Diagnosis :
Work Temperature : 52 Celsius
Supply Voltage(Vcc) : 3.27 V
TX Bias Current : 16.50 mA
TX Power(Output) : 2.798 mW (4.40 dBm)
RX Power(Input) : 0.002 mW (-26.00 dBm)
"""
    sample_sn = """
Vendor ID : ITBS  (HEX: 49 54 42 53)
Model : R1v2  (HEX: 52 31 76 32)
OnuID(MAC) : 30:e1:f1:73:a7:19
HWVersion : ONUR1_v2
SWVersion : 1.3-220719
"""
    discovered = discover_onus_4840e_from_show_pon(sample_show_pon, pon="1", max_onu=4)
    check(discovered["ok"] is True, "discover 4840E deve retornar ok", failures)
    check(discovered["pons"]["1"]["used"] == [1, 3], f"discover 4840E used errado: {discovered}", failures)
    check(discovered["pons"]["1"]["free"] == [2, 4], f"discover 4840E free errado: {discovered}", failures)

    found = find_onu_4840e_from_show_pon(sample_show_pon, "30:e1:f1:73:a7:19")
    check(found and found["pon"] == 1 and found["onu"] == 1, f"find 4840E errado: {found}", failures)

    signal = onu_signal_4840e_from_outputs(
        sample_show_pon,
        sample_mac,
        pon=1,
        onu=1,
        status_output=sample_status,
        opm_output=sample_opm,
        sn_output=sample_sn,
    )
    check(signal["ok"] is True, "signal 4840E deve retornar ok", failures)
    check(signal["serial"] == "30:e1:f1:73:a7:19", f"signal serial errado: {signal}", failures)
    check(signal["macs"][0]["mac"] == "d8:36:5f:66:3a:35", f"signal mac errado: {signal}", failures)
    check(signal["onu_rx"] == "-26.00 dBm", f"signal RX ONU errado: {signal}", failures)
    check(signal["onu_tx"] == "4.40 dBm", f"signal TX ONU errado: {signal}", failures)
    check(signal["distance_km"] == "2.654", f"signal distancia errada: {signal}", failures)
    check(signal["oper_status"] == "Up", f"signal status errado: {signal}", failures)
    check(signal["vendor_id"] == "ITBS", f"signal vendor id errado: {signal}", failures)
    check(signal["model"] == "R1v2", f"signal modelo ONU errado: {signal}", failures)

    telemetry = collect_onu_telemetry_4840e_from_outputs(sample_show_pon, sample_status, pon="all")
    check(len(telemetry) == 2, f"telemetria 4840E deve trazer 2 ONUs: {telemetry}", failures)
    check(telemetry[0]["pon"] == 1 and telemetry[0]["onu_id"] == 1, f"telemetria posicao 1 errada: {telemetry}", failures)
    check(telemetry[0]["oper_status"] == "Active", f"telemetria ONU up errada: {telemetry}", failures)
    check(telemetry[1]["oper_status"] == "Offline", f"telemetria ONU down errada: {telemetry}", failures)
    check(telemetry[1]["omci_status"] == "LOS", f"telemetria LOS errada: {telemetry}", failures)
    check(_same_onu_position({"olt_ip": "192.168.50.2", "pon": "0/1", "onu_id": "3"}, "192.168.50.2", 1, 3), "casamento PON 0/1 vs 1 falhou", failures)

    check(normalize_olt_driver("Intelbras", "4840") == "intelbras_4840e", "alias 4840 nao normalizou", failures)

    if failures:
        print(f"FALHOU ({len(failures)}):")
        for failure in failures:
            print(" -", failure)
        return 1
    print("OK OLT capabilities guard 4840E without touching network")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
