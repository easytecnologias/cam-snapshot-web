# Ver ao vivo - consolidacao em MSE via go2rtc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir as duas implementacoes de "ver ao vivo" que hoje coexistem (MJPEG morto + WebRTC sem TURN, ambos frageis) por um pipeline so, confiavel: MSE (Media Source Extensions) sobre o WebSocket que o go2rtc ja expoe, com registro idempotente e limpeza automatica de streams ociosos.

**Architecture:** `navegador <--WebSocket MSE/fMP4--> go2rtc <--RTSP--> camera`. O `go2rtc` entra no docker-compose (deixa de ser um container solto no servidor). O backend ganha um servico (`app/services/live_stream_service.py`) que registra/desregistra cameras no go2rtc de forma idempotente e remove periodicamente streams sem espectador. O frontend ganha um client MSE proprio (`frontend/js/liveStream.js`), usado tanto pelo painel de detalhe de camera quanto pelo modal de manutencao, eliminando a sinalizacao WebRTC hoje duplicada nos dois arquivos.

**Tech Stack:** FastAPI/Python (backend), JS puro sem framework (frontend), go2rtc (`alexxit/go2rtc`) como media server, Docker Compose.

## Global Constraints

- Sem WebRTC, sem STUN/TURN, sem audio -- so video, via MSE. (decisao do usuario)
- Publico e so navegador (desktop/tablet/celular pelo browser) -- sem app nativo. (decisao do usuario)
- HD (`subtype=0`) e SD (`subtype=1`, padrao ao abrir a tela) precisam estar disponiveis com um controle de troca na UI. (decisao do usuario)
- Streams sao removidos do go2rtc automaticamente quando ninguem esta assistindo -- nunca ficam registrados para sempre. (decisao do usuario, tambem fecha o vazamento de credenciais corrigido em 2026-08-29)
- O pipeline MJPEG antigo (`app/api/endpoints/live.py`, `app/services/live_mjpeg_service.py`) e removido por completo -- confirmado sem nenhum consumidor no frontend hoje.
- O nome do servico go2rtc dentro do docker-compose e `go2rtc` (DNS interno `go2rtc:1984`) -- usado consistentemente no backend (`GO2RTC_BASE_URL`) e no nginx (`deploy/nginx/default.conf`). Nao mudar esse nome sem atualizar os dois lugares.
- Este repo NAO usa pytest. Testes sao scripts standalone em `scripts/sightops_*_test.py`, rodados com `python scripts/nome_test.py`, usando `assert` direto. Mocks de HTTP seguem o padrao ja usado em `scripts/sightops_whatsapp_evolution_service_test.py`: reatribuir `requests.get`/`requests.post`/`requests.put`/`requests.delete` no modulo, com um `FakeResponse` simples, restaurando no `finally`.
- Assets do frontend usam `?v=N` no `index.html` para furar o cache do Cloudflare -- todo arquivo `.js`/`.css` alterado precisa de um numero de versao NOVO (nunca reusado). Ver `frontend/index.html:6066-6084` para a lista atual.
- Confirmado testando o go2rtc real em producao (versao 1.9.14): `GET /api/streams?name=X` **ignora** o parametro `name` e sempre devolve a lista inteira -- so `DELETE /api/streams?name=X` respeita o filtro. Qualquer logica que precise checar um stream especifico tem que buscar a lista inteira e procurar pela chave no dicionario, nao confiar em filtro do lado do go2rtc.
- Producao nao atualiza a partir do git -- o deploy real (subir o go2rtc no servidor, aplicar o novo nginx, aposentar o container antigo) fica para quando o usuario pedir, fora do escopo deste plano de codigo.

---

### Task 1: Servico de streams do go2rtc (registro idempotente, desregistro, limpeza)

**Files:**
- Create: `app/services/live_stream_service.py`
- Test: `scripts/sightops_live_stream_service_test.py`

**Interfaces:**
- Produces (usado pelas Tasks 2 e 3):
  - `GO2RTC_BASE_URL: str` -- constante `"http://go2rtc:1984"`.
  - `register_stream(*, ip: str, user: str, password: str, subtype: int = 1, vendor: str = "", model: str = "") -> str` -- devolve o `stream_name`.
  - `unregister_stream(*, ip: str, subtype: int = 1) -> None`.
  - `reap_idle_streams() -> list[str]` -- devolve os nomes removidos.
  - `_stream_rtsp_path_for_camera(*, vendor: str = "", model: str = "", subtype: int = 1) -> str` -- migrada de `app/api/endpoints/maintenance.py`, comportamento identico.

- [ ] **Step 1: Escrever o teste (ainda vai falhar -- o modulo nao existe)**

Crie `scripts/sightops_live_stream_service_test.py`:

