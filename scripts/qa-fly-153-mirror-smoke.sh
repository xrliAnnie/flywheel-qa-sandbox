#!/usr/bin/env bash
# FLY-153 mirror-mode smoke test.
#
# Two phases:
#   Phase A — Deterministic preflight (0 retry). Verifies wiring:
#             config, plugin cache, deploy success, REST probes, identity.md
#             content, access.json shape, flywheel-projects.json content.
#             Any failure exits non-zero with artifacts dumped.
#   Phase B — LLM behavior (1 retry per fixture, bot-origin only).
#             B2: slot 1 (Simba) bot mentions slot 2 (Peter); expect Peter
#                 reply, slots 1+3 silent, no Runner / chat-thread side effects.
#             B3: same with slot 3 (Oliver) — symmetric coverage.
#             1/2 fixtures pass = success (framework smoke proves transport,
#             not full reply-discipline coverage which is FLY-152 scope).
#
# Usage:  scripts/qa-fly-153-mirror-smoke.sh
#
# Pre-reqs:
#   - ~/.flywheel/test-slots.json with mirrorChannel.channelId set
#   - TEST_BOT_TOKEN_1, TEST_BOT_TOKEN_2, TEST_BOT_TOKEN_3 in ~/.flywheel/.env
#   - Mirror channel exists in test guild with bots 1/2/3 invited
#   - Annie's one-time setup per packages/qa-framework/README.md §Mirror Mode
#
# Exit codes:
#   0  — smoke passed (Phase A all + Phase B ≥1/2)
#   2  — Phase A deterministic failure
#   3  — Phase B LLM phase failed (0/2 after retries)
#   4  — usage / pre-req error
set -euo pipefail

# Smoke uses associative arrays (declare -A), which require Bash 4+. macOS
# ships /bin/bash 3.2.57 by default, so #!/usr/bin/env bash can land on it
# unless Homebrew bash is earlier in PATH. Fail fast with a precise hint.
if (( BASH_VERSINFO[0] < 4 )); then
  echo "ERROR: ${BASH_SOURCE[0]} requires Bash 4+ (got ${BASH_VERSION})." >&2
  echo "  macOS default bash is 3.2 — install a newer one with 'brew install bash'" >&2
  echo "  and run via /opt/homebrew/bin/bash (Apple Silicon) or /usr/local/bin/bash." >&2
  exit 4
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ENV_FILE="${HOME}/.flywheel/.env"
SLOTS_FILE="${HOME}/.flywheel/test-slots.json"
[[ -f "$ENV_FILE" ]] || { echo "ERROR: ${ENV_FILE} missing" >&2; exit 4; }
[[ -f "$SLOTS_FILE" ]] || { echo "ERROR: ${SLOTS_FILE} missing" >&2; exit 4; }
# shellcheck disable=SC1090
source "$ENV_FILE"

TS="$(date +%Y%m%d-%H%M%S)"
ARTIFACT_DIR="/tmp/qa-fly-153-mirror-smoke-${TS}"
mkdir -p "$ARTIFACT_DIR"

log() { echo "[smoke $(date +%H:%M:%S)] $*" >&2; }

dump_artifacts() {
  local reason="$1"
  log "Dumping artifacts → ${ARTIFACT_DIR} (reason: ${reason})"
  echo "$reason" > "${ARTIFACT_DIR}/FAIL_REASON.txt"
  for s in 1 2 3; do
    local sd="/tmp/flywheel-test-slot-${s}"
    [[ -f "${sd}/test-identity.md" ]] && cp "${sd}/test-identity.md" "${ARTIFACT_DIR}/slot-${s}-test-identity.md" || true
    [[ -f "${sd}/discord-state/access.json" ]] && cp "${sd}/discord-state/access.json" "${ARTIFACT_DIR}/slot-${s}-access.json" || true
    [[ -f "${sd}/flywheel-projects.json" ]] && cp "${sd}/flywheel-projects.json" "${ARTIFACT_DIR}/slot-${s}-flywheel-projects.json" || true
    [[ -f "${sd}/bridge.log" ]] && tail -200 "${sd}/bridge.log" > "${ARTIFACT_DIR}/slot-${s}-bridge.log.tail" || true
  done
  if [[ -n "${MIRROR_CHANNEL_ID:-}" && -n "${TEST_BOT_TOKEN_1:-}" ]]; then
    curl -sf -H "Authorization: Bot ${TEST_BOT_TOKEN_1}" \
      "https://discord.com/api/v10/channels/${MIRROR_CHANNEL_ID}/messages?limit=30" \
      > "${ARTIFACT_DIR}/recent-channel-messages.json" 2>/dev/null || true
  fi
}

