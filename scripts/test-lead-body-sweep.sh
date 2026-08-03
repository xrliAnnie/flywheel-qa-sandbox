#!/usr/bin/env bash
# FLY-1507: source-level tests for Lead body inventory, termination, and
# newborn/model verification. Runs under the production macOS bash 3.2.
set -u

PASS=0
FAIL=0
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

# Production dependencies are sourced before the production unit under test.
# shellcheck source=../packages/teamlead/scripts/lib/lead-identity-preflight.sh
source "$ROOT/packages/teamlead/scripts/lib/lead-identity-preflight.sh"
# shellcheck source=../packages/teamlead/scripts/lib/tmux-supervisor-guard.sh
source "$ROOT/packages/teamlead/scripts/lib/tmux-supervisor-guard.sh"
# shellcheck source=lib/lead-body-sweep.sh
source "$ROOT/scripts/lib/lead-body-sweep.sh"
PRODUCTION_SWEEP_TMUX_DEFINITION="$(declare -f _sweep_tmux)"

INVENTORY=""
PROCESS_TABLE=""
PROCESS_TABLE_FAIL=0
TMUX_CALLS=""
TMUX_CALL_FILE="$TMP_ROOT/tmux.calls"
SIGNAL_CALLS=""
DEAD_PIDS=""
SURVIVE_SIGNALS=""
START_FAILURE_PIDS=""
COMMAND_FAILURE_PIDS=""
DISAPPEARING_PID=""
DISAPPEARING_AFTER_INTERRUPT=0
DISAPPEARING_ALIVE_PROBES=0
TMUX_SET_WINDOW_FAIL=0

fixture_start() {
  case "$1" in
    101) echo "Mon Jul 27 10:00:01 2026" ;;
    102) echo "Mon Jul 27 10:00:02 2026" ;;
    201) echo "Mon Jul 27 10:00:03 2026" ;;
    301) echo "Mon Jul 27 09:00:00 2026" ;;
    302) echo "Mon Jul 27 11:00:00 2026" ;;
    303) echo "Mon Jul 27 11:00:01 2026" ;;
    304) echo "Mon Jul 27 11:00:02 2026" ;;
    401) echo "Mon Jul 27 12:00:00 2026" ;;
    501) echo "Mon Jul 27 13:00:00 2026" ;;
    *) return 1 ;;
  esac
}

fixture_command() {
  case "$1" in
    101|201|301)
      echo "claude --agent lead --append-system-prompt-file /tmp/lead-rules-bundles/proj-lead.9-lstart-a.md --model claude-fable-5 --resume session-old"
      ;;
    102)
      echo "claude --agent lead --append-system-prompt-file /tmp/lead-rules-bundles/other-lead.9-lstart-a.md --model claude-opus-4-8"
      ;;
    302)
      echo "claude --agent lead --append-system-prompt-file /tmp/lead-rules-bundles/proj-lead.10-lstart-b.md --model claude-fable-5 --session-id session-new"
      ;;
    303)
      echo "codex resume --remote unix:///tmp/codex/app-server-control/app-server-control.sock -C /tmp/work -s workspace-write -c approval_policy=never 11111111-1111-1111-1111-111111111111"
      ;;
    304)
      echo "claude --agent lead --append-system-prompt-file /rules/inbox-ack-rule.md --append-system-prompt-file /rules/project-lead-rules.md --model claude-fable-5"
      ;;
    501)
      echo "claude --agent lead --append-system-prompt-file /tmp/lead-rules-bundles/proj-lead.13-lstart-d.md --model claude-fable-5"
      ;;
    401)
      echo "/bin/zsh"
      ;;
    *) return 1 ;;
  esac
}

lead_body_process_start_identity() {
  case " $START_FAILURE_PIDS " in *" $1 "*) return 1 ;; esac
  if [[ "$1" == "$DISAPPEARING_PID" \
    && "$DISAPPEARING_AFTER_INTERRUPT" -eq 1 \
    && "$DISAPPEARING_ALIVE_PROBES" -gt 0 ]]; then
    return 0
  fi
  fixture_start "$1"
}