```python
"""Testa o servico de streams do go2rtc: registro idempotente, desregistro e
a varredura que remove streams sem espectador. Usa um FakeResponse para
simular o go2rtc sem rede.

Confirmado testando o go2rtc real em producao (versao 1.9.14): o parametro
?name= do GET /api/streams e IGNORADO -- sempre devolve a lista inteira. So
o DELETE respeita o filtro por nome. O FakeResponse abaixo reproduz esse
comportamento de proposito, para o teste continuar valendo se alguem tentar
"otimizar" o registro para filtrar do lado do servidor.

Roda direto: python scripts/sightops_live_stream_service_test.py
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any


def main() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

    import requests
    from app.services import live_stream_service as svc

    chamadas: list[dict[str, Any]] = []
    estado_streams: dict[str, Any] = {}

    class FakeResponse:
        def __init__(self, status_code: int, body: Any):
            self.status_code = status_code
            self._body = body

        def json(self) -> Any:
            return self._body

    def fake_get(url: str, **kwargs: Any) -> FakeResponse:
        chamadas.append({"metodo": "GET", "url": url, **kwargs})
        # go2rtc real ignora ?name= no GET -- sempre devolve tudo.
        return FakeResponse(200, dict(estado_streams))

    def fake_put(url: str, **kwargs: Any) -> FakeResponse:
        chamadas.append({"metodo": "PUT", "url": url, **kwargs})
        params = kwargs.get("params") or {}
        estado_streams[params["name"]] = {"producers": [{"url": params["src"]}], "consumers": None}
        return FakeResponse(200, {})

    def fake_delete(url: str, **kwargs: Any) -> FakeResponse:
        chamadas.append({"metodo": "DELETE", "url": url, **kwargs})
        params = kwargs.get("params") or {}
        estado_streams.pop(params.get("name"), None)
        return FakeResponse(200, {})

    original_get, original_put, original_delete = requests.get, requests.put, requests.delete
    requests.get = fake_get
    requests.put = fake_put
    requests.delete = fake_delete
    try:
        # --- registrar pela primeira vez: GET (checa) + PUT (cria) ---
        chamadas.clear()
        name = svc.register_stream(
            ip="10.10.9.85", user="admin", password="segredo123",
            subtype=1, vendor="Intelbras", model="VIP-1230",
        )
        assert name == "cam_10_10_9_85_1", name
        assert [c["metodo"] for c in chamadas] == ["GET", "PUT"], chamadas
        assert "10.10.9.85:554/cam/realmonitor?channel=1&subtype=1" in estado_streams[name]["producers"][0]["url"]

        # --- registrar de novo, MESMA camera/qualidade/credencial: idempotente, SEM PUT ---
        chamadas.clear()
        svc.register_stream(
            ip="10.10.9.85", user="admin", password="segredo123",
            subtype=1, vendor="Intelbras", model="VIP-1230",
        )
        assert [c["metodo"] for c in chamadas] == ["GET"], (
            f"registro repetido com os mesmos dados nao deveria fazer PUT de novo: {chamadas}"
        )

        # --- mesma camera, credencial DIFERENTE: fonte mudou, registra de novo ---
        chamadas.clear()
        svc.register_stream(
            ip="10.10.9.85", user="admin", password="outra-senha",
            subtype=1, vendor="Intelbras", model="VIP-1230",
        )
        assert [c["metodo"] for c in chamadas] == ["GET", "PUT"], (
            f"credencial mudou, deveria ter re-registrado: {chamadas}"
        )

        # --- HD (subtype=0) e SD (subtype=1) da mesma camera sao streams DIFERENTES ---
        name_hd = svc.register_stream(
            ip="10.10.9.85", user="admin", password="outra-senha",
            subtype=0, vendor="Intelbras", model="VIP-1230",
        )
        assert name_hd == "cam_10_10_9_85_0", name_hd
        assert name_hd != name, "HD e SD tem que ser streams separados no go2rtc"

        # --- fabricante Hikvision usa caminho RTSP diferente (Streaming/Channels) ---
        name_hik = svc.register_stream(
            ip="10.10.9.90", user="admin", password="x",
            subtype=1, vendor="Hikvision", model="DS-2CD1021G0-I",
        )
        assert "/Streaming/Channels/102" in estado_streams[name_hik]["producers"][0]["url"], estado_streams[name_hik]

        # --- desregistrar: DELETE com o nome certo, idempotente (nao existir nao e erro) ---
        chamadas.clear()
        svc.unregister_stream(ip="10.10.9.85", subtype=1)
        assert len(chamadas) == 1 and chamadas[0]["metodo"] == "DELETE", chamadas
        assert chamadas[0]["params"] == {"name": "cam_10_10_9_85_1"}, chamadas
        assert "cam_10_10_9_85_1" not in estado_streams
        svc.unregister_stream(ip="10.10.9.85", subtype=1)  # de novo, nao pode quebrar

        # --- varredura remove so quem nao tem espectador (consumers vazio/None) ---
        estado_streams.clear()
        estado_streams["cam_1_2_3_4_1"] = {"producers": [{"url": "x"}], "consumers": None}
        estado_streams["cam_5_6_7_8_1"] = {"producers": [{"url": "y"}], "consumers": []}
        estado_streams["cam_9_9_9_9_1"] = {"producers": [{"url": "z"}], "consumers": [{"user_agent": "chrome"}]}
        estado_streams["outra_coisa_nao_camera"] = {"producers": [{"url": "w"}], "consumers": None}
        removidos = svc.reap_idle_streams()
        assert set(removidos) == {"cam_1_2_3_4_1", "cam_5_6_7_8_1"}, removidos
        assert "cam_9_9_9_9_1" in estado_streams, "stream com espectador nao pode ser removido"
        assert "outra_coisa_nao_camera" in estado_streams, "so mexe em streams cam_*, nao em outras entradas do go2rtc"

        # --- caminho RTSP por fabricante (migrado de maintenance.py, mesmo comportamento) ---
        assert svc._stream_rtsp_path_for_camera(vendor="Hikvision", model="DS-2CD1021G0-I", subtype=1) == "/Streaming/Channels/102"
        assert svc._stream_rtsp_path_for_camera(vendor="Intelbras", model="VIPC-1230-B-G2", subtype=1) == "/cam/realmonitor?channel=1&subtype=1"
        assert svc._stream_rtsp_path_for_camera(vendor="", model="IPC-B121H-L", subtype=0) == "/Streaming/Channels/101"
    finally:
        requests.get, requests.put, requests.delete = original_get, original_put, original_delete

    print("live_stream_service: registro idempotente, HD/SD separados, desregistro e varredura de ociosos ok")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Rodar o teste para confirmar que falha**

Run: `python scripts/sightops_live_stream_service_test.py`
Expected: `ModuleNotFoundError: No module named 'app.services.live_stream_service'`

- [ ] **Step 3: Criar o servico**

Crie `app/services/live_stream_service.py`:

```python
"""Fala com o go2rtc para registrar/desregistrar cameras no "ver ao vivo" e
limpar streams que ninguem mais esta assistindo.

Por que existe
--------------
Antes desta mudanca, o registro de stream (em app/api/endpoints/maintenance.py)
sempre apagava o stream anterior antes de recriar -- se duas pessoas abrissem
a mesma camera, a segunda derrubava a primeira. Alem disso nada nunca
desregistrava uma camera depois que a tela era fechada: toda camera ja
aberta ficava registrada para sempre no go2rtc, senha incluida (foi a causa
do vazamento de credenciais corrigido em 2026-08-29, commit 78e8d84 --
/go2rtc/api/streams publico devolvia RTSP com usuario/senha em texto puro).

Este modulo concentra essa logica: registro idempotente (so mexe no go2rtc
quando a fonte realmente mudou) e uma varredura periodica que remove
streams sem espectador.

Confirmado testando o go2rtc real em producao (versao 1.9.14): o parametro
`?name=` do `GET /api/streams` e ignorado -- sempre devolve a lista
INTEIRA. So o `DELETE /api/streams?name=X` respeita o filtro. Por isso o
registro idempotente busca a lista inteira e procura o nome no dicionario
em vez de tentar filtrar do lado do go2rtc.
"""
from __future__ import annotations

from typing import Any, Dict, List
from urllib.parse import quote

import requests

# Nome do servico go2rtc dentro da rede do docker-compose (ver
# deploy/go2rtc/go2rtc.yaml e docker-compose*.yml) -- endereco fixo, nao
# configuravel por variavel de ambiente, porque e infraestrutura interna do
# proprio compose, nao algo que varia por instalacao.
GO2RTC_BASE_URL = "http://go2rtc:1984"


def _stream_name(ip: str, subtype: int) -> str:
    st = 0 if int(subtype or 0) == 0 else 1
    return f"cam_{ip.replace('.', '_')}_{st}"


def _stream_rtsp_path_for_camera(*, vendor: str = "", model: str = "", subtype: int = 1) -> str:
    """Caminho RTSP por fabricante. Migrado de app/api/endpoints/maintenance.py
    (comportamento identico, coberto por scripts/sightops_stream_rtsp_path_test.py)."""
    st = 0 if int(subtype or 0) == 0 else 1
    vendor_l = str(vendor or "").strip().lower()
    model_l = str(model or "").strip().lower()
    is_intelbras = "intelbras" in vendor_l or "dahua" in vendor_l or model_l.startswith(("vip-", "vipc-", "vhd-"))
    is_hikvision = (
        not is_intelbras
        and (
            "hikvision" in vendor_l
            or "hilook" in vendor_l
            or model_l.startswith("ds-")
            or model_l.startswith("ds2")
            or model_l.startswith("ipc-")
        )
    )
    if is_hikvision:
        channel = "101" if st == 0 else "102"
        return f"/Streaming/Channels/{channel}"
    return f"/cam/realmonitor?channel=1&subtype={st}"


