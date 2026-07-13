from __future__ import annotations

import json
import logging
from contextlib import redirect_stderr
from typing import Any, Dict, Tuple
import io

from fastapi import HTTPException

from app.core.paths import SAIDA_DIR
from app.core.perf import perf_step
from app.models.requests import (
    OltAddOnuRequest,
    OltCollectMacsRequest,
    OltDeleteOnuRequest,
    OltDiscoverOnusRequest,
    OltFindOnuRequest,
    OltOnuSignalRequest,
)
from app.cli.tools.olt_8820i_collect_macs import collect_macs_8820i
from app.cli.tools.olt_4840e_collect_macs import collect_macs_4840e
from app.cli.tools.olt_8820i_add_onu import (
    OnuAddError,
    add_onu as _add_onu_8820i,
    delete_onu as _delete_onu_8820i,
    discover_unauthorized_onus,
    find_onu_by_serial,
    onu_signal as _onu_signal_8820i,
    profile_for_model,
)
from app.services.db_store import load_olt_cpe_state, save_olt_cpe_state

logger = logging.getLogger("cam-snapshot")


def _dedup_cpes_by_key(cpes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove duplicados por (mac, pon, onu_id) quando possível."""
    out: list[dict[str, Any]] = []
    seen: set[Tuple[str, str, str]] = set()
    for r in cpes:
        mac = (str(r.get("cpe_mac") or r.get("mac") or r.get("MAC") or "")).strip().lower()
        pon = (str(r.get("pon") or r.get("PON") or "")).strip()
        onu = (str(r.get("onu_id") or r.get("onu") or r.get("ONU") or "")).strip()
        site = (str(r.get("site") or r.get("SITE") or "")).strip().lower()
        olt_ip = (str(r.get("olt_ip") or r.get("OLT_IP") or "")).strip().lower()
        key = (mac, f"{site}|{olt_ip}|{pon}", onu)
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def collect_macs(req: OltCollectMacsRequest) -> Dict[str, Any]:
    """Coleta MACs/CPEs na OLT Intelbras (8820i/4840e) e escreve olt-cpe-macs.json (compat legado)."""
    with perf_step("OLT_collect_macs_total"):
        stderr_buf = io.StringIO()

        try:
            with redirect_stderr(stderr_buf):
                with perf_step("OLT_collect_macs_driver"):
                    model = ((req.olt_model or "8820i").strip().lower())
                    if model in ("4840e", "intelbras_4840e", "intelbras_4840e_epon", "4840e_epon", "4840"):
                        rows = collect_macs_4840e(
                            olt_ip=req.olt_ip,
                            user=req.user,
                            password=req.password,
                            pon=req.pon,
                            olt_name=req.olt_name or "OLT-4840E",
                            port=22,
                        )
                    else:
                        rows = collect_macs_8820i(
                            olt_ip=req.olt_ip,
                            user=req.user,
                            password=req.password,
                            pon=req.pon,
                            olt_name=req.olt_name or "OLT-8820I",
                            timeout=12.0,
                        )
        except Exception as e:
            cli_log = stderr_buf.getvalue()
            logger.error(f"Erro ao consultar OLT: {e}")
            if cli_log:
                logger.error(cli_log)
            raise HTTPException(500, f"Erro ao consultar OLT: {e}") from e

        cli_log = stderr_buf.getvalue()
        json_path = None

        try:
            with perf_step("OLT_write_json_olt-cpe-macs.json"):
                SAIDA_DIR.mkdir(parents=True, exist_ok=True)
                json_path = SAIDA_DIR / "olt-cpe-macs.json"

                existing_cpes: list[dict[str, Any]] = []
                existing_meta: dict[str, Any] = {}

                try:
                    obj = load_olt_cpe_state() or {}
                    if not obj and json_path.exists():
                        obj = json.loads(json_path.read_text(encoding="utf-8"))
                    if isinstance(obj, dict):
                        existing_cpes = list(obj.get("cpes") or obj.get("rows") or [])
                        existing_meta = {k: v for k, v in obj.items() if k not in ("cpes", "rows")}
                except Exception:
                    existing_cpes = []
                    existing_meta = {}

                # Normaliza: o legado retorna list[dict]
                site = str(getattr(req, "site", "") or "").strip()
                new_cpes: list[dict[str, Any]] = []
                for r in list(rows or []):
                    if not isinstance(r, dict):
                        continue
                    rr = dict(r)
                    rr["site"] = site
                    rr["olt_ip"] = req.olt_ip
                    rr["olt_model"] = req.olt_model or "8820i"
                    new_cpes.append(rr)

                if getattr(req, "reuse_json", False):
                    all_cpes = new_cpes + existing_cpes
                else:
                    # Atualiza apenas o escopo atual (site + olt_ip), mantendo outras OLTs/sites.
                    def _same_scope(x: dict[str, Any]) -> bool:
                        return (
                            str(x.get("olt_ip") or "").strip() == str(req.olt_ip or "").strip()
                            and str(x.get("site") or "").strip().lower() == site.lower()
                        )

                    kept = [x for x in existing_cpes if isinstance(x, dict) and not _same_scope(x)]
                    all_cpes = kept + new_cpes
                all_cpes = _dedup_cpes_by_key(all_cpes)

                out_obj = {
                    **(existing_meta or {}),
                    "olt": {
                        "ip": req.olt_ip,
                        "name": req.olt_name,
                        "model": req.olt_model or "8820i",
                        "pon": req.pon,
                        "site": site,
                    },
                    "cpes": all_cpes,
                }

                save_olt_cpe_state(out_obj)
                if json_path is not None and not json_path.exists():
                    json_path = None
        except Exception as e:
            logger.error(f"Erro ao salvar JSON da OLT: {e}")
            raise HTTPException(500, f"Erro ao salvar JSON da OLT: {e}") from e

        return {
            "ok": True,
            "rows": new_cpes,
            "rows_all": all_cpes,
            "count": len(list(rows or [])),
            "count_all": len(list(all_cpes or [])),
            "json_path": str(json_path) if json_path else None,
            "cli_log": cli_log,
        }


def clear_macs(site: str = "") -> Dict[str, Any]:
    """Apaga dados OLT persistidos (DB-first) e fallback JSON legado."""
    site_norm = str(site or "").strip().lower()
    before = 0
    removed_rows = 0
    kept_rows: list[dict[str, Any]] = []
    existing_obj: dict[str, Any] = {}
    try:
        obj = load_olt_cpe_state() or {}
        if isinstance(obj, dict):
            existing_obj = obj
            rows = list(obj.get("cpes") or obj.get("rows") or [])
            before = len(rows)
            if site_norm:
                def _matches(r: dict[str, Any]) -> bool:
                    vals = [
                        str(r.get("site") or "").strip(),
                        str(r.get("SITE") or "").strip(),
                        str(r.get("local") or "").strip(),
                    ]
                    return any(v.lower() == site_norm for v in vals if v)
                kept_rows = [r for r in rows if not (isinstance(r, dict) and _matches(r))]
                removed_rows = max(0, len(rows) - len(kept_rows))
    except Exception:
        before = 0

    # DB-first
    if site_norm:
        out_obj = {
            **{k: v for k, v in existing_obj.items() if k not in ("cpes", "rows")},
            "olt": existing_obj.get("olt") if isinstance(existing_obj.get("olt"), dict) else {},
            "cpes": kept_rows,
        }
        save_olt_cpe_state(out_obj)
        return {
            "ok": True,
            "cleared": True,
            "scope": "site",
            "site": site.strip(),
            "removed_rows": int(removed_rows),
            "remaining": len(kept_rows),
            "removed_file": False,
        }

    save_olt_cpe_state({"olt": {}, "cpes": []})

    removed_file = False
    try:
        p = SAIDA_DIR / "olt-cpe-macs.json"
        if p.exists():
            p.unlink(missing_ok=True)
            removed_file = True
    except Exception:
        removed_file = False

    return {"ok": True, "cleared": True, "scope": "all", "removed_rows": int(before), "removed_file": removed_file}


def list_macs(site: str = "") -> Dict[str, Any]:
    """Lista dados OLT persistidos (DB-first), com filtro opcional por site."""
    site_norm = str(site or "").strip().lower()
    rows: list[dict[str, Any]] = []

    try:
        obj = load_olt_cpe_state() or {}
        if isinstance(obj, dict):
            base = list(obj.get("cpes") or obj.get("rows") or [])
            rows = [r for r in base if isinstance(r, dict)]
    except Exception:
        rows = []

    if site_norm:
        def _matches(r: dict[str, Any]) -> bool:
            vals = [
                str(r.get("site") or "").strip(),
                str(r.get("SITE") or "").strip(),
                str(r.get("local") or "").strip(),
            ]
            return any(v.lower() == site_norm for v in vals if v)

        rows = [r for r in rows if _matches(r)]

    rows = _dedup_cpes_by_key(rows)
    return {
        "ok": True,
        "rows": rows,
        "count": len(rows),
        "site": site.strip(),
    }


def discover_onus(req: OltDiscoverOnusRequest) -> Dict[str, Any]:
    """Descobre ONUs nao autorizadas + posicoes livres na OLT Intelbras 8820i.

    So a 8820i tem esse fluxo mapeado por enquanto (a 4840e nao tem comando
    de autorizacao confirmado ainda).
    """
    with perf_step("OLT_discover_onus"):
        try:
            return discover_unauthorized_onus(
                olt_ip=req.olt_ip,
                user=req.user,
                password=req.password,
                pon=req.pon,
                timeout=req.timeout,
            )
        except Exception as e:
            logger.error(f"Erro ao descobrir ONUs na OLT: {e}")
            raise HTTPException(500, f"Erro ao descobrir ONUs na OLT: {e}") from e


def add_onu(req: OltAddOnuRequest) -> Dict[str, Any]:
    """Autoriza uma ONU descoberta (serno_id) na OLT Intelbras 8820i, com
    servico/VLAN opcional. Equipamento vivo -- ver aviso na UI de Implantacao."""
    profile = (req.profile or "").strip() or profile_for_model(req.onu_model, req.terminal)
    with perf_step("OLT_add_onu"):
        try:
            return _add_onu_8820i(
                olt_ip=req.olt_ip,
                user=req.user,
                password=req.password,
                pon=req.pon,
                serno_id=req.serno_id,
                profile=profile,
                description=req.description,
                service=req.service,
                vlan=req.vlan,
                tag_mode=req.tag_mode,
                terminal=req.terminal,
                timeout=req.timeout,
            )
        except OnuAddError as e:
            return {
                "ok": False,
                "error": str(e),
                "failed_at": e.failed_command,
                "commands_run": e.commands_run,
            }
        except Exception as e:
            logger.error(f"Erro ao autorizar ONU na OLT: {e}")
            raise HTTPException(500, f"Erro ao autorizar ONU na OLT: {e}") from e


def find_onu(req: OltFindOnuRequest) -> Dict[str, Any]:
    """Localiza uma ONU ja autorizada pelo serial, na OLT Intelbras 8820i."""
    with perf_step("OLT_find_onu"):
        try:
            found = find_onu_by_serial(
                olt_ip=req.olt_ip,
                user=req.user,
                password=req.password,
                serial=req.serial,
                timeout=req.timeout,
            )
        except Exception as e:
            logger.error(f"Erro ao localizar ONU na OLT: {e}")
            raise HTTPException(500, f"Erro ao localizar ONU na OLT: {e}") from e
    if not found:
        return {"ok": False, "error": "ONU nao encontrada para esse serial."}
    return {"ok": True, **found}


def delete_onu(req: OltDeleteOnuRequest) -> Dict[str, Any]:
    """Exclui uma ONU ja autorizada (posicao pon/onu) na OLT Intelbras 8820i.

    Equipamento vivo -- remove o cadastro e desliga o servico da ONU."""
    with perf_step("OLT_delete_onu"):
        try:
            return _delete_onu_8820i(
                olt_ip=req.olt_ip,
                user=req.user,
                password=req.password,
                pon=req.pon,
                onu=req.onu,
                timeout=req.timeout,
            )
        except Exception as e:
            logger.error(f"Erro ao excluir ONU na OLT: {e}")
            raise HTTPException(500, f"Erro ao excluir ONU na OLT: {e}") from e


def onu_signal(req: OltOnuSignalRequest) -> Dict[str, Any]:
    """Consulta sinal (RX/distancia/status) e MACs aprendidos atras de uma
    ONU ja autorizada na OLT Intelbras 8820i. Aceita serial OU pon+onu."""
    with perf_step("OLT_onu_signal"):
        try:
            return _onu_signal_8820i(
                olt_ip=req.olt_ip,
                user=req.user,
                password=req.password,
                pon=req.pon or None,
                onu=req.onu or None,
                serial=req.serial,
                timeout=req.timeout,
            )
        except Exception as e:
            logger.error(f"Erro ao consultar sinal da ONU: {e}")
            raise HTTPException(500, f"Erro ao consultar sinal da ONU: {e}") from e
