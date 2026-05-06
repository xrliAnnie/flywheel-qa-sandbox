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
# Schema matches ~/.flywheel/test-slots.json:
#   FLY-96 (required): bridgePort, botName, tokenEnvVar, botAppId, channelId, role
#   FLY-127 (optional, dept-aware): department, deptLabel, identitySource
# role ∈ {"cos", "lead"} — kept for backward compat; selects identity if
# identitySource is absent.
# AGENT_ID is derived from botName (1:1) — simple and deterministic.
SLOT_IDX=$((SLOT - 1))
SLOT_PORT=$(jq -r ".slots[${SLOT_IDX}].bridgePort" "$SLOTS_FILE")
AGENT_ID=$(jq -r ".slots[${SLOT_IDX}].botName" "$SLOTS_FILE")
BOT_TOKEN_ENV=$(jq -r ".slots[${SLOT_IDX}].tokenEnvVar" "$SLOTS_FILE")
BOT_ID=$(jq -r ".slots[${SLOT_IDX}].botAppId" "$SLOTS_FILE")
CHAT_CHANNEL_ID=$(jq -r ".slots[${SLOT_IDX}].channelId" "$SLOTS_FILE")
SLOT_ROLE=$(jq -r ".slots[${SLOT_IDX}].role" "$SLOTS_FILE")
# FLY-115 v1.24.2 Gap C: forum channel is optional — empty means no forum thread
# creation. `jq // empty` returns "" when the key is absent, which we filter out
# in the FLYWHEEL_PROJECTS jq builder below to satisfy ProjectConfig's
# "forumChannel must be non-empty string or absent" rule.
FORUM_CHANNEL_ID=$(jq -r ".slots[${SLOT_IDX}].forumChannelId // empty" "$SLOTS_FILE")
# FLY-127: dept-aware fields. All three are optional for backward compat —
# if absent, falls back to FLY-96 role-based identity sourcing and `["*"]`
# label-match (no dept enforcement). If present, identitySource overrides
# the role→subdir map and deptLabel becomes the FLYWHEEL_PROJECTS match label
# so PR #170's classifyIssue() / isLeadInScope() actually fires in tests.
DEPARTMENT=$(jq -r ".slots[${SLOT_IDX}].department // empty" "$SLOTS_FILE")
DEPT_LABEL=$(jq -r ".slots[${SLOT_IDX}].deptLabel // empty" "$SLOTS_FILE")
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

# Project identifier — referenced by .flywheel/config.yaml below and by the
# FLYWHEEL_PROJECTS jq builder later. Defined early (was only set right
# before jq build) so the v1.24.3 sandbox config write can reuse it.
TEST_PROJECT_NAME="test-slot-${SLOT}"

# ── FLY-115 v1.24.3 Gap 2 fix: write .flywheel/config.yaml ─────────
# Root cause (Round 3 §S6, sandbox): `xrliAnnie/flywheel-qa-sandbox` has no
# `.flywheel/config.yaml`, so Bridge's run-infra.ts:328-345 leaves
# checkpointConfig=undefined. Blueprint.ts:341-380 then skips the
# "APPROVE GATE (MANDATORY)" injection, so the Runner never calls
# `flywheel-comm gate approve_to_ship` after writing land-status.json.
# That makes Bridge.actions.approveExecution() find no pending gate
# (`getPendingGateByRunner` returns undefined) and respond with
# `gateUnblocked=false`, which fails test-auto-approve.sh's exit-0 contract.
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
cat > "${HOST_REPO}/.flywheel/config.yaml" <<EOF
# Generated by scripts/test-deploy.sh (FLY-115 v1.24.3) — sandbox test config.
# DO NOT commit to xrliAnnie/flywheel-qa-sandbox; teardown wipes HOST_REPO.
project: ${TEST_PROJECT_NAME}

linear:
  team_id: FLY

runners:
  default: claude
  available:
    claude:
      type: claude
      model: sonnet

teams:
  - name: default
    orchestrators:
      - type: dag
        runner: claude

decision_layer:
  autonomy_level: advisor
  escalation_channel: discord

checkpoints:
  approve_to_ship:
    enabled: true
    timeout_ms: 3600000      # 1h
    timeout_behavior: fail-close
EOF
log "Wrote ${HOST_REPO}/.flywheel/config.yaml (approve_to_ship checkpoint enabled)"

# ── Generate DISCORD_STATE_DIR files ──────────────────
# .env with test bot token
cat > "${SLOT_DIR}/discord-state/.env" <<EOF
DISCORD_BOT_TOKEN=${TEST_BOT_TOKEN}
EOF
chmod 600 "${SLOT_DIR}/discord-state/.env"

