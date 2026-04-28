from getpass import getpass
from app.cli.tools.olt_4840e_collect_macs import collect_macs_4840e

print("INICIANDO...")
olt_ip = "192.168.50.2"
user = "admin"
password = getpass("Senha SSH da OLT: ")  # digita escondido

rows = collect_macs_4840e(
    olt_ip=olt_ip,
    user=user,
    password=password,
    pon="0/1",
    timeout=25.0,
)

print("TERMINOU. TOTAL:", len(rows))
print(rows[:5])
