#!/bin/bash
# FLY-102: Tests for flywheel-cmux-sync.sh event-signaled polling logic.
# Runs: /bin/bash scripts/test-cmux-sync.sh
#
# FLY-129 Phase 1 (R2-8): explicit `#!/bin/bash` (not `/usr/bin/env bash`).
# Production cmux watcher runs under macOS `/bin/bash` 3.2; Homebrew bash 4+
# would mask bash-3.2-incompatible constructs (declare -A, BASHPID, etc.).
# The preflight assertion below catches Homebrew-bash invocations.

case "${BASH_VERSION:-}" in
  3.2*) ;;
  *)
    echo "test-cmux-sync.sh requires /bin/bash 3.2 (macOS system bash)" >&2
    echo "  detected: BASH_VERSION=${BASH_VERSION:-<unset>}" >&2
    echo "  run as: /bin/bash $0" >&2
    exit 1
    ;;
esac
#
# Strategy: source the script (guarded against main dispatcher), then override
# tmux/cmux with bash functions so we can exercise the logic without touching
# real tmux sessions or a real cmux instance.
set -uo pipefail  # not -e: we want to keep going on test failures

PASS=0
FAIL=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

# Isolate file-based state in a tempdir
TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

export EVENT_FILE="$TMPDIR_ROOT/events"
export CLEANUP_PENDING="$TMPDIR_ROOT/cleanup-pending"
export STALE_STATE="$TMPDIR_ROOT/stale.state"
export HEAL_STATE="$TMPDIR_ROOT/heal.state"  # FLY-169
export CMUX_SOCK_IDENT_FILE="$TMPDIR_ROOT/sock-ident"  # FLY-254
export FLYWHEEL_CMUX_CLEANUP_DELAY=30
export FLYWHEEL_CMUX_CONSERVATIVE_CLEANUP=300

# FLY-129 Phase 1: tests must not touch the real /tmp watcher lock.
export FLYWHEEL_CMUX_WATCHER_LOCK_DIR="$TMPDIR_ROOT/watcher.lock"

# ════════════════════════════════════════════════════════════════
# Mocks for tmux and cmux
# ════════════════════════════════════════════════════════════════
MOCK_TMUX_WINDOWS=""       # lines of session|wid|wname
MOCK_PANE_DEAD=""          # lines of session:wname=0|1
MOCK_CMUX_WORKSPACES=""    # cmux list-workspaces output (legacy text)
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'  # FLY-129 Phase 3: cmux --json list-workspaces output
MOCK_CMUX_JSON_FAIL="0"    # FLY-129 Phase 3: 1 = simulate JSON failure (rc=1 from cmux)
MOCK_CMUX_JSON_INVALID="0" # FLY-129 Phase 3: 1 = return invalid JSON (parse failure)
MOCK_TMUX_SESSIONS=""      # list-sessions output
MOCK_TMUX_HOOKS=""         # captured set-hook invocations
MOCK_CMUX_OPS=""           # captured cmux operations
MOCK_TMUX_KILLED=""        # captured tmux kill-session targets
MOCK_PGREP_HIT="0"         # FLY-129 Phase 1: pgrep mock — 1 = watcher running, 0 = not
MOCK_SHOW_HOOKS=""         # FLY-129 Phase 2: tmux show-hooks output — lines of "<hook>[idx] ..." per session

tmux() {
  case "$1" in
    list-windows)
      shift
      # args are like: -t session -F format
      local session="" fmt=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -t) session="$2"; shift 2 ;;
          -F) fmt="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      # FLY-129 Phase 8: honor common -F format strings used by callers.
      # The MOCK_TMUX_WINDOWS row is "session|window_id|window_name"; map
      # the format to the requested projection.
      case "$fmt" in
        '#{window_name}')
          echo "$MOCK_TMUX_WINDOWS" | awk -F'|' -v s="$session" '$1 == s { print $3 }' || true
          ;;
        ''|'#{session_name}|#{window_id}|#{window_name}'|*)
          echo "$MOCK_TMUX_WINDOWS" | awk -F'|' -v s="$session" '$1 == s' || true
          ;;
      esac
      ;;
    list-sessions)
      echo "$MOCK_TMUX_SESSIONS"
      ;;
    has-session)
      # Parse the -t target properly (callers pass `has-session -t "=name"`).
      # FLY-169: the old `${2#=}` read "-t" literally, so linked_session_exists
      # always returned false. Only linked_session_exists calls this, and no
      # test exercised it before FLY-169, so correct parsing is safe.
      shift
      local target=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -t) target="${2#=}"; shift 2 ;;
          *) shift ;;
        esac
      done
      echo "$MOCK_TMUX_SESSIONS" | grep -qx "$target"
      ;;
    display-message)
      # args: -p -t target format
      local target="" fmt=""
      shift
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -p|-F) shift ;;
          -t) target="$2"; shift 2 ;;
          *) fmt="$1"; shift ;;
        esac
      done
      # target like =session:=wname
      local clean="${target//=/}"
      local session="${clean%%:*}"
      local wname="${clean##*:}"
      echo "$MOCK_PANE_DEAD" | awk -F= -v k="${session}:${wname}" '$1 == k { print $2; found=1 } END { if (!found) print "1" }'
      ;;
    set-hook)
      MOCK_TMUX_HOOKS+="$*"$'\n'
      ;;
    show-hooks)
      # FLY-129 Phase 2: driven by MOCK_SHOW_HOOKS. Whole-output mock —
      # the function ignores -t <session> so tests just set the global.
      printf '%s' "$MOCK_SHOW_HOOKS"
      ;;
    kill-session)
      # tmux kill-session -t target → capture target
      shift
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -t) MOCK_TMUX_KILLED+="$2"$'\n'; shift 2 ;;
          *) shift ;;
        esac
      done
      ;;
    list-clients)
      # FLY-169: tmux list-clients -t '=<view_session>'.
      #   - session NOT in MOCK_TMUX_CLIENTS → rc=1 (tmux error / no session) →
      #     callers fail closed.
      #   - "vs=N"     → rc=0, N client lines (static).
      #   - "vs=N1,N2" → per-call sequence (for TOCTOU): 1st call N1, 2nd N2…
      #     clamped to the last value. Counter is per view_session, reset by
      #     reset_mocks.
      shift
      local lc_target=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -t) lc_target="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      local vs="${lc_target#=}"
      local spec
      spec=$(echo "$MOCK_TMUX_CLIENTS" | awk -F= -v k="$vs" '$1==k{print $2; f=1} END{if(!f) print "__ERR__"}')
      if [[ "$spec" == "__ERR__" ]]; then
        return 1   # session not mocked → tmux error
      fi
      local cnt_file="$TMPDIR_ROOT/clients.$(echo "$vs" | tr -c 'A-Za-z0-9_.-' '_').n"
      local n=0
      if [[ -f "$cnt_file" ]]; then n=$(cat "$cnt_file"); fi
      n=$((n + 1)); echo "$n" > "$cnt_file"
      local val
      val=$(echo "$spec" | awk -F, -v i="$n" '{ if (i>NF) i=NF; print $i }')
      local j=1
      while [[ $j -le ${val:-0} ]]; do echo "client$j"; j=$((j + 1)); done
      return 0
      ;;
    select-window)
      # FLY-169: capture select-window targets so tests can assert active-window
      # repair (heal) and the create-time ready gate.
      shift
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -t) MOCK_TMUX_SELECTS+="$2"$'\n'; shift 2 ;;
          *) shift ;;
        esac
      done
      # Honor MOCK_TMUX_SELECT_FAIL (for the §2.6 create-gate test).
      if [[ "${MOCK_TMUX_SELECT_FAIL:-0}" == "1" ]]; then return 1; fi
      return 0
      ;;
    new-session)
      # FLY-169: faithfully register the -s session so linked_session_exists
      # reflects it afterward (mirrors production; the §2.6 create gate depends
      # on the linked session existing after new-session).
      shift
      local ns_name=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -s) ns_name="$2"; shift 2 ;;
          -t) shift 2 ;;
          *) shift ;;
        esac
      done
      if [[ -n "$ns_name" ]] && ! echo "$MOCK_TMUX_SESSIONS" | grep -qx "$ns_name"; then
        if [[ -n "$MOCK_TMUX_SESSIONS" ]]; then
          MOCK_TMUX_SESSIONS="${MOCK_TMUX_SESSIONS}"$'\n'"${ns_name}"
        else
          MOCK_TMUX_SESSIONS="$ns_name"
        fi
      fi
      ;;
    new-window)
      : ;;  # noop
    *)
      return 0 ;;
  esac
}

cmux() {
  # FLY-129: cmux_call passes `--socket "$path"` first; skip those two args
  # so the rest of the test mock keeps working unchanged.
  if [[ "${1:-}" == "--socket" ]]; then
    shift 2
  fi
  # FLY-129 Phase 3: support `cmux --json list-workspaces` ordering.
  local json_mode=0
  if [[ "${1:-}" == "--json" ]]; then
    json_mode=1
    shift
  fi
  case "${1:-}" in
    list-workspaces)
      if (( json_mode == 1 )); then
        # FLY-254 CR-R3: optional identity flip "during" a JSON IPC. Writes
        # the new identity to a FILE (this mock often runs inside $(...)
        # subshells; cmux_socket_identity's test override reads the file) on
        # the MOCK_JSON_FLIP_AT-th list-workspaces call. Used to reproduce
        # the generation-flip-during-current_selected_ref race.
        if [[ -n "${MOCK_JSON_FLIP_IDENT:-}" ]]; then
          local jf_file="$TMPDIR_ROOT/jsoncalls.n" jf_n=0
          [[ -f "$jf_file" ]] && jf_n=$(cat "$jf_file")
          jf_n=$((jf_n + 1)); echo "$jf_n" > "$jf_file"
          if [[ "$jf_n" -ge "${MOCK_JSON_FLIP_AT:-1}" ]]; then
            printf '%s' "$MOCK_JSON_FLIP_IDENT" > "$TMPDIR_ROOT/mock-ident.override"
          fi
        fi
        if [[ "$MOCK_CMUX_JSON_FAIL" == "1" ]]; then
          return 1
        fi
        if [[ "$MOCK_CMUX_JSON_INVALID" == "1" ]]; then
          echo "not json"
        elif [[ -n "${MOCK_CMUX_JSON_SEQ_N:-}" ]]; then
          # FLY-254: per-call JSON sequence read from files
          # $TMPDIR_ROOT/wsjson.<i> (1..MOCK_CMUX_JSON_SEQ_N, clamped to the
          # last). File-based counter — list-workspaces runs inside $(...)
          # subshells. Used by the readiness-wait partial-restore tests.
          local wj_file="$TMPDIR_ROOT/wsjson.n" wj_n=0
          [[ -f "$wj_file" ]] && wj_n=$(cat "$wj_file")
          wj_n=$((wj_n + 1)); echo "$wj_n" > "$wj_file"
          (( wj_n > MOCK_CMUX_JSON_SEQ_N )) && wj_n=$MOCK_CMUX_JSON_SEQ_N
          cat "$TMPDIR_ROOT/wsjson.$wj_n"
        else
          echo "$MOCK_CMUX_WORKSPACES_JSON"
        fi
      else
        echo "$MOCK_CMUX_WORKSPACES"
      fi
      ;;
    close-workspace|new-workspace|rename-workspace|send|send-key|refresh-surfaces)
      # FLY-169: capture send / send-key / refresh-surfaces too (with their
      # --surface args) so tests can assert surface-scoped self-heal sends.
      MOCK_CMUX_OPS+="$*"$'\n'
      ;;
    select-workspace)
      # FLY-254: capture the focus mutation AND reflect it in the workspace
      # JSON selected flags, so current_selected_ref sees focus changes the
      # way real cmux reports them. Mutating globals is safe here:
      # select-workspace is always invoked via cmux_call directly (never
      # inside $(...)), so this runs in the main shell.
      # CR-R4: the ops line also records the identity observed AT MUTATION
      # TIME (ident=…) — ordering regression guard: any bookkeeping slipped
      # between the final stat and the select shows up as ident=B here.
      MOCK_CMUX_OPS+="$* ident=$(cmux_socket_identity)"$'\n'
      local sw_ref=""
      shift
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --workspace) sw_ref="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      if [[ -n "$sw_ref" ]]; then
        local sw_new
        sw_new=$(printf '%s' "$MOCK_CMUX_WORKSPACES_JSON" | python3 -c '
import sys, json
ref = sys.argv[1]
d = json.load(sys.stdin)
for w in d.get("workspaces", []):
    w["selected"] = (w.get("ref") == ref)
print(json.dumps(d))' "$sw_ref" 2>/dev/null)
        [[ -n "$sw_new" ]] && MOCK_CMUX_WORKSPACES_JSON="$sw_new"
      fi
      # CR-R6 LOW: optional forced exit code — proves a REAL cmux rc (e.g. 99)
      # is never misread as a guard block.
      return "${MOCK_CMUX_SELECT_RC:-0}"
      ;;
    read-screen)
      # FLY-169: bare-shell gate reads the surface screen. MOCK_CMUX_READSCREEN
      # is the screen text (last non-empty line drives the prompt-sigil check).
      # FLY-254: MOCK_CMUX_READSCREEN_SEQ adds a per-call sequence — comma-
      # separated values, "FAIL" = rc=1, anything else = screen text; clamped
      # to the last value. Counter is FILE-based because read-screen is invoked
      # inside $(...) subshells (same pattern as the list-clients counters and
      # FLY-242's panedead counters).
      if [[ -n "${MOCK_CMUX_READSCREEN_SEQ:-}" ]]; then
        local rs_file="$TMPDIR_ROOT/readscreen.n" rs_n=0
        [[ -f "$rs_file" ]] && rs_n=$(cat "$rs_file")
        rs_n=$((rs_n + 1)); echo "$rs_n" > "$rs_file"
        local rs_v
        rs_v=$(echo "$MOCK_CMUX_READSCREEN_SEQ" | awk -F, -v i="$rs_n" '{ if (i>NF) i=NF; print $i }')
        if [[ "$rs_v" == "FAIL" ]]; then return 1; fi
        printf '%s\n' "$rs_v"
        return 0
      fi
      if [[ "${MOCK_CMUX_READSCREEN_FAIL:-0}" == "1" ]]; then return 1; fi
      printf '%s\n' "$MOCK_CMUX_READSCREEN"
      ;;
    list-pane-surfaces)
      # FLY-169: cmux --json list-pane-surfaces --workspace <ref>.
      #   MOCK_CMUX_SURFACES_FAIL=1    → cmux failure (rc=1)
      #   MOCK_CMUX_SURFACES_INVALID=1 → malformed JSON (parse must fail closed)
      #   else build {"surfaces":[{ref,type,selected}...]} from MOCK_CMUX_SURFACES
      #   lines formatted "wsref;;surfaceref;;type;;selected" (selected="true"/"").
      shift
      local lps_ws=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --workspace) lps_ws="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      if [[ "${MOCK_CMUX_SURFACES_FAIL:-0}" == "1" ]]; then return 1; fi
      if [[ "${MOCK_CMUX_SURFACES_INVALID:-0}" == "1" ]]; then
        echo "not json"
        return 0
      fi
      echo "$MOCK_CMUX_SURFACES" | awk -F';;' -v w="$lps_ws" '
        BEGIN { printf "{\"surfaces\":[" ; first=1 }
        $1==w { if(!first) printf "," ; first=0 ;
                sel = ($4=="true") ? "true" : "false" ;
                printf "{\"ref\":\"%s\",\"type\":\"%s\",\"selected\":%s}", $2, $3, sel }
        END { print "]}" }'
      ;;
    *) return 0 ;;
  esac
}

pgrep() {
  # FLY-129 Phase 1: drive sync_once's watcher-detection branch from tests.
  # Real pgrep returns 0 if any match, 1 if none. Honor MOCK_PGREP_HIT.
  [[ "${MOCK_PGREP_HIT:-0}" == "1" ]] && return 0
  return 1
}

export -f tmux cmux pgrep

reset_mocks() {
  MOCK_TMUX_WINDOWS=""
  MOCK_PANE_DEAD=""
  MOCK_CMUX_WORKSPACES=""
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'
  MOCK_CMUX_JSON_FAIL="0"
  MOCK_CMUX_JSON_INVALID="0"
  MOCK_TMUX_SESSIONS=""
  MOCK_TMUX_HOOKS=""
  MOCK_CMUX_OPS=""
  MOCK_TMUX_KILLED=""
  MOCK_PGREP_HIT="0"
  MOCK_SHOW_HOOKS=""
  # FLY-169 mocks
  MOCK_TMUX_CLIENTS=""        # lines "view_session=N" or "view_session=N1,N2" (per-call seq)
  MOCK_TMUX_SELECTS=""        # captured select-window targets
  MOCK_TMUX_SELECT_FAIL="0"   # 1 = select-window returns rc=1 (create-gate test)
  MOCK_CMUX_SURFACES=""       # lines "wsref;;title;;surfaceref"
  MOCK_CMUX_SURFACES_FAIL="0" # 1 = list-pane-surfaces cmux failure
  MOCK_CMUX_SURFACES_INVALID="0" # 1 = list-pane-surfaces returns malformed JSON
  MOCK_CMUX_READSCREEN="user@host ~ %"   # bare-shell screen (prompt sigil) by default
  MOCK_CMUX_READSCREEN_FAIL="0"          # 1 = read-screen cmux failure
  CMUX_HEAL_ON_RECOVERY="0"
  # FLY-254 mocks
  MOCK_CMUX_READSCREEN_SEQ=""   # per-call read-screen sequence ("FAIL,text,…")
  MOCK_CMUX_JSON_SEQ_N=""       # per-call list-workspaces JSON files (wsjson.<i>)
  MOCK_SOCK_IDENT=""            # cmux_socket_identity override value
  MOCK_SOCK_PRESENT="0"         # cmux_socket_present override (1 = socket exists)
  MOCK_SLEEPS=0                 # sleep-mock call counter
  MOCK_SLEEP_ARGS=""            # sleep-mock recorded durations
  MOCK_SLEEP_HOOK=""            # eval'd on each mocked sleep (flip state mid-wait)
  HEAL_RENDER_ESCALATE=0
  REOPEN_CONSUMED_THIS_TICK=0
  REOPEN_CACHE_IDENT=""         # FLY-254 CR-M6 in-process cache
  REOPEN_CACHE_STATE=""
  HEAL_SWEEP_GEN_IDENT=""       # FLY-254 CR-HIGH-2 generation pin
  HEAL_GEN_CHANGED=0            # FLY-254 CR-R2-HIGH-1 generation-changed latch
  MOCK_JSON_FLIP_IDENT=""       # FLY-254 CR-R3: identity flip during a JSON IPC
  MOCK_JSON_FLIP_AT=""
  MOCK_MKTEMP_HOOK=""           # FLY-254 CR-R5: eval'd at cmux_call_guarded's mktemp
  MOCK_CMUX_SELECT_RC=""        # FLY-254 CR-R6: force select-workspace exit code
  rm -f "$TMPDIR_ROOT"/jsoncalls.n "$TMPDIR_ROOT"/mock-ident.override "$TMPDIR_ROOT"/gmk.n 2>/dev/null
  # FLY-129 Phase 3: reset JSON transition state so per-test logging is clean.
  CMUX_JSON_LAST_STATE="unknown"
  rm -f "$EVENT_FILE" "$CLEANUP_PENDING" "$STALE_STATE" "$HEAL_STATE"
  rm -f "$TMPDIR_ROOT"/clients.*.n
  rm -f "$CMUX_SOCK_IDENT_FILE" "$TMPDIR_ROOT"/readscreen.n "$TMPDIR_ROOT"/wsjson.n "$TMPDIR_ROOT"/wsjson.[0-9]* 2>/dev/null
  rm -rf "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" "${FLYWHEEL_CMUX_WATCHER_LOCK_DIR}.reap"
}

