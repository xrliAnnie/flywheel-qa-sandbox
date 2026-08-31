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

die() { echo "[shell-publish-preflight] $*" >&2; exit 1; }

# Every read of an external command's output below requires exit 0 AND a sane
# value before it is trusted. A probe that fails but still prints something
# usable-looking is NOT authority: empty/garbage must read as "cannot confirm"
# -> refuse, never as "not configured" -> proceed.
# Codex R5#1: the old form nested an UNCHECKED external `dirname` inside the
# command substitution — only the outer `cd ... && pwd` exit was checked. A
# `dirname` on PATH that printed a different valid release tree and exited
# non-zero would redirect ROOT to that other tree, and the gate would then
# inspect the wrong package. Derive the script dir with Bash parameter expansion
# (a builtin — it cannot fail-open to a foreign PATH binary) instead.
SELF="${BASH_SOURCE[0]}"
SELF_DIR="${SELF%/*}"
[ "$SELF_DIR" = "$SELF" ] && SELF_DIR="."   # no slash in path → script is in cwd
ROOT="$(cd "$SELF_DIR/../.." && pwd)"; ROOT_RC=$?
[ "$ROOT_RC" -eq 0 ] \
  || die "cannot resolve the repo root (exit $ROOT_RC) — refusing rather than guessing which tree we are publishing from"
[ -n "$ROOT" ] && [ -d "$ROOT" ] \
  || die "resolved repo root is empty or not a directory ('$ROOT') — refusing"
SHELL_DIR="$ROOT/packages/onboard-shell"
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
# QA ff38290f F2: this gate used a bare `grep -q ... "$CONFIG"`. A missing file
# makes grep exit 2, the `if` reads false, and the script announced "DEFAULT_ENDPOINT
# is not the placeholder" and continued — a file that does not exist is not evidence
# that the endpoint is real. --check-endpoint-only then exited 0, indistinguishable
# from a genuine pass: the same phantom-control class this PR exists to remove.
# Existence and readability are checked FIRST, so absence cannot read as "no
# placeholder found".
CONFIG="$SHELL_DIR/lib/config.mjs"
[ -f "$CONFIG" ] \
  || die "cannot read $CONFIG — the endpoint gate cannot confirm DEFAULT_ENDPOINT is real, refusing. A missing file is not a passing check."
[ -r "$CONFIG" ] \
  || die "$CONFIG exists but is not readable — the endpoint gate cannot run, refusing"
GREP_OUT="$(grep -c 'flywheel\.invalid' "$CONFIG" 2>&1)"; GREP_RC=$?
# grep exits 0 (matched) or 1 (no match); anything else is a probe failure, not a
# verdict, and must not be read as "clean".
case "$GREP_RC" in
  0) die "DEFAULT_ENDPOINT is still the .invalid placeholder — fill the real hosting URL (Annie decides workers.dev vs custom domain) before ANY publish" ;;
  1) : ;;
  *) die "endpoint gate probe failed (grep exit $GREP_RC): $GREP_OUT — cannot confirm DEFAULT_ENDPOINT, refusing" ;;
esac
note "endpoint guard: DEFAULT_ENDPOINT is not the placeholder"
[ "$ENDPOINT_ONLY" -eq 1 ] && exit 0

command -v npm >/dev/null 2>&1 || die "npm required"
command -v node >/dev/null 2>&1 || die "node required"
command -v jq >/dev/null 2>&1 || die "jq required"

