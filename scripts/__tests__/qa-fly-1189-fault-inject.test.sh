#!/usr/bin/env bash
# FLY-1189 H2: hermetic tests for the fault injector's S1 SAFETY LOCK.
# The whole point of this suite is to prove the injector CANNOT touch a
# production runner: every anchor-rejection path must exit non-zero WITHOUT
# performing any action (the action sink stays empty). 19 production runners
# are live on this machine — a mis-fired SIGSTOP/mv is unrecoverable.
#
# Hermetic seams (never touch a real slot / real process):
#   QA1189_DESCRIBE_OVERRIDE  — a file with per-execId descriptor JSON fixtures
#                               (bypasses real tmux/ps/lsof/sqlite resolution)
#   QA1189_ACTION_SINK        — when set, freeze/thaw/mv are RECORDED to this
#                               file instead of executed (real machine: unset)
#   QA1189_SLOT_DIR / QA1189_MANIFEST / QA1189_JOURNAL / QA1189_QUARANTINE_ROOT
#
#   P*  pure anchor validators (path boundary, prod denylist, descendant count)
#   R*  rejection matrix — every case: exit 2 + ZERO actions in the sink
#   A*  accept path — valid target → action recorded (+ journal entry)
#   T*  TOCTOU — start-time/inode drift between check and act → refuse
#   D*  restore direction lock
#   J*  journal invariant (all-in-safe-root) + prod-snapshot shape
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INJ="${SCRIPT_DIR}/qa-fly-1189-fault-inject.sh"

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

[[ -x "$INJ" || -f "$INJ" ]] || { echo "FATAL: ${INJ} missing — implement it first" >&2; exit 1; }

# Pin the sandbox under /tmp (where real slot dirs live), NOT $TMPDIR: some
# runners set TMPDIR under ~/.flywheel, which the injector's production
# denylist correctly refuses — a test sandbox there would false-fail every
# "good path" case. Real slots are always /tmp/flywheel-test-slot-N.
TMP="$(mktemp -d "/tmp/qa1189inj.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# Source the injector's pure lib functions for P*/D* unit tests (the file must
# be safe to source: real work only runs under `main "$@"` when executed).
# shellcheck source=/dev/null
QA1189_LIB_ONLY=1 source "$INJ"
for fn in qa1189_path_anchor_ok qa1189_validate_target qa1189_journal_append \
  qa1189_journal_verify_unchanged qa1189_restore_direction_ok; do
  type "$fn" >/dev/null 2>&1 || { echo "FATAL: ${fn} not defined in ${INJ}" >&2; exit 1; }
done

# ── A slot sandbox root + a fake manifest (execIds allowed to be touched) ──
SLOT_DIR="${TMP}/flywheel-test-slot-2"
QUAR="${SLOT_DIR}/qa-moved-worktrees"
mkdir -p "$SLOT_DIR" "$QUAR"
MANIFEST="${TMP}/manifest.json"
jq -n '{campaignId:"c1", ownerSlot:2, injectionTargets:["exec-good","exec-freeze","exec-break","exec-toctou","exec-restore"]}' > "$MANIFEST"
JOURNAL="${TMP}/journal.jsonl"

# ── P1: path anchor — under slot prefix accepted ──
P_OK=1
qa1189_path_anchor_ok "${SLOT_DIR}/project-slot-2-FLY-9/wt" "$SLOT_DIR" || { P_OK=0; fail "P1: legit slot path should pass"; }
# prefix collision: slot-2-evil must NOT match slot-2
if qa1189_path_anchor_ok "${TMP}/flywheel-test-slot-2-evil/wt" "$SLOT_DIR"; then P_OK=0; fail "P1: prefix-collision (slot-2-evil) must be rejected"; fi
# outside prefix
if qa1189_path_anchor_ok "/etc/passwd" "$SLOT_DIR"; then P_OK=0; fail "P1: outside-prefix path must be rejected"; fi
[[ "$P_OK" == "1" ]] && pass "P1: path anchor — component-boundary prefix match"

