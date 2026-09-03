#!/bin/bash
# FLY-224 Phase 2: codex-lead.sh — the codex-app-server backend launcher.
#
# Dormant direct launcher retained for operator QA; production launchd dispatch
# is Claude wrapper-v2 only. It takes the same positional args as claude-lead.sh:
#
#   codex-lead.sh <lead-id> <project-dir> [project-name] [--subdir <dir>]
#
# Responsibilities (vendor-neutral bootstrap, plan §3 / §6.7a):
#   - resolve identity + per-(project,lead) state dir,
#   - exec the codex-lead runtime (Node) which owns the app-server child
#     (CodexLeadProcess, Phase 1), the LeadInputRouter (Phase 3), the Discord
#     gateway + canonical outbound (Phase 4), MCP argv injection (Phase 5) and
#     the health/supervisor (Phase 6).
#
# Phase 2 boundary: the wrapper→backend dispatch + this launcher + the state-dir
# bootstrap are wired here. The runtime entrypoint it execs is filled in by the
# later phases; until then it fails loudly rather than pretending to be live.
#
# Claude path (claude-lead.sh) is UNCHANGED by this file.
set -euo pipefail

log() { echo "[codex-lead $(date '+%H:%M:%S')] $*" >&2; }

SELECTED_LEAD_ID="${1:?Usage: codex-lead.sh <lead-id> <project-dir> [project-name] [flags]}"
PROJECT_DIR="${2:?project-dir required}"

# CR Phase 2a #2: LEAD_ID validation MUST match claude-lead.sh's contract
# (^[a-z0-9][a-z0-9-]*$ — first char alnum, rejects pure '-' / leading hyphen).
if [[ ! "$SELECTED_LEAD_ID" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  log "ERROR: Invalid lead-id '${SELECTED_LEAD_ID}'. Must match [a-z0-9][a-z0-9-]*"
  exit 1
fi

# Parse $3+ exactly like claude-lead.sh: first non-flag = project-name; flags
# require values; unknown flag / extra positional → ERROR exit (no silent ignore).
shift 2
SELECTED_PROJECT_NAME=""
SUBDIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --subdir)
      if [ $# -lt 2 ] || [ -z "${2:-}" ] || [[ "${2:-}" == --* ]]; then
        log "ERROR: --subdir requires a directory argument."
        exit 1
      fi
      SUBDIR="$2"; shift 2 ;;
    --bot-token-env)
      log "ERROR: --bot-token-env is registry-owned and may not be overridden by a launcher."
      exit 1 ;;
    --*)
      log "ERROR: Unknown flag '$1'. Did you mean --subdir?"
      exit 1 ;;
    *)
      if [ -z "$SELECTED_PROJECT_NAME" ]; then
        SELECTED_PROJECT_NAME="$1"; shift
      else
        log "ERROR: Unexpected argument '$1'. Use --subdir for workspace subdirectory."
        exit 1
      fi ;;
  esac
done
SELECTED_PROJECT_NAME="${SELECTED_PROJECT_NAME:-$(basename "$PROJECT_DIR")}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/canonical-lead-identity.sh
. "${SCRIPT_DIR}/lib/canonical-lead-identity.sh"
canonical_lead_identity_resolve "$SELECTED_PROJECT_NAME" "$SELECTED_LEAD_ID"

