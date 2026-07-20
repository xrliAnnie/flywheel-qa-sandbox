#!/bin/bash
set -uo pipefail
# FLY-1389 P1-e: THE managed entrance for registering a LOCAL directory
# plugin marketplace with Claude Code.
#
# Usage: register-local-marketplace.sh <name> <source-dir>
#
# Why: `claude plugin marketplace add <dir>` records the given directory's
# path into the GLOBAL ~/.claude/plugins/known_marketplaces.json
# (.source.path + .installLocation). Register a worktree path once and the
# global config keeps referencing it after the worktree is cleaned
# (matt-skills incident, 2026-07-20). This wrapper first copies the content
# to a STABLE location (~/.flywheel/marketplaces/<name>) and registers THAT.
#
# Rules (doc/engineer/implementation/global-bin-symlink-discipline.md):
# local directory marketplaces are registered ONLY through this entrance —
# never hand the calling directory to `claude plugin marketplace add`.
#
# Transaction (rollback-safe promote — NOT plain `mv staging dest`, which
# NESTS staging inside an existing dest instead of replacing it):
#   1) copy source → same-parent .staging-<name>.<pid>, verify completeness
#   2) dest exists → mv dest → backup
#   3) mv staging → dest (dest absent now → rename)
#   4) success → remove backup; a step-3 failure restores backup → dest
# Any failure leaves dest as a COMPLETE old tree or COMPLETE new tree.
# Rerun = replace (idempotent).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/path-hygiene.sh
source "${SCRIPT_DIR}/lib/path-hygiene.sh"

NAME="${1:-}"
SRC="${2:-}"
if [ -z "$NAME" ] || [ -z "$SRC" ]; then
  echo "Usage: register-local-marketplace.sh <name> <source-dir>" >&2
  exit 2
fi

# Test-only deterministic failure injection (hermetic suite drives the
# transaction's failure legs; never set in production).
_rlm_injected_fail() { [ "${FLYWHEEL_RLM_FAIL_AT:-}" = "$1" ]; }

CLAUDE_BIN="${FLYWHEEL_MARKETPLACE_CLAUDE_BIN:-claude}"

# ── validation ──────────────────────────────────────────────────────────────
if ! printf '%s' "$NAME" | grep -qE '^[a-z0-9][a-z0-9-]{0,63}$'; then
  echo "ERROR: marketplace name '$NAME' invalid — must match [a-z0-9][a-z0-9-]{0,63} (no traversal, no slashes)" >&2
  exit 1
fi
if [ ! -d "$SRC" ]; then
  echo "ERROR: source dir does not exist: $SRC" >&2
  exit 1
fi
SRC_CANON="$(cd "$SRC" && pwd -P)" || { echo "ERROR: cannot resolve source dir: $SRC" >&2; exit 1; }

DEST_ROOT="${HOME}/.flywheel/marketplaces"
DEST="${DEST_ROOT}/${NAME}"
mkdir -p "$DEST_ROOT"
DEST_ROOT_CANON="$(cd "$DEST_ROOT" && pwd -P)" || exit 1

# Symlink destinations first (clearest refusal), then containment: the
# canonical destination must live under the canonical root (belt-and-
# suspenders behind the name grammar — canonicalization also catches a
# symlink that escaped the root).
if [ -L "$DEST" ]; then
  echo "ERROR: destination exists and is a symlink — refusing (no symlink escape): $DEST" >&2
  exit 1
