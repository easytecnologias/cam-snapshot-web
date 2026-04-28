#!/usr/bin/env bash
set -euo pipefail

# cleanup.sh — limpeza segura do cam-snapshot-web
# Remove caches/artefatos gerados, SEM apagar inventário (JSON) nem configurações.

DRYRUN=0
FORCE=0

usage() {
  cat <<'EOF'
Uso:
  ./scripts/maintenance/cleanup.sh [--dry-run] [--force]

Opções:
  --dry-run   Mostra o que seria removido, sem remover.
  --force     Não pede confirmação.

O que remove (quando existir):
  - __pycache__/ , *.pyc
  - thumbs/ (miniaturas geradas)
  - saida/snapshots_manual/ (pasta de rascunhos)
  - logs temporários (se houver)

O que NÃO remove:
  - saida/cam-inventory.json
  - config/ e .env
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRYRUN=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Argumento desconhecido: $1" >&2; usage; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

confirm() {
  [[ "$FORCE" = "1" ]] && return 0
  read -r -p "Confirma limpeza em '$ROOT'? (digite 'sim' para continuar): " ans
  [[ "$ans" == "sim" ]]
}

rm_path() {
  local p="$1"
  if [[ -e "$p" ]]; then
    if [[ "$DRYRUN" = "1" ]]; then
      echo "[DRY-RUN] Remover: $p"
    else
      echo "Removendo: $p"
      rm -rf -- "$p"
    fi
  fi
}

find_and_rm() {
  local expr="$1"
  if [[ "$DRYRUN" = "1" ]]; then
    echo "[DRY-RUN] find $ROOT $expr"
    return 0
  fi
  # shellcheck disable=SC2086
  find "$ROOT" $expr -print -delete 2>/dev/null || true
}

confirm || { echo "Cancelado."; exit 1; }

echo ">> Limpando artefatos..."

# caches python
find_and_rm "-type d -name __pycache__"
find_and_rm "-type f -name '*.pyc'"

# thumbs e rascunhos
rm_path "$ROOT/thumbs"
rm_path "$ROOT/saida/thumbs"
rm_path "$ROOT/saida/snapshots_manual"

echo ">> OK."
