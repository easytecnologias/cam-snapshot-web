from __future__ import annotations

import html
import logging
import re
from typing import Any, Dict

import requests

from app.services import db_store

logger = logging.getLogger("cam-snapshot")


def _text(value: Any, limit: int = 500) -> str:
    return str(value or "").strip()[:limit]


def _digits(value: Any) -> str:
    return re.sub(r"\D", "", str(value or ""))


def _event_label(event_type: Any) -> str:
    clean = _text(event_type, 32).lower()
    if clean == "saida_manual":
        return "SAIDA MANUAL"
    if clean == "saida":
        return "SAIDA"
    return "ENTRADA"


def _event_context(event: Dict[str, Any]) -> Dict[str, Any]:
    tenant = db_store._current_tenant_slug()
    event_id = _text(event.get("id"), 80)
    person_id = _text(event.get("person_id"), 80)
    device_id = _text(event.get("device_id"), 80)
    context: Dict[str, Any] = dict(event)
    with db_store._conn() as c:
        if event_id:
            row = c.execute(
                """
                SELECT * FROM access_events
                WHERE tenant_slug=? AND id=?
                """,
                (tenant, event_id),
            ).fetchone()
            if row:
                context.update(dict(row))
        if person_id:
            person = c.execute(
                """
                SELECT full_name, person_type, class_name, site, guardian_name,
                       guardian_phone, whatsapp_enabled
                FROM access_people
                WHERE tenant_slug=? AND id=?
                """,
                (tenant, person_id),
            ).fetchone()
            if person:
                data = dict(person)
                context["person_name"] = data.get("full_name") or context.get("person_name_raw", "")
                context["person_type"] = data.get("person_type", "")
                context["class_name"] = data.get("class_name", "")
                context["guardian_name"] = data.get("guardian_name", "")
                context["guardian_phone"] = data.get("guardian_phone", "")
                context["whatsapp_enabled"] = bool(int(data.get("whatsapp_enabled") or 0))
                if not _text(context.get("site"), 120):
                    context["site"] = data.get("site", "")
        if device_id:
            device = c.execute(
                """
                SELECT name, site, access_direction
                FROM access_devices
                WHERE tenant_slug=? AND id=?
                """,
                (tenant, device_id),
            ).fetchone()
            if device:
                data = dict(device)
                context["device_name"] = context.get("device_name") or data.get("name", "")
                context["device_role"] = context.get("device_role") or data.get("access_direction", "")
                if not _text(context.get("site"), 120):
                    context["site"] = data.get("site", "")
    return context


def _build_message(event: Dict[str, Any]) -> str:
    label = _event_label(event.get("event_type"))
    person = _text(event.get("person_name") or event.get("person_name_raw"), 160) or "Pessoa nao identificada"
    site = _text(event.get("site"), 120) or "--"
    device = _text(event.get("device_name"), 160) or "--"
    occurred_at = _text(event.get("occurred_at"), 40) or "--"
    class_name = _text(event.get("class_name"), 80)
    lines = [
        f"{label} - Controle de Acesso",
        f"Pessoa: {person}",
    ]
    if class_name:
        lines.append(f"Turma: {class_name}")
    lines.extend(
        [
            f"Site: {site}",
            f"Dispositivo: {device}",
            f"Horario: {occurred_at}",
        ]
    )
    return "\n".join(lines)


def _whatsapp_target(phone: Any) -> str:
    raw = _text(phone, 32)
    if raw.startswith("+"):
        return "+" + _digits(raw)
    digits = _digits(raw)
    if not digits:
        return ""
    if digits.startswith("55"):
        return f"+{digits}"
    if len(digits) in {10, 11}:
        return f"+55{digits}"
    return f"+{digits}"


def _evolution_number(phone: Any) -> str:
    return _digits(_whatsapp_target(phone))


def _site_key(site: Any) -> str:
    return _text(site, 120)