# Source the script (guarded — dispatcher won't run because BASH_SOURCE != $0)
source "$SCRIPT_DIR/flywheel-cmux-sync.sh"

# Re-export mocks after sourcing (sourcing unsets them in some shells? defensive)
export -f tmux cmux

# ════════════════════════════════════════════════════════════════
# Test 1: register_session_hooks only registers for flywheel/runner-*
# ════════════════════════════════════════════════════════════════
echo "Test: register_session_hooks name filter"
reset_mocks
register_session_hooks "flywheel" >/dev/null
register_session_hooks "runner-geoforge3d" >/dev/null
register_session_hooks "unrelated-session" >/dev/null
register_session_hooks "cmux-worker-fly-102" >/dev/null

if echo "$MOCK_TMUX_HOOKS" | grep -q "flywheel"; then
  pass "registers on 'flywheel'"
else
  fail "missing hook for 'flywheel'"
fi
if echo "$MOCK_TMUX_HOOKS" | grep -q "runner-geoforge3d"; then
  pass "registers on 'runner-geoforge3d'"
else
  fail "missing hook for 'runner-geoforge3d'"
fi
if echo "$MOCK_TMUX_HOOKS" | grep -q "unrelated-session"; then
  fail "should not register on 'unrelated-session'"
else
  pass "skips 'unrelated-session'"
fi
if echo "$MOCK_TMUX_HOOKS" | grep -q "cmux-worker-fly-102"; then
  fail "should not register on cmux-* linked session"
else
  pass "skips cmux-* linked session"
fi

# ════════════════════════════════════════════════════════════════
# Test 2: register_session_hooks uses array index [500]
# ════════════════════════════════════════════════════════════════
echo "Test: hook uses array index [500]"
reset_mocks
register_session_hooks "flywheel" >/dev/null

if echo "$MOCK_TMUX_HOOKS" | grep -q 'after-new-window\[500\]'; then
  pass "after-new-window[500] used"
else
  fail "after-new-window[500] not found"
fi
if echo "$MOCK_TMUX_HOOKS" | grep -q 'pane-exited\[500\]'; then
  pass "pane-exited[500] used"
else
  fail "pane-exited[500] not found"
fi
# FLY-110: pane-died MUST also be registered (in register_global_hooks).
# Production sets `remain-on-exit on` on Runner/Lead sessions, where tmux
# 3.5a fires `pane-died` (not `pane-exited`) when the pane process exits.
# In tmux 3.5a, pane-died only fires when registered globally — session-
# scoped registration is silently ignored by the hook dispatcher.
reset_mocks
register_global_hooks >/dev/null
if echo "$MOCK_TMUX_HOOKS" | grep -q 'pane-died\[500\]'; then
  pass "pane-died[500] registered globally (FLY-110 fix)"
else
  fail "pane-died[500] not registered globally — production path with remain-on-exit on will not fire (FLY-110)"
fi
# pane-died MUST NOT be registered session-scoped — that registration is
# silently dropped by tmux 3.5a's hook dispatcher.
reset_mocks
register_session_hooks "flywheel" >/dev/null
if echo "$MOCK_TMUX_HOOKS" | grep -q 'pane-died\[500\]'; then
  fail "pane-died[500] should not be registered session-scoped (tmux 3.5a drops it silently); register globally instead"
else
  pass "pane-died not registered session-scoped (correct — tmux 3.5a only fires global pane-died)"
fi

# ════════════════════════════════════════════════════════════════
# Test 3: Hook command embeds format vars, not $(date ...)
# ════════════════════════════════════════════════════════════════
echo "Test: hook command does not embed shell-expanded timestamp"
reset_mocks
register_session_hooks "flywheel" >/dev/null

if echo "$MOCK_TMUX_HOOKS" | grep -q '#{session_name}'; then
  pass "hook uses #{session_name} format var"
else
  fail "hook missing #{session_name} (should use plain var, not #{hook_session_name} — see QA regression)"
fi
# #{hook_session_name} expands to EMPTY under run-shell -b in tmux 3.5a —
# QA-caught regression. Guard against its reintroduction.
if echo "$MOCK_TMUX_HOOKS" | grep -q '#{hook_session_name}\|#{hook_window_name}\|#{hook_window}[^_]'; then
  fail "hook uses #{hook_*} format var that expands to empty in tmux 3.5a"
else
  pass "hook avoids broken #{hook_*} format vars"
fi
# Make sure no numeric timestamp was baked in (would indicate shell expansion)
if echo "$MOCK_TMUX_HOOKS" | grep -qE '\|[0-9]{10}\|'; then
  fail "hook command contains baked-in timestamp (register-time expansion)"
else
  pass "no baked-in timestamp in hook command"
fi

# ════════════════════════════════════════════════════════════════
# Test 4: mark_for_cleanup is idempotent
# ════════════════════════════════════════════════════════════════
echo "Test: mark_for_cleanup idempotency"
reset_mocks
mark_for_cleanup "worker-fly-102" 1000
mark_for_cleanup "worker-fly-102" 1100  # duplicate
mark_for_cleanup "qa-fly-102" 1050

count=$(wc -l < "$CLEANUP_PENDING" | tr -d ' ')
if [[ "$count" == "2" ]]; then
  pass "duplicate mark_for_cleanup does not add second entry (got $count)"
else
  fail "expected 2 entries, got $count"
fi
# First timestamp retained (not overwritten)
first_ts=$(grep "^worker-fly-102|" "$CLEANUP_PENDING" | cut -d'|' -f2)
if [[ "$first_ts" == "1000" ]]; then
  pass "first-seen timestamp retained on duplicate"
else
  fail "timestamp changed on duplicate: got $first_ts"
fi

# ════════════════════════════════════════════════════════════════
# Test 5: process_pending_cleanups respects delay
# ════════════════════════════════════════════════════════════════
echo "Test: process_pending_cleanups — 30s delay"
reset_mocks
now=$(date +%s)
recent=$((now - 5))      # 5s ago
expired=$((now - 60))    # 60s ago
mark_for_cleanup "recent-win" "$recent"
mark_for_cleanup "expired-win" "$expired"

# No matching sessions, so is_pane_alive returns false for both
MOCK_TMUX_WINDOWS=""
MOCK_TMUX_SESSIONS=""

process_pending_cleanups >/dev/null

# "recent-win" should still be pending
if grep -q "^recent-win|" "$CLEANUP_PENDING" 2>/dev/null; then
  pass "recent entry preserved (< 30s)"
else
  fail "recent entry erroneously cleaned up"
fi
# "expired-win" should be cleaned (removed from pending)
if grep -q "^expired-win|" "$CLEANUP_PENDING" 2>/dev/null; then
  fail "expired entry not cleaned up"
else
  pass "expired entry cleaned up (>= 30s)"
fi
# kill-session called for expired-win's linked session
if echo "$MOCK_TMUX_KILLED" | grep -q "=cmux-expired-win"; then
  pass "linked session cmux-expired-win killed"
else
  fail "expected kill-session =cmux-expired-win. Got: $MOCK_TMUX_KILLED"
fi

# ════════════════════════════════════════════════════════════════
# Test 6: process_pending_cleanups cancels on pane restart
# ════════════════════════════════════════════════════════════════
echo "Test: pane restart cancels pending cleanup"
reset_mocks
now=$(date +%s)
expired=$((now - 60))
mark_for_cleanup "restart-win" "$expired"

# Simulate pane came back alive
MOCK_TMUX_WINDOWS="flywheel|@1|restart-win"
MOCK_PANE_DEAD="flywheel:restart-win=0"

process_pending_cleanups >/dev/null

if grep -q "^restart-win|" "$CLEANUP_PENDING" 2>/dev/null; then
  fail "pending entry should be dropped when pane alive"
else
  pass "pending entry dropped when pane alive"
fi
if echo "$MOCK_TMUX_KILLED" | grep -q "cmux-restart-win"; then
  fail "should not kill linked session when pane alive"
else
  pass "linked session untouched when pane alive"
fi

# ════════════════════════════════════════════════════════════════
# Test 7: is_pane_alive with remain-on-exit (window exists, pane dead)
# ════════════════════════════════════════════════════════════════
echo "Test: is_pane_alive respects #{pane_dead}"
reset_mocks
MOCK_TMUX_WINDOWS="flywheel|@1|dead-win"
MOCK_PANE_DEAD="flywheel:dead-win=1"

if is_pane_alive "dead-win"; then
  fail "is_pane_alive returned true for dead pane"
else
  pass "is_pane_alive returns false for dead pane despite window existing"
fi

MOCK_PANE_DEAD="flywheel:dead-win=0"
if is_pane_alive "dead-win"; then
  pass "is_pane_alive returns true for live pane"
else
  fail "is_pane_alive returned false for live pane"
fi

# Missing window → dead
MOCK_TMUX_WINDOWS=""
if is_pane_alive "ghost-win"; then
  fail "is_pane_alive returned true for missing window"
else
  pass "is_pane_alive returns false for missing window"
fi

# ════════════════════════════════════════════════════════════════
# Test 8: drain_events dispatches by event type + session filter
# ════════════════════════════════════════════════════════════════
echo "Test: drain_events dispatches correctly"
reset_mocks
# Pre-populate event file with mixed events
cat > "$EVENT_FILE" <<'EOF'
create|flywheel|@42|worker-fly-102
create|runner-geoforge3d|@43|runner-task-1
create|flywheel|@44|zsh
create|unrelated|@45|should-skip
exited|flywheel|worker-fly-102
exited|unrelated|should-skip
register|runner-new
register|not-a-runner
EOF
# Ensure workspace_exists_for returns false so create_workspace_for_window is called
MOCK_CMUX_WORKSPACES=""
# For register path: register_session_hooks will inspect name
MOCK_TMUX_SESSIONS=""

drain_events >/dev/null

# create events: should trigger new-workspace twice (worker-fly-102 + runner-task-1)
create_count=$(echo "$MOCK_CMUX_OPS" | grep -c "^new-workspace" || true)
if [[ "$create_count" == "2" ]]; then
  pass "drain_events creates workspaces for 2 valid sessions"
else
  fail "expected 2 new-workspace calls, got $create_count. Ops: $MOCK_CMUX_OPS"
fi
# zsh filtered
if echo "$MOCK_CMUX_OPS" | grep -q "zsh"; then
  fail "zsh window should be filtered"
else
  pass "zsh window filtered from create path"
fi
# unrelated session filtered
if echo "$MOCK_CMUX_OPS" | grep -q "should-skip"; then
  fail "unrelated session's window should be filtered"
else
  pass "unrelated session filtered from create path"
fi
# exited event → marks for cleanup
if grep -q "^worker-fly-102|" "$CLEANUP_PENDING" 2>/dev/null; then
  pass "exited event marks window for cleanup"
else
  fail "exited event did not mark for cleanup"
fi
# exited for unrelated session skipped
if grep -q "^should-skip|" "$CLEANUP_PENDING" 2>/dev/null; then
  fail "unrelated exited event should be skipped"
else
  pass "unrelated exited event skipped"
fi
# register event → hook registered for runner-new only
if echo "$MOCK_TMUX_HOOKS" | grep -q "runner-new"; then
  pass "register event → runner-new hook registered"
else
  fail "runner-new hook not registered"
fi
if echo "$MOCK_TMUX_HOOKS" | grep -q "not-a-runner"; then
  fail "register event → not-a-runner should be filtered"
else
  pass "register event filters non-flywheel/runner-* sessions"
fi
# Event file consumed
if [[ -f "$EVENT_FILE" ]]; then
  fail "event file should be removed after drain"
else
  pass "event file consumed"
fi

# ════════════════════════════════════════════════════════════════
# Test 9: cleanup_stale_conservative uses 5-minute threshold
# ════════════════════════════════════════════════════════════════
echo "Test: cleanup_stale_conservative — 5min threshold"
reset_mocks
# linked session exists; its corresponding tmux window doesn't
MOCK_TMUX_WINDOWS=""
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-orphan-win'
MOCK_CMUX_WORKSPACES="  workspace:3  orphan-win"

# First pass — marker gets recorded, no cleanup yet
cleanup_stale_conservative >/dev/null
if grep -q "^orphan-win|" "$STALE_STATE" 2>/dev/null; then
  pass "first-seen stale marker written"
else
  fail "stale marker not written"
fi
if echo "$MOCK_TMUX_KILLED" | grep -q "cmux-orphan-win"; then
  fail "should not cleanup on first detection"
else
  pass "first detection does not cleanup"
fi

# Simulate >5min later by rewriting marker in the past
now=$(date +%s)
past=$((now - 400))
printf 'orphan-win|%s\n' "$past" > "$STALE_STATE"

cleanup_stale_conservative >/dev/null
if echo "$MOCK_TMUX_KILLED" | grep -q "=cmux-orphan-win"; then
  pass "conservative cleanup fires after 5min"
else
  fail "expected kill-session =cmux-orphan-win. Got: $MOCK_TMUX_KILLED"
fi

# ════════════════════════════════════════════════════════════════
# Test 10: cleanup_stale_conservative clears marker when pane alive
# ════════════════════════════════════════════════════════════════
echo "Test: cleanup_stale_conservative clears marker on pane-alive return"
reset_mocks
# Pane alive → marker should be cleared
MOCK_TMUX_WINDOWS="flywheel|@1|returned-win"
MOCK_PANE_DEAD="flywheel:returned-win=0"
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-returned-win'
MOCK_CMUX_WORKSPACES=""
now=$(date +%s)
past=$((now - 200))
printf 'returned-win|%s\n' "$past" > "$STALE_STATE"

cleanup_stale_conservative >/dev/null

if grep -q "^returned-win|" "$STALE_STATE" 2>/dev/null; then
  fail "marker should be cleared when pane alive"
else
  pass "marker cleared when pane alive"
fi

# ════════════════════════════════════════════════════════════════
# Test 11: cleanup_stale_conservative treats dead pane (remain-on-exit) as stale
# ════════════════════════════════════════════════════════════════
echo "Test: cleanup_stale_conservative — dead pane with window still listed"
reset_mocks
# remain-on-exit: window still in list-windows, but pane is dead → should mark stale
MOCK_TMUX_WINDOWS="flywheel|@1|dead-pane-win"
MOCK_PANE_DEAD="flywheel:dead-pane-win=1"
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-dead-pane-win'
MOCK_CMUX_WORKSPACES=""

# First pass: mark stale
cleanup_stale_conservative >/dev/null
if grep -q "^dead-pane-win|" "$STALE_STATE" 2>/dev/null; then
  pass "dead-pane window marked stale despite window existing (remain-on-exit path)"
else
  fail "dead-pane window not marked stale — event-loss fallback would leak"
fi

# Fast-forward the marker by 6 minutes → cleanup should fire
now=$(date +%s)
past=$((now - 400))
printf 'dead-pane-win|%s\n' "$past" > "$STALE_STATE"
cleanup_stale_conservative >/dev/null
if echo "$MOCK_TMUX_KILLED" | grep -q "=cmux-dead-pane-win"; then
  pass "dead-pane window cleaned up after threshold (closes event-loss leak)"
else
  fail "expected cleanup of dead-pane-win after 5min. Got: $MOCK_TMUX_KILLED"
fi

# ════════════════════════════════════════════════════════════════
# Test 12: drain_events replays leftover .processing after a crash
# ════════════════════════════════════════════════════════════════
echo "Test: drain_events crash recovery replays .processing leftover"
reset_mocks
# Simulate prior crash: .processing holds an exited event, $EVENT_FILE doesn't exist.
printf 'exited|flywheel|crashed-win\n' > "${EVENT_FILE}.processing"
# No windows/sessions — is_pane_alive returns false → exited will mark for cleanup
MOCK_TMUX_WINDOWS=""
MOCK_TMUX_SESSIONS=""

drain_events >/dev/null

if grep -q "^crashed-win|" "$CLEANUP_PENDING" 2>/dev/null; then
  pass "leftover .processing event replayed (no event loss across crash)"
else
  fail "leftover .processing event lost"
fi
if [[ -f "${EVENT_FILE}.processing" ]]; then
  fail ".processing should be cleaned up after replay"
else
  pass ".processing cleaned after replay"
fi

# ════════════════════════════════════════════════════════════════
# Test 13: drain_events merges .processing with new events on recovery
# ════════════════════════════════════════════════════════════════
echo "Test: drain_events merges leftover + fresh events"
reset_mocks
# Leftover from prior crash + fresh event arrived since
printf 'exited|flywheel|old-win\n' > "${EVENT_FILE}.processing"
printf 'exited|flywheel|new-win\n' > "$EVENT_FILE"
MOCK_TMUX_WINDOWS=""
MOCK_TMUX_SESSIONS=""

drain_events >/dev/null

if grep -q "^old-win|" "$CLEANUP_PENDING" 2>/dev/null && grep -q "^new-win|" "$CLEANUP_PENDING" 2>/dev/null; then
  pass "both old (leftover) and new events processed"
else
  fail "expected both old-win and new-win in pending. Got: $(cat "$CLEANUP_PENDING" 2>/dev/null)"
fi

# ════════════════════════════════════════════════════════════════
# Integration: real tmux hook expansion
# ════════════════════════════════════════════════════════════════
# Regression guard for the tmux 3.5a hook var trap — QA found that
# #{hook_session_name} / #{hook_window_name} / #{hook_window} expand to EMPTY
# under `run-shell -b` for after-new-window / pane-exited, even though the
# man page lists them. This test fires the real hook command strings against
# a real tmux session and asserts the resulting event lines have non-empty
# fields. The pure-mock tests above cannot catch this because they stub tmux.
echo "Test: real tmux hook expansion (integration)"

if ! command -v tmux >/dev/null 2>&1; then
  echo "  ⏭  tmux not available — skipping"
else
  # Sourced flywheel-cmux-sync.sh sets `set -euo pipefail`; disable errexit
  # here so non-zero exits from tmux operations don't abort the test script.
  set +e
  TMUX_INT_EVENT_FILE="$TMPDIR_ROOT/int-events"
  TMUX_INT_SESSION="flywheel-cmux-sync-test-$$"
  > "$TMUX_INT_EVENT_FILE"

  # Use `command tmux` throughout to bypass the mock function defined above.
  command tmux kill-session -t "$TMUX_INT_SESSION" 2>/dev/null
  # FLY-129 R2: some sandboxes (AppArmor / restricted /tmp / codex review env)
  # reject tmux's socket creation. Probe + skip gracefully instead of failing.
  if ! command tmux new-session -d -s "$TMUX_INT_SESSION" -n initial 2>/dev/null; then
    echo "  ⏭  tmux new-session failed (sandbox / restricted env) — skipping integration test"
  else

  # Exact hook command strings from register_session_hooks / register_global_hooks.
  command tmux set-hook -t "$TMUX_INT_SESSION" 'after-new-window[500]' \
    "run-shell -b 'echo \"create|#{session_name}|#{window_id}|#{window_name}\" >> $TMUX_INT_EVENT_FILE'" 2>/dev/null
  command tmux set-hook -t "$TMUX_INT_SESSION" 'pane-exited[500]' \
    "run-shell -b 'echo \"exited|#{session_name}|#{window_name}\" >> $TMUX_INT_EVENT_FILE'" 2>/dev/null

  # Trigger after-new-window.
  command tmux new-window -t "$TMUX_INT_SESSION:" -n int-test-win 2>/dev/null
  # Give run-shell -b a moment to flush.
  sleep 0.3

  create_line=$(grep '^create|' "$TMUX_INT_EVENT_FILE" 2>/dev/null | head -1)
  if [[ -z "$create_line" ]]; then
    fail "no create event written to event file"
  else
    IFS='|' read -r _etype sess wid wname <<< "$create_line"
    if [[ -n "$sess" && -n "$wid" && -n "$wname" ]]; then
      pass "create event fields non-empty (sess=$sess wid=$wid wname=$wname)"
    else
      fail "create event has empty fields: sess='$sess' wid='$wid' wname='$wname'"
    fi
    if [[ "$sess" == "$TMUX_INT_SESSION" ]]; then
      pass "session_name expands to the session where hook fired"
    else
      fail "expected session=$TMUX_INT_SESSION, got session=$sess"
    fi
    if [[ "$wname" == "int-test-win" ]]; then
      pass "window_name expands to the new window"
    else
      fail "expected window_name=int-test-win, got window_name=$wname"
    fi
  fi

  command tmux kill-session -t "$TMUX_INT_SESSION" 2>/dev/null || true
  fi  # tmux new-session probe close
