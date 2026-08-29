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


def _stream_registered_with_source(name: str, source: str) -> bool:
    """True se o go2rtc ja tem esse stream registrado com essa fonte exata."""
    resp = requests.get(f"{GO2RTC_BASE_URL}/api/streams", timeout=5)
    if resp.status_code != 200:
        return False
    try:
        streams: Dict[str, Any] = resp.json() or {}
    except ValueError:
        return False
    producers = (streams.get(name) or {}).get("producers") or []
    current_source = producers[0].get("url") if producers else None
    return current_source == source


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

    if _stream_registered_with_source(name, source):
        return name

    put = requests.put(f"{GO2RTC_BASE_URL}/api/streams", params={"name": name, "src": source}, timeout=5)
    if put.status_code not in (200, 201, 204):
        # go2rtc 1.9.14 tem um bug conhecido: em parte dos registros de
        # stream genuinamente novo, ele CRIA o stream (confirmado testando
        # em producao) mas devolve HTTP 400 com um erro de YAML interno
        # ("did not find expected key") de um round-trip que roda DEPOIS de
        # ja ter salvo. Sem essa checagem, toda primeira abertura de cada
        # camera nova falhava e so funcionava ~4s depois, no reconnect
        # automatico do frontend -- confirmar pelo estado real antes de
        # desistir.
        if _stream_registered_with_source(name, source):
            return name
        raise RuntimeError(f"go2rtc recusou registrar {name}: HTTP {put.status_code} {put.text[:200]}")
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