def _access_whatsapp_site_configs(settings: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    raw = settings.get("access_control_whatsapp_notifications_by_site") or {}
    if not isinstance(raw, dict):
        return {}
    return {str(key): value for key, value in raw.items() if isinstance(value, dict)}


def _access_whatsapp_cfg(settings: Dict[str, Any], site: Any = "") -> Dict[str, Any]:
    global_cfg = settings.get("access_control_whatsapp_notifications") or {}
    if not isinstance(global_cfg, dict):
        global_cfg = {}
    key = _site_key(site)
    site_cfg = _access_whatsapp_site_configs(settings).get(key) if key else None
    if not site_cfg:
        return dict(global_cfg)
    merged = dict(global_cfg)
    merged.update(site_cfg)
    return merged


def _send_telegram(settings: Dict[str, Any], message: str) -> str:
    cfg = settings.get("telegram_notifications") or {}
    if not cfg.get("enabled"):
        return "telegram_skipped"
    token = _text(cfg.get("bot_token"), 200)
    chat_id = _text(cfg.get("chat_id"), 120)
    if not token or not chat_id:
        return "telegram_skipped"
    response = requests.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={
            "chat_id": chat_id,
            "text": html.escape(message),
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        },
        timeout=20,
    )
    data = response.json() if response.content else {}
    if response.ok and data.get("ok"):
        return "telegram_sent"
    return "telegram_failed"


def _send_whatsapp_evolution(cfg: Dict[str, Any], event: Dict[str, Any], message: str) -> str:
    base_url = _text(cfg.get("base_url"), 500).rstrip("/")
    api_key = _text(cfg.get("api_key"), 300)
    instance = _text(cfg.get("instance") or cfg.get("instance_name"), 120)
    number = _evolution_number(event.get("guardian_phone"))
    if not base_url or not api_key or not instance or not number:
        return "whatsapp_skipped"
    response = requests.post(
        f"{base_url}/message/sendText/{instance}",
        headers={"apikey": api_key, "Content-Type": "application/json"},
        json={
            "number": number,
            "text": message,
            "linkPreview": False,
        },
        timeout=20,
    )
    if 200 <= int(response.status_code or 0) < 300:
        return "whatsapp_sent"
    return "whatsapp_failed"


def send_access_whatsapp_text(number: Any, message: str, *, site: Any = "") -> Dict[str, Any]:
    """Envia uma resposta direta pelo mesmo canal usado nas notificacoes."""
    target = _evolution_number(number)
    text = _text(message, 4000)
    cfg = _access_whatsapp_cfg(db_store.load_app_settings(), site)
    if not target:
        return {"ok": False, "status": "whatsapp_skipped", "error": "Numero invalido."}
    if not text:
        return {"ok": False, "status": "whatsapp_skipped", "error": "Mensagem vazia."}
    if not cfg.get("enabled"):
        return {"ok": False, "status": "whatsapp_skipped", "error": "WhatsApp desativado."}
    if _text(cfg.get("provider"), 40).lower() != "evolution":
        return {"ok": False, "status": "whatsapp_skipped", "error": "Provedor nao suportado para resposta."}
    try:
        status = _send_whatsapp_evolution(cfg, {"guardian_phone": target, "whatsapp_enabled": True}, text)
    except Exception as exc:
        logger.warning("Falha ao enviar resposta WhatsApp de acesso: %s", exc)
        return {"ok": False, "status": "whatsapp_failed", "error": str(exc)}
    return {"ok": status == "whatsapp_sent", "status": status}


def _evolution_cfg(site: Any = "") -> Dict[str, str]:
    cfg = _access_whatsapp_cfg(db_store.load_app_settings(), site)
    if _text(cfg.get("provider"), 40).lower() != "evolution":
        return {}
    return {
        "base_url": _text(cfg.get("base_url"), 500).rstrip("/"),
        "api_key": _text(cfg.get("api_key"), 300),
        "instance": _text(cfg.get("instance") or cfg.get("instance_name"), 120),
    }


def _evolution_headers(cfg: Dict[str, str]) -> Dict[str, str]:
    return {"apikey": cfg["api_key"], "Content-Type": "application/json"}


def _evolution_state_label(data: Dict[str, Any]) -> str:
    raw = (
        data.get("state")
        or data.get("status")
        or (data.get("instance") or {}).get("state")
        or (data.get("instance") or {}).get("status")
        or ""
    )
    state = _text(raw, 40).lower()
    if state in {"open", "connected", "online"}:
        return "connected"
    if state in {"connecting", "qrcode", "qr", "pairing"}:
        return "waiting_qr"
    if state in {"close", "closed", "disconnected", "offline"}:
        return "disconnected"
    return state or "unknown"


