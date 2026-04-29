#!/usr/bin/env bash
# FLY-96: Deploy a test slot (Bridge + Lead) for Discord E2E testing.
#
# Usage: scripts/test-deploy.sh [slot-number]
#   If slot-number is provided, claims that specific slot.
#   If omitted, claims the first available slot from the pool.
#
# Output: JSON with slot metadata (slot, port, channel, pids)
# Prerequisites: ~/.flywheel/.env with TEST_BOT_TOKEN_N, ~/.flywheel/test-slots.json
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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

# ── Argument parsing (FLY-115) ────────────────────────
FROM_BRANCH=""
REQUESTED_SLOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-branch)
      FROM_BRANCH="${2:?--from-branch requires a value}"; shift 2 ;;
    --from-branch=*)
      FROM_BRANCH="${1#*=}"; shift ;;
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
gh repo view "$SANDBOX_SLUG" >/dev/null 2>&1 \
  || fail_preflight "sandbox repo ${SANDBOX_SLUG} missing. Run: gh repo fork xrliAnnie/flywheel --fork-name flywheel-qa-sandbox --clone=false"
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
# Order: better-sqlite3 rebuild + require() probe, THEN TypeScript build
# of the dist artifacts Bridge imports at runtime.
log "Preflight under ${REBUILD_LOCK}: better-sqlite3 rebuild + flywheel-edge-worker build"
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

  # 1. native addon rebuild (flywheel-comm + inbox-mcp both consume better-sqlite3)
  pnpm -r --filter flywheel-comm --filter flywheel-inbox-mcp rebuild better-sqlite3
  ( cd "$REPO_ROOT/packages/flywheel-comm" && node -e "require('better-sqlite3')" ) \
    || exit 11
  ( cd "$REPO_ROOT/packages/inbox-mcp" && node -e "require('better-sqlite3')" ) \
    || exit 12

  # 2. Rebuild edge-worker dist so scripts/run-bridge.ts → dist/WorktreeManager.js
  #    picks up the FLYWHEEL_RUNNER_START_POINT env fallback. Without this,
  #    /api/runs/start spawns Runners against stale origin/main dist.
  pnpm --filter flywheel-edge-worker build || exit 13

  # 3. Assert the env fallback actually landed in the built artifact. Cheaper
  #    than rerunning unit tests under the lock, and it catches the case where
  #    someone forgets to rebuild after editing src.
  grep -q 'FLYWHEEL_RUNNER_START_POINT' \
    "$REPO_ROOT/packages/edge-worker/dist/WorktreeManager.js" || exit 14
) || fail_preflight "preflight failed (better-sqlite3 rebuild, edge-worker build, or dist freshness check)"

release_preflight_lock
trap - EXIT

SLOT=""

if [[ -n "$REQUESTED_SLOT" ]]; then
  if claim_slot "$REQUESTED_SLOT"; then
    SLOT="$REQUESTED_SLOT"
  else
    echo "ERROR: Slot ${REQUESTED_SLOT} is in use." >&2
    exit 1
  fi
else
  for i in $(seq 1 "$TOTAL_SLOTS"); do
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
  lock_pid=$(cat "$lock/pid" 2>/dev/null || echo "")
  # Only clean up if still in "claiming" state (Bridge PID not yet written)
  if [[ "$lock_pid" == "claiming" ]]; then
    log "Deploy interrupted — releasing slot ${SLOT} lock"
    rm -rf "$lock"
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

# ── Create temp directories ───────────────────────────
SLOT_DIR="/tmp/flywheel-test-slot-${SLOT}"
mkdir -p "${SLOT_DIR}/discord-state"

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
rm -rf "${HOST_REPO}"
git clone --branch "${FROM_BRANCH}" "${SANDBOX_REMOTE_URL}" "${HOST_REPO}" \
  || fail_preflight "git clone --branch ${FROM_BRANCH} failed. Did you push the branch to sandbox? (see doc/qa/framework/real-runner-e2e-guide.md §6)"

