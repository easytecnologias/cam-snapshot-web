from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INDEX_HTML = ROOT / "frontend" / "index.html"
CORE_JS = ROOT / "frontend" / "js" / "core.js"
BOOTSTRAP_JS = ROOT / "frontend" / "js" / "bootstrap.js"
ACCESS_JS = ROOT / "frontend" / "js" / "accessControl.js"
AUTH_STORE = ROOT / "app" / "services" / "auth_store.py"
MAIN_PY = ROOT / "app" / "main.py"
ENDPOINTS_INIT = ROOT / "app" / "api" / "endpoints" / "__init__.py"
STYLES = ROOT / "frontend" / "styles.css"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _access_control_section() -> str:
    html = _read(INDEX_HTML)
    section = html.split('id="viewAccessControl"', 1)[1]
    return section.split("<!-- --- VIEW: OLT --- -->", 1)[0]


def test_access_control_menu_has_own_sidebar_section() -> None:
    html = _read(INDEX_HTML)
    analysis_marker = '<!-- Analise -->'
    access_marker = '<!-- Controle de Acesso -->'
    assert analysis_marker in html
    assert access_marker in html
    analysis = html.split(analysis_marker, 1)[1].split(access_marker, 1)[0]
    access = html.split(access_marker, 1)[1].split('<div id="navOwnerMode"', 1)[0]
    assert 'data-view="ia-nvr"' in analysis
    assert 'data-view="access-control"' not in analysis
    assert '<div class="nav-section-label">Controle de Acesso</div>' in access
    assert "<span>Controle de Acesso</span>" in access


def test_access_control_view_exists_and_is_routable() -> None:
    html = _read(INDEX_HTML)
    core = _read(CORE_JS)
    assert 'id="viewAccessControl"' in html
    assert "'access-control': { title: 'Controle de Acesso'" in core
    assert "'access-control':  'viewAccessControl'" in core
    assert "case 'access-control': loadAccessControl();" in core


def test_access_control_layout_uses_sightops_components() -> None:
    section = _access_control_section()
    styles = _read(STYLES)

    assert 'class="metrics access-control-kpis"' in section
    assert section.count('class="dash-kpi-card"') == 4
    assert section.count('class="metric-icon') == 4
    assert 'id="btnAccessPersonNew"' in section
    assert 'id="accessPeopleTable"' in section
    assert 'id="modalAccessPerson"' in section
    assert 'class="dashboard-grid"' not in section
    assert 'class="kpi-card"' not in section
    assert 'class="quick-actions-grid"' not in section
    assert ".access-control-kpis" in styles
    assert ".access-control-toolbar" in styles
    assert ".access-person-modal" in styles


def test_access_control_frontend_is_bound() -> None:
    html = _read(INDEX_HTML)
    bootstrap = _read(BOOTSTRAP_JS)
    access_js = _read(ACCESS_JS)

    assert 'js/accessControl.js' in html
    assert "bindAccessControl();" in bootstrap
    assert "function bindAccessControl()" in access_js
    assert "/api/access-control/people" in access_js


def test_access_control_module_can_be_enabled_per_tenant() -> None:
    auth = _read(AUTH_STORE)
    assert '{"key": "access-control", "label": "Controle de Acesso", "section": "Controle de Acesso"}' in auth


def test_access_control_backend_router_is_registered() -> None:
    main = _read(MAIN_PY)
    endpoints = _read(ENDPOINTS_INIT)

    assert "access_control_router" in endpoints
    assert "app.include_router(access_control_router)" in main


def test_access_devices_tab_exists() -> None:
    html = _read(INDEX_HTML)
    access_js = _read(ACCESS_JS)
    assert 'id="accessTabDevices"' in html
    assert 'id="accessDevicesTable"' in html
    assert 'id="btnAccessDeviceNew"' in html
    assert "function loadAccessDevices" in access_js
    assert "function renderAccessDevices" in access_js
    assert "data-access-open-door" in access_js


def test_access_device_save_preserves_vendor_and_model() -> None:
    # save_device() no backend faz UPDATE completo (ON CONFLICT DO UPDATE SET
    # vendor=excluded.vendor, model=excluded.model), entao o payload de edicao
    # precisa sempre carregar vendor/model do registro atual -- senao editar um
    # dispositivo apaga o model salvo e reseta o vendor pro default "dahua".
    html = _read(INDEX_HTML)
    access_js = _read(ACCESS_JS)
    assert 'id="accessDeviceVendor"' in html
    assert 'id="accessDeviceModel"' in html
    assert "item.vendor" in access_js
    assert "item.model" in access_js
    assert "vendor: document.getElementById('accessDeviceVendor')" in access_js
    assert "model: document.getElementById('accessDeviceModel')" in access_js


if __name__ == "__main__":
    test_access_control_menu_has_own_sidebar_section()
    test_access_control_view_exists_and_is_routable()
    test_access_control_layout_uses_sightops_components()
    test_access_control_frontend_is_bound()
    test_access_control_module_can_be_enabled_per_tenant()
    test_access_control_backend_router_is_registered()
    test_access_devices_tab_exists()
    test_access_device_save_preserves_vendor_and_model()
    print("OK access control shell")