fi

# ════════════════════════════════════════════════════════════════
# FLY-129: cmux IPC health check + cmux_call wrapper
# ════════════════════════════════════════════════════════════════

# Helper: probe whether AF_UNIX socket creation works in this environment.
# Some sandboxes (codex review env, certain CI setups) deny AF_UNIX bind.
# Tests requiring a real socket should skip gracefully when this returns 1.
_can_bind_af_unix() {
  command -v python3 >/dev/null 2>&1 || return 1
  local probe="$TMPDIR_ROOT/.afunix-probe.$$"
  rm -f "$probe"
  python3 - "$probe" >/dev/null 2>&1 <<'PY'
import socket, sys
try:
    s = socket.socket(socket.AF_UNIX)
    s.bind(sys.argv[1])
    s.close()
    sys.exit(0)
except Exception:
    sys.exit(1)
PY
  local rc=$?
  rm -f "$probe"
  [[ $rc -eq 0 ]]
}

# Helper: spawn a python Unix-socket listener (creates the socket file).
# Echoes the PID on stdout. Caller is responsible for kill + wait + rm.
#
# Important: redirect python stdout/stderr away from the command-substitution
# capture pipe. Otherwise the long-running background process inherits that
# pipe and `pid=$(_spawn_unix_socket ...)` won't return until python exits.
_spawn_unix_socket() {
  local path="$1"
  python3 - "$path" >/dev/null 2>&1 <<'PY' &
import socket, sys, time
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])
s.listen(1)
time.sleep(60)
PY
  local pid=$!
  local deadline=$((SECONDS + 5))
  while [[ ! -S "$path" && $SECONDS -lt $deadline ]]; do
    sleep 0.05
  done
  if [[ ! -S "$path" ]]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    return 1
  fi
  echo "$pid"
}

_kill_unix_socket() {
  local pid="$1" path="$2"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f "$path"
}

# Save / restore the global cmux mock so per-test overrides don't leak.
_SAVED_CMUX_MOCK=""
_save_cmux_mock() { _SAVED_CMUX_MOCK="$(declare -f cmux 2>/dev/null || true)"; }
_restore_cmux_mock() {
  unset -f cmux 2>/dev/null || true
  if [[ -n "$_SAVED_CMUX_MOCK" ]]; then
    eval "$_SAVED_CMUX_MOCK"
  fi
}

test_health_check_no_socket() {
  echo "▶ test_health_check_no_socket"
  local fake_socket="$TMPDIR_ROOT/no-such-socket"
  rm -f "$fake_socket"
  local rc=0
  CMUX_SOCKET_PATH="$fake_socket" cmux_health_check 2>/dev/null || rc=$?
  if [[ $rc -eq 1 ]]; then pass "missing socket → rc=1"; else fail "expected rc=1, got $rc"; fi
}

test_health_check_auth_rejected() {
  echo "▶ test_health_check_auth_rejected"
  if ! _can_bind_af_unix; then
    echo "  (skipped: AF_UNIX bind unavailable in this environment)"
    return 0
  fi
  local fake_socket="$TMPDIR_ROOT/cmux-fake-auth.sock"
  rm -f "$fake_socket"
  local server_pid
  if ! server_pid=$(_spawn_unix_socket "$fake_socket"); then
    echo "  (skipped: could not bind AF_UNIX socket — sandbox or permission issue)"
    return 0
  fi
  _save_cmux_mock
  cmux() {
    if [[ "$1" == "--socket" ]]; then shift 2; fi
    if [[ "$1" == "ping" ]]; then
      echo "ERROR: Access denied — only processes started inside cmux can connect" >&2
      return 141
    fi
    return 0
  }
  local rc=0
  CMUX_SOCKET_PATH="$fake_socket" cmux_health_check 2>/dev/null || rc=$?
  _restore_cmux_mock
  _kill_unix_socket "$server_pid" "$fake_socket"
  if [[ $rc -eq 2 ]]; then pass "auth rejected → rc=2"; else fail "expected rc=2, got $rc"; fi
}

test_health_check_healthy() {
  echo "▶ test_health_check_healthy"
  if ! _can_bind_af_unix; then
    echo "  (skipped: AF_UNIX bind unavailable in this environment)"
    return 0
  fi
  local fake_socket="$TMPDIR_ROOT/cmux-fake-healthy.sock"
  rm -f "$fake_socket"
  local server_pid
  if ! server_pid=$(_spawn_unix_socket "$fake_socket"); then
    echo "  (skipped: could not bind AF_UNIX socket — sandbox or permission issue)"
    return 0
  fi
  _save_cmux_mock
  cmux() {
    if [[ "$1" == "--socket" ]]; then shift 2; fi
    [[ "$1" == "ping" ]] && echo "PONG" && return 0
    return 0
  }
  local rc=0
  CMUX_SOCKET_PATH="$fake_socket" cmux_health_check 2>/dev/null || rc=$?
  _restore_cmux_mock
  _kill_unix_socket "$server_pid" "$fake_socket"
  if [[ $rc -eq 0 ]]; then pass "healthy → rc=0"; else fail "expected rc=0, got $rc"; fi
}

test_health_check_transient_error() {
  echo "▶ test_health_check_transient_error"
  if ! _can_bind_af_unix; then
    echo "  (skipped: AF_UNIX bind unavailable in this environment)"
    return 0
  fi
  local fake_socket="$TMPDIR_ROOT/cmux-fake-transient.sock"
  rm -f "$fake_socket"
  local server_pid
  if ! server_pid=$(_spawn_unix_socket "$fake_socket"); then
    echo "  (skipped: could not bind AF_UNIX socket — sandbox or permission issue)"
    return 0
  fi
  _save_cmux_mock
  cmux() {
    if [[ "$1" == "--socket" ]]; then shift 2; fi
    if [[ "$1" == "ping" ]]; then
      echo "Error: Failed to connect to socket" >&2
      return 1
    fi
    return 0
  }
  local rc=0
  CMUX_SOCKET_PATH="$fake_socket" cmux_health_check 2>/dev/null || rc=$?
  _restore_cmux_mock
  _kill_unix_socket "$server_pid" "$fake_socket"
  if [[ $rc -eq 3 ]]; then pass "transient → rc=3"; else fail "expected rc=3, got $rc"; fi
}

test_cmux_call_stdout_passthrough() {
  echo "▶ test_cmux_call_stdout_passthrough"
  _save_cmux_mock
  cmux() {
    if [[ "$1" == "--socket" ]]; then shift 2; fi
    echo "workspace:1  alpha"
    echo "workspace:2  beta"
    return 0
  }
  local out
  out=$(cmux_call list-workspaces 2>/dev/null)
  _restore_cmux_mock
  if [[ "$out" == *"workspace:1  alpha"* && "$out" == *"workspace:2  beta"* ]]; then
    pass "stdout preserved through cmux_call wrapper"
  else
    fail "stdout mangled: '$out'"
  fi
}

test_cmux_call_stderr_logged_not_in_stdout() {
  echo "▶ test_cmux_call_stderr_logged_not_in_stdout"
  _save_cmux_mock
  cmux() {
    if [[ "$1" == "--socket" ]]; then shift 2; fi
    echo "fake-stdout-line"
    echo "fake-stderr-line" >&2
    return 7
  }
  local out err
  err=$(mktemp)
  out=$(cmux_call list-workspaces 2>"$err") || true
  local err_content
  err_content=$(cat "$err")
  rm -f "$err"
  _restore_cmux_mock
  if [[ "$out" == *"fake-stdout-line"* ]] \
     && [[ "$err_content" == *"fake-stderr-line"* ]] \
     && [[ "$out" != *"fake-stderr-line"* ]]; then
    pass "stdout passes through, stderr captured to log (not stdout)"
  else
    fail "out='$out' err='$err_content'"
  fi
}

echo ""
echo "═══ FLY-129: cmux IPC health check + cmux_call ═══"
test_health_check_no_socket
test_health_check_auth_rejected
test_health_check_healthy
test_health_check_transient_error
test_cmux_call_stdout_passthrough
test_cmux_call_stderr_logged_not_in_stdout

# ════════════════════════════════════════════════════════════════
# FLY-129 Phase 1: watcher lock + sync_once watcher detection
# ════════════════════════════════════════════════════════════════
#
# acquire_watcher_lock calls `exit 0` on already-running and on retry
# exhaustion. We must run it inside a subshell so the test runner survives.
# Subshells inherit BASH_VERSION 3.2 — fine for our $$ comparisons (we use $!
# parent PID, not BASHPID, which is bash-4 only).

run_acquire_subshell() {
  # Returns: exit code of the subshell. Captures stderr (log()).
  local out_file="$1"
  ( acquire_watcher_lock ) >/dev/null 2>"$out_file"
  return $?
}

test_lock_acquire_blocks_second() {
  echo "Test: lock_acquire_blocks_second"
  reset_mocks
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  echo "$$" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"
  local stderr_file="$TMPDIR_ROOT/acq.stderr"
  if run_acquire_subshell "$stderr_file" && grep -q "watcher already running" "$stderr_file"; then
    pass "second acquire sees alive owner, exits 0 with 'already running' log"
  else
    fail "expected exit 0 + 'watcher already running' (stderr: $(cat "$stderr_file"))"
  fi
  # Ensure the lock dir still contains our PID — no fresh dir was created.
  local pid_in_lock
  pid_in_lock=$(cat "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid" 2>/dev/null || echo "")
  if [[ "$pid_in_lock" == "$$" ]]; then
    pass "lock dir untouched (PID file still contains original owner)"
  else
    fail "lock dir was modified — pid_in_lock='$pid_in_lock' expected '$$'"
  fi
}

test_lock_acquire_stale_pid_clean() {
  echo "Test: lock_acquire_stale_pid_clean"
  reset_mocks
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  # 999999 is virtually guaranteed not to be a live PID on macOS.
  echo "999999" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"
  local stderr_file="$TMPDIR_ROOT/acq.stderr"
  # We can't easily call acquire then watch the trap fire (subshell exits
  # cleanly via `return 0`). Run as subshell — the trap fires on exit and
  # clears the lock dir. Check the pid file mid-run is hard; instead verify
  # that no "already running" log was emitted and that the subshell exit
  # was 0 (acquire success).
  if run_acquire_subshell "$stderr_file"; then
    if ! grep -q "already running" "$stderr_file"; then
      pass "stale PID reaped, fresh acquire succeeded"
    else
      fail "stale-PID path took the 'already running' branch (stderr: $(cat "$stderr_file"))"
    fi
  else
    fail "stale-PID acquire path did not return 0 (stderr: $(cat "$stderr_file"))"
  fi
}

test_lock_release_only_owns() {
  echo "Test: lock_release_only_owns"
  reset_mocks
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  echo "99999" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"  # not us
  release_watcher_lock
  if [[ -d "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" ]]; then
    pass "release_watcher_lock does NOT delete a dir owned by another PID"
  else
    fail "release_watcher_lock deleted a dir we didn't own — pid file said 99999, not $$"
  fi
}

test_lock_acquire_mkdir_fails_after_reap() {
  # R2-3: after reaping stale lock, mkdir of the lock dir can fail if a
  # contender slips in. We can't reliably orchestrate a real race in a unit
  # test, so we simulate: pre-create $WATCHER_REAP_MUTEX so the first
  # iteration's `mkdir reap_mutex` fails → sleep 1 → next iteration. Across
  # 3 attempts we exhaust and exit 0. This validates BOTH the
  # mkdir-of-reap-mutex failure branch AND the bounded retry loop.
  echo "Test: lock_acquire_mkdir_fails_after_reap (R2-3 retry exhaustion)"
  reset_mocks
  # Pre-stale the lock dir with a dead PID so we'd want to reap...
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  echo "999999" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"
  # ...but a contender holds the reap mutex the whole time.
  mkdir -p "$WATCHER_REAP_MUTEX"
  local stderr_file="$TMPDIR_ROOT/acq.stderr"
  # Override sleep to no-op so this test doesn't take 3 real seconds.
  sleep() { :; }
  export -f sleep
  if run_acquire_subshell "$stderr_file"; then
    if grep -q "exhausted retries" "$stderr_file"; then
      pass "3 attempts exhausted, exit 0 + 'exhausted retries' log"
    else
      fail "did not log 'exhausted retries' (stderr: $(cat "$stderr_file"))"
    fi
  else
    fail "exhaustion path did not exit 0 — got non-zero (stderr: $(cat "$stderr_file"))"
  fi
  unset -f sleep
  rmdir "$WATCHER_REAP_MUTEX" 2>/dev/null || true
}

test_lock_acquire_retries_bounded() {
  # Same setup as above, but assert that the subshell completes in bounded
  # time (no infinite loop). Our override of `sleep` makes this trivial; the
  # real safeguard is the `for attempt in 1 2 3` loop.
  echo "Test: lock_acquire_retries_bounded (does not infinite loop)"
  reset_mocks
  mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
  echo "999999" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"
  mkdir -p "$WATCHER_REAP_MUTEX"
  sleep() { :; }
  export -f sleep
  local stderr_file="$TMPDIR_ROOT/acq.stderr"
  local t_start t_end
  t_start=$(date +%s)
  run_acquire_subshell "$stderr_file" || true
  t_end=$(date +%s)
  if (( t_end - t_start < 5 )); then
    pass "subshell exited in <5s (no infinite loop)"
  else
    fail "subshell took $((t_end - t_start))s (suspected infinite loop)"
  fi
  unset -f sleep
  rmdir "$WATCHER_REAP_MUTEX" 2>/dev/null || true
}

test_once_detects_watcher() {
  # Research §3.3 Option b: --once must short-circuit when --watch is running.
  echo "Test: once_detects_watcher"
  reset_mocks
  MOCK_PGREP_HIT="1"
  local stderr_file="$TMPDIR_ROOT/once.stderr"
  # sync_once contains `exit 0` on the detect branch → run in subshell.
  ( sync_once ) >/dev/null 2>"$stderr_file"
  local rc=$?
  if [[ $rc -eq 0 ]] && grep -q -- "--refresh" "$stderr_file"; then
    pass "subshell exit 0 + stderr suggests --refresh"
  else
    fail "rc=$rc stderr=$(cat "$stderr_file")"
  fi
}

echo ""
echo "═══ FLY-129 Phase 1: watcher lock + --once watcher detect ═══"
test_lock_acquire_blocks_second
test_lock_acquire_stale_pid_clean
test_lock_release_only_owns
test_lock_acquire_mkdir_fails_after_reap
test_lock_acquire_retries_bounded
test_once_detects_watcher

# ════════════════════════════════════════════════════════════════
# FLY-129 Phase 2: register_session_hooks idempotent + log silence
# ════════════════════════════════════════════════════════════════

test_hooks_present_silent() {
  echo "Test: hooks_present_silent (no re-register, no log spam)"
  reset_mocks
  # Both hooks already present at index [500] — Phase 2 should be silent.
  MOCK_SHOW_HOOKS=$'after-new-window[500] run-shell -b "..."\npane-exited[500] run-shell -b "..."\n'
  local stderr_file="$TMPDIR_ROOT/hooks.stderr"
  register_session_hooks "flywheel" 2>"$stderr_file"
  if [[ -z "$MOCK_TMUX_HOOKS" ]]; then
    pass "no tmux set-hook calls when both hooks already present"
  else
    fail "expected zero set-hook calls; got: $MOCK_TMUX_HOOKS"
  fi
  if ! grep -q "registered" "$stderr_file"; then
    pass "no '(re-)registered' log line emitted"
  else
    fail "expected silent; got log: $(cat "$stderr_file")"
  fi
}

test_hooks_missing_reregister() {
  echo "Test: hooks_missing_reregister (was 0/2)"
  reset_mocks
  MOCK_SHOW_HOOKS=""
  local stderr_file="$TMPDIR_ROOT/hooks.stderr"
  register_session_hooks "flywheel" 2>"$stderr_file"
  if echo "$MOCK_TMUX_HOOKS" | grep -q 'after-new-window\[500\]' \
     && echo "$MOCK_TMUX_HOOKS" | grep -q 'pane-exited\[500\]'; then
    pass "both hooks re-registered when missing"
  else
    fail "missing one or both hooks; got: $MOCK_TMUX_HOOKS"
  fi
  if grep -q "was 0/2" "$stderr_file"; then
    pass "log emits 'was 0/2'"
  else
    fail "expected 'was 0/2'; got: $(cat "$stderr_file")"
  fi
}

test_hooks_partial_reregister() {
  echo "Test: hooks_partial_reregister (was 1/2)"
  reset_mocks
  # Only after-new-window present; pane-exited missing.
  MOCK_SHOW_HOOKS=$'after-new-window[500] run-shell -b "..."\n'
  local stderr_file="$TMPDIR_ROOT/hooks.stderr"
  register_session_hooks "flywheel" 2>"$stderr_file"
  # Only pane-exited should have been (re-)set; after-new-window untouched.
  if echo "$MOCK_TMUX_HOOKS" | grep -q 'pane-exited\[500\]'; then
    pass "missing hook (pane-exited) was set"
  else
    fail "pane-exited not set; got: $MOCK_TMUX_HOOKS"
  fi
  if echo "$MOCK_TMUX_HOOKS" | grep -q 'after-new-window\[500\]'; then
    fail "after-new-window should NOT be re-set (was already present)"
  else
    pass "after-new-window left alone (already present)"
  fi
  if grep -q "was 1/2" "$stderr_file"; then
    pass "log emits 'was 1/2'"
  else
    fail "expected 'was 1/2'; got: $(cat "$stderr_file")"
  fi
}

echo ""
echo "═══ FLY-129 Phase 2: register_session_hooks idempotent + log silence ═══"
test_hooks_present_silent
test_hooks_missing_reregister
test_hooks_partial_reregister

# ════════════════════════════════════════════════════════════════
# FLY-129 Phase 3: JSON-based reverse-index + fail-closed callers
# ════════════════════════════════════════════════════════════════

JSON_TWO_DUP='{"workspaces":[{"ref":"workspace:1","title":"foo"},{"ref":"workspace:29","title":"foo"}]}'
JSON_WHITESPACE_TITLE='{"workspaces":[{"ref":"workspace:7","title":"foo bar baz"}]}'
JSON_GHOST_MIXED='{"workspaces":[{"ref":"workspace:10","title":null},{"ref":"workspace:11","title":"~"},{"ref":"workspace:12","title":""},{"ref":"workspace:13","title":"keep-me"}]}'

test_get_cmux_workspaces_json_fail_closed_rc_nonzero() {
  echo "Test: get_cmux_workspaces_json_fail_closed_rc_nonzero (R2-1)"
  reset_mocks
  MOCK_CMUX_JSON_FAIL="1"
  local stderr_file="$TMPDIR_ROOT/json.stderr"
  local out rc=0
  out=$(get_cmux_workspaces_json 2>"$stderr_file") || rc=$?
  if [[ $rc -ne 0 && -z "$out" ]]; then
    pass "rc=$rc + empty stdout on cmux failure"
  else
    fail "expected non-zero + empty stdout; rc=$rc out='$out'"
  fi
  if [[ $(grep -c "cmux mutation skipped" "$stderr_file") == "1" ]]; then
    pass "exactly one transition log emitted"
  else
    fail "expected 1 transition log; got: $(cat "$stderr_file")"
  fi
}