lead_body_process_command() {
  case " $COMMAND_FAILURE_PIDS " in *" $1 "*) return 1 ;; esac
  fixture_command "$1"
}

lead_body_process_table() {
  (( PROCESS_TABLE_FAIL == 0 )) || return 1
  printf '%s\n' "$PROCESS_TABLE"
}

lead_body_process_alive() {
  if [[ "$1" == "$DISAPPEARING_PID" ]]; then
    if (( DISAPPEARING_AFTER_INTERRUPT == 0 )); then
      return 0
    fi
    DISAPPEARING_ALIVE_PROBES=$((DISAPPEARING_ALIVE_PROBES + 1))
    [[ "$DISAPPEARING_ALIVE_PROBES" -eq 1 ]]
    return
  fi
  case " $DEAD_PIDS " in *" $1 "*) return 1 ;; esac
  fixture_start "$1" >/dev/null 2>&1
}

lead_body_signal() {
  local signal="$1" pid="$2"
  SIGNAL_CALLS="${SIGNAL_CALLS}${signal}:${pid}"$'\n'
  case " $SURVIVE_SIGNALS " in
    *" $pid "*) ;;
    *) [ "$signal" = "TERM" ] && DEAD_PIDS="${DEAD_PIDS} ${pid}" ;;
  esac
  return 0
}

lead_body_sleep() { return 0; }

_sweep_tmux() {
  TMUX_CALLS="${TMUX_CALLS}$*"$'\n'
  printf '%s\n' "$*" >> "$TMUX_CALL_FILE"
  case "${1:-}" in
    list-panes)
      if [[ -n "$DISAPPEARING_PID" \
        && "$DISAPPEARING_AFTER_INTERRUPT" -eq 1 \
        && "$DISAPPEARING_ALIVE_PROBES" -ge 2 ]]; then
        printf '%s\n' "$INVENTORY" \
          | awk -F '\t' -v pid="$DISAPPEARING_PID" \
            'BEGIN { OFS="|" } $4 != pid { print $1, $2, $3, $4, $5 }'
      else
        printf '%s\n' "$INVENTORY" \
          | awk -F '\t' 'BEGIN { OFS="|" } NF { print $1, $2, $3, $4, $5 }'
      fi
      ;;
    send-keys)
      [[ -z "$DISAPPEARING_PID" ]] || DISAPPEARING_AFTER_INTERRUPT=1
      return 0
      ;;
    set-window-option)
      (( TMUX_SET_WINDOW_FAIL == 0 ))
      ;;
    kill-window) return 0 ;;
    *) return 1 ;;
  esac
}
FIXTURE_SWEEP_TMUX_DEFINITION="$(declare -f _sweep_tmux)"

reset_fixture() {
  INVENTORY=""
  PROCESS_TABLE=""
  PROCESS_TABLE_FAIL=0
  TMUX_CALLS=""
  : > "$TMUX_CALL_FILE"
  SIGNAL_CALLS=""
  DEAD_PIDS=""
  SURVIVE_SIGNALS=""
  START_FAILURE_PIDS=""
  COMMAND_FAILURE_PIDS=""
  DISAPPEARING_PID=""
  DISAPPEARING_AFTER_INTERRUPT=0
  DISAPPEARING_ALIVE_PROBES=0
  TMUX_SET_WINDOW_FAIL=0
  LEAD_BODY_RULES_STATE_DIR="$TMP_ROOT/rules-state"
  mkdir -p "$LEAD_BODY_RULES_STATE_DIR"
  LEAD_BODY_INTERRUPT_ATTEMPTS=0
  LEAD_BODY_TERM_ATTEMPTS=0
  LEAD_BODY_KILL_ATTEMPTS=0
}

