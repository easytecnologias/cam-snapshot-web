from __future__ import annotations

from typing import Iterable

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.settings import AppSettings
from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
from app.services.auth_store import get_user_by_token

ROLE_RANK = {
    "viewer": 10,
    "operator": 20,
    "admin": 30,
    "owner": 40,
}


class ApiAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, settings: AppSettings) -> None:
        super().__init__(app)
        self.settings = settings
        self._public_paths = {
            "/api/auth/status",
            "/api/auth/login",
            "/api/auth/bootstrap-admin",
            "/api/system/health/live",
            "/api/system/health/ready",
            "/api/system/info",
            "/api/live/jpeg",
            "/api/live/mjpeg",
        }
        self._role_rules = [
            (("GET",), "/api/auth/users", "admin"),
            (("GET",), "/api/auth/audit", "admin"),
            (("POST",), "/api/auth/users", "admin"),
            (("POST",), "/api/db/init", "admin"),
            (("POST",), "/api/db/migrate", "admin"),
            (("POST",), "/api/db/storage/migrate", "admin"),
            (("POST",), "/api/db/sites", "admin"),
            (("POST",), "/api/db/assign-site", "admin"),
            (("POST",), "/api/settings/imgbb", "admin"),
            (("POST",), "/api/settings/imgbb/test", "admin"),
            (("POST",), "/api/scripts/", "admin"),
            (("POST",), "/api/backup/import", "admin"),
            (("POST",), "/api/inventory/report/settings", "admin"),
            (("POST",), "/api/inventory/report/logo", "admin"),
            (("POST",), "/api/dvr/report/settings", "admin"),
            (("POST",), "/api/dvr/report/logo", "admin"),
            (("POST",), "/api/nvr/report/settings", "admin"),
            (("POST",), "/api/nvr/report/logo", "admin"),
            (("POST",), "/api/inventory/import", "operator"),
            (("POST",), "/api/inventory/clear", "operator"),
            (("POST",), "/api/inventory/imgbb/upload", "operator"),
            (("POST",), "/api/kmz/", "operator"),
            (("POST",), "/api/scan", "operator"),
            (("POST",), "/api/inventory/delete", "operator"),
            (("POST",), "/api/rescan-single-ip", "operator"),
            (("POST",), "/api/olt/", "operator"),
            (("POST",), "/api/switch/", "operator"),
            (("POST",), "/api/tools/scan-ip", "operator"),
            (("POST",), "/api/discovery/run", "operator"),
            (("POST",), "/api/portscan/apply", "operator"),
            (("POST",), "/api/cameras/save", "operator"),
            (("POST",), "/api/cameras/ping_many", "operator"),
            (("POST",), "/api/snapshot/save", "operator"),
            (("POST",), "/api/cameras/ptz_move", "operator"),
            (("POST",), "/api/cameras/reboot", "operator"),
            (("POST",), "/api/cameras/rename", "operator"),
            (("POST",), "/api/maintenance/", "operator"),
            (("POST",), "/api/dvr/", "operator"),
            (("POST",), "/api/nvr/", "operator"),
        ]

    def _is_public_path(self, path: str) -> bool:
        if path in self._public_paths:
            return True
        return False

    def _match_role_rule(self, path: str, method: str) -> str:
        for methods, prefix, min_role in self._role_rules:
            if method not in methods:
                continue
            if path == prefix or path.startswith(prefix):
                return min_role
        return ""

    def _require_auth(self, path: str, method: str) -> bool:
        if not self.settings.auth_enabled:
            return False
        if not path.startswith("/api/"):
            return False
        if self._is_public_path(path):
            return False
        if method.upper() == "OPTIONS":
            return False
        if self._match_role_rule(path, method):
            return True
        if self.settings.auth_required:
            return True
        if not self.settings.auth_legacy_open and method.upper() not in ("GET", "HEAD"):
            return True
        return False

    @staticmethod
    def _role_allows(user_role: str, required_role: str) -> bool:
        have = ROLE_RANK.get(str(user_role or "").strip().lower(), 0)
        need = ROLE_RANK.get(str(required_role or "").strip().lower(), 10**9)
        return have >= need

    @staticmethod
    def _extract_bearer_token(headers: Iterable[tuple[str, str]] | dict | Request) -> str:
        if isinstance(headers, Request):
            raw = str(headers.headers.get("authorization") or "").strip()
            if not raw:
                query_token = str(
                    headers.query_params.get("auth_token")
                    or headers.query_params.get("access_token")
                    or headers.query_params.get("token")
                    or ""
                ).strip()
                if query_token:
                    return query_token
        elif isinstance(headers, dict):
            raw = str(headers.get("authorization") or "").strip()
        else:
            raw = ""
            for key, value in headers:
                if str(key).lower() == "authorization":
                    raw = str(value or "").strip()
                    break
        scheme, _, token = raw.partition(" ")
        if scheme.lower() != "bearer":
            return ""
        return token.strip()

    async def dispatch(self, request: Request, call_next) -> Response:
        path = request.url.path
        method = request.method.upper()
        ctx_token = set_current_tenant_slug("")
        if not self._require_auth(path, method):
            try:
                return await call_next(request)
            finally:
                reset_current_tenant_slug(ctx_token)

        token = self._extract_bearer_token(request)
        if not token:
            try:
                return JSONResponse(status_code=401, content={"detail": "autenticacao obrigatoria"})
            finally:
                reset_current_tenant_slug(ctx_token)

        user = get_user_by_token(token)
        if not user:
            try:
                return JSONResponse(status_code=401, content={"detail": "token invalido ou expirado"})
            finally:
                reset_current_tenant_slug(ctx_token)

        required_role = self._match_role_rule(path, method)
        if required_role and not self._role_allows(str(user.get("role") or ""), required_role):
            try:
                return JSONResponse(
                    status_code=403,
                    content={"detail": f"permissao insuficiente: requer perfil {required_role}"},
                )
            finally:
                reset_current_tenant_slug(ctx_token)

        request.state.current_user = user
        request.state.current_tenant_slug = str(user.get("tenant_slug") or "").strip().lower()
        reset_current_tenant_slug(ctx_token)
        ctx_token = set_current_tenant_slug(request.state.current_tenant_slug)
        try:
            return await call_next(request)
        finally:
            reset_current_tenant_slug(ctx_token)