# ── P2: production denylist (defense-in-depth) ──
P2_OK=1
for prod in "${HOME}/Dev/flywheel/x" "${HOME}/Dev/flywheel-FLY-1048-pr-c/wt" "${HOME}/.flywheel/comm/y"; do
  # Even if someone passed a prod path as the "slot prefix", the prod denylist refuses.
  if qa1189_path_anchor_ok "$prod" "$prod"; then P2_OK=0; fail "P2: production path ${prod} must be denied"; fi
done
[[ "$P2_OK" == "1" ]] && pass "P2: production prefix denylist"

# ── Descriptor fixture helper: writes a per-execId JSON file the injector reads
# via QA1189_DESCRIBE_OVERRIDE. Fields mirror the real resolver output. ──
DESC_DIR="${TMP}/descriptors"
mkdir -p "$DESC_DIR"
write_desc() { # execId json
  printf '%s' "$2" > "${DESC_DIR}/$1.json"
}
mk_desc() { # execId pid startTime cwd worktree inode sessionName sessionPresent claudeDescendants [paneId] [command]
  # paneId + command default to non-empty (mirroring the real resolver, which
  # always populates them from tmux/ps); tests that exercise the missing-tuple
  # path pass "" explicitly.
  local pane="${10-%1}" cmd="${11-claude --resume}"
  jq -n --arg e "$1" --argjson pid "$2" --arg st "$3" --arg cwd "$4" --arg wt "$5" \
    --arg ino "$6" --arg sn "$7" --argjson sp "$8" --argjson cd "$9" \
    --arg pane "$pane" --arg cmd "$cmd" \
    '{execId:$e, pid:$pid, startTime:$st, cwd:$cwd, worktree:$wt, inode:$ino, sessionName:$sn, paneId:$pane, command:$cmd, sessionPresent:($sp==1), claudeDescendants:$cd}'
}

GOOD_WT="${SLOT_DIR}/project-slot-2-FLY-9/wt"
mkdir -p "$GOOD_WT"
write_desc exec-good "$(mk_desc exec-good 4242 st-good "$GOOD_WT" "$GOOD_WT" 111 runner-test-slot-2 1 1)"

run_inj() { # runs the injector as a subprocess with the hermetic seams
  QA1189_DESCRIBE_OVERRIDE="$DESC_DIR" \
  QA1189_SLOT_DIR="$SLOT_DIR" \
  QA1189_MANIFEST="$MANIFEST" \
  QA1189_JOURNAL="$JOURNAL" \
  QA1189_QUARANTINE_ROOT="$QUAR" \
  QA1189_SESSION_PREFIX="runner-test-slot-" \
  QA1189_ACTION_SINK="$ACTION_SINK" \
    bash "$INJ" "$@"
}

# ── R-matrix: each rejection must (a) exit non-zero, (b) leave the action sink
#    EMPTY (nothing executed). ──
reject_case() { # name execId subcmd descJson
  local name="$1" execId="$2" subcmd="$3" desc="$4"
  ACTION_SINK="${TMP}/sink-${execId}-${subcmd}.txt"
  : > "$ACTION_SINK"
  write_desc "$execId" "$desc"
  local rc=0
  run_inj "$subcmd" "$execId" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    fail "${name}: expected non-zero exit, got 0"
    return
  fi
  if [[ -s "$ACTION_SINK" ]]; then
    fail "${name}: an action was performed on rejection! sink=$(cat "$ACTION_SINK")"
    return
  fi
  pass "${name}: rejected (exit ${rc}) with ZERO actions"
}

# R1: execId not in manifest
reject_case "R1 execId-not-in-manifest" "exec-rogue" freeze \
  "$(mk_desc exec-rogue 5000 st1 "$GOOD_WT" "$GOOD_WT" 111 runner-test-slot-2 1 1)"