# ── vendor-neutral bootstrap: per-(project,lead) state dir ──────
# CR Phase 2a #1 (R2): the directory key must be TRULY injective — a truncated
# hash (48-bit) can still collide, so it can't back the "distinct identities
# never share a state dir" guarantee (decision #13). Use a REVERSIBLE hex
# encoding of the raw `\037`-joined (projectName, leadId): hex is a bijection, so
# different identities always produce different dir names — by construction, not
# by hash luck. A short lossy `SAFE_*` prefix is kept only for human readability;
# the hex suffix is what guarantees uniqueness.
SAFE_PROJECT=$(printf '%s' "$FLYWHEEL_PROJECT_NAME" | tr -c 'a-zA-Z0-9_-' '_')
SAFE_LEAD=$(printf '%s' "$FLYWHEEL_LEAD_ID" | tr -c 'a-zA-Z0-9_-' '_')
IDENTITY_HEX=$(printf '%s\037%s' "$FLYWHEEL_PROJECT_NAME" "$FLYWHEEL_LEAD_ID" | od -An -v -tx1 | tr -d ' \n')
STATE_DIR="${FLYWHEEL_STATE_DIR:-${HOME}/.flywheel}/state/codex-lead/${SAFE_PROJECT}__${SAFE_LEAD}-${IDENTITY_HEX}"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR" 2>/dev/null || true

export FLYWHEEL_CODEX_LEAD_PROJECT_DIR="$PROJECT_DIR"
export FLYWHEEL_CODEX_LEAD_SUBDIR="$SUBDIR"
export FLYWHEEL_CODEX_LEAD_STATE_DIR="$STATE_DIR"

# ── FLY-898: fleet-wide core-room mention gate signal (non-CoS Codex lead) ────
# A Codex lead that subscribes to a core room (FLYWHEEL_LEAD_CORE_CHANNEL_ID set)
# AND is a NON-CoS lead in a project that HAS a CoS must id-only-gate that core
# room (resolveCoreRoomGate). We compute the decision from the SAME projects.json
# the Claude side uses and export FLYWHEEL_LEAD_CORE_MENTION_GATED=1 so the
# runtime turns the gate on (both headless + TUI). CoS / core-less / core-no-CoS
# → not set → byte-compat (core always handled). This launcher is the sole
# authority: clear any inherited value before recomputing from projects.json.
# Best-effort failures leave the gate off and never abort the launch.
unset FLYWHEEL_LEAD_CORE_MENTION_GATED
if [ -n "${FLYWHEEL_LEAD_CORE_CHANNEL_ID:-}" ]; then
  _cg_cli="${SCRIPT_DIR}/../dist/core-room-gate-cli.js"
  if [ -f "$_cg_cli" ] && command -v jq >/dev/null 2>&1; then
    _cg_gate="$(node "$_cg_cli" --lead-id "$FLYWHEEL_LEAD_ID" --project "$FLYWHEEL_PROJECT_NAME" 2>/dev/null \
      | jq -r '.gateNonCoS // false' 2>/dev/null || echo false)"
    if [ "$_cg_gate" = "true" ]; then
      export FLYWHEEL_LEAD_CORE_MENTION_GATED=1
      log "FLY-898: core-room mention gate ON for ${FLYWHEEL_LEAD_ID} (non-CoS in a core-with-CoS project)"
    fi
  fi
fi

# ── FLY-350 H-2: full-access governance bundle (= Claude-equal red line) ──────
# A full-access Codex Lead must load the SAME founder-only-authority contract +
# role rules as the corresponding Claude Lead. The ordered base bundle comes from
# the SHARED resolver (lead-rules-bundle.sh, parity-tested against claude-lead.sh)
# and is appended to FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES (→ Codex baseInstructions,
# AFTER the persona/identity files so persona establishes identity first, rules
# extend it — mirrors claude-lead.sh's persona-then-append order). FAIL-CLOSED:
# a missing REQUIRED governance file (founder-only-authority) aborts boot.
# Gated on the explicit full-access profile only → every other tier (companion /
# write-capable) is byte-compat (its launcher/plist owns
# FLYWHEEL_LEAD_SYSTEM_PROMPT_FILES unchanged).
if [ "${FLYWHEEL_CODEX_LEAD_PROFILE:-}" = "full-access" ]; then
  # shellcheck source=lead-rules-bundle.sh
  . "${SCRIPT_DIR}/lead-rules-bundle.sh"
  if ! assemble_full_access_governance "$FLYWHEEL_LEAD_ID" "${SCRIPT_DIR}/../lead-rules-base"; then
    log "ERROR: full-access governance bundle incomplete — a required rule file is missing (founder-only-authority)."
    log "Refusing to start a full-access Codex Lead without its founder-gate contract (fail-closed, FLY-350 H-2)."
    exit 1
  fi
  log "FLY-350 full-access governance bundle (${FLY350_FULL_ACCESS_ROLE:-dept}): ${FLY350_FULL_ACCESS_BUNDLE:-}"