def _evolution_qrcode_base64(data: Dict[str, Any]) -> str:
    raw = data.get("base64") or (data.get("qrcode") or {}).get("base64") or ""
    return _text(raw, 200000)


def get_access_whatsapp_connection(*, refresh_qr: bool = False, site: Any = "") -> Dict[str, Any]:
    cfg = _evolution_cfg(site)
    if not cfg.get("base_url") or not cfg.get("api_key") or not cfg.get("instance"):
        return {
            "ok": False,
            "configured": False,
            "state": "not_configured",
            "connected": False,
            "qrcode": "",
            "error": "WhatsApp nao configurado.",
        }

    base_url = cfg["base_url"]
    instance = cfg["instance"]
    headers = _evolution_headers(cfg)
    result: Dict[str, Any] = {"ok": True, "configured": True, "state": "unknown", "connected": False, "qrcode": ""}

    try:
        state_response = requests.get(
            f"{base_url}/instance/connectionState/{instance}",
            headers=headers,
            timeout=15,
        )
        if state_response.status_code == 404:
            create_response = requests.post(
                f"{base_url}/instance/create",
                headers=headers,
                json={"instanceName": instance, "integration": "WHATSAPP-BAILEYS", "qrcode": True},
                timeout=25,
            )
            create_data = create_response.json() if create_response.content else {}
            state = _evolution_state_label(create_data)
            result.update({"state": state, "connected": state == "connected", "qrcode": _evolution_qrcode_base64(create_data)})
            return result
        state_data = state_response.json() if state_response.content else {}
        state = _evolution_state_label(state_data)
        result.update({"state": state, "connected": state == "connected"})
    except Exception as exc:
        return {**result, "ok": False, "state": "error", "error": str(exc)}

    if refresh_qr or not result["connected"]:
        try:
            qr_response = requests.get(
                f"{base_url}/instance/connect/{instance}",
                headers=headers,
                timeout=25,
            )
            qr_data = qr_response.json() if qr_response.content else {}
            qrcode = _evolution_qrcode_base64(qr_data)
            if qrcode:
                result["qrcode"] = qrcode
                if result["state"] in {"unknown", "disconnected", "error"}:
                    result["state"] = "waiting_qr"
        except Exception as exc:
            result["qr_error"] = str(exc)
    return result


def disconnect_access_whatsapp(site: Any = "") -> Dict[str, Any]:
    cfg = _evolution_cfg(site)
    if not cfg.get("base_url") or not cfg.get("api_key") or not cfg.get("instance"):
        return {
            "ok": False,
            "configured": False,
            "state": "not_configured",
            "connected": False,
            "qrcode": "",
            "error": "WhatsApp nao configurado.",
        }

    base_url = cfg["base_url"]
    instance = cfg["instance"]
    headers = _evolution_headers(cfg)
    try:
        response = requests.delete(
            f"{base_url}/instance/logout/{instance}",
            headers=headers,
            timeout=25,
        )
        if response.status_code == 404:
            return {"ok": True, "configured": True, "state": "disconnected", "connected": False, "qrcode": ""}
        if not (200 <= int(response.status_code or 0) < 300):
            detail = response.text[:300] if getattr(response, "text", "") else "Falha ao desconectar WhatsApp."
            return {"ok": False, "configured": True, "state": "error", "connected": False, "qrcode": "", "error": detail}
    except Exception as exc:
        return {"ok": False, "configured": True, "state": "error", "connected": False, "qrcode": "", "error": str(exc)}
    return {"ok": True, "configured": True, "state": "disconnected", "connected": False, "qrcode": ""}


def _send_whatsapp(settings: Dict[str, Any], event: Dict[str, Any], message: str) -> str:
    cfg = _access_whatsapp_cfg(settings, event.get("site"))
    if not cfg.get("enabled"):
        return "whatsapp_skipped"
    if _text(cfg.get("provider"), 40).lower() == "evolution":
        return _send_whatsapp_evolution(cfg, event, message)
    webhook_url = _text(cfg.get("webhook_url"), 500)
    target = _whatsapp_target(event.get("guardian_phone"))
    if not webhook_url or not target or event.get("whatsapp_enabled") is False:
        return "whatsapp_skipped"
    response = requests.post(
        webhook_url,
        json={
            "to": target,
            "message": message,
            "event": {
                "id": _text(event.get("id"), 80),
                "type": _text(event.get("event_type"), 32),
                "person_id": _text(event.get("person_id"), 80),
                "site": _text(event.get("site"), 120),
                "occurred_at": _text(event.get("occurred_at"), 40),
            },
        },
        timeout=20,
    )
    if 200 <= int(response.status_code or 0) < 300:
        return "whatsapp_sent"
    return "whatsapp_failed"