test_get_cmux_workspaces_json_fail_closed_invalid_json() {
  echo "Test: get_cmux_workspaces_json_fail_closed_invalid_json (R2-1)"
  reset_mocks
  MOCK_CMUX_JSON_INVALID="1"
  local stderr_file="$TMPDIR_ROOT/json.stderr"
  local rc=0
  get_cmux_workspaces_json >/dev/null 2>"$stderr_file" || rc=$?
  if [[ $rc -ne 0 ]] && grep -q "invalid JSON" "$stderr_file"; then
    pass "invalid JSON → rc!=0 + 'invalid JSON' log"
  else
    fail "rc=$rc stderr=$(cat "$stderr_file")"
  fi
}

test_get_cmux_workspaces_json_recover_logs_once() {
  echo "Test: get_cmux_workspaces_json_recover_logs_once (R2-1)"
  reset_mocks
  MOCK_CMUX_JSON_FAIL="1"
  local stderr_file="$TMPDIR_ROOT/json-recover.stderr"
  rm -f "$stderr_file"  # don't accumulate from prior tests
  # 5 consecutive failures — first emits log, next 4 are silent.
  for _ in 1 2 3 4 5; do
    get_cmux_workspaces_json >/dev/null 2>>"$stderr_file" || true
  done
  local fail_logs
  fail_logs=$(grep -c "cmux mutation skipped" "$stderr_file" || true)
  if [[ "$fail_logs" == "1" ]]; then
    pass "5 consecutive failures → exactly 1 transition log"
  else
    fail "expected 1 log, got $fail_logs"
  fi
  # Recovery → 1 line "recovered"
  MOCK_CMUX_JSON_FAIL="0"
  get_cmux_workspaces_json >/dev/null 2>>"$stderr_file"
  if grep -q "recovered" "$stderr_file"; then
    pass "recovery emits 'recovered' log"
  else
    fail "no 'recovered' log; stderr=$(cat "$stderr_file")"
  fi
}

test_workspace_refs_for_dup() {
  echo "Test: workspace_refs_for_dup (multi-line return)"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON="$JSON_TWO_DUP"
  local refs rc=0
  refs=$(workspace_refs_for "foo") || rc=$?
  if [[ $rc -eq 0 ]] && [[ "$refs" == *"workspace:1"* ]] && [[ "$refs" == *"workspace:29"* ]]; then
    pass "two refs returned, one per line"
  else
    fail "rc=$rc refs='$refs'"
  fi
}

test_workspace_refs_for_with_whitespace_title() {
  echo "Test: workspace_refs_for_with_whitespace_title"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON="$JSON_WHITESPACE_TITLE"
  local refs
  refs=$(workspace_refs_for "foo bar baz")
  if [[ "$refs" == "workspace:7" ]]; then
    pass "ref returned for title with spaces (JSON path)"
  else
    fail "expected 'workspace:7', got '$refs'"
  fi
}

test_workspace_refs_for_none() {
  echo "Test: workspace_refs_for_none"
  reset_mocks
  local refs rc=0
  refs=$(workspace_refs_for "nothing") || rc=$?
  if [[ $rc -eq 0 && -z "$refs" ]]; then
    pass "rc=0 + empty stdout for missing title"
  else
    fail "rc=$rc refs='$refs'"
  fi
}

test_workspace_refs_for_rc2_on_json_fail() {
  echo "Test: workspace_refs_for returns rc=2 on JSON failure (R3-1)"
  reset_mocks
  MOCK_CMUX_JSON_FAIL="1"
  local refs rc=0
  refs=$(workspace_refs_for "anything" 2>/dev/null) || rc=$?
  if [[ $rc -eq 2 && -z "$refs" ]]; then
    pass "rc=2 + empty stdout signals JSON-unavailable"
  else
    fail "expected rc=2 + empty; got rc=$rc refs='$refs'"
  fi
}

test_workspace_exists_for_tri_state() {
  echo "Test: workspace_exists_for tri-state (0=found, 1=missing, 2=unavailable)"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON="$JSON_TWO_DUP"
  local rc=0
  workspace_exists_for "foo" >/dev/null 2>&1 || rc=$?
  [[ $rc -eq 0 ]] && pass "rc=0 for found" || fail "expected 0, got $rc"
  rc=0
  workspace_exists_for "not-here" >/dev/null 2>&1 || rc=$?
  [[ $rc -eq 1 ]] && pass "rc=1 for missing" || fail "expected 1, got $rc"
  reset_mocks
  MOCK_CMUX_JSON_FAIL="1"
  rc=0
  workspace_exists_for "anything" >/dev/null 2>&1 || rc=$?
  [[ $rc -eq 2 ]] && pass "rc=2 for JSON unavailable" || fail "expected 2, got $rc"
}

test_get_ghost_workspace_refs_mixed_titles() {
  echo "Test: get_ghost_workspace_refs collects null/empty/tilde"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON="$JSON_GHOST_MIXED"
  local refs
  refs=$(get_ghost_workspace_refs)
  # workspace:13 has title "keep-me", should NOT appear. Others should.
  local expected_count=0
  for r in workspace:10 workspace:11 workspace:12; do
    if echo "$refs" | grep -qx "$r"; then
      expected_count=$((expected_count + 1))
    fi
  done
  if [[ $expected_count -eq 3 ]] && ! echo "$refs" | grep -qx "workspace:13"; then
    pass "3 ghost refs returned, non-ghost excluded"
  else
    fail "refs=$refs (expected workspace:10/11/12 only)"
  fi
}

test_close_workspace_by_ref_dry_run() {
  echo "Test: close_workspace_by_ref dry-run skips cmux call but logs audit"
  reset_mocks
  local stderr_file="$TMPDIR_ROOT/close.stderr"
  FLYWHEEL_CMUX_DRY_RUN=1 close_workspace_by_ref "workspace:1" "test" 2>"$stderr_file"
  if [[ -z "$MOCK_CMUX_OPS" ]] && grep -q "audit.*dry_run=1" "$stderr_file"; then
    pass "no cmux ops + audit log shows dry_run=1"
  else
    fail "ops='$MOCK_CMUX_OPS' stderr='$(cat "$stderr_file")'"
  fi
}

test_close_workspace_by_ref_real() {
  echo "Test: close_workspace_by_ref real call + audit log"
  reset_mocks
  local stderr_file="$TMPDIR_ROOT/close.stderr"
  close_workspace_by_ref "workspace:7" "stale-foo" 2>"$stderr_file"
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:7" \
     && grep -q "audit.*reason=stale-foo" "$stderr_file"; then
    pass "1 cmux close call + audit log"
  else
    fail "ops='$MOCK_CMUX_OPS' stderr='$(cat "$stderr_file")'"
  fi
}

test_cleanup_workspace_for_handles_dup() {
  echo "Test: cleanup_workspace_for closes ALL dup refs"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON="$JSON_TWO_DUP"
  cleanup_workspace_for "foo" 2>/dev/null
  local close_count
  close_count=$(echo "$MOCK_CMUX_OPS" | grep -c "^close-workspace" || true)
  if [[ "$close_count" == "2" ]]; then
    pass "both dup refs closed (workspace:1 + workspace:29)"
  else
    fail "expected 2 closes, got $close_count. Ops: $MOCK_CMUX_OPS"
  fi
}

test_cleanup_workspace_for_json_unavailable_still_kills_linked_session_and_drains_state() {
  echo "Test: cleanup_workspace_for JSON unavailable — skips cmux close, runs local cleanup (R4-1)"
  reset_mocks
  MOCK_CMUX_JSON_FAIL="1"
  # Pre-seed STALE_STATE so drain has something to remove.
  echo "foo|1700000000" > "$STALE_STATE"
  local stderr_file="$TMPDIR_ROOT/cleanup.stderr"
  cleanup_workspace_for "foo" 2>"$stderr_file"
  # 1. NO cmux close (JSON was unavailable).
  if [[ -z "$MOCK_CMUX_OPS" ]]; then
    pass "no cmux close calls"
  else
    fail "unexpected cmux ops: $MOCK_CMUX_OPS"
  fi
  # 2. WARN log emitted ("cmux JSON unavailable").
  if grep -q "cmux JSON unavailable" "$stderr_file"; then
    pass "log emits 'cmux JSON unavailable'"
  else
    fail "missing JSON-unavailable warn; stderr=$(cat "$stderr_file")"
  fi
  # 3. tmux kill-session was called (unconditional).
  if echo "$MOCK_TMUX_KILLED" | grep -q "=cmux-foo"; then
    pass "tmux kill-session called unconditionally"
  else
    fail "no kill-session for cmux-foo; killed=$MOCK_TMUX_KILLED"
  fi
  # 4. STALE_STATE row drained.
  if ! grep -q "^foo|" "$STALE_STATE" 2>/dev/null; then
    pass "STALE_STATE row drained unconditionally"
  else
    fail "STALE_STATE still contains foo: $(cat "$STALE_STATE")"
  fi
}

test_drain_handles_regex_metachars_in_name() {
  echo "Test: drain_stale_state_row handles regex metacharacters in name (Phase 5)"
  reset_mocks
  echo "foo.bar[1]|1700000000" > "$STALE_STATE"
  echo "other|1700000001" >> "$STALE_STATE"
  drain_stale_state_row "foo.bar[1]"
  # foo.bar[1] removed (literal match), other untouched (sed regex would have matched 'other' too if naive)
  if ! grep -q "foo.bar\[1\]" "$STALE_STATE" && grep -q "^other|" "$STALE_STATE"; then
    pass "literal-compare drain: foo.bar[1] removed, other preserved"
  else
    fail "STALE_STATE state: $(cat "$STALE_STATE")"
  fi
}

test_is_pane_alive_handles_regex_metachars() {
  # Codex R2 MEDIUM fix regression guard: window names with regex
  # metacharacters (`.`, `[`, `]`) must NOT cross-match in is_pane_alive.
  echo "Test: is_pane_alive uses literal-field compare for window name (Codex R2)"
  reset_mocks
  MOCK_TMUX_WINDOWS=$'flywheel|@1|foo-bar-1\nflywheel|@2|foo.bar[1]'
  # foo.bar[1] live; foo-bar-1 dead — opposite of what a naive regex match
  # would yield (where '.' / '[1]' wildcards would let them collide).
  MOCK_PANE_DEAD=$'flywheel:foo-bar-1=1\nflywheel:foo.bar[1]=0'
  local rc=0
  is_pane_alive "foo.bar[1]" || rc=$?
  if [[ $rc -eq 0 ]]; then
    pass "is_pane_alive('foo.bar[1]') = alive (literal match found live pane)"
  else
    fail "expected alive (rc=0), got rc=$rc"
  fi
  rc=0
  is_pane_alive "foo-bar-1" || rc=$?
  if [[ $rc -eq 1 ]]; then
    pass "is_pane_alive('foo-bar-1') = dead (NOT confused with foo.bar[1])"
  else
    fail "expected dead (rc=1), got rc=$rc — likely matched foo.bar[1] by regex"
  fi
}

echo ""
echo "═══ FLY-129 Phase 3+5: JSON reverse-index + fail-closed + STALE_STATE drain ═══"
test_get_cmux_workspaces_json_fail_closed_rc_nonzero
test_get_cmux_workspaces_json_fail_closed_invalid_json
test_get_cmux_workspaces_json_recover_logs_once
test_workspace_refs_for_dup
test_workspace_refs_for_with_whitespace_title
test_workspace_refs_for_none
test_workspace_refs_for_rc2_on_json_fail
test_workspace_exists_for_tri_state
test_get_ghost_workspace_refs_mixed_titles
test_close_workspace_by_ref_dry_run
test_close_workspace_by_ref_real
test_cleanup_workspace_for_handles_dup
test_cleanup_workspace_for_json_unavailable_still_kills_linked_session_and_drains_state
test_drain_handles_regex_metachars_in_name
test_is_pane_alive_handles_regex_metachars

# ════════════════════════════════════════════════════════════════
# FLY-129 Phase 4: ghost reaper
# ════════════════════════════════════════════════════════════════

test_reap_ghost_workspaces_closes_only_ghosts() {
  echo "Test: reap_ghost_workspaces closes null/empty/'~' titles only"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON="$JSON_GHOST_MIXED"
  reap_ghost_workspaces
  local close_count
  close_count=$(echo "$MOCK_CMUX_OPS" | grep -c "^close-workspace" || true)
  if [[ "$close_count" == "3" ]]; then
    pass "3 ghost workspaces closed (workspace:10/11/12)"
  else
    fail "expected 3 closes, got $close_count. Ops: $MOCK_CMUX_OPS"
  fi
  if echo "$MOCK_CMUX_OPS" | grep -q "workspace:13"; then
    fail "non-ghost workspace:13 (title=keep-me) should NOT be closed"
  else
    pass "non-ghost workspace:13 left alone"
  fi
}

test_reap_ghost_skips_on_json_fail() {
  echo "Test: reap_ghost_workspaces no-ops on JSON failure"
  reset_mocks
  MOCK_CMUX_JSON_FAIL="1"
  reap_ghost_workspaces 2>/dev/null
  if [[ -z "$MOCK_CMUX_OPS" ]]; then
    pass "no closes attempted when JSON unavailable"
  else
    fail "unexpected ops on JSON failure: $MOCK_CMUX_OPS"
  fi
}

# ════════════════════════════════════════════════════════════════
# FLY-129 Phase 6: dedup newest-wins
# ════════════════════════════════════════════════════════════════

test_dedup_keeps_newest_workspace_n() {
  echo "Test: dedup_workspaces_by_title keeps highest workspace:N"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1","title":"foo"},{"ref":"workspace:29","title":"foo"}]}'
  dedup_workspaces_by_title 2>/dev/null
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:1" \
     && ! echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:29"; then
    pass "closed workspace:1, kept workspace:29 (newest-N wins)"
  else
    fail "ops: $MOCK_CMUX_OPS"
  fi
}

test_dedup_prefers_pinned_over_newest() {
  echo "Test: dedup_workspaces_by_title prefers pinned over newest-N"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1","title":"foo","pinned":true},{"ref":"workspace:29","title":"foo","pinned":false}]}'
  dedup_workspaces_by_title 2>/dev/null
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:29" \
     && ! echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:1"; then
    pass "closed workspace:29 (un-pinned), kept workspace:1 (pinned)"
  else
    fail "ops: $MOCK_CMUX_OPS"
  fi
}

test_dedup_prefers_selected_over_newest() {
  echo "Test: dedup_workspaces_by_title prefers selected over newest-N"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1","title":"foo","selected":true},{"ref":"workspace:29","title":"foo"}]}'
  dedup_workspaces_by_title 2>/dev/null
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:29" \
     && ! echo "$MOCK_CMUX_OPS" | grep -q "close-workspace --workspace workspace:1"; then
    pass "closed workspace:29 (unselected), kept workspace:1 (selected)"
  else
    fail "ops: $MOCK_CMUX_OPS"
  fi
}

test_dedup_logs_and_skips_malformed_ref() {
  echo "Test: dedup logs + skips malformed ref"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:abc","title":"foo"},{"ref":"workspace:5","title":"foo"}]}'
  local stderr_file="$TMPDIR_ROOT/dedup.stderr"
  dedup_workspaces_by_title 2>"$stderr_file"
  # workspace:abc is malformed; workspace:5 is the only valid → no dedup needed.
  if grep -q "malformed ref" "$stderr_file"; then
    pass "malformed ref logged"
  else
    fail "no malformed-ref log; stderr=$(cat "$stderr_file")"
  fi
  if echo "$MOCK_CMUX_OPS" | grep -q "close-workspace"; then
    fail "should NOT close anything (only one valid ref): $MOCK_CMUX_OPS"
  else
    pass "no close attempted (only one valid ref in dup group)"
  fi
}

test_dedup_skips_on_json_fail() {
  echo "Test: dedup_workspaces_by_title no-ops on JSON failure"
  reset_mocks
  MOCK_CMUX_JSON_FAIL="1"
  dedup_workspaces_by_title 2>/dev/null
  if [[ -z "$MOCK_CMUX_OPS" ]]; then
    pass "no closes attempted on JSON failure (R2-6 fail-closed)"
  else
    fail "unexpected ops: $MOCK_CMUX_OPS"
  fi
}

# ════════════════════════════════════════════════════════════════
# FLY-129 Phase 7: cmux ping backoff + state-transition log (R2-2)
# ════════════════════════════════════════════════════════════════

test_next_sleep_seconds_table() {
  echo "Test: next_sleep_seconds backoff curve"
  local ok=1
  for entry in "0:15" "1:15" "2:30" "5:30" "6:60" "10:60" "11:300" "30:300" "50:300"; do
    local count="${entry%:*}" expected="${entry#*:}"
    local got
    got=$(next_sleep_seconds "$count")
    if [[ "$got" != "$expected" ]]; then
      fail "count=$count expected=$expected got=$got"
      ok=0
    fi
  done
  (( ok == 1 )) && pass "all backoff table entries match"
}

# Helper to drive cmux_health_check via a mock socket file. We force
# rc=3 (transient) by pointing CMUX_SOCKET_PATH at a real file that ping
# rejects — actually easier to just stub cmux_health_check directly in
# these tests.

test_health_silent_on_repeat_rc3_no_inner_warn() {
  echo "Test: health_silent_on_repeat_rc3 — no per-tick 'WARN: cmux ping' (R2-2)"
  reset_mocks
  # Stub cmux_health_check to return rc=3 + stash diag.
  cmux_health_check() { CMUX_HEALTH_LAST_DIAG="rc=3 (stubbed transient)"; return 3; }
  local stderr_file="$TMPDIR_ROOT/h.stderr"
  rm -f "$stderr_file"
  for _ in 1 2 3 4 5; do
    cmux_health_check_or_die 2>>"$stderr_file" || true
  done
  # Inner WARN must not appear (R2-2: that log was deleted)
  if grep -q "cmux ping failed transiently" "$stderr_file"; then
    fail "saw deprecated inner 'cmux ping failed transiently' log"
  else
    pass "no inner-WARN spam (R2-2 verified)"
  fi
  # State-machine transition log = exactly 1 line on first fail
  local trans
  trans=$(grep -c "cmux unhealthy" "$stderr_file" || true)
  if [[ "$trans" == "1" ]]; then
    pass "1 transition log over 5 consecutive rc=3 ticks"
  else
    fail "expected 1 transition log, got $trans"
  fi
  # Reset stub
  unset -f cmux_health_check
}

test_health_logs_on_recovery_from_rc3() {
  echo "Test: health_logs_on_recovery_from_rc3 + diag included"
  reset_mocks
  CMUX_HEALTH_LAST_RC=0
  CMUX_HEALTH_FAIL_SINCE=""
  CMUX_HEALTH_FAIL_COUNT=0
  local stderr_file="$TMPDIR_ROOT/h.stderr"
  rm -f "$stderr_file"
  # rc=3 enters fail state
  cmux_health_check() { CMUX_HEALTH_LAST_DIAG="rc=3 diag-from-test"; return 3; }
  cmux_health_check_or_die 2>>"$stderr_file" || true
  # rc=0 should emit recovery
  cmux_health_check() { return 0; }
  cmux_health_check_or_die 2>>"$stderr_file"
  if grep -q "cmux recovered" "$stderr_file"; then
    pass "recovery log emitted on rc=3 → rc=0"
  else
    fail "no recovery log; stderr=$(cat "$stderr_file")"
  fi
  unset -f cmux_health_check
}

# ════════════════════════════════════════════════════════════════
# FLY-129 Phase 8: H2 fix (Path A list_lead_refs + Path B pending invalidation)
# ════════════════════════════════════════════════════════════════

