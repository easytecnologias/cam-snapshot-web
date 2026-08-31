import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.cli.tools.olt_4840e_add_onu as mod

FALHAS: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        FALHAS.append(msg)


class FakeChannel:
    """Simula o canal SSH pro protocolo desta OLT: cada comando enviado
    troca o prompt conforme o contexto (config/pon/onu), igual ao real.
    `script(cmd, prompt) -> (reply_text, next_prompt)`."""

    def __init__(self, script, prompt="OLT_RADS#"):
        self._script = script
        self._prompt = prompt
        self._pending = ""
        self.commands: list[str] = []

    def recv_ready(self) -> bool:
        return bool(self._pending)

    def recv(self, n: int) -> bytes:
        out = self._pending[:n]
        self._pending = self._pending[n:]
        return out.encode()

    def send(self, data: str) -> int:
        cmd = data.rstrip("\n")
        self.commands.append(cmd)
        reply, self._prompt = self._script(cmd, self._prompt)
        self._pending += reply + "\n" + self._prompt
        return len(data)

    def close(self) -> None:
        pass


class FakeSSHClient:
    def close(self) -> None:
        pass


def _patch_open_shell(script, prompt="OLT_RADS#"):
    original = mod._open_shell
    mod._open_shell = lambda host, user, password, port=22, timeout=12.0: (
        FakeSSHClient(), FakeChannel(script, prompt),
    )
    return original


def _patch_login(monkeypatch_noop=True):
    """`_ensure_logged_in`/`_ensure_enable` esperam textos especificos de
    login/senha que o FakeChannel nao precisa simular -- substitui as duas
    por no-ops nos testes (a autenticacao em si e testada nos scripts de
    `olt_4840e_collect_macs.py`, nao aqui)."""
    orig_login = mod._ensure_logged_in
    orig_enable = mod._ensure_enable
    mod._ensure_logged_in = lambda chan, user, password, timeout=12.0: None
    mod._ensure_enable = lambda chan, password, timeout=12.0: None
    return orig_login, orig_enable


def _unpatch(orig_open_shell, orig_login, orig_enable):
    mod._open_shell = orig_open_shell
    mod._ensure_logged_in = orig_login
    mod._ensure_enable = orig_enable


_STATUS_OUTPUT = (
    "ONU    Mac Address       Dis(m) RegisterTime      Type  Software   State\n"
    "0/4/6  30:e1:f1:73:a7:19 2654   26/07/29 06:09:43 other 1.3-220719 Up\n"
    "Total onu entries: 1 .\n"
    "onu online : 1 .\n"
)

_OPM_OUTPUT = (
    "ONU: 0/4/6\n"
    "Optical Transceiver Diagnosis :\n"
    "Work Temperature : 38.25 C\n"
    "Supply Voltage(Vcc) : 3.29 V\n"
    "TX Bias Current : 16.99 mA\n"
    "TX Power(Output) : 1.445 mW (3.00 dBm)\n"
    "RX Power(Input) : 0.573 mW (-2.40 dBm)\n"
)


def test_find_onu_4840e_finds_by_mac():
    def script(cmd, prompt):
        if cmd == "conf t":
            return "", "OLT_RADS(config)#"
        if cmd.startswith("show onu-status mac"):
            return _STATUS_OUTPUT, prompt
        return "", prompt

    orig_open_shell = _patch_open_shell(script)
    orig_login, orig_enable = _patch_login()
    try:
        result = mod.find_onu_4840e("100.64.10.5", "admin", "x", mac="30:e1:f1:73:a7:19")
    finally:
        _unpatch(orig_open_shell, orig_login, orig_enable)

    check(result is not None, "esperava achar a ONU")
    check(result["pon"] == 4 and result["onu"] == 6, f"pon/onu errados: {result}")


def test_find_onu_4840e_returns_none_when_not_found():
    def script(cmd, prompt):
        if cmd == "conf t":
            return "", "OLT_RADS(config)#"
        if cmd.startswith("show onu-status mac"):
            return "Total onu entries: 0 .\n", prompt
        return "", prompt

    orig_open_shell = _patch_open_shell(script)
    orig_login, orig_enable = _patch_login()
    try:
        result = mod.find_onu_4840e("100.64.10.5", "admin", "x", mac="aa:bb:cc:dd:ee:ff")
    finally:
        _unpatch(orig_open_shell, orig_login, orig_enable)

    check(result is None, f"esperava None, veio {result}")


def test_onu_signal_4840e_combines_status_and_opm():
    def script(cmd, prompt):
        if cmd == "conf t":
            return "", "OLT_RADS(config)#"
        if cmd == "show onu-status":
            return _STATUS_OUTPUT, prompt
        if cmd == "onu 0/4/6":
            return "", "OLT_RADS(onu-0/4/6)#"
        if cmd == "show onu-opm-diagnosis":
            return _OPM_OUTPUT, prompt
        if cmd == "exit":
            return "", "OLT_RADS(config)#"
        return "", prompt

    orig_open_shell = _patch_open_shell(script)
    orig_login, orig_enable = _patch_login()
    try:
        result = mod.onu_signal_4840e("100.64.10.5", "admin", "x", pon=4, onu=6)
    finally:
        _unpatch(orig_open_shell, orig_login, orig_enable)

    check(result["ok"] is True, result)
    check(result["mac"] == "30:e1:f1:73:a7:19", f"mac errado: {result}")
    check(result["state"] == "Up", f"state errado: {result}")
    check(result["rx_power_dbm"] == -2.40, f"rx power errado: {result}")


def main() -> None:
    test_find_onu_4840e_finds_by_mac()
    test_find_onu_4840e_returns_none_when_not_found()
    test_onu_signal_4840e_combines_status_and_opm()
    if FALHAS:
        print(f"FALHOU ({len(FALHAS)}):")
        for f in FALHAS:
            print(" -", f)
        raise SystemExit(1)
    print("OK: sightops_olt_4840e_add_onu_test (find_onu/onu_signal)")


if __name__ == "__main__":
    main()