def get_access_whatsapp_config(site: Any = "") -> Dict[str, Any]:
    settings = db_store.load_app_settings()
    site_key = _site_key(site)
    site_configs = _access_whatsapp_site_configs(settings)
    cfg = _access_whatsapp_cfg(settings, site_key)
    provider = _text(cfg.get("provider") or "evolution", 40).lower() or "evolution"
    base_url = _text(cfg.get("base_url"), 500).rstrip("/")
    instance = _text(cfg.get("instance") or cfg.get("instance_name") or "sightops", 120)
    configured = bool(base_url and instance and _text(cfg.get("api_key"), 300))
    return {
        "site": site_key,
        "enabled": bool(cfg.get("enabled")),
        "configured": configured,
        "site_configured": bool(site_key and site_key in site_configs),
        "provider": provider,
        "base_url": base_url,
        "instance": instance,
    }


def save_access_whatsapp_config(payload: Dict[str, Any]) -> Dict[str, Any]:
    settings = db_store.load_app_settings()
    site_key = _site_key(payload.get("site"))
    site_configs = _access_whatsapp_site_configs(settings)
    old_global = settings.get("access_control_whatsapp_notifications") or {}
    if not isinstance(old_global, dict):
        old_global = {}
    old = site_configs.get(site_key, {}) if site_key else old_global
    provider = _text(payload.get("provider") or old.get("provider") or "evolution", 40).lower() or "evolution"
    api_key = _text(payload.get("api_key"), 300) or _text(old.get("api_key"), 300) or _text(old_global.get("api_key"), 300)
    saved_cfg = {
        "enabled": bool(payload.get("enabled")),
        "provider": provider,
        "base_url": _text(payload.get("base_url"), 500).rstrip("/"),
        "api_key": api_key,
        "instance": _text(payload.get("instance") or payload.get("instance_name") or old.get("instance") or "sightops", 120),
    }
    if site_key:
        site_configs[site_key] = saved_cfg
        settings["access_control_whatsapp_notifications_by_site"] = site_configs
    else:
        settings["access_control_whatsapp_notifications"] = saved_cfg
    db_store.save_app_settings(settings)
    return get_access_whatsapp_config(site_key)


def test_access_whatsapp(payload: Dict[str, Any]) -> Dict[str, Any]:
    number = _text(payload.get("number") or payload.get("to"), 40)
    if not _evolution_number(number):
        return {"ok": False, "error": "Informe um numero de WhatsApp para teste."}
    cfg = _access_whatsapp_cfg(db_store.load_app_settings(), payload.get("site"))
    if not cfg.get("enabled"):
        return {"ok": False, "error": "WhatsApp desativado."}
    context = {"guardian_phone": number, "whatsapp_enabled": True}
    message = "Teste SightOps - notificacoes do Controle de Acesso configuradas."
    try:
        status = _send_whatsapp({"access_control_whatsapp_notifications": cfg}, context, message)
    except Exception as exc:
        logger.warning("Falha no teste de WhatsApp de acesso: %s", exc)
        return {"ok": False, "error": str(exc)}
    return {"ok": status == "whatsapp_sent", "status": status}


def notify_access_event(event: Dict[str, Any]) -> Dict[str, Any]:
    """Envia notificacoes de acesso sem deixar falha externa quebrar o evento."""
    context = _event_context(event)
    message = _build_message(context)
    settings = db_store.load_app_settings()
    statuses: list[str] = []
    for sender in (_send_telegram,):
        try:
            statuses.append(sender(settings, message))
        except Exception as exc:
            logger.warning("Falha ao enviar Telegram de acesso: %s", exc)
            statuses.append("telegram_failed")
    try:
        statuses.append(_send_whatsapp(settings, context, message))
    except Exception as exc:
        logger.warning("Falha ao enviar WhatsApp de acesso: %s", exc)
        statuses.append("whatsapp_failed")
    return {"ok": all(not status.endswith("_failed") for status in statuses), "statuses": statuses}
