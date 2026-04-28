from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterator, List, Optional
from urllib.parse import urlsplit, urlunsplit

from app.core.paths import DATA_DIR

try:
    import psycopg
    from psycopg.rows import dict_row
except Exception:  # pragma: no cover - fallback defensivo
    psycopg = None
    dict_row = None


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_text(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def _auth_backend() -> str:
    raw = str(os.getenv("AUTH_DATABASE_BACKEND") or os.getenv("DATABASE_BACKEND") or "sqlite").strip().lower()
    return raw if raw in ("sqlite", "postgres") else "sqlite"


def _default_bootstrap_username() -> str:
    return str(os.getenv("AUTH_DEFAULT_ADMIN_USERNAME") or "admin_teste").strip() or "admin_teste"


def _default_bootstrap_usernames() -> List[str]:
    names = [_default_bootstrap_username(), "admin_teste", "admin_test"]
    out: List[str] = []
    for name in names:
        n = str(name or "").strip()
        if n and n.lower() not in [x.lower() for x in out]:
            out.append(n)
    return out


def _default_bootstrap_password() -> str:
    return str(os.getenv("AUTH_DEFAULT_ADMIN_PASSWORD") or "admin_teste").strip() or "admin_teste"


def _sqlite_auth_path() -> str:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return str(os.getenv("AUTH_DB_PATH") or (DATA_DIR / "auth.db"))


def _postgres_auth_url() -> str:
    direct = str(os.getenv("AUTH_DATABASE_URL") or "").strip()
    if direct:
        return direct
    shared = str(os.getenv("DATABASE_URL") or "").strip()
    if shared and shared.startswith("postgres"):
        return shared
    host = str(os.getenv("AUTH_DATABASE_HOST") or os.getenv("DATABASE_HOST") or "postgres").strip()
    port = int(os.getenv("AUTH_DATABASE_PORT") or os.getenv("DATABASE_PORT") or "5432")
    name = str(os.getenv("AUTH_DATABASE_NAME") or os.getenv("DATABASE_NAME") or "sightops").strip()
    user = str(os.getenv("AUTH_DATABASE_USER") or os.getenv("DATABASE_USER") or "sightops").strip()
    password = str(os.getenv("AUTH_DATABASE_PASSWORD") or os.getenv("DATABASE_PASSWORD") or "sightops").strip()
    return f"postgresql://{user}:{password}@{host}:{port}/{name}"


def _redact_url_secret(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parts = urlsplit(raw)
        if parts.password is None:
            return raw
        username = parts.username or ""
        host = parts.hostname or ""
        port = f":{parts.port}" if parts.port else ""
        userinfo = f"{username}:***" if username else ""
        netloc = f"{userinfo}@{host}{port}" if userinfo else f"{host}{port}"
        return urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
    except Exception:
        return "***"


@contextmanager
def _conn() -> Iterator[Any]:
    with _conn_for_backend(_auth_backend()) as c:
        yield c


@contextmanager
def _conn_for_backend(backend: str) -> Iterator[Any]:
    backend_norm = str(backend or "sqlite").strip().lower()
    if backend_norm == "postgres":
        if psycopg is None:
            raise RuntimeError("psycopg nao instalado para auth postgres")
        with psycopg.connect(_postgres_auth_url(), row_factory=dict_row) as c:
            yield c
        return

    c = sqlite3.connect(_sqlite_auth_path())
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON;")
    # Em alguns ambientes Windows/sandbox o journal padrao gera erro de I/O.
    c.execute("PRAGMA journal_mode=MEMORY;")
    c.execute("PRAGMA synchronous=NORMAL;")
    try:
        yield c
        c.commit()
    finally:
        c.close()


def _sql(query: str) -> str:
    return _sql_for_backend(_auth_backend(), query)


def _sql_for_backend(backend: str, query: str) -> str:
    if str(backend or "sqlite").strip().lower() != "postgres":
        return query
    return (
        str(query or "")
        .replace("?", "%s")
        .replace("datetime('now')", "CURRENT_TIMESTAMP")
    )


def _fetchone(c: Any, query: str, params: tuple[Any, ...] = ()) -> Optional[Dict[str, Any]]:
    row = c.execute(_sql(query), params).fetchone()
    if row is None:
        return None
    return dict(row)


def _fetchall(c: Any, query: str, params: tuple[Any, ...] = ()) -> List[Dict[str, Any]]:
    return [dict(r) for r in c.execute(_sql(query), params).fetchall()]


def _execute(c: Any, query: str, params: tuple[Any, ...] = ()) -> None:
    c.execute(_sql(query), params)


def _fetchone_on(c: Any, backend: str, query: str, params: tuple[Any, ...] = ()) -> Optional[Dict[str, Any]]:
    row = c.execute(_sql_for_backend(backend, query), params).fetchone()
    if row is None:
        return None
    return dict(row)


def _fetchall_on(c: Any, backend: str, query: str, params: tuple[Any, ...] = ()) -> List[Dict[str, Any]]:
    return [dict(r) for r in c.execute(_sql_for_backend(backend, query), params).fetchall()]


def _execute_on(c: Any, backend: str, query: str, params: tuple[Any, ...] = ()) -> None:
    c.execute(_sql_for_backend(backend, query), params)


_AUTH_SCHEMA_SQLITE = """
CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    username TEXT NOT NULL UNIQUE,
    full_name TEXT DEFAULT '',
    email TEXT DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auth_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    revoked_at TEXT DEFAULT NULL,
    last_seen_at TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    resource_type TEXT DEFAULT '',
    resource_id TEXT DEFAULT '',
    detail_json TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


_AUTH_SCHEMA_POSTGRES = """
CREATE TABLE IF NOT EXISTS tenants (
    id BIGSERIAL PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    username TEXT NOT NULL UNIQUE,
    full_name TEXT DEFAULT '',
    email TEXT DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_tokens (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    label TEXT DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    revoked_at TEXT DEFAULT NULL,
    last_seen_at TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT REFERENCES tenants(id) ON DELETE SET NULL,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    resource_type TEXT DEFAULT '',
    resource_id TEXT DEFAULT '',
    detail_json TEXT DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


def init_auth_db() -> Dict[str, Any]:
    with _conn() as c:
        _init_auth_db_on_connection(c, _auth_backend())
        tenant_count = int((_fetchone(c, "SELECT COUNT(1) AS n FROM tenants") or {}).get("n") or 0)
        user_count = int((_fetchone(c, "SELECT COUNT(1) AS n FROM users") or {}).get("n") or 0)
    return {
        "ok": True,
        "backend": _auth_backend(),
        "tenants": tenant_count,
        "users": user_count,
        "db_path": _sqlite_auth_path() if _auth_backend() == "sqlite" else "",
        "database_url": _redact_url_secret(_postgres_auth_url()) if _auth_backend() == "postgres" else "",
    }


def _init_auth_db_on_connection(c: Any, backend: str) -> None:
    if str(backend or "sqlite").strip().lower() == "postgres":
        for stmt in [x.strip() for x in _AUTH_SCHEMA_POSTGRES.split(";") if x.strip()]:
            c.execute(stmt)
        _ensure_default_bootstrap_user(c)
        return
    c.executescript(_AUTH_SCHEMA_SQLITE)
    _ensure_default_bootstrap_user(c)


def _backend_meta(backend: str) -> Dict[str, str]:
    backend_norm = str(backend or "sqlite").strip().lower()
    return {
        "backend": backend_norm,
        "db_path": _sqlite_auth_path() if backend_norm == "sqlite" else "",
        "database_url": _redact_url_secret(_postgres_auth_url()) if backend_norm == "postgres" else "",
    }


def _postgres_set_sequence(c: Any, table: str, value: int) -> None:
    c.execute(
        "SELECT setval(pg_get_serial_sequence(%s, 'id'), %s, true)",
        (table, max(1, int(value or 1))),
    )


def migrate_auth_storage(source_backend: str = "sqlite", target_backend: str = "postgres", force: bool = False) -> Dict[str, Any]:
    src_backend = str(source_backend or "sqlite").strip().lower()
    dst_backend = str(target_backend or "postgres").strip().lower()
    if src_backend not in ("sqlite", "postgres") or dst_backend not in ("sqlite", "postgres"):
        raise ValueError("backend invalido")
    if src_backend == dst_backend:
        raise ValueError("source e target nao podem ser iguais")

    with _conn_for_backend(src_backend) as src, _conn_for_backend(dst_backend) as dst:
        _init_auth_db_on_connection(src, src_backend)
        _init_auth_db_on_connection(dst, dst_backend)

        src_users = int((_fetchone_on(src, src_backend, "SELECT COUNT(1) AS n FROM users") or {}).get("n") or 0)
        dst_users = int((_fetchone_on(dst, dst_backend, "SELECT COUNT(1) AS n FROM users") or {}).get("n") or 0)
        if dst_users > 0 and not force:
            raise ValueError("target auth storage ja possui usuarios; use force=1 para sobrescrever")

        if force:
            for table in ("auth_tokens", "audit_log", "users", "tenants"):
                _execute_on(dst, dst_backend, f"DELETE FROM {table}")

        tenants = _fetchall_on(src, src_backend, "SELECT id, slug, name, active, created_at FROM tenants ORDER BY id")
        users = _fetchall_on(
            src,
            src_backend,
            """
            SELECT id, tenant_id, username, full_name, email, password_hash, role, active, created_at, updated_at
            FROM users
            ORDER BY id
            """,
        )
        tokens = _fetchall_on(
            src,
            src_backend,
            """
            SELECT id, user_id, token_hash, label, created_at, expires_at, revoked_at, last_seen_at
            FROM auth_tokens
            ORDER BY id
            """,
        )
        audit = _fetchall_on(
            src,
            src_backend,
            """
            SELECT id, tenant_id, user_id, action, resource_type, resource_id, detail_json, created_at
            FROM audit_log
            ORDER BY id
            """,
        )

        for row in tenants:
            _execute_on(dst, dst_backend, "INSERT INTO tenants(id, slug, name, active, created_at) VALUES(?, ?, ?, ?, ?)", (row["id"], row["slug"], row["name"], row["active"], row["created_at"]))
        for row in users:
            _execute_on(
                dst,
                dst_backend,
                "INSERT INTO users(id, tenant_id, username, full_name, email, password_hash, role, active, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (row["id"], row["tenant_id"], row["username"], row.get("full_name") or "", row.get("email") or "", row["password_hash"], row["role"], row["active"], row["created_at"], row["updated_at"]),
            )
        for row in tokens:
            _execute_on(
                dst,
                dst_backend,
                "INSERT INTO auth_tokens(id, user_id, token_hash, label, created_at, expires_at, revoked_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                (row["id"], row["user_id"], row["token_hash"], row.get("label") or "", row["created_at"], row["expires_at"], row.get("revoked_at"), row.get("last_seen_at")),
            )
        for row in audit:
            _execute_on(
                dst,
                dst_backend,
                "INSERT INTO audit_log(id, tenant_id, user_id, action, resource_type, resource_id, detail_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                (row["id"], row.get("tenant_id"), row.get("user_id"), row["action"], row.get("resource_type") or "", row.get("resource_id") or "", row.get("detail_json") or "", row["created_at"]),
            )

        if dst_backend == "postgres":
            _postgres_set_sequence(dst, "tenants", max([int(x["id"]) for x in tenants], default=1))
            _postgres_set_sequence(dst, "users", max([int(x["id"]) for x in users], default=1))
            _postgres_set_sequence(dst, "auth_tokens", max([int(x["id"]) for x in tokens], default=1))
            _postgres_set_sequence(dst, "audit_log", max([int(x["id"]) for x in audit], default=1))

        dst_users_after = int((_fetchone_on(dst, dst_backend, "SELECT COUNT(1) AS n FROM users") or {}).get("n") or 0)
    return {
        "ok": True,
        "copied": {
            "tenants": len(tenants),
            "users": len(users),
            "auth_tokens": len(tokens),
            "audit_log": len(audit),
        },
        "source": _backend_meta(src_backend),
        "target": _backend_meta(dst_backend),
        "source_users": src_users,
        "target_users_before": dst_users,
        "target_users_after": dst_users_after,
        "force": bool(force),
    }


def _slugify(text: str) -> str:
    s = "".join(ch.lower() if ch.isalnum() else "-" for ch in str(text or "").strip())
    while "--" in s:
        s = s.replace("--", "-")
    return s.strip("-") or "default"


def _pbkdf2(password: str, salt: bytes, rounds: int = 120_000) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, rounds)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    rounds = 120_000
    derived = _pbkdf2(password, salt, rounds=rounds)
    return f"pbkdf2_sha256${rounds}${base64.b64encode(salt).decode()}${base64.b64encode(derived).decode()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algo, rounds_text, salt_b64, hash_b64 = str(encoded or "").split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        salt = base64.b64decode(salt_b64.encode())
        expected = base64.b64decode(hash_b64.encode())
        actual = _pbkdf2(password, salt, rounds=int(rounds_text))
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _ensure_tenant(c: Any, slug: str, name: str) -> int:
    s = _slugify(slug)
    n = str(name or slug or "Default").strip() or "Default"
    _execute(
        c,
        """
        INSERT INTO tenants(slug, name, active)
        VALUES(?, ?, 1)
        ON CONFLICT(slug) DO UPDATE SET name=excluded.name
        """,
        (s, n),
    )
    row = _fetchone(c, "SELECT id FROM tenants WHERE slug=?", (s,))
    return int(row["id"]) if row else 0


def _ensure_default_bootstrap_user(c: Any) -> None:
    existing = int((_fetchone(c, "SELECT COUNT(1) AS n FROM users") or {}).get("n") or 0)
    if existing > 0:
        _disable_default_bootstrap_users_when_real_admin_exists(c)
        return
    username = _default_bootstrap_username()
    password = _default_bootstrap_password()
    if len(password) < 8:
        password = "admin_teste"
    tenant_id = _ensure_tenant(c, "default", "Default")
    _execute(
        c,
        """
        INSERT INTO users(tenant_id, username, full_name, email, password_hash, role, active, updated_at)
        VALUES(?, ?, ?, '', ?, 'owner', 1, ?)
        """,
        (tenant_id, username, "Administrador inicial", hash_password(password), _utc_text(_utc_now())),
    )
    row = _fetchone(c, "SELECT id FROM users WHERE username=?", (username,))
    user_id = int(row["id"]) if row else 0
    _audit(c, action="auth.default_admin_seeded", tenant_id=tenant_id, user_id=user_id, resource_type="user", resource_id=str(user_id))


def _default_alias_clause() -> tuple[str, tuple[Any, ...]]:
    aliases = _default_bootstrap_usernames()
    placeholders = ", ".join(["lower(?)"] * len(aliases))
    return placeholders, tuple(aliases)


def _disable_default_bootstrap_users_when_real_admin_exists(c: Any) -> None:
    placeholders, params = _default_alias_clause()
    defaults = _fetchall(
        c,
        f"""
        SELECT id, tenant_id, username, active
        FROM users
        WHERE lower(username) IN ({placeholders})
        """,
        params,
    )
    if not defaults:
        return
    now_text = _utc_text(_utc_now())
    for default_user in defaults:
        tenant_id = int(default_user["tenant_id"])
        real_admins = int(
            (_fetchone(
                c,
                f"""
                SELECT COUNT(1) AS n
                FROM users
                WHERE tenant_id=?
                  AND active=1
                  AND lower(username) NOT IN ({placeholders})
                  AND lower(role) IN ('owner', 'admin')
                """,
                (tenant_id, *params),
            ) or {}).get("n")
            or 0
        )
        if real_admins <= 0 or not bool(default_user.get("active")):
            continue
        default_id = int(default_user["id"])
        _execute(c, "UPDATE users SET active=0, updated_at=? WHERE id=?", (now_text, default_id))
        _execute(
            c,
            "UPDATE auth_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
            (now_text, default_id),
        )
        _audit(
            c,
            action="auth.default_admin_disabled",
            tenant_id=tenant_id,
            user_id=None,
            resource_type="user",
            resource_id=str(default_user.get("username") or default_id),
        )


def user_requires_initial_setup(user: Dict[str, Any]) -> bool:
    username = str((user or {}).get("username") or "").strip().lower()
    return username in [x.lower() for x in _default_bootstrap_usernames()]


def _audit(
    c: Any,
    action: str,
    tenant_id: Optional[int] = None,
    user_id: Optional[int] = None,
    resource_type: str = "",
    resource_id: str = "",
    detail_json: str = "",
) -> None:
    _execute(
        c,
        """
        INSERT INTO audit_log(tenant_id, user_id, action, resource_type, resource_id, detail_json)
        VALUES(?, ?, ?, ?, ?, ?)
        """,
        (tenant_id, user_id, action, resource_type, resource_id, detail_json),
    )


def auth_status() -> Dict[str, Any]:
    init_auth_db()
    with _conn() as c:
        tenants = int((_fetchone(c, "SELECT COUNT(1) AS n FROM tenants") or {}).get("n") or 0)
        users = int((_fetchone(c, "SELECT COUNT(1) AS n FROM users") or {}).get("n") or 0)
        active_tokens = int(
            (_fetchone(
                c,
                "SELECT COUNT(1) AS n FROM auth_tokens WHERE revoked_at IS NULL AND expires_at > ?",
                (_utc_text(_utc_now()),),
            ) or {}).get("n")
            or 0
        )
    return {
        "ok": True,
        "backend": _auth_backend(),
        "tenants": tenants,
        "users": users,
        "active_tokens": active_tokens,
        "db_path": _sqlite_auth_path() if _auth_backend() == "sqlite" else "",
        "database_url": _redact_url_secret(_postgres_auth_url()) if _auth_backend() == "postgres" else "",
    }


def bootstrap_admin(
    username: str,
    password: str,
    tenant_slug: str = "default",
    tenant_name: str = "Default",
    full_name: str = "",
    email: str = "",
) -> Dict[str, Any]:
    u = str(username or "").strip()
    if not u:
        raise ValueError("username obrigatorio")
    if len(str(password or "")) < 8:
        raise ValueError("password deve ter ao menos 8 caracteres")
    init_auth_db()
    with _conn() as c:
        existing = int((_fetchone(c, "SELECT COUNT(1) AS n FROM users") or {}).get("n") or 0)
        if existing > 0:
            raise ValueError("bootstrap bloqueado: ja existem usuarios cadastrados")
        tenant_id = _ensure_tenant(c, tenant_slug, tenant_name)
        pwd_hash = hash_password(password)
        _execute(
            c,
            """
            INSERT INTO users(tenant_id, username, full_name, email, password_hash, role, active, updated_at)
            VALUES(?, ?, ?, ?, ?, 'owner', 1, ?)
            """,
            (tenant_id, u, str(full_name or "").strip(), str(email or "").strip(), pwd_hash, _utc_text(_utc_now())),
        )
        user_row = _fetchone(c, "SELECT id FROM users WHERE username=?", (u,))
        user_id = int(user_row["id"]) if user_row else 0
        _audit(c, action="auth.bootstrap_admin", tenant_id=tenant_id, user_id=user_id, resource_type="user", resource_id=str(user_id))
    return {"ok": True, "tenant_slug": _slugify(tenant_slug), "username": u, "role": "owner"}


def create_user(
    actor: Dict[str, Any],
    username: str,
    password: str,
    role: str = "viewer",
    full_name: str = "",
    email: str = "",
    active: bool = True,
) -> Dict[str, Any]:
    if str(actor.get("role") or "").strip().lower() not in ("owner", "admin"):
        raise ValueError("permissao insuficiente")
    u = str(username or "").strip()
    if not u:
        raise ValueError("username obrigatorio")
    if len(str(password or "")) < 8:
        raise ValueError("password deve ter ao menos 8 caracteres")
    role_norm = str(role or "viewer").strip().lower()
    if role_norm not in ("owner", "admin", "operator", "viewer"):
        raise ValueError("role invalida")
    actor_role = str(actor.get("role") or "").strip().lower()
    if role_norm == "owner" and actor_role != "owner":
        raise ValueError("somente owner pode criar outro owner")

    init_auth_db()
    with _conn() as c:
        tenant_id = int(actor["tenant_id"])
        exists = _fetchone(c, "SELECT id FROM users WHERE username=?", (u,))
        if exists:
            raise ValueError("username ja existe")
        default_usernames = _default_bootstrap_usernames()
        default_username = _default_bootstrap_username()
        placeholders, default_params = _default_alias_clause()
        actor_is_default = str(actor.get("username") or "").strip().lower() in [x.lower() for x in default_usernames]
        other_users = int(
            (_fetchone(
                c,
                f"SELECT COUNT(1) AS n FROM users WHERE tenant_id=? AND lower(username) NOT IN ({placeholders})",
                (tenant_id, *default_params),
            ) or {}).get("n")
            or 0
        )
        setup_completion = bool(actor_is_default and other_users == 0)
        if setup_completion:
            role_norm = "owner"
            active = True
        _execute(
            c,
            """
            INSERT INTO users(tenant_id, username, full_name, email, password_hash, role, active, updated_at)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                tenant_id,
                u,
                str(full_name or "").strip(),
                str(email or "").strip(),
                hash_password(password),
                role_norm,
                1 if active else 0,
                _utc_text(_utc_now()),
            ),
        )
        created = _fetchone(
            c,
            """
            SELECT u.id, u.username, u.full_name, u.email, u.role, u.active, t.slug AS tenant_slug, t.name AS tenant_name
            FROM users u
            JOIN tenants t ON t.id = u.tenant_id
            WHERE u.username=?
            """,
            (u,),
        )
        user_id = int((created or {}).get("id") or 0)
        _audit(c, action="user.create", tenant_id=tenant_id, user_id=int(actor["id"]), resource_type="user", resource_id=str(user_id))
        if setup_completion:
            now_text = _utc_text(_utc_now())
            _execute(
                c,
                f"UPDATE users SET active=0, updated_at=? WHERE tenant_id=? AND lower(username) IN ({placeholders})",
                (now_text, tenant_id, *default_params),
            )
            _execute(
                c,
                f"""
                UPDATE auth_tokens
                SET revoked_at=?
                WHERE user_id IN (
                    SELECT id FROM users WHERE tenant_id=? AND lower(username) IN ({placeholders})
                )
                AND revoked_at IS NULL
                """,
                (now_text, tenant_id, *default_params),
            )
            _audit(
                c,
                action="auth.default_admin_disabled",
                tenant_id=tenant_id,
                user_id=user_id,
                resource_type="user",
                resource_id=default_username,
            )
            if created is not None:
                created["_setup_completed"] = True
    return created or {}


def _get_user_for_tenant(c: Any, tenant_id: int, user_id: int) -> Optional[Dict[str, Any]]:
    return _fetchone(
        c,
        """
        SELECT u.id, u.tenant_id, u.username, u.full_name, u.email, u.role, u.active,
               t.slug AS tenant_slug, t.name AS tenant_name
        FROM users u
        JOIN tenants t ON t.id = u.tenant_id
        WHERE u.tenant_id=? AND u.id=?
        """,
        (tenant_id, user_id),
    )


def update_user_status(actor: Dict[str, Any], target_user_id: int, active: bool) -> Dict[str, Any]:
    actor_role = str(actor.get("role") or "").strip().lower()
    if actor_role not in ("owner", "admin"):
        raise ValueError("permissao insuficiente")
    init_auth_db()
    with _conn() as c:
        tenant_id = int(actor["tenant_id"])
        current = _get_user_for_tenant(c, tenant_id, int(target_user_id))
        if not current:
            raise ValueError("usuario nao encontrado")
        if int(current["id"]) == int(actor["id"]) and not bool(active):
            raise ValueError("voce nao pode desativar o proprio usuario")
        if str(current.get("role") or "").strip().lower() == "owner" and actor_role != "owner":
            raise ValueError("somente owner pode alterar outro owner")
        _execute(
            c,
            "UPDATE users SET active=?, updated_at=? WHERE id=?",
            (1 if active else 0, _utc_text(_utc_now()), int(target_user_id)),
        )
        if not active:
            _execute(
                c,
                "UPDATE auth_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
                (_utc_text(_utc_now()), int(target_user_id)),
            )
        _audit(
            c,
            action="user.set_active",
            tenant_id=tenant_id,
            user_id=int(actor["id"]),
            resource_type="user",
            resource_id=str(target_user_id),
            detail_json=json.dumps({"active": bool(active)}, ensure_ascii=False),
        )
        fresh = _get_user_for_tenant(c, tenant_id, int(target_user_id))
    return fresh or {}


def update_user_password(actor: Dict[str, Any], target_user_id: int, new_password: str) -> Dict[str, Any]:
    actor_role = str(actor.get("role") or "").strip().lower()
    if actor_role not in ("owner", "admin"):
        raise ValueError("permissao insuficiente")
    if len(str(new_password or "")) < 8:
        raise ValueError("password deve ter ao menos 8 caracteres")
    init_auth_db()
    with _conn() as c:
        tenant_id = int(actor["tenant_id"])
        current = _get_user_for_tenant(c, tenant_id, int(target_user_id))
        if not current:
            raise ValueError("usuario nao encontrado")
        if str(current.get("role") or "").strip().lower() == "owner" and actor_role != "owner":
            raise ValueError("somente owner pode redefinir senha de owner")
        _execute(
            c,
            "UPDATE users SET password_hash=?, updated_at=? WHERE id=?",
            (hash_password(new_password), _utc_text(_utc_now()), int(target_user_id)),
        )
        _execute(
            c,
            "UPDATE auth_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL",
            (_utc_text(_utc_now()), int(target_user_id)),
        )
        _audit(
            c,
            action="user.reset_password",
            tenant_id=tenant_id,
            user_id=int(actor["id"]),
            resource_type="user",
            resource_id=str(target_user_id),
        )
        fresh = _get_user_for_tenant(c, tenant_id, int(target_user_id))
    return fresh or {}


def update_user_profile(
    actor: Dict[str, Any],
    target_user_id: int,
    full_name: str = "",
    email: str = "",
    role: str = "viewer",
) -> Dict[str, Any]:
    actor_role = str(actor.get("role") or "").strip().lower()
    if actor_role not in ("owner", "admin"):
        raise ValueError("permissao insuficiente")
    role_norm = str(role or "viewer").strip().lower()
    if role_norm not in ("owner", "admin", "operator", "viewer"):
        raise ValueError("role invalida")
    if role_norm == "owner" and actor_role != "owner":
        raise ValueError("somente owner pode promover outro owner")

    init_auth_db()
    with _conn() as c:
        tenant_id = int(actor["tenant_id"])
        current = _get_user_for_tenant(c, tenant_id, int(target_user_id))
        if not current:
            raise ValueError("usuario nao encontrado")
        current_role = str(current.get("role") or "").strip().lower()
        if current_role == "owner" and actor_role != "owner":
            raise ValueError("somente owner pode editar outro owner")
        if int(current["id"]) == int(actor["id"]) and role_norm != current_role and actor_role != "owner":
            raise ValueError("somente owner pode alterar o proprio perfil administrativo")

        _execute(
            c,
            """
            UPDATE users
            SET full_name=?, email=?, role=?, updated_at=?
            WHERE id=?
            """,
            (
                str(full_name or "").strip(),
                str(email or "").strip(),
                role_norm,
                _utc_text(_utc_now()),
                int(target_user_id),
            ),
        )
        _audit(
            c,
            action="user.update_profile",
            tenant_id=tenant_id,
            user_id=int(actor["id"]),
            resource_type="user",
            resource_id=str(target_user_id),
            detail_json=json.dumps(
                {
                    "full_name": str(full_name or "").strip(),
                    "email": str(email or "").strip(),
                    "role": role_norm,
                },
                ensure_ascii=False,
            ),
        )
        fresh = _get_user_for_tenant(c, tenant_id, int(target_user_id))
    return fresh or {}


def authenticate_user(username: str, password: str) -> Optional[Dict[str, Any]]:
    init_auth_db()
    user = None
    with _conn() as c:
        user = _fetchone(
            c,
            """
            SELECT u.id, u.tenant_id, u.username, u.full_name, u.email, u.password_hash, u.role, u.active,
                   t.slug AS tenant_slug, t.name AS tenant_name, t.active AS tenant_active
            FROM users u
            JOIN tenants t ON t.id = u.tenant_id
            WHERE u.username=?
            """,
            (str(username or "").strip(),),
        )
    if not user:
        return None
    if not bool(user.get("active")) or not bool(user.get("tenant_active")):
        return None
    if not verify_password(password, str(user.get("password_hash") or "")):
        return None
    return user


def create_access_token(user: Dict[str, Any], label: str = "", ttl_hours: int = 24) -> Dict[str, Any]:
    init_auth_db()
    token = secrets.token_urlsafe(32)
    expires_at = _utc_now() + timedelta(hours=max(1, int(ttl_hours or 24)))
    token_hash = _token_hash(token)
    with _conn() as c:
        _execute(
            c,
            """
            INSERT INTO auth_tokens(user_id, token_hash, label, expires_at)
            VALUES(?, ?, ?, ?)
            """,
            (int(user["id"]), token_hash, str(label or "").strip(), _utc_text(expires_at)),
        )
        _audit(
            c,
            action="auth.login",
            tenant_id=int(user["tenant_id"]),
            user_id=int(user["id"]),
            resource_type="auth_token",
            resource_id=token_hash[:12],
        )
    return {"access_token": token, "token_type": "bearer", "expires_at": _utc_text(expires_at)}


def get_user_by_token(token: str) -> Optional[Dict[str, Any]]:
    raw = str(token or "").strip()
    if not raw:
        return None
    init_auth_db()
    now_text = _utc_text(_utc_now())
    with _conn() as c:
        user = _fetchone(
            c,
            """
            SELECT u.id, u.tenant_id, u.username, u.full_name, u.email, u.role, u.active,
                   t.slug AS tenant_slug, t.name AS tenant_name, t.active AS tenant_active,
                   at.id AS token_id, at.expires_at, at.revoked_at
            FROM auth_tokens at
            JOIN users u ON u.id = at.user_id
            JOIN tenants t ON t.id = u.tenant_id
            WHERE at.token_hash = ?
            """,
            (_token_hash(raw),),
        )
        if not user:
            return None
        if user.get("revoked_at"):
            return None
        if str(user.get("expires_at") or "") <= now_text:
            return None
        if not bool(user.get("active")) or not bool(user.get("tenant_active")):
            return None
        _execute(c, "UPDATE auth_tokens SET last_seen_at=? WHERE id=?", (now_text, int(user["token_id"])))
    return user


def revoke_token(token: str, actor: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    raw = str(token or "").strip()
    if not raw:
        raise ValueError("token obrigatorio")
    init_auth_db()
    now_text = _utc_text(_utc_now())
    token_hash = _token_hash(raw)
    with _conn() as c:
        row = _fetchone(c, "SELECT id FROM auth_tokens WHERE token_hash=?", (token_hash,))
        if not row:
            return {"ok": True, "revoked": False}
        _execute(c, "UPDATE auth_tokens SET revoked_at=? WHERE id=?", (now_text, int(row["id"])))
        _audit(
            c,
            action="auth.logout",
            tenant_id=int(actor["tenant_id"]) if actor else None,
            user_id=int(actor["id"]) if actor else None,
            resource_type="auth_token",
            resource_id=token_hash[:12],
        )
    return {"ok": True, "revoked": True}


def list_users(actor: Dict[str, Any]) -> List[Dict[str, Any]]:
    init_auth_db()
    with _conn() as c:
        return _fetchall(
            c,
            """
            SELECT u.id, u.username, u.full_name, u.email, u.role, u.active, u.created_at, u.updated_at,
                   t.slug AS tenant_slug, t.name AS tenant_name
            FROM users u
            JOIN tenants t ON t.id = u.tenant_id
            WHERE u.tenant_id=?
            ORDER BY u.username
            """,
            (int(actor["tenant_id"]),),
        )


def recent_audit_events(actor: Dict[str, Any], limit: int = 50) -> List[Dict[str, Any]]:
    init_auth_db()
    lim = max(1, min(int(limit or 50), 200))
    with _conn() as c:
        return _fetchall(
            c,
            """
            SELECT id, action, resource_type, resource_id, detail_json, created_at, user_id
            FROM audit_log
            WHERE tenant_id=?
            ORDER BY id DESC
            LIMIT ?
            """,
            (int(actor["tenant_id"]), lim),
        )


def auth_enabled() -> bool:
    raw = str(os.getenv("AUTH_ENABLED", "1")).strip().lower()
    return raw in ("1", "true", "yes", "on")
