#!/usr/bin/env bash
# FLY-96: Deploy a test slot (Bridge + Lead) for Discord E2E testing.
#
# Usage: scripts/test-deploy.sh [slot-number] [--digest <channel-id>]
#        [--generalized [--codex-runner] [--stub-runner] [--expect-head <full-sha>]]
#   If slot-number is provided, claims that specific slot.
#   If omitted, claims the first available slot from the pool.
#   --digest <id>  FLY-727: mount the daily-digest route on the slot Bridge
#                  (FLYWHEEL_DIGEST_CHANNEL=<id>) for a real staging digest E2E.
#
# Output: JSON with slot metadata (slot, port, channel, pids)
# Prerequisites: ~/.flywheel/.env with TEST_BOT_TOKEN_N, ~/.flywheel/test-slots.json
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# FLY-529: QA Testing Room roundtable + alert mirror env helpers (pure, sourceable).
# shellcheck source=lib/qa-room.sh
source "${SCRIPT_DIR}/lib/qa-room.sh"

# FLY-1189: multi-Lead (single Bridge, ≥2 real test Leads) additive extension.
# The canonical no-extra-lead registry baseline is guarded by
# scripts/__tests__/test-deploy-multilead.test.sh A1-A3.
# shellcheck source=lib/qa-multilead.sh
source "${SCRIPT_DIR}/lib/qa-multilead.sh"

# FLY-1775: generalized-DAG room provisioning helpers. Default-off; sourcing
# is side-effect free and ordinary slots stay on their existing byte path.
# shellcheck source=lib/qa-generalized.sh
source "${SCRIPT_DIR}/lib/qa-generalized.sh"

# FLY-2237: declarative, replayable slot-Bridge launch contract.
# shellcheck source=lib/qa-slot-bridge.sh
source "${SCRIPT_DIR}/lib/qa-slot-bridge.sh"

# FLY-1663: 529 Room Leads use the same launchd-native v2 topology as the
# target fleet, with labels and state scoped to the ephemeral QA slot.
# shellcheck source=lib/qa-launchd-lead.sh
source "${SCRIPT_DIR}/lib/qa-launchd-lead.sh"
QA_LEAD_REGISTRY=""

# FLY-2301: byte-stable Lead artifact renderers shared with regression fixtures.
# shellcheck source=lib/qa-lead-artifacts.sh
source "${SCRIPT_DIR}/lib/qa-lead-artifacts.sh"

# ── Load environment ──────────────────────────────────
ENV_FILE="${HOME}/.flywheel/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: ${ENV_FILE} not found. Create it with TEST_BOT_TOKEN_N values." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

SLOTS_FILE="${HOME}/.flywheel/test-slots.json"
if [[ ! -f "$SLOTS_FILE" ]]; then
  echo "ERROR: ${SLOTS_FILE} not found. Copy from scripts/test-slots.example.json and fill in values." >&2
  exit 1
fi

GUILD_ID=$(jq -r '.guildId' "$SLOTS_FILE")
TOTAL_SLOTS=$(jq '.slots | length' "$SLOTS_FILE")

log() { echo "[test-deploy] $(date +%H:%M:%S) $*" >&2; }

# ── FLY-162: reply-by-issue opt-in for test slot ──────
# When `TEST_REPLY_BY_ISSUE=1`, the test Bridge starts with the
# reply-by-issue routes enabled (TEAMLEAD_REPLY_BY_ISSUE_ENABLED=true)
# AND a per-slot TEAMLEAD_API_TOKEN. Both Bridge AND Lead env get the
# same token — Bridge to validate /api/* requests, Lead so its curl
# templates have $TEAMLEAD_API_TOKEN populated.
#
# Without TEST_REPLY_BY_ISSUE=1, behavior is unchanged: token is unset
# (env -u TEAMLEAD_API_TOKEN), reply.by_issue flag is off, all existing
# QA suites keep working.
#
# Plan AC11 + Codex R3 #1 + R4 LOW #2.
if [[ "${TEST_REPLY_BY_ISSUE:-0}" == "1" ]]; then
  # Allow caller to override via TEST_API_TOKEN; otherwise generate a
  # random per-slot token. We compute it once here so the same string
  # flows into both Bridge and Lead env blocks below.
  if [[ -z "${TEST_API_TOKEN:-}" ]]; then
    if command -v uuidgen >/dev/null 2>&1; then
      TEST_TEAMLEAD_API_TOKEN="fly-162-test-$(uuidgen | tr -d '-' | head -c 12)"
    else
      TEST_TEAMLEAD_API_TOKEN="fly-162-test-$(date +%s)-$$"
    fi
  else
    TEST_TEAMLEAD_API_TOKEN="$TEST_API_TOKEN"
  fi
  # FLY-1189 (Codex R1 MED): do NOT log any token characters — even a 24-char
  # prefix is a partial secret and the QA smoke persists this log to a campaign
  # file. Report presence + length only.
  log "TEST_REPLY_BY_ISSUE=1 — reply-by-issue routes will be enabled with TEAMLEAD_API_TOKEN=<redacted len=${#TEST_TEAMLEAD_API_TOKEN}>"
else
  TEST_TEAMLEAD_API_TOKEN=""
fi

# ── Slot allocation ───────────────────────────────────
claim_slot() {
  local slot_num="$1"
  local lockfile="/tmp/flywheel-test-slot-${slot_num}.lock"

  if mkdir "$lockfile" 2>/dev/null; then
    # PID is updated later to Bridge PID (long-lived) — see Step 5
    echo "claiming" > "$lockfile/pid"
    return 0
  fi

  # Check if existing lock is stale (Bridge PID dead)
  local lock_pid
  lock_pid=$(cat "$lockfile/pid" 2>/dev/null || echo "")
  if [[ "$lock_pid" == "cycle-failed" ]]; then
    log "Slot ${slot_num} has cycle-failed ownership — refusing automatic reclaim; run explicit test-teardown.sh ${slot_num}"
    return 1
  fi
  if [[ "$lock_pid" == "claiming" ]]; then
    # Another deploy is in-progress — check if lock is old (>5 min = likely crashed deploy)
    local lock_age
    lock_age=$(( $(date +%s) - $(stat -f %m "$lockfile/pid" 2>/dev/null || echo "0") ))
    if (( lock_age > 300 )); then
      log "Reclaiming stale claiming lock ${slot_num} (${lock_age}s old) — running full teardown first"
      # A prior deploy crashed before writing Bridge PID — Lead supervisor may still be
      # running from Step 1. Teardown clears Lead/session/workspace/CommDB.
      if ! bash "${SCRIPT_DIR}/test-teardown.sh" "$slot_num" >&2; then
        log "WARN: teardown of stale claiming slot ${slot_num} reported errors — continuing"
      fi
      mkdir "$lockfile" 2>/dev/null || return 1
      echo "claiming" > "$lockfile/pid"
      return 0
    fi
    return 1
  fi
  if [[ -n "$lock_pid" ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
    log "Reclaiming stale slot ${slot_num} (PID ${lock_pid} dead) — running full teardown first"
    # Bridge is dead but Lead supervisor, session-id, CommDB, workspace may still exist.
    # Reusing the slot without clearing them lets the new Bridge inherit the old Lead's
    # inbox-ready lease, --resume into the prior Claude session, and mix CommDB state
    # across tests. Run full teardown to guarantee a clean slot before reclaiming.
    if ! bash "${SCRIPT_DIR}/test-teardown.sh" "$slot_num" >&2; then
      log "WARN: teardown of stale slot ${slot_num} reported errors — continuing"
    fi
    # Teardown removed the lock; recreate it as "claiming".
    mkdir "$lockfile" 2>/dev/null || return 1
    echo "claiming" > "$lockfile/pid"
    return 0
  fi

  return 1
}

# ── Argument parsing (FLY-115 + FLY-153) ──────────────
FROM_BRANCH=""
REQUESTED_SLOT=""
MODE="slot"   # FLY-153: slot (default, per-slot channel) | mirror (3-Lead shared channel)
              # FLY-529: roundtable (test #leads-roundtable mirror + auto-thread host)
ALERTS=0      # FLY-529: --alerts wires the isolated test alert channel (any mode)
DIGEST_CHANNEL=""  # FLY-727: --digest <id> mounts the daily-digest route on the slot
                   # Bridge (FLYWHEEL_DIGEST_CHANNEL) so a real staging E2E can render
                   # /api/digest/render + deliver to an isolated test channel.
EXTRA_LEAD_SPECS=()       # FLY-1189: --extra-lead <slotId>:<deptLabel> (repeatable) —
                          # borrow another slot's bot/channel as a SECOND real Lead on
                          # THIS slot's single Bridge (N-to-N routing topology).
LEAD_LABEL=""             # FLY-1189: --lead-label <deptLabel> narrows the MAIN lead's
                          # match.labels from ["*"] to the explicit label.
LEAD_READY_TIMEOUT_ARG="" # FLY-1389 P2-a: --lead-ready-timeout <sec> overrides the
                          # 120s Lead inbox-ready wait (cold Lead on a loaded
                          # shared machine can legitimately exceed 120s). Env
                          # fallback: FLYWHEEL_TEST_LEAD_READY_TIMEOUT_SEC.
NO_LEAD=0                 # FLY-1389 P2-b: --no-lead skips identity staging + Lead
                          # startup entirely — Bridge-only deploy for pure
                          # Bridge/API/DB QA suites (Discord-Lead suites must
                          # NOT use it).
GENERALIZED=0             # FLY-1775: generalized workflow flags/config/bindings/readiness.
CODEX_RUNNER=0            # FLY-2211: opt-in real codex-tmux worker for restart drills.
STUB_RUNNER=0             # FLY-1775: deterministic persistent claude stub for the 9-step drill.
EXPECT_HEAD=""            # FLY-1775: optional script-repository HEAD fence.
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-branch)
      FROM_BRANCH="${2:?--from-branch requires a value}"; shift 2 ;;
    --from-branch=*)
      FROM_BRANCH="${1#*=}"; shift ;;
    --mode)
      MODE="${2:?--mode requires slot|mirror|roundtable}"; shift 2 ;;
    --mode=*)
      MODE="${1#*=}"; shift ;;
    --alerts)
      ALERTS=1; shift ;;
    --digest)
      DIGEST_CHANNEL="${2:?--digest requires a channel id}"; shift 2 ;;
    --digest=*)
      DIGEST_CHANNEL="${1#*=}"; shift ;;
    --extra-lead)
      EXTRA_LEAD_SPECS+=("${2:?--extra-lead requires <slotId>:<deptLabel>}"); shift 2 ;;
    --extra-lead=*)
      EXTRA_LEAD_SPECS+=("${1#*=}"); shift ;;
    --lead-label)
      LEAD_LABEL="${2:?--lead-label requires a value}"; shift 2 ;;
    --lead-label=*)
      LEAD_LABEL="${1#*=}"; shift ;;
    --lead-ready-timeout)
      LEAD_READY_TIMEOUT_ARG="${2:?--lead-ready-timeout requires seconds}"; shift 2 ;;
    --lead-ready-timeout=*)
      LEAD_READY_TIMEOUT_ARG="${1#*=}"; shift ;;
    --no-lead)
      NO_LEAD=1; shift ;;
    --generalized)
      GENERALIZED=1; shift ;;
    --codex-runner)
      CODEX_RUNNER=1; shift ;;
    --stub-runner)
      STUB_RUNNER=1; shift ;;
    --expect-head)
      EXPECT_HEAD="${2:?--expect-head requires a full SHA}"; shift 2 ;;
    --expect-head=*)
      EXPECT_HEAD="${1#*=}"; shift ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    [0-9]*)
      REQUESTED_SLOT="$1"; shift ;;
    *)
      echo "ERROR: unknown argument '$1'" >&2; exit 1 ;;
  esac
done

# Default branch — sandbox `main` works for most smoke / regression suites.
FROM_BRANCH="${FROM_BRANCH:-main}"

# FLY-1775 pit 1: the slot Bridge runs this checkout's bytes, never the
# --from-branch clone. Fence the actual script repository before any slot,
# lock, build, clone, or process mutation.
SCRIPT_REPO_HEAD=""
if [[ "$GENERALIZED" == "1" ]]; then
  [[ "$MODE" == "slot" ]] || {
    echo "ERROR: --generalized is only supported with --mode slot (mirror/roundtable are distinct topologies)." >&2
    exit 1
  }
  SCRIPT_REPO_HEAD=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "")
  qa_generalized_validate_expected_head "$SCRIPT_REPO_HEAD" "$EXPECT_HEAD" || exit 1
  log "GENERALIZED ROOM SOURCE HEAD: ${SCRIPT_REPO_HEAD} (Bridge runs this checkout; --from-branch only selects the sandbox clone)"
fi
if [[ "$STUB_RUNNER" == "1" && "$GENERALIZED" != "1" ]]; then
  echo "ERROR: --stub-runner requires --generalized" >&2
  exit 1
fi
if [[ "$CODEX_RUNNER" == "1" && "$GENERALIZED" != "1" ]]; then
  echo "ERROR: --codex-runner requires --generalized" >&2
  exit 1
fi
if [[ "$CODEX_RUNNER" == "1" && "$STUB_RUNNER" == "1" ]]; then
  echo "ERROR: --codex-runner cannot be combined with --stub-runner" >&2
  exit 1
fi
if [[ "$GENERALIZED" == "1" ]]; then
  case "${TEST_BRIDGE_DEPT_SCOPE_REJECT:-off}" in
    on|off) ;;
    *)
      echo "ERROR: TEST_BRIDGE_DEPT_SCOPE_REJECT must be 'on' or 'off' (got '${TEST_BRIDGE_DEPT_SCOPE_REJECT}')." >&2
      exit 1
      ;;
  esac
fi
if [[ -n "$EXPECT_HEAD" && "$GENERALIZED" != "1" ]]; then
  echo "ERROR: --expect-head requires --generalized" >&2
  exit 1
fi

# Generalized master entry always requires a token, independently of the
# reply-by-issue Discord route. Reuse TEST_API_TOKEN when supplied; otherwise
# mint the same per-room random form as the existing reply-by-issue path.
if [[ "$GENERALIZED" == "1" && -z "$TEST_TEAMLEAD_API_TOKEN" ]]; then
  if [[ -n "${TEST_API_TOKEN:-}" ]]; then
    TEST_TEAMLEAD_API_TOKEN="$TEST_API_TOKEN"
  elif command -v uuidgen >/dev/null 2>&1; then
    TEST_TEAMLEAD_API_TOKEN="fly-1775-test-$(uuidgen | tr -d '-' | head -c 12)"
  else
    TEST_TEAMLEAD_API_TOKEN="fly-1775-test-$(date +%s)-$$"
  fi
  log "generalized master auth enabled with TEAMLEAD_API_TOKEN=<redacted len=${#TEST_TEAMLEAD_API_TOKEN}>; reply-by-issue remains ${TEST_REPLY_BY_ISSUE:-0}"
fi
TEST_TEAMLEAD_INGEST_TOKEN=""
if [[ "$GENERALIZED" == "1" ]]; then
  TEST_TEAMLEAD_INGEST_TOKEN=$(qa_generalized_resolve_ingest_token \
    "${TEST_INGEST_TOKEN:-}" "$TEST_TEAMLEAD_API_TOKEN") || exit 1
  log "generalized ingest auth enabled with TEAMLEAD_INGEST_TOKEN=<redacted len=${#TEST_TEAMLEAD_INGEST_TOKEN}>"
fi