def _source_url(*, ip: str, user: str, password: str, vendor: str, model: str, subtype: int) -> str:
    user_q = quote(str(user or "admin"), safe="")
    pass_q = quote(str(password or ""), safe="")
    rtsp_path = _stream_rtsp_path_for_camera(vendor=vendor, model=model, subtype=subtype)
    rtsp_url = f"rtsp://{user_q}:{pass_q}@{ip}:554{rtsp_path}"
    # ffmpeg: transcodifica H.265 -> H.264 (navegador nao decodifica H.265 nativamente em MSE)
    return f"ffmpeg:{rtsp_url}#video=h264"


def register_stream(*, ip: str, user: str, password: str, subtype: int = 1, vendor: str = "", model: str = "") -> str:
    """Registra a camera no go2rtc se ainda nao estiver com a fonte certa.

    Idempotente: HD (subtype=0) e SD (subtype=1) sao streams separados no
    go2rtc. Chamar de novo com os mesmos dados nao repete o PUT nem
    interrompe quem ja esta assistindo -- era o bug do DELETE incondicional
    que existia antes desta mudanca.
    """
    st = 0 if int(subtype or 0) == 0 else 1
    name = _stream_name(ip, st)
    source = _source_url(ip=ip, user=user, password=password, vendor=vendor, model=model, subtype=st)

    resp = requests.get(f"{GO2RTC_BASE_URL}/api/streams", timeout=5)
    streams: Dict[str, Any] = {}
    if resp.status_code == 200:
        try:
            streams = resp.json() or {}
        except ValueError:
            streams = {}
    producers = (streams.get(name) or {}).get("producers") or []
    current_source = producers[0].get("url") if producers else None
    if current_source == source:
        return name

    put = requests.put(f"{GO2RTC_BASE_URL}/api/streams", params={"name": name, "src": source}, timeout=5)
    if put.status_code not in (200, 201, 204):
        raise RuntimeError(f"go2rtc recusou registrar {name}: HTTP {put.status_code}")
    return name


def unregister_stream(*, ip: str, subtype: int = 1) -> None:
    """Remove o stream do go2rtc. Nao existir mais nao e erro (idempotente)."""
    name = _stream_name(ip, subtype)
    requests.delete(f"{GO2RTC_BASE_URL}/api/streams", params={"name": name}, timeout=5)


def reap_idle_streams() -> List[str]:
    """Remove do go2rtc todo stream de camera (prefixo `cam_`) sem espectador.

    So mexe em streams criados por este modulo (prefixo `cam_`) -- nunca em
    outras entradas que porventura existam no go2rtc por outro motivo.
    Devolve os nomes removidos, para quem chamar poder logar.
    """
    resp = requests.get(f"{GO2RTC_BASE_URL}/api/streams", timeout=10)
    if resp.status_code != 200:
        return []
    try:
        streams: Dict[str, Any] = resp.json() or {}
    except ValueError:
        return []

    removed: List[str] = []
    for name, info in streams.items():
        if not name.startswith("cam_"):
            continue
        consumers = (info or {}).get("consumers")
        if consumers:
            continue
        requests.delete(f"{GO2RTC_BASE_URL}/api/streams", params={"name": name}, timeout=5)
        removed.append(name)
    return removed
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `python scripts/sightops_live_stream_service_test.py`
Expected: `live_stream_service: registro idempotente, HD/SD separados, desregistro e varredura de ociosos ok`

- [ ] **Step 5: Commit**

```bash
git add app/services/live_stream_service.py scripts/sightops_live_stream_service_test.py
git commit -m "feat(live-view): servico de registro idempotente e limpeza de streams do go2rtc"
```

---

### Task 2: Endpoints de registrar/desregistrar stream

**Files:**
- Modify: `app/api/endpoints/maintenance.py:1226-1283` (remove `_stream_rtsp_path_for_camera`, reescreve `maintenance_stream_register`, adiciona `maintenance_stream_unregister`)
- Modify: `scripts/sightops_stream_rtsp_path_test.py:8` (import muda de lugar)

**Interfaces:**
- Consumes: `register_stream`, `unregister_stream`, `_stream_rtsp_path_for_camera` de `app.services.live_stream_service` (Task 1).
- Produces: `POST /api/maintenance/stream_register/{ip}` (contrato inalterado: query `user, password, subtype, vendor, model` -> `{"ok": true, "stream_name": str}`), `POST /api/maintenance/stream_unregister/{ip}` (query `subtype` -> `{"ok": true}`) -- consumidos pela Task 6 (`frontend/js/liveStream.js`).

- [ ] **Step 1: Atualizar o teste existente para importar do novo lugar**

Em `scripts/sightops_stream_rtsp_path_test.py`, troque a linha 8:

```python
from app.api.endpoints.maintenance import _stream_rtsp_path_for_camera
```

por:

```python
from app.services.live_stream_service import _stream_rtsp_path_for_camera
```

- [ ] **Step 2: Rodar o teste para confirmar que falha (a funcao ainda esta em maintenance.py, nao em live_stream_service -- mas Task 1 ja moveu ela, entao na verdade so falha se Task 1 nao tiver rodado; como Task 1 ja esta commitada, rode e confirme que PASSA aqui, e so falhe visualmente conferindo que maintenance.py AINDA tem a funcao duplicada por enquanto)**

Run: `python scripts/sightops_stream_rtsp_path_test.py`
Expected: PASS (a funcao ja existe em `live_stream_service.py` desde a Task 1; este step so confirma que o import novo funciona antes de remover a copia antiga do maintenance.py no proximo step).

- [ ] **Step 3: Remover a funcao duplicada e reescrever os endpoints em maintenance.py**

Em `app/api/endpoints/maintenance.py`, adicione o import perto dos outros `from app.services...` (apos a linha `from app.services.ping_service import _do_ping_sync`, por volta da linha 28):

```python
from app.services.live_stream_service import register_stream, unregister_stream
```

Substitua o bloco inteiro de `_stream_rtsp_path_for_camera` ate o fim de `maintenance_stream_register` (linhas ~1226-1283) por:

```python
@router.post("/maintenance/stream_register/{ip}")
def maintenance_stream_register(
    ip: str,
    user: str = "admin",
    password: str = "",
    subtype: int = 1,
    vendor: str = "",
    model: str = "",
):
    """Registra a camera no go2rtc (idempotente) e devolve o nome do stream
    para o player MSE conectar em /go2rtc/api/ws?src=<stream_name>."""
    from fastapi.responses import JSONResponse

    try:
        stream_name = register_stream(ip=ip, user=user, password=password, subtype=subtype, vendor=vendor, model=model)
    except Exception as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=502)
    return {"ok": True, "stream_name": stream_name}


@router.post("/maintenance/stream_unregister/{ip}")
def maintenance_stream_unregister(ip: str, subtype: int = 1):
    """Desregistra a camera do go2rtc (chamado ao fechar a tela de live view;
    a limpeza automatica periodica cobre o caso de aba fechada sem aviso)."""
    unregister_stream(ip=ip, subtype=subtype)
    return {"ok": True}
```

