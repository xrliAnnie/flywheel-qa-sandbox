#!/bin/bash
# FLY-574 — close a companion lead's #leads-roundtable allowlist gap.
#
# WHY: the Discord plugin's gate() drops any sender that is not in a group's
# `allowFrom` whitelist BEFORE the mention check, whenever that whitelist is
# non-empty (server.ts ~line 675) — and this applies to bot senders too: being in
# `allowBots` only gets a bot past the messageCreate intake filter, the per-group
# `allowFrom` still gates the reply. Belle's #leads-roundtable group
# (requireMention:true) has a non-empty allowFrom that was missing Flywheel's own
# Leads (Tadashi, Cass), so their top-level @ never reached Belle.
#
# WHAT: add one or more sender ids to ONE EXISTING group's `allowFrom` in an
# access.json. Atomic (temp + rename), backed up first, idempotent (never
# duplicates), fail-closed (missing file / absent group / invalid JSON → non-zero,
# no mutation), and it touches no other field. Refuses to CREATE a group — that
# would silently subscribe the lead to a new channel, which is out of scope.
#
# Usage:
#   add-roundtable-allowfrom.sh \
#     --access-file <path> --channel-id <id> \
#     --add <id|csv> [--add <id|csv> ...] [--dry-run]
#
# Reusable for any lead/group, not just Belle.

set -euo pipefail

usage() {
  cat >&2 <<USAGE
Usage: add-roundtable-allowfrom.sh --access-file <path> --channel-id <id> --add <id|csv> [--add ...] [--dry-run]
Adds sender ids to ONE existing group's allowFrom (atomic, backed up, idempotent, fail-closed).
USAGE
}

ACCESS_FILE=""
CHANNEL_ID=""
DRY_RUN=0
ADDS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --access-file) ACCESS_FILE="${2:-}"; shift 2 ;;
    --channel-id)  CHANNEL_ID="${2:-}"; shift 2 ;;
    --add)         ADDS+=("${2:-}"); shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "[add-roundtable-allowfrom] ERROR: unknown arg '$1'" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$ACCESS_FILE" ] || [ -z "$CHANNEL_ID" ] || [ "${#ADDS[@]}" -eq 0 ]; then
  echo "[add-roundtable-allowfrom] ERROR: --access-file, --channel-id and at least one --add are required" >&2
  usage; exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "[add-roundtable-allowfrom] ERROR: jq is required but not found" >&2
  exit 2
fi

# ── Validate the access file (fail-closed) ──────────────────────────────────
if [ ! -f "$ACCESS_FILE" ]; then
  echo "[add-roundtable-allowfrom] ERROR: access file not found: $ACCESS_FILE" >&2
  exit 1
fi
if ! jq -e . "$ACCESS_FILE" >/dev/null 2>&1; then
  echo "[add-roundtable-allowfrom] ERROR: not valid JSON: $ACCESS_FILE" >&2
  exit 1
fi
if ! jq -e --arg ch "$CHANNEL_ID" '.groups | has($ch)' "$ACCESS_FILE" >/dev/null 2>&1; then
  echo "[add-roundtable-allowfrom] ERROR: group '$CHANNEL_ID' not present in $ACCESS_FILE — refusing to create it (out of scope)" >&2
  exit 1
fi

# ── Flatten the requested ids (split csv, drop blanks, de-dupe input) ────────
REQ_IDS=()
for raw in "${ADDS[@]}"; do
  IFS=',' read -ra parts <<< "$raw"
  for p in "${parts[@]}"; do
    p="${p//[[:space:]]/}"
    [ -n "$p" ] && REQ_IDS+=("$p")
  done
done

# Build a JSON array of the requested ids for jq.
IDS_JSON=$(printf '%s\n' "${REQ_IDS[@]}" | jq -R . | jq -s .)

# ── Report which are genuinely new (for the human summary) ──────────────────
NEW_IDS=()
for id in "${REQ_IDS[@]}"; do
  if ! jq -e --arg ch "$CHANNEL_ID" --arg id "$id" \
      '(.groups[$ch].allowFrom // []) | index($id) != null' "$ACCESS_FILE" >/dev/null 2>&1; then
    # not present yet → new (guard against dup within NEW_IDS)
    case " ${NEW_IDS[*]:-} " in *" $id "*) : ;; *) NEW_IDS+=("$id") ;; esac
  fi
