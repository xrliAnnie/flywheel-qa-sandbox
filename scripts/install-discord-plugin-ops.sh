#!/bin/bash
# FLY-1676: publish managed Discord plugin operations and pointer marketplace.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${REPO_ROOT}/scripts/discord-plugin"
BIN_DIR="${HOME}/.flywheel/bin"
MARKETPLACE_SOURCE="${REPO_ROOT}/marketplaces/flywheel-plugins"
REGISTRAR="${FLYWHEEL_DISCORD_REGISTRAR:-${REPO_ROOT}/scripts/register-local-marketplace.sh}"

for source in \
  check-discord-plugin.sh \
  update-discord-plugin.sh \
  check-discord-plugin-legacy-overlay.sh \
  update-discord-plugin-legacy-overlay.sh; do
  [ -f "${SOURCE_DIR}/${source}" ] \
    || { echo "ERROR: canonical Discord operation is missing: ${SOURCE_DIR}/${source}" >&2; exit 1; }
done
[ -f "$REGISTRAR" ] || { echo "ERROR: marketplace registrar is missing: $REGISTRAR" >&2; exit 1; }

mkdir -p "$BIN_DIR"
for source in \
  check-discord-plugin.sh \
  update-discord-plugin.sh \
  check-discord-plugin-legacy-overlay.sh \
  update-discord-plugin-legacy-overlay.sh; do
  staging="${BIN_DIR}/.${source}.staging.$$"
  cp "${SOURCE_DIR}/${source}" "$staging"
  chmod 0755 "$staging"
  mv "$staging" "${BIN_DIR}/${source}"
done

bash "$REGISTRAR" flywheel-plugins "$MARKETPLACE_SOURCE"
echo "installed Discord plugin operations in ${BIN_DIR}"