- [ ] **Step 4: Rodar os dois testes e confirmar que passam**

Run: `python scripts/sightops_stream_rtsp_path_test.py && python scripts/sightops_live_stream_service_test.py`
Expected: ambos PASS.

- [ ] **Step 5: Confirmar que o app ainda sobe (import correto, sem erro de sintaxe)**

Run: `python -c "import app.main"`
Expected: sem excecao.

- [ ] **Step 6: Commit**

```bash
git add app/api/endpoints/maintenance.py scripts/sightops_stream_rtsp_path_test.py
git commit -m "refactor(live-view): endpoints de stream delegam pro live_stream_service, adiciona unregister"
```

---

### Task 3: Limpeza automatica de streams ociosos (tarefa de fundo)

**Files:**
- Modify: `app/main.py` (nova funcao de loop + wiring em startup/shutdown)

**Interfaces:**
- Consumes: `reap_idle_streams()` de `app.services.live_stream_service` (Task 1).

- [ ] **Step 1: Adicionar a funcao de loop**

Em `app/main.py`, logo apos o fim de `_access_control_sync_loop` (apos a linha `await asyncio.sleep(interval)` que fecha essa funcao, por volta da linha 301, antes do `@app.get("/api/scripts/zabbix/status-sync/auto")`), adicione:

```python
async def _live_stream_cleanup_loop() -> None:
    from app.services.live_stream_service import reap_idle_streams

    interval = 300  # 5 minutos
    await asyncio.sleep(30)
    while True:
        try:
            removed = await asyncio.to_thread(reap_idle_streams)
            app.state.live_stream_cleanup_last = {"ok": True, "interval_s": interval, "removed": removed}
            if removed:
                logger.info("live stream cleanup: removidos %s", removed)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            app.state.live_stream_cleanup_last = {"ok": False, "interval_s": interval, "error": str(exc)}
            logger.exception("live stream cleanup loop failed")
        await asyncio.sleep(interval)
```

- [ ] **Step 2: Disparar a tarefa no startup**

No bloco `@app.on_event("startup")` (linha ~317-332), apos a linha `app.state.access_control_sync_task = asyncio.create_task(...)`, adicione:

```python
    app.state.live_stream_cleanup_task = asyncio.create_task(
        _live_stream_cleanup_loop(), name="live-stream-cleanup-loop"
    )
```

- [ ] **Step 3: Cancelar a tarefa no shutdown**

No bloco `@app.on_event("shutdown")` (linha ~335-347), adicione `"live_stream_cleanup_task"` a tupla de nomes:

```python
    for task_name in (
        "zabbix_status_task",
        "monitoring_refresh_task",
        "olt_telemetry_task",
        "access_control_sync_task",
        "live_stream_cleanup_task",
    ):
```

- [ ] **Step 4: Confirmar que o app sobe e a tarefa e criada**

Run:
```bash
python - <<'EOF'
import asyncio
from app.main import app, startup_events, shutdown_events

async def check():
    await startup_events()
    task = app.state.live_stream_cleanup_task
    assert task is not None and not task.done(), "tarefa deveria estar rodando"
    await shutdown_events()
    print("live-stream-cleanup-loop criada e cancelada corretamente")

asyncio.run(check())
EOF
```
Expected: `live-stream-cleanup-loop criada e cancelada corretamente` (a primeira rodada do loop so acontece apos 30s de sleep, entao este teste so confirma que a tarefa foi criada/cancelada sem erro, nao que `reap_idle_streams` foi chamada -- isso ja esta coberto pelo teste da Task 1).

- [ ] **Step 5: Commit**

```bash
git add app/main.py
git commit -m "feat(live-view): tarefa periodica remove streams ociosos do go2rtc a cada 5min"
```

---

### Task 4: Remover o pipeline MJPEG antigo (morto, sem uso no frontend)

**Files:**
- Delete: `app/api/endpoints/live.py`
- Delete: `app/services/live_mjpeg_service.py`
- Modify: `app/api/endpoints/__init__.py:5` (remove o import)
- Modify: `app/main.py:34,99` (remove `live_router` da lista de import e do `include_router`)
- Modify: `app/core/security.py:33-34,76` (remove as 3 entradas)

**Interfaces:**
- Nao produz nem consome nada de outras tasks -- remocao pura, sem dependencia.

- [ ] **Step 1: Confirmar mais uma vez que nada usa isso (rede de seguranca antes de apagar)**

Run:
```bash
grep -rn "api/live/" frontend/ app/ --include="*.js" --include="*.py" | grep -v "app/api/endpoints/live.py" | grep -v "app/core/security.py"
```
Expected: nenhuma saida (confirma que so `live.py` e `security.py`, que ja estao no escopo desta task, mencionam essas rotas).

- [ ] **Step 2: Apagar os dois arquivos**

```bash
git rm app/api/endpoints/live.py app/services/live_mjpeg_service.py
```

- [ ] **Step 3: Remover o import em `app/api/endpoints/__init__.py`**

Remova a linha `from .live import router as live_router` (linha 5).

- [ ] **Step 4: Remover as referencias em `app/main.py`**

Remova `live_router,` da lista de imports (linha 34, dentro do bloco `from app.api.endpoints import (...)`) e remova a linha `app.include_router(live_router)` (linha 99).

- [ ] **Step 5: Remover as 3 entradas em `app/core/security.py`**

Remova as linhas 33-34 (dentro de `self._public_paths`):
```python
            "/api/live/jpeg",
            "/api/live/mjpeg",
```
(mantenha `/api/system/health/live` na linha 31 -- e outra feature, health check, nao mexer).

Remova a linha 76 (dentro de `self._role_rules`):
```python
            (("POST",), "/api/live/session", "operator"),
```

- [ ] **Step 6: Confirmar que o app ainda sobe**

Run: `python -c "import app.main"`
Expected: sem excecao.

- [ ] **Step 7: Rodar a suite de testes que toca autenticacao/rotas, se existir um teste rapido para security.py**

Run:
```bash
python -c "
from app.core.security import ApiAuthMiddleware
mw = ApiAuthMiddleware.__new__(ApiAuthMiddleware)
mw.settings = None
mw._public_paths = {
    '/api/auth/status', '/api/auth/login', '/api/auth/bootstrap-admin',
    '/api/system/health/live', '/api/system/health/ready',
    '/api/windows/agent/report',
}
assert '/api/live/jpeg' not in mw._public_paths
assert '/api/live/mjpeg' not in mw._public_paths
assert '/api/system/health/live' in mw._public_paths
print('security.py: rotas mortas removidas, health/live preservada')
"
```
Expected: `security.py: rotas mortas removidas, health/live preservada` (este check e so uma confirmacao manual da edicao, ja que o projeto nao tem um teste automatizado dedicado a `security.py` hoje).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(live-view): remove pipeline MJPEG antigo (sem uso no frontend)

