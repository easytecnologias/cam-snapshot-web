import importlib.util
import pathlib

print("INICIANDO...")

path = pathlib.Path("tools/olt_4840e_collect_macs.py").resolve()
spec = importlib.util.spec_from_file_location("olt_4840e_collect_macs", path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

OLT_IP = "192.168.50.2"
USER = "admin"
PASS = "xzydsP2@11"   # sem espaços no fim

# DEBUG: pega aspas/espaço/CRLF invisível
print("PASS repr:", repr(PASS))
print("PASS len :", len(PASS))

rows = mod.collect_macs_4840e(
    olt_ip=OLT_IP,
    user=USER,
    password=PASS,
    pon="0/1",
    timeout=25.0
)

print("TERMINOU. TOTAL:", len(rows))
print(rows[:3])
