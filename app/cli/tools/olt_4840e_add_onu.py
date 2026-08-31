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
