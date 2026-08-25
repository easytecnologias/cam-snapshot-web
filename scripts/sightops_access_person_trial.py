from __future__ import annotations

import argparse
import base64
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException

from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
from app.services.access_control_device import (
    get_system_info,
    get_controller_person_photo,
    list_controller_people,
    provision_person,
    remove_person,
)
from app.services.access_control_photos import load_person_face_photo
from app.services.access_control_store import get_device_with_password, list_devices, list_people


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _matches(haystack: str, needle: str) -> bool:
    return needle.lower() in haystack.lower()


def _find_one(label: str, rows: list[dict[str, Any]], needle: str, fields: tuple[str, ...]) -> dict[str, Any]:
    matches = [
        row
        for row in rows
        if any(_matches(_clean(row.get(field)), needle) for field in fields)
    ]
    if not matches:
        raise SystemExit(f"{label} nao encontrado para busca: {needle}")
    if len(matches) > 1:
        print(json.dumps({"ambiguous": label, "count": len(matches), "matches": matches}, ensure_ascii=False, indent=2))
        raise SystemExit(f"Busca ambigua para {label}; refine o nome.")
    return matches[0]


def _photo_payload(label: str, data: bytes | None) -> dict[str, Any]:
    return {
        "present": bool(data),
        "bytes": len(data or b""),
        "base64": base64.b64encode(data or b"").decode("ascii") if data else "",
        "label": label,
    }


def _resolve(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any] | None, list[dict[str, str]]]:
    devices = list_devices()
    safe_devices = [{k: v for k, v in d.items() if k != "password"} for d in devices]
    device_row = _find_one("dispositivo", safe_devices, args.device, ("name", "host"))
    full_device = get_device_with_password(device_row["id"])
    if not full_device:
        raise SystemExit("Dispositivo encontrado na lista, mas nao abriu com senha interna.")

    people = list_people(search=args.person)
    person = _find_one("pessoa SightOps", people, args.person, ("full_name", "enrollment_code", "controller_user_id"))

    controller_match = None
    controller_people: list[dict[str, str]] = []
    try:
        controller_people = list_controller_people(full_device)
        controller_id = _clean(person.get("controller_user_id"))
        if controller_id:
            controller_match = next(
                (row for row in controller_people if _clean(row.get("controller_user_id")) == controller_id),
                None,
            )
        if not controller_match:
            name_matches = [
                row
                for row in controller_people
                if _matches(_clean(row.get("full_name")), _clean(person.get("full_name")) or args.person)
            ]
            controller_match = name_matches[0] if len(name_matches) == 1 else None
    except HTTPException as exc:
        print(json.dumps({"controller_lookup_error": exc.detail}, ensure_ascii=False, indent=2))
    return full_device, person, controller_match, controller_people


def _backup(args: argparse.Namespace) -> Path:
    device, person, controller_person, _controller_people = _resolve(args)
    controller_id = _clean(args.controller_id) or _clean((controller_person or {}).get("controller_user_id")) or _clean(person.get("controller_user_id"))
    if args.controller_id and not controller_person:
        controller_person = next(
            (row for row in _controller_people if _clean(row.get("controller_user_id")) == _clean(args.controller_id)),
            None,
        )
    if not controller_id:
        raise SystemExit("Pessoa sem controller_user_id; nao posso fazer backup seguro da controladora.")

    local_photo = load_person_face_photo(person)
    controller_photo = None
    try:
        controller_photo = get_controller_person_photo(device, controller_id)
    except HTTPException as exc:
        print(json.dumps({"controller_photo_error": exc.detail}, ensure_ascii=False, indent=2))

    payload = {
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tenant": args.tenant,
        "device": {k: v for k, v in device.items() if k != "password"},
        "person": person,
        "controller_person": controller_person,
        "controller_user_id": controller_id,
        "photos": {
            "sightops": _photo_payload("sightops", local_photo),
            "controller": _photo_payload("controller", controller_photo),
        },
    }
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out = out_dir / f"sauna-elishafan-backup-{stamp}.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "backup": str(out),
        "person_id": person.get("id"),
        "full_name": person.get("full_name"),
        "controller_user_id": controller_id,
        "sightops_photo_bytes": len(local_photo or b""),
        "controller_photo_bytes": len(controller_photo or b""),
    }, ensure_ascii=False, indent=2))
    return out


