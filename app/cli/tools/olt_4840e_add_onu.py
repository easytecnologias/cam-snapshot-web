#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Provisionamento de ONU na OLT Intelbras 4840E (EPON), via a mesma sessao
SSH interativa que olt_4840e_collect_macs.py ja usa (importa os helpers de
conexao de la -- _open_shell/_ensure_logged_in/_ensure_enable/_cli/_norm_mac
-- em vez de duplicar, esse arquivo NUNCA e tocado por este driver).

Sequencias de comando validadas contra a OLT real (cliente RADS, OLT
SANTANA) e contra o roteiro operacional do proprio tecnico do cliente + o
manual oficial Intelbras 4840E (secoes 9.1-9.11):

    interface pon 0/<pon>
    onu-authenticate mode mac-auth white-list      -> so se ainda nao estiver
    white-list add mac <mac>                       -> autoriza, OLT atribui onu-id
    show white-list                                -> le de volta o onu-id atribuido
    onu 0/<pon>/<onu>
    onu-description <texto>
    interface ethernet <porta>
    onu-vlan-mode tag vlan <vlan>
    onu-p2p                                        -> libera pra transmitir (camera)
    copy running-config startup-config             -> salva, senao perde no reboot

    no onu-binding onu 0/<pon>/<onu>                -> exclusao, passo 1
    white-list del mac <mac>                        -> exclusao, passo 2 (dentro da PON)

    onu-reboot                                      -> dentro do contexto onu, pede y/n

    show onu-status [mac <mac>]                     -> lista/consulta (MAC, Rtt, estado)
    show onu-opm-diagnosis                          -> dentro do contexto onu (RX/TX power)
