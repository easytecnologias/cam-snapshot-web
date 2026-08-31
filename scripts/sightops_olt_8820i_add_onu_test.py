import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app.cli.tools.olt_8820i_add_onu as mod
from app.cli.tools.olt_8820i_add_onu import OnuAddError, resolve_current_serno_id, serial_number_arg

PROMPT = mod.PROMPT


class FakeChannel:
    def __init__(self, script):
        self._script = script
        self._pending = PROMPT
        self.commands = []

    def recv_ready(self):
        return bool(self._pending)

    def recv(self, n):
        out = self._pending[:n]
        self._pending = self._pending[n:]
        return out.encode()

    def send(self, data):
        cmd = data.strip()
        self.commands.append(cmd)
        self._pending = self._script(cmd) + "\n" + PROMPT

    def close(self):
        pass


class FakeSSHClient:
    def __init__(self, script):
        self._script = script
        self.channel = None

    def set_missing_host_key_policy(self, policy):
        pass

    def connect(self, *a, **kw):
        pass

    def invoke_shell(self):
        self.channel = FakeChannel(self._script)
        return self.channel

    def close(self):
        pass


def _patch_client(factory):
    original = mod.paramiko.SSHClient
    mod.paramiko.SSHClient = factory
    return original


def _discovered(*entries):
    return [{"serno_id": sid, "serial": serial} for sid, serial in entries]


def test_uses_fresh_serno_id_when_serial_matches():
    discovered = _discovered((72, "ITBS0A488C12"), (73, "8B3E3755"))
    assert resolve_current_serno_id(discovered, "itbs0a488c12", 999) == 72


def test_falls_back_to_serno_id_when_no_serial_given():
    discovered = _discovered((72, "ITBS0A488C12"))
    assert resolve_current_serno_id(discovered, "", 72) == 72


def test_falls_back_to_serno_id_when_serial_not_found_but_id_still_present():
    discovered = _discovered((72, "ITBS0A488C12"))
    assert resolve_current_serno_id(discovered, "SERIAL-NOT-IN-LIST", 72) == 72


def test_raises_actionable_error_when_id_expired_and_serial_gone():
    discovered = _discovered((99, "SOMEOTHERSERIAL"))
    try:
        resolve_current_serno_id(discovered, "ITBS0A488C12", 72)
        assert False, "esperava OnuAddError"
    except OnuAddError as e:
        assert "ITBS0A488C12" in str(e)
        assert "descoberta" in str(e).lower()


def test_serial_number_arg_concatenates_vendor_and_serial():
    assert serial_number_arg("ITBS", "2C96E6A7") == "ITBS2C96E6A7"


def test_serial_number_arg_does_not_double_prefix_when_already_concatenated():
    # onu_signal devolve o serial ja colado (ex: 'ITBS2C96E6A7') -- nao pode
    # virar 'ITBSITBS2C96E6A7'.
    assert serial_number_arg("ITBS", "ITBS2C96E6A7") == "ITBS2C96E6A7"


def test_serial_number_arg_without_vendor():
    assert serial_number_arg("", "2C96E6A7") == "2C96E6A7"


_ONU_SHOW_OUTPUT = """
Free slots in GPON Link 7:
================================
2  6  8  9  10

Discovered serial numbers
================================
sernoID  Vendor  Serial Number  Model     Time Discovered
3        ITBS    2C96E6A7       110Gb     Jul 18 12:13:43 2026
"""


def test_add_onu_authorizes_by_serial_when_serial_informed():
    # Validado contra OLT real: 'onu set gpon <pon> onu <onu> serial-number
    # <VENDOR+SERIAL> meprof <perfil>' -- nao deve usar 'id <sernoID>'
    # quando o serial esta disponivel (o sernoID muda a cada 'onu show').
    def script(cmd):
        if cmd.startswith("onu show gpon"):
            return _ONU_SHOW_OUTPUT
        if cmd.startswith("onu set gpon"):
            return "Onu 2 successfully enabled with serial number ITBS2C96E6A7"
        if cmd.startswith("bridge add"):
            return "Adding bridge gpon 7 onu 2 vlan 3000 ....................... Ok"
        return ""

    original = _patch_client(lambda: FakeSSHClient(script))
    try:
        result = mod.add_onu(
            "10.80.80.2", "admin", "admin",
            pon=7, serno_id=3, profile="intelbras-110b",
            slot=2, serial="2C96E6A7", vendor="ITBS",
            service="tls", vlan=3000,
        )
    finally:
        mod.paramiko.SSHClient = original

    assert result["ok"] is True, result
    set_cmds = [c for c in result["commands_run"] if c.startswith("onu set")]
    assert set_cmds == ["onu set gpon 7 onu 2 serial-number ITBS2C96E6A7 meprof intelbras-110b"], set_cmds


