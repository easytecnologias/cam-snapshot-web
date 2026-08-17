from __future__ import annotations

import sys
import tempfile
from pathlib import Path
from typing import Dict

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.api.endpoints.access_control import (
    AccessDoorGroupRequest,
    AccessGroupRequest,
    AccessRuleRequest,
    api_access_control_save_door_group,
    api_access_control_save_group,
    api_access_control_save_rule,
    router,
)
from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
from app.services import db_store
from app.services.access_control_store import (
    list_pending_provisions,
    save_device,
    save_person,
)


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


def _pending_pairs() -> set[tuple[str, str]]:
    return {
        (str(row["person_id"]), str(row["device_id"]))
        for row in list_pending_provisions()
        if str(row.get("status")) == "pending"
    }


def test_normal_setup_order_enqueues_provisioning() -> None:
    """Ordem real de implantacao: cadastra pessoas -> cria grupo -> cria grupo de
    porta -> cria a regra que liga os dois. Antes desta correcao so o POST
    /people enfileirava provisionamento, entao essa sequencia terminava com ZERO
    linhas pendentes e o loop de fundo nunca provisionava ninguem
    (retry_pending_provisions so reprocessa o que ja existe). Nenhuma chamada a
    /people/{id}/sync aqui de proposito."""
    token = set_current_tenant_slug("cliente-provision-order")
    try:
        person = save_person({"full_name": "Ana Ordem", "site": "Sede"})
        device = save_device({
            "name": "Catraca Portao", "site": "Sede", "vendor": "dahua",
            "host": "10.10.13.33", "username": "admin", "password": "xzydsP2011",
        })
        assert _pending_pairs() == set(), "nao deveria haver pendencia antes de existir regra"

        group = api_access_control_save_group(
            AccessGroupRequest(name="Alunos Manha", site="Sede", member_ids=[person["id"]])
        )["group"]
        # Ainda sem grupo de porta/regra: a pessoa nao alcanca nenhum dispositivo.
        assert _pending_pairs() == set()

        door_group = api_access_control_save_door_group(
            AccessDoorGroupRequest(name="Portao Principal", site="Sede", device_ids=[device["id"]])
        )["door_group"]
        assert _pending_pairs() == set()

        api_access_control_save_rule(
            AccessRuleRequest(people_group_id=group["id"], door_group_id=door_group["id"])
        )
        assert _pending_pairs() == {(person["id"], device["id"])}, (
            "salvar a regra tinha que enfileirar o par (pessoa, dispositivo) sem re-salvar a pessoa"
        )
    finally:
        reset_current_tenant_slug(token)


def test_adding_member_to_existing_group_enqueues_provisioning() -> None:
    """Caminho inverso: caminho de acesso ja montado, pessoa nova entra no grupo
    depois. Salvar o grupo (unica acao do operador) tem que enfileirar."""
    token = set_current_tenant_slug("cliente-provision-membro")
    try:
        first = save_person({"full_name": "Bruno Antigo", "site": "Sede"})
        device = save_device({
            "name": "Catraca Portao", "site": "Sede", "vendor": "dahua",
            "host": "10.10.13.33", "username": "admin", "password": "xzydsP2011",
        })
        group = api_access_control_save_group(
            AccessGroupRequest(name="Alunos", site="Sede", member_ids=[first["id"]])
        )["group"]
        door_group = api_access_control_save_door_group(
            AccessDoorGroupRequest(name="Portao", site="Sede", device_ids=[device["id"]])
        )["door_group"]
        api_access_control_save_rule(
            AccessRuleRequest(people_group_id=group["id"], door_group_id=door_group["id"])
        )
        assert _pending_pairs() == {(first["id"], device["id"])}

        segundo = save_person({"full_name": "Carla Nova", "site": "Sede"})
        api_access_control_save_group(
            AccessGroupRequest(
                id=group["id"], name="Alunos", site="Sede", member_ids=[first["id"], segundo["id"]]
            )
        )
        assert _pending_pairs() == {
            (first["id"], device["id"]),
            (segundo["id"], device["id"]),
        }
    finally:
        reset_current_tenant_slug(token)


def test_new_device_in_door_group_enqueues_provisioning() -> None:
    """Trocar/adicionar catraca num grupo de portas ja usado por uma regra ativa
    tem que enfileirar as pessoas alcancadas por essa regra."""
    token = set_current_tenant_slug("cliente-provision-porta")
    try:
        person = save_person({"full_name": "Diego Teste", "site": "Sede"})
        device = save_device({
            "name": "Catraca A", "site": "Sede", "vendor": "dahua",
            "host": "10.10.13.33", "username": "admin", "password": "xzydsP2011",
        })
        group = api_access_control_save_group(
            AccessGroupRequest(name="Funcionarios", site="Sede", member_ids=[person["id"]])
        )["group"]
        door_group = api_access_control_save_door_group(
            AccessDoorGroupRequest(name="Portoes", site="Sede", device_ids=[device["id"]])
        )["door_group"]
        api_access_control_save_rule(
            AccessRuleRequest(people_group_id=group["id"], door_group_id=door_group["id"])
        )
        novo = save_device({
            "name": "Catraca B", "site": "Sede", "vendor": "dahua",
            "host": "10.10.13.34", "username": "admin", "password": "xzydsP2011",
        })
        api_access_control_save_door_group(
            AccessDoorGroupRequest(
                id=door_group["id"], name="Portoes", site="Sede", device_ids=[device["id"], novo["id"]]
            )
        )
        assert (person["id"], novo["id"]) in _pending_pairs()
    finally:
        reset_current_tenant_slug(token)


def main() -> None:
    test_new_routes_registered()
    with tempfile.TemporaryDirectory(prefix="sightops-access-routes-") as tmp:
        db_store.SIGHTOPS_DB_PATH = Path(tmp) / "access.db"
        db_store.init_db()
        test_normal_setup_order_enqueues_provisioning()
        test_adding_member_to_existing_group_enqueues_provisioning()
        test_new_device_in_door_group_enqueues_provisioning()
    print("OK access control routes: dispositivos, grupos, regras, sync e eventos registrados")


if __name__ == "__main__":
    main()
