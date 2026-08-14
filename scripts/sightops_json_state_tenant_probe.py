from __future__ import annotations

from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug, tenant_scoped_key
from app.services.db_store import _conn, get_json_state, set_json_state


KEY = "__codex_json_state_probe__"


def _as_tenant(slug: str, value: str) -> None:
    token = set_current_tenant_slug(slug)
    try:
        set_json_state(tenant_scoped_key(KEY), {"tenant": value})
        got = get_json_state(tenant_scoped_key(KEY), {})
        if got != {"tenant": value}:
            raise RuntimeError(f"json_state tenant {slug} retornou {got!r}")
    finally:
        reset_current_tenant_slug(token)


def main() -> int:
    _as_tenant("codex-a", "a")
    _as_tenant("codex-b", "b")
    with _conn() as conn:
        rows = conn.execute(
            "SELECT tenant_slug, k FROM json_state WHERE k=? ORDER BY tenant_slug",
            (KEY,),
        ).fetchall()
        count = len(rows)
        conn.execute("DELETE FROM json_state WHERE k=?", (KEY,))
    if count != 2:
        raise RuntimeError(f"esperado 2 linhas isoladas, veio {count}")
    print("OK json_state tenant probe: mesma chave isolada em dois tenants")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