echo "Test: FLY-1602 tmux inventory survives a no-locale launchd environment"
real_tmux_socket="$TMP_ROOT/no-locale-tmux.sock"
real_inventory=""
real_inventory_rc=0
real_window=""
real_name=""
real_pane=""
real_pid=""
real_dead=""
if env -u LANG -u LC_ALL -u LC_CTYPE \
  tmux -S "$real_tmux_socket" new-session -d -s flywheel -n proj-lead "sleep 30" \
  >/dev/null 2>&1; then
  eval "$PRODUCTION_SWEEP_TMUX_DEFINITION"
  real_inventory="$(
    unset LANG LC_ALL LC_CTYPE
    export FLYWHEEL_TMUX_SOCKET_OVERRIDE="$real_tmux_socket"
    lead_body_pane_inventory
  )" || real_inventory_rc=$?
  tmux -S "$real_tmux_socket" kill-server >/dev/null 2>&1 || true
  unset FLYWHEEL_TMUX_SOCKET_OVERRIDE
  eval "$FIXTURE_SWEEP_TMUX_DEFINITION"
  IFS=$'\t' read -r real_window real_name real_pane real_pid real_dead <<EOF
$real_inventory
EOF
  if (( real_inventory_rc == 0 )) \
    && [[ "$real_window" == @* ]] \
    && [[ "$real_name" == proj-lead ]] \
    && [[ "$real_pane" == %* ]] \
    && [[ "$real_pid" =~ ^[0-9]+$ ]] \
    && [[ "$real_dead" == 0 ]]; then
    pass "real tmux inventory remains parseable with LANG/LC_ALL/LC_CTYPE unset"
  else
    fail "no-locale real tmux inventory was not parseable (rc=$real_inventory_rc inventory=$real_inventory)"
  fi
else
  fail "real tmux fixture could not start"
fi

echo "Test: FLY-1602 adoption HOLD evidence is always valid JSON"
provided_hold_evidence='{"reason":"adoption_evidence_not_closed"}'
if type lead_body_adoption_hold_evidence >/dev/null 2>&1; then
  default_hold_evidence="$(lead_body_adoption_hold_evidence "")"
  preserved_hold_evidence="$(lead_body_adoption_hold_evidence "$provided_hold_evidence")"
  if printf '%s' "$default_hold_evidence" | jq -e '.reason == "adoption_hold"' >/dev/null 2>&1 \
    && [[ "$preserved_hold_evidence" == "$provided_hold_evidence" ]] \
    && printf '%s' "$preserved_hold_evidence" | jq -e '.reason == "adoption_evidence_not_closed"' >/dev/null 2>&1 \
    && rg -q 'lead_body_adoption_hold_evidence' "$ROOT/packages/teamlead/scripts/claude-lead.sh"; then
    pass "default and caller-provided HOLD evidence stay valid and production-wired"
  else
    fail "adoption HOLD evidence was malformed, rewritten, or not wired"
  fi
else
  fail "adoption HOLD evidence helper is missing"
fi

echo "Test: FLY-1602 adoption evidence closes every source without mutating archive"
reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t301\t0'
PROCESS_TABLE="301 $(fixture_command 301)"
archive="$TMP_ROOT/adoption.archive"
printf '99\t301\t%s\t@1\n' "$(fixture_start 301)" > "$archive"
archive_before="$(shasum -a 256 "$archive" | awk '{print $1}')"
evidence="$(lead_body_adoption_evidence \
  proj lead claude-code "$archive" 301 "$(fixture_start 301)" 2>/dev/null || true)"
archive_after="$(shasum -a 256 "$archive" | awk '{print $1}')"
if grep -q '^#status=complete$' <<<"$evidence" \
  && grep -q $'^301\tMon Jul 27 09:00:00 2026\tfull\twindow\t@1\t%1\tsession-old$' <<<"$evidence" \
  && [[ "$archive_before" == "$archive_after" ]]; then
  pass "adoption evidence proves one exact body/window/session and leaves archive byte-identical"
else
  fail "positive adoption evidence mismatch: $(tr '\n' '|' <<<"$evidence")"
fi