# FLY-1439: fail immediately on a typo'd isolated Claude root instead of
# materializing an empty config and waiting minutes for an unauthenticated
# Lead to miss its ready lease.
if [[ -n "${TEST_LEAD_CLAUDE_CONFIG_DIR:-}" ]]; then
  case "${TEST_LEAD_CLAUDE_CONFIG_DIR}" in
    /*) ;;
    *)
      echo "ERROR: TEST_LEAD_CLAUDE_CONFIG_DIR must be an existing absolute directory." >&2
      exit 1
      ;;
  esac
  if [[ ! -d "${TEST_LEAD_CLAUDE_CONFIG_DIR}" ]] \
    || { [[ ! -f "${TEST_LEAD_CLAUDE_CONFIG_DIR}/.credentials.json" ]] \
      && [[ ! -d "${TEST_LEAD_CLAUDE_CONFIG_DIR}/plugins" ]] \
      && [[ ! -f "${TEST_LEAD_CLAUDE_CONFIG_DIR}/settings.json" ]]; }; then
    echo "ERROR: TEST_LEAD_CLAUDE_CONFIG_DIR must be an existing absolute directory containing Claude credentials, plugins, or settings." >&2
    exit 1
  fi
fi

# ── FLY-153: Mirror mode validation (BEFORE expensive preflight) ──
# Round 1 #3 + R2 #4: validate mode + mirror requirements before paying for
# gh/pnpm preflight. If the user asks for an impossible mirror config (slot 4,
# missing mirrorChannel), fail in milliseconds instead of minutes.
case "$MODE" in
  slot|mirror|roundtable) ;;
  *)
    echo "ERROR: --mode must be 'slot', 'mirror', or 'roundtable' (got '${MODE}')" >&2
    exit 1
    ;;
esac

MIRROR_CHANNEL_ID=""
if [[ "$MODE" == "mirror" ]]; then
  if [[ ! -f "$SLOTS_FILE" ]]; then
    echo "ERROR: ${SLOTS_FILE} not found — required for --mode mirror" >&2
    exit 1
  fi
  MIRROR_CHANNEL_ID=$(jq -r '.mirrorChannel.channelId // empty' "$SLOTS_FILE")
  if [[ -z "$MIRROR_CHANNEL_ID" || "$MIRROR_CHANNEL_ID" == "<shared-mirror-channel-id>" ]]; then
    echo "ERROR: --mode mirror requires mirrorChannel.channelId in ${SLOTS_FILE}." >&2
    echo "  See packages/qa-framework/README.md §Mirror Mode for setup steps." >&2
    exit 1
  fi
  if [[ -n "$REQUESTED_SLOT" ]]; then
    case "$REQUESTED_SLOT" in
      1|2|3) ;;
      *)
        echo "ERROR: --mode mirror supports slots 1-3 (cos/product/ops). Slot ${REQUESTED_SLOT} has no prod analog (slot 4 is finance-only)." >&2
        exit 1
        ;;
    esac
  fi
fi

# ── FLY-1389 P2: lead-ready timeout + --no-lead validation (BEFORE preflight) ──
# Resolve + validate the knob NOW so an invalid value fails in milliseconds
# instead of after gh/pnpm preflight (same discipline as mirror validation).
LEAD_READY_TIMEOUT_SEC=$(qa_room_resolve_lead_ready_timeout \
  "$LEAD_READY_TIMEOUT_ARG" "${FLYWHEEL_TEST_LEAD_READY_TIMEOUT_SEC:-}") || exit 1
# 2s poll cadence → ceil(timeout/2) iterations.
LEAD_READY_POLL_ITERS=$(( (LEAD_READY_TIMEOUT_SEC + 1) / 2 ))
if [[ "$NO_LEAD" == "1" && ${#EXTRA_LEAD_SPECS[@]} -gt 0 ]]; then
  echo "ERROR: --no-lead and --extra-lead are mutually exclusive (a campaign is Lead-centric)" >&2
  exit 1
fi

# ── FLY-1189: multi-Lead campaign validation (BEFORE expensive preflight) ──
# Same fail-in-milliseconds discipline as the mirror-mode validation above.
# EXTRA_LEADS_JSON carries the resolved per-slot fields (agentId / botAppId /
# tokenEnvVar / chatChannel / role / identitySource) + slotId + deptLabel +
# labels — the single source the projects builder, Lead startup, and
# manifests all consume. Token VALUES are resolved lazily via indirection at
# use points and never enter the JSON.
EXTRA_LEADS_JSON="[]"
if [[ -n "$LEAD_LABEL" && ! "$LEAD_LABEL" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "ERROR: --lead-label '${LEAD_LABEL}' invalid (charset [A-Za-z0-9._-])" >&2
  exit 1
fi
if (( ${#EXTRA_LEAD_SPECS[@]} > 0 )); then
  EXTRA_LEADS_JSON=$(qa_multilead_validate_campaign_args \
    "$SLOTS_FILE" "$MODE" "$REQUESTED_SLOT" "${EXTRA_LEAD_SPECS[@]}") || exit 1
  # Every extra Lead's bot token env must resolve NOW — a missing token after
  # the main Lead is already up would strand a half-built campaign.
  while IFS= read -r XTOKEN_ENV_NAME; do
    [[ -z "$XTOKEN_ENV_NAME" ]] && continue
    if [[ -z "${!XTOKEN_ENV_NAME:-}" ]]; then
      echo "ERROR: ${XTOKEN_ENV_NAME} (extra-lead bot token env) not set in environment." >&2
      exit 1
    fi
  done < <(jq -r '.[].tokenEnvVar' <<<"$EXTRA_LEADS_JSON")
  log "Campaign validated: main slot ${REQUESTED_SLOT} + extra lead(s) $(jq -c 'map({slotId, agentId, deptLabel})' <<<"$EXTRA_LEADS_JSON")"
fi

# ── FLY-115: Pre-flight ───────────────────────────────
REBUILD_LOCK="/tmp/flywheel-qa-rebuild.lock"
SANDBOX_SLUG="xrliAnnie/flywheel-qa-sandbox"
SANDBOX_REMOTE_URL="${FLYWHEEL_SANDBOX_REMOTE_URL:-git@github.com:${SANDBOX_SLUG}.git}"

fail_preflight() {
  echo "ERROR [pre-flight]: $1" >&2
  echo "See doc/qa/framework/real-runner-e2e-guide.md." >&2
  exit 2
}

[[ -n "${LINEAR_API_KEY:-}" ]] \
  || fail_preflight "LINEAR_API_KEY not set (required for /api/runs/start PreHydrator)"
gh auth status >/dev/null 2>&1 \
  || fail_preflight "gh CLI not authenticated (required for Runner gh pr create)"
# FLY-1620: use the REST endpoint, not `gh repo view` (which goes through
# GraphQL). Runners burn the GraphQL hourly quota with ordinary `gh pr`
# traffic; when it hits 0 this check failed and reported the sandbox as
# MISSING — sending the operator to run a fork command that cannot even
# succeed (a user cannot fork their own repo). REST has its own quota.
if ! gh api "repos/${SANDBOX_SLUG}" >/dev/null 2>&1; then
  if ! gh api rate_limit --jq '.resources.core.remaining' >/dev/null 2>&1; then
    fail_preflight "cannot reach the GitHub API (network or auth). Sandbox repo ${SANDBOX_SLUG} was NOT checked — this is not evidence that it is missing."
  fi
  fail_preflight "sandbox repo ${SANDBOX_SLUG} is not reachable with the current gh auth. Verify it exists and that this token can see it: gh api repos/${SANDBOX_SLUG}"
fi
# Runner needs to 'git push + gh pr create' into the sandbox. Read-only access
# means the whole real-Runner flow fails after clone. Fail fast so the operator
# fixes gh auth scopes / fork permissions before we start rebuilding anything.
SANDBOX_PUSH_PERM=$(gh api "repos/${SANDBOX_SLUG}" --jq '.permissions.push' 2>/dev/null || echo "")
[[ "$SANDBOX_PUSH_PERM" == "true" ]] \
  || fail_preflight "no push permission on ${SANDBOX_SLUG} (gh api .permissions.push=${SANDBOX_PUSH_PERM:-unset}). Check gh auth scopes / fork ownership."

# Serialized preflight block — all the work that would collide across slots
# is done under one lock. macOS has no flock(1) — fall back to a portable
# mkdir-based spinlock with PID-based stale detection.
#
# Order: better-sqlite3 native compile + require() probe, THEN TypeScript
# build of the dist artifacts Bridge imports at runtime.
log "Preflight under ${REBUILD_LOCK}: better-sqlite3 native compile + flywheel-edge-worker build + flywheel-teamlead build"
LOCK_TIMEOUT=300
waited=0
while ! mkdir "$REBUILD_LOCK" 2>/dev/null; do
  # Reclaim if holder PID is dead (crashed mid-preflight).
  lock_holder=$(cat "${REBUILD_LOCK}/pid" 2>/dev/null || echo "")
  if [[ -n "$lock_holder" ]] && ! kill -0 "$lock_holder" 2>/dev/null; then
    log "Reclaiming stale preflight lock (holder PID ${lock_holder} dead)"
    rm -rf "$REBUILD_LOCK"
    continue
  fi
  if (( waited >= LOCK_TIMEOUT )); then
    fail_preflight "preflight lock busy > ${LOCK_TIMEOUT}s (holder=${lock_holder:-unknown}). If stale: rm -rf ${REBUILD_LOCK}"
  fi
  sleep 1
  waited=$((waited + 1))
done
echo "$$" > "${REBUILD_LOCK}/pid"
release_preflight_lock() { rm -rf "$REBUILD_LOCK"; }
trap release_preflight_lock EXIT

(
  cd "$REPO_ROOT"

  # 1. native addon compile — better_sqlite3.node.
  #
  # Root cause for the silent-no-op the old `pnpm rebuild` had: this repo
  # pins `pnpm.onlyBuiltDependencies: []` in package.json, which (pnpm 10+)
  # blocks ALL transitive install scripts. better-sqlite3's `install` hook
  # is what compiles the native binding, so `pnpm rebuild better-sqlite3`
  # returned 0 without touching the dep on a fresh worktree. Bridge / Lead
  # would then crash with "Could not locate the bindings file" the moment
  # they tried to open CommDB.
  #
  # Fix: bypass pnpm and drive better-sqlite3's own `install` script
  # directly when the compiled binary is missing. Idempotent — re-runs
  # are no-ops once the binary exists.
  BSQLITE_DIR=$(find "$REPO_ROOT/node_modules/.pnpm" -type d \
    -path "*better-sqlite3@*/node_modules/better-sqlite3" 2>/dev/null | head -1)
  if [[ -z "$BSQLITE_DIR" ]]; then
    echo "ERROR: better-sqlite3 not installed in pnpm store. Run 'pnpm install --frozen-lockfile' first." >&2
    exit 11
  fi
  BSQLITE_BINARY="${BSQLITE_DIR}/build/Release/better_sqlite3.node"
  if [[ ! -f "$BSQLITE_BINARY" ]]; then
    echo "[preflight] Compiling better-sqlite3 native binding at ${BSQLITE_DIR}" >&2
    ( cd "$BSQLITE_DIR" && npm run install ) || {
      echo "ERROR: better-sqlite3 install script failed. Is node-gyp / a C++ toolchain available?" >&2
      exit 11
    }
    if [[ ! -f "$BSQLITE_BINARY" ]]; then
      echo "ERROR: better-sqlite3 install script returned 0 but ${BSQLITE_BINARY} still missing." >&2
      exit 11
    fi
  fi
  ( cd "$REPO_ROOT/packages/flywheel-comm" && node -e "require('better-sqlite3')" ) \
    || exit 11
  ( cd "$REPO_ROOT/packages/inbox-mcp" && node -e "require('better-sqlite3')" ) \
    || exit 12

  # 2. FLY-1775: generalized rooms consume the built config package as the
  #    canonical workflow-menu binding authority. Keep ordinary deploys on
  #    their exact historical build path.
  if [[ "$GENERALIZED" == "1" ]]; then
    pnpm --filter flywheel-config build || exit 16
  fi

  # 3. Rebuild edge-worker dist so scripts/run-bridge.ts → dist/WorktreeManager.js
  #    picks up the FLYWHEEL_RUNNER_START_POINT env fallback. Without this,
  #    /api/runs/start spawns Runners against stale origin/main dist.
  pnpm --filter flywheel-edge-worker build || exit 13

  # 4. FLY-162 QA round 1: rebuild teamlead dist too. scripts/run-bridge.ts
  #    imports compiled artifacts from packages/teamlead/dist (route handlers,
  #    config loader, plugin). Without this rebuild, edits to tools.ts /
  #    config.ts / plugin.ts (e.g. new POST /api/chat-threads/send route) are
  #    invisible to the running Bridge — it still serves the old dist. QA hit
  #    this exact trap on the first FLY-162 deploy ("404 not found" on /send).
  pnpm --filter flywheel-teamlead build || exit 15

  # 5. Assert the env fallback actually landed in the built artifact. Cheaper
  #    than rerunning unit tests under the lock, and it catches the case where
  #    someone forgets to rebuild after editing src.
  grep -q 'FLYWHEEL_RUNNER_START_POINT' \
    "$REPO_ROOT/packages/edge-worker/dist/WorktreeManager.js" || exit 14
) || fail_preflight "preflight failed. Run pnpm install --frozen-lockfile, then pnpm -r build; verify better-sqlite3, config, edge-worker, teamlead, and dist freshness."

release_preflight_lock
trap - EXIT

SLOT=""

# FLY-1189: stale-teardown hook for the campaign claim set (mirrors what
# claim_slot() does inline for a single slot).
campaign_stale_teardown() {
  bash "${SCRIPT_DIR}/test-teardown.sh" "$1" >&2
}
CAMPAIGN_SLOT_IDS=()