live.py/live_mjpeg_service.py foram substituidos pelo go2rtc ha meses;
confirmado que nenhuma tela chama /api/live/* hoje. Parte da consolidacao
do "ver ao vivo" num pipeline so (MSE via go2rtc).
EOF
)"
```

---

### Task 5: go2rtc no docker-compose (config versionada, nginx aponta pro servico)

**Files:**
- Create: `deploy/go2rtc/go2rtc.yaml`
- Modify: `docker-compose.production.yml`
- Modify: `docker-compose.yml`
- Modify: `deploy/nginx/default.conf:84` (endereco do proxy)

**Interfaces:**
- Nenhuma interface de codigo -- so infraestrutura. O nome do servico (`go2rtc`, porta `1984`) precisa bater com `GO2RTC_BASE_URL` em `app/services/live_stream_service.py` (Task 1, ja escrito com esse nome) e com o proxy do nginx.

- [ ] **Step 1: Criar a config versionada do go2rtc**

Crie `deploy/go2rtc/go2rtc.yaml`:

```yaml
# Config do go2rtc para o modulo SightOps de "ver ao vivo".
#
# streams comeca vazio de proposito: cada camera e registrada em tempo real
# via API (app/services/live_stream_service.py) quando alguem abre o "ver
# ao vivo", nunca pre-cadastrada aqui -- assim este arquivo nunca acumula
# credencial de cliente nenhum, mesmo com o tempo.
api:
  listen: ":1984"

log:
  level: warn

streams: {}
```

- [ ] **Step 2: Adicionar o servico em `docker-compose.production.yml`**

Apos o servico `sightops-prod-postgres` (antes de `zabbix-prod-postgres`, por volta da linha 87), adicione:

```yaml
  go2rtc:
    image: alexxit/go2rtc:1.9.14
    container_name: sightops-prod-go2rtc
    volumes:
      - ./deploy/go2rtc/go2rtc.yaml:/config/go2rtc.yaml:ro
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:1984/api/streams"]
      interval: 20s
      timeout: 5s
      retries: 5
      start_period: 15s
    networks:
      - sightops-prod
    restart: unless-stopped
```

E adicione uma dependencia no `sightops-prod-nginx` (que fala com o go2rtc via `/go2rtc/api/ws`) -- no bloco `depends_on:` do servico `sightops-prod-nginx` (linha ~49-51), acrescente:

```yaml
    depends_on:
      cam-snapshot-api:
        condition: service_healthy
      go2rtc:
        condition: service_started
```

- [ ] **Step 3: Adicionar o servico em `docker-compose.yml` (dev local)**

Apos o servico `nginx` (antes de `postgres`, por volta da linha 55), adicione:

```yaml
  go2rtc:
    image: alexxit/go2rtc:1.9.14
    container_name: go2rtc
    volumes:
      - ./deploy/go2rtc/go2rtc.yaml:/config/go2rtc.yaml:ro
    restart: unless-stopped
```

- [ ] **Step 4: Apontar o nginx pro nome do servico em vez do IP fixo**

Em `deploy/nginx/default.conf`, dentro do location `/go2rtc/api/ws` (linhas ~80-95, corrigido na sessao anterior para bloquear o resto da API), troque:

```nginx
        proxy_pass http://172.28.0.1:1984/api/ws;
```

por:

```nginx
        proxy_pass http://go2rtc:1984/api/ws;
```

- [ ] **Step 5: Validar a sintaxe dos compose files**

Run:
```bash
docker compose -f docker-compose.production.yml config --quiet
docker compose -f docker-compose.yml config --quiet
```
Expected: sem erro (comando muda (sem saida) para "quiet" bem-sucedido).

- [ ] **Step 6: Validar a sintaxe do nginx (sem subir de verdade -- so o parser)**

Run:
```bash
docker run --rm -v "$(pwd)/deploy/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine nginx -t
```
Expected: `nginx: configuration file /etc/nginx/nginx.conf test is successful` (o `upstream sightops_api` e outros hosts referenciados no arquivo nao precisam resolver de verdade para o teste de sintaxe passar -- `nginx -t` so valida a gramatica, nao a conectividade).

- [ ] **Step 7: Commit**

```bash
git add deploy/go2rtc/go2rtc.yaml docker-compose.production.yml docker-compose.yml deploy/nginx/default.conf
git commit -m "feat(live-view): go2rtc entra no docker-compose, config versionada"
```

---

### Task 6: Client MSE do "ver ao vivo" (frontend/js/liveStream.js)

**Files:**
- Create: `frontend/js/liveStream.js`

**Interfaces:**
- Consumes: `POST /api/maintenance/stream_register/{ip}` e `POST /api/maintenance/stream_unregister/{ip}` (Task 2); a funcao global `api(url, options)` ja existente em `frontend/js/core.js` (usada em todo o frontend para chamadas `fetch` autenticadas).
- Produces (usado pelas Tasks 7 e 8): `mountLiveStream(videoEl, opts) -> {setSubtype(novoSubtype), stop()}`, descrito no Step 3 abaixo.

- [ ] **Step 1: Confirmar a assinatura da funcao `api()` que ja existe no projeto**

Run: `grep -n "^function api\|^async function api" frontend/js/core.js`
Expected: uma linha mostrando `async function api(url, options = {})` (ou assinatura equivalente) -- usada exatamente do mesmo jeito que `cameras.js`/`maintenance.js` ja usam hoje (`await api(url, { method: 'POST' })`, devolvendo o corpo JSON ja parseado).

- [ ] **Step 2: Adicionar o script na pagina, antes de `cameras.js`**

Em `frontend/index.html`, na lista de `<script>` perto do fim do `<body>` (linha ~6068), adicione ANTES da linha `<script src="js/cameras.js?v=179"></script>`:

```html
  <script src="js/liveStream.js?v=1"></script>
```

- [ ] **Step 3: Criar `frontend/js/liveStream.js`**

```javascript
// Player de "ver ao vivo": fala MSE (Media Source Extensions) direto com o
// go2rtc pelo WebSocket que ele ja expoe (/go2rtc/api/ws), sem WebRTC, sem
// STUN/TURN -- so essa conexao WebSocket precisa passar, o que ja e
// garantido sempre que o proprio site carrega.
//
// Protocolo confirmado lendo o client oficial do go2rtc (video-rtc.js,
// versao 1.6.0, servido pelo proprio container em producao): depois que o
// WebSocket abre, cria-se um MediaSource; quando ele fica pronto
// (evento sourceopen), manda-se {type:'mse', value:<codecs suportados>};
// o go2rtc responde com o mesmo formato indicando o codec escolhido, e a
// partir dai manda fragmentos MP4 BINARIOS direto pelo WebSocket, que vao
// para dentro de um SourceBuffer.
//
// Usado tanto pelo painel de detalhe de camera (cameras.js) quanto pelo
// modal de manutencao (maintenance.js) -- antes cada um tinha sua propria
// copia da sinalizacao WebRTC.

const LIVE_STREAM_CODECS = [
  'avc1.640029', // H.264 high 4.1
  'avc1.64002A', // H.264 high 4.2
  'avc1.640033', // H.264 high 5.1
];

function _liveStreamName(ip, subtype) {
  const st = Number(subtype) === 0 ? 0 : 1;
  return `cam_${ip.replace(/\./g, '_')}_${st}`;
}

function _liveStreamCodecs() {
  return LIVE_STREAM_CODECS.filter(c => {
    try { return MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`); }
    catch (e) { return false; }
  }).join();
}

function _liveStreamConcat(buffers) {
  const total = buffers.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    out.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return out;
}

async function _liveStreamRegister(ip, user, pass, subtype, hint) {
  const params = new URLSearchParams({
    user: user || 'admin',
    password: pass || '',
    subtype: String(subtype),
    vendor: hint?.vendor || '',
    model: hint?.model || '',
  });
  const resp = await api(`/api/maintenance/stream_register/${ip}?${params.toString()}`, { method: 'POST' });
  if (!resp || !resp.ok) throw new Error('Falha ao registrar stream');
  return resp.stream_name || _liveStreamName(ip, subtype);
}

function _liveStreamUnregister(ip, subtype) {
  if (!ip) return;
  const params = new URLSearchParams({ subtype: String(subtype) });
  // best-effort: nao trava o fechamento da tela esperando resposta
  api(`/api/maintenance/stream_unregister/${ip}?${params.toString()}`, { method: 'POST' }).catch(() => {});
}

/**
 * Monta o player de "ver ao vivo" num <video> ja existente na tela.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {{ip: string, user: string, pass: string, subtype?: number, vendor?: string, model?: string, onStatus?: (texto: string) => void}} opts
 * @returns {{setSubtype: (novoSubtype: number) => void, stop: () => void}}
 */