echo "Test: FLY-1602 adoption evidence rejects extras, detect-only rows, and sensor loss"
reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t301\t0\n@2\tproj-lead\t%2\t302\t0'
PROCESS_TABLE="301 $(fixture_command 301)"$'\n'"302 $(fixture_command 302)"
if lead_body_adoption_evidence \
  proj lead claude-code "$TMP_ROOT/missing.archive" 301 "$(fixture_start 301)" >/dev/null 2>&1; then
  fail "a second matching body/window passed adoption evidence"
else
  pass "a second matching body/window blocks adoption"
fi

reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t301\t0'
PROCESS_TABLE="301 $(fixture_command 301)"$'\n'"102 $(fixture_command 102)"
if lead_body_adoption_evidence \
  proj lead claude-code "$TMP_ROOT/missing.archive" 301 "$(fixture_start 301)" >/dev/null 2>&1; then
  fail "a detect-only same-identity process passed adoption evidence"
else
  pass "a detect-only same-identity process blocks adoption"
fi

reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t301\t0'
PROCESS_TABLE_FAIL=1
evidence="$(lead_body_adoption_evidence \
  proj lead claude-code "$TMP_ROOT/missing.archive" 301 "$(fixture_start 301)" 2>/dev/null || true)"
if grep -q '^#status=indeterminate$' <<<"$evidence"; then
  pass "process-table sensor loss is explicitly indeterminate"
else
  fail "sensor loss did not fail closed: $(tr '\n' '|' <<<"$evidence")"
fi

echo "Test: FLY-1602 adopted-body attach is idempotent and session-fenced"
reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t301\t0'
PROCESS_TABLE="301 $(fixture_command 301)"
evidence="$(lead_body_adoption_evidence \
  proj lead claude-code "$TMP_ROOT/missing.archive" 301 "$(fixture_start 301)")"
archive="$TMP_ROOT/attach.archive"
session_file="$TMP_ROOT/session.id"
manifest="$TMP_ROOT/adoption-manifest.json"
printf '{"resolvedModel":"claude-fable-5"}\n' > "$manifest"
if lead_body_attach_adopted \
  "$evidence" 99 "$archive" "$session_file" "$manifest" \
  && [ "$LEAD_ADOPTION_WINDOW_ID" = @1 ] \
  && [ "$LEAD_ADOPTION_PANE_PID" = 301 ] \
  && [ "$(cat "$session_file")" = session-old ] \
  && tmux_supervisor_archive_read "$archive" \
  && [ "$TMUX_ARCHIVE_SERVER_PID" = 99 ]; then
  pass "attach rebuilds missing archive/session metadata for the exact body"
else
  fail "positive adopted-body attach failed"
fi
if lead_body_attach_adopted \
  "$evidence" 99 "$archive" "$session_file" "$manifest"; then
  pass "attach is idempotent after metadata recovery"
else
  fail "idempotent adopted-body attach failed"
fi
printf 'different-session\n' > "$session_file"
if lead_body_attach_adopted \
  "$evidence" 99 "$archive" "$session_file" "$manifest" >/dev/null 2>&1; then
  fail "session identity mismatch was overwritten"
elif [ "$(cat "$session_file")" = different-session ]; then
  pass "session identity mismatch HOLDs without overwriting evidence"
else
  fail "session identity mismatch mutated the session file"
fi

echo "Test: FLY-1602 adopted-body attach failures stay retryable after CAS"
reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t301\t0'
PROCESS_TABLE="301 $(fixture_command 301)"
evidence="$(lead_body_adoption_evidence \
  proj lead claude-code "$TMP_ROOT/missing.archive" 301 "$(fixture_start 301)")"
archive="$TMP_ROOT/attach-fault.archive"
session_file="$TMP_ROOT/attach-fault.session"
manifest="$TMP_ROOT/attach-fault-manifest.json"
printf '{"resolvedModel":"different-model"}\n' > "$manifest"
printf '88\t301\t%s\t@1\n' "$(fixture_start 301)" > "$archive"
archive_before="$(shasum -a 256 "$archive" | awk '{print $1}')"
if lead_body_attach_adopted \
  "$evidence" 99 "$archive" "$session_file" "$manifest" >/dev/null 2>&1; then
  fail "conflicting archive evidence passed post-CAS attach"