def test_add_onu_falls_back_to_id_when_no_serial_given():
    def script(cmd):
        if cmd.startswith("onu show gpon"):
            return _ONU_SHOW_OUTPUT
        if cmd.startswith("onu set gpon"):
            return "Onu 2 successfully enabled"
        if cmd.startswith("bridge add"):
            return "Adding bridge gpon 7 onu 2 vlan 3000 ....................... Ok"
        return ""

    original = _patch_client(lambda: FakeSSHClient(script))
    try:
        result = mod.add_onu(
            "10.80.80.2", "admin", "admin",
            pon=7, serno_id=3, profile="intelbras-110b",
            slot=2, service="tls", vlan=3000,
        )
    finally:
        mod.paramiko.SSHClient = original

    assert result["ok"] is True, result
    set_cmds = [c for c in result["commands_run"] if c.startswith("onu set")]
    assert set_cmds == ["onu set gpon 7 onu 2 id 3 meprof intelbras-110b"], set_cmds


def test_bridge_add_falls_back_to_other_type_on_vlan_conflict():
    # Validado contra OLT real: VLAN 3000 travada em 'tls' -- tentar
    # 'downlink' nela e recusado, e o sistema deve tentar 'tls' sozinho.
    calls = []

    def script(cmd):
        if cmd.startswith("onu show gpon"):
            return _ONU_SHOW_OUTPUT
        if cmd.startswith("onu set gpon"):
            return "Onu 2 successfully enabled"
        if cmd.startswith("bridge add"):
            calls.append(cmd)
            if "downlink" in cmd:
                return "% Cannot add Asymmetric bridge to VLAN that already has a TLS bridge\nAdding bridge gpon 7 onu 2 vlan 3000 ....................... FAILED"
            return "Adding bridge gpon 7 onu 2 vlan 3000 ....................... Ok"
        return ""

    original = _patch_client(lambda: FakeSSHClient(script))
    try:
        result = mod.add_onu(
            "10.80.80.2", "admin", "admin",
            pon=7, serno_id=3, profile="intelbras-110b",
            slot=2, service="downlink", vlan=3000,
        )
    finally:
        mod.paramiko.SSHClient = original

    assert result["ok"] is True, result
    assert len(calls) == 2, calls
    assert "downlink" in calls[0] and "tls" in calls[1], calls


def test_bridge_add_retries_after_onu_not_ready():
    # Validado contra OLT real: logo apos o 'onu set', a OLT as vezes ainda
    # nao terminou o OMCI e recusa a bridge com "Please set ONU first".
    calls = []
    original_sleep = mod.time.sleep
    mod.time.sleep = lambda *_a, **_kw: None  # nao esperar de verdade no teste
    try:
        def script(cmd):
            if cmd.startswith("onu show gpon"):
                return _ONU_SHOW_OUTPUT
            if cmd.startswith("onu set gpon"):
                return "Onu 2 successfully enabled"
            if cmd.startswith("bridge add"):
                calls.append(cmd)
                if len(calls) == 1:
                    return "% Please set ONU first\nAdding bridge gpon 7 onu 2 vlan 3000 ....................... FAILED"
                return "Adding bridge gpon 7 onu 2 vlan 3000 ....................... Ok"
            return ""

        original = _patch_client(lambda: FakeSSHClient(script))
        try:
            result = mod.add_onu(
                "10.80.80.2", "admin", "admin",
                pon=7, serno_id=3, profile="intelbras-110b",
                slot=2, service="tls", vlan=3000,
            )
        finally:
            mod.paramiko.SSHClient = original
    finally:
        mod.time.sleep = original_sleep

    assert result["ok"] is True, result
    assert len(calls) == 2, calls