def _load_backup(path: str) -> dict[str, Any]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    for key in ("person", "device", "controller_user_id"):
        if not data.get(key):
            raise SystemExit(f"Backup invalido: faltou {key}.")
    return data


def _photo_from_backup(data: dict[str, Any]) -> bytes | None:
    photos = data.get("photos") if isinstance(data.get("photos"), dict) else {}
    for key in ("sightops", "controller"):
        raw = ((photos.get(key) or {}).get("base64") or "").strip()
        if raw:
            return base64.b64decode(raw)
    return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["inspect", "backup", "delete-controller", "restore-controller", "test-direct"])
    parser.add_argument("--tenant", default="easy-tecnologias")
    parser.add_argument("--device", default="SAUNA")
    parser.add_argument("--person", default="elishafan")
    parser.add_argument("--controller-id", default="")
    parser.add_argument("--out-dir", default="/tmp/sightops-access-backups")
    parser.add_argument("--backup", default="")
    parser.add_argument("--direct", action="store_true")
    parser.add_argument("--full-name", default="")
    args = parser.parse_args()

    token = set_current_tenant_slug(args.tenant)
    try:
        if args.action == "inspect":
            device, person, controller_person, controller_people = _resolve(args)
            person_controller_id = _clean(person.get("controller_user_id"))
            controller_candidates = [
                row
                for row in controller_people
                if (
                    person_controller_id
                    and _clean(row.get("controller_user_id")) == person_controller_id
                )
                or _matches(_clean(row.get("full_name")), args.person)
                or _matches(_clean(row.get("full_name")), "elish")
                or _matches(_clean(row.get("full_name")), "machado")
            ]
            print(json.dumps({
                "ok": True,
                "device": {k: v for k, v in device.items() if k != "password"},
                "person": person,
                "controller_person": controller_person,
                "controller_people_count": len(controller_people),
                "controller_candidates": controller_candidates[:20],
                "sightops_photo_bytes": len(load_person_face_photo(person) or b""),
            }, ensure_ascii=False, indent=2))
        elif args.action == "backup":
            _backup(args)
        elif args.action == "test-direct":
            device, _person, _controller_person, _controller_people = _resolve(args)
            direct_device = dict(device)
            direct_device["connector_id"] = ""
            result = get_system_info(direct_device)
            print(json.dumps({"ok": True, "direct": True, "info": result}, ensure_ascii=False, indent=2))
        elif args.action == "delete-controller":
            if not args.backup:
                raise SystemExit("Informe --backup antes de apagar.")
            data = _load_backup(args.backup)
            controller_user_id = _clean(data.get("controller_user_id"))
            if not _photo_from_backup(data):
                raise SystemExit("Backup sem foto; nao vou apagar da controladora.")
            device = get_device_with_password(data["device"]["id"])
            if not device:
                raise SystemExit("Dispositivo do backup nao encontrado.")
            if args.direct:
                device["connector_id"] = ""
            result = remove_person(device, controller_user_id)
            print(json.dumps({"ok": True, "removed_controller_user_id": controller_user_id, "result": result}, ensure_ascii=False, indent=2))
        elif args.action == "restore-controller":
            if not args.backup:
                raise SystemExit("Informe --backup para restaurar.")
            data = _load_backup(args.backup)
            device = get_device_with_password(data["device"]["id"])
            if not device:
                raise SystemExit("Dispositivo do backup nao encontrado.")
            if args.direct:
                device["connector_id"] = ""
            photo = _photo_from_backup(data)
            person = dict(data["person"])
            person["controller_user_id"] = _clean(data.get("controller_user_id")) or _clean(person.get("controller_user_id"))
            if args.full_name:
                person["full_name"] = args.full_name.replace("_", " ")
            result = provision_person(device, person, photo)
            print(json.dumps({"ok": True, "restored_controller_user_id": data.get("controller_user_id"), "result": result}, ensure_ascii=False, indent=2))
    finally:
        reset_current_tenant_slug(token)


if __name__ == "__main__":
    main()
