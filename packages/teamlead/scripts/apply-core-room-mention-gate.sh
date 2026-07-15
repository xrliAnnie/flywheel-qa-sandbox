#!/bin/bash
# FLY-898 — fleet-wide core-room reply discipline for CLAUDE leads (access.json).
#
# WHY: in a project's core room (its generalChannel) a non-CoS lead should hear a
# message ONLY when genuinely addressed (a real @ / reply-to-self); a bare no-@
# message goes to the CoS alone. The Discord plugin already enforces this once a
# group's `requireMention:true` — and, with the fork's PER-GROUP `mentionPatterns`,
# an EMPTY per-group patterns list makes the core group id-only (a bare NAME in
# text no longer counts — kills the FLY-152 pile-on). The CoS (chat==core) is
# untouched; the roundtable group keeps the global name patterns.
#
# FLY-944: the per-group `allowFrom` (sender whitelist) is checked BEFORE the
# mention gate in the plugin, so a stale whitelist silently dropped a SIBLING
# LEAD's real @-mention (only the founder was listed → lead-to-lead @ never
# triggered). It is retired: the main transform clears it in the SAME atomic
# patch as the requireMention flip (a non-CoS core must NEVER get allowFrom:[]
# while requireMention is still false — access.json hot-reloads, and that
# combination opens a hear-everything pile-on window). Sender trust stays with
# intake allowBots + guild membership; "should I reply" stays with the FLY-898
# mention discipline.
#
# WHAT: idempotently patch ONE existing core group in an access.json —
#   requireMention: false → true      (silences no-@ core messages), and
#   mentionPatterns: []               (id-only) — ONLY when the runtime plugin
#                                     supports per-group patterns (preflight),
#   allowFrom: []                     (FLY-944 — same atomic patch).
# Atomic (temp+rename), backed up first, idempotent (target-state → no-op),
# optimistic-rebase (the plugin also writes this file), fail-closed on bad JSON,
# and it NEVER creates a group / touches any other field. A missing core group is
# a NO-OP (the lead just doesn't subscribe core) — not an error.
#
# Two modes:
#   Single: --access-file <path> --channel-id <coreId> [--id-only] [--dry-run]
#   Fleet:  --all [--project <name>] [--id-only] [--dry-run]
#           (resolves every gated non-CoS CLAUDE lead via core-room-gate-cli.js
#            + its access.json under $FLYWHEEL_CHANNELS_DIR, then patches each.)
#
# --id-only requests the strict id-only fields; the PREFLIGHT (runtime server.ts
# has per-group support) gates whether they are actually written. Without it, the
# script still applies requireMention:true (partial benefit: no-@ silenced, bare
# name still passes) and LOUDLY warns that id-only is not yet active.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { echo "[core-room-gate] $*" >&2; }

usage() {
  cat >&2 <<USAGE
Usage:
  apply-core-room-mention-gate.sh --access-file <path> --channel-id <id> [--id-only|--allowfrom-only] [--dry-run]
  apply-core-room-mention-gate.sh --all [--project <name>] [--id-only] [--dry-run]
  apply-core-room-mention-gate.sh --all-shared [--dry-run]
USAGE
}

# ── Runtime plugin source (for the per-group preflight) ─────────────────────
# The RUNTIME path Claude Code executes the MCP server from is the marketplace
# dir. Overridable for tests.
PLUGIN_SERVER="${FLYWHEEL_DISCORD_PLUGIN_SERVER:-$HOME/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/discord/server.ts}"
# The support marker proving the RUNTIME plugin genuinely gates the core room on
# per-group patterns. An EXPLICIT sentinel (Codex R2 MEDIUM) — not a code-shape grep:
# a shape like `resolveGroupMentionPatterns(policy` could match a helper DEFINITION or
# a half-finished impl while `isMentioned` still used the global patterns. The fork
# carries this exact token at the gate ONLY while both isMentioned call sites route
# through `resolveGroupMentionPatterns`, so it cannot false-positive. Absent → preflight
# fails → we refuse to write the id-only field (requireMention-only + warn), never a
# silent half-fix.
PER_GROUP_MARKER='FLY-898-PER-GROUP-MENTION-PATTERNS-ACTIVE'

# Channels dir where each lead's access.json lives (claude-lead.sh DISCORD_STATE_DIR).
CHANNELS_DIR="${FLYWHEEL_CHANNELS_DIR:-$HOME/.claude/channels}"

# The built decision CLI (dist). Overridable for tests.
GATE_CLI="${FLYWHEEL_CORE_ROOM_GATE_CLI:-$SCRIPT_DIR/../dist/core-room-gate-cli.js}"