# R2: session not present in slot Bridge DB
reject_case "R2 session-absent" "exec-good" freeze \
  "$(mk_desc exec-good 5001 st1 "$GOOD_WT" "$GOOD_WT" 111 runner-test-slot-2 0 1)"
# R3: no resolvable tmux target (empty sessionName = no CommDB tmux_window). The
# slot-namespace guarantee comes from the PATH anchor (a prod runner's cwd is
# under ~/Dev/flywheel* → denied); the tmux anchor requires a resolvable target.
reject_case "R3 no-tmux-target" "exec-good" freeze \
  "$(mk_desc exec-good 5002 st1 "$GOOD_WT" "$GOOD_WT" 111 "" 1 1)"

# R3b: tmux SESSION not in the configured namespace allowlist → rejected.
ACTION_SINK="${TMP}/sink-r3b.txt"; : > "$ACTION_SINK"
write_desc exec-good "$(mk_desc exec-good 5099 st1 "$GOOD_WT" "$GOOD_WT" 111 "flywheel:@9" 1 1)"
rc=0
QA1189_TMUX_SESSION_ALLOW="runner-test-slot-2" \
  QA1189_DESCRIBE_OVERRIDE="$DESC_DIR" QA1189_SLOT_DIR="$SLOT_DIR" QA1189_MANIFEST="$MANIFEST" \
  QA1189_JOURNAL="$JOURNAL" QA1189_QUARANTINE_ROOT="$QUAR" QA1189_ACTION_SINK="$ACTION_SINK" \
  bash "$INJ" freeze exec-good >/dev/null 2>&1 || rc=$?
if [[ "$rc" -ne 0 && ! -s "$ACTION_SINK" ]]; then
  pass "R3b: tmux session outside allowlist rejected, zero actions"
else
  fail "R3b: non-allowlisted tmux session not caught (rc=$rc)"
fi
# and an ALLOWLISTED session passes the tmux anchor (freeze recorded).
ACTION_SINK="${TMP}/sink-r3b-ok.txt"; : > "$ACTION_SINK"
write_desc exec-good "$(mk_desc exec-good 5100 st1 "$GOOD_WT" "$GOOD_WT" 111 "runner-test-slot-2:@1" 1 1)"
rc=0
QA1189_TMUX_SESSION_ALLOW="runner-test-slot-2" \
  QA1189_DESCRIBE_OVERRIDE="$DESC_DIR" QA1189_SLOT_DIR="$SLOT_DIR" QA1189_MANIFEST="$MANIFEST" \
  QA1189_JOURNAL="$JOURNAL" QA1189_QUARANTINE_ROOT="$QUAR" QA1189_ACTION_SINK="$ACTION_SINK" \
  bash "$INJ" freeze exec-good >/dev/null 2>&1 || rc=$?
grep -q "STOP" "$ACTION_SINK" 2>/dev/null && [[ "$rc" -eq 0 ]] \
  && pass "R3b: allowlisted tmux session passes the namespace anchor" \
  || fail "R3b: allowlisted session should pass (rc=$rc)"
# restore the good descriptor for later tests
write_desc exec-good "$(mk_desc exec-good 4242 st-good "$GOOD_WT" "$GOOD_WT" 111 runner-test-slot-2 1 1)"
# R4a: zero claude descendants
reject_case "R4a zero-descendants" "exec-good" freeze \
  "$(mk_desc exec-good 5003 st1 "$GOOD_WT" "$GOOD_WT" 111 runner-test-slot-2 1 0)"
# R4b: multiple claude descendants
reject_case "R4b multi-descendants" "exec-good" freeze \
  "$(mk_desc exec-good 5004 st1 "$GOOD_WT" "$GOOD_WT" 111 runner-test-slot-2 1 2)"
# R5: cwd hits production prefix
reject_case "R5 prod-cwd" "exec-good" freeze \
  "$(mk_desc exec-good 5005 st1 "${HOME}/Dev/flywheel/wt" "${HOME}/Dev/flywheel/wt" 111 runner-test-slot-2 1 1)"