if [[ -n "$REQUESTED_SLOT" ]]; then
  if (( ${#EXTRA_LEAD_SPECS[@]} > 0 )); then
    # FLY-1189: claim the FULL campaign slot set (main + extras) atomically,
    # sorted ascending (concurrent campaigns can't deadlock on claim order).
    # Any single failure rolls back every lock newly claimed by this call.
    CAMPAIGN_SLOT_IDS=("$REQUESTED_SLOT")
    while IFS= read -r XSID; do
      [[ -n "$XSID" ]] && CAMPAIGN_SLOT_IDS+=("$XSID")
    done < <(jq -r '.[].slotId' <<<"$EXTRA_LEADS_JSON")
    if qa_multilead_claim_set /tmp campaign_stale_teardown "${CAMPAIGN_SLOT_IDS[@]}" >/dev/null; then
      SLOT="$REQUESTED_SLOT"
    else
      echo "ERROR: campaign slot set (${CAMPAIGN_SLOT_IDS[*]}) claim failed — no locks held." >&2
      exit 1
    fi
  elif claim_slot "$REQUESTED_SLOT"; then
    SLOT="$REQUESTED_SLOT"
  else
    echo "ERROR: Slot ${REQUESTED_SLOT} is in use." >&2
    exit 1
  fi
else
  # FLY-153: in mirror mode auto-allocation only considers slots 1-3
  # (slot 4 is finance — no prod analog in mirror topology).
  if [[ "$MODE" == "mirror" ]]; then
    AUTO_RANGE_END=3
  else
    AUTO_RANGE_END="$TOTAL_SLOTS"
  fi
  for i in $(seq 1 "$AUTO_RANGE_END"); do
    if claim_slot "$i"; then
      SLOT="$i"
      break
    fi
  done
fi

# Cleanup trap: release slot lock if deploy fails before Bridge PID is written
cleanup_on_failure() {
  local lock="/tmp/flywheel-test-slot-${SLOT}.lock"
  local lock_pid
	local generalized_bridge_stopped=1
	# FLY-1775: generalized readiness remains inside the deploy transaction even
	# after bridge.pid replaces the "claiming" sentinel. A failure between
	# /health and room-info finalization must leave no process, port, lock, or
	# half-ready slot for a later QA run to mistake as usable.
	if [[ "${GENERALIZED_READINESS_PENDING:-0}" == "1" ]]; then
		if [[ -n "${BRIDGE_PID:-}" ]]; then
			if ! qa_generalized_terminate_pid "$BRIDGE_PID"; then
				generalized_bridge_stopped=0
			fi
		fi
		if [[ -n "${QA_LEAD_REGISTRY:-}" && -f "${QA_LEAD_REGISTRY}" ]]; then
			qa_launchd_stop_registry "$QA_LEAD_REGISTRY" 2>/dev/null || true
			QA_LEAD_REGISTRY=""
		fi
		qa_generalized_invalidate_room_info "$SLOT_DIR"
		if (( generalized_bridge_stopped == 1 )); then
			rm -rf "$lock"
		else
			echo "ERROR: generalized Bridge ${BRIDGE_PID} did not exit; retaining slot ${SLOT} lock" >&2
		fi
		# Preserve the partial slot directory (especially bridge.log) for the
		# operator diagnosis named by this script. The ordinary campaign rollback
		# below still owns borrowed locks and extra-Lead supervisors.
	fi
  if [[ -n "${QA_LEAD_REGISTRY:-}" && -f "$QA_LEAD_REGISTRY" ]]; then
    qa_launchd_stop_registry "$QA_LEAD_REGISTRY" 2>/dev/null || true
  fi
  lock_pid=$(cat "$lock/pid" 2>/dev/null || echo "")
  # Only clean up if still in "claiming" state (Bridge PID not yet written)
  if [[ "$lock_pid" == "claiming" ]]; then
    log "Deploy interrupted — releasing slot ${SLOT} lock"
    rm -rf "$lock"
  fi
  # FLY-1189: campaign rollback — extra Leads + borrowed locks still in
  # "claiming" state (finalize flips them to the live Bridge PID; a finalized
  # campaign is NEVER torn down here). Runs regardless of the main lock's
  # state — some legacy failure paths rm the main lock themselves before exit.
  local cm="/tmp/flywheel-test-slot-${SLOT}/campaign-manifest.json"
  local xsid xlock xpid
  for xsid in ${CAMPAIGN_SLOT_IDS[@]+"${CAMPAIGN_SLOT_IDS[@]}"}; do
    [[ "$xsid" == "$SLOT" ]] && continue
    xlock="/tmp/flywheel-test-slot-${xsid}.lock"
    xpid=$(cat "$xlock/pid" 2>/dev/null || echo "")
    if [[ "$xpid" == "claiming" ]]; then
      if [[ -n "$cm" && -f "$cm" ]]; then
        qa_multilead_teardown_extra_leads "$cm" 2>/dev/null || true
        cm=""
      fi
      log "Deploy interrupted — releasing borrowed slot ${xsid} lock"
      rm -rf "$xlock"
    fi
  done
	# A failed readiness transaction must retain bridge.log for diagnosis but
	# cannot leave a replayable launch contract or captured credentials behind.
	if [[ -n "${BRIDGE_LAUNCH_SPEC:-}" ]]; then
		rm -f "$BRIDGE_LAUNCH_SPEC"
	fi
	if [[ "${SLOT_DIR:-}" == "/tmp/flywheel-test-slot-${SLOT}" ]]; then
		rm -rf "${SLOT_DIR}/state/bridge-env-secrets"
	fi
}
trap cleanup_on_failure EXIT

if [[ -z "$SLOT" ]]; then
  echo "ERROR: All ${TOTAL_SLOTS} test slots are in use." >&2
  exit 1
fi

log "Claimed slot ${SLOT}"

# ── Read slot config ──────────────────────────────────
# Schema matches ~/.flywheel/test-slots.json (FLY-96):
#   bridgePort, botName, tokenEnvVar, botAppId, channelId, role
# role ∈ {"cos", "lead"} — selects which GeoForge3D identity.md to source from.
# AGENT_ID is derived from botName (1:1) — simple and deterministic.
SLOT_IDX=$((SLOT - 1))
SLOT_PORT=$(jq -r ".slots[${SLOT_IDX}].bridgePort" "$SLOTS_FILE")
AGENT_ID=$(jq -r ".slots[${SLOT_IDX}].botName" "$SLOTS_FILE")
BOT_TOKEN_ENV=$(jq -r ".slots[${SLOT_IDX}].tokenEnvVar" "$SLOTS_FILE")
BOT_ID=$(jq -r ".slots[${SLOT_IDX}].botAppId" "$SLOTS_FILE")
CHAT_CHANNEL_ID=$(jq -r ".slots[${SLOT_IDX}].channelId" "$SLOTS_FILE")
SLOT_ROLE=$(jq -r ".slots[${SLOT_IDX}].role" "$SLOTS_FILE")
SLOT_BACKEND=$(jq -r ".slots[${SLOT_IDX}].backend // empty" "$SLOTS_FILE")
SLOT_CODEX_SOURCE_HOME=$(jq -r ".slots[${SLOT_IDX}].codexSourceHome // empty" "$SLOTS_FILE")
SLOT_CODEX_PROFILE=$(jq -r ".slots[${SLOT_IDX}].codexProfile // empty" "$SLOTS_FILE")
if ! MAIN_LEAD_SHAPE=$(qa_multilead_validate_lead_shape \
    "$SLOT_BACKEND" "$SLOT_CODEX_SOURCE_HOME" "$SLOT_CODEX_PROFILE"); then
  echo "ERROR: slots[${SLOT_IDX}] has an invalid Lead carrier shape" >&2
  rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
  exit 1
fi
# FLY-163: forum concept removed. forumChannelId field (if still present in
# legacy test-slots.json) is ignored. No FORUM_CHANNEL_ID extraction needed.

# FLY-153: identitySource selects which GeoForge3D identity.md to load. Optional;
# falls back to legacy role-based mapping (cos→cos-lead, lead→product-lead) so
# pre-FLY-153 test-slots.json files keep working. Without this, slot 3 (ops) would
# always load Peter's identity (the legacy `lead` mapping), breaking mirror cascade
# coverage that requires Simba + Peter + Oliver.
IDENTITY_SOURCE=$(jq -r ".slots[${SLOT_IDX}].identitySource // empty" "$SLOTS_FILE")

# Validate required fields (jq returns literal "null" string when missing)
for pair in "bridgePort:${SLOT_PORT}" "botName:${AGENT_ID}" "tokenEnvVar:${BOT_TOKEN_ENV}" "botAppId:${BOT_ID}" "channelId:${CHAT_CHANNEL_ID}" "role:${SLOT_ROLE}"; do
  field="${pair%%:*}"
  value="${pair#*:}"
  if [[ -z "$value" || "$value" == "null" ]]; then
    echo "ERROR: slots[${SLOT_IDX}].${field} missing or null in ${SLOTS_FILE}" >&2
    rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
    exit 1
  fi
done

# Resolve bot token from env var name
TEST_BOT_TOKEN="${!BOT_TOKEN_ENV:-}"
if [[ -z "$TEST_BOT_TOKEN" ]]; then
  echo "ERROR: ${BOT_TOKEN_ENV} not set in environment." >&2
  rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
  exit 1
fi

# ── FLY-153: mirror mode override ───────────────────────────
# In mirror mode, swap the slot's per-slot channelId for the shared mirror
# channel. The slot's own channel field stays in test-slots.json untouched —
# legacy mode coexists.
EFFECTIVE_CHANNEL_LABEL="slot-channel"
if [[ "$MODE" == "mirror" ]]; then
  log "Mirror mode active — overriding CHAT_CHANNEL_ID ${CHAT_CHANNEL_ID} -> ${MIRROR_CHANNEL_ID}"
  CHAT_CHANNEL_ID="$MIRROR_CHANNEL_ID"
  EFFECTIVE_CHANNEL_LABEL="mirror-channel"
fi

# Persist mode in slot lock dir for downstream consumers (FLY-153 P7):
# inject-linear-issue.sh refuses mirror slots without --allow-mirror;
# qa-fly-60-driver.sh aborts if any selected slot is in mirror mode.
echo "$MODE" > "/tmp/flywheel-test-slot-${SLOT}.lock/mode"

# ── FLY-153 R2 #4: per-bot mirror channel REST probe ────────
# Verify (a) channel exists, (b) bot has View Channel permission, (c) bot is a
# channel member — before paying the cost of starting Lead + Bridge. Send
# Messages permission can't be tested via GET; smoke Phase A's ephemeral
# POST/DELETE catches that later. Resolve the pointer installPath from the
# canonical registry-aware checker; never guess from orphaned version dirs.
if [[ "$MODE" == "mirror" ]]; then
  PLUGIN_CHECK="${HOME}/.flywheel/bin/check-discord-plugin.sh"
  if [[ ! -x "$PLUGIN_CHECK" ]]; then
    echo "ERROR: managed Discord plugin checker is missing: ${PLUGIN_CHECK}" >&2
    rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
    exit 1
  fi
  if ! ACTIVE_PLUGIN="$("$PLUGIN_CHECK" --print-install-path)"; then
    echo "ERROR: discord@flywheel-plugins does not match fork main; mirror QA refuses to start. Run: claude plugin update discord@flywheel-plugins --scope user" >&2
    rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
    exit 1
  fi
  if [[ ! -f "${ACTIVE_PLUGIN}/server.ts" ]] \
      || ! grep -q "access.allowBots" "${ACTIVE_PLUGIN}/server.ts"; then
    echo "ERROR: Discord plugin at ${ACTIVE_PLUGIN} does not consume access.allowBots — mirror mode cascade will silently fail. Run: claude plugin update discord@flywheel-plugins --scope user" >&2
    rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
    exit 1
  fi

  log "Probing mirror channel ${MIRROR_CHANNEL_ID} accessibility for bot ${AGENT_ID}"
  # Drop -f: with -f curl exits non-zero on >=400 AND still writes the body
  # to -o /dev/null, then -w "%{http_code}" is appended via the failed-curl
  # branch -> we used to get strings like "403000" which never matched 403|404
  # below. Without -f curl returns 0 on HTTP errors and only the http code is
  # captured. Network/DNS failures still produce empty output → "000" fallback.
  PROBE_HTTP=$(curl -s -H "Authorization: Bot ${TEST_BOT_TOKEN}" \
    "https://discord.com/api/v10/channels/${MIRROR_CHANNEL_ID}" \
    -o /dev/null -w "%{http_code}" 2>/dev/null || echo "000")
  [[ -z "$PROBE_HTTP" ]] && PROBE_HTTP="000"
  case "$PROBE_HTTP" in
    200)
      log "Mirror channel probe OK (HTTP 200) for ${AGENT_ID}"
      ;;
    403|404)
      echo "ERROR: Mirror channel ${MIRROR_CHANNEL_ID} inaccessible to bot ${AGENT_ID} (HTTP ${PROBE_HTTP})." >&2
      echo "  Invite this bot with View Channel + Send Messages + Read Message History." >&2
      echo "  See packages/qa-framework/README.md §Mirror Mode for step-by-step." >&2
      rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
      exit 1
      ;;
    *)
      echo "ERROR: Mirror channel probe network/auth error (HTTP ${PROBE_HTTP}) for bot ${AGENT_ID}." >&2
      echo "  Verify TEST_BOT_TOKEN_${SLOT} is fresh and Discord API is reachable." >&2
      rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
      exit 1
      ;;
  esac
fi

# ── Create temp directories ───────────────────────────
SLOT_DIR="/tmp/flywheel-test-slot-${SLOT}"
BRIDGE_LAUNCH_SPEC="${SLOT_DIR}/bridge-launch.json"
mkdir -p "${SLOT_DIR}/discord-state"
chmod 700 "$SLOT_DIR"
QA_LEAD_REGISTRY="${SLOT_DIR}/launchd-leads.json"
# FLY-2030: canonical identity compilation requires the founder-selected
# summary granularity. QA uses a slot-local selection and summary-exempt Leads,
# so the 529 harness neither depends on nor mutates the operator's real HOME.
QA_SUMMARY_CONFIG_HOME="${SLOT_DIR}/identity-home"
mkdir -p "${QA_SUMMARY_CONFIG_HOME}/.flywheel"
chmod 700 "$QA_SUMMARY_CONFIG_HOME" "${QA_SUMMARY_CONFIG_HOME}/.flywheel"
printf '%s\n' \
  "{\"granularity\":\"per-lead\",\"setBy\":\"test-deploy\",\"setAt\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\"}" \
  > "${QA_SUMMARY_CONFIG_HOME}/.flywheel/summary-config.json"
chmod 600 "${QA_SUMMARY_CONFIG_HOME}/.flywheel/summary-config.json"
GENERALIZED_READINESS_PENDING=0
GENERALIZED_CHILD_TMPDIR="${TMPDIR:-/tmp}"
GENERALIZED_API_TOKEN_PATH=""
GENERALIZED_ROOM_INFO=""
# FLY-1775 pit 9 intentionally extends the ordinary reply-by-issue opt-in:
# inject-linear-issue needs the same slot-local Bearer credential. Default
# ordinary rooms still create no token file; the opt-in file is always 0600.
if [[ "$GENERALIZED" == "1" || "${TEST_REPLY_BY_ISSUE:-0}" == "1" ]]; then
  GENERALIZED_API_TOKEN_PATH="${SLOT_DIR}/state/api-token"
  mkdir -p "${SLOT_DIR}/state"
  printf '%s\n' "$TEST_TEAMLEAD_API_TOKEN" > "$GENERALIZED_API_TOKEN_PATH"
  chmod 600 "$GENERALIZED_API_TOKEN_PATH"
fi
if [[ "$GENERALIZED" == "1" ]]; then
  GENERALIZED_READINESS_PENDING=1
  GENERALIZED_CHILD_TMPDIR=$(qa_generalized_safe_tmpdir "${TMPDIR:-/tmp}" "$(id -u)")
  if [[ "$GENERALIZED_CHILD_TMPDIR" != "${TMPDIR:-/tmp}" ]]; then
    log "generalized preflight: TMPDIR socket path is too long; child processes use TMPDIR=/tmp (sun_path safety)"
  fi
  GENERALIZED_ROOM_INFO="${SLOT_DIR}/room-info.json"
fi

# ── FLY-529: QA Room roundtable + alert mirror config + env arrays ─────────
# Resolved here (after SLOT/SLOT_DIR, before access.json / FLYWHEEL_PROJECTS /
# env blocks) so the values weave into all of them. LEAD_EXTRA_ENV /
# BRIDGE_EXTRA_ENV start empty and are injected into the env invocations later
# with the bash-3.2-safe `${arr[@]+"${arr[@]}"}` expansion (empty array under
# `set -u` would otherwise abort).
LEAD_EXTRA_ENV=()
BRIDGE_EXTRA_ENV=()
GENERALIZED_ENV_UNSET_ARGS=()
# FLY-1608: isolate both sides of the fail-close complete marker protocol.
# Bridge reads/drains this directory; spawned Runners write to it via adapter
# passthrough. Without both injections a QA slot can consume production markers
# or leave test markers for the production Bridge.
COMPLETE_MARKER_DIR="${SLOT_DIR}/state/complete-failed"
LEAD_EXTRA_ENV+=("FLYWHEEL_COMPLETE_MARKER_DIR=${COMPLETE_MARKER_DIR}")
BRIDGE_EXTRA_ENV+=("FLYWHEEL_COMPLETE_MARKER_DIR=${COMPLETE_MARKER_DIR}")
BRIDGE_EXTRA_ENV+=("FLYWHEEL_LOOP_DIAGNOSTICS_DIR=${SLOT_DIR}/state/loop-diagnostics")
# FLY-1726: a failed canonical-identity assertion must stay inside the QA
# slot, never write a diagnostic into the resident fleet's state directory.
LEAD_EXTRA_ENV+=("FLYWHEEL_IDENTITY_FAILURE_DIR=${SLOT_DIR}/state/lead-identity-failures")
# FLY-1663 QA must never read, create, or rotate the resident Bridge secret.
BRIDGE_EXTRA_ENV+=("FLYWHEEL_DELIVERY_SECRET_PATH=${SLOT_DIR}/state/delivery-secret")
# FLY-2174: the Bridge's Codex orphan reaper combines its StateStore runway
# with the daemon homes/session/socket inventories named by these coordinates.
# A slot-local DB cannot authorize mutations against the resident fleet's
# default ~/.flywheel inventories: every production execution would look
# inactive to the slot and old reparented app-servers would be signaled. Bind
# all three destructive identity axes to one slot tree for every Bridge mode.
BRIDGE_EXTRA_ENV+=("FLYWHEEL_CODEX_HOMES_ROOT=${SLOT_DIR}/state/codex-homes")
BRIDGE_EXTRA_ENV+=("FLYWHEEL_CODEX_SESSION_DIR=${SLOT_DIR}/state/codex-sessions")
BRIDGE_EXTRA_ENV+=("FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT=${SLOT_DIR}/state/cdx-sock")
# FLY-1999: native tmux routing keeps every unqualified Bridge/adapter/reaper
# call on the slot server. The launch boundary below also removes inherited
# TMUX and the explicit override so no call can resolve back to another server.
BRIDGE_EXTRA_ENV+=("TMUX_TMPDIR=${SLOT_DIR}")
# FLY-1981: consent policy is permanently audit-only, so every QA Bridge opens
# an audit store. Keep synthetic slot decisions out of the resident calibration
# ledger even when alerts/roundtable mode is disabled.
BRIDGE_EXTRA_ENV+=("FLYWHEEL_FOUNDER_CONSENT_AUDIT_DB_PATH=${SLOT_DIR}/state/founder-consent-audit.db")
if [[ "$GENERALIZED" == "1" ]]; then
  BRIDGE_EXTRA_ENV+=("BRIDGE_DEPT_SCOPE_REJECT=${TEST_BRIDGE_DEPT_SCOPE_REJECT:-off}")
  LEAD_EXTRA_ENV+=("TMPDIR=${GENERALIZED_CHILD_TMPDIR}")
  # launchd manifests are explicit env maps rather than `env -u`; empty values
  # are the v2 carrier's scrubbed representation for ambient-only coordinates.
  # The same centralized list becomes repeated `env -u` flags at the Bridge
  # boundary below so new production roundtable settings cannot leak into only
  # one side of a generalized slot.
  while IFS= read -r _generalized_scrub_name; do
    [[ -n "$_generalized_scrub_name" ]] || continue
    LEAD_EXTRA_ENV+=("${_generalized_scrub_name}=")
    GENERALIZED_ENV_UNSET_ARGS+=(-u "$_generalized_scrub_name")
  done < <(qa_generalized_ambient_scrub_env_names)
fi
# FLY-1439: opt-in isolated Claude config for pinned-plugin real-machine QA.
# The dedicated knob is appended after the Lead launcher's `env -u
# CLAUDE_CONFIG_DIR`, so inherited production values remain scrubbed while an
# explicit test config wins. The expected-path sentinel is derived from the
# exact same bytes; claude-lead.sh fails closed if a skip request drifts.
if [[ -n "${TEST_LEAD_CLAUDE_CONFIG_DIR:-}" ]]; then
  LEAD_EXTRA_ENV+=("CLAUDE_CONFIG_DIR=${TEST_LEAD_CLAUDE_CONFIG_DIR}")
  LEAD_EXTRA_ENV+=("TEST_SKIP_PLUGIN_FORK_CHECK=1")
  LEAD_EXTRA_ENV+=("TEST_SKIP_PLUGIN_FORK_CHECK_EXPECTED_CONFIG_DIR=${TEST_LEAD_CLAUDE_CONFIG_DIR}")
fi
# FLY-1189: the single Bridge hosts multiple dept Leads. PR-C's detection /
# founder escalation posts to each owner Lead's [FLY-XX] thread with THAT lead's
# botToken (resolveLeadForIssue → lead.botToken), and loadProjects() resolves
# lead.botToken from process.env[botTokenEnv] at boot. So EVERY extra lead's
# token env must reach the Bridge — otherwise lead.botToken is empty and the post
# falls back to config.discordBotToken (the HOST bot), which is not a member of
# the dept channel → HTTP 403 (found in FLY-1189 QA: thread-note + founder page
# both 403'd because only the host TEST_BOT_TOKEN_1 was in the Bridge env). The
# host token is already passed as `${BOT_TOKEN_ENV}=…`; add the extras here.
if [[ "${EXTRA_LEADS_JSON:-[]}" != "[]" ]]; then
  while IFS= read -r _xtenv; do
    [[ -n "$_xtenv" ]] && BRIDGE_EXTRA_ENV+=("${_xtenv}=${!_xtenv:-}")
  done < <(jq -r '.[].tokenEnvVar' <<<"$EXTRA_LEADS_JSON")