# FLY-944: roundtable channel id — env wins, else the FLY-569 shared default.
ROUNDTABLE_FILE="${FLYWHEEL_ROUNDTABLE_FILE:-$HOME/.flywheel/roundtable.json}"
resolve_roundtable_id() {
  if [ -n "${FLYWHEEL_ROUNDTABLE_CHANNEL_ID:-}" ]; then
    printf '%s' "$FLYWHEEL_ROUNDTABLE_CHANNEL_ID"; return 0
  fi
  [ -f "$ROUNDTABLE_FILE" ] && jq -r '.channelId // empty' "$ROUNDTABLE_FILE" 2>/dev/null
}

ALL=0
ALL_SHARED=0
ACCESS_FILE=""
CHANNEL_ID=""
ID_ONLY=0
ALLOWFROM_ONLY=0
DRY_RUN=0
PROJECT_FILTER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --all)         ALL=1; shift ;;
    --all-shared)  ALL_SHARED=1; shift ;;
    --access-file) ACCESS_FILE="${2:-}"; shift 2 ;;
    --channel-id)  CHANNEL_ID="${2:-}"; shift 2 ;;
    --project)     PROJECT_FILTER="${2:-}"; shift 2 ;;
    --id-only)     ID_ONLY=1; shift ;;
    --allowfrom-only) ALLOWFROM_ONLY=1; shift ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) log "ERROR: unknown arg '$1'"; usage; exit 2 ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  log "ERROR: jq is required but not found"; exit 2
fi

# ── Preflight: does the RUNTIME plugin support per-group mentionPatterns? ────
# Returns 0 (supported) / 1 (not). A missing server.ts → not supported (safe:
# we won't write id-only fields that the old plugin would silently ignore).
preflight_per_group() {
  [ -f "$PLUGIN_SERVER" ] || return 1
  grep -q "$PER_GROUP_MARKER" "$PLUGIN_SERVER" 2>/dev/null
}

# ── Atomic edit with optimistic-concurrency guard (the plugin also writes
# these files; mirror add-roundtable-allowfrom.sh). cksum is the change detector
# (locale-independent, unlike shasum under LANG=C.UTF-8).
hash_file() { cksum "$1" 2>/dev/null | awk '{print $1"-"$2}'; }

# atomic_patch <access-file> <channel-id> <jq-filter> <log-msg>
# Applies `jq --arg ch <channel-id> <jq-filter>` to the file atomically:
# backup first, pre-hash rebase (a concurrent plugin write wins → retry, 5x),
# fail-closed on bad JSON output, and a failed rename never reports success.
# Backup names carry a per-process sequence (Codex code review R1 MEDIUM):
# `.bak.<epoch>.<pid>` alone collides when ONE run patches the SAME file twice
# within a second (--all-shared: core + roundtable) — the second cp would eat
# the first backup and the pre-sweep state would be unrecoverable.
_BAK_SEQ=0
atomic_patch() {
  local af="$1" ch="$2" filter="$3" msg="$4"
  local swapped=0 backup=""
  for _ in 1 2 3 4 5; do
    local pre tmp
    pre="$(hash_file "$af")"
    tmp="${af}.tmp.$$"
    if ! jq --arg ch "$ch" "$filter" "$af" > "$tmp" 2>/dev/null; then
      rm -f "$tmp"; sleep 0.2; continue
    fi

    if ! jq -e . "$tmp" >/dev/null 2>&1; then
      log "ERROR: edit produced invalid JSON — aborting, original untouched"
      rm -f "$tmp"; return 1
    fi

    # FAIL-CLOSED (Codex R1 MEDIUM): the script runs `set -uo pipefail` (no -e), so
    # cp/mv failures must be checked explicitly — a failed backup must NOT proceed to
    # mutate, and a failed rename must NOT report success (fleet rollout evidence must
    # be trustworthy).
    _BAK_SEQ=$((_BAK_SEQ + 1))
    backup="${af}.bak.$(date +%s).$$.${_BAK_SEQ}"
    if ! cp -p "$af" "$backup"; then
      log "ERROR: backup failed for $af — aborting, original untouched"
      rm -f "$tmp" "$backup"; backup=""; return 1
    fi
    # Re-base immediately before the swap: a concurrent plugin write wins → retry.
    if [ "$(hash_file "$af")" != "$pre" ]; then
      rm -f "$tmp" "$backup"; backup=""; sleep 0.2; continue
    fi
    if ! mv "$tmp" "$af"; then
      log "ERROR: rename failed for $af — not applied (backup: $backup)"
      rm -f "$tmp"
      return 1
    fi
    swapped=1
    break
  done

  if [ "$swapped" -ne 1 ]; then
    log "ERROR: access.json kept changing under a concurrent writer — not applied ($af)"
    return 1
  fi

  log "$msg in $af (backup: $backup)"
  return 0
}