# R6: prefix-collision worktree (slot-2-evil)
reject_case "R6 prefix-collision" "exec-break" break-worktree \
  "$(mk_desc exec-break 5006 st1 "${TMP}/flywheel-test-slot-2-evil/wt" "${TMP}/flywheel-test-slot-2-evil/wt" 111 runner-test-slot-2 1 1)"
# R7: empty PID (target vanished before we even resolved)
reject_case "R7 empty-pid" "exec-good" freeze \
  "$(mk_desc exec-good 0 st1 "$GOOD_WT" "$GOOD_WT" 111 runner-test-slot-2 1 1)"

# ── R8: symlink escape — realpath resolution must catch a worktree that
#    symlinks out of the sandbox to a production path. ──
ACTION_SINK="${TMP}/sink-symlink.txt"; : > "$ACTION_SINK"
ESCAPE_TARGET="${TMP}/pretend-prod"; mkdir -p "$ESCAPE_TARGET"
SYM_WT="${SLOT_DIR}/project-slot-2-FLY-esc/wt"
mkdir -p "$(dirname "$SYM_WT")"
ln -s "$ESCAPE_TARGET" "$SYM_WT"
write_desc exec-sym "$(jq -n --arg e exec-sym --argjson pid 5007 --arg st st1 \
  --arg cwd "$SYM_WT" --arg wt "$SYM_WT" --arg ino 111 --arg sn runner-test-slot-2 \
  '{execId:$e, pid:$pid, startTime:$st, cwd:$cwd, worktree:$wt, inode:$ino, sessionName:$sn, sessionPresent:true, claudeDescendants:1, resolveRealpath:true}')"
jq '.injectionTargets += ["exec-sym"]' "$MANIFEST" > "${MANIFEST}.tmp" && mv "${MANIFEST}.tmp" "$MANIFEST"
rc=0
run_inj break-worktree exec-sym >/dev/null 2>&1 || rc=$?
if [[ "$rc" -ne 0 && ! -s "$ACTION_SINK" ]]; then
  pass "R8: symlink-escape worktree rejected (realpath), zero actions"
else
  fail "R8: symlink escape not caught (rc=$rc sink=$(cat "$ACTION_SINK"))"
fi

# ── A1: valid target → freeze recorded in sink + journal entry written ──
ACTION_SINK="${TMP}/sink-good.txt"; : > "$ACTION_SINK"
: > "$JOURNAL"
write_desc exec-good "$(mk_desc exec-good 4242 st-good "$GOOD_WT" "$GOOD_WT" 111 runner-test-slot-2 1 1)"
rc=0
run_inj freeze exec-good >/dev/null 2>&1 || rc=$?
A1_OK=1
[[ "$rc" -eq 0 ]] || { A1_OK=0; fail "A1: valid freeze should exit 0 (rc=$rc)"; }
grep -q "STOP" "$ACTION_SINK" 2>/dev/null || { A1_OK=0; fail "A1: freeze action (STOP) not recorded in sink"; }
grep -q "4242" "$ACTION_SINK" 2>/dev/null || { A1_OK=0; fail "A1: freeze did not target the resolved PID"; }
[[ -s "$JOURNAL" ]] && jq -e 'select(.execId=="exec-good" and .action=="freeze")' >/dev/null 2>&1 < <(tail -1 "$JOURNAL") \
  || { A1_OK=0; fail "A1: journal entry for freeze missing"; }
[[ "$A1_OK" == "1" ]] && pass "A1: valid freeze → action recorded + journaled"

