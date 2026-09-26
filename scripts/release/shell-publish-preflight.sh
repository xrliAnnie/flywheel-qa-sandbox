#!/bin/bash
# FLY-1062 PR4 · shell publish preflight — the SHARED guard for BOTH publish
# paths (the dormant shell-publish.yml workflow AND the founder-local 2FA
# command in the runbook). Publishing the thin shell bakes DEFAULT_ENDPOINT
# into every customer install, so this refuses:
#   1. the .invalid placeholder endpoint (a published shell must point at the
#      real hosting URL — one-line change once Annie picks workers.dev vs a
#      custom domain);
#   2. an npm/node too old for trusted publishing (npm ≥11.5.1, node ≥22.14 —
#      only enforced for the OIDC path, --founder-local skips it);
#   3. a version that already exists on the registry (clean semver never
#      reused);
#   4. a red publish content gate (the packed file set is the registered
#      whitelist and nothing else).
#
# Usage:
#   scripts/release/shell-publish-preflight.sh [--founder-local] [--check-endpoint-only]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHELL_DIR="$ROOT/packages/onboard-shell"

die() { echo "[shell-publish-preflight] $*" >&2; exit 1; }
note() { echo "[shell-publish-preflight] $*"; }

FOUNDER_LOCAL=0
ENDPOINT_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --founder-local) FOUNDER_LOCAL=1 ;;
    --check-endpoint-only) ENDPOINT_ONLY=1 ;;
    *) die "unknown arg: $arg" ;;
  esac
done

# ── 1. endpoint reality ───────────────────────────────────────────────────────
if grep -q 'flywheel\.invalid' "$SHELL_DIR/lib/config.mjs"; then
  die "DEFAULT_ENDPOINT is still the .invalid placeholder — fill the real hosting URL (Annie decides workers.dev vs custom domain) before ANY publish"
fi
note "endpoint guard: DEFAULT_ENDPOINT is not the placeholder"
[ "$ENDPOINT_ONLY" -eq 1 ] && exit 0

command -v npm >/dev/null 2>&1 || die "npm required"
command -v node >/dev/null 2>&1 || die "node required"
command -v jq >/dev/null 2>&1 || die "jq required"

# ── 2. toolchain floor (OIDC trusted publishing prerequisites) ───────────────
if [ "$FOUNDER_LOCAL" -ne 1 ]; then
  NPM_V="$(npm --version)"
  NODE_V="$(node --version | tr -d v)"
  version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
  version_ge "$NPM_V" "11.5.1" || die "npm $NPM_V < 11.5.1 (trusted publishing floor)"
  version_ge "$NODE_V" "22.14.0" || die "node $NODE_V < 22.14 (trusted publishing floor)"
  # trusted publishing also requires repository.url matching the repo — NOT
  # set under the fallback form (it would bake the private repo slug into the
  # public package, tripping the zero-private-URL gate); add it deliberately
  # when the environment form becomes real, with a registered gate exception.
  jq -e '.repository.url' "$SHELL_DIR/package.json" >/dev/null 2>&1 \
    || die "repository.url missing — required for trusted publishing (see runbook: environment-form flip)"
  note "toolchain: npm $NPM_V / node $NODE_V ok"
fi

# ── 3. version never reused ───────────────────────────────────────────────────
NAME="$(jq -r '.name' "$SHELL_DIR/package.json")"
VER="$(jq -r '.version' "$SHELL_DIR/package.json")"
if npm view "$NAME@$VER" version >/dev/null 2>&1; then
  die "$NAME@$VER already exists on the registry — bump the shell version explicitly in a PR"
fi
note "registry: $NAME@$VER not yet published"

# ── 4. publish content gate ───────────────────────────────────────────────────
bash "$SHELL_DIR/__tests__/onboard-shell-publish-gate.test.sh" >/dev/null 2>&1 \
  || die "publish content gate RED — fix before publishing"
note "publish content gate green"

note "PREFLIGHT PASS — publish may proceed ($([ "$FOUNDER_LOCAL" -eq 1 ] && echo founder-local 2FA || echo OIDC workflow) path)"