elif [[ "$(shasum -a 256 "$archive" | awk '{print $1}')" == "$archive_before" ]] \
  && [[ ! -e "$session_file" ]]; then
  pass "archive mismatch HOLDs without rewriting archive or session evidence"
else
  fail "archive mismatch mutated attachment evidence"
fi

printf '99\t301\t%s\t@1\n' "$(fixture_start 301)" > "$archive"
TMUX_SET_WINDOW_FAIL=1
if lead_body_attach_adopted \
  "$evidence" 99 "$archive" "$session_file" "$manifest" >/dev/null 2>&1; then
  fail "remain-on-exit failure passed post-CAS attach"
elif [[ ! -e "$session_file" ]] && [[ -z "$SIGNAL_CALLS" ]]; then
  pass "remain-on-exit failure HOLDs without restoring session or signalling body"
else
  fail "remain-on-exit failure caused forbidden post-CAS side effects"
fi

TMUX_SET_WINDOW_FAIL=0
if lead_body_attach_adopted \
  "$evidence" 99 "$archive" "$session_file" "$manifest" \
  && [[ "$LEAD_ADOPTION_MODEL_OBSERVATION" == mismatch ]] \
  && [[ "$(cat "$session_file")" == session-old ]]; then
  pass "same supervisor converges after transient attach failure; model drift is observation-only"
else
  fail "post-CAS attachment did not converge after external repair"
fi

INVENTORY=$'@2\tproj-lead\t%2\t301\t0'
if lead_body_attach_adopted \
  "$evidence" 99 "$archive" "$session_file" "$manifest" >/dev/null 2>&1; then
  fail "tmux identity drift passed post-CAS revalidation"
elif [[ -z "$SIGNAL_CALLS" ]]; then
  pass "tmux identity drift HOLDs without signalling the adopted body"
else
  fail "tmux identity drift signalled the adopted body"
fi

echo "Test: FLY-1507 target collection grades proof and deduplicates sources"
reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t101\t0\n@2\tproj-lead\t%2\t102\t0\n@9\tunrelated\t%9\t401\t0'
PROCESS_TABLE=$'101 claude --agent lead --append-system-prompt-file /tmp/lead-rules-bundles/proj-lead.9-lstart-a.md\n102 claude --agent lead --append-system-prompt-file /tmp/lead-rules-bundles/other-lead.9-lstart-a.md'
targets="$TMP_ROOT/targets.tsv"
rc=0
lead_body_collect_targets "proj" "lead" "claude-code" "$TMP_ROOT/missing.archive" "$targets" || rc=$?
if (( rc == 0 )) \
  && grep -q $'^101\tMon Jul 27 10:00:01 2026\tfull\t' "$targets" \
  && grep -q $'^102\tMon Jul 27 10:00:02 2026\tdetect\t' "$targets" \
  && [[ "$(grep -c '^101	' "$targets")" == "1" ]] \
  && grep -q '^#status=complete$' "$targets"; then
  pass "collector keeps exact-project full proof, cross-project detect, and one row per PID"
else
  fail "collector proof/dedup mismatch (rc=$rc): $(tr '\n' '|' < "$targets" 2>/dev/null)"
fi

echo "Test: FLY-1507 tmux inventory is scoped to the flywheel session"
if grep -q 'list-panes -s -t =flywheel' "$TMUX_CALL_FILE"; then
  pass "collector uses list-panes -s -t =flywheel"
else
  fail "collector crossed the tmux session boundary: $TMUX_CALLS"
fi

echo "Test: FLY-1507 archive sensor failure is indeterminate and preserves evidence"
reset_fixture
archive="$TMP_ROOT/lead.archive"
printf '99\t101\tMon Jul 27 10:00:01 2026\t@1\n' > "$archive"
START_FAILURE_PIDS="101"
rc=0
lead_body_collect_targets "proj" "lead" "claude-code" "$archive" "$targets" || rc=$?
if (( rc == 2 )) && grep -q '^#status=indeterminate$' "$targets" && [[ -f "$archive" ]]; then
  pass "archive lstart read failure fails closed without deleting the archive"
