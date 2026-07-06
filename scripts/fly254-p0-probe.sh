#!/bin/bash
# FLY-254 P0 probe — verify CLI `cmux select-workspace` force-renders an
# unrendered (restored, never-clicked) workspace surface, same as a human click.
#
# RUN WINDOW: immediately after Annie quits+reopens cmux, BEFORE she clicks any
# tab (founder-approved, ~10s, exactly two focus changes: target + restore).
#
# Actions: read-only (list-workspaces / read-screen) plus exactly TWO
# `select-workspace` calls (target, then restore — the restore is also armed
# as an EXIT/INT/TERM trap so Annie's tab is recovered even on early failure).
# NO send / close / new / rename.
#
# Usage: bash scripts/fly254-p0-probe.sh [target-workspace-ref]
#   With no arg, auto-picks the first NON-selected workspace whose read-screen
#   fails with the UNRENDERED diagnostic ("Terminal surface not found") — a
#   generic IPC failure is NOT accepted as the precondition (Codex CR R1 M7:
#   transient failure followed by success must not false-PASS the render
#   hypothesis).
set -uo pipefail

SOCKET="${CMUX_SOCKET_PATH:-/tmp/cmux.sock}"
OUT="/tmp/fly254-p0-probe-evidence-$(date +%Y%m%d-%H%M%S).log"
UNRENDERED_RE="Terminal surface not found"
log() { echo "[p0 $(date '+%H:%M:%S')] $*" | tee -a "$OUT"; }

cx() { cmux --socket "$SOCKET" "$@"; }

is_ws_ref() { printf '%s' "$1" | grep -qE '^workspace:[0-9]+$'; }

ORIG=""
RESTORED=0
restore_focus() {
  # One-shot, idempotent — armed as a trap before the first focus mutation so
  # ANY exit path (failure, signal) puts Annie back on her tab (Codex CR R1 M7).
  [[ "$RESTORED" == "1" || -z "$ORIG" ]] && return 0
  RESTORED=1
  if cx select-workspace --workspace "$ORIG" >>"$OUT" 2>&1; then
    log "focus restored to $ORIG"
  else
    log "WARN: focus restore failed — tell Annie her tab may have moved"
  fi
}

fail() { log "RESULT: FAIL — $*"; log "Evidence: $OUT"; restore_focus; exit 1; }

[[ -S "$SOCKET" ]] || fail "cmux socket missing at $SOCKET (is cmux open?)"
cx ping 2>&1 | grep -q PONG || fail "cmux ping failed"

# 1. Snapshot workspaces + original selected ref (require exactly one, legal).
WS_JSON=$(cx --json list-workspaces 2>>"$OUT") || fail "list-workspaces failed"
ORIG=$(printf '%s' "$WS_JSON" | python3 -c '
import sys, json
sel = [w["ref"] for w in json.load(sys.stdin).get("workspaces", [])
       if w.get("selected") and w.get("ref")]
print(sel[0] if len(sel) == 1 else "")')
[[ -n "$ORIG" ]] || fail "no unique selected workspace (got 0 or >1) — fail-closed, not probing"
is_ws_ref "$ORIG" || fail "selected ref '$ORIG' is not a legal workspace ref — fail-closed"
log "original selected: $ORIG"

# 2. Pick target: arg, or first non-selected workspace whose read-screen fails
#    with the UNRENDERED diagnostic specifically.
TARGET="${1:-}"
TARGET_TITLE="manual arg"
if [[ -n "$TARGET" ]]; then
  is_ws_ref "$TARGET" || fail "target ref '$TARGET' is not a legal workspace ref"
else
  while read -r ref title; do
    [[ -z "$ref" || "$ref" == "$ORIG" ]] && continue
    is_ws_ref "$ref" || continue
    pick_err=$(cx read-screen --workspace "$ref" 2>&1 >/dev/null) && continue
    if printf '%s' "$pick_err" | grep -q "$UNRENDERED_RE"; then
      TARGET="$ref"; TARGET_TITLE="$title"; break
    fi
  done < <(printf '%s' "$WS_JSON" | python3 -c '
import sys, json
for w in json.load(sys.stdin).get("workspaces", []):
    if w.get("ref"):
        print(w["ref"], w.get("title") or "~")')
fi
[[ -n "$TARGET" ]] || fail "no unrendered workspace found (no '$UNRENDERED_RE' on read-screen) — rerun right after a fresh reopen, before clicking tabs"
log "target: $TARGET ($TARGET_TITLE)"

# 3. Precondition evidence: read-screen fails with the UNRENDERED diagnostic.
#    A generic failure (IPC blip, auth) is NOT the state under test → FAIL,
#    never a false PASS on the core hypothesis (Codex CR R1 M7).
PRE_ERR=$(cx read-screen --workspace "$TARGET" 2>&1 >/dev/null) \
  && fail "precondition broken: target read-screen already succeeds (surface rendered) — pick another target"
printf '%s' "$PRE_ERR" | grep -q "$UNRENDERED_RE" \
  || fail "precondition broken: read-screen failed but NOT with '$UNRENDERED_RE' (got: $(printf '%s' "$PRE_ERR" | head -1)) — not the unrendered state"
log "precondition OK: $(printf '%s' "$PRE_ERR" | head -1)"

# 4. THE TEST: CLI select-workspace, then bounded wait for readability.
#    Arm the traps BEFORE the first focus mutation. EXIT does the idempotent
#    restore; INT/TERM must TERMINATE (Codex CR R2 M2: a bare
#    `trap restore_focus INT` restores and then CONTINUES the script in bash
#    3.2 — the probe would keep polling and could still report PASS/FAIL
#    after the operator interrupted it). `exit` re-triggers the EXIT trap.
trap restore_focus EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cx select-workspace --workspace "$TARGET" >>"$OUT" 2>&1 || fail "select-workspace returned non-zero"
log "select-workspace issued; polling read-screen (<=10 x 0.5s)..."
PASS=0
for i in $(seq 1 10); do
  sleep 0.5
  if SCREEN=$(cx read-screen --workspace "$TARGET" 2>>"$OUT"); then
    PASS=1
    log "read-screen succeeded after ~$(python3 -c "print($i*0.5)")s; last lines:"
    printf '%s\n' "$SCREEN" | tail -3 | tee -a "$OUT"
    break
  fi
done

# 5. Restore Annie's original tab (explicit; the trap remains as backstop).
restore_focus

if [[ "$PASS" == "1" ]]; then
  log "RESULT: PASS — CLI select-workspace force-rendered the surface (read-screen '$UNRENDERED_RE' -> success on same ref)"
  log "Evidence: $OUT"
  exit 0
else
  fail "surface did not become readable within 5s after select-workspace"
fi