# FLY-127 v3 (qa R3 / Annie's Option B): build access.json `groups` to mirror
# production's multi-channel listening pattern. Production product-lead's
# access.json has 3 channels: own chat, own forum, AND the shared core
# (geoforge3d-core, Simba's channel) — so all dept Leads see Annie's posts in
# the core channel and decide based on @mention / dept scope.
#
# For test, dept-aware non-cos slots (slot 2/3/4) get their own chat + forum
# + cos-test (the shared core analog). cos slot 1 keeps its single-channel
# config because cos-test IS its own channel; legacy slots without
# slot.department keep the FLY-96 single-channel access.json.
#
# allowFrom on the cos-test entry = Annie's user ID + the OTHER 3 dept bots,
# matching production where Peter sees Simba/Oliver bots in core. This lets
# a dept Lead observe both Annie's prompts and other Leads' relays.
ANNIE_USER_ID="${FLYWHEEL_ANNIE_USER_ID:-1138241636057481306}"
COS_CHANNEL_ID=$(jq -r '.slots[] | select(.role == "cos") | .channelId' "$SLOTS_FILE")
OTHER_BOT_IDS=$(jq -c --arg currentBot "$AGENT_ID" \
  '[ .slots[] | select(.botName != $currentBot) | .botAppId ]' "$SLOTS_FILE")

GROUPS_JSON=$(jq -n \
  --arg ownChannel "$CHAT_CHANNEL_ID" \
  --arg ownForum "$FORUM_CHANNEL_ID" \
  --arg cosChannel "$COS_CHANNEL_ID" \
  --arg department "$DEPARTMENT" \
  --arg annieId "$ANNIE_USER_ID" \
  --argjson otherBots "$OTHER_BOT_IDS" \
  '
  ({ ($ownChannel): { requireMention: false, allowFrom: [] } })
  + (if $ownForum != "" then { ($ownForum): { requireMention: false, allowFrom: [] } } else {} end)
  + (if ($department != "" and $department != "cos" and $cosChannel != "" and $cosChannel != $ownChannel) then
       { ($cosChannel): { requireMention: false, allowFrom: ([$annieId] + $otherBots) } }
     else {} end)
  ')

cat > "${SLOT_DIR}/discord-state/access.json" <<EOF
{"dmPolicy":"allowlist","allowFrom":[],"allowBots":["${BOT_ID}"],"groups":${GROUPS_JSON},"pending":{}}
EOF
ACCESS_GROUP_COUNT=$(echo "$GROUPS_JSON" | jq 'length')
log "access.json groups=${ACCESS_GROUP_COUNT} (own${FORUM_CHANNEL_ID:+ + forum}${DEPARTMENT:+${COS_CHANNEL_ID:+ + cos-test (if non-cos slot)}})"

# ── Generate test identity.md from production template ──
# FLY-96 QA bug fix: 4-line identity.md didn't define announce behavior
# (session_started / completed / failed message templates), so test Leads
# didn't post anything to Discord. Source from GeoForge3D production
# identity.md (role-based) + TEST SLOT OVERRIDE banner that redirects all
# channel/bot references to this slot's dedicated resources.
# FLY-127: prefer explicit identitySource (per-dept, e.g. ops-lead) over the
# role-based fallback. Old slots without identitySource keep the FLY-96 mapping
# (cos→cos-lead, lead→product-lead) so existing test runs are unaffected.
if [[ -n "$IDENTITY_SOURCE" ]]; then
  SOURCE_SUBDIR="$IDENTITY_SOURCE"
else
  case "$SLOT_ROLE" in
    cos)  SOURCE_SUBDIR="cos-lead" ;;
    lead) SOURCE_SUBDIR="product-lead" ;;
    *)
      echo "ERROR: unknown slot role '${SLOT_ROLE}' (expected 'cos' or 'lead'). Set slot.identitySource explicitly to override." >&2
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

# FLY-127 fix (qa-fly-127 round 1): macOS ships bash 3.2.57, which fails to
# parse an apostrophe inside `${VAR:+...}` inside a heredoc — the `'` opens
# a quote context the parser never closes, yielding "bad substitution: no
# closing `}'" at runtime. Pre-render the dept-aware suffix and banner OUTSIDE
# the heredoc so the heredoc only sees plain `${var}` expansions, which 3.2
# handles correctly. Robust against future copy-edits adding more `'`/`!`/`"`
# to the dept banner.
if [[ -n "$DEPT_LABEL" ]]; then
  DEPT_DESC_SUFFIX=", dept=${DEPT_LABEL}"
  # Leading newline keeps the bullet on its own line under the previous one.
  DEPT_BANNER="