# ── Patch ONE access.json's core group (idempotent, atomic, fail-closed) ────
# args: <access-file> <channel-id>
# Uses ID_ONLY / ALLOWFROM_ONLY / DRY_RUN / preflight from the outer scope.
apply_one() {
  local af="$1" ch="$2"

  if [ ! -f "$af" ]; then
    log "no access.json for group '$ch' at $af — skip (lead not provisioned)"
    return 0
  fi
  if ! jq -e . "$af" >/dev/null 2>&1; then
    log "ERROR: not valid JSON: $af (fail-closed, not mutated)"
    return 1
  fi
  # A missing core group = the lead does not subscribe core → NO-OP (never create).
  if ! jq -e --arg ch "$ch" '.groups | has($ch)' "$af" >/dev/null 2>&1; then
    log "core group '$ch' not present in $af — no-op (lead not subscribed to core)"
    return 0
  fi

  # Decide the id-only intent for THIS run (preflight-gated).
  local want_id_only=0
  if [ "$ID_ONLY" -eq 1 ]; then
    if preflight_per_group; then
      want_id_only=1
    else
      log "WARNING: --id-only requested but runtime plugin lacks per-group mentionPatterns support"
      log "         ($PLUGIN_SERVER) — applying requireMention:true ONLY (bare-name still passes)."
      log "         id-only NOT active: sync the fork plugin, then re-run to complete the id-only gate."
    fi
  fi

  # ── FLY-944 --allowfrom-only: retire the per-group sender whitelist ONLY ──
  # CALLER CONTRACT: only for a CoS core group (requireMention:false is its
  # design state) or a roundtable group (fleet-wide requireMention:true; the
  # plugin also defaults a MISSING requireMention to true). A NON-CoS core must
  # go through the main transform (flip + clear together) — clearing allowFrom
  # alone there would open the hear-everything pile-on window (hot-reload!).
  if [ "$ALLOWFROM_ONLY" -eq 1 ]; then
    local cur_af_empty
    cur_af_empty=$(jq -r --arg ch "$ch" \
      '((.groups[$ch].allowFrom // []) | length) == 0' "$af")
    if [ "$cur_af_empty" = "true" ]; then
      log "group '$ch' allowFrom already empty in $af — no-op"
      return 0
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
      log "DRY-RUN — would clear group '$ch' allowFrom in $af"
      return 0
    fi
    # shellcheck disable=SC2016  # $ch is a jq --arg, expanded by jq not bash.
    atomic_patch "$af" "$ch" '.groups[$ch].allowFrom = []' \
      "group '$ch' → allowFrom:[] (shared-channel sender whitelist retired)"
    return $?
  fi

  # Current state. FLY-944: the target state now also has an EMPTY allowFrom —
  # the per-group sender whitelist dropped sibling-lead @-mentions BEFORE the
  # mention check, so it is retired in the SAME atomic patch as the flip.
  local cur_req cur_patterns_is_empty cur_af_empty
  cur_req=$(jq -r --arg ch "$ch" '.groups[$ch].requireMention' "$af")
  cur_patterns_is_empty=$(jq -r --arg ch "$ch" \
    '((.groups[$ch] | has("mentionPatterns")) and ((.groups[$ch].mentionPatterns | length) == 0))' "$af")
  cur_af_empty=$(jq -r --arg ch "$ch" \
    '((.groups[$ch].allowFrom // []) | length) == 0' "$af")

  # Already in the target state? → idempotent no-op.
  if [ "$cur_req" = "true" ] && [ "$cur_af_empty" = "true" ]; then
    if [ "$want_id_only" -eq 0 ] || [ "$cur_patterns_is_empty" = "true" ]; then
      local state="mention-required-only"
      [ "$want_id_only" -eq 1 ] && state="id-only-core"
      log "group '$ch' already at target ($state + allowFrom:[]) in $af — no-op"
      return 0
    fi
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$want_id_only" -eq 1 ]; then
      log "DRY-RUN — would set group '$ch' requireMention:true + mentionPatterns:[] + allowFrom:[] (id-only-core) in $af"
    else
      log "DRY-RUN — would set group '$ch' requireMention:true + allowFrom:[] (mention-required-only) in $af"
    fi
    return 0
  fi

  # Build the transform: always requireMention:true; set mentionPatterns:[] only
  # when id-only is active this run.
  local filter msg
  # shellcheck disable=SC2016  # $ch in the filters is a jq --arg, expanded by jq.
  if [ "$want_id_only" -eq 1 ]; then
    filter='.groups[$ch].requireMention = true | .groups[$ch].mentionPatterns = [] | .groups[$ch].allowFrom = []'
    msg="group '$ch' → requireMention:true + mentionPatterns:[] + allowFrom:[] (id-only-core)"
  else
    filter='.groups[$ch].requireMention = true | .groups[$ch].allowFrom = []'
    msg="group '$ch' → requireMention:true + allowFrom:[] (mention-required-only)"
  fi
  atomic_patch "$af" "$ch" "$filter" "$msg"
  return $?
}