# ── A2: verify-target is DRY-RUN — anchors pass, journal written, NO action ──
ACTION_SINK="${TMP}/sink-verify.txt"; : > "$ACTION_SINK"
: > "$JOURNAL"
rc=0
run_inj verify-target exec-good >/dev/null 2>&1 || rc=$?
A2_OK=1
[[ "$rc" -eq 0 ]] || { A2_OK=0; fail "A2: verify-target of a valid slot target should exit 0"; }
[[ ! -s "$ACTION_SINK" ]] || { A2_OK=0; fail "A2: verify-target must NOT perform any action"; }
jq -e 'select(.action=="verify")' >/dev/null 2>&1 < <(tail -1 "$JOURNAL") || { A2_OK=0; fail "A2: verify journal entry missing"; }
[[ "$A2_OK" == "1" ]] && pass "A2: verify-target is dry-run (journal only, no action)"

# ── A2b: register-target adds a NEW execId to injectionTargets after full
#    anchor validation; a prod/non-slot target can't be registered. ──
A2b_OK=1
REG_MANIFEST="${TMP}/reg-manifest.json"
jq -n '{campaignId:"c1", ownerSlot:2, injectionTargets:[]}' > "$REG_MANIFEST"
ACTION_SINK="${TMP}/sink-reg.txt"; : > "$ACTION_SINK"
# A valid slot target not yet in the (empty) injectionTargets.
write_desc exec-reg "$(mk_desc exec-reg 9100 st-reg "$GOOD_WT" "$GOOD_WT" 111 runner-test-slot-2 1 1)"
if QA1189_DESCRIBE_OVERRIDE="$DESC_DIR" QA1189_SLOT_DIR="$SLOT_DIR" QA1189_MANIFEST="$REG_MANIFEST" \
   QA1189_JOURNAL="$JOURNAL" QA1189_QUARANTINE_ROOT="$QUAR" QA1189_ACTION_SINK="$ACTION_SINK" \
   bash "$INJ" register-target exec-reg >/dev/null 2>&1; then
  jq -e '.injectionTargets | index("exec-reg")' >/dev/null 2>&1 <"$REG_MANIFEST" \
    || { A2b_OK=0; fail "A2b: register-target did not add exec-reg to injectionTargets"; }
  [[ ! -s "$ACTION_SINK" ]] || { A2b_OK=0; fail "A2b: register-target must not perform any action"; }
else
  A2b_OK=0; fail "A2b: register-target of a valid slot target should succeed"
fi
# A prod-path target cannot be registered (path anchor refuses even w/o membership).
write_desc exec-regprod "$(mk_desc exec-regprod 9200 st-p "${HOME}/Dev/flywheel/wt" "${HOME}/Dev/flywheel/wt" 111 runner-test-slot-2 1 1)"
if QA1189_DESCRIBE_OVERRIDE="$DESC_DIR" QA1189_SLOT_DIR="$SLOT_DIR" QA1189_MANIFEST="$REG_MANIFEST" \
   QA1189_JOURNAL="$JOURNAL" QA1189_QUARANTINE_ROOT="$QUAR" QA1189_ACTION_SINK="$ACTION_SINK" \
   bash "$INJ" register-target exec-regprod >/dev/null 2>&1; then
  A2b_OK=0; fail "A2b: register-target must REFUSE a production-path target"
fi
jq -e '.injectionTargets | index("exec-regprod") | not' >/dev/null 2>&1 <"$REG_MANIFEST" \
  || { A2b_OK=0; fail "A2b: a refused prod target must NOT be in injectionTargets"; }
[[ "$A2b_OK" == "1" ]] && pass "A2b: register-target allowlists valid targets, refuses prod paths"

