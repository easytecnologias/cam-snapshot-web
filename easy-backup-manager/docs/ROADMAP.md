# Roadmap EASY Backup Manager

## MVP 1 - Operacao basica
- Dashboard executivo com PCs, status, falhas, ultimo backup e uso de storage.
- Cadastro multiempresa de maquinas, grupos e clientes.
- Login JWT, RBAC e protecao das rotas.
- Integracao inicial com UrBackup para sincronizar clientes, listar backups e disparar jobs.
- WebSocket para eventos operacionais e atualizacao em tempo real.
- Docker Compose com frontend, backend, PostgreSQL, UrBackup e Nginx.

## MVP 2 - Operacao assistida
- Politicas de backup por grupo.
- Agenda por janela de horario.
- Relatorios PDF por cliente.
- Alertas por e-mail e WhatsApp.
- Retencao configuravel por cliente.
- Registro de auditoria para acoes criticas.

## MVP 3 - Recuperacao
- Fluxo guiado de restauracao de arquivo.
- Restauracao de imagem por maquina.
- Checklist de teste de restore.
- Historico de RPO/RTO por cliente.
- Evidencias de backup para contrato/SLA.

## MVP 4 - SaaS-ready
- Billing por maquina protegida e storage usado.
- S3/Wasabi/Backblaze como tier externo.
- Anti-ransomware com snapshots imutaveis no storage compativel.
- Portal do cliente com permissoes limitadas.
- Provisionamento automatico de novos tenants.