def test_bridge_add_does_not_retry_on_unrelated_failure():
    # Um erro que nao e nem "tipo errado" nem "ainda nao assentou" deve
    # falhar direto, sem tentar de novo e sem trocar o tipo de servico.
    calls = []

    def script(cmd):
        if cmd.startswith("onu show gpon"):
            return _ONU_SHOW_OUTPUT
        if cmd.startswith("onu set gpon"):
            return "Onu 2 successfully enabled"
        if cmd.startswith("bridge add"):
            calls.append(cmd)
            return "% Invalid input detected\nAdding bridge gpon 7 onu 2 vlan 3000 ....................... FAILED"
        return ""

    original = _patch_client(lambda: FakeSSHClient(script))
    try:
        try:
            mod.add_onu(
                "10.80.80.2", "admin", "admin",
                pon=7, serno_id=3, profile="intelbras-110b",
                slot=2, service="tls", vlan=3000,
            )
            assert False, "esperava OnuAddError"
        except OnuAddError as e:
            assert e.slot == 2, e.slot
    finally:
        mod.paramiko.SSHClient = original

    assert len(calls) == 1, calls


def test_add_bridge_only_recovers_authorized_onu_without_reauthorizing():
    # Recuperacao: ONU ja autorizada (onu set ja feito antes), so falta a
    # bridge -- add_bridge_only nao deve mandar 'onu set' de novo.
    calls = []

    def script(cmd):
        calls.append(cmd)
        if cmd.startswith("bridge add"):
            return "Adding bridge gpon 7 onu 2 vlan 3000 ....................... Ok"
        return ""

    original = _patch_client(lambda: FakeSSHClient(script))
    try:
        result = mod.add_bridge_only(
            "10.80.80.2", "admin", "admin",
            pon=7, slot=2, service="tls", vlan=3000,
        )
    finally:
        mod.paramiko.SSHClient = original

    assert result["ok"] is True, result
    assert calls == ["bridge add gpon 7 onu 2 tls vlan 3000 tagged eth 1"], calls


def test_reboot_onu_sends_expected_command_and_reports_ok():
    calls = []

    def script(cmd):
        calls.append(cmd)
        return "Rebooting ONU gpon 7 onu 2 ..."

    original = _patch_client(lambda: FakeSSHClient(script))
    try:
        result = mod.reboot_onu("10.80.80.2", "admin", "admin", pon=7, onu=2)
    finally:
        mod.paramiko.SSHClient = original

    assert calls == ["onu reboot gpon 7 onu 2"], calls
    assert result["ok"] is True, result


def test_reboot_onu_reports_failure_when_olt_rejects():
    def script(cmd):
        return "% Invalid input detected"

    original = _patch_client(lambda: FakeSSHClient(script))
    try:
        result = mod.reboot_onu("10.80.80.2", "admin", "admin", pon=7, onu=2)
    finally:
        mod.paramiko.SSHClient = original

    assert result["ok"] is False, result


def main() -> None:
    test_uses_fresh_serno_id_when_serial_matches()
    test_falls_back_to_serno_id_when_no_serial_given()
    test_falls_back_to_serno_id_when_serial_not_found_but_id_still_present()
    test_raises_actionable_error_when_id_expired_and_serial_gone()
    test_serial_number_arg_concatenates_vendor_and_serial()
    test_serial_number_arg_does_not_double_prefix_when_already_concatenated()
    test_serial_number_arg_without_vendor()
    test_add_onu_authorizes_by_serial_when_serial_informed()
    test_add_onu_falls_back_to_id_when_no_serial_given()
    test_bridge_add_falls_back_to_other_type_on_vlan_conflict()
    test_bridge_add_retries_after_onu_not_ready()
    test_bridge_add_does_not_retry_on_unrelated_failure()
    test_add_bridge_only_recovers_authorized_onu_without_reauthorizing()
    test_reboot_onu_sends_expected_command_and_reports_ok()
    test_reboot_onu_reports_failure_when_olt_rejects()
    print("OK: sightops_olt_8820i_add_onu_test")


if __name__ == "__main__":
    main()