# ── A3: break-worktree valid → mv recorded, quarantine dst = safe root ──
ACTION_SINK="${TMP}/sink-break.txt"; : > "$ACTION_SINK"
: > "$JOURNAL"
BREAK_WT="${SLOT_DIR}/project-slot-2-FLY-brk/wt"
mkdir -p "$BREAK_WT"
write_desc exec-break "$(mk_desc exec-break 4343 st-brk "$BREAK_WT" "$BREAK_WT" 222 runner-test-slot-2 1 1)"
rc=0
run_inj break-worktree exec-break >/dev/null 2>&1 || rc=$?
A3_OK=1
[[ "$rc" -eq 0 ]] || { A3_OK=0; fail "A3: valid break should exit 0 (rc=$rc)"; }
grep -q "$QUAR" "$ACTION_SINK" 2>/dev/null || { A3_OK=0; fail "A3: break destination must be the quarantine root"; }
jq -e --arg q "$QUAR" 'select(.action=="break" and (.dst|startswith($q)))' >/dev/null 2>&1 < <(tail -1 "$JOURNAL") \
  || { A3_OK=0; fail "A3: break journal dst not under quarantine root"; }
[[ "$A3_OK" == "1" ]] && pass "A3: valid break-worktree → mv to quarantine, journaled"

# ── T1: TOCTOU — start-time changed between journal and re-read → refuse ──
T_OK=1
: > "$JOURNAL"
D1="$(mk_desc exec-toctou 7777 st-CHECK "$GOOD_WT" "$GOOD_WT" 111 runner-test-slot-2 1 1)"
qa1189_journal_append "$JOURNAL" "$D1" freeze "" ""
# re-read shows the SAME pid but a DIFFERENT start-time = PID was recycled.
D2="$(mk_desc exec-toctou 7777 st-DRIFTED "$GOOD_WT" "$GOOD_WT" 111 runner-test-slot-2 1 1)"
if qa1189_journal_verify_unchanged "$JOURNAL" exec-toctou "$D2"; then T_OK=0; fail "T1: start-time drift must fail TOCTOU verify"; fi
# same start-time + same inode = OK
if ! qa1189_journal_verify_unchanged "$JOURNAL" exec-toctou "$D1"; then T_OK=0; fail "T1: unchanged identity should pass TOCTOU verify"; fi
# inode drift also fails
D3="$(mk_desc exec-toctou 7777 st-CHECK "$GOOD_WT" "$GOOD_WT" 999 runner-test-slot-2 1 1)"
if qa1189_journal_verify_unchanged "$JOURNAL" exec-toctou "$D3"; then T_OK=0; fail "T1: inode drift must fail TOCTOU verify"; fi
[[ "$T_OK" == "1" ]] && pass "T1: TOCTOU verify catches start-time + inode drift"

# T1b: FAIL-CLOSED on an EMPTY identity field (Codex R1 HIGH #3). An empty
# start-time or inode must NOT read as "unchanged" (empty==empty). Build a
# journal entry AND re-read both with an empty start-time — must refuse.
T1b_OK=1
: > "$JOURNAL"
DE="$(mk_desc exec-empty 6001 "" "$GOOD_WT" "$GOOD_WT" "" runner-test-slot-2 1 1)"
qa1189_journal_append "$JOURNAL" "$DE" freeze "" ""
if qa1189_journal_verify_unchanged "$JOURNAL" exec-empty "$DE"; then
  T1b_OK=0; fail "T1b: empty start-time/inode on both sides must FAIL (cannot verify)"
fi
# also: journal has values but re-read lost them → refuse
: > "$JOURNAL"
DV="$(mk_desc exec-empty 6002 st-X "$GOOD_WT" "$GOOD_WT" 123 runner-test-slot-2 1 1)"
qa1189_journal_append "$JOURNAL" "$DV" freeze "" ""
DVE="$(mk_desc exec-empty 6002 "" "$GOOD_WT" "$GOOD_WT" "" runner-test-slot-2 1 1)"
if qa1189_journal_verify_unchanged "$JOURNAL" exec-empty "$DVE"; then
  T1b_OK=0; fail "T1b: re-read losing start-time/inode must FAIL"
fi
[[ "$T1b_OK" == "1" ]] && pass "T1b: TOCTOU fail-closed on missing start-time/inode"

