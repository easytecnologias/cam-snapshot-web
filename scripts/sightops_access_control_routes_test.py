from __future__ import annotations

import sys
from pathlib import Path
from typing import Dict

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.api.endpoints.access_control import router


def test_new_routes_registered() -> None:
    # FastAPI registra um objeto de rota por decorator (@router.get, @router.post, ...),
    # entao GET e POST no mesmo path viram DUAS entradas em router.routes, cada uma com
    # route.methods = {"GET"} ou {"POST"} isoladamente -- nunca {"GET", "POST"} junto.
    # Por isso agregamos os metodos por path antes de comparar com o conjunto esperado.
    methods_by_path: Dict[str, set[str]] = {}
    for route in router.routes:
        methods_by_path.setdefault(route.path, set()).update(route.methods)
    paths = {(path, tuple(sorted(methods))) for path, methods in methods_by_path.items()}
    expected = {
        ("/api/access-control/devices", ("GET", "POST")),
        ("/api/access-control/devices/{device_id}", ("DELETE",)),
        ("/api/access-control/devices/{device_id}/open-door", ("POST",)),
        ("/api/access-control/groups", ("GET", "POST")),
        ("/api/access-control/groups/{group_id}", ("DELETE",)),
        ("/api/access-control/door-groups", ("GET", "POST")),
        ("/api/access-control/door-groups/{door_group_id}", ("DELETE",)),
        ("/api/access-control/rules", ("GET", "POST")),
        ("/api/access-control/rules/{rule_id}", ("DELETE",)),
        ("/api/access-control/people/{person_id}/sync", ("POST",)),
        ("/api/access-control/events", ("GET",)),
    }
    missing = expected - paths
    assert not missing, f"rotas faltando: {missing}"


def main() -> None:
    test_new_routes_registered()
    print("OK access control routes: dispositivos, grupos, regras, sync e eventos registrados")


if __name__ == "__main__":
    main()