test_list_lead_refs_returns_only_flywheel() {
  echo "Test: list_lead_refs returns refs for flywheel session windows only"
  reset_mocks
  MOCK_TMUX_WINDOWS="flywheel|@1|ops-lead
flywheel|@2|product-lead
runner-foo|@3|runner-task"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"ref":"workspace:1","title":"ops-lead"},{"ref":"workspace:2","title":"product-lead"},{"ref":"workspace:3","title":"runner-task"}]}'
  local refs
  refs=$(list_lead_refs)
  # ops-lead + product-lead should be present, runner-task should NOT.
  if echo "$refs" | grep -qx "workspace:1" \
     && echo "$refs" | grep -qx "workspace:2" \
     && ! echo "$refs" | grep -qx "workspace:3"; then
    pass "returns Lead refs only (no Runner refs)"
  else
    fail "got refs='$refs'"
  fi
}

test_json_missing_workspaces_key_treated_as_fail() {
  # Codex R1 MEDIUM fix: a parse-OK response without a "workspaces" array
  # (e.g. {"error":"foo"}) must be treated as JSON-unavailable, not as
  # "zero workspaces". Otherwise downstream callers blindly create.
  echo "Test: get_cmux_workspaces_json rejects valid JSON missing 'workspaces' key"
  reset_mocks
  MOCK_CMUX_WORKSPACES_JSON='{"error":"server problem"}'
  local rc=0
  get_cmux_workspaces_json >/dev/null 2>&1 || rc=$?
  if [[ $rc -ne 0 ]]; then
    pass "rc!=0 on JSON missing 'workspaces' array"
  else
    fail "expected non-zero; got rc=$rc"
  fi
}

echo ""
echo "═══ FLY-129 Phase 4: ghost reaper ═══"
test_reap_ghost_workspaces_closes_only_ghosts
test_reap_ghost_skips_on_json_fail

echo ""
echo "═══ FLY-129 Phase 6: dedup newest-wins ═══"
test_dedup_keeps_newest_workspace_n
test_dedup_prefers_pinned_over_newest
test_dedup_prefers_selected_over_newest
test_dedup_logs_and_skips_malformed_ref
test_dedup_skips_on_json_fail

echo ""
echo "═══ FLY-129 Phase 7: cmux ping backoff + state-transition log (R2-2) ═══"
test_next_sleep_seconds_table
test_health_silent_on_repeat_rc3_no_inner_warn
test_health_logs_on_recovery_from_rc3

echo ""
echo "═══ FLY-129 Phase 8: H2 fix (list_lead_refs only — Path A) ═══"
test_list_lead_refs_returns_only_flywheel
test_json_missing_workspaces_key_treated_as_fail

# ════════════════════════════════════════════════════════════════
# FLY-169: event-driven cmux workspace attach self-heal
# Run with errexit ON to mirror production (`set -euo pipefail`) and prove the
# self_heal_one_workspace loop survives the deliberate rc=1/2 returns from
# self_heal_workspace_ref (R6-#1).
# ════════════════════════════════════════════════════════════════
echo ""
echo "═══ FLY-169: cmux attach self-heal ═══"
set -e   # deterministic errexit for this block (regardless of earlier set +e)

# Fixture: one Lead window "lead-a" with a live linked session + one workspace
# (workspace:1) titled "lead-a" (managed) with a selected terminal surface
# (surface:1). $1 = client spec for view session cmux-lead-a (e.g. "0","1","0,2").
# Detection keys on the 0-client STATE + managed workspace title, NOT the
# surface title (which is the live foreground process, not the create command).
fly169_setup_one() {
  reset_mocks
  MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-a'
  MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a'
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"lead-a","ref":"workspace:1"}]}'
  MOCK_CMUX_SURFACES="workspace:1;;surface:1;;terminal;;true"
  MOCK_TMUX_CLIENTS="cmux-lead-a=${1}"
}

# Test 1: 0-client → ONE atomic re-attach send (cmd + newline) scoped to the
# selected terminal surface, NO separate send-key, + select-window + refresh
fly169_setup_one 0
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:1 --surface surface:1 tmux attach -t '=cmux-lead-a'"; then
  pass "0-client: atomic send scoped to --workspace + selected --surface with attach cmd"
else
  fail "expected surface-scoped attach send; got: $MOCK_CMUX_OPS"
fi
if echo "$MOCK_CMUX_OPS" | grep -q "send-key"; then
  fail "atomic re-attach must NOT use a separate send-key (text→Enter gap); got: $MOCK_CMUX_OPS"
else
  pass "atomic: no separate send-key (newline embedded in the single send)"
fi
if echo "$MOCK_CMUX_OPS" | grep -q "refresh-surfaces"; then pass "refresh-surfaces after heal"; else fail "missing refresh-surfaces"; fi
if echo "$MOCK_TMUX_SELECTS" | grep -q "=cmux-lead-a:=lead-a"; then pass "select-window points at agent window"; else fail "missing select-window"; fi

# Test 2: client>0 (attached) → MUST NOT send (Claude-prompt safety), only select-window
fly169_setup_one 1
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send"; then
  fail "CRITICAL: must NOT send into an attached surface (Claude prompt risk); got: $MOCK_CMUX_OPS"
else
  pass "attached: no send (never types into Claude prompt)"
fi
if echo "$MOCK_TMUX_SELECTS" | grep -q "=cmux-lead-a:=lead-a"; then pass "attached: select-window only (safe)"; else fail "expected select-window when attached"; fi

# Test 3: workspace has NO terminal surface (e.g. only a browser pane) → no send
fly169_setup_one 0
MOCK_CMUX_SURFACES="workspace:1;;surface:1;;browser;;true"
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send"; then fail "must NOT send when no terminal surface"; else pass "no terminal surface: not touched"; fi
if [[ -z "$MOCK_TMUX_SELECTS" ]]; then pass "no terminal surface: no select-window (healed=0)"; else fail "unexpected select-window: $MOCK_TMUX_SELECTS"; fi

# Test 3b (structural no-hijack): self_heal_sweep_all only iterates agent windows
# (get_tmux_agent_windows). A user's workspace whose title is NOT an agent window
# name is never targeted, even if it's detached with a terminal surface.
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-a'   # only lead-a is an agent window
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a\ncmux-random-user-ws'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"lead-a","ref":"workspace:1"},{"title":"random-user-ws","ref":"workspace:9"}]}'
MOCK_CMUX_SURFACES=$'workspace:1;;surface:1;;terminal;;true\nworkspace:9;;surface:9;;terminal;;true'
MOCK_TMUX_CLIENTS=$'cmux-lead-a=1\ncmux-random-user-ws=0'   # lead-a attached; random ws detached
self_heal_sweep_all
if echo "$MOCK_CMUX_OPS" | grep -q "workspace:9"; then
  fail "HIJACK: swept a non-agent-window user workspace (workspace:9)"
else
  pass "structural no-hijack: non-agent-window workspace never swept"
fi

# Test 4: multiple terminal surfaces, one selected → send targets the SELECTED one
fly169_setup_one 0
MOCK_CMUX_SURFACES=$'workspace:1;;surface:9;;terminal;;\nworkspace:1;;surface:7;;terminal;;true'
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q -- "--surface surface:7 tmux attach"; then
  pass "multi-surface: send targets the SELECTED terminal surface:7 (not surface:9)"
else
  fail "wrong surface targeted; got: $MOCK_CMUX_OPS"
fi

# Test 4b (Codex CR R3 HIGH): target view session has 0 clients, BUT the selected
# surface is attached to a DIFFERENT tmux session (read-screen shows a tmux
# status bar, not a prompt sigil) → bare-shell gate MUST block the send.
fly169_setup_one 0
MOCK_CMUX_READSCREEN='[cmux-other-lead:win* 1:claude  2:zsh     "host" 23:58 26-May-26'
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send"; then
  fail "CRITICAL: surface attached to ANOTHER session (status bar) must NOT receive a send"
else
  pass "bare-shell gate: surface attached elsewhere (status bar) → no send"
fi

# Test 4c: read-screen failure → fail-closed, no send
fly169_setup_one 0
MOCK_CMUX_READSCREEN_FAIL=1
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send"; then fail "must fail-closed on read-screen failure"; else pass "read-screen failure → no send (fail-closed)"; fi

# Test 5: duplicate workspace refs (dup title) → iterate ALL, send to each intent ref
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-a'
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"lead-a","ref":"workspace:1"},{"title":"lead-a","ref":"workspace:2"}]}'
MOCK_CMUX_SURFACES=$'workspace:1;;surface:1;;terminal;;true\nworkspace:2;;surface:2;;terminal;;true'
MOCK_TMUX_CLIENTS="cmux-lead-a=0"
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:1 --surface surface:1" \
   && echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:2 --surface surface:2"; then
  pass "dup refs: iterates all (no dedup-winner guess)"
else
  fail "expected sends to both dup refs; got: $MOCK_CMUX_OPS"
fi

# Test 6: tmux list-clients error → fail-closed, no send
fly169_setup_one 0
MOCK_TMUX_CLIENTS=""   # cmux-lead-a not mocked → list-clients rc=1
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send"; then fail "must fail-closed on list-clients error"; else pass "list-clients error: no send (fail-closed)"; fi

# Test 7: malformed list-pane-surfaces JSON → no send, no traceback
fly169_setup_one 0
MOCK_CMUX_SURFACES_INVALID=1
heal_out=$(self_heal_one_workspace "lead-a" 2>&1)
if echo "$MOCK_CMUX_OPS" | grep -q "send"; then fail "must fail-closed on malformed surfaces JSON"; else pass "malformed JSON: no send"; fi
if echo "$heal_out" | grep -qi "traceback"; then fail "Python traceback leaked"; else pass "malformed JSON: no traceback"; fi

# Test 8: TOCTOU — first count 0, recheck before send flips to >0 → no send
fly169_setup_one 0
MOCK_TMUX_CLIENTS="cmux-lead-a=0,2"   # call1=0 (outer), call2=2 (recheck) → block send
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send"; then fail "TOCTOU: must NOT send when client appears before send"; else pass "TOCTOU recheck blocks send"; fi

# Test 8b: mid-loop TOCTOU (dup refs) — first ref sends, then client appears → 2nd ref not sent
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-a'
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"lead-a","ref":"workspace:1"},{"title":"lead-a","ref":"workspace:2"}]}'
MOCK_CMUX_SURFACES=$'workspace:1;;surface:1;;terminal;;true\nworkspace:2;;surface:2;;terminal;;true'
MOCK_TMUX_CLIENTS="cmux-lead-a=0,0,2"  # outer=0, ref1 GATE1=0 (atomic send), ref2 GATE1=2 (break)
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:1"; then pass "mid-loop: first ref sent"; else fail "first ref should send"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:2"; then fail "second ref must NOT send after client appears"; else pass "mid-loop: loop breaks before second ref"; fi

# Test 8c (Codex CR R1+R4 HIGH — designed out): the re-attach is a SINGLE
# atomic send (cmd + embedded newline), so there is NO text→Enter gap at all.
# Assert exactly one send op and zero send-key ops on a normal heal.
fly169_setup_one 0
self_heal_one_workspace "lead-a"
SEND_N=$(echo "$MOCK_CMUX_OPS" | grep -c "^send --workspace workspace:1" || true)
SENDKEY_N=$(echo "$MOCK_CMUX_OPS" | grep -c "^send-key" || true)
if [[ "$SEND_N" == "1" && "$SENDKEY_N" == "0" ]]; then
  pass "atomic re-attach: exactly 1 send, 0 send-key (no text→Enter gap)"
else
  fail "expected 1 send + 0 send-key; got send=$SEND_N send-key=$SENDKEY_N. Ops: $MOCK_CMUX_OPS"
fi

# Test 9 / 17: linked session dead → skip (reconcile's job, not self-heal's)
fly169_setup_one 0
MOCK_TMUX_SESSIONS="flywheel"   # no cmux-lead-a → linked session dead
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -qE "send|close-workspace|new-workspace"; then
  fail "self-heal must not send/close/create on linked-dead (reconcile's job)"
else
  pass "linked-dead: self-heal no-ops (deferred to reconcile)"
fi

# Test 10: workspace_refs_for rc=2 (cmux JSON unavailable) → skip
fly169_setup_one 0
MOCK_CMUX_JSON_FAIL=1
self_heal_one_workspace "lead-a"
if echo "$MOCK_CMUX_OPS" | grep -q "send"; then fail "must skip on workspace JSON rc=2"; else pass "JSON rc=2: no send (skip tick)"; fi

# Test 11: verify-at-create is ref-scoped — heals via new_ref BEFORE rename
# (workspace not yet title-addressable). self_heal_workspace_ref takes the ref.
reset_mocks
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a'
MOCK_CMUX_SURFACES="workspace:5;;surface:5;;terminal;;true"
MOCK_TMUX_CLIENTS="cmux-lead-a=0"
hr=0
self_heal_workspace_ref "lead-a" "workspace:5" || hr=$?
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:5 --surface surface:5 tmux attach"; then
  pass "verify-at-create: ref-scoped heal works pre-rename (via new_ref)"
else
  fail "ref-scoped send failed; got: $MOCK_CMUX_OPS"
fi
[[ "$hr" == "0" ]] && pass "self_heal_workspace_ref rc=0 on send attempt" || fail "expected rc=0, got $hr"

# Test 12: create-time §2.6 gate — select-window failure defers new-workspace
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-b'
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-b'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[]}'   # lead-b not present → create proceeds to gate
MOCK_TMUX_SELECT_FAIL=1
create_workspace_for_window "flywheel" "@1" "lead-b" >/dev/null 2>&1 || true
if echo "$MOCK_CMUX_OPS" | grep -q "new-workspace"; then
  fail "must NOT new-workspace when select-window fails (§2.6 gate)"
else
  pass "create gate: defers new-workspace on select-window failure"
fi

# Test 13a: event wiring — 'create' event for an EXISTING workspace → self-heal
fly169_setup_one 0
printf 'create|flywheel|@1|lead-a\n' > "$TMPDIR_ROOT/ev169"
_drain_file "$TMPDIR_ROOT/ev169"
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:1 --surface surface:1"; then
  pass "wiring: create-event (existing ws) triggers self-heal"
else
  fail "create-exists wiring did not self-heal; got: $MOCK_CMUX_OPS"
fi

# Test 13b: event wiring — 'register' event → sweep that session → self-heal
fly169_setup_one 0
printf 'register|flywheel\n' > "$TMPDIR_ROOT/ev169"
_drain_file "$TMPDIR_ROOT/ev169"
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:1"; then
  pass "wiring: register-event sweeps session → self-heal"
else
  fail "register wiring did not self-heal; got: $MOCK_CMUX_OPS"
fi

# Test 13c: ANTI-POLLING regression — sync_additive (60s periodic) must NOT self-heal
fly169_setup_one 0   # detached + heal-able workspace
sync_additive >/dev/null 2>&1 || true
if echo "$MOCK_CMUX_OPS" | grep -qE "send --workspace|send-key"; then
  fail "REGRESSION: sync_additive must NOT self-heal (Annie vetoed periodic scan)"
else
  pass "anti-polling: sync_additive does not self-heal (event-driven only)"
fi

# Test 15: cmux health-recovery sets one-shot flag (NOT per-tick)
fly169_setup_one 0
cmux_health_check() { return 0; }   # override: healthy (safe — Phase 7 health tests already ran)
CMUX_HEALTH_LAST_RC=1               # was unhealthy → recovery transition
CMUX_HEAL_ON_RECOVERY=0
cmux_health_check_or_die >/dev/null 2>&1 || true
[[ "$CMUX_HEAL_ON_RECOVERY" == "1" ]] && pass "health-recovery: sets one-shot heal flag" || fail "recovery flag not set"
CMUX_HEALTH_LAST_RC=0               # already healthy → no transition
CMUX_HEAL_ON_RECOVERY=0
cmux_health_check_or_die >/dev/null 2>&1 || true
[[ "$CMUX_HEAL_ON_RECOVERY" == "0" ]] && pass "health-recovery: no flag on steady healthy (not per-tick)" || fail "flag wrongly set when already healthy"

# Test 16: --once is a manual rescue path — sweeps + heals existing bare-zsh
fly169_setup_one 0
MOCK_PGREP_HIT=0   # no watcher running → sync_once proceeds
sync_once >/dev/null 2>&1 || true
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:1 --surface surface:1"; then
  pass "--once: manual rescue sweeps + heals bare-zsh"
else
  fail "--once did not heal; got: $MOCK_CMUX_OPS"
fi

# Test 14: heal-state transition log (once) + clear on recovery
fly169_setup_one 0
rm -f "$HEAL_STATE"
self_heal_one_workspace "lead-a"                       # detached → logs once, writes HEAL_STATE row
if grep -q '^lead-a|' "$HEAL_STATE" 2>/dev/null; then pass "heal-state: row written on re-attach"; else fail "expected HEAL_STATE row for lead-a"; fi
MOCK_TMUX_CLIENTS="cmux-lead-a=1"                       # now attached
self_heal_one_workspace "lead-a"                       # attached branch → clears row
if grep -q '^lead-a|' "$HEAL_STATE" 2>/dev/null; then fail "HEAL_STATE row should be cleared on recovery"; else pass "heal-state: row cleared when re-attached"; fi

# Test 18: errexit safety (R6-#1) — first ref rc=1 must NOT abort the loop
# (this whole block runs under `set -e`; reaching here already exercises it,
# but assert explicitly that a no-intent first ref still lets a later ref heal).
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-a'
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"lead-a","ref":"workspace:1"},{"title":"lead-a","ref":"workspace:2"}]}'
# workspace:1 has NO terminal surface (browser → rc=1 skip); workspace:2 does (rc=0)
MOCK_CMUX_SURFACES=$'workspace:1;;surface:1;;browser;;true\nworkspace:2;;surface:2;;terminal;;true'
MOCK_TMUX_CLIENTS="cmux-lead-a=0"
self_heal_one_workspace "lead-a"   # under set -e: rc=1 from ref1 must not abort
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:2 --surface surface:2"; then
  pass "errexit-safe: rc=1 first ref does not abort; later ref still heals"
else
  fail "errexit/loop continuation failed; got: $MOCK_CMUX_OPS"
fi

set +e   # restore lenient mode for the new FLY-177 tests (process juggling)

# ════════════════════════════════════════════════════════════════
# FLY-177: ④ refresh_linked_sessions selects by LIVE window_id (not name)
# ════════════════════════════════════════════════════════════════
echo "Test: FLY-177 ④ refresh selects live window_id, skips stale dup"
reset_mocks
# Two same-name windows: @1 (remain-on-exit DEAD) + @2 (live). Old name-based
# select would land on @1 (lowest index); ④ must pick @2.
MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-a\nflywheel|@2|lead-a'
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a'
MOCK_PANE_DEAD=$'flywheel:@1=1\nflywheel:@2=0'
refresh_linked_sessions || true
if echo "$MOCK_TMUX_SELECTS" | grep -qx "=cmux-lead-a:@2" \
   && ! echo "$MOCK_TMUX_SELECTS" | grep -qx "=cmux-lead-a:@1"; then
  pass "④ selects live @2, skips dead @1 (no stale-window drift)"
else
  fail "④ dup-name: expected select =cmux-lead-a:@2 only; got: $(echo "$MOCK_TMUX_SELECTS" | tr '\n' ' ')"
fi

echo "Test: FLY-177 ④ single live window still selected (equivalence)"
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@5|lead-a'
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a'
MOCK_PANE_DEAD=$'flywheel:@5=0'
refresh_linked_sessions || true
if echo "$MOCK_TMUX_SELECTS" | grep -qx "=cmux-lead-a:@5"; then
  pass "④ single live window selected by id"
else
  fail "④ single-live: expected select =cmux-lead-a:@5; got: $(echo "$MOCK_TMUX_SELECTS" | tr '\n' ' ')"
fi

echo "Test: FLY-177 ④ all-dead window → no select"
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@9|lead-a'
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a'
MOCK_PANE_DEAD=$'flywheel:@9=1'
refresh_linked_sessions || true
if [[ -z "$MOCK_TMUX_SELECTS" ]]; then
  pass "④ dead-only window: no select (leaves to reconcile / restart)"