# T1c: real-mode fail-closed on empty paneId/command (Codex R4 #3). Called
# directly (no QA1189_ACTION_SINK = real mode); a descriptor missing paneId
# must refuse even if pid/start/inode match.
T1c_OK=1
: > "$JOURNAL"
DP="$(mk_desc exec-pane 6100 st-p "$GOOD_WT" "$GOOD_WT" 200 runner-test-slot-2 1 1 "" "")"
qa1189_journal_append "$JOURNAL" "$DP" freeze "" ""
if qa1189_journal_verify_unchanged "$JOURNAL" exec-pane "$DP"; then
  T1c_OK=0; fail "T1c: empty paneId/command (real mode) must FAIL the tuple TOCTOU"
fi
# with a sink set (test mode) the same descriptor passes (fixtures allowed)
if ! QA1189_ACTION_SINK=/dev/null qa1189_journal_verify_unchanged "$JOURNAL" exec-pane "$DP"; then
  T1c_OK=0; fail "T1c: test-mode (action sink) should not require paneId/command"
fi
[[ "$T1c_OK" == "1" ]] && pass "T1c: real-mode fail-closed on empty paneId/command"

# P3: macOS /private/tmp canonicalization — a slot path given as /tmp/… and a
# prefix given the same way must match after canon (the real resolver realpaths
# cwd to /private/tmp on macOS while the slot root is /tmp). Use the real
# sandbox dir which exists.
if qa1189_path_anchor_ok "$GOOD_WT" "$SLOT_DIR"; then
  pass "P3: canonicalized slot path matches slot root (macOS /private/tmp safe)"
else
  fail "P3: real slot path under slot root should pass after canon"
fi

# ── T2: subcommand-level TOCTOU — descriptor changes between check and act.
#    The injector re-reads the descriptor right before acting; if the override
#    file was rewritten with a drifted start-time, freeze must refuse + no action. ──
ACTION_SINK="${TMP}/sink-toctou.txt"; : > "$ACTION_SINK"
: > "$JOURNAL"
# QA1189_TOCTOU_REREAD points at a SECOND descriptor dir used ONLY for the
# pre-action re-read, letting the test inject drift deterministically.
REREAD_DIR="${TMP}/reread"; mkdir -p "$REREAD_DIR"
write_desc exec-toctou "$(mk_desc exec-toctou 8888 st-A "$GOOD_WT" "$GOOD_WT" 111 runner-test-slot-2 1 1)"
printf '%s' "$(mk_desc exec-toctou 8888 st-B "$GOOD_WT" "$GOOD_WT" 111 runner-test-slot-2 1 1)" > "${REREAD_DIR}/exec-toctou.json"
rc=0
QA1189_TOCTOU_REREAD="$REREAD_DIR" run_inj freeze exec-toctou >/dev/null 2>&1 || rc=$?
if [[ "$rc" -ne 0 && ! -s "$ACTION_SINK" ]]; then
  pass "T2: pre-action re-read drift → freeze refused, zero actions"
else
  fail "T2: TOCTOU re-read drift not caught (rc=$rc sink=$(cat "$ACTION_SINK"))"
fi

# ── D1: restore direction lock ──
D_OK=1
: > "$JOURNAL"
ORIG="${SLOT_DIR}/project-slot-2-FLY-r/wt"
DST="${QUAR}/exec-restore"
# Real journal entries are compact JSONL (jq -c) — the line-based lookups
# depend on that; build the fixture the same way.
BD="$(jq -cn --arg e exec-restore --arg src "$ORIG" --arg dst "$DST" \
  '{execId:$e, action:"break", src:$src, dst:$dst, pid:9, startTime:"s", inode:"1"}')"
