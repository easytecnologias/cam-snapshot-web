# EASY Backup Manager

MVP corporativo de backup integrado ao `cam-snapshot-web`, usando UrBackup como engine principal.

## Subir ambiente

```bash
cp .env.example .env
docker compose up -d --build
```

Painel:

```text
http://SERVER:8090
```

UrBackup:

```text
http://SERVER:55414
```

## Observação sobre UrBackup Docker

A imagem oficial usada é `uroni/urbackup-server:latest`. Ela recomenda `network_mode: host` para descoberta/comunicação dos clientes UrBackup e usa:

- `/backups` para dados de backup
- `/var/urbackup` para banco/configuração do UrBackup

## Estrutura

```text
backend/   API Node.js + TypeScript
frontend/  React + Tailwind
nginx/     reverse proxy
storage/   estado persistente do UrBackup
backups/   backups dos clientes
docs/      arquitetura e operação
```
