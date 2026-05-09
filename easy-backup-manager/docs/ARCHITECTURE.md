# EASY Backup Manager - Arquitetura MVP

## Objetivo

Criar um painel corporativo SaaS-ready para pequenas e médias empresas, usando UrBackup como engine de backup e uma camada própria para painel, automação, multiempresa, alertas e relatórios.

## Decisão principal

O projeto não implementa a engine de backup do zero. O UrBackup é responsável por backup, retenção, clientes e restauração. O EASY Backup Manager orquestra, monitora e apresenta a operação.

Referências confirmadas:

- Docker Hub `uroni/urbackup-server`: imagem multiarch, volumes `/backups` e `/var/urbackup`, recomendação de `network_mode: host`, web UI em `55414`.
- UrBackup Downloads: clientes Windows/Linux/macOS e server, webinterface padrão `55414`.

## Componentes

- `frontend`: React + Tailwind, dashboard operacional.
- `backend`: Node.js + TypeScript, REST API, JWT, RBAC, WebSocket.
- `postgres`: banco transacional.
- `urbackup-server`: engine oficial `uroni/urbackup-server`.
- `nginx`: reverse proxy para painel, API e UrBackup.

## Fluxo

```text
PC Cliente
  -> UrBackup Client
  -> UrBackup Server Docker
  -> Storage local/NAS
  -> EASY Backup Manager
```

## Multiempresa

Toda máquina pertence a um `Tenant`. Usuários carregam `tenantId` no JWT. O backend filtra dados por `tenantId`.

## Roadmap

1. MVP com cadastro, dashboard, sync básico e start backup.
2. Worker de sincronização com UrBackup.
3. Alertas WhatsApp/e-mail.
4. Retenção, SLA e relatórios.
5. S3/NAS, imutabilidade e anti-ransomware.
6. Restore workflow, PXE/bare-metal e billing.