fi
DEST_CANON="$(path_hygiene_canonicalize "$DEST")" || { echo "ERROR: cannot resolve destination" >&2; exit 1; }
case "$DEST_CANON" in
  "$DEST_ROOT_CANON"/*) : ;;
  *) echo "ERROR: destination escapes ${DEST_ROOT_CANON}: $DEST_CANON" >&2; exit 1 ;;
esac
if [ "$SRC_CANON" = "$DEST_CANON" ]; then
  echo "ERROR: source IS the stable destination — nothing to do" >&2
  exit 1
fi

# ── transaction guard: per-name lock + crash/signal recovery ────────────────
# Codex code R1 MED-2: without a lock, two concurrent registrations of the
# same name interleave backup/promote and can nest or lose the destination;
# without a signal net, a SIGTERM between backup and promote leaves DEST
# absent. The EXIT trap is the single recovery point — every failure path
# below just exits and the trap restores the terminal invariant (destination
# = COMPLETE old tree or COMPLETE new tree).
STAGING="${DEST_ROOT}/.staging-${NAME}.$$"
BACKUP="${DEST_ROOT}/.backup-${NAME}.$$"
LOCK_DIR="${DEST_ROOT}/.lock-${NAME}"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "ERROR: another registration for '${NAME}' is in progress (lock: ${LOCK_DIR}; remove it only if no other run is alive)" >&2
  exit 1
fi
# Recovery is INVARIANT-driven, not state-variable-driven (Codex code R2
# MED: a TERM landing between the backup `mv` and a state assignment would
# make any state machine lie about how far the transaction got — the
# filesystem itself is the only truthful record). On EVERY exit: if the
# destination is gone and our backup exists, restore it; always discard
# staging; always release the lock. A failed restore is FAIL-LOUD (rc
# forced non-zero + explicit manual-recovery pointer) — never silently
# release the lock claiming recovery.
txn_cleanup() {
  rc=$?
  if [ ! -e "$DEST" ] && [ -e "$BACKUP" ]; then
    if ! mv "$BACKUP" "$DEST"; then
      echo "ERROR: FAILED to restore ${BACKUP} -> ${DEST}; the destination is MISSING — restore manually: mv ${BACKUP} ${DEST}" >&2
      [ "$rc" -ne 0 ] || rc=1
    fi
  fi
  rm -rf "$STAGING"
  rmdir "$LOCK_DIR" 2>/dev/null || true
  exit "$rc"
}
trap txn_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ── 1) staged copy + verification ───────────────────────────────────────────
mkdir -p "$STAGING"
if ! cp -R "${SRC_CANON}/." "$STAGING/" || _rlm_injected_fail stage; then
  echo "ERROR: staged copy failed — destination untouched" >&2
  exit 1
fi
if ! diff -r "$SRC_CANON" "$STAGING" >/dev/null 2>&1; then
  echo "ERROR: staged copy verification failed (partial copy?) — destination untouched" >&2
  exit 1
fi
# Codex code R1 MED-3: a symlink inside the content that points OUTSIDE the
# staged tree survives cp -R as a symlink — the "stable" copy would still
# break when the original checkout is cleaned. Refuse escaping symlinks.
STAGING_CANON="$(cd "$STAGING" && pwd -P)"
while IFS= read -r lnk; do
  [ -n "$lnk" ] || continue
  lt="$(readlink "$lnk")"
  case "$lt" in
    /*) : ;;
    *) lt="$(dirname "$lnk")/$lt" ;;
  esac
  if ! lt_canon="$(path_hygiene_canonicalize "$lt")"; then
    echo "ERROR: content symlink with unresolvable target: $lnk -> $(readlink "$lnk") — refusing" >&2
    exit 1
  fi
  case "$lt_canon" in
    "$STAGING_CANON"/*|"$STAGING_CANON") : ;;
    *)
      echo "ERROR: content symlink escapes the marketplace tree: $lnk -> $lt_canon — a stable copy would still break when the source checkout is cleaned. Vendor the real file instead." >&2
      exit 1
      ;;
  esac
done < <(find "$STAGING" -type l 2>/dev/null)

# ── 2) backup existing dest ─────────────────────────────────────────────────
if [ -e "$DEST" ]; then
  if ! mv "$DEST" "$BACKUP"; then
    echo "ERROR: could not move existing destination aside — destination untouched" >&2
    exit 1
  fi
fi
if _rlm_injected_fail after-backup; then
  echo "ERROR: injected failure after backup — old tree will be restored" >&2
  exit 1
fi

# ── 3) promote (dest is absent now → mv is a rename, atomic) ───────────────
if _rlm_injected_fail promote || ! mv "$STAGING" "$DEST"; then
  echo "ERROR: promote failed — old tree restored, staging discarded" >&2
  exit 1
fi

# ── 4) drop backup (failure here still leaves a COMPLETE new tree) ─────────
if [ -e "$BACKUP" ]; then
  if _rlm_injected_fail cleanup || ! rm -rf "$BACKUP"; then
    echo "WARNING: backup cleanup failed — new tree is live; remove ${BACKUP} manually" >&2
  fi
fi

# ── register the STABLE path with Claude Code ───────────────────────────────
if "$CLAUDE_BIN" plugin marketplace add "$DEST"; then
  echo "registered marketplace '${NAME}' at stable path ${DEST}"
else
  # Idempotent rerun: already registered at the same stable path is success.
  # BOTH persisted fields must match (Codex code R1 MED-4: `or` would call a
  # half-stale registration — one field still pointing at a worktree —
  # success; the hygiene scanner treats each field independently).
  MP_FILE="${HOME}/.claude/plugins/known_marketplaces.json"
  if [ -f "$MP_FILE" ] && jq -e --arg n "$NAME" --arg p "$DEST" \
      '.[$n]? | (((.source? | objects | .path) == $p) and (.installLocation == $p))' \
      "$MP_FILE" >/dev/null 2>&1; then
    echo "marketplace '${NAME}' already registered at the stable path — content replaced, registration kept"
  else
    echo "ERROR: '${CLAUDE_BIN} plugin marketplace add ${DEST}' failed and no fully-stable registration exists (check .source.path AND .installLocation)" >&2
    exit 1
  fi
fi
