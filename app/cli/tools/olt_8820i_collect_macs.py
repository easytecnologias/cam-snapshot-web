#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Ferramenta auxiliar: coleta MACs por ONU na OLT Intelbras 8820i (GPON)
usando sessão interativa (invoke_shell) e gera saida/olt-cpe-macs.json.

Uso típico (PowerShell):

    # PON específica
    python .\tools\olt_8820i_collect_macs.py `
      --olt-ip 10.80.80.5 `
      --user admin `
      --password admin `
      --pon 1 `
      --out saida\olt-cpe-macs.json

    # Todas as PONs (1-8)
    python .\tools\olt_8820i_collect_macs.py `
      --olt-ip 10.80.80.5 `
      --user admin `
      --password admin `
      --pon all `
      --out saida\olt-cpe-macs.json
"""

import argparse
import csv
import os
import re
import sys
import time
from typing import Dict, List

import paramiko  # type: ignore[import]


PROMPT = "intelbras-olt>"  # ajuste se o prompt for diferente
DEBUG_OLT_COLLECT = str(os.getenv("OLT_DEBUG_COLLECT", "0")).strip().lower() in ("1", "true", "yes", "on")


def normalize_mac(s: str) -> str:
    """Normaliza MAC para o formato aa:bb:cc:dd:ee:ff (minúsculo)."""
    if not s:
        return ""
    s = s.strip()
    s = re.sub(r"[^0-9A-Fa-f]", "", s)  # remove tudo que não é hexa
    s = s.lower()
    if len(s) == 12:
        return ":".join(s[i : i + 2] for i in range(0, 12, 2))
    return s


def open_shell(client: paramiko.SSHClient):
    """Abre uma sessão interativa na OLT e sincroniza com o prompt."""
    chan = client.invoke_shell()
    time.sleep(0.25)
    _ = read_until_prompt(chan)
    return chan


def read_until_prompt(chan, timeout: float = 10.0) -> str:
    """Lê dados da sessão até encontrar o PROMPT ou estourar timeout."""
    buffer = ""
    start = time.time()
    while True:
        if chan.recv_ready():
            data = chan.recv(4096).decode(errors="ignore")
            buffer += data
            if PROMPT in buffer:
                break
        if time.time() - start > timeout:
            break
        time.sleep(0.05)
    return buffer


def cli_run(chan, cmd: str, timeout: float = 10.0) -> str:
    """
    Envia um comando para a OLT via shell interativo e lê até o prompt retornar.
    Remove eco do comando e o prompt final, deixando só o "miolo" da saída.
    """
    time.sleep(0.05)
    while chan.recv_ready():
        _ = chan.recv(4096)

    cmd_str = cmd.strip()
    chan.send(cmd_str + "\n")

    output = read_until_prompt(chan, timeout=timeout)

    output_lines = output.splitlines()
    cleaned_lines: List[str] = []
    for line in output_lines:
        if line.strip() == cmd_str:
            continue
        if PROMPT in line:
            continue
        cleaned_lines.append(line)

    final = "\n".join(cleaned_lines)
    if DEBUG_OLT_COLLECT:
        sys.stderr.write(f"[DBG] Saida de '{cmd_str}':\n{final}\n")
    return final


def parse_onu_status(output: str, pon: int | None = None) -> List[Dict]:
    """Parseia saída de 'onu status gpon <pon>'."""
    onus: List[Dict] = []

    lines = output.splitlines()
    in_table = False

    for line in lines:
        s = line.strip()
        if not s:
            continue

        if s.startswith("ONU") and "OperStatus" in s:
            in_table = True
            continue

        if not in_table:
            continue

        if s.startswith("Configured ONUs"):
            break

        parts = s.split()
        if len(parts) < 2:
            continue

        try:
            onu_id = int(parts[0])
        except ValueError:
            continue

        serial = parts[1]
        pon_id = pon if pon is not None else 1

        onus.append(
            {
                "pon": pon_id,
                "onu_id": onu_id,
                "enabled": "Yes",
                "serial": serial,
                "model": "",
                "profile": "",
                "name": f"gpon {pon_id} onu {onu_id}",
            }
        )

    return onus


def parse_macs_from_output(output: str) -> List[Dict]:
    """Parseia saída de:

        bridge show mac gpon <pon> onu <onu>
    """
    macs: List[Dict] = []

    mac_pattern = re.compile(
        r"^([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}|[0-9A-Fa-f]{12})", re.IGNORECASE
    )
    vlan_pattern = re.compile(r"vlan\s+(\d+)", re.IGNORECASE)

    for line in output.splitlines():
        line = line.strip()
        if not line or "MAC Address" in line or "Interface" in line or line.startswith("="):
            continue

        m_mac = mac_pattern.search(line)
        if not m_mac:
            continue

        m_vlan = vlan_pattern.search(line)
        vlan = m_vlan.group(1) if m_vlan else ""

        raw_mac = m_mac.group(1)
        mac_norm = normalize_mac(raw_mac)
        if not mac_norm:
            continue

        macs.append({"cpe_mac": mac_norm, "vlan": vlan})

    return macs


def get_macs_for_onu(chan, pon: int, onu_id: int) -> List[Dict]:
    """Executa o comando:

        bridge show mac gpon <pon> onu <onu_id>
    """
    cmd = f"bridge show mac gpon {pon} onu {onu_id}"
    out = cli_run(chan, cmd, timeout=15.0)
    macs = parse_macs_from_output(out)
    if macs:
        sys.stderr.write(f"[INFO] MACs encontrados para gpon {pon} onu {onu_id}.\n")
    else:
        sys.stderr.write(
            f"[WARN] Nenhum MAC parseado para gpon {pon} onu {onu_id}. Veja a saída acima.\n"
        )
    return macs


# ============
# FUNÇÃO P/ BACKEND (FastAPI)
# ============

def collect_macs_8820i(
    olt_ip: str,
    user: str,
    password: str,
    pon: str = "all",
    olt_name: str = "OLT-8820I",
    timeout: float = 12.0,
) -> List[Dict]:
    """
    Coleta MACs por ONU na OLT Intelbras 8820i e retorna lista de dicts.
    Pode receber PON específica (ex: "1") ou "all".
    """
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    sys.stderr.write(f"[INFO] Conectando em {olt_ip}...\n")
    client.connect(
        olt_ip,
        username=user,
        password=password,
        look_for_keys=False,
        allow_agent=False,
        timeout=timeout,
        banner_timeout=timeout,
        auth_timeout=timeout,
    )

    try:
        chan = open_shell(client)
        onu_status_cache: Dict[int, str] = {}

        # Descobre quais PONs vamos varrer
        if pon.lower() == "all":
            sys.stderr.write("[INFO] Varredura automática de PONs usando 'onu status gpon <pon>'...\n")
            pons: List[int] = []
            for p in range(1, 9):
                out_status = cli_run(chan, f"onu status gpon {p}", timeout=10.0)
                if "Configured ONUs" in out_status:
                    sys.stderr.write(f"[INFO] PON {p} encontrada (Configured ONUs).\n")
                    pons.append(p)
                    onu_status_cache[p] = out_status
            if not pons:
                sys.stderr.write(
                    "[WARN] Nenhuma PON encontrada entre 1 e 8 com 'onu status gpon <pon>'.\n"
                )
        else:
            try:
                pons = [int(pon)]
            except ValueError:
                sys.stderr.write(
                    "[ERRO] Valor inválido para pon. Use um número (ex: 1) ou 'all'.\n"
                )
                return []

        if not pons:
            sys.stderr.write("[ERRO] Nenhuma PON para processar.\n")
            return []

        rows: List[Dict] = []

        for p in pons:
            sys.stderr.write(f"[INFO] Lendo ONUs da gpon {p} com 'onu status gpon {p}'...\n")
            out_onu = onu_status_cache.get(p) or cli_run(chan, f"onu status gpon {p}", timeout=15.0)
            onus = parse_onu_status(out_onu, p)
            if not onus:
                sys.stderr.write(
                    f"[WARN] Nenhuma ONU encontrada em gpon {p}. "
                    "Verifique se o comando e o parser estão corretos.\n"
                )
                continue

            for onu in onus:
                onu_id = int(onu["onu_id"])
                sys.stderr.write(
                    f"[INFO] Coletando MACs de gpon {p} onu {onu_id}...\n"
                )
                macs = get_macs_for_onu(chan, p, onu_id)
                for m in macs:
                    rows.append(
                        {
                            "cpe_mac": m["cpe_mac"],
                            "pon": p,
                            "onu_id": onu_id,
                            "onu_name": onu["name"],
                            "onu_serial": onu["serial"],
                            "onu_model": onu["model"],
                            "olt_ip": olt_ip,
                            "olt_name": olt_name,
                            "vlan": m.get("vlan", ""),
                        }
                    )

        return rows
    finally:
        client.close()


# ============
# CLI TRADICIONAL
# ============

def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Coleta MACs por ONU na OLT Intelbras 8820i e gera saida/olt-cpe-macs.json. "
            "Use --pon N para PON específica ou --pon all para todas (1-8)."
        )
    )
    parser.add_argument("--olt-ip", required=True)
    parser.add_argument("--user", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument(
        "--pon",
        required=True,
        help="PON desejada (ex: 1) ou 'all' para todas as PONs detectadas (1-8).",
    )
    parser.add_argument("--olt-name", default="OLT-8820I")
    parser.add_argument("--out", default="saida/olt-cpe-macs.json")
    args = parser.parse_args()

    rows = collect_macs_8820i(
        olt_ip=args.olt_ip,
        user=args.user,
        password=args.password,
        pon=args.pon,
        olt_name=args.olt_name,
    )

    if not rows:
        sys.stderr.write(
            "[WARN] Nenhum MAC coletado. O CSV será criado, mas estará vazio.\n"
        )

    fieldnames = [
        "cpe_mac",
        "pon",
        "onu_id",
        "onu_name",
        "onu_serial",
        "onu_model",
        "olt_ip",
        "olt_name",
        "vlan",
    ]

    import os
    import json
    from datetime import datetime

    os.makedirs(os.path.dirname(args.out), exist_ok=True)

    payload = {
        "meta": {
            "kind": "olt_cpe_macs",
            "olt_ip": args.olt_ip,
            "olt_name": getattr(args, "olt_name", ""),
            "scan_time": datetime.now().astimezone().isoformat(),
            "total_cpes": len(rows),
        },
        "cpes": rows,
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    sys.stderr.write(f"[INFO] JSON gerado em: {args.out}\n")


if __name__ == "__main__":
    main()
