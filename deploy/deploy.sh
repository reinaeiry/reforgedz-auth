#!/usr/bin/env bash
# Deploys reforgedz-auth to a Pterodactyl Node.js container on the EU box.
#
# Prereqs (one-time, in Pterodactyl panel UI — see EU-DEPLOY.md):
#   1. Create a Node.js (yolks/nodejs:22) server. Note its volume UUID.
#   2. Set startup env vars (PORT, COOKIE_DOMAIN, SMTP_*, etc.). See env.production.template.
#   3. Add the Cloudflare Tunnel public-hostname route auth.reforgedz.net -> http://localhost:<PORT>.
#
# Usage:
#   VOLUME_UUID=<uuid-from-panel> ./deploy.sh
# Optional:
#   EU_HOST=144.76.199.155  (default)
#   EU_USER=root            (default)
#
# Idempotent: rsync only the source files, never the .env or keys.

set -euo pipefail

EU_HOST="${EU_HOST:-144.76.199.155}"
EU_USER="${EU_USER:-root}"
VOLUME_UUID="${VOLUME_UUID:-}"

if [[ -z "$VOLUME_UUID" ]]; then
  echo "ERROR: VOLUME_UUID is required. Look it up in the Pterodactyl panel after creating the server."
  echo "Usage: VOLUME_UUID=<uuid> $0"
  exit 1
fi

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_BASE="/var/lib/pterodactyl/volumes/${VOLUME_UUID}"

echo "[deploy] Source : $SRC_DIR"
echo "[deploy] Remote : ${EU_USER}@${EU_HOST}:${REMOTE_BASE}"
echo

# Sanity-check the volume exists before we push.
ssh -o ConnectTimeout=10 "${EU_USER}@${EU_HOST}" "test -d '${REMOTE_BASE}'" || {
  echo "ERROR: Remote volume directory does not exist: ${REMOTE_BASE}"
  echo "Check the volume UUID in the Pterodactyl panel."
  exit 1
}

# Rsync source. node_modules, keys, data, .env all explicitly excluded so we
# never clobber generated state on the container.
rsync -avz --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'data/auth.db*' \
  --exclude 'keys/' \
  --exclude '.env' \
  --exclude '*.log' \
  --exclude 'deploy/' \
  "${SRC_DIR}/" "${EU_USER}@${EU_HOST}:${REMOTE_BASE}/"

# npm install + key generation on the remote, idempotent.
ssh "${EU_USER}@${EU_HOST}" bash -lc "'
  set -e
  cd ${REMOTE_BASE}
  mkdir -p data keys
  chown -R pterodactyl:pterodactyl data keys
  echo \"[remote] installing deps\"
  sudo -u pterodactyl /usr/bin/npm install --omit=dev --no-audit --no-fund
  if [[ ! -f keys/ed25519-private.pem ]]; then
    echo \"[remote] generating Ed25519 keypair\"
    sudo -u pterodactyl /usr/bin/node scripts/generate-keys.js
  else
    echo \"[remote] keys already present, skipping generation\"
  fi
  chmod 600 keys/ed25519-private.pem 2>/dev/null || true
  echo \"[remote] PUBLIC KEY (paste this into admin/transcripts AUTH_PUBLIC_KEY_PEM):\"
  cat keys/ed25519-public.pem
'"

echo
echo "[deploy] Done. Now:"
echo "  1. In the Pterodactyl panel, set the container startup variables from deploy/.env.production.template."
echo "  2. Set SMTP_PASS from the noreply@reforgedz.net mailbox in the Mailcow UI."
echo "  3. Start (or restart) the container."
echo "  4. SSH in and run: cd ${REMOTE_BASE} && sudo -u pterodactyl npm run bootstrap -- 'first-manager'"
echo "  5. Open the printed invite link in a browser and finish setup."