else
  fail "④ dead-only: expected no select; got: $(echo "$MOCK_TMUX_SELECTS" | tr '\n' ' ')"
fi

# ════════════════════════════════════════════════════════════════
# FLY-177: CHURN ROOT CAUSE — self-heal sweep must not abort the watcher under
# `set -euo pipefail` when no agent window matches the target session.
#
# Bug: self_heal_sweep_session's loop body's final statement is
#   `[[ "$s" == "$target" && -n "$wname" ]] && self_heal_one_workspace "$wname"`
# When the LAST agent window does NOT belong to $target, the `[[ ]]` is false and
# the `while` loop's exit status is 1. It is called bare in _drain_file's
# `register)` arm under errexit, so that stray 1 aborted the watcher → launchd
# KeepAlive respawned it every ~30s. Production trigger: every `register|<session>`
# event for a `cmux-*` linked session (fired by session-created when the watcher
# creates a linked session — no agent window is ever in a cmux-* session) and for
# `flywheel` whenever a runner-* window sorts last. The churn began the instant
# runner-geoforge3d appeared (the log shows ~40min stable flywheel-only, then 30s
# churn from 15:56 onward when GEO-381's linked-session creation started firing
# register events). Reproduced under a subshell with production's errexit/pipefail.
# ════════════════════════════════════════════════════════════════
echo "Test: FLY-177 self_heal_sweep_session no-match returns 0 under errexit (no churn)"
reset_mocks
# flywheel + runner windows; the LAST entry (runner) is what makes the trailing
# `[[ s==target ]]` false for a cmux-* / flywheel target — exactly production.
MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-a\nrunner-geoforge3d|@8|GEO-381-x'
MOCK_TMUX_SESSIONS=$'flywheel\nrunner-geoforge3d'
sss_rc=0
( set -euo pipefail; self_heal_sweep_session "cmux-GEO-381-x" ) >/dev/null 2>&1 || sss_rc=$?
if [[ "$sss_rc" -eq 0 ]]; then
  pass "self_heal_sweep_session: no-match target returns 0 (no errexit abort)"
else
  fail "REGRESSION: self_heal_sweep_session returned $sss_rc on no-match → would churn watcher"
fi

echo "Test: FLY-177 register|cmux-* drain does not abort watcher under errexit (churn repro)"
reset_mocks
# Production churn repro: session-created on a cmux-* linked session drains through
# the register) arm → self_heal_sweep_session(non-agent target) → (pre-fix) rc=1
# → set -e abort → launchd respawn. The whole drain must survive errexit.
MOCK_TMUX_WINDOWS=$'flywheel|@1|lead-a\nrunner-geoforge3d|@8|GEO-381-x'
MOCK_TMUX_SESSIONS=$'flywheel\nrunner-geoforge3d\ncmux-lead-a\ncmux-GEO-381-x'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"lead-a","ref":"workspace:1"},{"title":"GEO-381-x","ref":"workspace:2"}]}'
MOCK_CMUX_SURFACES=$'workspace:1;;surface:1;;terminal;;true\nworkspace:2;;surface:2;;terminal;;true'
MOCK_TMUX_CLIENTS=$'cmux-lead-a=1\ncmux-GEO-381-x=1'
printf 'register|cmux-GEO-381-x\n' > "$TMPDIR_ROOT/ev177-churn"
drain_rc=0
( set -euo pipefail; _drain_file "$TMPDIR_ROOT/ev177-churn" ) >/dev/null 2>&1 || drain_rc=$?
if [[ "$drain_rc" -eq 0 ]]; then
  pass "register|cmux-* drain survives errexit (watcher would NOT respawn-churn)"
else
  fail "REGRESSION: _drain_file aborted (rc=$drain_rc) on register|cmux-* → 30s churn"
fi

# ════════════════════════════════════════════════════════════════
# FLY-177: _pid_is_watcher parsing — real function (deterministic cases)
# ════════════════════════════════════════════════════════════════
echo "Test: FLY-177 _pid_is_watcher real parsing"
# Negative cases are deterministic everywhere: empty pid, and a live non-watcher
# (this test process — its command is bash/test-cmux-sync, not the watcher).
if ! _pid_is_watcher "" && ! _pid_is_watcher "$$"; then
  pass "_pid_is_watcher: false for empty pid and a live non-watcher process"
else
  fail "_pid_is_watcher: should be false for empty/non-watcher (got true)"
fi
# Positive case depends on `ps -o command=` reflecting `exec -a` argv0, which is
# environment-sensitive (sandboxes can hide it). Feature-detect: only assert if
# ps actually shows the spoofed argv; otherwise skip (Codex R1 flakiness note).
bash -c 'exec -a "flywheel-cmux-sync --watch" sleep 5' &
piw_pid=$!
sleep 0.4
piw_cmd=$(ps -o command= -p "$piw_pid" 2>/dev/null || true)
if [[ "$piw_cmd" == *flywheel-cmux-sync* && "$piw_cmd" == *--watch* ]]; then
  if _pid_is_watcher "$piw_pid"; then
    pass "_pid_is_watcher: true for a real watcher-like command"
  else
    fail "_pid_is_watcher: false-negative for watcher command '$piw_cmd'"
  fi
else
  echo "  ⏭  ps does not reflect exec -a argv here — skipping _pid_is_watcher positive case"
fi
kill "$piw_pid" 2>/dev/null

# ════════════════════════════════════════════════════════════════
# FLY-177: supervised blocking-acquire (FLYWHEEL_CMUX_SUPERVISED=1)
# Deterministic: override _pid_is_watcher to consult MOCK_WATCHER_PIDS so the
# lock state-machine is tested without depending on ps/exec -a (Codex R1).
# ════════════════════════════════════════════════════════════════
MOCK_WATCHER_PIDS=""
_pid_is_watcher() {
  local p="$1"
  [[ -z "$p" ]] && return 1
  case " ${MOCK_WATCHER_PIDS} " in *" $p "*) return 0 ;; *) return 1 ;; esac
}

echo "Test: FLY-177 supervised acquires immediately on free lock"
reset_mocks
rm -rf "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" "${FLYWHEEL_CMUX_WATCHER_LOCK_DIR}.reap"
sup_err="$TMPDIR_ROOT/sup-free.err"
( FLYWHEEL_CMUX_SUPERVISED=1; acquire_watcher_lock ) >/dev/null 2>"$sup_err"
sup_rc=$?
if [[ $sup_rc -eq 0 ]] && ! grep -qE "waiting|already running" "$sup_err"; then
  pass "supervised: acquires immediately when lock free"
else
  fail "supervised free-lock: rc=$sup_rc err=$(cat "$sup_err" 2>/dev/null)"
fi

echo "Test: FLY-177 supervised reaps live NON-watcher owner (PID-reuse guard)"
reset_mocks
rm -rf "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" "${FLYWHEEL_CMUX_WATCHER_LOCK_DIR}.reap"
sleep 30 & nonwatcher_pid=$!          # live, but NOT in MOCK_WATCHER_PIDS
MOCK_WATCHER_PIDS=""
mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
echo "$nonwatcher_pid" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"
sup_err="$TMPDIR_ROOT/sup-nonwatcher.err"
SUPERVISED_WAIT_SECONDS=1
( FLYWHEEL_CMUX_SUPERVISED=1; acquire_watcher_lock ) >/dev/null 2>"$sup_err"
sup_rc=$?
SUPERVISED_WAIT_SECONDS=15
kill "$nonwatcher_pid" 2>/dev/null
if [[ $sup_rc -eq 0 ]] && grep -q "is not a watcher (stale), reaping" "$sup_err"; then
  pass "supervised: live non-watcher owner reaped (no infinite wait)"
else
  fail "supervised non-watcher: rc=$sup_rc err=$(cat "$sup_err" 2>/dev/null)"
fi

echo "Test: FLY-177 supervised blocks for live watcher, takes over on its death"
reset_mocks
rm -rf "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR" "${FLYWHEEL_CMUX_WATCHER_LOCK_DIR}.reap"
sleep 60 & fake_watcher=$!
MOCK_WATCHER_PIDS="$fake_watcher"     # mark this live pid as a watcher
export MOCK_WATCHER_PIDS              # visible to the backgrounded subshell
mkdir -p "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR"
echo "$fake_watcher" > "$FLYWHEEL_CMUX_WATCHER_LOCK_DIR/pid"
sup_err="$TMPDIR_ROOT/sup-block.err"
# Codex R2 LOW: marker distinguishes a genuine `acquire_watcher_lock` RETURN
# (→ `&& touch`) from any `exit 0` path inside acquire (which skips the `&&`).
sup_marker="$TMPDIR_ROOT/sup-takeover.marker"
rm -f "$sup_marker"
SUPERVISED_WAIT_SECONDS=1; export SUPERVISED_WAIT_SECONDS
( FLYWHEEL_CMUX_SUPERVISED=1; acquire_watcher_lock && touch "$sup_marker" ) >/dev/null 2>"$sup_err" &
acq_pid=$!
sleep 3
if kill -0 "$acq_pid" 2>/dev/null && grep -q "waiting" "$sup_err" && [[ ! -f "$sup_marker" ]]; then
  pass "supervised: blocks while a live watcher owns the lock (no exit-churn, not yet acquired)"
else
  alive="n"; kill -0 "$acq_pid" 2>/dev/null && alive="y"
  fail "supervised block: acq alive=$alive marker=$([[ -f "$sup_marker" ]] && echo y || echo n) err=$(cat "$sup_err" 2>/dev/null)"
  kill "$acq_pid" 2>/dev/null
fi
kill "$fake_watcher" 2>/dev/null   # owner dies → acquire should take over
took_over=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! kill -0 "$acq_pid" 2>/dev/null; then took_over=1; break; fi
  sleep 1
done
SUPERVISED_WAIT_SECONDS=15; export SUPERVISED_WAIT_SECONDS
if [[ $took_over -eq 1 ]] && [[ -f "$sup_marker" ]]; then
  pass "supervised: takes over after lock owner dies (acquire returned → marker)"
else
  fail "supervised takeover: exited=$took_over marker=$([[ -f "$sup_marker" ]] && echo y || echo n)"
  kill "$acq_pid" 2>/dev/null
fi
wait "$acq_pid" 2>/dev/null
unset MOCK_WATCHER_PIDS

# ════════════════════════════════════════════════════════════════
# FLY-177: launchd wrapper — PATH resolution + exec (manage real PID)
# ════════════════════════════════════════════════════════════════
echo "Test: FLY-177 launchd-minimal PATH resolves cmux + tmux"
if env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/bash -c '
  export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  command -v cmux >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1'; then
  pass "expanded PATH resolves cmux + tmux from minimal launchd env"
elif ! { [[ -x /opt/homebrew/bin/cmux ]] || [[ -x /usr/local/bin/cmux ]]; }; then
  echo "  ⏭  cmux not installed on host — skipping launchd PATH resolution test"
else
  fail "expanded PATH failed to resolve cmux/tmux from minimal env"
fi

echo "Test: FLY-177 autostart execs watcher + sets launchd PATH"
AUTOSTART_SH="$SCRIPT_DIR/flywheel-cmux-autostart.sh"
if grep -qE '^exec "\$SYNC_SCRIPT" --watch' "$AUTOSTART_SH" \
   && grep -qE 'export PATH="/opt/homebrew/bin' "$AUTOSTART_SH"; then
  pass "autostart: exec watcher (launchd manages real PID) + PATH expansion present"
else
  fail "autostart: missing 'exec \$SYNC_SCRIPT --watch' or PATH expansion"
fi

set +e   # restore lenient mode before the FLY-254 section + summary

# ════════════════════════════════════════════════════════════════
# FLY-254: render-escalated reopen sweep
# ════════════════════════════════════════════════════════════════
# Test-only overrides. Socket identity/presence are pure-stat probes in prod;
# here they're driven by MOCK_ vars. `sleep` is mocked: counts calls and runs
# an optional hook so tests can flip state "during" a wait. This section runs
# LAST — overriding sleep cannot affect earlier tests.
# Identity override file takes precedence over the MOCK_ var: the cmux mock's
# JSON-flip hook runs inside $(...) subshells and can only signal the parent
# via a file (FLY-254 CR-R3 race tests).
cmux_socket_identity() {
  if [[ -f "$TMPDIR_ROOT/mock-ident.override" ]]; then
    cat "$TMPDIR_ROOT/mock-ident.override"
    return 0
  fi
  printf '%s' "${MOCK_SOCK_IDENT:-}"
}
cmux_socket_present() { [[ "${MOCK_SOCK_PRESENT:-0}" == "1" ]]; }
sleep() { MOCK_SLEEPS=$((MOCK_SLEEPS + 1)); MOCK_SLEEP_ARGS+="${1:-} "; eval "${MOCK_SLEEP_HOOK:-}" || true; }
# CR-R5: mutation-boundary hook — fires ONLY for cmux_call_guarded's own
# mktemp (FUNCNAME survives the $(...) subshell), i.e. the last bookkeeping
# step before the actual cmux mutation. State changes must cross the subshell
# via files (mock-ident.override).
mktemp() {
  if [[ "${FUNCNAME[1]:-}" == "cmux_call_guarded" && -n "${MOCK_MKTEMP_HOOK:-}" ]]; then
    eval "$MOCK_MKTEMP_HOOK" || true
  fi
  command mktemp "$@"
}

# Standard escalation scenario: one Lead window 'lead-a' (ws workspace:7,
# unrendered surface), user's tab = workspace:1 ('home', selected).
setup_escalation_scenario() {
  reset_mocks
  MOCK_TMUX_WINDOWS="flywheel|@7|lead-a"
  MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a'
  MOCK_TMUX_CLIENTS="cmux-lead-a=0"
  MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"home","ref":"workspace:1","selected":true},{"title":"lead-a","ref":"workspace:7"}]}'
  MOCK_CMUX_SURFACES="workspace:7;;surface:7;;terminal;;true"
  MOCK_CMUX_READSCREEN_SEQ="FAIL,annie@mac ~ %"
  export FLYWHEEL_CMUX_RENDER_WAIT_TICKS=3
  unset FLYWHEEL_CMUX_REOPEN_SWEEP 2>/dev/null || true
}

echo "Test: FLY-254 escalation happy path (focus → render → full gates → send → restore)"
setup_escalation_scenario
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:7"; then
  pass "escalation focuses the broken workspace (select-workspace ws7)"
else fail "expected select-workspace ws7; ops: $MOCK_CMUX_OPS"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:7 --surface surface:7 tmux attach"; then
  pass "atomic send fired after render + full gate re-run"
else fail "expected attach send to ws7; ops: $MOCK_CMUX_OPS"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:1"; then
  pass "focus restored to original tab (ws1)"
else fail "expected restore select-workspace ws1; ops: $MOCK_CMUX_OPS"; fi

echo "Test: FLY-254 R1-HIGH-1 race — client appears at the FINAL pre-send check"
setup_escalation_scenario
MOCK_TMUX_CLIENTS="cmux-lead-a=0,0,0,1"   # 4th client-count call (final ⑤) → 1
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace"; then
  fail "client appeared at final check but send still fired"
else pass "final pre-send 0-client re-check blocks the send (race closed)"; fi

echo "Test: FLY-254 R1-HIGH-1 drift — ref no longer resolves from wname after focus"
setup_escalation_scenario
MOCK_SLEEP_HOOK='MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"title\":\"home\",\"ref\":\"workspace:1\"},{\"title\":\"renamed\",\"ref\":\"workspace:7\",\"selected\":true}]}"'
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace"; then
  fail "ref drifted (title renamed) after focus but send still fired"
else pass "fresh MANAGED re-check blocks send after title drift"; fi

echo "Test: FLY-254 render timeout — budget exhausted, summary log, sweep continues + restores"
setup_escalation_scenario
MOCK_CMUX_READSCREEN_SEQ="FAIL"   # clamped: every read fails — never renders
export FLYWHEEL_CMUX_RENDER_WAIT_TICKS=2
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace"; then
  fail "render never completed but send fired"
else pass "no send on render timeout (fail-closed)"; fi
if grep -q "render timeout" "$TMPDIR_ROOT/t254.log"; then
  pass "one summary log on render timeout"
else fail "expected 'render timeout' summary log"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:1"; then
  pass "focus still restored after timeout"
else fail "expected restore to ws1 after timeout; ops: $MOCK_CMUX_OPS"; fi

echo "Test: FLY-254 positively-not-a-shell after render → fail closed"
setup_escalation_scenario
MOCK_CMUX_READSCREEN_SEQ="FAIL,[0] 0:zsh* | mac | 12:00"   # renders into a status bar
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace"; then
  fail "non-shell screen after render but send fired"
else pass "bare-shell positive proof still gates the escalated send"; fi

echo "Test: FLY-254 focus snapshot fail-closed (no unique selected ref)"
setup_escalation_scenario
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"home","ref":"workspace:1"},{"title":"lead-a","ref":"workspace:7"}]}'
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace"; then
  fail "no restorable snapshot but focus mutation happened"
else pass "zero selected → zero focus mutations (fail-closed)"; fi
setup_escalation_scenario
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"home","ref":"workspace:1","selected":true},{"title":"lead-a","ref":"workspace:7","selected":true}]}'
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace"; then
  fail "ambiguous (2x selected) snapshot but focus mutation happened"
else pass "multiple selected → zero focus mutations (fail-closed)"; fi

echo "Test: FLY-254 R2-M5 mid-sweep user intervention stops remaining escalation"
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@7|lead-a\nflywheel|@8|lead-b'
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a\ncmux-lead-b'
MOCK_TMUX_CLIENTS=$'cmux-lead-a=0\ncmux-lead-b=0'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"home","ref":"workspace:1","selected":true},{"title":"lead-a","ref":"workspace:7"},{"title":"lead-b","ref":"workspace:8"},{"title":"elsewhere","ref":"workspace:99"}]}'
MOCK_CMUX_SURFACES=$'workspace:7;;surface:7;;terminal;;true\nworkspace:8;;surface:8;;terminal;;true'
MOCK_CMUX_READSCREEN_SEQ="FAIL,annie@mac ~ %,FAIL"
export FLYWHEEL_CMUX_RENDER_WAIT_TICKS=3
# User clicks ws99 during lead-a's render wait (sleep #1) — lead-b's pre-focus
# check must detect it, stop ALL remaining focus escalation, and never restore.
MOCK_SLEEP_HOOK='[[ "$MOCK_SLEEPS" -eq 1 ]] && MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"title\":\"home\",\"ref\":\"workspace:1\"},{\"title\":\"lead-a\",\"ref\":\"workspace:7\"},{\"title\":\"lead-b\",\"ref\":\"workspace:8\"},{\"title\":\"elsewhere\",\"ref\":\"workspace:99\",\"selected\":true}]}"'
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:8"; then
  fail "user intervened but lead-b was still focused"
else pass "user intervention stops remaining focus escalation (no ws8 focus)"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:1"; then
  fail "user intervened but focus was restored anyway (user's choice stomped)"
else pass "no restore after user intervention (user's selection wins)"; fi
if grep -q "user switched tabs" "$TMPDIR_ROOT/t254.log"; then
  pass "user-intervention transition logged"
else fail "expected 'user switched tabs' log"; fi

echo "Test: FLY-254 R3-M2 end-form — user switches AFTER the last forced focus"
setup_escalation_scenario
# Flip selected to ws99 during lead-a's render wait; lead-a still heals (its
# gates are client/shell-based), but the EPILOGUE must see selected≠last_forced
# and skip the restore.
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"home","ref":"workspace:1","selected":true},{"title":"lead-a","ref":"workspace:7"},{"title":"elsewhere","ref":"workspace:99"}]}'
MOCK_SLEEP_HOOK='[[ "$MOCK_SLEEPS" -eq 1 ]] && MOCK_CMUX_WORKSPACES_JSON="{\"workspaces\":[{\"title\":\"home\",\"ref\":\"workspace:1\"},{\"title\":\"lead-a\",\"ref\":\"workspace:7\"},{\"title\":\"elsewhere\",\"ref\":\"workspace:99\",\"selected\":true}]}"'
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:1"; then
  fail "selected changed after last focus but restore fired (zero-restore violated)"