function mountLiveStream(videoEl, opts) {
  const RECONNECT_MS = 4000;
  const user = opts.user || 'admin';
  const pass = opts.pass || '';
  const hint = { vendor: opts.vendor || '', model: opts.model || '' };
  const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};

  let ip = opts.ip;
  let subtype = Number(opts.subtype) === 0 ? 0 : 1;
  let generation = 0; // incrementa a cada connect(); descarta eventos de tentativas antigas
  let ws = null;
  let reconnectTimer = null;
  let stopped = false;

  function teardown() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    try { videoEl.pause(); } catch (e) {}
    videoEl.removeAttribute('src');
    videoEl.load();
  }

  async function connect() {
    const myGen = ++generation;
    teardown();
    if (stopped) return;
    onStatus('Conectando...');

    let streamName;
    try {
      streamName = await _liveStreamRegister(ip, user, pass, subtype, hint);
    } catch (e) {
      if (myGen !== generation || stopped) return;
      onStatus('Erro ao registrar stream');
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
      return;
    }
    if (myGen !== generation || stopped) return;

    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${wsProto}://${location.host}/go2rtc/api/ws?src=${streamName}`);
    socket.binaryType = 'arraybuffer';
    ws = socket;

    let ms = null;
    let sourceBuffer = null;
    let pending = [];

    function onSourceBufferUpdateEnd() {
      if (!sourceBuffer.updating && pending.length) {
        const merged = _liveStreamConcat(pending);
        pending = [];
        try { sourceBuffer.appendBuffer(merged); } catch (e) { /* ignora, o proximo frame corrige */ }
      }
      if (!sourceBuffer.updating && sourceBuffer.buffered && sourceBuffer.buffered.length) {
        const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
        const start0 = sourceBuffer.buffered.start(0);
        const start = end - 5;
        if (start > start0) {
          sourceBuffer.remove(start0, start);
          ms.setLiveSeekableRange(start, end);
        }
        if (videoEl.currentTime < start) videoEl.currentTime = start;
        const gap = end - videoEl.currentTime;
        videoEl.playbackRate = gap > 0.1 ? Math.min(gap, 2) : 1;
      }
    }

    socket.onopen = () => {
      if (myGen !== generation) return;
      onStatus('Aguardando video...');

      ms = new MediaSource();
      videoEl.src = URL.createObjectURL(ms);
      ms.addEventListener('sourceopen', () => {
        if (myGen !== generation) return;
        URL.revokeObjectURL(videoEl.src);
        socket.send(JSON.stringify({ type: 'mse', value: _liveStreamCodecs() }));
      }, { once: true });
    };

    socket.onmessage = (ev) => {
      if (myGen !== generation) return;

      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'mse') {
          sourceBuffer = ms.addSourceBuffer(msg.value);
          sourceBuffer.mode = 'segments';
          sourceBuffer.addEventListener('updateend', onSourceBufferUpdateEnd);
          onStatus('');
          videoEl.play().catch(() => {});
        } else if (msg.type === 'error') {
          onStatus('Erro go2rtc: ' + msg.value);
        }
        return;
      }

      // fragmento MP4 binario
      if (!sourceBuffer) return; // chegou antes do handshake 'mse' terminar, descarta
      if (sourceBuffer.updating || pending.length) {
        pending.push(ev.data);
      } else {
        try { sourceBuffer.appendBuffer(ev.data); } catch (e) { /* ignora, o proximo frame corrige */ }
      }
    };

    socket.onclose = () => {
      if (myGen !== generation || stopped) return;
      onStatus('Reconectando...');
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
    };

    socket.onerror = () => {
      if (myGen !== generation) return;
      onStatus('Erro de conexao');
    };
  }

  connect();

  return {
    setSubtype(novoSubtype) {
      const st = Number(novoSubtype) === 0 ? 0 : 1;
      if (st === subtype) return;
      const oldIp = ip, oldSubtype = subtype;
      subtype = st;
      connect();
      _liveStreamUnregister(oldIp, oldSubtype);
    },
    stop() {
      const lastIp = ip, lastSubtype = subtype;
      stopped = true;
      generation++;
      teardown();
      _liveStreamUnregister(lastIp, lastSubtype);
    },
  };
}
```

Este protocolo (handshake `{type:'mse', value:codecs}`, buffer com flush no `updateend`, janela de ~5s com `playbackRate` ajustado para ficar perto do "ao vivo") replica fielmente a logica do metodo `onmse()` do `video-rtc.js` oficial do go2rtc, direcionada a um `<video>` ja existente na pagina em vez de um custom element novo (este projeto nao usa web components em nenhum outro lugar do frontend -- manter o padrao de manipulacao direta de DOM ja usado em `cameras.js`/`maintenance.js`).

- [ ] **Step 4: Teste manual no navegador (nao ha framework de teste JS neste projeto -- API de video so se valida rodando de verdade)**

1. Suba o ambiente de dev: `docker compose up -d --build`.
2. Abra o DevTools do navegador, va para a tela de Câmeras, abra o painel de qualquer câmera com IP/usuário/senha válidos (uma câmera real na rede local ou de teste).
3. No Console, rode diretamente para testar o modulo isolado, sem esperar a Task 7/8:
   ```js
   const v = document.createElement('video');
   v.autoplay = true; v.muted = true; v.style.width = '480px';
   document.body.prepend(v);
   const h = mountLiveStream(v, {
     ip: 'SEU_IP_DE_TESTE', user: 'admin', pass: 'SUA_SENHA', subtype: 1,
     onStatus: (t) => console.log('status:', t || '(conectado)'),
   });
   ```
4. Espera-se ver o vídeo aparecer em poucos segundos, sem travar. Rode `h.setSubtype(0)` no console e confirme que troca para a qualidade principal sem recarregar a página. Rode `h.stop()` e confirme, na aba Network do DevTools, que uma chamada `POST /api/maintenance/stream_unregister/SEU_IP_DE_TESTE` foi feita.

Expected: vídeo ao vivo tocando, troca de qualidade funcionando, desregistro confirmado na aba Network.

- [ ] **Step 5: Commit**

```bash
git add frontend/js/liveStream.js frontend/index.html
git commit -m "feat(live-view): client MSE unico para o ver ao vivo (frontend/js/liveStream.js)"
```

---

### Task 7: Integrar o painel de câmera (cameras.js) com o novo player, adicionar HD/SD

**Files:**
- Modify: `frontend/js/cameras.js:2096-2336` (substitui `startCamPanelLive`/`closeCamPanelLive`, remove `_cpRtcPeer`/`_cpLiveIp`)
- Modify: `frontend/index.html` (botão de qualidade no painel; bump de versão do `cameras.js`)
- Modify: `frontend/js/bootstrap.js` (listener do novo botão)
- Modify: `frontend/styles.css` (estilo do novo botão)

**Interfaces:**
- Consumes: `mountLiveStream` de `frontend/js/liveStream.js` (Task 6).

- [ ] **Step 1: Adicionar o botão de qualidade no HTML**

Em `frontend/index.html`, dentro de `#cpInlineLive` (linhas ~434-460), logo após o botão `cpLiveFullscreen` (linhas 457-459), adicione:

```html
                <button id="cpLiveQuality" class="cam-live-quality" type="button" title="Trocar qualidade (HD/SD)">
                  <i data-lucide="layers"></i> <span>SD</span>
                </button>
```

- [ ] **Step 2: Estilizar o botão**

Em `frontend/styles.css`, logo após a regra `.cam-live-fullscreen svg { width: 16px; height: 16px; }` (linha ~4336), adicione:

```css
.cam-live-quality {
  position: absolute;
  left: 10px;
  bottom: 10px;
  z-index: 5;
  min-width: 34px;
  height: 34px;
  padding: 0 10px;
  border: 0;
  border-radius: 9px;
  background: rgba(255,255,255,.14);
  color: #fff;
  display: none;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.cam-live-quality svg { width: 14px; height: 14px; }
.cam-inline-live.playing .cam-live-quality {
  display: flex;
}
```

- [ ] **Step 3: Substituir a logica de conexao em `cameras.js`**

Em `frontend/js/cameras.js`, substitua as linhas 2118-2119 (`let _cpRtcPeer = null; let _cpLiveIp = '';`) por:

```javascript
let _cpLiveHandle = null;
let _cpLiveSubtype = 1;
```

Substitua `closeCamPanelLive()` (linhas 2121-2132) por:

```javascript
function closeCamPanelLive() {
  if (_cpLiveHandle) { _cpLiveHandle.stop(); _cpLiveHandle = null; }
  const video = document.getElementById('cpLiveVideo');
  if (video) { video.srcObject = null; video.classList.add('hidden'); }
  const live = document.getElementById('cpInlineLive');
  live?.classList.remove('playing', 'mobile-fullscreen');
  live?.classList.add('hidden');
  document.body.classList.remove('cam-live-lock');
  const status = document.getElementById('cpLiveStatus');
  if (status) status.classList.add('hidden');
}
```

Substitua a função inteira `startCamPanelLive()` (linhas 2223-2336) por:

```javascript
async function startCamPanelLive() {
  if (!_invOltActive?.ip) return;
  const ip = _invOltActive.ip;
  const user = document.getElementById('cpLiveUser')?.value.trim() || 'admin';
  const pass = document.getElementById('cpLivePass')?.value || '';
  if (!pass) {
    showToast('Informe a senha da camera para ver ao vivo.', true);
    document.getElementById('cpLivePass')?.focus();
    return;
  }

  const auth = document.getElementById('cpLiveAuth');
  const status = document.getElementById('cpLiveStatus');
  const statusText = status?.querySelector('span');
  const video = document.getElementById('cpLiveVideo');
  if (!auth || !status || !video) return;

  if (_cpLiveHandle) { _cpLiveHandle.stop(); _cpLiveHandle = null; }
  auth.style.display = 'none';
  status.classList.remove('hidden');
  if (statusText) statusText.textContent = 'Conectando...';
  video.srcObject = null;
  video.classList.remove('hidden');

  const hint = cameraStreamHint(ip, _invOltActive);
  _cpLiveHandle = mountLiveStream(video, {
    ip, user, pass,
    subtype: _cpLiveSubtype,
    vendor: hint.vendor,
    model: hint.model,
    onStatus: (texto) => {
      if (texto) {
        if (statusText) statusText.textContent = texto;
        status.classList.remove('hidden');
      } else {
        status.classList.add('hidden');
        document.getElementById('cpInlineLive')?.classList.add('playing');
      }
    },
  });
}

function toggleCamPanelLiveQuality() {
  if (!_cpLiveHandle) return;
  _cpLiveSubtype = _cpLiveSubtype === 0 ? 1 : 0;
  _cpLiveHandle.setSubtype(_cpLiveSubtype);
  const label = document.querySelector('#cpLiveQuality span');
  if (label) label.textContent = _cpLiveSubtype === 0 ? 'HD' : 'SD';
}
```

Em `openCamPanelLive()` (linhas 2096-2116), reinicie a qualidade para SD toda vez que o painel abre (evita que uma escolha de HD de uma câmera "vaze" para a próxima). Logo após a linha `video.srcObject = null;` (linha 2107), adicione:

```javascript
  _cpLiveSubtype = 1;
  const qualityLabel = document.querySelector('#cpLiveQuality span');
  if (qualityLabel) qualityLabel.textContent = 'SD';
```

- [ ] **Step 4: Ligar o botão em `bootstrap.js`**

Em `frontend/js/bootstrap.js`, logo após o bloco do `cpLiveFullscreen` (linhas 413-416), adicione:

```javascript
  document.getElementById('cpLiveQuality')?.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleCamPanelLiveQuality();
  });
```

- [ ] **Step 5: Bump de versão dos assets alterados**

Em `frontend/index.html`, atualize as tags de versão (nunca reusar um número já usado):
- `<script src="js/cameras.js?v=179">` → `<script src="js/cameras.js?v=180">`
- `<link rel="stylesheet" href="styles.css?v=261">` → `href="styles.css?v=262">`
- `<script src="js/bootstrap.js?v=191">` → `<script src="js/bootstrap.js?v=192">`