printf '%s\n' "$BD" >> "$JOURNAL"
# correct direction: restore source = journaled dst (quarantine), dest = journaled src (original)
qa1189_restore_direction_ok "$JOURNAL" exec-restore "$DST" "$ORIG" || { D_OK=0; fail "D1: correct restore direction should pass"; }
# wrong: restoring FROM an arbitrary path
if qa1189_restore_direction_ok "$JOURNAL" exec-restore "/etc" "$ORIG"; then D_OK=0; fail "D1: restore source != journaled quarantine must be rejected"; fi
# wrong: restoring TO an arbitrary path (not the journaled original)
if qa1189_restore_direction_ok "$JOURNAL" exec-restore "$DST" "/etc/evil"; then D_OK=0; fail "D1: restore dest != journaled original must be rejected"; fi
[[ "$D_OK" == "1" ]] && pass "D1: restore direction lock (both endpoints journal-bound)"

# ── J1: journal all-in-safe-root invariant (E5 hard gate). Every mutated PID's
#    canonical cwd is under slot/quarantine root; a planted prod path fails. ──
J_OK=1
: > "$JOURNAL"
qa1189_journal_append "$JOURNAL" "$(mk_desc e1 10 s "$GOOD_WT" "$GOOD_WT" 1 runner-test-slot-2 1 1)" freeze "" ""
qa1189_journal_verify_safe_root "$JOURNAL" "$SLOT_DIR" "$QUAR" || { J_OK=0; fail "J1: clean journal should pass safe-root invariant"; }
# plant a prod path (compact, like the real journal)
printf '%s\n' "$(jq -cn --arg cwd "${HOME}/Dev/flywheel/x" '{execId:"bad", action:"freeze", cwd:$cwd, pid:11}')" >> "$JOURNAL"
if qa1189_journal_verify_safe_root "$JOURNAL" "$SLOT_DIR" "$QUAR"; then J_OK=0; fail "J1: a prod path in the journal MUST fail the invariant"; fi
[[ "$J_OK" == "1" ]] && pass "J1: journal all-in-safe-root invariant (E5 gate)"

# ── J2: prod-snapshot shape (PID set + file-set JSON) ──
ACTION_SINK="${TMP}/sink-snap.txt"; : > "$ACTION_SINK"
SNAP=$(QA1189_DESCRIBE_OVERRIDE="$DESC_DIR" QA1189_SLOT_DIR="$SLOT_DIR" \
  QA1189_MANIFEST="$MANIFEST" QA1189_JOURNAL="$JOURNAL" QA1189_QUARANTINE_ROOT="$QUAR" \
  QA1189_ACTION_SINK="$ACTION_SINK" \
  QA1189_PROD_SNAPSHOT_ROOTS="${TMP}/snaproot" \
  bash "$INJ" prod-snapshot before 2>/dev/null || echo "{}")
mkdir -p "${TMP}/snaproot"; echo x > "${TMP}/snaproot/a.txt"
SNAP=$(QA1189_DESCRIBE_OVERRIDE="$DESC_DIR" QA1189_SLOT_DIR="$SLOT_DIR" \
  QA1189_MANIFEST="$MANIFEST" QA1189_JOURNAL="$JOURNAL" QA1189_QUARANTINE_ROOT="$QUAR" \
  QA1189_ACTION_SINK="$ACTION_SINK" \
  QA1189_PROD_SNAPSHOT_ROOTS="${TMP}/snaproot" \
  bash "$INJ" prod-snapshot before 2>/dev/null || echo "{}")
if jq -e '.label == "before" and (.pids | type == "array") and (.files | type == "array")' >/dev/null 2>&1 <<<"$SNAP"; then
  pass "J2: prod-snapshot emits {label, pids[], files[]}"
else
  fail "J2: prod-snapshot shape wrong: $SNAP"
fi

# ── S1: injector must NOT self-register an EXIT trap (trap ownership = driver) ──
if grep -Eq "trap[[:space:]]+[^#]*EXIT" "$INJ"; then
  fail "S1: injector must NOT register an EXIT trap (driver owns recovery lifecycle)"
else
  pass "S1: injector registers no EXIT trap (trap ownership = driver)"
fi

echo "=================================="
echo "qa-fly-1189-fault-inject tests: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ]
