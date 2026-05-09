# Checklist de Produção

- Definir `POSTGRES_PASSWORD` e `JWT_SECRET` fortes.
- Criar usuário Linux dedicado para os volumes.
- Ajustar `URBACKUP_PUID` e `URBACKUP_PGID`.
- Montar storage em `./backups` ou bind mount para NAS.
- Testar restauração antes de vender o ambiente.
- Configurar retenção no UrBackup.
- Habilitar TLS no Nginx em produção.
- Proteger `/urbackup/` por VPN, IP allowlist ou autenticação adicional.
- Configurar monitoramento de disco.
- Configurar backup do PostgreSQL.
- Documentar processo de restore por cliente.
- Validar throughput para 40+ endpoints.