else
  fail "archive sensor failure was not preserved (rc=$rc status=$(head -1 "$targets"))"
fi

echo "Test: FLY-1507 staged termination stops at TERM and targets the exact pane"
reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t201\t0'
cat_target="$TMP_ROOT/terminate.tsv"
printf '#status=complete\n#project=proj\n#lead=lead\n#backend=claude-code\n201\tMon Jul 27 10:00:03 2026\tfull\twindow\t@1\t%%1\n' > "$cat_target"
rc=0
lead_body_terminate "$cat_target" "lead" "$TMP_ROOT/no.archive" || rc=$?
if (( rc == 0 )) \
  && echo "$TMUX_CALLS" | grep -q 'send-keys -t %1 C-c' \
  && echo "$SIGNAL_CALLS" | grep -q '^TERM:201$' \
  && ! echo "$SIGNAL_CALLS" | grep -q '^KILL:201$'; then
  pass "termination uses exact-pane C-c, TERM, and no unnecessary KILL"
else
  fail "termination staging mismatch (rc=$rc tmux=$TMUX_CALLS signals=$SIGNAL_CALLS)"
fi

echo "Test: FLY-1507 PID reuse is never signalled or window-killed"
reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t201\t0'
printf '#status=complete\n#project=proj\n#lead=lead\n#backend=claude-code\n201\tOLD START\tfull\twindow\t@1\t%%1\n' > "$cat_target"
rc=0
lead_body_terminate "$cat_target" "lead" "$TMP_ROOT/no.archive" || rc=$?
if (( rc == 2 )) && [[ -z "$SIGNAL_CALLS" ]] && ! echo "$TMUX_CALLS" | grep -q 'kill-window'; then
  pass "changed start identity blocks signals and whole-window cleanup"
else
  fail "PID reuse fence failed (rc=$rc tmux=$TMUX_CALLS signals=$SIGNAL_CALLS)"
fi

echo "Test: FLY-1507 a body surviving KILL returns failure"
reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t201\t0'
SURVIVE_SIGNALS="201"
printf '#status=complete\n#project=proj\n#lead=lead\n#backend=claude-code\n201\tMon Jul 27 10:00:03 2026\tfull\twindow\t@1\t%%1\n' > "$cat_target"
rc=0
lead_body_terminate "$cat_target" "lead" "$TMP_ROOT/no.archive" || rc=$?
if (( rc == 1 )) && echo "$SIGNAL_CALLS" | grep -q '^KILL:201$'; then
  pass "KILL survivor is reported as a failed sweep"
else
  fail "KILL survivor was not reported (rc=$rc signals=$SIGNAL_CALLS)"
fi

echo "Test: FLY-1507 a body reaped during lstart read is determined dead"
reset_fixture
DISAPPEARING_PID="501"
INVENTORY=$'@5\tproj-lead\t%5\t501\t0'
printf '#status=complete\n#project=proj\n#lead=lead\n#backend=claude-code\n501\tMon Jul 27 13:00:00 2026\tfull\twindow\t@5\t%%5\n' > "$cat_target"
rc=0
lead_body_terminate "$cat_target" "lead" "$TMP_ROOT/no.archive" || rc=$?
if (( rc == 0 )) \
  && (( DISAPPEARING_ALIVE_PROBES >= 2 )) \
  && echo "$TMUX_CALLS" | grep -q 'send-keys -t %5 C-c'; then
  pass "termination rechecks liveness after a C-c body is reaped during lstart"
else
  fail "post-C-c sensor race was reported unsafe (rc=$rc alive_probes=$DISAPPEARING_ALIVE_PROBES tmux=$TMUX_CALLS)"
fi