fi

# FLY-259 ③: TUI mode — the Lead runs as the daemon-WS sidecar runtime and a
# REAL interactive `codex resume --remote` TUI shares its thread in cmux.
# Opt-in via FLYWHEEL_CODEX_LEAD_MODE=tui (default = FLY-224 headless,
# byte-compatible). Requires FLYWHEEL_CODEX_TUI_CWD; home/daemon are ensured
# fail-loud BEFORE the runtime starts (codex-lead-tui-home.sh contracts:
# pins, standalone, auth — all validated there).
if [ "${FLYWHEEL_CODEX_LEAD_MODE:-headless}" = "tui" ]; then
  TUI_HOME_SH="${SCRIPT_DIR}/codex-lead-tui-home.sh"
  # Honor the dry-run contract (review MED): in dry-run we must NOT touch the
  # home or start the daemon — the runtime prints its report and exits. Only run
  # the side-effecting ensures on a real start.
  if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" != "1" ]; then
    FLYWHEEL_CODEX_TUI_HOME="$CODEX_HOME" FLYWHEEL_CODEX_TUI_CWD="${FLYWHEEL_CODEX_TUI_CWD:?FLYWHEEL_CODEX_TUI_CWD required in tui mode}"     /bin/bash "$TUI_HOME_SH" ensure-home
    FLYWHEEL_CODEX_TUI_HOME="$CODEX_HOME" /bin/bash "$TUI_HOME_SH" ensure-daemon
  fi
  TUI_RUNTIME_DIST="${SCRIPT_DIR}/../dist/lead-backends/codex/codex-lead-tui-runtime.js"
  TUI_RUNTIME_SRC="${SCRIPT_DIR}/../src/lead-backends/codex/codex-lead-tui-runtime.ts"
  log "Starting codex TUI Lead '${FLYWHEEL_LEAD_ID}' (project: ${FLYWHEEL_PROJECT_NAME}, state: ${STATE_DIR}, ③ real terminal)"
  if [ -f "$TUI_RUNTIME_DIST" ]; then
    exec node "$TUI_RUNTIME_DIST"
  elif [ -f "$TUI_RUNTIME_SRC" ] && command -v npx >/dev/null 2>&1; then
    exec npx tsx "$TUI_RUNTIME_SRC"
  else
    log "ERROR: codex-lead-tui runtime entrypoint not found (build the teamlead package)."
    exit 1
  fi
fi

# Runtime entrypoint (built dist preferred; tsx fallback for dev).
RUNTIME_DIST="${SCRIPT_DIR}/../dist/lead-backends/codex/codex-lead-runtime.js"
RUNTIME_SRC="${SCRIPT_DIR}/../src/lead-backends/codex/codex-lead-runtime.ts"

log "Starting codex Lead '${FLYWHEEL_LEAD_ID}' (project: ${FLYWHEEL_PROJECT_NAME}, state: ${STATE_DIR})"

if [ -f "$RUNTIME_DIST" ]; then
  exec node "$RUNTIME_DIST"
elif [ -f "$RUNTIME_SRC" ] && command -v npx >/dev/null 2>&1; then
  exec npx tsx "$RUNTIME_SRC"
else
  log "ERROR: codex-lead runtime entrypoint not found."
  log "  Expected built: ${RUNTIME_DIST}"
  log "  or source:      ${RUNTIME_SRC}"
  log "  (The runtime is implemented across FLY-224 Phases 3-6.)"
  exit 1
fi