# Resolve remote-tracking ref for the Runner worktree start point
RUNNER_START_REF="refs/remotes/origin/${FROM_BRANCH}"
git -C "${HOST_REPO}" rev-parse --verify "$RUNNER_START_REF" >/dev/null \
  || fail_preflight "${RUNNER_START_REF} missing in slot clone"

# Host-side local branch so Annie can push via the host clone if ever needed
git -C "${HOST_REPO}" checkout -B "$QA_TEMP_BRANCH" "$RUNNER_START_REF"

# Record the SHA under test for downstream verification
BRANCH_SHA="$(git -C "${HOST_REPO}" rev-parse HEAD)"
log "Sandbox HEAD for ${FROM_BRANCH}: ${BRANCH_SHA}"

# ── Generate DISCORD_STATE_DIR files ──────────────────
# .env with test bot token
cat > "${SLOT_DIR}/discord-state/.env" <<EOF
DISCORD_BOT_TOKEN=${TEST_BOT_TOKEN}
EOF
chmod 600 "${SLOT_DIR}/discord-state/.env"

# access.json — only the test channel
cat > "${SLOT_DIR}/discord-state/access.json" <<EOF
{"dmPolicy":"allowlist","allowFrom":[],"allowBots":["${BOT_ID}"],"groups":{"${CHAT_CHANNEL_ID}":{"requireMention":false,"allowFrom":[]}},"pending":{}}
EOF

# ── Generate test identity.md from production template ──
# FLY-96 QA bug fix: 4-line identity.md didn't define announce behavior
# (session_started / completed / failed message templates), so test Leads
# didn't post anything to Discord. Source from GeoForge3D production
# identity.md (role-based) + TEST SLOT OVERRIDE banner that redirects all
# channel/bot references to this slot's dedicated resources.
case "$SLOT_ROLE" in
  cos)  SOURCE_SUBDIR="cos-lead" ;;
  lead) SOURCE_SUBDIR="product-lead" ;;
  *)
    echo "ERROR: unknown slot role '${SLOT_ROLE}' (expected 'cos' or 'lead')" >&2
    rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
    exit 1
    ;;
esac

PROD_IDENTITY="${HOME}/Dev/GeoForge3D/.lead/${SOURCE_SUBDIR}/identity.md"
if [[ ! -f "$PROD_IDENTITY" ]]; then
  echo "ERROR: Production identity not found: ${PROD_IDENTITY}" >&2
  echo "  (test-deploy expects ~/Dev/GeoForge3D checkout with .lead/${SOURCE_SUBDIR}/identity.md)" >&2
  rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
  exit 1
fi

cat > "${SLOT_DIR}/test-identity.md" <<EOF
---
name: ${AGENT_ID}
description: Flywheel TEST slot ${SLOT} (${SLOT_ROLE}) — automated QA environment
model: opus
disallowedTools: Write, Edit, MultiEdit, Agent, NotebookEdit
permissionMode: bypassPermissions
---

# TEST SLOT ${SLOT} — OVERRIDE (READ CAREFULLY)

**This is an automated QA test environment, not production.**
All channel IDs and bot IDs mentioned later in this file refer to PRODUCTION
resources. You MUST replace them with the TEST slot identity below and must
NOT interact with any production channel.

## TEST IDENTITY OVERRIDE (highest priority)

