---
name: puxar-gravacao-dvr
description: >-
  Baixa gravações de um DVR/NVR Intelbras ou Dahua direto pela rede local, sem
  precisar de nenhum servidor ou sistema externo. Use quando o usuário pedir para
  puxar/baixar gravações, trechos, clipes ou vídeos de um DVR informando IP,
  usuário, senha, canais (câmeras) e período (data/hora). Gera MP4 leves,
  organizados em uma pasta por câmera. É a habilidade de "Reprodução" do SightOps
  empacotada de forma portátil (usa o protocolo loadfile.cgi do próprio DVR).
---

# Puxar gravação de DVR (Intelbras/Dahua)

Baixa trechos gravados direto do DVR pela rede local e converte para MP4 leve.
Isso é **download de arquivo** (limitado pela banda da rede), **não** streaming
RTSP em tempo real — 1 hora de gravação não leva 1 hora pra baixar.

## Pré-requisitos
- A máquina precisa **alcançar o DVR na rede** (mesma LAN ou VPN). IP do DVR
  costuma ser local (ex.: `192.168.x.x`).
- **Python 3** com a lib `requests`.
- **ffmpeg** instalado (para converter `.dav` em `.mp4`). Se faltar, instale.

## Dados que você precisa pedir ao usuário (se não vierem)
- IP do DVR e porta (padrão 80)
- Usuário e senha do DVR (autenticação HTTP **Digest**)
- Canais / câmeras (ex.: 5, 6, 7...)
- Período: data + hora de início e fim

## Como baixar cada trecho
Requisição GET, com **HTTP Digest auth**, para:

```
http://<IP>:<PORTA>/cgi-bin/loadfile.cgi?action=startLoad&channel=<N>&startTime=<INI>&endTime=<FIM>
```

- `startTime`/`endTime` no formato `AAAA-MM-DD HH:MM:SS` (fazer URL-encode).
- Salvar a resposta (stream) como arquivo `.dav`.
- **Validação:** os bytes de uma gravação válida começam com o magic `DHAV`.
  Se não começar com `DHAV`, ou o arquivo vier com menos de ~1 KB, considerar que
  **não há gravação** naquele trecho/canal e seguir em frente (não abortar tudo).
- Códigos: `401/403` = credencial recusada; `404` = gravação não encontrada.

## Converter para MP4 leve
```
ffmpeg -y -hide_banner -loglevel error -i trecho.dav \
  -vf scale=1280:-2 -c:v libx264 -preset veryfast -crf 28 \
  -movflags +faststart -an trecho.mp4
```
Depois **apague o `.dav`** intermediário. Para arquivos menores, reduza a
resolução (`scale=960:-2` ou `scale=640:-2`).

## Regras de organização
- **Limite de 60 minutos por chamada.** Períodos maiores devem ser quebrados em
  trechos de 1 hora (ex.: 16:00-17:00, 17:00-18:00, ...).
- Uma **pasta por câmera**: `camera-05`, `camera-06`, ... com os MP4 dentro.
- Nomear por horário para ordenar: `ch05_2026-07-15_16h00-17h00.mp4`.
- Mostrar progresso e **não parar** se um trecho falhar — registrar e continuar.
- Rodar em sequência; muitos trechos × muitas câmeras demora (avise o usuário).

## Script de referência (Python, stdlib + requests)
Adapte os valores do topo conforme o pedido do usuário.

```python
import os, time, urllib.parse, subprocess
from datetime import datetime, timedelta
import requests
from requests.auth import HTTPDigestAuth

DVR_IP   = "192.168.1.105"; PORT = 80
USER     = "admin"; PASSWORD = "ouroverde2023"
CHANNELS = [5, 6, 7, 8, 9, 10, 11]
START    = "2026-07-15 16:00:00"
END      = "2026-07-16 12:00:00"
CHUNK_MIN = 60
OUTDIR   = "gravacoes"
SCALE    = "scale=1280:-2"
FMT = "%Y-%m-%d %H:%M:%S"

def chunks(s, e, minutes):
    cur, end = datetime.strptime(s, FMT), datetime.strptime(e, FMT)
    while cur < end:
        nxt = min(cur + timedelta(minutes=minutes), end)
        yield cur, nxt; cur = nxt

def base():
    return f"http://{DVR_IP}" + (f":{PORT}" if PORT != 80 else "")

def download_dav(ch, ini, fim, dav):
    q = urllib.parse.urlencode({"action": "startLoad", "channel": ch,
        "startTime": ini.strftime(FMT), "endTime": fim.strftime(FMT)})
    url = f"{base()}/cgi-bin/loadfile.cgi?{q}"
    with requests.get(url, auth=HTTPDigestAuth(USER, PASSWORD), stream=True,
                      timeout=(8, 900)) as r:
        if r.status_code in (401, 403): raise RuntimeError("login DVR recusado")
        if r.status_code == 404: return False
        if r.status_code >= 400: raise RuntimeError(f"HTTP {r.status_code}")
        total, first = 0, True
        with open(dav, "wb") as f:
            for c in r.iter_content(1024 * 1024):
                if not c: continue
                if first:
                    first = False
                    if not c.startswith(b"DHAV"): return False
                total += len(c); f.write(c)
        return total >= 1024

def to_mp4(dav, mp4):
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", dav, "-vf", SCALE, "-c:v", "libx264", "-preset", "veryfast",
        "-crf", "28", "-movflags", "+faststart", "-an", mp4], check=True)

def main():
    parts = list(chunks(START, END, CHUNK_MIN))
    total = len(CHANNELS) * len(parts); done = 0
    for ch in CHANNELS:
        folder = os.path.join(OUTDIR, f"camera-{ch:02d}")
        os.makedirs(folder, exist_ok=True)
        for ini, fim in parts:
            done += 1
            tag = f"{ini:%Y-%m-%d_%Hh%M}-{fim:%Hh%M}"
            label = f"[{done}/{total}] cam {ch:02d} {tag}"
            dav = os.path.join(folder, f"ch{ch:02d}_{tag}.dav")
            mp4 = os.path.join(folder, f"ch{ch:02d}_{tag}.mp4")
            try:
                if not download_dav(ch, ini, fim, dav):
                    print(f"{label} -> sem gravacao"); continue
                to_mp4(dav, mp4)
                mb = os.path.getsize(mp4) / (1024 * 1024)
                print(f"{label} -> OK ({mb:.1f} MB)")
            except Exception as e:
                print(f"{label} -> FALHOU: {e}")
            finally:
                if os.path.exists(dav): os.remove(dav)
            time.sleep(1)
    print("Concluido em:", os.path.abspath(OUTDIR))

if __name__ == "__main__":
    main()
```
