# Sellable Baseline

Este checklist define o minimo para entregar o SightOps em implantacoes assistidas.

## Antes De Entregar

- Confirmar `APP_ENV=production`.
- Confirmar `ENABLE_DOCS=0`.
- Confirmar `AUTH_ENABLED=1`, `AUTH_REQUIRED=1` e `AUTH_LEGACY_OPEN=0`.
- Confirmar `ALLOWED_ORIGINS` apontando apenas para o IP ou dominio do cliente.
- Confirmar PostgreSQL `reachable` em `/api/system/health/ready`.
- Confirmar que `sightops-api`, `sightops-nginx` e `sightops-postgres` estao `healthy`.
- Criar ao menos um usuario administrador e um usuario operador.
- Salvar a chave ImgBB pela tela e testar upload em uma camera selecionada.
- Gerar PDF de inventario com nome/logo do cliente.
- Gerar integracao Zabbix com ao menos uma camera com `imgbb_url`.
- Exportar backup completo em ZIP e validar que o arquivo foi baixado.

## Teste Funcional

- Scan Camera IP com snapshot.
- Enriquecimento por OLT.
- Upload ImgBB pela tabela do inventario.
- Abertura do drawer pelo IP e visualizacao da imagem.
- Preview PDF.
- Exportacao PDF.
- Script Zabbix.
- Tela de manutencao: ping e live.
- DVR/NVR: carregar inventario e atualizar ImgBB quando aplicavel.

## Seguranca

- Nao deixar credenciais reais em arquivos versionados.
- Proteger `.env.platform` com permissao restrita no servidor.
- Nao expor a porta interna da API publicamente; usar apenas o Nginx.
- Live de camera deve usar sessao temporaria; senha de camera nao deve aparecer na URL.
- Backups devem ser armazenados fora do diretorio publico do Nginx.

## Rotina De Atualizacao

1. Fazer commit e push para `main`.
2. Aguardar GitHub Actions publicar `ghcr.io/easytecnologias/cam-snapshot-web:latest`.
3. No servidor, executar:

```bash
cd /opt/sightops/cam-snapshot-web
docker compose --env-file .env.platform -f docker-compose.platform.yml pull cam-snapshot-api
docker compose --env-file .env.platform -f docker-compose.platform.yml up -d cam-snapshot-api sightops-nginx
docker ps --filter name=sightops
```

4. Validar:

```bash
curl -fsS http://127.0.0.1/api/system/health/live
curl -fsS http://127.0.0.1/api/system/health/ready
```