- **Your Bot ID**: \`${BOT_ID}\` (overrides any bot ID in the sections below)
- **Your ONLY channel**: <#${CHAT_CHANNEL_ID}> (channel ID \`${CHAT_CHANNEL_ID}\`)
- **Ignore** all other channel IDs in "Channel Isolation Rules", "Core Channel Routing", "Discord Channel IDs", etc. — those belong to production.
- If a received message's \`chat_id\` is not \`${CHAT_CHANNEL_ID}\`, silently ignore it (no reply, no action).
- **Behavior rules** (when to announce session_started / session_completed / session_failed, message format, reactions) from the sections below STILL apply — but only inside <#${CHAT_CHANNEL_ID}>.

---

# Production identity (reference for behavior rules)

EOF
cat "$PROD_IDENTITY" >> "${SLOT_DIR}/test-identity.md"

# ── Stage shared Lead rules ──────────────────────────
# claude-lead.sh reads \${PROJECT_DIR}/.lead/shared/*.md (FLY-26). Without this
# the test Lead misses department-lead-rules.md which defines announce behavior.
SHARED_SRC="${HOME}/Dev/GeoForge3D/.lead/shared"
SHARED_DST="${HOST_REPO}/.lead/shared"
if [[ -d "$SHARED_SRC" ]]; then
  mkdir -p "$SHARED_DST"
  cp "$SHARED_SRC"/*.md "$SHARED_DST/" 2>/dev/null || true
  SHARED_COUNT=$(ls -1 "$SHARED_DST" 2>/dev/null | wc -l | tr -d ' ')
  log "Shared rules staged: ${SHARED_COUNT} files from ${SHARED_SRC}"
else
  log "WARN: ${SHARED_SRC} not found — test Lead will miss shared rules"
fi

# ── Generate FLYWHEEL_PROJECTS JSON ───────────────────
TEST_PROJECT_NAME="test-slot-${SLOT}"
FLYWHEEL_PROJECTS="[{
  \"projectName\": \"${TEST_PROJECT_NAME}\",
  \"projectRoot\": \"${HOST_REPO}\",
  \"projectRepo\": \"${SANDBOX_SLUG}\",
  \"leads\": [{
    \"agentId\": \"${AGENT_ID}\",
    \"chatChannel\": \"${CHAT_CHANNEL_ID}\",
    \"match\": {\"labels\": [\"*\"]}
  }]
}]"

log "Starting test Lead: ${AGENT_ID} (project: ${TEST_PROJECT_NAME})"

# ── Step 1: Start test Lead (background) ─────────────
# env -u clears inherited production token, then sets test token explicitly (D8)
env -u DISCORD_BOT_TOKEN \
  DISCORD_BOT_TOKEN="${TEST_BOT_TOKEN}" \
  DISCORD_GUILD_ID="${GUILD_ID}" \
  BRIDGE_URL="http://localhost:${SLOT_PORT}" \
  DISCORD_STATE_DIR="${SLOT_DIR}/discord-state" \
  AGENT_SOURCE="${SLOT_DIR}/test-identity.md" \
  FLYWHEEL_LEAD_ROLE="${SLOT_ROLE}" \
  bash "${REPO_ROOT}/packages/teamlead/scripts/claude-lead.sh" \
    "${AGENT_ID}" "${HOST_REPO}" "${TEST_PROJECT_NAME}" &
LEAD_BG_PID=$!
log "Lead background PID: ${LEAD_BG_PID}"

# ── Step 1b: Auto-confirm dev-channels interactive prompt ─────
# FLY-96 QA bug fix: fresh slot has no acknowledged dev-channels state, so
# Claude Code shows "Loading development channels / 1. I am using this for
# local development / 2. Exit" prompt on startup. claude-lead.sh only sends
# Enter (at 8s), which selects the UI default (Exit on fresh installs and
# hangs the Lead). Poll the tmux window and send "1" + Enter explicitly.
#
# FLY-109: expect-dev-channels.exp now handles this inside the tmux child —
# the send-keys workaround is redundant when the .exp file is active. Set
# SKIP_DEV_CHANNELS_WORKAROUND=1 to skip this block and validate that the
# .exp file alone is sufficient (Class A expect tests rely on this path).
LEAD_WINDOW_NAME="${TEST_PROJECT_NAME}-${AGENT_ID}"
if [[ "${SKIP_DEV_CHANNELS_WORKAROUND:-0}" == "1" ]]; then
  log "SKIP_DEV_CHANNELS_WORKAROUND=1 — relying on expect-dev-channels.exp for dialog confirmation"
  LEAD_WINDOW_ID=""
  for i in $(seq 1 30); do
    LEAD_WINDOW_ID=$(tmux list-windows -t flywheel -F '#{window_id} #{window_name}' 2>/dev/null \
      | awk -v n="$LEAD_WINDOW_NAME" '$2==n {print $1; exit}')
    [[ -n "$LEAD_WINDOW_ID" ]] && break
    sleep 1
  done
  [[ -n "$LEAD_WINDOW_ID" ]] && log "Lead tmux window: ${LEAD_WINDOW_ID} (expect script handles dialog)" \
    || log "WARN: Lead tmux window '${LEAD_WINDOW_NAME}' not found after 30s"
else
  log "Polling tmux window '${LEAD_WINDOW_NAME}' for dev-channels prompt"
  LEAD_WINDOW_ID=""
  for i in $(seq 1 30); do
    LEAD_WINDOW_ID=$(tmux list-windows -t flywheel -F '#{window_id} #{window_name}' 2>/dev/null \
      | awk -v n="$LEAD_WINDOW_NAME" '$2==n {print $1; exit}')
    [[ -n "$LEAD_WINDOW_ID" ]] && break
    sleep 1
  done

  if [[ -n "$LEAD_WINDOW_ID" ]]; then
    log "Lead tmux window: ${LEAD_WINDOW_ID}"
    PROMPT_HIT=false
    for i in $(seq 1 30); do
      PANE=$(tmux capture-pane -t "$LEAD_WINDOW_ID" -p 2>/dev/null || echo "")
      if echo "$PANE" | grep -qE "Loading development channels|am using this for local|development channels"; then
        log "Detected dev-channels prompt on slot ${SLOT}, sending '1' Enter"
        tmux send-keys -t "$LEAD_WINDOW_ID" "1" 2>/dev/null || true
        sleep 0.3
        tmux send-keys -t "$LEAD_WINDOW_ID" Enter 2>/dev/null || true
        PROMPT_HIT=true
        break
      fi
      sleep 1
    done
    [[ "$PROMPT_HIT" == "false" ]] && log "No dev-channels prompt observed (already acknowledged or startup bypassed it)"
  else
    log "WARN: Lead tmux window '${LEAD_WINDOW_NAME}' not found after 30s"
  fi
fi

# ── Step 2: Wait for Lead inbox-ready lease ───────────
LEASE_DIR="${HOME}/.flywheel/comm/${TEST_PROJECT_NAME}"
LEASE_FILE="${LEASE_DIR}/.inbox-ready-${AGENT_ID}"
log "Waiting for lease: ${LEASE_FILE}"

LEAD_READY=false
for i in $(seq 1 60); do
  if [[ -f "$LEASE_FILE" ]]; then
    LEASE_PID=$(jq -r '.pid' "$LEASE_FILE" 2>/dev/null || echo "")
    if [[ -n "$LEASE_PID" ]] && kill -0 "$LEASE_PID" 2>/dev/null; then
      log "Lead ${AGENT_ID} ready (lease alive, PID ${LEASE_PID})"
      LEAD_READY=true
      break
    fi
  fi
  # Check if Lead process died
  if ! kill -0 "$LEAD_BG_PID" 2>/dev/null; then
    log "ERROR: Lead process died before becoming ready"
    rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
    exit 1
  fi
  sleep 2
done

if [[ "$LEAD_READY" != "true" ]]; then
  log "ERROR: Lead did not become ready within 120 seconds"
  kill "$LEAD_BG_PID" 2>/dev/null || true
  rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
  exit 1
fi

# ── Step 3: Start test Bridge (file-backed DB, real-Runner env) ──
# FLY-115 §4.5: file-backed teamlead.db so FLY-108 S4 chain is visible
# across processes; TEAMLEAD_URL so Blueprint/TmuxAdapter forward
# FLYWHEEL_BRIDGE_URL to the Runner; FLYWHEEL_RUNNER_START_POINT so the
# Runner worktree HEAD tracks sandbox <from-branch>; LINEAR_API_KEY so
# /api/runs/start PreHydrator can verify issues against Linear; stdout +
# stderr redirected to bridge.log for QA observability. Unset
# TEAMLEAD_API_TOKEN so /api/* routes don't require auth in test.
log "Starting test Bridge on port ${SLOT_PORT} (from-branch=${FROM_BRANCH})"
env -u TEAMLEAD_API_TOKEN \
  TEAMLEAD_PORT="${SLOT_PORT}" \
  TEAMLEAD_DB_PATH="${SLOT_DIR}/teamlead.db" \
  TEAMLEAD_URL="http://localhost:${SLOT_PORT}" \
  FLYWHEEL_PROJECTS="${FLYWHEEL_PROJECTS}" \
  LINEAR_API_KEY="${LINEAR_API_KEY}" \
  FLYWHEEL_RUNNER_START_POINT="${RUNNER_START_REF}" \
  npx tsx "${REPO_ROOT}/scripts/run-bridge.ts" \
  > "${SLOT_DIR}/bridge.log" 2>&1 &
BRIDGE_PID=$!
echo "$BRIDGE_PID" > "${SLOT_DIR}/bridge.pid"
# Update slot lock with long-lived Bridge PID (prevents stale-lock misdetection)
echo "$BRIDGE_PID" > "/tmp/flywheel-test-slot-${SLOT}.lock/pid"
# Bridge PID written — disable failure cleanup trap
trap - EXIT
log "Bridge PID: ${BRIDGE_PID}"

# ── Step 4: Wait for Bridge HTTP ready ────────────────
BRIDGE_READY=false
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${SLOT_PORT}/health" >/dev/null 2>&1; then
    log "Bridge ready on port ${SLOT_PORT}"
    BRIDGE_READY=true
    break
  fi
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    log "ERROR: Bridge process died"
    kill "$LEAD_BG_PID" 2>/dev/null || true
    rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
    exit 1
  fi
  sleep 1
done

if [[ "$BRIDGE_READY" != "true" ]]; then
  log "ERROR: Bridge did not become ready within 30 seconds"
  kill "$BRIDGE_PID" 2>/dev/null || true
  kill "$LEAD_BG_PID" 2>/dev/null || true
  rm -rf "/tmp/flywheel-test-slot-${SLOT}.lock"
  exit 1
fi

# ── Step 5: Record PIDs ──────────────────────────────
# Lead supervisor PID is written by claude-lead.sh to:
#   ~/.flywheel/pids/<project-name>-<lead-id>.pid
# We also record Bridge PID locally.
LEAD_PID_FILE="${HOME}/.flywheel/pids/${TEST_PROJECT_NAME}-${AGENT_ID}.pid"

log "Test environment ready!"
log "  Slot: ${SLOT}"
log "  Port: ${SLOT_PORT}"
log "  Agent: ${AGENT_ID}"
log "  Channel: ${CHAT_CHANNEL_ID}"
log "  Bridge PID: ${BRIDGE_PID}"
log "  Lead PID file: ${LEAD_PID_FILE}"

# Output JSON for downstream scripts
cat <<EOF
{
  "slot": ${SLOT},
  "port": ${SLOT_PORT},
  "agentId": "${AGENT_ID}",
  "projectName": "${TEST_PROJECT_NAME}",
  "chatChannelId": "${CHAT_CHANNEL_ID}",
  "botTokenEnv": "${BOT_TOKEN_ENV}",
  "bridgePid": ${BRIDGE_PID},
  "leadPidFile": "${LEAD_PID_FILE}",
  "slotDir": "${SLOT_DIR}",
  "bridgeUrl": "http://localhost:${SLOT_PORT}",
  "fromBranch": "${FROM_BRANCH}",
  "sandbox": "${SANDBOX_SLUG}",
  "hostRepo": "${HOST_REPO}",
  "tempBranch": "${QA_TEMP_BRANCH}",
  "branchSha": "${BRANCH_SHA}",
  "runnerStartPoint": "${RUNNER_START_REF}",
  "dbPath": "${SLOT_DIR}/teamlead.db",
  "bridgeLog": "${SLOT_DIR}/bridge.log"
}
EOF
