from __future__ import annotations

from app.cli.tools.olt_4840e_collect_macs import onu_signal_4840e


def main() -> None:
    res = onu_signal_4840e(
        "100.64.10.5",
        "admin",
        "xzydsP2011",
        pon=4,
        onu=6,
        serial="30:e1:f1:73:a7:19",
        timeout=18,
    )
    keys = [
        "ok",
        "driver",
        "pon",
        "pon_label",
        "onu",
        "serial",
        "model",
        "oper_status",
        "onu_rx",
        "onu_tx",
        "distance_m",
        "distance_km",
        "register_time",
        "vendor_id",
        "hardware",
        "software",
    ]
    for key in keys:
        print(f"{key}={res.get(key)}")
    print(f"macs={len(res.get('macs') or [])}")
    print(f"note={res.get('note')}")


if __name__ == "__main__":
    main()