# ── Fleet mode: iterate every gated non-CoS CLAUDE lead ─────────────────────
run_all() {
  if [ ! -f "$GATE_CLI" ]; then
    log "ERROR: decision CLI not built ($GATE_CLI) — run: pnpm -F flywheel-teamlead build"
    return 1
  fi
  local jsonl rc=0
  jsonl="$(node "$GATE_CLI" --all 2>/dev/null)" || {
    log "ERROR: core-room-gate-cli --all failed"; return 1
  }
  if [ -z "$jsonl" ]; then
    log "no gated non-CoS leads in the fleet — nothing to do"
    return 0
  fi
  local line project lead core backend af
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    backend=$(printf '%s' "$line" | jq -r '.backend')
    # Codex leads gate via runtime env (FLYWHEEL_LEAD_CORE_MENTION_GATED), NOT
    # access.json — skip them here.
    [ "$backend" = "codex-app-server" ] && continue
    project=$(printf '%s' "$line" | jq -r '.projectName')
    lead=$(printf '%s' "$line" | jq -r '.leadId')
    core=$(printf '%s' "$line" | jq -r '.coreChannelId')
    if [ -n "$PROJECT_FILTER" ] && [ "$project" != "$PROJECT_FILTER" ]; then
      continue
    fi
    af="${CHANNELS_DIR}/discord-${lead}/access.json"
    log "apply ${project}/${lead} core=${core}"
    apply_one "$af" "$core" || rc=1
  done <<< "$jsonl"
  return $rc
}

# ── FLY-944 fleet mode: retire allowFrom on shared groups, role-aware ───────
# Non-CoS core → the MAIN transform (--id-only semantics: flip + patterns +
# clear in ONE atomic patch). CoS core & roundtable → --allowfrom-only.
# Never clears a non-CoS core's allowFrom without flipping requireMention.
run_all_shared() {
  if [ ! -f "$GATE_CLI" ]; then
    log "ERROR: decision CLI not built ($GATE_CLI) — run: pnpm -F flywheel-teamlead build"
    return 1
  fi
  local jsonl rt rc=0
  jsonl="$(node "$GATE_CLI" --all-leads 2>/dev/null)" || {
    log "ERROR: core-room-gate-cli --all-leads failed"; return 1
  }
  rt="$(resolve_roundtable_id || true)"
  local line backend lead core is_cos gate af
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    backend=$(printf '%s' "$line" | jq -r '.backend')
    # Codex leads gate via runtime env, not access.json — skip (mirror run_all).
    [ "$backend" = "codex-app-server" ] && continue
    lead=$(printf '%s' "$line" | jq -r '.leadId')
    core=$(printf '%s' "$line" | jq -r '.coreChannelId // empty')
    is_cos=$(printf '%s' "$line" | jq -r '.isCoS')
    gate=$(printf '%s' "$line" | jq -r '.gateNonCoS')
    af="${CHANNELS_DIR}/discord-${lead}/access.json"
    [ -f "$af" ] || continue
    if [ -n "$core" ]; then
      if [ "$gate" = "true" ]; then
        # non-CoS core: main transform ONLY (flip + patterns + clear together).
        log "all-shared ${lead}: non-CoS core ${core} → main transform (id-only)"
        ID_ONLY=1 ALLOWFROM_ONLY=0 apply_one "$af" "$core" || rc=1
      elif [ "$is_cos" = "true" ]; then
        log "all-shared ${lead}: CoS core ${core} → allowfrom-only"
        ALLOWFROM_ONLY=1 apply_one "$af" "$core" || rc=1
      fi
      # core-no-CoS project (joycon): gateNonCoS=false & isCoS=false → core untouched.
    fi
    if [ -n "$rt" ]; then
      log "all-shared ${lead}: roundtable ${rt} → allowfrom-only"
      ALLOWFROM_ONLY=1 apply_one "$af" "$rt" || rc=1
    fi
  done <<< "$jsonl"
  return $rc
}

if [ "$ALL_SHARED" -eq 1 ]; then
  run_all_shared
  exit $?
fi

if [ "$ALL" -eq 1 ]; then
  run_all
  exit $?
fi

if [ -z "$ACCESS_FILE" ] || [ -z "$CHANNEL_ID" ]; then
  log "ERROR: single mode requires --access-file and --channel-id (or use --all)"
  usage; exit 2
fi
apply_one "$ACCESS_FILE" "$CHANNEL_ID"
exit $?
