"""Em site declarativo, apagar e apagar -- e chamar de volta e chamar de volta.

O usuario nao deve precisar administrar uma lista de bloqueados: sair da lista
de permitidos ja basta. Este teste percorre o ciclo inteiro.

Roda direto:
    python scripts/sightops_apagar_e_chamar_de_volta_test.py
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

SITE = "ESCOLA MEDEA"


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


class FakeProc:
    returncode = 0
    stdout = "ok"
    stderr = ""


def _fake_scan(rows):
    def fake_run(cmd, cwd=None, capture_output=True, text=True, check=False):
        if "--out" not in cmd:
            return FakeProc()
        out = Path(cmd[cmd.index("--out") + 1])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(rows), encoding="utf-8")
        return FakeProc()

    return fake_run


REDE = [
    {"ip": "100.65.10.57", "mac": "aa:aa:aa:aa:aa:01", "status": "online", "local": SITE},
    {"ip": "100.65.10.58", "mac": "aa:aa:aa:aa:aa:02", "status": "online", "local": SITE},
]


def varre(scan_service, ScanRequest):
    original = scan_service.subprocess.run
    scan_service.subprocess.run = _fake_scan(REDE)
    try:
        return scan_service.run_http_scan(
            ScanRequest(alvo="100.65.10.0/24", usuario="admin", senha="x", local=SITE,
                        inventory_mode="basic", capture_snapshot=False, excel=False)
        )
    finally:
        scan_service.subprocess.run = original


def ips_no_inventario(load_inventory_json):
    return sorted(str(r.get("ip") or "") for r in (load_inventory_json(mode="basic") or []))


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="sightops-apagar-"))
    try:
        os.environ["DATABASE_BACKEND"] = "sqlite"
        os.environ["DATA_DIR"] = str(tmp)

        from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
        from app.models.requests import InventoryDeleteRequest, ScanRequest
        from app.services.inventory_delete_service import inventory_delete
        from app.services.inventory_json import load_inventory_json
        from app.services.olt_ignore_list import list_ignored
        from app.services import camera_allowlist, scan_service

        token = set_current_tenant_slug("rads")
        try:
            camera_allowlist.set_site(SITE, ["100.65.10.57", "100.65.10.58"])
            varre(scan_service, ScanRequest)
            check(ips_no_inventario(load_inventory_json) == ["100.65.10.57", "100.65.10.58"],
                  "as duas autorizadas deviam entrar")
            print("  ok: as 2 cameras autorizadas entraram")

            # --- apagar uma
            res = inventory_delete(InventoryDeleteRequest(
                ips=["100.65.10.58"], mode="basic", site=SITE, permanent=True))
            check(res.get("ok"), f"delete falhou: {res}")
            check(res.get("allowlist_removed") == 1, f"devia sair da allowlist: {res}")
            check(not camera_allowlist.is_allowed(SITE, "100.65.10.58"),
                  "IP apagado nao pode continuar autorizado")
            check(not list_ignored(),
                  f"site declarativo nao devia precisar de lista de bloqueados: {list_ignored()}")
            print("  ok: apagar tirou da lista de permitidos e NAO criou bloqueio")

            # --- varrer de novo: a rede continua com as duas, o inventario nao
            varre(scan_service, ScanRequest)
            check(ips_no_inventario(load_inventory_json) == ["100.65.10.57"],
                  f"a apagada voltou: {ips_no_inventario(load_inventory_json)}")
            print("  ok: varredura seguinte NAO trouxe a camera apagada de volta")

            # --- chamar de volta
            camera_allowlist.add_entries(SITE, ["100.65.10.58"])
            varre(scan_service, ScanRequest)
            check(ips_no_inventario(load_inventory_json) == ["100.65.10.57", "100.65.10.58"],
                  f"devia voltar ao recolocar na lista: {ips_no_inventario(load_inventory_json)}")
            print("  ok: recolocou o IP na lista e a camera voltou")

            # --- site SEM allowlist continua dependendo do bloqueio
            outro = "SITE LEGADO"
            rows = load_inventory_json(mode="basic") or []
            rows.append({"ip": "10.10.9.99", "mac": "bb:bb:bb:bb:bb:01", "local": outro, "site": outro})
            from app.services.inventory_json import save_inventory_json
            save_inventory_json(rows, mode="basic")
            res2 = inventory_delete(InventoryDeleteRequest(
                ips=["10.10.9.99"], mode="basic", site=outro, permanent=True))
            check(res2.get("allowlist_removed") == 0, "site legado nao tem allowlist pra mexer")
            check(any(r["ip"] == "10.10.9.99" for r in list_ignored()),
                  "site sem allowlist ainda precisa do bloqueio")
            print("  ok: site sem allowlist continua usando a lista de bloqueados")
        finally:
            reset_current_tenant_slug(token)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("OK apagar e apagar; chamar de volta e chamar de volta")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
