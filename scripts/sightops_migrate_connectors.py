from __future__ import annotations

import argparse
import copy
import json
import os
import sys
from pathlib import Path
from typing import Any

ROOT = Path(os.environ.get("SIGHTOPS_APP_ROOT") or ("/app" if Path("/app/app").is_dir() else Path(__file__).resolve().parents[1]))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.services.connector_service import _load_connectors, _save_connectors, _text  # noqa: E402


WG_PREFIX = "10.250.0"
PROD_BASE_URL = "https://sightops.easytecnologias.com.br"


def _safe_public(row: dict[str, Any]) -> dict[str, Any]:
    out = {
        "id": row.get("id"),
        "tenant_slug": row.get("tenant_slug"),
        "type": row.get("type"),
        "name": row.get("name"),
        "client": row.get("client"),
        "site": row.get("site"),
        "public_base_url": row.get("public_base_url"),
        "last_seen": row.get("last_seen"),
        "has_token": bool(row.get("token")),
    }
    tunnel = row.get("tunnel") if isinstance(row.get("tunnel"), dict) else {}
    out["client_address"] = tunnel.get("client_address")
    out["client_lans"] = tunnel.get("client_lans")
    return out


def export_connectors(out_path: str, source_tenant: str = "", include_legacy: bool = True) -> dict[str, Any]:
    rows = _load_connectors()
    exported = []
    for row in rows:
        tenant = _text(row.get("tenant_slug"))
        if source_tenant and tenant != source_tenant:
            continue
        if not include_legacy and not tenant:
            continue
        exported.append(copy.deepcopy(row))
    payload = {"connectors": exported}
    Path(out_path).write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    return {"ok": True, "count": len(exported), "connectors": [_safe_public(row) for row in exported]}


def _used_wg_hosts(rows: list[dict[str, Any]]) -> set[int]:
    used: set[int] = set()
    for row in rows:
        tunnel = row.get("tunnel") if isinstance(row.get("tunnel"), dict) else {}
        raw = _text(tunnel.get("client_address")).split("/", 1)[0]
        if raw.startswith(WG_PREFIX + "."):
            try:
                used.add(int(raw.rsplit(".", 1)[1]))
            except Exception:
                pass
    return used


def _next_wg_address(used: set[int]) -> str:
    for host in range(2, 255):
        if host not in used:
            used.add(host)
            return f"{WG_PREFIX}.{host}/32"
    raise RuntimeError("sem IP WireGuard livre")


def import_connectors(in_path: str, target_tenant: str, replace: bool = False, public_base_url: str = PROD_BASE_URL) -> dict[str, Any]:
    payload = json.loads(Path(in_path).read_text(encoding="utf-8"))
    incoming = payload.get("connectors") if isinstance(payload, dict) else None
    if not isinstance(incoming, list):
        raise SystemExit("arquivo de entrada sem lista connectors")

    rows = _load_connectors()
    existing_by_id = {_text(row.get("id")): row for row in rows}
    used_hosts = _used_wg_hosts(rows)
    imported = []
    skipped = []
    remapped = []

    for original in incoming:
        if not isinstance(original, dict):
            continue
        cid = _text(original.get("id"))
        if not cid:
            skipped.append({"id": "", "reason": "sem id"})
            continue
        if cid in existing_by_id:
            existing = existing_by_id[cid]
            if _text(existing.get("tenant_slug")) != target_tenant or not replace:
                skipped.append({"id": cid, "reason": "ja existe"})
                continue
            rows = [row for row in rows if _text(row.get("id")) != cid]

        row = copy.deepcopy(original)
        row["tenant_slug"] = target_tenant
        row["public_base_url"] = public_base_url.rstrip("/")
        row["last_seen"] = ""
        row["status"] = "offline"
        row["remote_ip"] = ""
        tunnel = row.get("tunnel") if isinstance(row.get("tunnel"), dict) else {}
        if tunnel:
            original_address = _text(tunnel.get("client_address"))
            host = None
            raw_ip = original_address.split("/", 1)[0]
            if raw_ip.startswith(WG_PREFIX + "."):
                try:
                    host = int(raw_ip.rsplit(".", 1)[1])
                except Exception:
                    host = None
            if host is None or host in used_hosts:
                new_address = _next_wg_address(used_hosts)
                tunnel["client_address"] = new_address
                remapped.append({"id": cid, "name": row.get("name"), "from": original_address, "to": new_address})
            else:
                used_hosts.add(host)
            row["tunnel"] = tunnel
        rows.append(row)
        existing_by_id[cid] = row
        imported.append(_safe_public(row))

    _save_connectors(rows)
    return {"ok": True, "imported": len(imported), "skipped": skipped, "remapped": remapped, "connectors": imported}


def main() -> None:
    parser = argparse.ArgumentParser(description="Exporta/importa conectores SightOps entre ambientes.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    exp = sub.add_parser("export")
    exp.add_argument("--out", required=True)
    exp.add_argument("--source-tenant", default="")
    exp.add_argument("--no-legacy", action="store_true")
    imp = sub.add_parser("import")
    imp.add_argument("--infile", required=True)
    imp.add_argument("--target-tenant", required=True)
    imp.add_argument("--replace", action="store_true")
    imp.add_argument("--public-base-url", default=PROD_BASE_URL)
    args = parser.parse_args()

    if args.cmd == "export":
        result = export_connectors(args.out, args.source_tenant, include_legacy=not args.no_legacy)
    else:
        result = import_connectors(args.infile, args.target_tenant, replace=args.replace, public_base_url=args.public_base_url)
    print(json.dumps(result, ensure_ascii=False, default=str, indent=2))


if __name__ == "__main__":
    main()