done

if [ "${#NEW_IDS[@]}" -eq 0 ]; then
  echo "[add-roundtable-allowfrom] all ${#REQ_IDS[@]} id(s) already in group '$CHANNEL_ID' allowFrom — nothing to do (idempotent no-op)"
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[add-roundtable-allowfrom] DRY-RUN — would add to group '$CHANNEL_ID' allowFrom: ${NEW_IDS[*]}"
  echo "[add-roundtable-allowfrom] DRY-RUN — file NOT modified: $ACCESS_FILE"
  exit 0
fi

# ── Atomic edit with optimistic-concurrency guard ───────────────────────────
# The Discord plugin ALSO writes this access.json (temp+rename, e.g. DM-pairing
# prune). A naive read-modify-rename here could clobber a concurrent plugin write
# with our stale snapshot, silently dropping the plugin's change (FLY-574 Codex
# review HIGH). We cannot lock the non-cooperating plugin (it takes no lock), so
# we use optimistic concurrency: transform the CURRENT content and only swap it in
# if the file did not change between our read and the swap; otherwise re-base on
# the fresh content and retry. This collapses the common case (a plugin write
# during our transform → we re-base, no clobber).
#
# RESIDUAL (accepted, documented): a write landing in the sub-millisecond window
# between the final re-check and the rename syscall itself still cannot be
# prevented — that is a fundamental TOCTOU for two writers that rename onto the
# same path without a shared lock, and is unclosable from this side alone (closing
# it would require the plugin fork to also take a cooperative lock — out of scope
# for FLY-574 scope A; tracked for the follow-up). It is bounded by: this is a
# ONE-TIME, operator-coordinated maintenance edit (not a runtime hot path); the
# plugin writes access.json only on rare DM-pairing prune events; and a timestamped
# backup is always taken first, so any clobber is trivially recoverable.
#
# `cksum` (not `shasum`) is the change detector: it is a locale-independent C
# utility, whereas `shasum` (Perl) panics under this machine's default
# `LANG=C.UTF-8` (FLY-574 Codex review MEDIUM).
hash_file() { cksum "$1" 2>/dev/null | awk '{print $1"-"$2}'; }

swapped=0
BACKUP=""
for _attempt in 1 2 3 4 5; do
  pre="$(hash_file "$ACCESS_FILE")"
  TMP="${ACCESS_FILE}.tmp.$$"
  if ! jq --arg ch "$CHANNEL_ID" --argjson ids "$IDS_JSON" '
      .groups[$ch].allowFrom = (
        reduce $ids[] as $id ((.groups[$ch].allowFrom // []);
          if index($id) then . else . + [$id] end)
      )
    ' "$ACCESS_FILE" > "$TMP" 2>/dev/null; then
    rm -f "$TMP"; sleep 0.2; continue
  fi

  # The edited file must still be valid JSON before we swap it in.
  if ! jq -e . "$TMP" >/dev/null 2>&1; then
    echo "[add-roundtable-allowfrom] ERROR: edit produced invalid JSON — aborting, original untouched" >&2
    rm -f "$TMP"
    exit 1
  fi

  # Back up the exact content we are about to replace.
  BACKUP="${ACCESS_FILE}.bak.$(date +%s).$$"
  cp -p "$ACCESS_FILE" "$BACKUP"

  # Re-base check IMMEDIATELY before the swap: if the file changed since we read
  # it, a concurrent writer (the plugin) won — discard our stale transform + this
  # backup and retry on the fresh content. Nothing runs between this check and the
  # rename, so the residual clobber window is the rename syscall only.
  if [ "$(hash_file "$ACCESS_FILE")" != "$pre" ]; then
    rm -f "$TMP" "$BACKUP"; BACKUP=""; sleep 0.2; continue
  fi
  mv "$TMP" "$ACCESS_FILE"
  swapped=1
  break
done

if [ "$swapped" -ne 1 ]; then
  echo "[add-roundtable-allowfrom] ERROR: access.json kept changing under a concurrent writer — not applied, original untouched" >&2
  exit 1
fi

echo "[add-roundtable-allowfrom] group '$CHANNEL_ID' allowFrom += [${NEW_IDS[*]}] (backup: $BACKUP)"
exit 0
