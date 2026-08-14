from __future__ import annotations

from collections import Counter

from app.core.tenant_context import set_current_tenant_slug
from app.services.dashboard_service import (
    _has_snapshot,
    _is_offline,
    _is_online,
    build_dashboard_summary,
)
from app.services.inventory_json import inventory_row_key, load_inventory_json


def main() -> None:
    set_current_tenant_slug("easy-tecnologias")
    summary = build_dashboard_summary()
    print("SUMMARY_IP", summary["inventory"]["ip"])
    print("ALERTS", summary["alerts"])

    seen: set[str] = set()
    rows: list[tuple[str, dict]] = []
    for mode in ["basic", "olt", "switch"]:
        data = load_inventory_json(mode=mode) or []
        print(
            "MODE",
            mode,
            "raw",
            len(data),
            "online",
            sum(1 for r in data if _is_online(r)),
            "offline",
            sum(1 for r in data if _is_offline(r)),
            "missing_snap",
            sum(1 for r in data if not _has_snapshot(r)),
            "missing_snap_with_local",
            sum(1 for r in data if not _has_snapshot(r, resolve_local=True)),
        )
        for row in data:
            key = inventory_row_key(row, fallback=f"ROW:{id(row)}")
            if key in seen:
                continue
            seen.add(key)
            rows.append((mode, row))

    missing = [(mode, row) for mode, row in rows if not _has_snapshot(row)]
    missing_with_local = [(mode, row) for mode, row in rows if not _has_snapshot(row, resolve_local=True)]
    print(
        "DEDUP",
        "total",
        len(rows),
        "online",
        sum(1 for _, row in rows if _is_online(row)),
        "offline",
        sum(1 for _, row in rows if _is_offline(row)),
        "missing",
        len(missing),
        "missing_with_local",
        len(missing_with_local),
    )
    print(
        "MISSING_STATUS",
        "online",
        sum(1 for _, row in missing if _is_online(row)),
        "offline",
        sum(1 for _, row in missing if _is_offline(row)),
        "unknown",
        sum(1 for _, row in missing if not _is_online(row) and not _is_offline(row)),
    )
    print("MISSING_BY_MODE", Counter(mode for mode, _ in missing))
    print(
        "MISSING_BY_SITE",
        Counter(
            row.get("local") or row.get("site") or row.get("site_name") or "-"
            for _, row in missing
        ).most_common(10),
    )
    for mode, row in missing[:30]:
        snapshot_fields = {
            key: row.get(key)
            for key in [
                "snapshot_url",
                "snapshot_path",
                "thumb_url",
                "imgbb_url",
                "imgbb_thumb_url",
                "snapshot_file",
            ]
            if row.get(key)
        }
        print(
            "MISS",
            mode,
            row.get("ip"),
            row.get("status"),
            row.get("local") or row.get("site"),
            row.get("titulo") or row.get("title"),
            snapshot_fields,
        )


if __name__ == "__main__":
    main()