fi
ROUNDTABLE_CHANNEL_ID=""
ROUNDTABLE_IDENTITY_NOTE=""

if [[ "$MODE" == "roundtable" ]]; then
  ROUNDTABLE_CHANNEL_ID=$(jq -r '.roundtableChannel.channelId // empty' "$SLOTS_FILE")
  if [[ -z "$ROUNDTABLE_CHANNEL_ID" || "$ROUNDTABLE_CHANNEL_ID" == "<test-leads-roundtable-channel-id>" ]]; then
    echo "ERROR: --mode roundtable requires roundtableChannel.channelId in ${SLOTS_FILE}." >&2
    echo "  Run scripts/setup-roundtable-channel.sh <channel-id> first (see packages/qa-framework/README.md §Roundtable Mirror)." >&2
    rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"; exit 1
  fi
  RT_HOST_SLOT=$(jq -r '.roundtableChannel.hostSlot // 1' "$SLOTS_FILE")
  RT_TRIGGER_MODE=$(jq -r '.roundtableChannel.triggerMode // "any_top_level"' "$SLOTS_FILE")
  RT_MEMBER_SLOTS=$(jq -c '.roundtableChannel.memberSlots // []' "$SLOTS_FILE")
  RT_MEMBER_USER_IDS=$(qa_room_member_user_ids "$SLOTS_FILE" "$RT_MEMBER_SLOTS")

  # Light reachability probe (the thread-CREATE permission probe lives in
  # setup-roundtable-channel.sh; here we only confirm the channel is visible to
  # this slot's bot so we fail before starting Lead + Bridge).
  RT_PROBE_HTTP=$(curl -s -H "Authorization: Bot ${TEST_BOT_TOKEN}" \
    "https://discord.com/api/v10/channels/${ROUNDTABLE_CHANNEL_ID}" \
    -o /dev/null -w "%{http_code}" 2>/dev/null || echo "000")
  if [[ "$RT_PROBE_HTTP" != "200" ]]; then
    echo "ERROR: roundtable channel ${ROUNDTABLE_CHANNEL_ID} inaccessible to bot ${AGENT_ID} (HTTP ${RT_PROBE_HTTP})." >&2
    echo "  Invite this bot + grant View/Send/Read; host bot also needs Create Public Threads + Send Messages in Threads." >&2
    echo "  See scripts/setup-roundtable-channel.sh." >&2
    rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"; exit 1
  fi

  # Lead subscribes to the roundtable channel as its cross-dept channel.
  LEAD_EXTRA_ENV+=("FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=${ROUNDTABLE_CHANNEL_ID}")
  # FLY-314 Phase 2 (Part b) / FLY-535: reply-in-thread plugin flags for the LEAD
  # pane (both host + member slots run the plugin and reply in topic threads).
  # Gated on roundtableChannel.replyInThread in test-slots.json — DEFAULT false
  # => no lines => byte-compatible (plugin stays FLY-220 mention-required). These
  # are what the FLY-314 Part-b QA (multi-lead continuation + anti-loop budget)
  # needs ON; without them the test Lead silently runs OFF = false-green.
  RT_REPLY_IN_THREAD=$(jq -r '.roundtableChannel.replyInThread // false | if . then 1 else 0 end' "$SLOTS_FILE")
  RT_AUTO_CONTINUE=$(jq -r '.roundtableChannel.autoContinue // false | if . then 1 else 0 end' "$SLOTS_FILE")
  # FLY-676: emit budget ONLY when explicitly set in test-slots.json. Absent => empty =>
  # qa-room.sh omits FLYWHEEL_ROUNDTABLE_THREAD_BUDGET => the backend default (12) is
  # exercised, so the QA Room matches the shipped production default instead of forcing 2.
  RT_THREAD_BUDGET=$(jq -r '.roundtableChannel.threadBudget // empty' "$SLOTS_FILE")
  while IFS= read -r line; do
    [[ -n "$line" ]] && LEAD_EXTRA_ENV+=("$line")
  done < <(qa_room_roundtable_lead_env \
    "$ROUNDTABLE_CHANNEL_ID" "$RT_REPLY_IN_THREAD" "$RT_AUTO_CONTINUE" "$RT_THREAD_BUDGET")
  # Identity note (no backticks — this is a normal assignment, not a heredoc):
  # tells the Lead the roundtable channel + its threads are ALSO in-scope so the
  # slot's channel-isolation rules do not make it silent-ignore roundtable msgs.
  ROUNDTABLE_IDENTITY_NOTE="- **Roundtable (FLY-529 test)**: <#${ROUNDTABLE_CHANNEL_ID}> (channel ID ${ROUNDTABLE_CHANNEL_ID}) is your SHARED cross-dept roundtable — it and its threads are ALSO in-scope (read + reply there); never silent-ignore it."
  # Host slot's Bridge runs the single auto-thread manager (isolated cursor).
  while IFS= read -r line; do
    [[ -n "$line" ]] && BRIDGE_EXTRA_ENV+=("$line")
  done < <(qa_room_roundtable_bridge_env \
    "$SLOT" "$RT_HOST_SLOT" "$ROUNDTABLE_CHANNEL_ID" "$BOT_TOKEN_ENV" "$BOT_ID" \
    "$RT_TRIGGER_MODE" "$RT_MEMBER_USER_IDS" "$SLOT_DIR")
  log "roundtable mode: channel=${ROUNDTABLE_CHANNEL_ID} hostSlot=${RT_HOST_SLOT} thisSlot=${SLOT} manager=$([[ "$SLOT" == "$RT_HOST_SLOT" ]] && echo ON || echo off) members=${RT_MEMBER_USER_IDS:-none}"
fi

if [[ "$ALERTS" == "1" ]]; then
  ALERT_CHANNEL_ID=$(jq -r '.alertChannel.channelId // empty' "$SLOTS_FILE")
  if [[ -z "$ALERT_CHANNEL_ID" || "$ALERT_CHANNEL_ID" == "<test-flywheel-alerts-channel-id>" ]]; then
    echo "ERROR: --alerts requires alertChannel.channelId in ${SLOTS_FILE}." >&2
    echo "  Run scripts/setup-alert-channel.sh <channel-id> first (see packages/qa-framework/README.md §Alert Mirror)." >&2
    rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"; exit 1
  fi
  ALERT_REPAIR_BOT_TOKEN_ENV=$(jq -r --arg d "$BOT_TOKEN_ENV" '.alertChannel.repairBotTokenEnv // $d' "$SLOTS_FILE")

  # Reachability probe for the alert channel (this slot's bot must see it).
  AL_PROBE_HTTP=$(curl -s -H "Authorization: Bot ${TEST_BOT_TOKEN}" \
    "https://discord.com/api/v10/channels/${ALERT_CHANNEL_ID}" \
    -o /dev/null -w "%{http_code}" 2>/dev/null || echo "000")
  if [[ "$AL_PROBE_HTTP" != "200" ]]; then
    echo "ERROR: alert channel ${ALERT_CHANNEL_ID} inaccessible to bot ${AGENT_ID} (HTTP ${AL_PROBE_HTTP})." >&2
    echo "  Invite this bot with View/Send/Read. See scripts/setup-alert-channel.sh." >&2
    rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"; exit 1
  fi

  # Isolated alert dirs go to BOTH Bridge and Lead (two alert writer paths).
  while IFS= read -r line; do
    [[ -n "$line" ]] && { BRIDGE_EXTRA_ENV+=("$line"); LEAD_EXTRA_ENV+=("$line"); }
  done < <(qa_room_alert_iso_env "$SLOT_DIR")
  # Unified channel + repair bot are Bridge-only.
  while IFS= read -r line; do
    [[ -n "$line" ]] && BRIDGE_EXTRA_ENV+=("$line")
  done < <(qa_room_alert_bridge_env "$ALERT_CHANNEL_ID" "$ALERT_REPAIR_BOT_TOKEN_ENV")
  # The Bridge's owner-attributed send chain dereferences the repair bot token
  # env by NAME. test-deploy sources ~/.flywheel/.env WITHOUT `set -a`, so an
  # unexported repair token would not reach the child Bridge. When the repair
  # env differs from the slot's own token env, pass its value through explicitly
  # (never logged). Codex code R2 #2.
  if [[ -n "$ALERT_REPAIR_BOT_TOKEN_ENV" && "$ALERT_REPAIR_BOT_TOKEN_ENV" != "$BOT_TOKEN_ENV" ]]; then
    BRIDGE_EXTRA_ENV+=("${ALERT_REPAIR_BOT_TOKEN_ENV}=${!ALERT_REPAIR_BOT_TOKEN_ENV:-}")
  fi
  # Shell path identity remains owned by qa_slot_start_lead: its canonical
  # projects file and mode-0600 wrapper env file carry the projects coordinate
  # and named bot token. Do not duplicate either in LEAD_EXTRA_ENV; wrapper-v2
  # rejects the drift, and extra Leads inherit this array.
  log "alerts mode: channel=${ALERT_CHANNEL_ID} repairBotEnv=${ALERT_REPAIR_BOT_TOKEN_ENV} (queue/claims/deadletter isolated to ${SLOT_DIR})"
fi

# FLY-1165: the done-thread reconcile sweep hits the REAL Linear API (fresh
# per-issue lookups) and would archive the slot's isolated threads against
# production Linear state. Explicitly OFF for every slot Bridge; a QA that
# tests the sweep itself opts in by exporting FLYWHEEL_DONE_THREAD_RECONCILE=1
# before running test-deploy.
BRIDGE_EXTRA_ENV+=("FLYWHEEL_DONE_THREAD_RECONCILE=${FLYWHEEL_DONE_THREAD_RECONCILE:-0}")

# FLY-727: --digest mounts the daily-digest route on the slot Bridge by setting
# FLYWHEEL_DIGEST_CHANNEL. The route renders /api/digest/render from the slot's
# ISOLATED StateStore; scripts/daily-digest.sh then delivers via publish-report to
# this channel using the slot's own bot token — never production. Bridge-only env
# (the digest is a Bridge cron/route; the Lead never touches it).
if [[ -n "$DIGEST_CHANNEL" ]]; then
  BRIDGE_EXTRA_ENV+=("FLYWHEEL_DIGEST_CHANNEL=${DIGEST_CHANNEL}")
  log "digest mode: FLYWHEEL_DIGEST_CHANNEL=${DIGEST_CHANNEL} (route mounts on slot Bridge; renders from isolated StateStore)"
fi

# FLY-115: per-slot normal clone eliminates cross-slot git contention
# and avoids bare-clone refspec/spin.md gotchas.
#
# Clone basename embeds the slot number (project-slot-${SLOT}) because
# WorktreeManager derives the Runner branch name from basename(projectRoot)
# (packages/edge-worker/src/WorktreeManager.ts `worktreeName`). If two slots
# ran the same issue with identical basenames, both Runners would push
# `project-<ISSUE>` to the shared sandbox remote and collide. Slot-suffixed
# basename yields slot-unique branches: `project-slot-1-FLY-108`, etc.
HOST_REPO_DIRNAME="project-slot-${SLOT}"
HOST_REPO="${SLOT_DIR}/${HOST_REPO_DIRNAME}"
QA_TEMP_BRANCH="qa-slot-${SLOT}-$(date +%s)"
log "Cloning sandbox → ${HOST_REPO} (branch: ${FROM_BRANCH})"
if [[ "$GENERALIZED" == "1" ]]; then
  TMPDIR="$GENERALIZED_CHILD_TMPDIR" \
    qa_generalized_clone_with_stall_watchdog \
      "$SANDBOX_REMOTE_URL" "$FROM_BRANCH" "$HOST_REPO" \
    || fail_preflight "git clone --branch ${FROM_BRANCH} failed or stopped growing twice. Partial clones were killed and removed; retry after checking network/auth."
else
  rm -rf "${HOST_REPO}"
  git clone --branch "${FROM_BRANCH}" "${SANDBOX_REMOTE_URL}" "${HOST_REPO}" \
    || fail_preflight "git clone --branch ${FROM_BRANCH} failed. Did you push the branch to sandbox? (see doc/qa/framework/real-runner-e2e-guide.md §6)"
fi

# Resolve remote-tracking ref for the Runner worktree start point
RUNNER_START_REF="refs/remotes/origin/${FROM_BRANCH}"
git -C "${HOST_REPO}" rev-parse --verify "$RUNNER_START_REF" >/dev/null \
  || fail_preflight "${RUNNER_START_REF} missing in slot clone"

# Host-side local branch so Annie can push via the host clone if ever needed
git -C "${HOST_REPO}" checkout -B "$QA_TEMP_BRANCH" "$RUNNER_START_REF"

# Record the SHA under test for downstream verification
BRANCH_SHA="$(git -C "${HOST_REPO}" rev-parse HEAD)"
log "Sandbox HEAD for ${FROM_BRANCH}: ${BRANCH_SHA}"

# Project identifier — referenced by .flywheel/config.yaml below and by the
# FLYWHEEL_PROJECTS jq builder later. Defined early (was only set right
# before jq build) so the v1.24.3 sandbox config write can reuse it.
TEST_PROJECT_NAME="test-slot-${SLOT}"

# ── FLY-115 v1.24.3 Gap 2 fix: write .flywheel/config.yaml ─────────
# Root cause (Round 3 §S6, sandbox): `xrliAnnie/flywheel-qa-sandbox` has no
# `.flywheel/config.yaml`, so Bridge's run-infra.ts:328-345 leaves
# checkpointConfig=undefined. Blueprint.ts:341-380 then skips the
# "APPROVE GATE (MANDATORY)" injection, so the Runner never opens
# `flywheel-comm gate approve_to_ship --no-block` and never persists
# `complete --route needs_review --question-id <id>` with the exact reviewed
# head. Without that durable question/head binding, POST /api/actions/approve
# is correctly refused: no Bridge approval response is written and the session
# cannot advance. There is no unbound approval fallback.
#
# Fix: drop a minimal-but-validator-complete config into HOST_REPO before
# Bridge starts (Step 3 below), enabling **only** approve_to_ship. We do not
# enable brainstorm/question — those would block the Runner at session start
# waiting for a Lead response and break the unrelated PR scenarios that other
# slots will run in parallel.
#
# All required keys (project / linear.team_id / runners / teams /
# decision_layer.{autonomy_level,escalation_channel}) are filled with
# safe synthetic values that match packages/config/src/ConfigLoader.ts
# validation — values are inert because the sandbox never talks to real
# Linear/Discord routing logic during the test.
mkdir -p "${HOST_REPO}/.flywheel"
# FLY-1189: content generation extracted to qa_multilead_config_yaml.
if [[ "$GENERALIZED" == "1" ]]; then
  QA_CONFIG_MODE="generalized"
else
  QA_CONFIG_MODE="ordinary"
fi
if [[ "$CODEX_RUNNER" == "1" ]]; then
  QA_CONFIG_RUNNER="codex"
else
  QA_CONFIG_RUNNER="claude"
fi
qa_multilead_config_yaml "${TEST_PROJECT_NAME}" "$QA_CONFIG_MODE" "$QA_CONFIG_RUNNER" \
  > "${HOST_REPO}/.flywheel/config.yaml"
log "Wrote ${HOST_REPO}/.flywheel/config.yaml (approve_to_ship checkpoint enabled)"

if [[ "$GENERALIZED" == "1" ]]; then
  # Complete menu-domain activation: adopted graph nodes require explicit
  # project-registry implementations. Node content is copied from the checkout
  # under test; Bridge validates the overlay before compiling each prompt.
  mkdir -p "${HOST_REPO}/.flywheel/menus" \
    "${HOST_REPO}/.flywheel/agents/nodes"
  for node in eng_design implement qa general; do
    cp "${REPO_ROOT}/.flywheel/agents/nodes/${node}.md" \
      "${HOST_REPO}/.flywheel/agents/nodes/${node}.md"
  done
  cat > "${HOST_REPO}/.flywheel/agents/registry.yaml" <<'EOF'
nodes:
  eng_design: { file: nodes/eng_design.md, department: engineering }
  implement: { file: nodes/implement.md, department: engineering }
  qa: { file: nodes/qa.md, department: engineering }
  general: { file: nodes/general.md }
EOF
  printf '%s: [code, generic]\n' "$AGENT_ID" \
    > "${HOST_REPO}/.flywheel/menus/adoption.yaml"
  if [[ "$STUB_RUNNER" == "1" ]]; then
    qa_generalized_install_stub "${SLOT_DIR}/stub-bin" \
      "${REPO_ROOT}/scripts/qa-529-generalized-stub.mjs" \
      "${REPO_ROOT}/scripts/qa-529-generalized-codex-stub.mjs"
    BRIDGE_EXTRA_ENV+=("PATH=${SLOT_DIR}/stub-bin:${PATH}")
  fi
  log "Wrote generalized registry/adoption (lead=${AGENT_ID}, menus=code,generic, runner=$([[ "$STUB_RUNNER" == "1" ]] && echo stub || echo real))"
fi

# ── Generate DISCORD_STATE_DIR files ──────────────────
# .env with test bot token
cat > "${SLOT_DIR}/discord-state/.env" <<EOF
DISCORD_BOT_TOKEN=${TEST_BOT_TOKEN}
EOF
chmod 600 "${SLOT_DIR}/discord-state/.env"

