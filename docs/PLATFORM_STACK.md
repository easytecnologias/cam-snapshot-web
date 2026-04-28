# Stack Completa Com Docker Compose

Este guia explica como entregar o SightOps Cam Snapshot junto com banco de dados, Zabbix e Grafana.

## Estratégia De Entrega

Existem duas formas boas de entregar o sistema:

1. **Build local a partir do GitHub**

   O cliente ou servidor clona o repositório e roda o Compose com build local.

   Vantagem: simples no começo, sem depender de registry.

   Desvantagem: cada servidor precisa baixar o código e compilar a imagem.

2. **Imagem publicada em um registry**

   O GitHub Actions cria a imagem e publica em:

   ```text
   ghcr.io/easytecnologias/cam-snapshot-web
   ```

   Vantagem: instalação mais profissional, rápida e repetível. O servidor só baixa a imagem pronta.

   Desvantagem: exige configurar o pacote no GitHub Container Registry. Se o repositório for privado, o servidor precisa autenticar no GHCR.

Para produção, a recomendação é usar imagem publicada no **GitHub Container Registry (GHCR)**. Como o código já está no GitHub, o GHCR evita a necessidade inicial de Docker Hub.

## Serviços Da Stack

O arquivo `docker-compose.platform.yml` sobe:

- `cam-snapshot-api`: API FastAPI do SightOps.
- `sightops-nginx`: proxy reverso para a aplicação web.
- `sightops-postgres`: banco do SightOps.
- `zabbix-postgres`: banco dedicado do Zabbix.
- `zabbix-server`: servidor Zabbix.
- `zabbix-web`: interface web do Zabbix.
- `zabbix-agent2`: agente Zabbix básico dentro da rede Docker.
- `grafana`: Grafana OSS com plugin Zabbix instalado.

## Portas Padrão

| Serviço | Porta |
| --- | --- |
| SightOps Web | `80` |
| Grafana | `3000` |
| Zabbix Web | `8081` |
| Zabbix Server | `10051` |
| PostgreSQL SightOps | `127.0.0.1:5432` |

As portas podem ser alteradas no `.env.platform`.

## Instalação Usando Imagem Pronta

Copie o arquivo de ambiente:

```bash
cp .env.platform.example .env.platform
```

Edite as senhas:

```bash
nano .env.platform
```

Suba a stack:

```bash
docker compose --env-file .env.platform -f docker-compose.platform.yml up -d
```

Acesse:

```text
SightOps: http://localhost
Grafana:  http://localhost:3000
Zabbix:   http://localhost:8081
```

## Instalação Fazendo Build Local

Use este modo quando a imagem ainda não estiver publicada ou quando estiver testando mudanças locais:

```bash
cp .env.platform.example .env.platform
docker compose --env-file .env.platform \
  -f docker-compose.platform.yml \
  -f docker-compose.platform.build.yml \
  up -d --build
```

## Publicação Da Imagem

O workflow `.github/workflows/docker-image.yml` publica a imagem automaticamente no GHCR quando houver push na `main` ou tag `v*.*.*`.

Tags geradas:

- `latest` para a branch `main`.
- `sha-<commit>` para rastreabilidade.
- `vX.Y.Z` quando uma tag de release for publicada.

Exemplo de release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

## Produção

Antes de entregar para cliente ou produção:

- Troque todas as senhas em `.env.platform`.
- Configure `ALLOWED_ORIGINS` com o domínio real.
- Use HTTPS no proxy externo ou load balancer.
- Restrinja acesso direto a PostgreSQL.
- Faça backup dos volumes Docker.
- Use tags versionadas em vez de `latest` para ambientes críticos.

Exemplo:

```env
CAM_SNAPSHOT_IMAGE=ghcr.io/easytecnologias/cam-snapshot-web:v1.0.0
```

## Backup Dos Volumes

Volumes principais:

- `sightops_data`
- `sightops_output`
- `sightops_postgres`
- `zabbix_postgres`
- `grafana_data`

Esses volumes contêm dados de operação e devem entrar na rotina de backup.
