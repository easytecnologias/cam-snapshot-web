# SightOps Cam Snapshot

Instalação rápida em servidor Ubuntu: veja [docs/INSTALACAO_RAPIDA_UBUNTU.md](docs/INSTALACAO_RAPIDA_UBUNTU.md).

SightOps Cam Snapshot é uma plataforma web de operação para equipes de CFTV, redes e infraestrutura. O sistema inventaria câmeras IP, DVRs e NVRs, captura evidências visuais, cruza informações com OLTs e switches, e gera relatórios técnicos para uso em campo, auditoria e gestão.

O projeto combina uma API FastAPI, uma interface web leve, deploy com Docker, suporte a PostgreSQL, autenticação multiempresa, isolamento por tenant, health checks e ferramentas auxiliares para integrações com ImgBB, MikroTik Netwatch, Zabbix, Grafana e mapas KMZ/GeoJSON.

## Principais Recursos

- Inventário de câmeras por IP, intervalo ou CIDR.
- Captura de snapshot para câmeras IP, canais de DVR e canais de NVR.
- Autenticação multiempresa com perfis `viewer`, `operator`, `admin` e `owner`.
- Isolamento por tenant para inventários, snapshots, logos, relatórios e configurações.
- Persistência em PostgreSQL ou SQLite.
- Acompanhamento de varreduras em tempo real via WebSocket.
- Rotinas de manutenção para câmeras compatíveis, incluindo ping, reboot, renomeação, NTP, PTZ e troca de senha.
- Enriquecimento com dados de OLT e switches gerenciáveis.
- Exportações e integrações para PDF, XLSX, KMZ, Grafana, Zabbix e MikroTik.
- Deploy com Docker Compose, Nginx como proxy reverso e health checks.

## Estrutura Do Projeto

```text
app/
  api/endpoints/        Rotas HTTP e WebSocket organizadas por domínio
  core/                 Configurações, segurança, observabilidade e paths
  services/             Regras de negócio, integrações e persistência
  cli/tools/            Ferramentas de linha de comando
web/
  pages/                Páginas HTML servidas pelo backend
  static/               JavaScript e CSS compartilhados
deploy/nginx/           Configuração do Nginx
config/                 Arquivos de exemplo
docs/                   Documentação técnica, segurança e produção
scripts/                Scripts de limpeza e manutenção
tools/                  Geradores e auxiliares de integração
```

Pastas de execução como `data/`, `output/`, relatórios gerados, snapshots, bancos de dados e arquivos `.env` locais são ignorados de propósito pelo Git.

## Documentação Técnica

- [Guia de Desenvolvimento](docs/DEVELOPMENT.md): setup, fluxo de trabalho, validações e processo de release.
- [Visão de API e Arquitetura](docs/API_OVERVIEW.md): organização do backend, autenticação, tenants e principais endpoints.
- [Stack Completa Docker](docs/PLATFORM_STACK.md): SightOps, PostgreSQL, Zabbix e Grafana em uma única composição.
- [Baseline de Produção](docs/PRODUCTION_BASELINE.md): premissas operacionais para deploy Linux/Docker.
- [Notas de Segurança](docs/SECURITY.md): regras práticas para segredos, dados runtime e higiene do repositório.

## Requisitos

- Python 3.11 recomendado.
- Docker e Docker Compose para deploy completo.
- `ffmpeg` para fluxos que dependem de vídeo/snapshot.
- PostgreSQL 16 ao usar a stack Docker Compose.

As dependências Python ficam em `requirements.txt`.

## Instalação Local

Crie o arquivo de ambiente local:

```bash
cp .env.example .env
```

Instale as dependências e suba a API:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

No Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Acesse:

```text
http://localhost:8000
```

## Docker Compose

Para subir a stack completa com API, Nginx e PostgreSQL:

```bash
cp .env.example .env
docker compose up --build
```

O layout padrão expõe:

- Web/Nginx: `http://localhost`
- API: `127.0.0.1:8000`
- PostgreSQL: `127.0.0.1:5432`