# access.json — only the test channel.
# FLY-153: in mirror mode, allowBots also includes the OTHER mirror slots'
# bot user IDs so cross-Lead bot delivery (e.g. Simba's triage report → Peter)
# survives the Discord plugin's pre-gate bot filter at server.ts:856-858.
ALLOWBOTS_JSON=$(jq -n --arg self "$BOT_ID" '[$self]')
if [[ "$MODE" == "mirror" ]]; then
  ALLOWBOTS_JSON=$(jq -n \
    --arg self "$BOT_ID" \
    --argjson selfSlot "$SLOT" \
    --slurpfile slots <(jq '.slots' "$SLOTS_FILE") \
    '
    [$self] + (
      $slots[0]
      | map(select(.id != $selfSlot and (.id == 1 or .id == 2 or .id == 3)))
      | map(.botAppId)
      | map(select(. != null and . != ""))
    )
    | unique
    ')
elif [[ "$MODE" == "roundtable" ]]; then
  # FLY-529: allowBots = self + the OTHER roundtable participant bots (host slot
  # ∪ memberSlots, minus self) so cross-Lead bot delivery in the shared
  # roundtable channel survives the plugin's pre-gate bot filter.
  ALLOWBOTS_JSON=$(qa_room_roundtable_allowbots \
    "$SLOTS_FILE" "$BOT_ID" "$SLOT" "$RT_HOST_SLOT" "$RT_MEMBER_SLOTS")
fi
# Groups: always the slot's own channel; roundtable mode adds the shared
# roundtable channel so the Lead reads/posts there too.
GROUPS_JSON=$(jq -n --arg chat "$CHAT_CHANNEL_ID" --arg rt "$ROUNDTABLE_CHANNEL_ID" '
  ({ ($chat): { requireMention: false, allowFrom: [] } })
  + (if ($rt | length) > 0 then { ($rt): { requireMention: false, allowFrom: [] } } else {} end)
')
cat > "${SLOT_DIR}/discord-state/access.json" <<EOF
{"dmPolicy":"allowlist","allowFrom":[],"allowBots":${ALLOWBOTS_JSON},"groups":${GROUPS_JSON},"pending":{}}
EOF
log "access.json allowBots: $(echo "$ALLOWBOTS_JSON" | jq -c .) groups: $(echo "$GROUPS_JSON" | jq -c 'keys')"

# ── FLY-1389 P2-b: identity + shared-rules staging are Lead-only inputs ──
# (identity.md → AGENT_SOURCE for claude-lead.sh; .lead/shared → read by
# claude-lead.sh). The Bridge consumes neither. --no-lead skips the whole
# section — this is also what lets a host WITHOUT ~/Dev/GeoForge3D run a
# Bridge-only slot (the PROD_IDENTITY existence check below would exit 1).
# NOTE: the body below is intentionally NOT re-indented (heredoc terminators
# must stay at column 0).
if [[ "$NO_LEAD" == "1" ]]; then
  log "--no-lead: skipping test identity generation + shared Lead rules staging (Bridge-only deploy)"
else

# ── Generate test identity.md from production template ──
# FLY-96 QA bug fix: 4-line identity.md didn't define announce behavior
# (session_started / completed / failed message templates), so test Leads
# didn't post anything to Discord. Source from GeoForge3D production
# identity.md (role-based) + TEST SLOT OVERRIDE banner that redirects all
# channel/bot references to this slot's dedicated resources.
# FLY-153: prefer explicit identitySource; fall back to legacy role mapping.
# Allowlist limits which GeoForge3D .lead/* dirs we'll source — mirror mode
# expects cos-lead / product-lead / ops-lead specifically.
if [[ -n "$IDENTITY_SOURCE" ]]; then
  case "$IDENTITY_SOURCE" in
    cos-lead|product-lead|ops-lead)
      SOURCE_SUBDIR="$IDENTITY_SOURCE"
      ;;
    *)
      echo "ERROR: slots[${SLOT_IDX}].identitySource '${IDENTITY_SOURCE}' not in allowlist (cos-lead|product-lead|ops-lead)" >&2
      rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
      exit 1
      ;;
  esac
else
  # Backward-compat: pre-FLY-153 test-slots.json had only `role`.
  case "$SLOT_ROLE" in
    cos)  SOURCE_SUBDIR="cos-lead" ;;
    lead) SOURCE_SUBDIR="product-lead" ;;
    *)
      echo "ERROR: unknown slot role '${SLOT_ROLE}' (expected 'cos' or 'lead')" >&2
      rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
      exit 1
      ;;
  esac
fi

PROD_IDENTITY="${HOME}/Dev/GeoForge3D/.lead/${SOURCE_SUBDIR}/identity.md"
if [[ ! -f "$PROD_IDENTITY" ]]; then
  echo "ERROR: Production identity not found: ${PROD_IDENTITY}" >&2
  echo "  (test-deploy expects ~/Dev/GeoForge3D checkout with .lead/${SOURCE_SUBDIR}/identity.md)" >&2
  rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
  exit 1
fi

# FLY-153: TEST OVERRIDE banner now has two channel-scope variants. Slot mode
# (legacy) tells the LLM to ignore ALL production channel IDs because the slot
# has its own dedicated channel. Mirror mode tells the LLM that the production
# `#geoforge3d-core` references map to the mirror channel — channel-scoped
# rules anchored on `#geoforge3d-core` (e.g. FLY-152 Shared Channel Reply
# Discipline) DO apply, but against the mirror channel. All OTHER production
# channel IDs remain prod-only and must not be touched.
PROD_CORE_CHANNEL_ID="1487340532610109520"   # #geoforge3d-core in production