- [ ] **Step 6: Teste manual no navegador**

1. Suba o ambiente: `docker compose up -d --build`.
2. Abra a tela de Câmeras, clique numa câmera, clique em "Ver ao vivo", informe usuário/senha reais.
3. Confirme: vídeo aparece em SD por padrão; o botão de qualidade (ícone de camadas) aparece perto do botão de tela cheia; clicar nele troca para HD (rótulo muda para "HD") sem travar nem recarregar a página; fechar o painel (botão X) e reabrir reinicia em SD.
4. Na aba Network do DevTools, confirme uma chamada `POST /api/maintenance/stream_unregister/<ip>` ao fechar o painel.

Expected: fluxo completo funcionando, sem erros no console.

- [ ] **Step 7: Commit**

```bash
git add frontend/js/cameras.js frontend/js/bootstrap.js frontend/styles.css frontend/index.html
git commit -m "feat(live-view): painel de camera usa o player MSE unico, adiciona toggle HD/SD"
```

---

### Task 8: Integrar o modal de manutenção (maintenance.js) com o novo player

**Files:**
- Modify: `frontend/js/maintenance.js:154-374` (substitui `_startWebRTC`, `openMntStream`, `closeMntStream`; reaproveita `_mntStreamToggleQuality` já existente)
- Modify: `frontend/index.html` (bump de versão do `maintenance.js`)

**Interfaces:**
- Consumes: `mountLiveStream` de `frontend/js/liveStream.js` (Task 6).

- [ ] **Step 1: Substituir as variáveis de estado do WebRTC**

Em `frontend/js/maintenance.js`, substitua a linha `let _rtcPeer = null;` (linha 160) por:

```javascript
let _mntLiveHandle = null;
```

- [ ] **Step 2: Substituir `_startWebRTC` por uma chamada ao player único**

Substitua a função inteira `_startWebRTC(ip, user, pass, subtype)` (linhas 206-305) por:

```javascript
function _startLiveView(ip, user, pass, subtype) {
  const video       = document.getElementById('mntStreamVideo');
  const placeholder = document.getElementById('mntStreamPlaceholder');
  const statusEl    = document.getElementById('mntStreamStatus');

  if (_mntLiveHandle) { _mntLiveHandle.stop(); _mntLiveHandle = null; }
  video.srcObject = null;
  video.classList.add('hidden');
  video.muted = true;
  if (placeholder) placeholder.style.display = '';
  if (statusEl) statusEl.textContent = 'Conectando...';

  const hint = cameraStreamHint(ip);
  _mntLiveHandle = mountLiveStream(video, {
    ip, user, pass, subtype,
    vendor: hint.vendor,
    model: hint.model,
    onStatus: (texto) => {
      if (texto) {
        if (statusEl) statusEl.textContent = texto;
      } else {
        video.muted = _mntStreamMuted;
        video.classList.remove('hidden');
        if (placeholder) placeholder.style.display = 'none';
        if (statusEl) statusEl.textContent = '';
      }
    },
  });
}
```

- [ ] **Step 3: Atualizar `openMntStream` para chamar a nova função**

Em `openMntStream(ip, titulo)` (linhas 177-204), troque a última linha, de:

```javascript
  _startWebRTC(ip, _mntStreamUser, _mntStreamPass, _mntStreamSubtype);
```

para:

```javascript
  _startLiveView(ip, _mntStreamUser, _mntStreamPass, _mntStreamSubtype);
```

- [ ] **Step 4: Atualizar `closeMntStream` para desregistrar**

Substitua `closeMntStream()` (linhas 307-317) por:

```javascript
function closeMntStream() {
  clearInterval(_mntClockTimer);
  _mntClockTimer = null;
  if (_mntLiveHandle) { _mntLiveHandle.stop(); _mntLiveHandle = null; }
  _mntStreamIp = '';
  const video = document.getElementById('mntStreamVideo');
  if (video) { video.srcObject = null; video.classList.add('hidden'); }
  const placeholder = document.getElementById('mntStreamPlaceholder');
  if (placeholder) placeholder.style.display = '';
  document.getElementById('modalMntStream').classList.add('hidden');
}
```

- [ ] **Step 5: Atualizar `_mntStreamToggleQuality` para usar o handle (já existia, só troca a chamada final)**

Em `_mntStreamToggleQuality()` (linhas 369-374), troque a última linha, de:

```javascript
  _startWebRTC(_mntStreamIp, _mntStreamUser, _mntStreamPass, _mntStreamSubtype);
```

para:

```javascript
  if (_mntLiveHandle) _mntLiveHandle.setSubtype(_mntStreamSubtype);
```

(Isso troca a qualidade sem recriar o registro/handle inteiro -- `setSubtype` já cuida de registrar o novo stream e desregistrar o antigo.)

- [ ] **Step 6: Bump de versão**

Em `frontend/index.html`, atualize `<script src="js/maintenance.js?v=145">` para `?v=146` (o número exato depende do que a Task 7 já tiver deixado nos outros arquivos -- confira o `index.html` atual antes de escolher o número, nunca reusar um já usado).

- [ ] **Step 7: Teste manual no navegador**

1. Suba o ambiente: `docker compose up -d --build`.
2. Vá em Manutenção → Câmeras, clique no ícone de play de qualquer câmera para abrir o modal de stream.
3. Confirme: vídeo conecta; o botão de qualidade já existente (rótulo "Sub-stream"/"Principal") continua funcionando, agora via o player novo; fechar o modal (X) dispara `POST /api/maintenance/stream_unregister/<ip>` (confira na aba Network).
4. Abra a MESMA câmera em duas abas do navegador ao mesmo tempo -- confirme que as duas continuam tocando (o bug antigo derrubava uma quando a outra registrava).

Expected: modal funcionando como antes, troca de qualidade ok, duas abas simultâneas não se derrubam mais.

- [ ] **Step 8: Commit**

```bash
git add frontend/js/maintenance.js frontend/index.html
git commit -m "feat(live-view): modal de manutencao usa o player MSE unico"
```

---

## Nota final (não é uma task de código)

O deploy real em produção — subir o serviço `go2rtc` no servidor via compose, aplicar o novo `default.conf`, e aposentar o container `go2rtc` atual (que roda fora do compose, em `/opt/sightops/go2rtc/`, com ~150 streams acumulados de credenciais de clientes) — fica para quando o usuário pedir explicitamente, seguindo o padrão de deploy manual já usado nesta sessão (build de imagem, troca de container, verificação por SSH). Este plano cobre só código e configuração versionada no repositório.

No dia do deploy, depois de trocar o `default.conf`, revalidar de fora (como já foi feito em 2026-08-29 ao corrigir o vazamento) que `/go2rtc/api/streams` continua bloqueado (403) e `/go2rtc/api/ws` continua respondendo — o endereço do proxy muda de IP fixo para nome de serviço nesta mudança, então vale confirmar que a regra de bloqueio sobreviveu à troca.
