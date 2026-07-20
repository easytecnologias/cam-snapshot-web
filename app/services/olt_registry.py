"""Cadastro de OLTs por tenant.

Antes disto, toda operacao de OLT (coletar, adicionar ONU, sinal, remover)
recebia host/usuario/senha no corpo da requisicao, e a lista de OLTs da tela de
ONU era derivada das ONUs ja coletadas -- uma OLT nova nao aparecia ate alguem
coletar dela. Aqui a OLT vira cadastro de verdade, e as operacoes passam a
receber so o `olt_id`.

Duas regras que valem pra tudo neste modulo:

1. **A senha nunca sai daqui pra cima.** `list_olts` e `get_olt` devolvem
   `has_password` (booleano), nunca o valor. So `resolve_credentials` decifra,
   e ela existe pra ser chamada pelo olt_service no momento de falar com o
   equipamento -- nao por rota que responde ao navegador.

2. **Todo acesso e filtrado por tenant.** Nao ha funcao que busque OLT por id
   sem `tenant_slug` no WHERE: e o que impede um cliente de ler ou usar a OLT
   de outro sabendo o numero do id.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from app.core.crypto import decrypt, encrypt
from app.services.db_store import _conn, _current_tenant_slug

logger = logging.getLogger("app.olt_registry")

# Colunas seguras: tudo que a tela pode ver. password_enc fica fora de proposito.
_PUBLIC_COLUMNS = "id, tenant_slug, site_id, name, host, vendor, model, username, connector_id, notes, active"


class OltNotFound(LookupError):
    pass


def _text(value: Any) -> str:
    return str(value or "").strip()


def _public(row: Any) -> Dict[str, Any]:
    item = dict(row or {})
    enc = item.pop("password_enc", "")
    item["has_password"] = bool(_text(enc))
    item["active"] = bool(item.get("active", 1))
    return item


def list_olts(include_inactive: bool = True) -> List[Dict[str, Any]]:
    tenant = _current_tenant_slug()
    where = "WHERE tenant_slug = ?" if include_inactive else "WHERE tenant_slug = ? AND active = 1"
    with _conn() as c:
        rows = c.execute(
            f"SELECT {_PUBLIC_COLUMNS}, password_enc FROM olts {where} ORDER BY name",
            (tenant,),
        ).fetchall()
    return [_public(r) for r in rows or []]


def get_olt(olt_id: int) -> Optional[Dict[str, Any]]:
    tenant = _current_tenant_slug()
    with _conn() as c:
        row = c.execute(
            f"SELECT {_PUBLIC_COLUMNS}, password_enc FROM olts WHERE id = ? AND tenant_slug = ?",
            (int(olt_id), tenant),
        ).fetchone()
    return _public(row) if row else None


def save_olt(payload: Dict[str, Any]) -> Dict[str, Any]:
    """Cria ou atualiza. `id` no payload significa atualizar.

    Senha vazia num update **mantem a que estava**. Sem isso, editar o nome da
    OLT apagaria a senha silenciosamente -- a tela nunca reenvia a senha porque
    ela nunca chega la pra ser reenviada.
    """
    tenant = _current_tenant_slug()
    name = _text(payload.get("name"))
    host = _text(payload.get("host"))
    if not name:
        raise ValueError("nome da OLT e obrigatorio")
    if not host:
        raise ValueError("IP/host da OLT e obrigatorio")

    olt_id = payload.get("id")
    senha = str(payload.get("password") or "")

    campos = {
        "site_id": payload.get("site_id") or None,
        "name": name,
        "host": host,
        "vendor": _text(payload.get("vendor")),
        "model": _text(payload.get("model")),
        "username": _text(payload.get("username")),
        "connector_id": _text(payload.get("connector_id")),
        "notes": _text(payload.get("notes")),
        "active": 1 if bool(payload.get("active", True)) else 0,
    }

    with _conn() as c:
        if olt_id:
            atual = c.execute(
                "SELECT password_enc FROM olts WHERE id = ? AND tenant_slug = ?",
                (int(olt_id), tenant),
            ).fetchone()
            if not atual:
                raise OltNotFound(f"OLT {olt_id} nao encontrada neste tenant")
            campos["password_enc"] = encrypt(senha) if senha else _text(dict(atual).get("password_enc"))

            sets = ", ".join(f"{k} = ?" for k in campos)
            c.execute(
                f"UPDATE olts SET {sets}, updated_at = (datetime('now')) WHERE id = ? AND tenant_slug = ?",
                (*campos.values(), int(olt_id), tenant),
            )
            novo_id = int(olt_id)
        else:
            campos["password_enc"] = encrypt(senha)
            cols = ", ".join(["tenant_slug", *campos.keys()])
            marks = ", ".join(["?"] * (len(campos) + 1))
            c.execute(f"INSERT INTO olts({cols}) VALUES({marks})", (tenant, *campos.values()))
            row = c.execute(
                "SELECT id FROM olts WHERE tenant_slug = ? AND host = ?", (tenant, host)
            ).fetchone()
            novo_id = int(dict(row or {}).get("id") or 0)

        salvo = c.execute(
            f"SELECT {_PUBLIC_COLUMNS}, password_enc FROM olts WHERE id = ? AND tenant_slug = ?",
            (novo_id, tenant),
        ).fetchone()

    return _public(salvo)


def delete_olt(olt_id: int) -> bool:
    tenant = _current_tenant_slug()
    with _conn() as c:
        row = c.execute(
            "SELECT id FROM olts WHERE id = ? AND tenant_slug = ?", (int(olt_id), tenant)
        ).fetchone()
        if not row:
            return False
        c.execute("DELETE FROM olts WHERE id = ? AND tenant_slug = ?", (int(olt_id), tenant))
    return True


def resolve_credentials(olt_id: int) -> Dict[str, Any]:
    """Devolve os dados de acesso, com a senha decifrada.

    Unico ponto do sistema que abre a senha. Chamada pelo olt_service na hora
    de falar com o equipamento -- nunca por rota que responde ao navegador.
    """
    tenant = _current_tenant_slug()
    with _conn() as c:
        row = c.execute(
            "SELECT id, name, host, vendor, model, username, password_enc, connector_id, site_id, active "
            "FROM olts WHERE id = ? AND tenant_slug = ?",
            (int(olt_id), tenant),
        ).fetchone()
    if not row:
        raise OltNotFound(f"OLT {olt_id} nao encontrada neste tenant")

    item = dict(row)
    return {
        "id": int(item.get("id") or 0),
        "name": _text(item.get("name")),
        "host": _text(item.get("host")),
        "vendor": _text(item.get("vendor")),
        "model": _text(item.get("model")),
        "username": _text(item.get("username")),
        "password": decrypt(_text(item.get("password_enc"))),
        "connector_id": _text(item.get("connector_id")),
        "site_id": item.get("site_id"),
        "active": bool(item.get("active", 1)),
    }
