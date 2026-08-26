#!/usr/bin/env bash
# Push incremental de los chunks de Konachan a GitHub.
# Sube commit por commit (rama temporal), verifica cada uno, y al final
# actualiza main y limpia las ramas temporales.
#
# Uso: bash push_konachan.sh
# Reanudable: si se corta, solo vuelve a correrlo (omite lo ya subido).
set -u

cd "$(dirname "$0")"
REPO="git@github.com:leriart/Wallpapers.git"
SSH="ssh -i ~/.ssh/github_ed25519 -o ServerAliveInterval=15 -o ServerAliveCountMax=6"

# Commit base del remote (main actual en GitHub)
BASE="41998fa6f86ea6ccf11a9949e4a7b8643d1ece95"

# Commits a subir, en orden (docs + chunks 0..44)
COMMITS=$(git log --reverse --format='%H %s' ${BASE}..HEAD | awk '{print $1}')

COUNT=$(echo "$COMMITS" | wc -l)
echo "Commits por subir: $COUNT"
i=0
for c in $COMMITS; do
  i=$((i+1))
  short=$(git rev-parse --short $c)
  msg=$(git log -1 --format='%s' $c | cut -c1-50)
  ref="upload-kd-$(printf '%03d' $i)"
  # ¿Ya está en el remote?
  if git ls-remote origin refs/heads/$ref 2>/dev/null | grep -q "$c"; then
    echo "[$i/$COUNT] $short $msg — ya subido, omito"
    continue
  fi
  echo "[$i/$COUNT] Subiendo $short $msg ..."
  GIT_SSH_COMMAND="$SSH" git push origin "$c:refs/heads/$ref" || {
    echo "  FALLÓ en $short ($msg). Reintenta cuando la conexión mejore."
    echo "  Reanuda con: bash push_konachan.sh"
    exit 1
  }
done

echo "=== Todos los objetos subidos. Actualizando main ==="
GIT_SSH_COMMAND="$SSH" git push origin HEAD:main || {
  echo "Push de main falló. Reanuda con: bash push_konachan.sh"
  exit 1
}

echo "=== Limpiando ramas temporales ==="
REMOTES=$(git ls-remote origin | grep 'refs/heads/upload-kd-' | awk '{print $2}')
if [ -n "$REMOTES" ]; then
  GIT_SSH_COMMAND="$SSH" git push origin --delete $REMOTES 2>/dev/null
fi
echo "=== LISTO ==="