# ── 2. toolchain floor (OIDC trusted publishing prerequisites) ───────────────
if [ "$FOUNDER_LOCAL" -ne 1 ]; then
  NPM_V="$(npm --version)"; NPM_V_RC=$?
  [ "$NPM_V_RC" -eq 0 ] \
    || die "npm --version failed (exit $NPM_V_RC) — cannot confirm the npm toolchain floor, refusing. A probe that failed but still printed something is not authority."
  NODE_V="$(node --version | tr -d v)"; NODE_V_RC=$?
  [ "$NODE_V_RC" -eq 0 ] \
    || die "node --version failed (exit $NODE_V_RC) — cannot confirm the node toolchain floor, refusing"
  # An exit-0 probe can still print garbage; require a real version grammar
  # before comparing, or sort -V silently orders nonsense and we "pass".
  # Codex R4: the first attempt used a GLOB `[0-9]*.[0-9]*.[0-9]*`, where `*` means
  # "any characters" — not "more digits". `99garbage.99junk.99trash` matched it and
  # sort -V then ranked it above both floors. A guard that accepts garbage is the
  # same phantom control it was written to remove. Anchored regex instead.
  is_semverish() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.+-][0-9A-Za-z.-]+)?$ ]]; }
  is_semverish "$NPM_V" \
    || die "npm --version printed '$NPM_V', which is not a version — refusing rather than comparing nonsense"
  is_semverish "$NODE_V" \
    || die "node --version printed '$NODE_V', which is not a version — refusing rather than comparing nonsense"
  version_ge() {
    local lowest
    lowest="$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)"; local rc=$?
    [ "$rc" -eq 0 ] || die "version comparison pipeline failed (exit $rc) — cannot confirm the toolchain floor, refusing"
    [ "$lowest" = "$2" ]
  }
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
# FLY-1323 (Codex code R2): NAME/VER are the LAST unguarded reads in this gate,
# and NAME is the most load-bearing of all — it derives SCOPE (an empty NAME
# silently skips the whole scoped-registry branch) and feeds `npm view NAME@VER`.
# Audited the full probe surface rather than patching the one Codex happened to
# name: EVERY read here now requires exit 0 AND a non-empty, sane value.
NAME="$(jq -r '.name' "$SHELL_DIR/package.json")"; NAME_RC=$?
[ "$NAME_RC" -eq 0 ] \
  || die "jq probe of package.json .name failed (exit $NAME_RC) — cannot identify the package, refusing"
case "$NAME" in
  ""|null) die "package.json .name is empty/null — cannot identify the package or derive its scope, refusing" ;;
esac
VER="$(jq -r '.version' "$SHELL_DIR/package.json")"; VER_RC=$?
[ "$VER_RC" -eq 0 ] \
  || die "jq probe of package.json .version failed (exit $VER_RC) — cannot check version reuse, refusing"
case "$VER" in
  ""|null) die "package.json .version is empty/null — cannot check version reuse, refusing" ;;
esac
# FLY-1323: FAIL CLOSED. This used to treat ANY `npm view` failure (DNS, TLS,
# registry 5xx, wrong registry, auth) as "version is free" and print a green
# PREFLIGHT PASS — a fail-OPEN check on the one gate that stops a clean semver
# being reused. Only an explicit E404 means "not published"; anything else is a
# lookup we could not perform, and an unperformed check is never a pass.
# FLY-1323 (Codex R2): pin the lookup AND the publish target to npmjs. An E404
# from some OTHER registry is not evidence the version is free on npmjs, and a
# misconfigured registry could send the first customer-facing package somewhere
# it was never meant to go. Assert the configured registry, then query npmjs
# explicitly rather than trusting ambient config.
NPMJS="https://registry.npmjs.org/"
is_npmjs() { [ "$1" = "$NPMJS" ] || [ "$1" = "${NPMJS%/}" ]; }

# FLY-1323 (Codex code R1 HIGH-1): the `npm config get` probe MUST succeed. A
# failed probe with empty stdout is NOT evidence of "no override" — it is a check
# we could not perform, and an unperformed check never passes. `X="$(cmd)"; RC=$?`
# preserves cmd's exit; do NOT wrap the probe in a die-ing function called via
# command substitution (its exit would only kill the subshell → fail-open again).
CONFIGURED_REGISTRY="$(npm config get registry 2>/dev/null)"; CR_RC=$?
[ "$CR_RC" -eq 0 ] \
  || die "npm config get registry failed (exit $CR_RC) — cannot confirm the default publish registry, refusing"