else pass "final selected re-check skips restore (end-form user switch)"; fi
if grep -q "keeping user's selection" "$TMPDIR_ROOT/t254.log"; then
  pass "epilogue logs the kept user selection"
else fail "expected 'keeping user's selection' log"; fi

echo "Test: FLY-254 generation state machine (three-field fixtures)"
reset_mocks
MOCK_SOCK_IDENT="11:22:333"
reopen_detector_check 2>"$TMPDIR_ROOT/t254.log"
if [[ "$(cat "$CMUX_SOCK_IDENT_FILE" 2>/dev/null)" == "11:22:333|pending|0" ]]; then
  pass "missing file → arm identity|pending|0"
else fail "expected arm; file: $(cat "$CMUX_SOCK_IDENT_FILE" 2>/dev/null || echo '<none>')"; fi
if grep -q "cmux reopen detected" "$TMPDIR_ROOT/t254.log"; then
  pass "arm logs reopen detection"
else fail "expected reopen-detected log"; fi
# Churn immunity: same identity + done → detector must NOT re-arm.
echo "11:22:333|done|1" > "$CMUX_SOCK_IDENT_FILE"
reopen_detector_check 2>/dev/null
if [[ "$(cat "$CMUX_SOCK_IDENT_FILE")" == "11:22:333|done|1" ]]; then
  pass "same identity + done → no re-arm (watcher churn immunity)"
else fail "done generation was re-armed: $(cat "$CMUX_SOCK_IDENT_FILE")"; fi
# Identity change → new pending generation.
MOCK_SOCK_IDENT="44:55:666"
reopen_detector_check 2>/dev/null
if [[ "$(cat "$CMUX_SOCK_IDENT_FILE")" == "44:55:666|pending|0" ]]; then
  pass "identity change → new generation armed"
else fail "expected new arm; file: $(cat "$CMUX_SOCK_IDENT_FILE")"; fi

echo "Test: FLY-254 consume — attempts increment before sweep, done after"
setup_escalation_scenario
MOCK_SOCK_IDENT="11:22:333"
echo "11:22:333|pending|0" > "$CMUX_SOCK_IDENT_FILE"
consume_pending_reopen_sweep 2>/dev/null
if [[ "$(cat "$CMUX_SOCK_IDENT_FILE")" == "11:22:333|done|1" ]]; then
  pass "consume: pending|0 → done|1 (normal completion)"
else fail "expected done|1; file: $(cat "$CMUX_SOCK_IDENT_FILE")"; fi
if [[ "$REOPEN_CONSUMED_THIS_TICK" == "1" ]]; then
  pass "REOPEN_CONSUMED_THIS_TICK set (recovery-sweep coalesce signal)"
else fail "expected REOPEN_CONSUMED_THIS_TICK=1"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:7"; then
  pass "consume actually ran the escalated sweep (send fired)"
else fail "expected escalated sweep send; ops: $MOCK_CMUX_OPS"; fi

echo "Test: FLY-254 crash resume — pending|1 re-consumed; already-attached workspaces no-op"
setup_escalation_scenario
# lead-b is ALREADY attached (clients=1) — a resume must not focus or send it.
MOCK_TMUX_WINDOWS=$'flywheel|@7|lead-a\nflywheel|@8|lead-b'
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a\ncmux-lead-b'
MOCK_TMUX_CLIENTS=$'cmux-lead-a=0\ncmux-lead-b=1'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"home","ref":"workspace:1","selected":true},{"title":"lead-a","ref":"workspace:7"},{"title":"lead-b","ref":"workspace:8"}]}'
MOCK_CMUX_SURFACES=$'workspace:7;;surface:7;;terminal;;true\nworkspace:8;;surface:8;;terminal;;true'
MOCK_SOCK_IDENT="11:22:333"
echo "11:22:333|pending|1" > "$CMUX_SOCK_IDENT_FILE"
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if [[ "$(cat "$CMUX_SOCK_IDENT_FILE")" == "11:22:333|done|2" ]]; then
  pass "crash resume: pending|1 → done|2"
else fail "expected done|2; file: $(cat "$CMUX_SOCK_IDENT_FILE")"; fi
if grep -q "resuming pending re-attach sweep" "$TMPDIR_ROOT/t254.log"; then
  pass "resume logged"
else fail "expected resume log"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "workspace:8"; then
  fail "resume touched the already-attached workspace (ws8): $MOCK_CMUX_OPS"
else pass "resume no-ops the already-attached workspace (residue only)"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:7"; then
  pass "resume healed the residual broken workspace (ws7)"
else fail "expected ws7 heal on resume; ops: $MOCK_CMUX_OPS"; fi

echo "Test: FLY-254 R3-HIGH-1 durable attempt budget — pending|3 never consumed"
setup_escalation_scenario
MOCK_SOCK_IDENT="11:22:333"
echo "11:22:333|pending|3" > "$CMUX_SOCK_IDENT_FILE"
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace\|send --workspace"; then
  fail "attempt budget exhausted but sweep still ran"
else pass "attempt budget exhausted → zero focus/send"; fi
if grep -q "attempt budget exhausted" "$TMPDIR_ROOT/t254.log"; then
  pass "give-up logged once"
else fail "expected budget-exhausted log"; fi
if [[ "$(cat "$CMUX_SOCK_IDENT_FILE")" == "11:22:333|done|3" ]]; then
  pass "exhausted generation flipped to done (no further consumption)"
else fail "expected done|3; file: $(cat "$CMUX_SOCK_IDENT_FILE")"; fi

echo "Test: FLY-254 malformed state file → fail-closed reset, no escalation"
setup_escalation_scenario
MOCK_SOCK_IDENT="11:22:333"
echo "garbage-no-pipes" > "$CMUX_SOCK_IDENT_FILE"
reopen_detector_check 2>"$TMPDIR_ROOT/t254.log"
if [[ "$(cat "$CMUX_SOCK_IDENT_FILE")" == "11:22:333|done|0" ]]; then
  pass "malformed → reset to done (no escalation off corrupt state)"
else fail "expected reset to done|0; file: $(cat "$CMUX_SOCK_IDENT_FILE")"; fi
if grep -q "malformed generation state" "$TMPDIR_ROOT/t254.log"; then
  pass "malformed reset logged"
else fail "expected malformed log"; fi

echo "Test: FLY-254 attempt-write failure → zero escalation that round (fail-closed)"
setup_escalation_scenario
MOCK_SOCK_IDENT="11:22:333"
mkdir -p "$TMPDIR_ROOT/ro"
SAVED_IDENT_FILE="$CMUX_SOCK_IDENT_FILE"
CMUX_SOCK_IDENT_FILE="$TMPDIR_ROOT/ro/sock-ident"
echo "11:22:333|pending|0" > "$CMUX_SOCK_IDENT_FILE"
chmod 555 "$TMPDIR_ROOT/ro"
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
chmod 755 "$TMPDIR_ROOT/ro"
CMUX_SOCK_IDENT_FILE="$SAVED_IDENT_FILE"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace\|send --workspace"; then
  fail "attempt counter could not be persisted but sweep still ran"
else pass "unpersistable attempt counter → no escalated sweep (fail-closed)"; fi

echo "Test: FLY-254 R2-M4 readiness — partial set held stable must NOT early-exit"
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@7|lead-a\nflywheel|@8|lead-b'
printf '%s' '{"workspaces":[{"title":"lead-a","ref":"workspace:7"}]}' > "$TMPDIR_ROOT/wsjson.1"
printf '%s' '{"workspaces":[{"title":"lead-a","ref":"workspace:7"}]}' > "$TMPDIR_ROOT/wsjson.2"
printf '%s' '{"workspaces":[{"title":"lead-a","ref":"workspace:7"},{"title":"lead-b","ref":"workspace:8"}]}' > "$TMPDIR_ROOT/wsjson.3"
MOCK_CMUX_JSON_SEQ_N=3
export FLYWHEEL_CMUX_READINESS_TICKS=5
reopen_readiness_wait 2>/dev/null
WS_READS=$(cat "$TMPDIR_ROOT/wsjson.n" 2>/dev/null || echo 0)
if [[ "$WS_READS" -ge 3 ]]; then
  pass "readiness waited past the stable partial set (expected-set check, $WS_READS reads)"
else fail "readiness early-exited on a stable PARTIAL set after $WS_READS reads"; fi

echo "Test: FLY-254 readiness budget exhausted → proceed + log missing names"
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@7|lead-a\nflywheel|@8|lead-b'
printf '%s' '{"workspaces":[{"title":"lead-a","ref":"workspace:7"}]}' > "$TMPDIR_ROOT/wsjson.1"
MOCK_CMUX_JSON_SEQ_N=1
export FLYWHEEL_CMUX_READINESS_TICKS=2
reopen_readiness_wait 2>"$TMPDIR_ROOT/t254.log"
if grep -q "readiness budget exhausted" "$TMPDIR_ROOT/t254.log" \
   && grep -q "lead-b" "$TMPDIR_ROOT/t254.log"; then
  pass "budget exhaustion logged with the missing window name"
else fail "expected exhausted+missing log; got: $(cat "$TMPDIR_ROOT/t254.log")"; fi

echo "Test: FLY-254 R2-HIGH-2 sliced sleeps — rc=1 socket reappearance wakes early"
reset_mocks
CMUX_HEALTH_LAST_RC=1
export FLYWHEEL_CMUX_SOCKET_PROBE_SLICE=3
MOCK_SLEEP_HOOK='[[ "$MOCK_SLEEPS" -ge 2 ]] && MOCK_SOCK_PRESENT=1'
reopen_aware_sleep 30 2>/dev/null
if [[ "$MOCK_SLEEPS" -eq 2 ]]; then
  pass "rc=1: woke on socket reappearance after 2 slices (not 10)"
else fail "rc=1: expected 2 slices, got $MOCK_SLEEPS"; fi

echo "Test: FLY-254 R2-HIGH-2 sliced sleeps — rc=3 stale-socket identity change wakes early"
reset_mocks
CMUX_HEALTH_LAST_RC=3
echo "old:1:1|done|1" > "$CMUX_SOCK_IDENT_FILE"
MOCK_SOCK_IDENT="old:1:1"
MOCK_SLEEP_HOOK='[[ "$MOCK_SLEEPS" -ge 2 ]] && MOCK_SOCK_IDENT="new:2:2"'
reopen_aware_sleep 30 2>/dev/null
if [[ "$MOCK_SLEEPS" -eq 2 ]]; then
  pass "rc=3: woke on identity change after 2 slices (stale-socket blind spot closed)"
else fail "rc=3: expected 2 slices, got $MOCK_SLEEPS"; fi

echo "Test: FLY-254 healthy sleep stays a single plain sleep"
reset_mocks
CMUX_HEALTH_LAST_RC=0
reopen_aware_sleep 15 2>/dev/null
if [[ "$MOCK_SLEEPS" -eq 1 ]]; then
  pass "rc=0: one plain sleep (byte-identical cadence)"
else fail "rc=0: expected 1 sleep, got $MOCK_SLEEPS"; fi

echo "Test: FLY-254 kill switch — FLYWHEEL_CMUX_REOPEN_SWEEP=0 reverts to FLY-169 status quo"
setup_escalation_scenario
export FLYWHEEL_CMUX_REOPEN_SWEEP=0
MOCK_SOCK_IDENT="11:22:333"
reopen_detector_check 2>/dev/null
if [[ ! -f "$CMUX_SOCK_IDENT_FILE" ]]; then
  pass "off: detector writes no state file"
else fail "off: state file was created"; fi
echo "11:22:333|pending|0" > "$CMUX_SOCK_IDENT_FILE"
consume_pending_reopen_sweep 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace\|send"; then
  fail "off: consume still acted"
else pass "off: consume is a no-op"; fi
CMUX_HEALTH_LAST_RC=1
MOCK_SLEEPS=0
reopen_aware_sleep 30 2>/dev/null
if [[ "$MOCK_SLEEPS" -eq 1 ]]; then
  pass "off: unhealthy sleep is one plain sleep (no slicing)"
else fail "off: expected 1 sleep, got $MOCK_SLEEPS"; fi
# Regression sentinel: escalation never fires from a plain (FLY-169) sweep,
# and the event-path heal stays fail-closed on read-screen failure.
setup_escalation_scenario
MOCK_CMUX_READSCREEN_SEQ="FAIL"
self_heal_sweep_all 2>/dev/null   # NOT escalated
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace\|send --workspace"; then
  fail "plain sweep escalated or sent on unreadable surface"
else pass "plain sweep: read-screen failure stays fail-closed (FLY-169 verbatim)"; fi

echo "Test: FLY-254 invalid env knobs fall back to defaults"
reset_mocks
V=$(validated_int_env TEST_KNOB "abc" 6 60 2>/dev/null)
[[ "$V" == "6" ]] && pass "non-numeric → default" || fail "non-numeric: got $V"
V=$(validated_int_env TEST_KNOB "0" 6 60 2>/dev/null)
[[ "$V" == "6" ]] && pass "zero → default" || fail "zero: got $V"
V=$(validated_int_env TEST_KNOB "999" 6 60 2>/dev/null)
[[ "$V" == "6" ]] && pass "over-max → default" || fail "over-max: got $V"
V=$(validated_int_env TEST_KNOB "08" 6 60 2>/dev/null)
[[ "$V" == "8" ]] && pass "leading zero → base-10 (no octal trap)" || fail "leading zero: got $V"

echo "Test: FLY-254 set -euo pipefail survival (sweep + consume return 0 on failure paths)"
setup_escalation_scenario
MOCK_CMUX_READSCREEN_SEQ="FAIL"
export FLYWHEEL_CMUX_RENDER_WAIT_TICKS=2
SURVIVED=$( (set -euo pipefail
  HEAL_RENDER_ESCALATE=1
  self_heal_sweep_all
  MOCK_SOCK_IDENT="11:22:333"
  echo "11:22:333|pending|3" > "$CMUX_SOCK_IDENT_FILE"
  consume_pending_reopen_sweep
  reopen_detector_check
  CMUX_HEALTH_LAST_RC=0
  reopen_aware_sleep 15
  echo SURVIVED) 2>/dev/null )
if [[ "$SURVIVED" == *SURVIVED* ]]; then
  pass "all FLY-254 entry points survive set -euo pipefail on failure paths"
else fail "a FLY-254 path killed the watcher under set -e"; fi

echo "Test: FLY-254 wiring structure (watch_loop coalesce + bootstrap replace + sliced sleep)"
SYNC_SH="$SCRIPT_DIR/flywheel-cmux-sync.sh"
if grep -q 'REOPEN_CONSUMED_THIS_TICK" != "1"' "$SYNC_SH"; then
  pass "watch_loop coalesces recovery sweep with the escalated consume"
else fail "missing recovery-sweep coalesce guard"; fi
if grep -q 'BOOTSTRAP_SKIP_HEAL_SWEEP=1 sync_additive_bootstrap' "$SYNC_SH"; then
  pass "bootstrap consume replaces the legacy bootstrap sweep when pending"
else fail "missing bootstrap replace wiring"; fi
if grep -q 'reopen_aware_sleep "\$sleep_seconds"' "$SYNC_SH"; then
  pass "watch_loop sleeps through reopen_aware_sleep"
else fail "watch_loop still uses plain sleep"; fi
if grep -q 'REOPEN_CACHE_STATE" == "pending"' "$SYNC_SH"; then
  pass "watch_loop consume is cache-gated (CR-M6: settled done = zero file IO)"
else fail "missing cache gate on the consume call"; fi
# CR-R1 L9: scan the FULL sync_once body (the old -A20 only saw 20 lines).
if ! awk '/^sync_once\(\)/,/^}$/' "$SYNC_SH" | grep -q 'reopen\|escalat\|HEAL_RENDER'; then
  pass "--once does not participate in escalation / generation consumption (full body)"
else fail "--once gained reopen behavior (must stay non-escalated)"; fi

echo "Test: FLY-254 bootstrap skip flag suppresses the legacy heal sweep"
setup_escalation_scenario
MOCK_CMUX_READSCREEN_SEQ=""
MOCK_CMUX_READSCREEN="annie@mac ~ %"   # legacy heal WOULD send without the flag
BOOTSTRAP_SKIP_HEAL_SWEEP=1 sync_additive_bootstrap 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace"; then
  fail "skip flag set but bootstrap sweep still healed"
else pass "BOOTSTRAP_SKIP_HEAL_SWEEP=1 suppresses the bootstrap heal sweep"; fi
setup_escalation_scenario
MOCK_CMUX_READSCREEN_SEQ=""
MOCK_CMUX_READSCREEN="annie@mac ~ %"
sync_additive_bootstrap 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:7"; then
  pass "without the flag the bootstrap heal sweep still heals (status quo)"
else fail "bootstrap sweep stopped healing; ops: $MOCK_CMUX_OPS"; fi

# ── FLY-254 Codex code review R1 findings — behavioral coverage ──

echo "Test: FLY-254 CR-HIGH-1 — already-readable escalated fast path hits the in-helper final guard"
setup_escalation_scenario
MOCK_CMUX_READSCREEN_SEQ="annie@mac ~ %"   # readable immediately — no focus needed
MOCK_TMUX_CLIENTS="cmux-lead-a=0,0,1"      # 3rd client read = the helper's final guard → 1
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace"; then
  fail "client appeared at the helper guard but the fast path still sent"
else pass "fast path blocked by the in-helper final 0-client guard"; fi

echo "Test: FLY-254 CR-HIGH-1 — client appearing during bookkeeping blocks the render-loop send"
setup_escalation_scenario
MOCK_TMUX_CLIENTS="cmux-lead-a=0,0,0,1"    # 4th read = in-helper guard after bookkeeping
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace"; then
  fail "client appeared during bookkeeping but send still fired"
else pass "render-loop send blocked by the in-helper final guard"; fi

echo "Test: FLY-254 CR-HIGH-2 — identity flip during readiness aborts the consume"
setup_escalation_scenario
MOCK_TMUX_WINDOWS=$'flywheel|@7|lead-a\nflywheel|@9|lead-c'   # lead-c has no workspace → readiness waits
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
export FLYWHEEL_CMUX_READINESS_TICKS=2
MOCK_SLEEP_HOOK='[[ "$MOCK_SLEEPS" -ge 1 ]] && MOCK_SOCK_IDENT="B:2:2"'
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace\|send --workspace"; then
  fail "consume swept after the generation changed during readiness"
else pass "no sweep on a generation whose budget was never charged"; fi
if grep -q "generation changed during readiness" "$TMPDIR_ROOT/t254.log"; then
  pass "readiness-abort logged"
else fail "expected readiness-abort log"; fi
if grep -q "^A:1:1|pending|1$" "$CMUX_SOCK_IDENT_FILE"; then
  pass "old generation NOT marked done (next tick arms the new identity cleanly)"
else fail "file: $(cat "$CMUX_SOCK_IDENT_FILE")"; fi
export FLYWHEEL_CMUX_READINESS_TICKS=5

echo "Test: FLY-254 CR-HIGH-2 — generation pin stops focus escalation mid-sweep"
reset_mocks
MOCK_TMUX_WINDOWS=$'flywheel|@7|lead-a\nflywheel|@8|lead-b'
MOCK_TMUX_SESSIONS=$'flywheel\ncmux-lead-a\ncmux-lead-b'
MOCK_TMUX_CLIENTS=$'cmux-lead-a=0\ncmux-lead-b=0'
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"home","ref":"workspace:1","selected":true},{"title":"lead-a","ref":"workspace:7"},{"title":"lead-b","ref":"workspace:8"}]}'
MOCK_CMUX_SURFACES=$'workspace:7;;surface:7;;terminal;;true\nworkspace:8;;surface:8;;terminal;;true'
MOCK_CMUX_READSCREEN_SEQ="FAIL,annie@mac ~ %,FAIL"
export FLYWHEEL_CMUX_RENDER_WAIT_TICKS=3
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
MOCK_SLEEP_HOOK='[[ "$MOCK_SLEEPS" -ge 1 ]] && MOCK_SOCK_IDENT="B:2:2"'   # flips during lead-a render wait
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:8"; then
  fail "generation changed mid-sweep but lead-b was still focused"