"""

from __future__ import annotations

import re
import time
from typing import Any, Dict, List, Optional

from app.cli.tools.olt_4840e_collect_macs import (
    _cli,
    _ensure_enable,
    _ensure_logged_in,
    _norm_mac,
    _open_shell,
)

_FAILURE_MARKERS = (
    "invalid parameter",
    "incomplete command",
    "unrecognized command",
)


def command_failed(output: str) -> bool:
    low = (output or "").strip().lower()
    return any(marker in low for marker in _FAILURE_MARKERS)


class OnuAddError(Exception):
    """Erro ao autorizar/excluir/reiniciar ONU -- carrega o que ja foi
    aplicado. `onu` fica preenchido quando o onu-id ja foi lido de volta
    (whitelist confirmada), mesmo que um passo seguinte (VLAN, p2p) falhe --
    sinal de que a ONU ja esta autorizada, so a config adicional que nao
    completou."""

    def __init__(self, message: str, failed_command: str, commands_run: List[str], onu: Optional[int] = None) -> None:
        super().__init__(message)
        self.failed_command = failed_command
        self.commands_run = commands_run
        self.onu = onu


_ONU_STATUS_LINE_RE = re.compile(
    r"^(?P<slot>\d+)/(?P<pon>\d+)/(?P<onu>\d+)\s+"
    r"(?P<mac>(?:[0-9a-f]{2}:){5}[0-9a-f]{2})\s+"
    r"(?P<dist>-|\d+)\s+"
    r"(?P<register>-|\d{2}/\d{2}/\d{2}\s+\d{2}:\d{2}:\d{2})\s+"
    r"(?P<type>\S+)\s+(?P<software>\S+)\s+(?P<state>Up|Down)\s*$",
    re.IGNORECASE,
)


def _parse_onu_status(output: str) -> List[Dict[str, Any]]:
    """Parseia 'show onu-status' (lista, uma PON ou tudo) e 'show onu-status
    mac <mac>' (uma linha so). Formato real (validado ao vivo):

        0/1/1  30:e1:f1:3e:a0:3f 2555   26/08/28 05:45:20 other 1.3-220719 Up
        0/1/13 80:85:44:5f:32:f8 -      -                 other -          Down
    """
    rows: List[Dict[str, Any]] = []
    for raw in (output or "").splitlines():
        m = _ONU_STATUS_LINE_RE.match(raw.strip())
        if not m:
            continue
        rows.append({
            "pon": int(m.group("pon")),
            "onu": int(m.group("onu")),
            "mac": _norm_mac(m.group("mac")),
            "distance_m": None if m.group("dist") == "-" else int(m.group("dist")),
            "register_time": "" if m.group("register") == "-" else re.sub(r"\s+", " ", m.group("register")),
            "type": m.group("type"),
            "software": m.group("software"),
            "state": m.group("state").capitalize(),
        })
    return rows


_WHITE_LIST_LINE_RE = re.compile(
    r"^pon-(?P<pon>\d+)/(?P<pon2>\d+)\s+(?P<index>\d+)\s+"
    r"(?P<mac>(?:[0-9a-f]{2}:){5}[0-9a-f]{2})\s*$",
    re.IGNORECASE,
)


def _parse_white_list(output: str) -> List[Dict[str, Any]]:
    """Parseia 'show white-list'. Formato real (validado no manual):

        WHITE LIST:
        Port Index Mac Address
        pon-0/1 1 00:0a:5a:00:01:01
        Total white-list entries: 1 .

    A coluna 'Port' vem como 'pon-<slot>/<pon>', nao so '<pon>'.
    """
    rows: List[Dict[str, Any]] = []
    for raw in (output or "").splitlines():
        m = _WHITE_LIST_LINE_RE.match(raw.strip())
        if not m:
            continue
        rows.append({
            "pon": int(m.group("pon2")),
            "index": int(m.group("index")),
            "mac": _norm_mac(m.group("mac")),
        })
    return rows


def _parse_opm_diagnosis(output: str) -> Dict[str, Any]:
    """Parseia 'show onu-opm-diagnosis' (dentro do contexto 'onu <endereco>').
    Formato real (validado no manual):

        ONU: 0/4/1
        Optical Transceiver Diagnosis :
        Work Temperature : 38.25 C
        Supply Voltage(Vcc) : 3.29 V
        TX Bias Current : 16.99 mA
        TX Power(Output) : 1.445 mW (3.00 dBm)
        RX Power(Input) : 0.573 mW (-2.40 dBm)
    """
    result: Dict[str, Any] = {}
    for raw in (output or "").splitlines():
        line = raw.strip()
        m = re.search(r"Work Temperature\s*:\s*([\-\d.]+)\s*C", line, re.IGNORECASE)
        if m:
            result["temperature_c"] = float(m.group(1))
            continue
        m = re.search(r"Supply Voltage.*:\s*([\-\d.]+)\s*V", line, re.IGNORECASE)
        if m:
            result["voltage_v"] = float(m.group(1))
            continue
        m = re.search(r"TX Bias Current\s*:\s*([\-\d.]+)\s*mA", line, re.IGNORECASE)
        if m:
            result["tx_bias_ma"] = float(m.group(1))
            continue
        m = re.search(r"TX Power.*\(([\-\d.]+)\s*dBm\)", line, re.IGNORECASE)
        if m:
            result["tx_power_dbm"] = float(m.group(1))
            continue
        m = re.search(r"RX Power.*\(([\-\d.]+)\s*dBm\)", line, re.IGNORECASE)
        if m:
            result["rx_power_dbm"] = float(m.group(1))
            continue
    return result


def _classify_auth_mode(output: str) -> str:
    """Classifica a saida de 'show onu-authenticate mode' (dentro do
    contexto da PON) em 'mac-auth', 'loid-auth', 'hybrid-auth' ou
    'disable'. So autoriza via whitelist quando ja for 'mac-auth' ou
    'disable' (ainda nao configurado) -- 'loid-auth'/'hybrid-auth' sao
    esquemas diferentes que este driver nao deve sobrescrever sozinho."""
    low = (output or "").lower()
    if "mac-auth" in low:
        return "mac-auth"
    if "loid-auth" in low:
        return "loid-auth"
    if "hybrid-auth" in low:
        return "hybrid-auth"
    return "disable"


def _connect_and_login(olt_ip: str, user: str, password: str, port: int, timeout: float):
    """Abre a sessao e loga/eleva privilegio. Se o login ou o 'enable'
    falharem DEPOIS do socket/shell abrir, fecha a conexao antes de propagar
    o erro -- senao ela vaza (nenhum chamador tem uma referencia pra fechar,
    porque a excecao acontece antes do 'return')."""
    client, chan = _open_shell(olt_ip, user, password, port=port, timeout=timeout)
    try:
        _ensure_logged_in(chan, user=user, password=password, timeout=timeout)
        _ensure_enable(chan, password=password, timeout=timeout)
    except Exception:
        try:
            chan.close()
        except Exception:
            pass
        try:
            client.close()
        except Exception:
            pass
        raise
    return client, chan


def find_onu_4840e(
    olt_ip: str, user: str, password: str, mac: str, port: int = 22, timeout: float = 12.0,
) -> Optional[Dict[str, Any]]:
    """Localiza uma ONU ja autorizada pelo MAC ('show onu-status mac <mac>').
    Retorna None se nao achar."""
    mac_norm = _norm_mac(mac)
    client, chan = _connect_and_login(olt_ip, user, password, port, timeout)
    try:
        _cli(chan, "conf t", timeout=timeout)
        out = _cli(chan, f"show onu-status mac {mac_norm}", timeout=timeout)
        rows = _parse_onu_status(out)
        return rows[0] if rows else None
    finally:
        try:
            chan.close()
        except Exception:
            pass
        try:
            client.close()
        except Exception:
            pass


def onu_signal_4840e(
    olt_ip: str, user: str, password: str, pon: int, onu: int, port: int = 22, timeout: float = 12.0,
) -> Dict[str, Any]:
    """Consulta status (Rtt/distancia/estado) + diagnostico optico
    (RX/TX power/temperatura/tensao) de uma ONU ja autorizada."""
    addr = f"0/{pon}/{onu}"
    client, chan = _connect_and_login(olt_ip, user, password, port, timeout)
    try:
        _cli(chan, "conf t", timeout=timeout)
        status_out = _cli(chan, "show onu-status", timeout=timeout)
        rows = _parse_onu_status(status_out)
        match = next((r for r in rows if r["pon"] == pon and r["onu"] == onu), None)
        if not match:
            return {"ok": False, "error": f"ONU {addr} nao encontrada em 'show onu-status'."}

        cmd = f"onu {addr}"
        out = _cli(chan, cmd, timeout=timeout)
        if command_failed(out):
            return {"ok": False, "error": f"Falha ao entrar no contexto {addr}: {out.strip()[:300]}"}
        diag_out = _cli(chan, "show onu-opm-diagnosis", timeout=timeout)
        diag = _parse_opm_diagnosis(diag_out)
        _cli(chan, "exit", timeout=timeout)

        return {
            "ok": True,
            "pon": pon,
            "onu": onu,
            "mac": match["mac"],
            "distance_m": match["distance_m"],
            "register_time": match["register_time"],
            "state": match["state"],
            "software": match["software"],
            **diag,
        }
    finally:
        try:
            chan.close()
        except Exception:
            pass
        try:
            client.close()
        except Exception:
            pass


def _pon_range(pon: str) -> List[int]:
    p = (pon or "all").strip().lower()
    if p == "all":
        return [1, 2, 3, 4]
    return [int(p)]


def discover_onus_4840e(
    olt_ip: str, user: str, password: str, pon: str = "all", port: int = 22, timeout: float = 12.0,
) -> Dict[str, Any]:
    """Descobre MACs vistos fisicamente na PON mas ainda fora da whitelist
    (candidatas a autorizar). Cruza 'show onu-status' (tudo que ja foi
    visto, autorizado ou nao -- os nao-autorizados aparecem com State=Down
    e sem RTT) com 'show white-list' (o que ja esta autorizado)."""
    client, chan = _connect_and_login(olt_ip, user, password, port, timeout)
    try:
        pons_out: Dict[str, Any] = {}
        for p in _pon_range(pon):
            _cli(chan, "conf t", timeout=timeout)
            _cli(chan, f"interface pon 0/{p}", timeout=timeout)
            status_rows = _parse_onu_status(_cli(chan, "show onu-status", timeout=timeout))
            white_rows = _parse_white_list(_cli(chan, "show white-list", timeout=timeout))
            _cli(chan, "exit", timeout=timeout)

            whitelisted_macs = {row["mac"] for row in white_rows if row["pon"] == p}
            discovered = [
                {"pon": row["pon"], "mac": row["mac"], "state": row["state"]}
                for row in status_rows
                if row["pon"] == p and row["state"] == "Down" and row["mac"] not in whitelisted_macs
            ]
            pons_out[str(p)] = {"discovered": discovered}
        return {"ok": True, "pons": pons_out}
    finally:
        try:
            chan.close()
        except Exception:
            pass
        try:
            client.close()
        except Exception:
            pass