- **Department scope (FLY-127)**: you own the \`${DEPT_LABEL}\` Linear label only. Bridge will 403-reject any \`POST /api/runs/start\` for an issue whose labels do not exactly match \`${DEPT_LABEL}\`. If a user asks you to spawn a Runner for an out-of-scope issue, refuse in Chinese and tell them which slot owns the department for that issue."
else
  DEPT_DESC_SUFFIX=""
  DEPT_BANNER=""
fi

# FLY-127 v3 (Annie's Option B): if this slot is a dept-aware non-cos lead
# AND a cos slot exists in the same guild, list cos-test as a SHARED CORE
# channel in the OVERRIDE banner. Mirrors production where each dept Lead
# listens to geoforge3d-core in addition to its own channel — Annie posts
# routing requests there and Leads decide based on @mention / dept scope.
# Without this update, the OVERRIDE bullet "Your ONLY channel" silenced
# cos-test messages even though access.json now allowlists cos-test.
SHARED_CORE_BANNER=""
if [[ -n "$DEPARTMENT" && "$DEPARTMENT" != "cos" && -n "$COS_CHANNEL_ID" && "$COS_CHANNEL_ID" != "$CHAT_CHANNEL_ID" ]]; then
  CHANNEL_FILTER_TEXT="If a received message's \`chat_id\` is NOT one of: \`${CHAT_CHANNEL_ID}\` (own), \`${COS_CHANNEL_ID}\` (cos-test shared core), silently ignore it (no reply, no action)."
  ALLOWED_CHANNELS_TEXT="**Your channels** (allowed): <#${CHAT_CHANNEL_ID}> (own primary), <#${COS_CHANNEL_ID}> (shared core, multiple Lead bots listen here — same as production geoforge3d-core)"
  SHARED_CORE_BANNER="
- **Shared core channel routing** (FLY-127 v3): in <#${COS_CHANNEL_ID}> multiple Lead bots see every message. Only act when (1) your bot is @-mentioned, OR (2) your name appears in the text, OR (3) a Linear issue is named whose label matches your dept (\`${DEPT_LABEL:-N/A}\`). Otherwise stay silent — the matching dept Lead handles it. This mirrors production's geoforge3d-core multi-Lead routing."
else
  CHANNEL_FILTER_TEXT="If a received message's \`chat_id\` is not \`${CHAT_CHANNEL_ID}\`, silently ignore it (no reply, no action)."
  ALLOWED_CHANNELS_TEXT="**Your ONLY channel**: <#${CHAT_CHANNEL_ID}> (channel ID \`${CHAT_CHANNEL_ID}\`)"
fi

cat > "${SLOT_DIR}/test-identity.md" <<EOF
---
name: ${AGENT_ID}
description: Flywheel TEST slot ${SLOT} (${SLOT_ROLE}${DEPT_DESC_SUFFIX}) — automated QA environment
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
- ${ALLOWED_CHANNELS_TEXT}
- **Ignore** all other channel IDs in "Channel Isolation Rules", "Core Channel Routing", "Discord Channel IDs", etc. — those belong to production.
- ${CHANNEL_FILTER_TEXT}
- **Behavior rules** (when to announce session_started / session_completed / session_failed, message format, reactions) from the sections below STILL apply — but only inside the channels listed above.
- **Project name (FLY-127 qa-fly-127 R4)**: For ALL Bridge API calls (\`/api/runs/start\`, \`/api/sessions/*\`, \`flywheel-comm respond\`, etc.) and for any \`projectName\` field in JSON bodies, you MUST use \`${TEST_PROJECT_NAME}\` — NOT the production project name (\`geoforge3d\`, \`flywheel\`, etc.) referenced in the sections below. Bridge will 403 \`project_unknown\` for the production name because this slot's \`FLYWHEEL_PROJECTS\` only registers the test project.${DEPT_BANNER}${SHARED_CORE_BANNER}

### Lead ID for API calls (FLY-60 W6 — overrides production identity name)

The production identity below uses the production lead name (\`product-lead\` / \`cos-lead\` / \`ops-lead\`) when invoking Bridge HTTP APIs and \`flywheel-comm\` CLI. **In this test slot you are NOT that lead — you are \`${AGENT_ID}\`.** The Bridge scope-checks every API call against the slot-configured \`agentId=${AGENT_ID}\` and 403-rejects any call that uses a production lead name.

- **Your leadId for ALL API calls**: \`${AGENT_ID}\` (NOT \`product-lead\` / \`cos-lead\` / \`ops-lead\` from the production template below).
- **Override scope**: every \`leadId\` value in the sections below — whether it's a literal string in JSON bodies (\`"leadId": "product-lead"\`), a CLI flag (\`--lead product-lead\`), a shell variable reference (\`\${LEAD_ID}\`, \`\${FLYWHEEL_LEAD_ID}\`), or anywhere else — MUST be substituted to \`${AGENT_ID}\` before you run the command. The production examples below are templates; you are running as \`${AGENT_ID}\`.
- **Env vars for this slot**: \`LEAD_ID=${AGENT_ID}\` and \`FLYWHEEL_LEAD_ID=${AGENT_ID}\`. Prefer using these in shell commands rather than hardcoded production names.
- **Forbidden literal strings** in any API call body / CLI flag (Bridge will 403-reject these as scope-mismatched against \`agentId=${AGENT_ID}\`):
  - \`product-lead\`
  - \`cos-lead\`
  - \`ops-lead\`
- Examples of correct usage in this slot:
  - \`flywheel-comm respond --lead ${AGENT_ID} --db ... <question_id> approve\`
  - \`curl -X POST .../api/sessions/<exec_id>/close-runner -d '{"leadId":"${AGENT_ID}","reason":"..."}'\`
  - \`curl -X POST .../api/runs/start -d '{"leadId":"${AGENT_ID}","issueId":"FLY-XXX"}'\`

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
# FLY-115 v1.24.2 Gap 1 + Gap C: Use `jq -n` to build FLYWHEEL_PROJECTS so that:
#   - `botTokenEnv` is always present → Lead/Bridge resolve token via the
#     per-slot env var instead of falling back to DISCORD_BOT_TOKEN (Gap 1).
#   - `forumChannel` key is added only when `forumChannelId` is non-empty.
#     ProjectConfig's validator rejects empty strings / nulls but accepts an
#     absent key — see packages/teamlead/src/ProjectConfig.ts:100-110.
#     Until Annie populates the test guild's forum channels, FORUM_CHANNEL_ID
#     stays empty and the key is omitted, so Bridge still starts cleanly.
# Note: TEST_PROJECT_NAME is defined earlier (after the sandbox clone) so the
# v1.24.3 sandbox config write can reuse it; the assignment is left here in
# comment form for traceability.
# TEST_PROJECT_NAME="test-slot-${SLOT}"  # moved up to ~line 292 (FLY-115 v1.24.3)
# FLY-127: when slot.deptLabel is set, the lead's match.labels becomes
# `[deptLabel]` so PR #170's department registry actually enforces scope in
# tests (S1 happy / S2 mismatch / S3 multi-dept / S4 no-dept all become
# meaningful). When deptLabel is empty (legacy slots), keep `["*"]` so old
# integration tests that don't care about dept routing keep passing.
#
# FLY-127 (qa-fly-127 round 2): single-Lead-per-Bridge test slots can't
# reproduce `label_mismatch` / `issue_multiple_department_labels` /
# auto-resolve-to-sibling because each Bridge's `loadProjects()` only sees
# its own dept Lead. The registry then truthfully reports "no canonical lead
# in this project" for any foreign-dept label, so S2/S3/AR2/AR3 collapse
# into S4 / 200-spawn shapes.
#
# Fix (Path A): when this slot is dept-aware (slot.department set), also
# inject sibling spawning leads from ~/.flywheel/test-slots.json as
# **shadow** Lead entries. Shadows reuse the sibling slot's bot-token-env +
# chat/forum channel IDs, so:
#   * ProjectConfig's per-spawning-lead canonical-label uniqueness check
#     still passes (each shadow has a distinct dept label).
#   * The 403 paths (label_mismatch, multi-dept) are fully testable; no
#     dispatch happens before a 403 so the shadow never has to act.
#   * AR3 (auto-resolve to sibling) routes the runs/start to a shadow whose
#     announce path uses the sibling slot's bot — Discord side sees the
#     spawn notification land in the right channel; the Runner itself is
#     hosted on this slot's host. That's a known test-infra deviation from
#     prod (in prod each dept has its own Bridge); documented in QA report.
#
# Legacy slots (no `.department`) skip shadow injection so existing tests
# aren't perturbed.
SHADOW_LEADS_JSON="[]"
if [[ -n "$DEPARTMENT" ]]; then
  SHADOW_LEADS_JSON=$(jq -c \
    --arg currentBot "$AGENT_ID" \
    '
    [
      .slots[]
      | select((.department // "") != "")
      | select((.forumChannelId // "") != "")
      | select(.botName != $currentBot)
      | {
          agentId: .botName,
          chatChannel: .channelId,
          botTokenEnv: .tokenEnvVar,
          forumChannel: .forumChannelId,
          match: { labels: [.deptLabel] }
        }
    ]
    ' "$SLOTS_FILE")
fi

FLYWHEEL_PROJECTS=$(jq -n \
  --arg projectName "$TEST_PROJECT_NAME" \
  --arg projectRoot "$HOST_REPO" \
  --arg projectRepo "$SANDBOX_SLUG" \
  --arg agentId "$AGENT_ID" \
  --arg chatChannel "$CHAT_CHANNEL_ID" \
  --arg botTokenEnv "$BOT_TOKEN_ENV" \
  --arg forumChannel "$FORUM_CHANNEL_ID" \
  --arg deptLabel "$DEPT_LABEL" \
  --argjson shadowLeads "$SHADOW_LEADS_JSON" \
  '
  [{
    projectName: $projectName,
    projectRoot: $projectRoot,
    projectRepo: $projectRepo,
    leads: ([
      ({
        agentId: $agentId,
        chatChannel: $chatChannel,
        botTokenEnv: $botTokenEnv,
        match: { labels: (if ($deptLabel != "") then [$deptLabel] else ["*"] end) }
      } + (if ($forumChannel != "") then { forumChannel: $forumChannel } else {} end))
    ] + $shadowLeads)
  }]
  ')

if [[ -z "$FORUM_CHANNEL_ID" ]]; then
  log "WARN: slot ${SLOT} has no forumChannelId in $SLOTS_FILE — forum thread creation will be skipped (Gap C §11.2 env gate pending)"
fi
SHADOW_COUNT=$(echo "$SHADOW_LEADS_JSON" | jq 'length')
if [[ -n "$DEPT_LABEL" ]]; then
  log "Dept-aware slot ${SLOT}: department=${DEPARTMENT:-?} deptLabel=${DEPT_LABEL} identitySource=${IDENTITY_SOURCE:-(role-based:${SLOT_ROLE})} shadowLeads=${SHADOW_COUNT}"
else
  log "Legacy slot ${SLOT}: deptLabel absent → match.labels=['*'] (no dept enforcement)"
fi

log "Starting test Lead: ${AGENT_ID} (project: ${TEST_PROJECT_NAME})"

# ── Step 1: Start test Lead (background) ─────────────
# env -u clears inherited production token, then sets test token explicitly (D8)
# FLY-115 fix: redirect Lead stdout/stderr to a per-slot log so the caller's
# `| tail -40` doesn't stay attached to the backgrounded Lead's stdout — that
# kept the pipe open and made the caller hang forever.
LEAD_LOG="${SLOT_DIR}/lead.log"
env -u DISCORD_BOT_TOKEN \
  DISCORD_BOT_TOKEN="${TEST_BOT_TOKEN}" \
  DISCORD_GUILD_ID="${GUILD_ID}" \
  BRIDGE_URL="http://localhost:${SLOT_PORT}" \
  DISCORD_STATE_DIR="${SLOT_DIR}/discord-state" \
  AGENT_SOURCE="${SLOT_DIR}/test-identity.md" \
  FLYWHEEL_LEAD_ROLE="${SLOT_ROLE}" \
  bash "${REPO_ROOT}/packages/teamlead/scripts/claude-lead.sh" \
    "${AGENT_ID}" "${HOST_REPO}" "${TEST_PROJECT_NAME}" \
    > "${LEAD_LOG}" 2>&1 &
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
# FLY-115 v1.24.2 Gap 1 (Codex R1 LOW fix): also pass the per-lead token
# under the name the ProjectConfig references in `botTokenEnv` (e.g.
# TEST_BOT_TOKEN_1). Without this, process.env[botTokenEnv] is empty and
# loadProjects() silently falls back to DISCORD_BOT_TOKEN
# (packages/teamlead/src/ProjectConfig.ts:179-189). Fallback works for a
# single-slot test but masks a real misconfiguration (wrong tokenEnvVar,
# wrong .env key). Exporting both keeps botTokenEnv load-bearing.
env -u TEAMLEAD_API_TOKEN \
  TEAMLEAD_PORT="${SLOT_PORT}" \
  DISCORD_BOT_TOKEN="${TEST_BOT_TOKEN}" \
  "${BOT_TOKEN_ENV}=${TEST_BOT_TOKEN}" \
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
  "bridgeLog": "${SLOT_DIR}/bridge.log",
  "leadLog": "${LEAD_LOG}"
}
EOF