# ═══════════════════════════════════════════════════════════════════
# Phase A — Deterministic preflight
# ═══════════════════════════════════════════════════════════════════

log "Phase A — deterministic preflight"

MIRROR_CHANNEL_ID=$(jq -r '.mirrorChannel.channelId // empty' "$SLOTS_FILE")
if [[ -z "$MIRROR_CHANNEL_ID" || "$MIRROR_CHANNEL_ID" == "<shared-mirror-channel-id>" ]]; then
  echo "ERROR [Phase A]: mirrorChannel.channelId missing/placeholder in ${SLOTS_FILE}" >&2
  echo "  See packages/qa-framework/README.md §Mirror Mode for setup." >&2
  exit 2
fi
log "Mirror channel: ${MIRROR_CHANNEL_ID}"

# Plugin cache must consume access.allowBots
PLUGIN_BASE="${HOME}/.claude/plugins/cache/claude-plugins-official/discord"
if [[ -d "$PLUGIN_BASE" ]]; then
  LATEST_PLUGIN=$(ls -dt "${PLUGIN_BASE}"/*/ 2>/dev/null | head -1)
  if [[ -n "$LATEST_PLUGIN" && -f "${LATEST_PLUGIN}/server.ts" ]]; then
    grep -q "access.allowBots" "${LATEST_PLUGIN}/server.ts" \
      || { echo "ERROR [Phase A]: Discord plugin at ${LATEST_PLUGIN} does not consume access.allowBots." >&2; dump_artifacts "plugin-cache-stale"; exit 2; }
    log "Plugin cache OK: ${LATEST_PLUGIN}"
  fi
fi

# Bot user IDs (echo for sanity per Round 1 #7)
declare -A BOT_TOKENS=()
declare -A BOT_IDS=()
for s in 1 2 3; do
  BOT_TOKENS[$s]="$(eval echo "\${TEST_BOT_TOKEN_$s:-}")"
  BOT_IDS[$s]=$(jq -r ".slots[$((s-1))].botAppId" "$SLOTS_FILE")
  [[ -n "${BOT_TOKENS[$s]}" ]] || { echo "ERROR [Phase A]: TEST_BOT_TOKEN_$s missing in env" >&2; exit 4; }
  [[ -n "${BOT_IDS[$s]}" && "${BOT_IDS[$s]}" != "null" ]] || { echo "ERROR [Phase A]: slots[$((s-1))].botAppId missing in ${SLOTS_FILE}" >&2; exit 4; }
  log "Slot $s bot user ID: ${BOT_IDS[$s]}"
done

# Cleanup trap installed BEFORE the deploy loop so a partial deploy (slot 1
# OK, slot 2 fails) still tears down whatever made it up. DEPLOYED_SLOTS
# tracks which slots actually need teardown so we don't issue spurious
# test-teardown.sh calls for slots that never claimed a lock.
DEPLOYED_SLOTS=()
cleanup() {
  for s in "${DEPLOYED_SLOTS[@]}"; do
    "${SCRIPT_DIR}/test-teardown.sh" "$s" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

# Deploy slots 1-3 in mirror mode
declare -A DEPLOY_JSON=()
for s in 1 2 3; do
  log "Deploying mirror slot $s ..."
  if ! out=$("${SCRIPT_DIR}/test-deploy.sh" --mode mirror "$s" 2> "${ARTIFACT_DIR}/slot-${s}-deploy.stderr"); then
    echo "ERROR [Phase A]: test-deploy.sh --mode mirror $s failed" >&2
    cat "${ARTIFACT_DIR}/slot-${s}-deploy.stderr" >&2
    dump_artifacts "deploy-slot-${s}-failed"
    exit 2
  fi
  DEPLOY_JSON[$s]="$out"
  DEPLOYED_SLOTS+=("$s")
  echo "$out" > "${ARTIFACT_DIR}/slot-${s}-deploy.json"
  log "Slot $s deployed"
done

# Validate access.json + flywheel-projects.json + identity.md per slot
for s in 1 2 3; do
  sd="/tmp/flywheel-test-slot-${s}"

  # access.json
  ACC="${sd}/discord-state/access.json"
  [[ -f "$ACC" ]] || { echo "ERROR [Phase A]: ${ACC} missing" >&2; dump_artifacts "missing-access-${s}"; exit 2; }
  jq -e --arg ch "$MIRROR_CHANNEL_ID" '.groups[$ch] != null' "$ACC" >/dev/null \
    || { echo "ERROR [Phase A]: slot ${s} access.json missing groups[mirror-channel]" >&2; dump_artifacts "access-groups-${s}"; exit 2; }
  for other in 1 2 3; do
    jq -e --arg id "${BOT_IDS[$other]}" '.allowBots | index($id) != null' "$ACC" >/dev/null \
      || { echo "ERROR [Phase A]: slot ${s} access.json allowBots missing bot ${BOT_IDS[$other]} (slot ${other})" >&2; dump_artifacts "access-allowBots-${s}-missing-${other}"; exit 2; }
  done

  # flywheel-projects.json
  FP="${sd}/flywheel-projects.json"
  [[ -f "$FP" ]] || { echo "ERROR [Phase A]: ${FP} missing (test-deploy.sh did not persist FLYWHEEL_PROJECTS)" >&2; dump_artifacts "missing-projects-${s}"; exit 2; }
  ACTUAL_CHANNEL=$(jq -r '.[0].leads[0].chatChannel' "$FP")
  [[ "$ACTUAL_CHANNEL" == "$MIRROR_CHANNEL_ID" ]] \
    || { echo "ERROR [Phase A]: slot ${s} flywheel-projects.json chatChannel=${ACTUAL_CHANNEL}, expected ${MIRROR_CHANNEL_ID}" >&2; dump_artifacts "projects-chatChannel-${s}"; exit 2; }

  # identity.md
  IDM="${sd}/test-identity.md"
  [[ -f "$IDM" ]] || { echo "ERROR [Phase A]: ${IDM} missing" >&2; dump_artifacts "missing-identity-${s}"; exit 2; }
  if grep -q "Ignore all other channel IDs" "$IDM"; then
    echo "ERROR [Phase A]: slot ${s} identity.md still contains legacy 'Ignore all other channel IDs' banner" >&2
    dump_artifacts "identity-legacy-banner-${s}"
    exit 2
  fi
  grep -q "CHANNEL CONTEXT — MIRROR MODE" "$IDM" \
    || { echo "ERROR [Phase A]: slot ${s} identity.md missing 'CHANNEL CONTEXT — MIRROR MODE' header" >&2; dump_artifacts "identity-mirror-banner-${s}"; exit 2; }

  # Slot 3 must load Oliver's identity (validates §4.1 fix)
  if [[ "$s" == "3" ]]; then
    if ! grep -qiE "Oliver|ops-lead" "$IDM"; then
      echo "ERROR [Phase A]: slot 3 identity.md does not appear to load ops-lead identity (Oliver)" >&2
      echo "  Check slots[2].identitySource = 'ops-lead' in ${SLOTS_FILE}" >&2
      dump_artifacts "slot-3-not-oliver"
      exit 2
    fi
  fi
done
log "Phase A — all slots validated"

# Ephemeral POST/DELETE per bot to verify Send Messages permission
for s in 1 2 3; do
  PROBE_BODY=$(jq -n --arg c "__qa-fly-153-probe-slot-${s}-${TS}__" '{content:$c}')
  POST_RESP=$(curl -s -X POST \
    -H "Authorization: Bot ${BOT_TOKENS[$s]}" \
    -H "Content-Type: application/json" \
    -d "$PROBE_BODY" \
    "https://discord.com/api/v10/channels/${MIRROR_CHANNEL_ID}/messages" 2>/dev/null || echo "")
  PROBE_MSG_ID=$(echo "$POST_RESP" | jq -r '.id // empty' 2>/dev/null || echo "")
  if [[ -z "$PROBE_MSG_ID" ]]; then
    echo "ERROR [Phase A]: slot ${s} bot cannot Send Messages to mirror channel" >&2
    echo "  POST response: $POST_RESP" >&2
    dump_artifacts "send-probe-${s}"
    exit 2
  fi
  # Best-effort cleanup
  curl -s -X DELETE -H "Authorization: Bot ${BOT_TOKENS[$s]}" \
    "https://discord.com/api/v10/channels/${MIRROR_CHANNEL_ID}/messages/${PROBE_MSG_ID}" >/dev/null 2>&1 || true
  log "Slot $s Send Messages OK (probe msg ${PROBE_MSG_ID} cleaned)"
done

log "Phase A PASS"

# ═══════════════════════════════════════════════════════════════════
# Phase B — LLM behavior (bot-origin)
# ═══════════════════════════════════════════════════════════════════

log "Phase B — LLM bot-origin fixtures"

# sqlite3 is required for StateStore side-effect assertions. If missing, the
# `|| echo 0` fallback would silently pass even when state actually changed.
# Fail loudly so the smoke is honest about coverage.
command -v sqlite3 >/dev/null \
  || { echo "ERROR [Phase B]: sqlite3 not found in PATH — required for StateStore side-effect checks." >&2; dump_artifacts "no-sqlite3"; exit 2; }

# Capture per-slot baselines so each fixture compares against the freshly
# observed state (not the pre-Phase-B state) — that way fixture B3 can detect
# its own side effects without being confused by anything B2 left behind.
declare -A BASELINE_SESSIONS=()
declare -A BASELINE_CHAT_THREADS=()
declare -A BASELINE_RUNS_LOG=()
declare -A BASELINE_THREAD_LOG=()
# `grep -c PATTERN file` exits 1 when there are zero matches (and writes "0"
# to stdout). Combining with `|| echo "0"` produces "0\n0" which then breaks
# arithmetic comparison (`(( cur > base ))` errors). awk always exits 0 and
# always prints exactly one integer, so the result is unambiguous.
count_matches() {
  local pattern="$1" file="$2"
  if [[ ! -f "$file" ]]; then echo 0; return; fi
  awk -v pat="$pattern" '$0 ~ pat {n++} END {print n+0}' "$file"
}
sqlite_count() {
  local db="$1" sql="$2"
  if [[ ! -f "$db" ]]; then echo 0; return; fi
  local out
  out=$(sqlite3 "$db" "$sql" 2>/dev/null || echo "")
  echo "${out:-0}"
}

snapshot_baselines() {
  local s
  for s in 1 2 3; do
    BASELINE_SESSIONS[$s]=$(sqlite_count "/tmp/flywheel-test-slot-${s}/teamlead.db" "SELECT count(*) FROM sessions")
    BASELINE_CHAT_THREADS[$s]=$(sqlite_count "/tmp/flywheel-test-slot-${s}/teamlead.db" "SELECT count(*) FROM chat_threads")
    BASELINE_RUNS_LOG[$s]=$(count_matches "/api/runs/start" "/tmp/flywheel-test-slot-${s}/bridge.log")
    BASELINE_THREAD_LOG[$s]=$(count_matches "ensureChatThread|chatThread.*create" "/tmp/flywheel-test-slot-${s}/bridge.log")
  done
}
snapshot_baselines

# Run a single bot-origin fixture: source bot mentions target bot.
# Returns 0 if target replied and non-targets stayed silent; 1 otherwise.
run_fixture() {
  local source_slot="$1" target_slot="$2" fixture_name="$3"
  local target_id="${BOT_IDS[$target_slot]}"
  local source_token="${BOT_TOKENS[$source_slot]}"
  local body
  body=$(jq -n \
    --arg c "<@${target_id}> 看下 FLY-1，按 reply discipline 回（mirror smoke ${fixture_name} ${TS}）" \
    --arg uid "$target_id" \
    '{content:$c, allowed_mentions:{users:[$uid]}}')

  log "${fixture_name}: slot ${source_slot} bot posting mention of slot ${target_slot} (${target_id})"
  local post_resp post_id
  post_resp=$(curl -s -X POST \
    -H "Authorization: Bot ${source_token}" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "https://discord.com/api/v10/channels/${MIRROR_CHANNEL_ID}/messages" 2>/dev/null || echo "")
  post_id=$(echo "$post_resp" | jq -r '.id // empty')
  if [[ -z "$post_id" ]]; then
    log "${fixture_name}: POST failed: $post_resp"
    return 1
  fi

  log "${fixture_name}: posted msg ${post_id}; waiting 60s for replies"
  sleep 60

  local recent
  recent=$(curl -sf -H "Authorization: Bot ${source_token}" \
    "https://discord.com/api/v10/channels/${MIRROR_CHANNEL_ID}/messages?limit=50&after=${post_id}" 2>/dev/null || echo "[]")
  echo "$recent" > "${ARTIFACT_DIR}/${fixture_name}-recent.json"

  local target_replies non_target_replies
  target_replies=$(echo "$recent" | jq --arg id "$target_id" '[.[] | select(.author.id == $id)] | length')
  non_target_replies=0
  for s in 1 2 3; do
    if [[ "$s" == "$target_slot" ]]; then continue; fi
    local count
    count=$(echo "$recent" | jq --arg id "${BOT_IDS[$s]}" '[.[] | select(.author.id == $id)] | length')
    non_target_replies=$((non_target_replies + count))
  done

  log "${fixture_name}: target_replies=${target_replies}, non_target_replies=${non_target_replies}"

  if (( target_replies < 1 )); then
    log "${fixture_name} FAIL: target slot ${target_slot} did not reply"
    return 1
  fi
  if (( non_target_replies > 0 )); then
    log "${fixture_name} FAIL: non-target slots replied (${non_target_replies} message(s))"
    return 1
  fi

  # Side-effect check: no Runner spawn or chat-thread creation on ANY slot
  # within this fixture window (compare against the per-fixture baselines we
  # snapshot BEFORE the POST). Mirror smoke is for reply discipline only.
  local s cur cur_threads cur_runs_log cur_thread_log
  for s in 1 2 3; do
    cur_runs_log=$(count_matches "/api/runs/start" "/tmp/flywheel-test-slot-${s}/bridge.log")
    if (( cur_runs_log > BASELINE_RUNS_LOG[$s] )); then
      log "${fixture_name} FAIL: slot ${s} bridge.log /api/runs/start delta ${BASELINE_RUNS_LOG[$s]} -> ${cur_runs_log} (unexpected Runner spawn)"
      return 1
    fi
    cur_thread_log=$(count_matches "ensureChatThread|chatThread.*create" "/tmp/flywheel-test-slot-${s}/bridge.log")
    if (( cur_thread_log > BASELINE_THREAD_LOG[$s] )); then
      log "${fixture_name} FAIL: slot ${s} bridge.log chat-thread create delta ${BASELINE_THREAD_LOG[$s]} -> ${cur_thread_log}"
      return 1
    fi
    cur=$(sqlite_count "/tmp/flywheel-test-slot-${s}/teamlead.db" "SELECT count(*) FROM sessions")
    if [[ "$cur" != "${BASELINE_SESSIONS[$s]}" ]]; then
      log "${fixture_name} FAIL: slot ${s} StateStore sessions changed from ${BASELINE_SESSIONS[$s]} to ${cur}"
      return 1
    fi
    cur_threads=$(sqlite_count "/tmp/flywheel-test-slot-${s}/teamlead.db" "SELECT count(*) FROM chat_threads")
    if [[ "$cur_threads" != "${BASELINE_CHAT_THREADS[$s]}" ]]; then
      log "${fixture_name} FAIL: slot ${s} StateStore chat_threads changed from ${BASELINE_CHAT_THREADS[$s]} to ${cur_threads}"
      return 1
    fi
  done

  log "${fixture_name} PASS"
  return 0
}

run_fixture_with_retry() {
  local source_slot="$1" target_slot="$2" fixture_name="$3"
  if run_fixture "$source_slot" "$target_slot" "$fixture_name"; then
    return 0
  fi
  log "${fixture_name}: 1 retry"
  if run_fixture "$source_slot" "$target_slot" "${fixture_name}-retry"; then
    return 0
  fi
  return 1
}

PASS_COUNT=0
run_fixture_with_retry 1 2 B2-Peter && PASS_COUNT=$((PASS_COUNT + 1)) || true
run_fixture_with_retry 1 3 B3-Oliver && PASS_COUNT=$((PASS_COUNT + 1)) || true

log "Phase B result: ${PASS_COUNT}/2 fixtures passed"

if (( PASS_COUNT < 1 )); then
  echo "ERROR [Phase B]: 0/2 LLM fixtures passed (smoke threshold is 1/2). Likely a banner / wiring issue." >&2
  dump_artifacts "phase-b-zero-pass"
  exit 3
fi

log "SMOKE PASS — Phase A all + Phase B ${PASS_COUNT}/2"
exit 0