is_npmjs "$CONFIGURED_REGISTRY" \
  || die "npm registry is '$CONFIGURED_REGISTRY', expected $NPMJS — refusing to preflight (or publish) against a non-npmjs registry"

# A SCOPED override (`@flywheel-ai:registry=…` in any .npmrc) beats the default for
# both `npm view` and the actual `npm publish`, so checking only the default would
# pass while the first customer package went elsewhere. Resolve the package's own
# scope and pin that too — probe success required before "empty == absent".
SCOPE="${NAME%%/*}"   # "@flywheel-ai" from "@flywheel-ai/onboard"
case "$SCOPE" in
  @*)
    SCOPED_REGISTRY="$(npm config get "${SCOPE}:registry" 2>/dev/null)"; SR_RC=$?
    [ "$SR_RC" -eq 0 ] \
      || die "npm config get ${SCOPE}:registry failed (exit $SR_RC) — cannot confirm the scoped publish registry, refusing"
    case "$SCOPED_REGISTRY" in
      ""|undefined|null) : ;;   # genuinely unset (probe SUCCEEDED, value absent)
      *) is_npmjs "$SCOPED_REGISTRY" \
           || die "scoped registry ${SCOPE}:registry is '$SCOPED_REGISTRY' — it overrides the default for publish; refusing"
         note "scoped registry pinned: ${SCOPE} → $SCOPED_REGISTRY" ;;
    esac
    ;;
esac

# package.json's own `publishConfig.registry` ALSO overrides the publish target
# (npm honours it over both default and scoped config). PR-2 must touch this
# package again, so pin it here rather than trust it stays unset (Codex R1 HIGH-1).
# Codex code R2: this probe had the SAME fail-open as the two npm ones above —
# a `jq` that exits non-zero with empty stdout was read as "not configured" and
# sailed through to PASS. Every probe in this gate requires exit 0 before its
# empty output may be interpreted as absence. No exceptions: an unperformed
# check is never a pass.
PUBCFG_REGISTRY="$(jq -r '.publishConfig.registry // empty' "$SHELL_DIR/package.json")"; PC_RC=$?
[ "$PC_RC" -eq 0 ] \
  || die "jq probe of package.json publishConfig.registry failed (exit $PC_RC) — cannot confirm the publish target, refusing"
if [ -n "$PUBCFG_REGISTRY" ]; then
  is_npmjs "$PUBCFG_REGISTRY" \
    || die "package.json publishConfig.registry is '$PUBCFG_REGISTRY' — it overrides the publish target; refusing"
  note "publishConfig.registry pinned: $PUBCFG_REGISTRY"
fi
note "registry pinned: $CONFIGURED_REGISTRY"
VIEW_OUT="$(npm view --registry "$NPMJS" "$NAME@$VER" version 2>&1)" && VIEW_RC=0 || VIEW_RC=$?
if [ "$VIEW_RC" -eq 0 ]; then
  die "$NAME@$VER already exists on the registry — bump the shell version explicitly in a PR"
elif ! grep -q 'E404' <<<"$VIEW_OUT"; then
  die "registry lookup for $NAME@$VER failed (not a 404) — refusing to guess the version is free: $VIEW_OUT"
fi
note "registry: $NAME@$VER not yet published (explicit E404)"

# ── 4. publish content gate ───────────────────────────────────────────────────
bash "$SHELL_DIR/__tests__/onboard-shell-publish-gate.test.sh" >/dev/null 2>&1 \
  || die "publish content gate RED — fix before publishing"
note "publish content gate green"

note "PREFLIGHT PASS — publish may proceed ($([ "$FOUNDER_LOCAL" -eq 1 ] && echo founder-local 2FA || echo OIDC workflow) path)"