else pass "generation pin stops remaining focus escalation"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:1"; then
  fail "restore fired after a mid-sweep generation change"
else pass "no restore after a mid-sweep generation change"; fi
if grep -q "generation changed mid-sweep" "$TMPDIR_ROOT/t254.log"; then
  pass "mid-sweep abort logged"
else fail "expected mid-sweep abort log"; fi

echo "Test: FLY-254 CR-M3 — unwritable HEAL_STATE cannot kill the watcher"
setup_escalation_scenario
SAVED_HEAL_STATE="$HEAL_STATE"
HEAL_STATE="$TMPDIR_ROOT/healdir"
mkdir -p "$HEAL_STATE"
SURVIVED=$( (set -euo pipefail
  HEAL_RENDER_ESCALATE=1
  self_heal_sweep_all
  echo SURVIVED) 2>/dev/null )
HEAL_STATE="$SAVED_HEAL_STATE"
if [[ "$SURVIVED" == *SURVIVED* ]]; then
  pass "escalated sweep survives HEAL_STATE being a directory under set -e"
else fail "HEAL_STATE-as-directory killed the sweep"; fi

echo "Test: FLY-254 CR-M4 — arithmetic overflow / out-of-range attempts are malformed"
reset_mocks
MOCK_SOCK_IDENT="O:1:1"
echo "O:1:1|pending|99999999999999999999" > "$CMUX_SOCK_IDENT_FILE"
consume_pending_reopen_sweep 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace\|send --workspace"; then
  fail "overflow attempts field was consumed"
else pass "overflow attempts → not consumable"; fi
reopen_detector_check 2>/dev/null
if grep -q "^O:1:1|done|0$" "$CMUX_SOCK_IDENT_FILE"; then
  pass "detector resets the overflow state to done (fail-closed)"
else fail "file: $(cat "$CMUX_SOCK_IDENT_FILE")"; fi
reset_mocks
MOCK_SOCK_IDENT="O:1:1"
echo "O:1:1|pending|4" > "$CMUX_SOCK_IDENT_FILE"   # beyond writer's representable set
consume_pending_reopen_sweep 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace\|send --workspace"; then
  fail "attempts=4 (unrepresentable) was consumed"
else pass "attempts outside 0..3 → malformed, not consumable"; fi
V=$(validated_int_env TEST_KNOB "18446744073709551617" 6 60 2>/dev/null)
if [[ "$V" == "6" ]]; then
  pass "64-bit wrap value → default (lexical length cap)"
else fail "wrap value accepted: got $V"; fi

echo "Test: FLY-254 CR-M5 — malformed selected ref disables focus mutations"
setup_escalation_scenario
MOCK_CMUX_WORKSPACES_JSON='{"workspaces":[{"title":"home","ref":"not-a-workspace-ref","selected":true},{"title":"lead-a","ref":"workspace:7"}]}'
HEAL_RENDER_ESCALATE=1 self_heal_sweep_all 2>/dev/null
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace"; then
  fail "illegal selected ref accepted as a focus snapshot"
else pass "illegal selected ref → zero focus mutations (fail-closed)"; fi

echo "Test: FLY-254 CR-M6 — settled generation costs the healthy tick zero file IO"
reset_mocks
MOCK_SOCK_IDENT="S:1:1"
write_generation_state "S:1:1" done 1 2>/dev/null   # warms the in-process cache
rm -f "$CMUX_SOCK_IDENT_FILE"                        # remove the file entirely
reopen_detector_check 2>/dev/null                    # fast path must not read/recreate it
if [[ ! -f "$CMUX_SOCK_IDENT_FILE" ]]; then
  pass "detector fast path: zero file IO when identity matches the cache"
else fail "detector touched the state file on the steady-state fast path"; fi

echo "Test: FLY-254 CR-M6/L9 behavioral — persistent done-write failure cannot exceed the durable budget"
setup_escalation_scenario
MOCK_SOCK_IDENT="X:1:1"
echo "X:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
# Wrap the writer: 'done' writes fail persistently; everything else is real.
eval "$(declare -f write_generation_state | sed '1s/write_generation_state/write_generation_state_real/')"
write_generation_state() {
  if [[ "$2" == "done" ]]; then return 1; fi
  write_generation_state_real "$@"
}
TOTAL_SWEEPS=0
for _round in 1 2 3 4 5; do
  # Simulate a watcher restart: cold cache + fresh per-call mock counters.
  REOPEN_CACHE_IDENT=""; REOPEN_CACHE_STATE=""
  rm -f "$TMPDIR_ROOT"/clients.*.n "$TMPDIR_ROOT"/readscreen.n
  MOCK_CMUX_OPS=""
  consume_pending_reopen_sweep 2>>"$TMPDIR_ROOT/t254.log"
  if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:7"; then
    TOTAL_SWEEPS=$((TOTAL_SWEEPS + 1))
  fi
done
eval "$(declare -f write_generation_state_real | sed '1s/write_generation_state_real/write_generation_state/')"
unset -f write_generation_state_real
if [[ "$TOTAL_SWEEPS" -eq 3 ]]; then
  pass "exactly 3 sweeps across restarts under persistent done-write failure (durable cap)"
else fail "expected 3 sweeps under done-write failure, got $TOTAL_SWEEPS"; fi
if grep -q "attempt budget exhausted" "$TMPDIR_ROOT/t254.log"; then
  pass "give-up logged after budget exhaustion"
else fail "expected give-up log"; fi

echo "Test: FLY-254 CR-L8 — slice larger than total cannot oversleep"
reset_mocks
CMUX_HEALTH_LAST_RC=1
export FLYWHEEL_CMUX_SOCKET_PROBE_SLICE=60
reopen_aware_sleep 15 2>/dev/null
if [[ "$MOCK_SLEEP_ARGS" == "15 " ]]; then
  pass "single min(slice,total) step of 15s (requested total honored)"
else fail "oversleep: slept '$MOCK_SLEEP_ARGS' for a 15s request"; fi
export FLYWHEEL_CMUX_SOCKET_PROBE_SLICE=3

echo "Test: FLY-254 CR-M7 — probe structure (unrendered diagnostic + trap restore + ref validation)"
PROBE_SH="$SCRIPT_DIR/fly254-p0-probe.sh"
if grep -q 'Terminal surface not found' "$PROBE_SH" \
   && grep -q 'trap restore_focus EXIT' "$PROBE_SH" \
   && grep -q "trap 'exit 130' INT" "$PROBE_SH" \
   && grep -q 'is_ws_ref' "$PROBE_SH"; then
  pass "probe requires the unrendered diagnostic, arms restore-on-EXIT + terminating signal traps, validates refs"
else fail "probe missing diagnostic requirement / trap split / ref validation"; fi

echo "Test: FLY-254 CR-R2-HIGH-1 — single-workspace identity flip during render wait: zero send, zero restore"
setup_escalation_scenario
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
MOCK_CMUX_READSCREEN_SEQ="FAIL,annie@mac ~ %"   # would render fine — but the generation flips first
MOCK_SLEEP_HOOK='[[ "$MOCK_SLEEPS" -ge 1 ]] && MOCK_SOCK_IDENT="B:2:2"'   # flips during the render wait
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:7"; then
  pass "focus happened on generation A (pre-flip)"
else fail "expected the initial ws7 focus; ops: $MOCK_CMUX_OPS"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace"; then
  fail "send landed on generation B (uncharged cross-generation send)"
else pass "no send after the generation flipped (post-render-wait re-check)"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:1"; then
  fail "restore landed on generation B"
else pass "no restore after the generation flipped (latch suppresses epilogue)"; fi
if grep -q "generation changed mid-sweep" "$TMPDIR_ROOT/t254.log"; then
  pass "mid-sweep generation flip logged"
else fail "expected mid-sweep flip log"; fi

echo "Test: FLY-254 CR-R2-M2 behavioral — TERM during probe polling terminates + restores exactly once"
# (TERM, not INT: background jobs in a non-interactive shell ignore SIGINT
# per POSIX — the INT trap is for interactive operator use and shares the
# exact same exit-via-EXIT-trap mechanism being tested here.)
mkdir -p "$TMPDIR_ROOT/fakebin"
FAKE_CMUX_LOG="$TMPDIR_ROOT/fakecmux.log"
> "$FAKE_CMUX_LOG"
cat > "$TMPDIR_ROOT/fakebin/cmux" <<FAKECMUX
#!/bin/bash
LOG="$FAKE_CMUX_LOG"
if [[ "\$1" == "--socket" ]]; then shift 2; fi
if [[ "\$1" == "--json" ]]; then shift; fi
case "\$1" in
  ping) echo PONG ;;
  list-workspaces)
    echo '{"workspaces":[{"title":"home","ref":"workspace:1","selected":true},{"title":"lead-a","ref":"workspace:7"}]}' ;;
  read-screen)
    echo "Error: internal_error: ERROR: Terminal surface not found" >&2
    exit 1 ;;
  select-workspace)
    echo "select \$*" >> "\$LOG"
    echo OK ;;
  *) echo OK ;;
esac
FAKECMUX
chmod +x "$TMPDIR_ROOT/fakebin/cmux"
# A unix socket file so the probe's [[ -S ]] precheck passes. CR-R3 LOW:
# AF_UNIX bind is rejected in some sandboxes — capability-check and SKIP
# (matching the harness's existing real-tmux skip pattern) instead of
# failing the whole run.
if ! python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.bind('$TMPDIR_ROOT/fake.sock')" 2>/dev/null; then
  echo "  ⏭  AF_UNIX bind unavailable (sandbox/restricted env) — skipping probe signal test"
  rm -f "$TMPDIR_ROOT/fake.sock" 2>/dev/null
else
  CMUX_SOCKET_PATH="$TMPDIR_ROOT/fake.sock" PATH="$TMPDIR_ROOT/fakebin:$PATH" \
    /bin/bash "$SCRIPT_DIR/fly254-p0-probe.sh" > "$TMPDIR_ROOT/probe.out" 2>&1 &
  PROBE_PID=$!
  # Wait until the target focus is logged (probe is in its polling loop), then TERM.
  for _i in $(seq 1 50); do
    grep -q "workspace:7" "$FAKE_CMUX_LOG" 2>/dev/null && break
    command sleep 0.2
  done
  kill -TERM "$PROBE_PID" 2>/dev/null
  PROBE_RC=0
  wait "$PROBE_PID" || PROBE_RC=$?
  if [[ "$PROBE_RC" -eq 143 ]]; then
    pass "TERM terminates the probe (rc=143, no zombie polling)"
  else fail "expected rc=143 on TERM, got $PROBE_RC; out: $(tail -3 "$TMPDIR_ROOT/probe.out")"; fi
  RESTORES=$(grep -c "select-workspace --workspace workspace:1" "$FAKE_CMUX_LOG" 2>/dev/null)
  if [[ "$RESTORES" -eq 1 ]]; then
    pass "exactly one restore to the original tab on interrupt"
  else fail "expected 1 restore, got $RESTORES; log: $(cat "$FAKE_CMUX_LOG")"; fi
  if grep -q "RESULT: PASS" "$TMPDIR_ROOT/probe.out"; then
    fail "interrupted probe still reported PASS"
  else pass "no PASS verdict from an interrupted probe"; fi
  rm -f "$TMPDIR_ROOT/fake.sock"
fi

echo "Test: FLY-254 CR-R3-HIGH-1 — identity flip DURING the pre-focus selected-ref IPC"
setup_escalation_scenario
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
# JSON call #4 is the pre-focus current_selected_ref (1=readiness, 2=sweep
# snapshot, 3=one_workspace refs, 4=pre-focus read). The flip lands while
# that IPC is in flight; the re-stat immediately before select-workspace
# must catch it — ZERO focus on generation B.
MOCK_JSON_FLIP_IDENT="B:2:2"
MOCK_JSON_FLIP_AT=4
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace\|send --workspace"; then
  fail "focus/send landed on generation B (flip during pre-focus IPC); ops: $MOCK_CMUX_OPS"
else pass "pre-select re-stat blocks the focus after a flip during the JSON IPC"; fi
if grep -q "generation changed mid-sweep" "$TMPDIR_ROOT/t254.log"; then
  pass "latch logged for the pre-focus IPC flip"
else fail "expected mid-sweep flip log"; fi

echo "Test: FLY-254 CR-R3-HIGH-1 — identity flip DURING the epilogue selected-ref IPC"
setup_escalation_scenario
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
# JSON call #6 is the epilogue current_selected_ref (5 = render-loop refs).
# The heal completes on A; the flip lands during the epilogue read; the
# pre-restore re-stat must skip the restore — generation B keeps its focus.
MOCK_JSON_FLIP_IDENT="B:2:2"
MOCK_JSON_FLIP_AT=6
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:7"; then
  pass "heal completed on generation A before the flip"
else fail "expected the ws7 heal on A; ops: $MOCK_CMUX_OPS"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:1"; then
  fail "restore landed on generation B (flip during epilogue IPC)"
else pass "pre-restore re-stat blocks the restore after a flip during the JSON IPC"; fi
if grep -q "generation changed before restore" "$TMPDIR_ROOT/t254.log"; then
  pass "latch logged for the epilogue IPC flip"
else fail "expected before-restore flip log"; fi

echo "Test: FLY-254 CR-R4-HIGH-1 — the final stat is the GENUINE last op before the restore mutation"
setup_escalation_scenario
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
# Hook `log`: flip the identity the moment the restored-focus message is
# emitted. With the log AFTER the mutation the flip lands too late and the
# select mock records ident=A; a regression (log before select) would make
# the flip land first and the mock would record ident=B.
eval "$(declare -f log | sed '1s/^log/log_real_254/')"
log() {
  # CR-R5 M2 honesty fix: match BOTH message forms — against the pre-R4 code
  # ("restoring focus", emitted BEFORE the mutation) this hook flips first
  # and the select records ident=B → the test goes RED; against the fixed
  # code ("restored focus", after the mutation) it stays green.
  if [[ "$*" == *"restor"*"focus"* ]]; then
    printf '%s' "B:2:2" > "$TMPDIR_ROOT/mock-ident.override"
  fi
  log_real_254 "$@"
}
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
eval "$(declare -f log_real_254 | sed '1s/^log_real_254/log/')"
unset -f log_real_254
RESTORE_LINE=$(echo "$MOCK_CMUX_OPS" | grep "select-workspace --workspace workspace:1")
if [[ "$RESTORE_LINE" == *"ident=A:1:1"* ]]; then
  pass "restore mutation observed generation A (no bookkeeping between stat and select)"
else fail "restore observed the wrong generation: $RESTORE_LINE"; fi

# ── CR-R5 HIGH-1: the wrapper's own mktemp is the last bookkeeping step —
# the guard must run AFTER it. The hook below flips the identity exactly at
# the Nth guarded mktemp (guarded mktemps in the happy path: 1=pre-focus
# select, 2=send, 3=restore). Against the pre-R5 implementation (guards
# outside the wrapper) every one of these flips lands AFTER the guard and
# the mutation executes on B — red/green verified by stashing the fix.
MKTEMP_FLIP_HOOK='gn=0; [[ -f "$TMPDIR_ROOT/gmk.n" ]] && gn=$(cat "$TMPDIR_ROOT/gmk.n"); gn=$((gn+1)); echo "$gn" > "$TMPDIR_ROOT/gmk.n"; [[ "$gn" -ge "${MOCK_MKTEMP_FLIP_AT:-1}" ]] && printf "%s" "B:2:2" > "$TMPDIR_ROOT/mock-ident.override"'

echo "Test: FLY-254 CR-R5-HIGH-1 — identity flip at the wrapper's mktemp blocks the FOCUS"
setup_escalation_scenario
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
MOCK_MKTEMP_FLIP_AT=1
MOCK_MKTEMP_HOOK="$MKTEMP_FLIP_HOOK"
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace\|send --workspace"; then
  fail "mutation executed on generation B (flip at the wrapper mktemp); ops: $MOCK_CMUX_OPS"
else pass "in-wrapper guard blocks the focus after a flip at the wrapper's mktemp"; fi
if grep -q "generation changed mid-sweep" "$TMPDIR_ROOT/t254.log"; then
  pass "latch logged for the wrapper-boundary flip"
else fail "expected mid-sweep flip log"; fi

echo "Test: FLY-254 CR-R5-HIGH-1 — identity flip at the wrapper's mktemp blocks the SEND"
setup_escalation_scenario
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
MOCK_MKTEMP_FLIP_AT=2   # 1=pre-focus select (passes on A), 2=the send
MOCK_MKTEMP_HOOK="$MKTEMP_FLIP_HOOK"
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:7 ident=A:1:1"; then
  pass "focus executed on generation A (pre-flip)"
else fail "expected the ws7 focus on A; ops: $MOCK_CMUX_OPS"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace"; then
  fail "send executed on generation B (flip at the wrapper mktemp)"
else pass "in-wrapper guard blocks the send after a flip at the wrapper's mktemp"; fi

echo "Test: FLY-254 CR-R5-HIGH-1 — identity flip at the wrapper's mktemp blocks the RESTORE"
setup_escalation_scenario
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
MOCK_MKTEMP_FLIP_AT=3   # 1=pre-focus select, 2=send, 3=the restore
MOCK_MKTEMP_HOOK="$MKTEMP_FLIP_HOOK"
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
if echo "$MOCK_CMUX_OPS" | grep -q "send --workspace workspace:7"; then
  pass "heal completed on generation A before the flip"
else fail "expected the ws7 heal on A; ops: $MOCK_CMUX_OPS"; fi
if echo "$MOCK_CMUX_OPS" | grep -q "select-workspace --workspace workspace:1"; then
  fail "restore executed on generation B (flip at the wrapper mktemp)"
else pass "in-wrapper guard blocks the restore after a flip at the wrapper's mktemp"; fi
if grep -q "generation changed before restore" "$TMPDIR_ROOT/t254.log"; then
  pass "latch logged for the wrapper-boundary restore flip"
else fail "expected before-restore flip log"; fi

echo "Test: FLY-254 CR-R6-LOW — a real cmux exit code is never misread as a guard block"
setup_escalation_scenario
MOCK_SOCK_IDENT="A:1:1"
echo "A:1:1|pending|0" > "$CMUX_SOCK_IDENT_FILE"
MOCK_CMUX_SELECT_RC=99   # the old sentinel value, now a plain cmux failure
consume_pending_reopen_sweep 2>"$TMPDIR_ROOT/t254.log"
MOCK_CMUX_SELECT_RC=""
if grep -q "generation changed mid-sweep" "$TMPDIR_ROOT/t254.log"; then
  fail "cmux rc=99 was misread as a generation-change guard block"
else pass "cmux rc=99 handled as a plain select failure (GUARD_WAS_BLOCKED side channel)"; fi
if grep -q "WARN: cmux select-workspace failed (rc=99)" "$TMPDIR_ROOT/t254.log"; then
  pass "plain cmux failure logged through the wrapper's WARN path"
else fail "expected the wrapper WARN for rc=99; log: $(grep WARN "$TMPDIR_ROOT/t254.log" | head -2)"; fi

set +e   # restore lenient mode for the summary

# ════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════
echo ""
echo "────────────────────────────"
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -eq 0 ]]; then
  echo "✅ All tests passed"
  exit 0
else
  echo "❌ Some tests failed"
  exit 1
fi
