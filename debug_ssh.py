from __future__ import annotations

import os
import sys
import time

import paramiko


def env_required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def main() -> int:
    host = env_required("DEBUG_SSH_HOST")
    user = env_required("DEBUG_SSH_USER")
    password = env_required("DEBUG_SSH_PASSWORD")
    commands = [
        cmd.strip()
        for cmd in os.getenv("DEBUG_SSH_COMMANDS", "show pon;show mac onu").split(";")
        if cmd.strip()
    ]

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(host, username=user, password=password, look_for_keys=False, allow_agent=False)

    try:
        chan = ssh.invoke_shell()
        time.sleep(1)
        if chan.recv_ready():
            print(chan.recv(99999).decode(errors="ignore"))

        for cmd in commands:
            chan.send(cmd + "\n")
            time.sleep(1.5)
            out = ""
            while chan.recv_ready():
                out += chan.recv(99999).decode(errors="ignore")
                time.sleep(0.2)
            print("======", cmd, "======")
            print(out)
    finally:
        try:
            chan.close()
        except Exception:
            pass
        ssh.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