Antes de usar em produção, edite o `.env` e configure senhas fortes, domínio real e origens permitidas.

## Configuração

Variáveis importantes:

| Variável | Finalidade |
| --- | --- |
| `APP_ENV` | Ambiente de execução, normalmente `development` ou `production`. |
| `ENABLE_DOCS` | Habilita `/docs`, `/redoc` e `/openapi.json`. Em produção, mantenha `0` salvo necessidade explícita. |
| `DATABASE_BACKEND` | Define `sqlite` ou `postgres`. |
| `DATABASE_URL` | URL completa do banco. Se vazia, o app monta usando host, usuário e senha. |
| `DATA_DIR` | Diretório de dados runtime. Padrão: `data`. |
| `ALLOWED_ORIGINS` | Origens CORS separadas por vírgula. Evite `*` em produção. |
| `AUTH_ENABLED` | Ativa a camada de autenticação. |
| `AUTH_REQUIRED` | Exige login nas rotas protegidas da API. |
| `AUTH_LEGACY_OPEN` | Compatibilidade com rotas legadas. Use `0` em produção. |
| `AUTH_TOKEN_TTL_HOURS` | Tempo de vida dos tokens de acesso. |
| `IMGBB_API_KEY` | Chave opcional para publicação de snapshots no ImgBB. |

Nunca versione `.env`, bancos de dados, relatórios gerados, snapshots ou inventários de clientes.

## Autenticação Inicial

Quando o banco de autenticação ainda não possui usuários, crie o primeiro administrador:

```bash
curl -X POST http://localhost:8000/api/auth/bootstrap-admin \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"troque-esta-senha\",\"tenant_slug\":\"default\",\"tenant_name\":\"Default\"}"
```

Depois faça login:

```bash
curl -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"troque-esta-senha\",\"label\":\"web\"}"
```

Use o bearer token retornado nas chamadas autenticadas.

## Health Checks

A aplicação expõe:

- `GET /api/system/health/live` para verificar se o processo está vivo.
- `GET /api/system/health/ready` para verificar banco e dependências runtime.
- `GET /api/system/info` para informações não sensíveis do ambiente.

## Checklist De Produção

- Configure `APP_ENV=production`.
- Configure `ENABLE_DOCS=0`.
- Use `AUTH_ENABLED=1`, `AUTH_REQUIRED=1` e `AUTH_LEGACY_OPEN=0`.
- Troque todas as senhas padrão do `.env`.
- Restrinja `ALLOWED_ORIGINS` ao domínio real da aplicação.
- Mantenha a porta `8000` restrita a localhost ou rede interna.
- Exponha o sistema publicamente apenas via Nginx ou proxy reverso equivalente.
- Restrinja permissões do `.env`, por exemplo `chmod 600 .env`.
- Faça backup de `data/` e `output/`, mas mantenha essas pastas fora do Git.
- Faça deploy a partir de commits/tags revisados, não de edições manuais em produção.

## Comandos Úteis

Validação rápida de import/sintaxe:

```bash
python -B -c "import app.main; print('app.main ok')"
node -e "new Function(require('fs').readFileSync('web/static/app.js','utf8')); console.log('app.js syntax ok')"
```

Limpeza de artefatos gerados:

```bash
./scripts/maintenance/cleanup.sh --dry-run
./scripts/maintenance/cleanup.sh --force
```

No Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\maintenance\cleanup.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File .\scripts\maintenance\cleanup.ps1 -Force
```

## Notas De Segurança

Esta aplicação manipula credenciais de câmeras, bearer tokens, inventário de rede, snapshots e relatórios operacionais. Trate o host e o diretório de dados como infraestrutura sensível.

- Não grave credenciais reais em arquivos de código.
- Não versione `.env`, `data/`, `output/`, snapshots, PDFs ou bancos de dados.
- Rotacione credenciais caso um arquivo local tenha sido exposto.
- Prefira repositórios privados para deployments operacionais.
- Revise exportações antes de compartilhá-las fora da equipe responsável.

## Licença

Consulte o arquivo `LICENSE`.