echo "Test: FLY-1507 orphan bodies cannot satisfy newborn verification"
for backend in claude-code codex-app-server; do
  reset_fixture
  if [[ "$backend" == "claude-code" ]]; then
    body=301
  else
    body=303
  fi
  INVENTORY="@1"$'\t'"proj-lead"$'\t'"%1"$'\t'"${body}"$'\t'"0"
  start="$(fixture_start "$body")"
  printf '#status=complete\n#project=proj\n#lead=lead\n#backend=%s\n%s\t%s\tfull\twindow\t@1\t%%1\n' \
    "$backend" "$body" "$start" > "$targets"
  if lead_body_newborn_ok "proj" "lead" "$targets" >/dev/null 2>&1; then
    fail "$backend accepted an old body as newborn"
  else
    pass "$backend rejects a live body present in the pre-restart snapshot"
  fi
done

echo "Test: FLY-1507 a single new proven body passes newborn verification"
for backend in claude-code codex-app-server; do
  reset_fixture
  if [[ "$backend" == "claude-code" ]]; then
    old=301
    body=302
  else
    old=301
    body=303
  fi
  DEAD_PIDS="$old"
  INVENTORY="@1"$'\t'"proj-lead"$'\t'"%1"$'\t'"${body}"$'\t'"0"
  printf '#status=complete\n#project=proj\n#lead=lead\n#backend=%s\n%s\t%s\tfull\twindow\t@old\t%%old\n' \
    "$backend" "$old" "$(fixture_start "$old")" > "$targets"
  evidence="$(lead_body_newborn_ok "proj" "lead" "$targets" 2>/dev/null || true)"
  if [[ "$evidence" == "${body}"$'\t'"$(fixture_start "$body")" ]]; then
    pass "$backend accepts exactly one new identity-proven body"
  else
    fail "$backend newborn evidence mismatch: '$evidence'"
  fi
done

echo "Test: FLY-1507 duplicate windows and extra live panes fail closed"
reset_fixture
DEAD_PIDS="301"
printf '#status=complete\n#project=proj\n#lead=lead\n#backend=claude-code\n301\t%s\tfull\twindow\t@old\t%%old\n' \
  "$(fixture_start 301)" > "$targets"
INVENTORY=$'@1\tproj-lead\t%1\t302\t0\n@2\tproj-lead\t%2\t302\t0'
if lead_body_newborn_ok "proj" "lead" "$targets" >/dev/null 2>&1; then
  fail "duplicate same-name windows passed newborn verification"
else
  pass "duplicate same-name windows are rejected"
fi
INVENTORY=$'@1\tproj-lead\t%1\t302\t0\n@1\tproj-lead\t%2\t401\t0'
if lead_body_newborn_ok "proj" "lead" "$targets" >/dev/null 2>&1; then
  fail "multi-pane window passed newborn verification"
else
  pass "a second live pane blocks newborn verification"
fi

echo "Test: FLY-1507 indeterminate snapshots can never produce newborn evidence"
reset_fixture
INVENTORY=$'@1\tproj-lead\t%1\t302\t0'
printf '#status=indeterminate\n#project=proj\n#lead=lead\n#backend=claude-code\n' > "$targets"
if lead_body_newborn_ok "proj" "lead" "$targets" >/dev/null 2>&1; then
  fail "indeterminate snapshot passed newborn verification"
else
  pass "indeterminate snapshot is fail-closed"
fi

echo "Test: FLY-1507 model evidence is exact and missing expected evidence is explicit"
reset_fixture
manifest="$TMP_ROOT/manifest.json"
printf '{"resolvedModel":"claude-fable-5"}\n' > "$manifest"
model="$(lead_body_model_evidence 302 "$manifest" 2>/dev/null || true)"
if [[ "$model" == "claude-fable-5" ]]; then
  pass "matching resolved model is emitted as body evidence"
else
  fail "matching model evidence failed: '$model'"
fi
printf '{"resolvedModel":"claude-sonnet-5"}\n' > "$manifest"
if lead_body_model_evidence 302 "$manifest" >/dev/null 2>&1; then
  fail "model mismatch was accepted"
else
  pass "model mismatch prevents restart success"
