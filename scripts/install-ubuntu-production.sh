#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/easytecnologias/cam-snapshot-web.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/sightops/cam-snapshot-web}"
PUBLIC_IP="${PUBLIC_IP:-}"
USE_BUILD=0
INSTALL_PORTAINER=1
FORCE_ENV=0

usage() {
  cat <<'EOF'
Uso:
  sudo bash scripts/install-ubuntu-production.sh [opcoes]

Opcoes:
  --ip IP_OU_HOST        IP/host publico usado no ALLOWED_ORIGINS.
  --dir CAMINHO         Pasta de instalacao. Padrao: /opt/sightops/cam-snapshot-web
  --repo URL            Repositorio Git. Padrao: GitHub oficial do projeto.
  --build               Builda a imagem localmente no servidor.
  --no-portainer        Nao instala/sobe Portainer.
  --force-env           Recria .env.platform, guardando backup do anterior.
  -h, --help            Mostra esta ajuda.

Exemplo rapido:
  sudo bash scripts/install-ubuntu-production.sh --ip 10.10.12.7
EOF
}

log() {
  printf '\n[SightOps] %s\n' "$*"
}

die() {
  printf '\n[ERRO] %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ip)
      PUBLIC_IP="${2:-}"
      shift 2
      ;;
    --dir)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    --repo)
      REPO_URL="${2:-}"
      shift 2
      ;;
    --build)
      USE_BUILD=1
      shift
      ;;
    --no-portainer)
      INSTALL_PORTAINER=0
      shift
      ;;
    --force-env)
      FORCE_ENV=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Opcao desconhecida: $1"
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  die "Execute como root. Exemplo: sudo bash scripts/install-ubuntu-production.sh --ip 10.10.12.7"
fi

if [[ -z "$PUBLIC_IP" ]]; then
  PUBLIC_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
if [[ -z "$PUBLIC_IP" ]]; then
  die "Nao consegui detectar o IP. Use --ip IP_DO_SERVIDOR."
fi

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

install_basics() {
  log "Instalando pacotes basicos..."
  apt-get update
  apt-get install -y ca-certificates curl gnupg git openssl ufw
}

random_secret() {
  if command_exists openssl; then
    openssl rand -base64 32 | tr -d '\n'
  else
    date +%s%N | sha256sum | awk '{print $1}'
  fi
}

install_docker() {
  if command_exists docker && docker compose version >/dev/null 2>&1; then
    log "Docker e Docker Compose ja estao instalados."
    return
  fi

  log "Instalando Docker oficial..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

configure_firewall() {
  if ! command_exists ufw; then
    apt-get update
    apt-get install -y ufw
  fi
  log "Liberando portas no UFW..."
  ufw allow OpenSSH >/dev/null || true
  ufw allow 80/tcp >/dev/null || true
  ufw allow 3000/tcp >/dev/null || true
  ufw allow 8081/tcp >/dev/null || true
  ufw allow 10051/tcp >/dev/null || true
  ufw allow 9000/tcp >/dev/null || true
  ufw allow 9443/tcp >/dev/null || true
  ufw --force enable >/dev/null || true
}

install_portainer() {
  if [[ "$INSTALL_PORTAINER" -ne 1 ]]; then
    return
  fi
  if docker ps -a --format '{{.Names}}' | grep -Fxq portainer; then
    log "Portainer ja existe. Garantindo que esteja ligado..."
    docker start portainer >/dev/null || true
    return
  fi
  log "Subindo Portainer..."
  docker volume create portainer_data >/dev/null
  docker run -d \
    --name portainer \
    --restart=unless-stopped \
    -p 9000:9000 \
    -p 9443:9443 \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v portainer_data:/data \
    portainer/portainer-ce:latest >/dev/null
}

checkout_project() {
  log "Preparando projeto em ${INSTALL_DIR}..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    git -C "$INSTALL_DIR" pull --ff-only
  elif [[ -e "$INSTALL_DIR" ]]; then
    die "A pasta ${INSTALL_DIR} ja existe e nao parece ser um repositorio Git."
  else
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi
}

write_env() {
  cd "$INSTALL_DIR"
  if [[ -f .env.platform && "$FORCE_ENV" -ne 1 ]]; then
    log ".env.platform ja existe. Mantendo configuracao atual."
    return
  fi

  if [[ -f .env.platform ]]; then
    cp .env.platform ".env.platform.backup-$(date +%Y%m%d-%H%M%S)"
  fi

  log "Gerando .env.platform com senhas fortes..."
  cat > .env.platform <<EOF
TZ=America/Sao_Paulo
APP_ENV=production
ENABLE_DOCS=0
AUTH_REQUIRED=1
AUTH_LEGACY_OPEN=0
ENABLE_LEGACY_STATE_IMPORT=0

CAM_SNAPSHOT_IMAGE=ghcr.io/easytecnologias/cam-snapshot-web:latest

SIGHTOPS_HTTP_PORT=80
SIGHTOPS_POSTGRES_PORT=5432
ZABBIX_WEB_PORT=8081
ZABBIX_SERVER_PORT=10051
GRAFANA_PORT=3000

ALLOWED_ORIGINS=http://${PUBLIC_IP}
TRUSTED_PROXIES=127.0.0.1

SIGHTOPS_DB=sightops
SIGHTOPS_DB_USER=sightops
SIGHTOPS_DB_PASSWORD=$(random_secret)

ZABBIX_DB=zabbix
ZABBIX_DB_USER=zabbix
ZABBIX_DB_PASSWORD=$(random_secret)

ZBX_CACHESIZE=256M
ZBX_HISTORYCACHESIZE=128M
ZBX_TRENDCACHESIZE=128M
ZBX_VALUECACHESIZE=128M
ZABBIX_AGENT_HOSTNAME=sightops-docker-host

GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=$(random_secret)
GRAFANA_INSTALL_PLUGINS=alexanderzobnin-zabbix-app

IMGBB_API_KEY=
EOF
  chmod 600 .env.platform
}

start_stack() {
  cd "$INSTALL_DIR"
  log "Baixando imagens e subindo stack..."
  if [[ "$USE_BUILD" -eq 1 ]]; then
    docker compose --env-file .env.platform \
      -f docker-compose.platform.yml \
      -f docker-compose.platform.build.yml \
      up -d --build
  else
    docker compose --env-file .env.platform -f docker-compose.platform.yml pull
    docker compose --env-file .env.platform -f docker-compose.platform.yml up -d
  fi
}

print_status() {
  cd "$INSTALL_DIR"
  log "Status dos containers:"
  docker compose --env-file .env.platform -f docker-compose.platform.yml ps

  log "Acessos:"
  printf '  SightOps:  http://%s/\n' "$PUBLIC_IP"
  printf '  Grafana:   http://%s:3000/\n' "$PUBLIC_IP"
  printf '  Zabbix:    http://%s:8081/\n' "$PUBLIC_IP"
  if [[ "$INSTALL_PORTAINER" -eq 1 ]]; then
    printf '  Portainer: http://%s:9000/\n' "$PUBLIC_IP"
  fi
  printf '\nCredenciais importantes foram salvas em: %s/.env.platform\n' "$INSTALL_DIR"
  printf 'Login inicial do SightOps: admin_teste / admin_teste\n'
  printf 'Troque a senha inicial apos o primeiro acesso.\n'
}

install_basics
install_docker
configure_firewall
install_portainer
checkout_project
write_env
start_stack
print_status