# Bash quirk: `$(cat <<MARK ... MARK)` parses the heredoc body with the outer
# subshell tokenizer, which still sees apostrophes as opening string literals
# and chokes on `message's`. Build the variants without contractions to dodge
# the issue (and keep the wording slightly more formal).
if [[ "$MODE" == "mirror" ]]; then
  CHANNEL_SCOPE_BLOCK=$(cat <<MIRROR_BLOCK
## CHANNEL CONTEXT — MIRROR MODE (highest priority)

This slot subscribes to the test guild shared mirror channel
\`<#${CHAT_CHANNEL_ID}>\`, which simulates the production
\`#geoforge3d-core\` topology (3 Leads share one channel).

**Production → Mirror substitution**:

- Every reference to \`#geoforge3d-core\` (channel ID \`${PROD_CORE_CHANNEL_ID}\`)
  in the production identity below MUST be interpreted as
  \`<#${CHAT_CHANNEL_ID}>\` for this test slot.
- Channel-scoped rules anchored on \`#geoforge3d-core\` (e.g. "Core Channel
  Routing Rules", FLY-152 Shared Channel Reply Discipline) DO apply, but
  against the mirror channel.
- All OTHER production channel IDs ("Channel Isolation Rules" enumerated
  channels not equal to \`#geoforge3d-core\`) remain production-only — you
  MUST NOT post to them.
- **Your ONLY top-level channel** for any outbound message: \`<#${CHAT_CHANNEL_ID}>\`.
- **Threads inside your channel are in-scope** (FLY-162). Channel scope =
  \`chat_id == ${CHAT_CHANNEL_ID}\` OR the inbound message is in a thread whose
  \`parent_id == ${CHAT_CHANNEL_ID}\` (Discord plugin exposes \`parent_id\` on
  thread message envelopes). If \`parent_id\` is missing or you cannot infer
  it, fall back to \`GET /api/chat-threads/by-thread/<chat_id>\` — a 200 with
  any \`issueId\` confirms the thread is yours; a 404 means it is not. Only
  silent-ignore when both checks say "not yours" or when \`chat_id\` is a
  production channel ID enumerated in the production identity below.
- **Behavior rules** (when to announce session_started / session_completed /
  session_failed, message format, reactions) STILL apply — but only inside
  \`<#${CHAT_CHANNEL_ID}>\` and its threads.
MIRROR_BLOCK
)
else
  CHANNEL_SCOPE_BLOCK=$(cat <<SLOT_BLOCK
- **Your ONLY top-level channel**: <#${CHAT_CHANNEL_ID}> (channel ID \`${CHAT_CHANNEL_ID}\`)
- **Ignore** all other production channel IDs in "Channel Isolation Rules", "Core Channel Routing", "Discord Channel IDs", etc. — those belong to production.
- **Threads inside your channel are in-scope** (FLY-162). Channel scope = \`chat_id == ${CHAT_CHANNEL_ID}\` OR the inbound message is in a thread whose \`parent_id == ${CHAT_CHANNEL_ID}\` (Discord plugin exposes \`parent_id\` on thread message envelopes). If \`parent_id\` is missing or you cannot infer it, fall back to \`GET /api/chat-threads/by-thread/<chat_id>\` — a 200 with any \`issueId\` confirms the thread is yours; a 404 means it is not. Only silent-ignore when both checks say "not yours" or when \`chat_id\` is a production channel ID enumerated below.
- **Behavior rules** (when to announce session_started / session_completed / session_failed, message format, reactions) from the sections below STILL apply — but only inside <#${CHAT_CHANNEL_ID}> and its threads.
${ROUNDTABLE_IDENTITY_NOTE}
SLOT_BLOCK
)
fi

cat > "${SLOT_DIR}/test-identity.md" <<EOF
---
name: ${AGENT_ID}
description: Flywheel TEST slot ${SLOT} (${SLOT_ROLE}, mode=${MODE}) — automated QA environment
model: opus
disallowedTools: Agent
permissionMode: bypassPermissions
---

# TEST SLOT ${SLOT} — OVERRIDE (READ CAREFULLY)

**This is an automated QA test environment, not production.**
All channel IDs and bot IDs mentioned later in this file refer to PRODUCTION
resources. You MUST replace them with the TEST slot identity below and must
NOT interact with any production channel.

## TEST IDENTITY OVERRIDE (highest priority)

- **Your Bot ID**: \`${BOT_ID}\` (overrides any bot ID in the sections below)

${CHANNEL_SCOPE_BLOCK}

### Lead ID for scoped API calls (FLY-60 W6 — overrides production identity name)

The production identity below uses the production lead name (\`product-lead\` / \`cos-lead\` / \`ops-lead\`) when invoking scoped Bridge HTTP APIs and \`flywheel-comm\` CLI. **In this test slot you are NOT that lead — you are \`${AGENT_ID}\`.** APIs that accept a \`leadId\` scope-check it against the slot-configured \`agentId=${AGENT_ID}\` and 403-reject a production lead name.

- **Your leadId for scoped API calls that accept one**: \`${AGENT_ID}\` (NOT \`product-lead\` / \`cos-lead\` / \`ops-lead\` from the production template below).
- **Override scope**: every \`leadId\` value in the sections below — whether it's a literal string in JSON bodies (\`"leadId": "product-lead"\`), a CLI flag (\`--lead product-lead\`), a shell variable reference (\`\${LEAD_ID}\`, \`\${FLYWHEEL_LEAD_ID}\`), or anywhere else — MUST be substituted to \`${AGENT_ID}\` before you run the command. The production examples below are templates; you are running as \`${AGENT_ID}\`.
- **Env vars for this slot**: \`LEAD_ID=${AGENT_ID}\` and \`FLYWHEEL_LEAD_ID=${AGENT_ID}\`. Prefer using these in shell commands rather than hardcoded production names.
- **Forbidden literal strings** in any API call body / CLI flag (Bridge will 403-reject these as scope-mismatched against \`agentId=${AGENT_ID}\`):
  - \`product-lead\`
  - \`cos-lead\`
  - \`ops-lead\`
- Examples of correct usage in this slot:
  - \`curl -X POST .../api/sessions/<exec_id>/close-runner -d '{"leadId":"${AGENT_ID}","reason":"..."}'\`
  - \`curl -X POST .../api/runs/start -d '{"leadId":"${AGENT_ID}","issueId":"FLY-XXX"}'\`
- **Ship approval is not a leadId-scoped call and never uses \`respond\`**. The Runner opens \`gate approve_to_ship --no-block\`, then persists \`complete --route needs_review --question-id <id>\` with the bound question/head. The approval source POSTs \`{"execution_id":"<exec-id>"}\` and no other body fields to \`/api/actions/approve\`. Bridge writes the authoritative response, advances and wakes the legacy Runner; the Runner must then pass \`verify-approval\` for the exact head before shipping.

---

# Production identity (reference for behavior rules)

EOF
cat "$PROD_IDENTITY" >> "${SLOT_DIR}/test-identity.md"

# ── Stage shared Lead rules ──────────────────────────
# claude-lead.sh reads \${PROJECT_DIR}/.lead/shared/*.md (FLY-26). Without this
# the test Lead misses department-lead-rules.md which defines announce behavior.
#
# FLY-162: when testing a rule change that lives on a feature branch (not yet
# merged to GeoForge3D main), set GEOFORGE3D_LEAD_RULES_SRC to the worktree
# path so the test slot picks up the rule under test. Without this override,
# the test Lead reads from main and silently misses unmerged rules — which
# was the original FLY-162 TC-01 false-negative root cause.
SHARED_SRC="${GEOFORGE3D_LEAD_RULES_SRC:-${HOME}/Dev/GeoForge3D/.lead/shared}"
SHARED_DST="${HOST_REPO}/.lead/shared"
if [[ -d "$SHARED_SRC" ]]; then
  mkdir -p "$SHARED_DST"
  cp "$SHARED_SRC"/*.md "$SHARED_DST/" 2>/dev/null || true
  SHARED_COUNT=$(ls -1 "$SHARED_DST" 2>/dev/null | wc -l | tr -d ' ')
  log "Shared rules staged: ${SHARED_COUNT} files from ${SHARED_SRC}"
else
  log "WARN: ${SHARED_SRC} not found — test Lead will miss shared rules"
fi

fi  # end --no-lead skip (identity + shared rules)

# ── Generate FLYWHEEL_PROJECTS JSON ───────────────────
# FLY-115 v1.24.2 Gap 1: Use `jq -n` to build FLYWHEEL_PROJECTS so that
# `botTokenEnv` is always present → Lead/Bridge resolve token via the per-slot
# env var instead of falling back to DISCORD_BOT_TOKEN.
# FLY-163: forumChannel field removed; ProjectConfig now strips any deprecated
# forumChannel key with a warning at load time.
# FLY-173: for the cos test slot the chatChannel IS the test project core
# channel (mirrors Simba in prod where cos-lead.chatChannel == generalChannel).
# Setting generalChannel makes the Bridge route classify cos-slot core posts as
# core-channel (allow) and lets claude-lead.sh derive a non-empty
# DISCORD_CORE_CHANNEL for the test pane — needed for AC12 (Bridge-down core
# fail-open). Department slots leave generalChannel unset (no exemption,
# cross-talk guard intact).
#
# FLY-1189: builder extracted to qa_multilead_build_projects — byte-identical
# with defaults (["*"] labels, no extras; unit-guarded A1/A2). --lead-label
# narrows the MAIN lead's match.labels; --extra-lead appends additional leads
# (own bot / channel / token env / dept label) to the SAME single project.
MAIN_LABELS_JSON='["*"]'
if [[ -n "$LEAD_LABEL" ]]; then
  MAIN_LABELS_JSON=$(jq -cn --arg l "$LEAD_LABEL" '[$l]')
fi
EXTRA_LEADS_JSON=$(jq -c --arg root "${SLOT_DIR}/extra-leads" '
  map(. + {
    discordStateDir: ($root + "/slot-" + (.slotId | tostring) + "/discord-state")
  })' <<<"$EXTRA_LEADS_JSON")
FLYWHEEL_PROJECTS=$(qa_multilead_build_projects \
  "$TEST_PROJECT_NAME" "$HOST_REPO" "$SANDBOX_SLUG" "$AGENT_ID" \
  "$CHAT_CHANNEL_ID" "$BOT_TOKEN_ENV" "$SLOT_ROLE" \
  "$MAIN_LABELS_JSON" "$EXTRA_LEADS_JSON" "$BOT_ID" \
  "${SLOT_DIR}/discord-state" "$MAIN_LEAD_SHAPE")

# FLY-529: when --alerts is on, inject the test alert channel + token env into
# the test lead's projects entry so the SHELL-side lead-alert.sh (which resolves
# its channel from FLYWHEEL_PROJECTS_FILE, NOT the unified env) posts to the
# isolated test channel instead of dead-lettering as unknown config.
# alertBotTokenEnv = the SLOT's own token env (not the repair env): the shell
# path posts via the Lead's own bot, resolved from the canonical mode-0600
# wrapper env file. It must not be copied into LEAD_EXTRA_ENV. The repair bot
# env stays Bridge-only (owner-attributed send chain).
if [[ "$ALERTS" == "1" ]]; then
  FLYWHEEL_PROJECTS=$(printf '%s' "$FLYWHEEL_PROJECTS" \
    | qa_room_inject_alert_into_projects "$AGENT_ID" "$ALERT_CHANNEL_ID" "$BOT_TOKEN_ENV")
  # FLY-1189: extra Leads get the same shell-side lead-alert.sh parity — each
  # entry resolves the test alert channel + ITS OWN token env from the
  # projects file.
  if (( ${#EXTRA_LEAD_SPECS[@]} > 0 )); then
    while IFS=$'\t' read -r XAGENT XTOKEN_ENV_NAME; do
      [[ -z "$XAGENT" ]] && continue
      FLYWHEEL_PROJECTS=$(printf '%s' "$FLYWHEEL_PROJECTS" \
        | qa_room_inject_alert_into_projects "$XAGENT" "$ALERT_CHANNEL_ID" "$XTOKEN_ENV_NAME")
    done < <(jq -r '.[] | [.agentId, .tokenEnvVar] | @tsv' <<<"$EXTRA_LEADS_JSON")
  fi
fi

# Launch specs are intentionally single-line for every environment value.
# Compact the already-validated JSON once, before both the file and live-env
# projections, so initial launch and cycle replay remain byte-identical.
FLYWHEEL_PROJECTS=$(jq -c . <<<"$FLYWHEEL_PROJECTS") \
  || campaign_abort "failed to compact FLYWHEEL_PROJECTS"

# FLY-153 R2 #3: persist FLYWHEEL_PROJECTS to disk so the smoke test (and any
# operator) can deterministically inspect the routing config without scraping
# the live Bridge process env. Bridge still receives FLYWHEEL_PROJECTS via env
# below — this is a double-write, not a relocation.
FLYWHEEL_PROJECTS_FILE="${SLOT_DIR}/flywheel-projects.json"
echo "$FLYWHEEL_PROJECTS" > "$FLYWHEEL_PROJECTS_FILE"
log "Wrote ${FLYWHEEL_PROJECTS_FILE}"

# FLY-1775 pit 5: GET visibility does not prove Send Messages. In a
# generalized --alerts room, exercise every bot that the scrubbed Bridge send
# chain can actually select, then delete its marker. This catches the observed
# slot-1-works/slot-2-403 invitation matrix before Bridge startup.
if [[ "$GENERALIZED" == "1" && "$ALERTS" == "1" ]]; then
  _alert_sender_envs=""
  while IFS= read -r _sender_env; do
    [[ -n "$_sender_env" ]] || continue
    [[ " $_alert_sender_envs " == *" $_sender_env "* ]] && continue
    _alert_sender_envs="${_alert_sender_envs} ${_sender_env}"
  done < <(
    {
      jq -r '.[].leads[].botTokenEnv // empty' <<<"$FLYWHEEL_PROJECTS"
      printf '%s\n' "$ALERT_REPAIR_BOT_TOKEN_ENV"
    }
  )
  for _sender_env in $_alert_sender_envs; do
    _sender_token="${!_sender_env:-}"
    if [[ -z "$_sender_token" ]]; then
      echo "ERROR: generalized alert sender ${_sender_env} has no token value." >&2
      echo "  Configure the slot-local token; production fallback is intentionally scrubbed." >&2
      exit 1
    fi
    if ! qa_generalized_probe_discord_sender "$ALERT_CHANNEL_ID" "$_sender_env" "$_sender_token"; then
      echo "ERROR: invite slot ${SLOT} bot ${_sender_env} to alert channel ${ALERT_CHANNEL_ID} and grant Send Messages + Manage Messages (marker cleanup)." >&2
      exit 1
    fi
  done
  unset _alert_sender_envs _sender_env _sender_token
  log "generalized alert preflight: every sender-capable slot bot passed POST+DELETE"
fi

# Start one slot-scoped Lead as launchd -> wrapper-v2 -> private tmux -> body.
# stdout: launchdPid<TAB>socket<TAB>label<TAB>manifest<TAB>pidFile
qa_slot_start_lead() {
  local carrier_slot="$1" agent="$2" token_env="$3" token_value="$4"
  local role="$5" discord_state="$6" identity="$7" workspace="$8" lead_log="$9"
  shift 9
  local runtime="${SLOT_DIR}/launchd/${agent}" state="${SLOT_DIR}/q/${carrier_slot}"
  local projects="${state}/projects.json" env_file="${state}/.env"
  local manifest="${runtime}/manifest.json" plist="${runtime}/lead.plist"
  local pid_file="${runtime}/pid" label wrapper launch_env topology launch_pid socket
  local lead_row mcp_exclude
  label=$(qa_launchd_label "$carrier_slot" "$agent") || return 1
  wrapper="${FLYWHEEL_QA_LEAD_WRAPPER:-${REPO_ROOT}/scripts/flywheel-lead-wrapper-v2.sh}"
  mkdir -p "$runtime" "$state" "$workspace" || return 1
  chmod 700 "$runtime" "$state"
  printf '%s\n' "$FLYWHEEL_PROJECTS" > "$projects"
  qa_lead_write_env "$env_file" "$token_env" "$token_value" || return 1
  chmod 600 "$projects"

  lead_row=$(jq -cer --arg agent "$agent" \
    '[.[].leads[]? | select(.agentId == $agent)] | if length == 1 then .[0] else error("expected one Lead") end' \
    <<<"$FLYWHEEL_PROJECTS") || return 1
  mcp_exclude=$(jq -r '.mcpExclude // ""' <<<"$lead_row")
  launch_env=$(qa_slot_launch_env_json \
    "DISCORD_GUILD_ID=${GUILD_ID}" \
    "BRIDGE_URL=http://localhost:${SLOT_PORT}" \
    "AGENT_SOURCE=${identity}" \
    "TEAMLEAD_API_TOKEN=${TEST_TEAMLEAD_API_TOKEN}" \
    "FLYWHEEL_PROJECTS_FILE=${projects}" \
    "TEAMLEAD_DB_PATH=${SLOT_DIR}/teamlead.db" \
    "FLYWHEEL_STATE_DIR=${state}" \
    "FLYWHEEL_WRAPPER_ENV_FILE=${env_file}" \
    "FLYWHEEL_DELIVERY_SECRET_PATH=${SLOT_DIR}/state/delivery-secret" \
    "LEAD_WORKSPACE=${workspace}" \
    "$@") || return 1
  qa_lead_write_manifest "$manifest" "$agent" "$HOST_REPO" \
    "$TEST_PROJECT_NAME" "$projects" "$workspace" "$mcp_exclude" \
    "$launch_env" || return 1
  FLYWHEEL_DIR="$REPO_ROOT" qa_launchd_render_plist \
    "$plist" "$label" "$wrapper" "$manifest" "$HOME" "$state" \
    "$projects" "$env_file" "$lead_log" "$QA_SUMMARY_CONFIG_HOME" || return 1
  qa_launchd_register "$QA_LEAD_REGISTRY" "$label" "$plist" "$manifest" || return 1
  launch_pid=$(qa_launchd_lead_start "$label" "$plist") || return 1
  topology=$(qa_launchd_lead_verify "$label" "$manifest") \
    || { qa_launchd_lead_stop "$label" || true; return 1; }
  IFS=$'\t' read -r launch_pid socket <<<"$topology"
  printf '%s\n' "$launch_pid" > "$pid_file"
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$launch_pid" "$socket" "$label" "$manifest" "$pid_file"
}

# ── FLY-1389 P0-d: test slots are FRESH by definition — unconditionally drop
# any stale session-id left by a prior round. A stale id makes every
# `claude --resume` fail deterministically (transcript for the old workspace
# slug does not exist); teardown normally removes it, but a crashed deploy
# skips teardown — exactly the 529 Room incident (9 resume crashes, 0
# successes, lease never appeared).
rm -f "${HOME}/.flywheel/claude-sessions/${TEST_PROJECT_NAME}-${AGENT_ID}.session-id"

# FLY-1389 P2-b: Lead-path variables must exist (set -u) on the --no-lead
# path too — Bridge failure handling + the output JSON reference them.
LEAD_BG_PID=""
LEAD_LOG=""
LEAD_SOCKET=""
LEAD_LAUNCHD_LABEL=""
LEAD_PID_FILE=""

if [[ "$NO_LEAD" == "1" ]]; then
  log "--no-lead: skipping Lead startup + dev-channels confirm + lease wait (Bridge-only deploy)"
else

log "Starting test Lead: ${AGENT_ID} (project: ${TEST_PROJECT_NAME}, mode=${MODE}, channel=${EFFECTIVE_CHANNEL_LABEL}=${CHAT_CHANNEL_ID})"

# Private-socket equivalent of the old shared-window dev-channels workaround.
# FLY-1679 note: since the launcher itself auto-confirms on the v2 carrier
# (_poll_dev_channels_dialog_v2), this compensating poller is normally a no-op —
# it just reports "no dev-channels prompt observed". Setting
# SKIP_DEV_CHANNELS_WORKAROUND=1 removes it entirely, which is how a QA slot
# proves the production startup chain confirms the dialog with zero keypresses.
confirm_dev_channels_prompt() {
  local socket="$1" lead_name="$2" pane="" i hit=false
  if [[ "${SKIP_DEV_CHANNELS_WORKAROUND:-0}" == "1" ]]; then
    log "SKIP_DEV_CHANNELS_WORKAROUND=1 — ${lead_name} relies on the launcher's own dev-channels auto-confirm (FLY-1679)"
    return 0
  fi
  log "Polling private Lead socket for ${lead_name} dev-channels prompt"
  for i in $(seq 1 30); do
    pane=$(tmux -S "$socket" capture-pane -t '=main:main.%0' -p 2>/dev/null || echo "")
    if echo "$pane" | grep -qE "Loading development channels|am using this for local|development channels"; then
      tmux -S "$socket" send-keys -t '=main:main.%0' "1" 2>/dev/null || true
      sleep 0.3
      tmux -S "$socket" send-keys -t '=main:main.%0' Enter 2>/dev/null || true
      hit=true
      break
    fi
    sleep 1
  done
  [[ "$hit" == "true" ]] \
    && log "Confirmed dev-channels prompt for ${lead_name}" \
    || log "No dev-channels prompt observed for ${lead_name}"
}

# ── Step 1: bootstrap isolated launchd-v2 Lead ─────────────
LEAD_LOG="${SLOT_DIR}/lead.log"
LEAD_LAUNCH_RECORD=$(qa_slot_start_lead \
  "$SLOT" "$AGENT_ID" "$BOT_TOKEN_ENV" "$TEST_BOT_TOKEN" "$SLOT_ROLE" \
  "${SLOT_DIR}/discord-state" "${SLOT_DIR}/test-identity.md" \
  "${SLOT_DIR}/lead-workspace" "$LEAD_LOG" \
  ${LEAD_EXTRA_ENV[@]+"${LEAD_EXTRA_ENV[@]}"}) \
  || { log "ERROR: launchd-v2 Lead bootstrap failed"; exit 1; }
IFS=$'\t' read -r LEAD_BG_PID LEAD_SOCKET LEAD_LAUNCHD_LABEL _lead_manifest LEAD_PID_FILE \
  <<<"$LEAD_LAUNCH_RECORD"
log "Lead background PID: ${LEAD_BG_PID}"
log "$(qa_lead_log_launchd_label "$LEAD_LAUNCHD_LABEL" "$LEAD_SOCKET")"
confirm_dev_channels_prompt "$LEAD_SOCKET" "$AGENT_ID"

# ── Step 2: Wait for Lead inbox-ready lease ───────────
# FLY-1389 P2-a: budget is LEAD_READY_TIMEOUT_SEC (default 120s; flag/env
# knob resolved before preflight) — 2s poll → LEAD_READY_POLL_ITERS.
LEASE_DIR="${HOME}/.flywheel/comm/${TEST_PROJECT_NAME}"
LEASE_FILE="${LEASE_DIR}/.inbox-ready-${AGENT_ID}"
log "Waiting for lease: ${LEASE_FILE} (budget ${LEAD_READY_TIMEOUT_SEC}s)"

LEAD_READY=false
for i in $(seq 1 "$LEAD_READY_POLL_ITERS"); do
  if [[ -f "$LEASE_FILE" ]]; then
    LEASE_PID=$(jq -r '.pid' "$LEASE_FILE" 2>/dev/null || echo "")
    if [[ -n "$LEASE_PID" ]] && kill -0 "$LEASE_PID" 2>/dev/null; then
      log "Lead ${AGENT_ID} ready (lease alive, PID ${LEASE_PID})"
      LEAD_READY=true
      break
    fi
  fi
  LEAD_BG_PID=$(qa_launchd_lead_pid "$LEAD_LAUNCHD_LABEL" || true)
  sleep 2
done

if [[ "$LEAD_READY" != "true" ]]; then
  log "ERROR: Lead did not become ready within ${LEAD_READY_TIMEOUT_SEC} seconds"
  qa_launchd_lead_stop "$LEAD_LAUNCHD_LABEL" || true
  rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
  exit 1
fi

fi  # end --no-lead skip (Lead startup + dev-channels confirm + lease wait)

# ── FLY-1189 Step 2b: Start extra test Leads (campaign mode only) ──────────
# Each extra Lead = another slot's bot + channel, attached to THIS slot's
# single Bridge via the multi-lead FLYWHEEL_PROJECTS built above. All extra
# Lead resources live under ${SLOT_DIR}/extra-leads/slot-<N>/ so the OWNER
# slot's teardown wipes everything; the borrowed slot's own SLOT_DIR is never
# created.
CAMPAIGN_ID=""
CAMPAIGN_MANIFEST_FILE=""

if (( ${#EXTRA_LEAD_SPECS[@]} > 0 )); then
  CAMPAIGN_ID="fly1189-$(date +%s)-slot${SLOT}"
  CAMPAIGN_MANIFEST_FILE="${SLOT_DIR}/campaign-manifest.json"
  EXTRA_LEAD_BG_PIDS=()

  campaign_abort() {
    log "ERROR: $1 — aborting campaign deploy"
    qa_launchd_stop_registry "$QA_LEAD_REGISTRY" 2>/dev/null || true
    if [[ -f "$CAMPAIGN_MANIFEST_FILE" ]]; then
      qa_multilead_teardown_extra_leads "$CAMPAIGN_MANIFEST_FILE" || true
    fi
    local xsid
    for xsid in ${CAMPAIGN_SLOT_IDS[@]+"${CAMPAIGN_SLOT_IDS[@]}"}; do
      rm -rf "/tmp/flywheel-test-slot-${xsid}.lock"
    done
    exit 1
  }

  # Write the campaign manifest BEFORE starting anything — every resource path
  # is deterministic, so failure paths (campaign_abort, cleanup_on_failure,
  # test-teardown.sh) can always clean by manifest even mid-startup.
  EXTRA_LEADS_MANIFEST=$(jq \
    --arg home "$HOME" --arg pn "$TEST_PROJECT_NAME" --arg slotdir "$SLOT_DIR" \
    'map({
      slotId, agentId, deptLabel,
      chatChannelId: .chatChannel,
      botTokenEnv: .tokenEnvVar,
      tmuxWindow: "",
      launchdLabel: ("com.flywheel.qa.lead.slot-" + (.slotId | tostring) + "." + .agentId),
      stateDir: ($slotdir + "/extra-leads/slot-" + (.slotId | tostring)),
      pidFile: ($slotdir + "/launchd/" + .agentId + "/pid"),
      sessionIdFile: ($home + "/.flywheel/claude-sessions/" + $pn + "-" + .agentId + ".session-id"),
      leadManifest: ($slotdir + "/launchd/" + .agentId + "/manifest.json"),
      leadWorkspace: ($slotdir + "/extra-leads/slot-" + (.slotId | tostring) + "/lead-workspace")
    })' <<<"$EXTRA_LEADS_JSON")
  jq -n \
    --arg cid "$CAMPAIGN_ID" \
    --argjson owner "$SLOT" \
    --arg pn "$TEST_PROJECT_NAME" \
    --argjson borrowed "$(jq -c '[.[].slotId]' <<<"$EXTRA_LEADS_JSON")" \
    --argjson extraLeads "$EXTRA_LEADS_MANIFEST" \
    '{campaignId: $cid, ownerSlot: $owner, projectName: $pn, borrowedSlots: $borrowed, extraLeads: $extraLeads}' \
    > "$CAMPAIGN_MANIFEST_FILE"
  log "Wrote ${CAMPAIGN_MANIFEST_FILE}"

  while IFS= read -r XLEAD; do
    [[ -z "$XLEAD" ]] && continue
    XSID=$(jq -r '.slotId' <<<"$XLEAD")
    XAGENT=$(jq -r '.agentId' <<<"$XLEAD")
    XBOT_ID=$(jq -r '.botAppId' <<<"$XLEAD")
    XCHANNEL=$(jq -r '.chatChannel' <<<"$XLEAD")
    XTOKEN_ENV_NAME=$(jq -r '.tokenEnvVar' <<<"$XLEAD")
    XROLE=$(jq -r '.role' <<<"$XLEAD")
    XIDENTITY_SOURCE=$(jq -r '.identitySource // empty' <<<"$XLEAD")
    XLABEL=$(jq -r '.deptLabel' <<<"$XLEAD")
    XTOKEN="${!XTOKEN_ENV_NAME:-}"
    [[ -n "$XTOKEN" ]] || campaign_abort "extra-lead token env ${XTOKEN_ENV_NAME} empty"

    XDIR="${SLOT_DIR}/extra-leads/slot-${XSID}"
    mkdir -p "${XDIR}/discord-state"
    cat > "${XDIR}/discord-state/.env" <<EOF
DISCORD_BOT_TOKEN=${XTOKEN}
EOF
    chmod 600 "${XDIR}/discord-state/.env"
    XALLOWBOTS=$(jq -n --arg self "$XBOT_ID" '[$self]')
    XGROUPS=$(jq -n --arg chat "$XCHANNEL" '{ ($chat): { requireMention: false, allowFrom: [] } }')
    cat > "${XDIR}/discord-state/access.json" <<EOF
{"dmPolicy":"allowlist","allowFrom":[],"allowBots":${XALLOWBOTS},"groups":${XGROUPS},"pending":{}}
EOF

    # Identity: same source-allowlist + role fallback as the main Lead.
    if [[ -n "$XIDENTITY_SOURCE" ]]; then
      case "$XIDENTITY_SOURCE" in
        cos-lead|product-lead|ops-lead) XSOURCE_SUBDIR="$XIDENTITY_SOURCE" ;;
        *) campaign_abort "extra-lead slot ${XSID} identitySource '${XIDENTITY_SOURCE}' not in allowlist (cos-lead|product-lead|ops-lead)" ;;
      esac
    else
      case "$XROLE" in
        cos)  XSOURCE_SUBDIR="cos-lead" ;;
        lead) XSOURCE_SUBDIR="product-lead" ;;
        *)    campaign_abort "extra-lead slot ${XSID} unknown role '${XROLE}'" ;;
      esac
    fi
    XPROD_IDENTITY="${HOME}/Dev/GeoForge3D/.lead/${XSOURCE_SUBDIR}/identity.md"
    [[ -f "$XPROD_IDENTITY" ]] || campaign_abort "production identity not found: ${XPROD_IDENTITY}"

    cat > "${XDIR}/test-identity.md" <<EOF
---
name: ${XAGENT}
description: Flywheel TEST slot ${XSID} (${XROLE}, mode=extra-lead) — automated QA environment (campaign owner: slot ${SLOT})
model: opus
disallowedTools: Agent
permissionMode: bypassPermissions
---

# TEST EXTRA-LEAD (slot ${XSID} bot on the slot ${SLOT} Bridge) — OVERRIDE (READ CAREFULLY)

**This is an automated QA test environment, not production.**
All channel IDs and bot IDs mentioned later in this file refer to PRODUCTION
resources. You MUST replace them with the TEST identity below and must NOT
interact with any production channel.

## TEST IDENTITY OVERRIDE (highest priority)

- **Your Bot ID**: \`${XBOT_ID}\` (overrides any bot ID in the sections below)

- **Your ONLY top-level channel**: <#${XCHANNEL}> (channel ID \`${XCHANNEL}\`)
- **Ignore** all other production channel IDs in "Channel Isolation Rules", "Core Channel Routing", "Discord Channel IDs", etc. — those belong to production.
- **Threads inside your channel are in-scope** (FLY-162). Channel scope = \`chat_id == ${XCHANNEL}\` OR the inbound message is in a thread whose \`parent_id == ${XCHANNEL}\` (Discord plugin exposes \`parent_id\` on thread message envelopes). If \`parent_id\` is missing or you cannot infer it, fall back to \`GET /api/chat-threads/by-thread/<chat_id>\` — a 200 with any \`issueId\` confirms the thread is yours; a 404 means it is not. Only silent-ignore when both checks say "not yours" or when \`chat_id\` is a production channel ID enumerated below.
- **Behavior rules** (when to announce session_started / session_completed / session_failed, message format, reactions) from the sections below STILL apply — but only inside <#${XCHANNEL}> and its threads.

### Lead ID for API calls (FLY-60 W6 — overrides production identity name)

**In this test slot you are \`${XAGENT}\`.** The Bridge scope-checks every API call against the configured \`agentId=${XAGENT}\` and 403-rejects any call that uses a production lead name.

- **Your leadId for ALL API calls**: \`${XAGENT}\` (NOT \`product-lead\` / \`cos-lead\` / \`ops-lead\` from the production template below).
- **Override scope**: every \`leadId\` value in the sections below — literal JSON strings, CLI flags, shell variable references — MUST be substituted to \`${XAGENT}\` before you run the command.
- **Env vars for this slot**: \`LEAD_ID=${XAGENT}\` and \`FLYWHEEL_LEAD_ID=${XAGENT}\`.

---

# Production identity (reference for behavior rules)

EOF
    cat "$XPROD_IDENTITY" >> "${XDIR}/test-identity.md"

    XLEAD_LOG="${XDIR}/lead.log"
    # qa_slot_start_lead writes this Lead's canonical token to its wrapper env
    # file. Do not also put it in launchEnvironment: wrapper-v2 rejects that
    # competing secret source before projecting any identity.
    XLEAD_ENV=(${LEAD_EXTRA_ENV[@]+"${LEAD_EXTRA_ENV[@]}"})
    log "Starting extra test Lead: ${XAGENT} (slot ${XSID} bot, label ${XLABEL}, channel ${XCHANNEL})"
    # FLY-1389 P0-d: extra Leads are fresh too — drop any stale session-id.
    rm -f "${HOME}/.flywheel/claude-sessions/${TEST_PROJECT_NAME}-${XAGENT}.session-id"
    XLEAD_LAUNCH_RECORD=$(qa_slot_start_lead \
      "$XSID" "$XAGENT" "$XTOKEN_ENV_NAME" "$XTOKEN" "$XROLE" \
      "${XDIR}/discord-state" "${XDIR}/test-identity.md" \
      "${XDIR}/lead-workspace" "$XLEAD_LOG" "${XLEAD_ENV[@]}") \
      || campaign_abort "extra Lead ${XAGENT} launchd-v2 bootstrap failed"
    IFS=$'\t' read -r XLEAD_BG_PID XLEAD_SOCKET _xlead_label _xlead_manifest _xlead_pid_file \
      <<<"$XLEAD_LAUNCH_RECORD"
    EXTRA_LEAD_BG_PIDS+=("$XLEAD_BG_PID")
    log "$(qa_lead_log_extra_pid "$XAGENT" "$XLEAD_BG_PID")"

    confirm_dev_channels_prompt "$XLEAD_SOCKET" "$XAGENT"

    XLEASE_FILE="${LEASE_DIR}/.inbox-ready-${XAGENT}"
    XLEAD_READY=false
    for i in $(seq 1 "$LEAD_READY_POLL_ITERS"); do
      if [[ -f "$XLEASE_FILE" ]]; then
        XLEASE_PID=$(jq -r '.pid' "$XLEASE_FILE" 2>/dev/null || echo "")
        if [[ -n "$XLEASE_PID" ]] && kill -0 "$XLEASE_PID" 2>/dev/null; then
          XLEAD_READY=true
          break
        fi
      fi
      sleep 2
    done
    [[ "$XLEAD_READY" == "true" ]] || campaign_abort "extra Lead ${XAGENT} did not become ready within ${LEAD_READY_TIMEOUT_SEC}s (log: ${XLEAD_LOG})"
    log "Extra Lead ${XAGENT} ready (lease alive)"
  done < <(jq -c '.[]' <<<"$EXTRA_LEADS_JSON")

  # Bridge must resolve EVERY lead's botTokenEnv by name (ProjectConfig
  # dereferences process.env[botTokenEnv] per lead) — pass each extra token
  # through explicitly (never logged).
  while IFS= read -r XTOKEN_ENV_NAME; do
    [[ -z "$XTOKEN_ENV_NAME" ]] && continue
    BRIDGE_EXTRA_ENV+=("${XTOKEN_ENV_NAME}=${!XTOKEN_ENV_NAME}")
  done < <(jq -r '.[].tokenEnvVar' <<<"$EXTRA_LEADS_JSON")
fi
BRIDGE_EXTRA_ENV+=("FLYWHEEL_STATE_DIR=${SLOT_DIR}")

# ── Step 3: Start test Bridge (file-backed DB, real-Runner env) ──
# FLY-115 §4.5: file-backed teamlead.db so FLY-108 S4 chain is visible
# across processes; TEAMLEAD_URL so Blueprint/TmuxAdapter forward
# FLYWHEEL_BRIDGE_URL to the Runner; FLYWHEEL_RUNNER_START_POINT so the
# Runner worktree HEAD tracks sandbox <from-branch>; LINEAR_API_KEY so
# /api/runs/start PreHydrator can verify issues against Linear; stdout +
# stderr redirected to bridge.log for QA observability.
#
# Default: env -u TEAMLEAD_API_TOKEN so /api/* routes don't require
# auth in test (matches the original FLY-96 baseline).
#
# FLY-162 (when TEST_REPLY_BY_ISSUE=1): inject TEAMLEAD_API_TOKEN +
# TEAMLEAD_CHAT_THREADS_ENABLED=true + TEAMLEAD_REPLY_BY_ISSUE_ENABLED=true
# + TEAMLEAD_REPLY_GUARD_ENABLED=true (Layer 2) so the test slot can
# exercise both the reply-by-issue routes and the preventive reply-guard.
# The same token was injected into the Lead env above so the Lead's curl
# templates authenticate; TEAMLEAD_ISSUE_PREFIXES defaults to FLY,GEO via
# claude-lead.sh.
log "Starting test Bridge on port ${SLOT_PORT} (from-branch=${FROM_BRANCH})"
[[ -n "${AGENT_ID:-}" ]] \
  || campaign_abort "TEAMLEAD_DEFAULT_LEAD_AGENT requires non-empty AGENT_ID"
QA_SLOT_BRIDGE_NODE="${FLYWHEEL_QA_NODE:-$(command -v node)}"
QA_SLOT_BRIDGE_NPX="$(command -v npx)"
QA_SLOT_BRIDGE_BASH="$(command -v bash)"
QA_SLOT_BRIDGE_SESSION_LAUNCHER="$(command -v python3)"
[[ "$QA_SLOT_BRIDGE_NODE" == /* && -x "$QA_SLOT_BRIDGE_NODE" ]] \
  || campaign_abort "FLYWHEEL_QA_NODE must resolve to an absolute executable"
[[ "$QA_SLOT_BRIDGE_NPX" == /* && -x "$QA_SLOT_BRIDGE_NPX" ]] \
  || campaign_abort "npx must resolve to an absolute executable"
[[ "$QA_SLOT_BRIDGE_BASH" == /* && -x "$QA_SLOT_BRIDGE_BASH" ]] \
  || campaign_abort "bash must resolve to an absolute executable"
[[ "$QA_SLOT_BRIDGE_SESSION_LAUNCHER" == /* && -x "$QA_SLOT_BRIDGE_SESSION_LAUNCHER" ]] \
  || campaign_abort "python3 must resolve to an absolute executable"
BRIDGE_LAUNCH_CWD="$PWD"
BRIDGE_OWNERSHIP_CAPTURE_ARGS=()
if (( ${#CAMPAIGN_SLOT_IDS[@]} > 0 )); then
  for XSID in "${CAMPAIGN_SLOT_IDS[@]}"; do
    BRIDGE_OWNERSHIP_CAPTURE_ARGS+=(
      --ownership-pid-file "/tmp/flywheel-test-slot-${XSID}.lock/pid"
    )
  done
else
  BRIDGE_OWNERSHIP_CAPTURE_ARGS+=(
    --ownership-pid-file "/tmp/flywheel-test-slot-${SLOT}.lock/pid"
  )
fi
# FLY-115 v1.24.2 Gap 1 (Codex R1 LOW fix): also pass the per-lead token
# under the name the ProjectConfig references in `botTokenEnv` (e.g.
# TEST_BOT_TOKEN_1). Without this, process.env[botTokenEnv] is empty and
# loadProjects() silently falls back to DISCORD_BOT_TOKEN
# (packages/teamlead/src/ProjectConfig.ts:179-189). Fallback works for a
# single-slot test but masks a real misconfiguration (wrong tokenEnvVar,
# wrong .env key). Exporting both keeps botTokenEnv load-bearing.
if [[ "$GENERALIZED" == "1" ]]; then
  GENERALIZED_REPLY_ENV=()
  if [[ "${TEST_REPLY_BY_ISSUE:-0}" == "1" ]]; then
    GENERALIZED_REPLY_ENV+=("TEAMLEAD_CHAT_THREADS_ENABLED=true")
    GENERALIZED_REPLY_ENV+=("TEAMLEAD_REPLY_BY_ISSUE_ENABLED=true")
    GENERALIZED_REPLY_ENV+=("TEAMLEAD_REPLY_GUARD_ENABLED=true")
  fi
  ( qa_generalized_exec_with_ingest_token "$TEST_TEAMLEAD_INGEST_TOKEN" env \
    ${GENERALIZED_ENV_UNSET_ARGS[@]+"${GENERALIZED_ENV_UNSET_ARGS[@]}"} \
    -u TMUX \
    -u FLYWHEEL_TMUX_SOCKET_OVERRIDE \
    -u FLYWHEEL_QA_NODE \
    -u TEAMLEAD_REPLY_BY_ISSUE_ENABLED \
    -u TEAMLEAD_REPLY_GUARD_ENABLED \
    -u TEAMLEAD_CHAT_THREADS_ENABLED \
    TMPDIR="${GENERALIZED_CHILD_TMPDIR}" \
    TEAMLEAD_PORT="${SLOT_PORT}" \
    TEAMLEAD_DEFAULT_LEAD_AGENT="${AGENT_ID}" \
    DISCORD_OWNER_USER_ID="${QA1189_OWNER_OVERRIDE:-${DISCORD_OWNER_USER_ID:-}}" \
    DISCORD_BOT_TOKEN="${TEST_BOT_TOKEN}" \
    "${BOT_TOKEN_ENV}=${TEST_BOT_TOKEN}" \
    TEAMLEAD_DB_PATH="${SLOT_DIR}/teamlead.db" \
    TEAMLEAD_URL="http://localhost:${SLOT_PORT}" \
    FLYWHEEL_PROJECTS="${FLYWHEEL_PROJECTS}" \
    FLYWHEEL_PROJECTS_FILE="${FLYWHEEL_PROJECTS_FILE}" \
    FLYWHEEL_SUMMARY_CONFIG_HOME="${QA_SUMMARY_CONFIG_HOME}" \
    LINEAR_API_KEY="${LINEAR_API_KEY}" \
    FLYWHEEL_RUNNER_START_POINT="${RUNNER_START_REF}" \
    FLYWHEEL_BIN_DIR="${SLOT_DIR}/bin" \
    FLYWHEEL_HOOKS_DIR="${SLOT_DIR}/hooks" \
    TEAMLEAD_API_TOKEN="${TEST_TEAMLEAD_API_TOKEN}" \
    ${GENERALIZED_REPLY_ENV[@]+"${GENERALIZED_REPLY_ENV[@]}"} \
    ${BRIDGE_EXTRA_ENV[@]+"${BRIDGE_EXTRA_ENV[@]}"} \
    "$QA_SLOT_BRIDGE_NODE" "${SCRIPT_DIR}/lib/qa-slot-bridge-spec.mjs" capture \
      --spec "$BRIDGE_LAUNCH_SPEC" --slot "$SLOT" --port "$SLOT_PORT" \
      --bridge-url "http://localhost:${SLOT_PORT}" --cwd "$BRIDGE_LAUNCH_CWD" \
      --repo-root "$REPO_ROOT" \
      --session-launcher "$QA_SLOT_BRIDGE_SESSION_LAUNCHER" \
      --log "${SLOT_DIR}/bridge.log" --script "${REPO_ROOT}/scripts/run-bridge.ts" \
      "${BRIDGE_OWNERSHIP_CAPTURE_ARGS[@]}" -- \
      "$QA_SLOT_BRIDGE_BASH" "${SCRIPT_DIR}/lib/qa-generalized-bridge-wrapper.sh" \
      "$QA_SLOT_BRIDGE_NPX" tsx "${REPO_ROOT}/scripts/run-bridge.ts" )
elif [[ "${TEST_REPLY_BY_ISSUE:-0}" == "1" ]]; then
  # FLY-1389 P1-a: FLYWHEEL_BIN_DIR / FLYWHEEL_HOOKS_DIR pin the slot Bridge's
  # runtime deploy (sync-flywheel-hooks.ts seams, "for test slots" by design)
  # to slot-local dirs — without them every slot Bridge boot rewrote the
  # GLOBAL ~/.flywheel/bin symlinks to this checkout's dist.
  env \
    -u TEAMLEAD_INGEST_TOKEN \
    -u TMUX \
    -u FLYWHEEL_TMUX_SOCKET_OVERRIDE \
    -u FLYWHEEL_QA_NODE \
    TEAMLEAD_PORT="${SLOT_PORT}" \
    TEAMLEAD_DEFAULT_LEAD_AGENT="${AGENT_ID}" \
    DISCORD_OWNER_USER_ID="${QA1189_OWNER_OVERRIDE:-${DISCORD_OWNER_USER_ID:-}}" \
    DISCORD_BOT_TOKEN="${TEST_BOT_TOKEN}" \
    "${BOT_TOKEN_ENV}=${TEST_BOT_TOKEN}" \
    TEAMLEAD_DB_PATH="${SLOT_DIR}/teamlead.db" \
    TEAMLEAD_URL="http://localhost:${SLOT_PORT}" \
    FLYWHEEL_PROJECTS="${FLYWHEEL_PROJECTS}" \
    FLYWHEEL_PROJECTS_FILE="${FLYWHEEL_PROJECTS_FILE}" \
    FLYWHEEL_SUMMARY_CONFIG_HOME="${QA_SUMMARY_CONFIG_HOME}" \
    LINEAR_API_KEY="${LINEAR_API_KEY}" \
    FLYWHEEL_RUNNER_START_POINT="${RUNNER_START_REF}" \
    FLYWHEEL_BIN_DIR="${SLOT_DIR}/bin" \
    FLYWHEEL_HOOKS_DIR="${SLOT_DIR}/hooks" \
    TEAMLEAD_API_TOKEN="${TEST_TEAMLEAD_API_TOKEN}" \
    TEAMLEAD_CHAT_THREADS_ENABLED=true \
    TEAMLEAD_REPLY_BY_ISSUE_ENABLED=true \
    TEAMLEAD_REPLY_GUARD_ENABLED=true \
    ${BRIDGE_EXTRA_ENV[@]+"${BRIDGE_EXTRA_ENV[@]}"} \
    "$QA_SLOT_BRIDGE_NODE" "${SCRIPT_DIR}/lib/qa-slot-bridge-spec.mjs" capture \
      --spec "$BRIDGE_LAUNCH_SPEC" --slot "$SLOT" --port "$SLOT_PORT" \
      --bridge-url "http://localhost:${SLOT_PORT}" --cwd "$BRIDGE_LAUNCH_CWD" \
      --repo-root "$REPO_ROOT" \
      --session-launcher "$QA_SLOT_BRIDGE_SESSION_LAUNCHER" \
      --log "${SLOT_DIR}/bridge.log" --script "${REPO_ROOT}/scripts/run-bridge.ts" \
      "${BRIDGE_OWNERSHIP_CAPTURE_ARGS[@]}" -- \
      "$QA_SLOT_BRIDGE_NPX" tsx "${REPO_ROOT}/scripts/run-bridge.ts"
else
  # FLY-529: this is the "reply-by-issue OFF" default path. It already clears the
  # inherited TEAMLEAD_API_TOKEN; it MUST also clear the reply-by-issue flags the
  # production ~/.flywheel/.env now exports (TEAMLEAD_REPLY_BY_ISSUE_ENABLED /
  # _REPLY_GUARD_ENABLED / _CHAT_THREADS_ENABLED). Otherwise the child Bridge
  # inherits REPLY_BY_ISSUE_ENABLED=true with no token and loadConfig() fatals
  # ("requires TEAMLEAD_API_TOKEN") — which broke every deploy from a sourced-env
  # runner until this QA run caught it.
  # FLY-1389 P1-a: same slot-local FLYWHEEL_BIN_DIR / FLYWHEEL_HOOKS_DIR
  # isolation on the default (reply-by-issue OFF) branch.
  env -u TEAMLEAD_API_TOKEN \
    -u TEAMLEAD_INGEST_TOKEN \
    -u TMUX \
    -u FLYWHEEL_TMUX_SOCKET_OVERRIDE \
    -u FLYWHEEL_QA_NODE \
    -u TEAMLEAD_REPLY_BY_ISSUE_ENABLED \
    -u TEAMLEAD_REPLY_GUARD_ENABLED \
    -u TEAMLEAD_CHAT_THREADS_ENABLED \
    TEAMLEAD_PORT="${SLOT_PORT}" \
    TEAMLEAD_DEFAULT_LEAD_AGENT="${AGENT_ID}" \
    DISCORD_OWNER_USER_ID="${QA1189_OWNER_OVERRIDE:-${DISCORD_OWNER_USER_ID:-}}" \
    DISCORD_BOT_TOKEN="${TEST_BOT_TOKEN}" \
    "${BOT_TOKEN_ENV}=${TEST_BOT_TOKEN}" \
    TEAMLEAD_DB_PATH="${SLOT_DIR}/teamlead.db" \
    TEAMLEAD_URL="http://localhost:${SLOT_PORT}" \
    FLYWHEEL_PROJECTS="${FLYWHEEL_PROJECTS}" \
    FLYWHEEL_PROJECTS_FILE="${FLYWHEEL_PROJECTS_FILE}" \
    FLYWHEEL_SUMMARY_CONFIG_HOME="${QA_SUMMARY_CONFIG_HOME}" \
    LINEAR_API_KEY="${LINEAR_API_KEY}" \
    FLYWHEEL_RUNNER_START_POINT="${RUNNER_START_REF}" \
    FLYWHEEL_BIN_DIR="${SLOT_DIR}/bin" \
    FLYWHEEL_HOOKS_DIR="${SLOT_DIR}/hooks" \
    ${BRIDGE_EXTRA_ENV[@]+"${BRIDGE_EXTRA_ENV[@]}"} \
    "$QA_SLOT_BRIDGE_NODE" "${SCRIPT_DIR}/lib/qa-slot-bridge-spec.mjs" capture \
      --spec "$BRIDGE_LAUNCH_SPEC" --slot "$SLOT" --port "$SLOT_PORT" \
      --bridge-url "http://localhost:${SLOT_PORT}" --cwd "$BRIDGE_LAUNCH_CWD" \
      --repo-root "$REPO_ROOT" \
      --session-launcher "$QA_SLOT_BRIDGE_SESSION_LAUNCHER" \
      --log "${SLOT_DIR}/bridge.log" --script "${REPO_ROOT}/scripts/run-bridge.ts" \
      "${BRIDGE_OWNERSHIP_CAPTURE_ARGS[@]}" -- \
      "$QA_SLOT_BRIDGE_NPX" tsx "${REPO_ROOT}/scripts/run-bridge.ts"
fi
: > "${SLOT_DIR}/bridge.log"
qa_slot_bridge_exec_spec "$BRIDGE_LAUNCH_SPEC" "$REPO_ROOT" \
  >> "${SLOT_DIR}/bridge.log" 2>&1 &
BRIDGE_PID=$!
echo "$BRIDGE_PID" > "${SLOT_DIR}/bridge.pid"
# Update slot lock with long-lived Bridge PID (prevents stale-lock misdetection)
echo "$BRIDGE_PID" > "/tmp/flywheel-test-slot-${SLOT}.lock/pid"
# NOTE: campaign lock FINALIZE + `trap - EXIT` are DEFERRED until AFTER the
# Bridge health check below (Codex R1 MED): finalizing the borrowed locks and
# disarming the failure trap before the Bridge is confirmed up would leak the
# extra Leads + borrowed locks when the Bridge dies during startup. Until then
# the borrowed locks stay in "claiming" state so cleanup_on_failure can release
# them, and the extra Lead supervisors are torn down via the campaign manifest.
log "Bridge PID: ${BRIDGE_PID}"

# ── Step 4: Wait for Bridge HTTP ready ────────────────
# FLY-535: 120s (was 30s) to match the Lead readiness budget — on a loaded shared
# machine the Bridge (node loading the full teamlead dist) can take >30s to serve
# /health while still starting normally. The kill -0 liveness check below still
# fast-fails a genuinely crashed Bridge, so this only adds patience for slow starts.
# On failure we exit; the still-armed cleanup_on_failure EXIT trap releases the
# main lock AND (for a campaign) the borrowed locks + extra Leads.
BRIDGE_READY=false
for i in $(seq 1 120); do
  if curl -sf "http://localhost:${SLOT_PORT}/health" >/dev/null 2>&1; then
    log "Bridge ready on port ${SLOT_PORT} (after ${i}s)"
    BRIDGE_READY=true
    break
  fi
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    log "ERROR: Bridge process died"
    qa_launchd_stop_registry "$QA_LEAD_REGISTRY" 2>/dev/null || true
    rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
    exit 1
  fi
  sleep 1
done

if [[ "$BRIDGE_READY" != "true" ]]; then
  log "ERROR: Bridge did not become ready within 120 seconds"
  kill "$BRIDGE_PID" 2>/dev/null || true
  qa_launchd_stop_registry "$QA_LEAD_REGISTRY" 2>/dev/null || true
  rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
  exit 1
fi

# FLY-1775: /health is only the first readiness signal. Generalized rooms are
# not publishable until the exact built checkout, flag exec boundary, strict
# config, complete menu domain, and canonical category bindings all agree.
if [[ "$GENERALIZED" == "1" ]]; then
  GENERALIZED_HEALTH_JSON=$(curl -sS "http://localhost:${SLOT_PORT}/health") \
    || { log "ERROR: generalized /health body unavailable"; exit 1; }
  if ! jq -e --arg sha "$SCRIPT_REPO_HEAD" \
    '.ok == true and .buildMode == "built" and .buildSha == $sha and .artifactBuildSha == $sha' \
    <<<"$GENERALIZED_HEALTH_JSON" >/dev/null; then
    log "ERROR: generalized health identity mismatch; expected built ${SCRIPT_REPO_HEAD}, got $(jq -c '{ok,buildMode,buildSha,artifactBuildSha}' <<<"$GENERALIZED_HEALTH_JSON" 2>/dev/null || echo invalid-json)"
    exit 1
  fi
  node "${SCRIPT_DIR}/lib/qa-generalized.mjs" seed-bindings \
    --db "${SLOT_DIR}/teamlead.db" --project "$TEST_PROJECT_NAME" >/dev/null \
    || { log "ERROR: generalized workflow_category_binding seed failed"; exit 1; }
  node "${SCRIPT_DIR}/lib/qa-generalized.mjs" seed-project-flags \
    --db "${SLOT_DIR}/teamlead.db" --project "$TEST_PROJECT_NAME" \
    --flags pipeline_dag,pipeline_work_kind,doc_flow >/dev/null \
    || { log "ERROR: generalized scoped pipeline/doc_flow flag seed failed"; exit 1; }
  node "${SCRIPT_DIR}/lib/qa-generalized.mjs" verify-bindings \
    --db "${SLOT_DIR}/teamlead.db" --project "$TEST_PROJECT_NAME" >/dev/null \
    || { log "ERROR: generalized binding verification failed"; exit 1; }
  node "${SCRIPT_DIR}/lib/qa-generalized.mjs" verify-config \
    --file "${HOST_REPO}/.flywheel/config.yaml" \
    --db "${SLOT_DIR}/teamlead.db" --project "$TEST_PROJECT_NAME" >/dev/null \
    || { log "ERROR: generalized pipeline config verification failed"; exit 1; }
  GENERALIZED_MENU_JSON=$(curl -sS --get \
    --data-urlencode "projectName=${TEST_PROJECT_NAME}" \
    --data-urlencode "leadId=${AGENT_ID}" \
    "http://localhost:${SLOT_PORT}/api/workflow/menus") \
    || { log "ERROR: generalized menu endpoint unavailable"; exit 1; }
  if ! jq -e '
    .success == true and
    ([.menus[].item] | sort) == ["code","generic"] and
    (any(.menus[]; .item == "code" and
      ([.nodes[].id] | sort) == ["eng_design","founder_gate","implement","qa"]))
  ' <<<"$GENERALIZED_MENU_JSON" >/dev/null; then
    log "ERROR: generalized menu readiness failed: $(jq -c '{success,code,reason,legal,menus}' <<<"$GENERALIZED_MENU_JSON" 2>/dev/null || echo invalid-json)"
    exit 1
  fi
  if [[ "$STUB_RUNNER" == "1" ]]; then
    GENERALIZED_RUNNER_MODE="stub"
  else
    GENERALIZED_RUNNER_MODE="real"
  fi
  _room_tmp="${GENERALIZED_ROOM_INFO}.tmp.$$"
  jq -n \
    --argjson slot "$SLOT" --argjson port "$SLOT_PORT" \
    --arg projectName "$TEST_PROJECT_NAME" --arg agentId "$AGENT_ID" \
    --arg mode "$MODE" --arg runnerMode "$GENERALIZED_RUNNER_MODE" \
    --arg bridgeUrl "http://localhost:${SLOT_PORT}" \
    --arg dbPath "${SLOT_DIR}/teamlead.db" --arg hostRepo "$HOST_REPO" \
    --arg flywheelProjectsFile "$FLYWHEEL_PROJECTS_FILE" \
	--arg summaryConfigHome "$QA_SUMMARY_CONFIG_HOME" \
    --arg flywheelRepo "$REPO_ROOT" \
    --arg buildSha "$SCRIPT_REPO_HEAD" --arg apiTokenPath "$GENERALIZED_API_TOKEN_PATH" \
    --arg bridgeLog "${SLOT_DIR}/bridge.log" \
    '{schemaVersion:1,slot:$slot,port:$port,projectName:$projectName,agentId:$agentId,
      mode:$mode,generalized:true,runnerMode:$runnerMode,bridgeUrl:$bridgeUrl,
      dbPath:$dbPath,hostRepo:$hostRepo,flywheelRepo:$flywheelRepo,buildSha:$buildSha,
      flywheelProjectsFile:$flywheelProjectsFile,
	  summaryConfigHome:$summaryConfigHome,
      apiTokenPath:$apiTokenPath,
      bridgeLog:$bridgeLog}' > "$_room_tmp" \
    || { rm -f "$_room_tmp"; exit 1; }
  chmod 600 "$_room_tmp"
  mv "$_room_tmp" "$GENERALIZED_ROOM_INFO"
  log "generalized readiness: bindings 5/5 · pipeline+work_kind on · menu on"
fi

# ── Bridge confirmed up → NOW finalize campaign locks + disarm the failure trap ──
# FLY-1189: write the SAME live Bridge PID + campaign sidecar into EVERY
# campaign lock (owner + borrowed). The live PID protects borrowed locks from
# other deploys' stale reclaim for the whole campaign; the sidecar routes any
# direct teardown attempt to the owner slot. A finalize failure rolls the whole
# deploy back (plan H1, Codex R2 #5).
if (( ${#EXTRA_LEAD_SPECS[@]} > 0 )); then
  if ! qa_multilead_finalize_locks /tmp "$BRIDGE_PID" "$SLOT" "$CAMPAIGN_ID" "${CAMPAIGN_SLOT_IDS[@]}"; then
    log "ERROR: campaign lock finalize failed — rolling back the whole deploy"
    kill "$BRIDGE_PID" 2>/dev/null || true
    campaign_abort "lock finalize failure"
  fi
  log "Campaign locks finalized (Bridge PID ${BRIDGE_PID}, campaign ${CAMPAIGN_ID}, slots: ${CAMPAIGN_SLOT_IDS[*]})"
fi
# Bridge ready + locks finalized — disable the failure cleanup trap.
GENERALIZED_READINESS_PENDING=0
trap - EXIT

# FLY-1189: launch manifest — deploy-time ground truth and dist SHA.
# No secrets: token env NAMES only.
if [[ "$NO_LEAD" == "1" ]]; then LEAD_CARRIER="none"; else LEAD_CARRIER="launchd-v2"; fi
qa_lead_write_launch_manifest "${SLOT_DIR}/launch-manifest.json" \
  "$BRIDGE_PID" "$BRANCH_SHA" "$FROM_BRANCH" "$MODE" \
  "${CAMPAIGN_ID}" "${LEAD_LABEL}" "$EXTRA_LEADS_JSON" "$LEAD_CARRIER" \
  "$QA_LEAD_REGISTRY" "$LEAD_LAUNCHD_LABEL" "$LEAD_SOCKET"
log "Wrote ${SLOT_DIR}/launch-manifest.json"

# ── Step 5: Record PIDs ──────────────────────────────
# The launchd PID file is slot-local and written only after topology proof.
# FLY-1389 P2-b: no-lead deploys have no Lead artifacts — empty strings in
# the output JSON (guarded consumers; schema keys stay present).
if [[ "$NO_LEAD" == "1" ]]; then
  LEAD_PID_FILE=""
  NO_LEAD_JSON=true
else
  NO_LEAD_JSON=false
fi

log "Test environment ready!"
log "  Slot: ${SLOT}"
log "  Port: ${SLOT_PORT}"
log "  Agent: ${AGENT_ID}"
log "  Channel: ${CHAT_CHANNEL_ID}"
log "  Bridge PID: ${BRIDGE_PID}"
log "  Lead PID file: ${LEAD_PID_FILE}"

# Output JSON for downstream scripts.
# FLY-153: also surface mode + mirrorChannelId + flywheelProjectsFile so smoke
# tests and qa-fly-60-driver can branch on mode without re-reading config.
GENERALIZED_OUTPUT_FIELDS=""
if [[ "$GENERALIZED" == "1" ]]; then
  GENERALIZED_OUTPUT_FIELDS=$(cat <<EOF
,
  "generalized": true,
  "runnerMode": "${GENERALIZED_RUNNER_MODE}",
  "buildSha": "${SCRIPT_REPO_HEAD}",
  "apiTokenPath": "${GENERALIZED_API_TOKEN_PATH}",
  "roomInfo": "${GENERALIZED_ROOM_INFO}"
EOF
)
fi
qa_lead_render_stdout_json \
  "$SLOT" "$MODE" "$NO_LEAD_JSON" "$MIRROR_CHANNEL_ID" "$SLOT_PORT" \
  "$AGENT_ID" "$TEST_PROJECT_NAME" "$CHAT_CHANNEL_ID" "$BOT_TOKEN_ENV" \
  "$BRIDGE_PID" "$LEAD_PID_FILE" "$LEAD_CARRIER" "$LEAD_LAUNCHD_LABEL" \
  "$LEAD_SOCKET" "$QA_LEAD_REGISTRY" "$SLOT_DIR" "$FROM_BRANCH" \
  "$SANDBOX_SLUG" "$HOST_REPO" "$QA_TEMP_BRANCH" "$BRANCH_SHA" \
  "$RUNNER_START_REF" "${SLOT_DIR}/teamlead.db" "${SLOT_DIR}/bridge.log" \
  "$BRIDGE_LAUNCH_SPEC" "$LEAD_LOG" "$FLYWHEEL_PROJECTS_FILE" \
  "${SLOT_DIR}/launch-manifest.json" "${CAMPAIGN_MANIFEST_FILE:-}" \
  "${CAMPAIGN_ID:-}" "$LEAD_LABEL" "$EXTRA_LEADS_JSON" \
  "$GENERALIZED_OUTPUT_FIELDS"