fi
printf '{}\n' > "$manifest"
model="$(lead_body_model_evidence 302 "$manifest" 2>/dev/null || true)"
if [[ "$model" == "claude-fable-5" ]]; then
  pass "missing resolvedModel warns but preserves observed argv evidence"
else
  fail "missing resolvedModel lost observed model evidence: '$model'"
fi

echo "Test: FLY-1507 Codex proof requires the complete windowed TUI argv"
if lead_body_codex_command_matches "$(fixture_command 303)" \
  && ! lead_body_codex_command_matches "codex" \
  && ! lead_body_codex_command_matches "codex resume --remote http://wrong -C /tmp -s read-only -c approval_policy=never thread"; then
  pass "only a complete local-socket Codex resume command receives full proof"
else
  fail "Codex proof classifier is too broad or rejects the production shape"
fi

echo "Test: FLY-1507 Claude bundle proof scans every append target"
bundle_after_legacy="claude --agent lead --append-system-prompt-file /rules/inbox-ack-rule.md --append-system-prompt-file /tmp/lead-rules-bundles/proj-lead.12-lstart-c.md"
if _lead_body_claude_project_matches "$bundle_after_legacy" "proj" "lead"; then
  pass "a project bundle is recognized even when it is not the first append target"
else
  fail "Claude proof stopped at the first append target"
fi

echo "Test: FLY-1507 legacy rules receipt proves the exact ordered append-target set"
receipt="$LEAD_BODY_RULES_STATE_DIR/proj-lead.active.json"
printf '%s\n' \
  '{"mode":"legacy","bundlePath":null,"pid":99,"supervisorStart":"Mon Jul 27 10:00:00 2026","sha":null,"role":"dept","generatedAt":"2026-07-27T10:00:00Z","selectedSources":[{"label":"launcher","basename":"inbox-ack-rule.md","path":"/rules/inbox-ack-rule.md"},{"label":"project","basename":"project-lead-rules.md","path":"/rules/project-lead-rules.md"}],"appendTargets":["/rules/inbox-ack-rule.md","/rules/project-lead-rules.md"],"files":2}' \
  > "$receipt"
if _lead_body_claude_project_matches "$(fixture_command 304)" "proj" "lead" \
  && ! _lead_body_claude_project_matches \
    "claude --agent lead --append-system-prompt-file /rules/project-lead-rules.md" \
    "proj" "lead"; then
  pass "legacy proof accepts only the scoped receipt's complete ordered targets"
else
  fail "legacy receipt proof was rejected or accepted a partial target list"
fi

echo "Test: FLY-1507 legacy-mode bodies receive full sweep proof"
reset_fixture
printf '%s\n' \
  '{"mode":"legacy","bundlePath":null,"pid":99,"supervisorStart":"Mon Jul 27 10:00:00 2026","sha":null,"role":"dept","generatedAt":"2026-07-27T10:00:00Z","selectedSources":[{"label":"launcher","basename":"inbox-ack-rule.md","path":"/rules/inbox-ack-rule.md"},{"label":"project","basename":"project-lead-rules.md","path":"/rules/project-lead-rules.md"}],"appendTargets":["/rules/inbox-ack-rule.md","/rules/project-lead-rules.md"],"files":2}' \
  > "$LEAD_BODY_RULES_STATE_DIR/proj-lead.active.json"
INVENTORY=$'@1\tproj-lead\t%1\t304\t0'
PROCESS_TABLE="304 $(fixture_command 304)"
rc=0
lead_body_collect_targets "proj" "lead" "claude-code" "$TMP_ROOT/missing.archive" "$targets" || rc=$?
if (( rc == 0 )) && grep -q $'^304\tMon Jul 27 11:00:02 2026\tfull\t' "$targets"; then
  pass "collector authorizes a legacy-mode body using its scoped active receipt"
else
  fail "collector left the legacy-mode body unsweepable (rc=$rc): $(tr '\n' '|' < "$targets" 2>/dev/null)"
fi

echo ""
echo "═══════════════════════════════════════"
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "═══════════════════════════════════════"
(( FAIL == 0 ))
