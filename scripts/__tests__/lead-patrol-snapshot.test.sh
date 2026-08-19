#!/bin/bash
# FLY-1855 — executable six-step Lead patrol snapshot contract.
# Hermetic: true StateStore/CommDB schemas, fake tmux/gh, temp-only reports.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/lead-patrol-snapshot.sh"
TMP="$(mktemp -d -t fly1855-patrol.XXXXXX)" || exit 1
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

PASS=0
FAIL=0
pass() { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }
contains() { grep -Fq -- "$2" "$1" && pass "$3" || fail "$3 (missing: $2)"; }
not_contains() { ! grep -Fq -- "$2" "$1" && pass "$3" || fail "$3 (unexpected: $2)"; }
count_is() {
  local file="$1" needle="$2" expected="$3" label="$4" actual
  actual="$(grep -Fc -- "$needle" "$file" || true)"
  [ "$actual" -eq "$expected" ] && pass "$label" || fail "$label (expected $expected, got $actual: $needle)"
}

if [ ! -f "$ROOT/packages/teamlead/dist/StateStore.js" ] \
  || [ ! -f "$ROOT/packages/flywheel-comm/dist/lib.js" ]; then
  echo "FAIL: build artifacts missing; run pnpm -r build before this suite" >&2
  exit 1
fi

mkdir -p "$TMP/template"
DB_PATH="$TMP/template/teamlead.db" node --input-type=module -e \
  'import { StateStore } from "./packages/teamlead/dist/StateStore.js"; const s = await StateStore.create(process.env.DB_PATH); s.close();'
DB_PATH="$TMP/template/comm.db" node --input-type=module -e \
  'import { CommDB } from "./packages/flywheel-comm/dist/lib.js"; const d = new CommDB(process.env.DB_PATH); d.close();'

make_case() {
  local dir="$1"
  mkdir -p "$dir/comm/flywheel" "$dir/state/comm/tidal-echo" "$dir/bin" "$dir/home"
  cp "$TMP/template/teamlead.db" "$dir/teamlead.db"
  cp "$TMP/template/comm.db" "$dir/comm/flywheel/comm.db"
  cp "$TMP/template/comm.db" "$dir/state/comm/tidal-echo/comm.db"
  cat > "$dir/state/projects.json" <<'JSON'
[
  {
    "projectName": "flywheel",
    "projectRepo": "xrliAnnie/flywheel",
    "leads": [
      {"agentId":"flywheel-eng-lead","chatChannel":"1516209714097291335","botUserId":"1516207680836866219"}
    ]
  },
  {"projectName":"tidal-echo","projectRepo":"example/tidal-echo","leads":[]}
]
JSON
  cat > "$dir/bin/tmux" <<'SH'
#!/bin/bash
if [ "${1:-}" = list-windows ]; then
  printf '%s\n' 'FLY-100' 'FLY-101' 'FLY-102' 'cmux-FLY-999' 'zsh'
  exit 0
fi
if [ "${1:-}" = list-panes ]; then
  exit 0
fi
exit 2
SH
  cat > "$dir/bin/gh" <<'SH'
#!/bin/bash
if [ "${GH_FAIL:-0}" = 1 ]; then
  echo 'temporary gh failure' >&2
  exit 1
fi
if [ "${GH_SCHEMA:-0}" = 1 ]; then
  case "$*" in
    *'/pulls?state=open&per_page=50'*) printf '%s\n' '[{"number":"SECRET_BAD_SCHEMA"}]' ;;
    *'/actions/runs?per_page=5'*) printf '%s\n' '{"workflow_runs":[{}]}' ;;
  esac
  exit 0
fi
if [ "${GH_EMPTY:-0}" = 1 ]; then
  case "$*" in
    *'/pulls?state=open&per_page=50'*) printf '%s\n' '[]' ;;
    *'/actions/runs?per_page=5'*) printf '%s\n' '{"workflow_runs":[]}' ;;
  esac
  exit 0
fi
case "$*" in
  *'/pulls?state=open&per_page=50'*)
    printf '%s\n' '[{"number":12,"draft":false,"head":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"updated_at":"2026-08-19T06:30:00Z"}]'
    ;;
  *'/actions/runs?per_page=5'*)
    printf '%s\n' '{"workflow_runs":[{"id":44,"status":"completed","created_at":"2026-08-19T06:40:00Z"}]}'
    ;;
  *) echo "unexpected gh args: $*" >&2; exit 2 ;;
esac
SH
  chmod 0755 "$dir/bin/tmux" "$dir/bin/gh"
}

run_snapshot() {
  local dir="$1" out="$2"
  HOME="$dir/home" \
  PATH="$dir/bin:$PATH" \
  FLYWHEEL_STATE_DIR="$dir/state" \
  FLYWHEEL_STATE_DB_PATH="$dir/teamlead.db" \
  FLYWHEEL_PROJECTS_FILE="$dir/state/projects.json" \
  FLYWHEEL_COMM_DB="$dir/comm/flywheel/comm.db" \
  GH_FAIL="${GH_FAIL:-0}" \
  GH_SCHEMA="${GH_SCHEMA:-0}" \
  GH_EMPTY="${GH_EMPTY:-0}" \
  TMUX_CALL_LOG="${TMUX_CALL_LOG:-$dir/tmux-calls.log}" \
  TMUX_CAPTURE_FAIL="${TMUX_CAPTURE_FAIL:-}" \
    bash "$SCRIPT" --project flywheel --lead flywheel-eng-lead > "$out" 2>&1
}

MAIN="$TMP/main"
make_case "$MAIN"
sqlite3 "$MAIN/teamlead.db" <<'SQL'
INSERT INTO workflow_run(run_id,issue_id,project_name,status,created_at) VALUES
 ('run-100','FLY-100','flywheel','active',datetime('now')),
 ('run-101','FLY-101','flywheel','active',datetime('now')),
 ('run-102','FLY-102','flywheel','active',datetime('now')),
 ('run-103','FLY-103','flywheel','active',datetime('now')),
 ('run-104','FLY-104','flywheel','active',datetime('now')),
 ('run-105','FLY-105','flywheel','active',datetime('now')),
 ('run-108','FLY-108','flywheel','terminated',datetime('now')),
 ('run-999','TE-999','tidal-echo','active',datetime('now'));
INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at) VALUES
 ('run-100','implement',1,'running','exec-no-turn',datetime('now')),
 ('run-101','implement',1,'running','exec-holder',datetime('now')),
 ('run-102','implement',1,'running','exec-wait',datetime('now')),
 ('run-103','implement',1,'running','exec-mail',datetime('now')),
 ('run-104','implement',1,'running','exec-wake',datetime('now')),
 ('run-105','implement',1,'running','exec-claim',datetime('now')),
 ('run-108','implement',1,'running','exec-old',datetime('now')),
 ('run-999','implement',1,'running','exec-other',datetime('now'));
INSERT INTO sessions(execution_id,issue_id,issue_identifier,issue_title,project_name,status) VALUES
 ('exec-no-turn','FLY-100','FLY-100','no turn','flywheel','running'),
 ('exec-holder','FLY-101','FLY-101','dead holder','flywheel','running'),
 ('exec-wait','FLY-102','FLY-102','wait streak','flywheel','running'),
 ('exec-mail','FLY-103','FLY-103','mail','flywheel','running'),
 ('exec-wake','FLY-104','FLY-104','wake','flywheel','running'),
 ('exec-claim','FLY-105','FLY-105','claim','flywheel','running'),
 ('exec-old','FLY-108','FLY-108','terminal','flywheel','terminated'),
 ('exec-other','TE-999','TE-999','other','tidal-echo','running');
INSERT INTO dead_letter_alerts(id,source_kind,recipient,through_dead_seq,lead_id,project_name,dead_count,summary,state,created_at) VALUES
 ('dead-pending','runner_unroutable','exec-wake',1,'flywheel-eng-lead','flywheel',1,'SECRET_DEAD_SUMMARY','pending',strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')),
 ('dead-accepted','runner_unroutable','exec-wake-accepted',2,'flywheel-eng-lead','flywheel',1,'SECRET_ACCEPTED_SUMMARY','accepted',strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes'));
INSERT INTO workflow_node_pr_binding(run_id,node_id,attempt,pr_number,head_sha,target_repo_identity,probe_repo_slug,target_repo_path,worktree_binding_generation,receipt_id,bound_at)
 VALUES('run-105','implement',1,105,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','__main__','xrliAnnie/flywheel','.', 'gen-1','receipt-105',datetime('now'));
INSERT INTO workflow_claims(server_seq,issued_at,issue_id,workflow_run_id,node_id,decision_kind,attempt,predicate,issuer_kind,subject_kind,subject_digest,expires_at,permanent,evidence,authority_id)
 VALUES(105,datetime('now'),'FLY-105','run-105','implement','code_review',1,'codex_approved','bridge_policy','git_head','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',datetime('now','+1 day'),0,'{"secret":"SECRET_CLAIM_EVIDENCE"}','authority-105');
SQL
sqlite3 "$MAIN/comm/flywheel/comm.db" <<'SQL'
INSERT INTO three_stage_turn(issue_id,holder_exec_id,phase,epoch,granted_at) VALUES
 ('FLY-101','ghost-holder','implement',1,unixepoch()*1000),
 ('FLY-102','exec-wait','implement',1,unixepoch()*1000),
 ('FLY-103','exec-mail','implement',1,unixepoch()*1000),
 ('FLY-104','exec-wake','implement',1,unixepoch()*1000),
 ('FLY-105','exec-claim','implement',1,unixepoch()*1000),
 ('FLY-108','exec-old','implement',1,unixepoch()*1000);
INSERT INTO turn_wait_ledger(execution_id,holder_exec_id,epoch,first_seen_at,no_turn_streak,last_no_turn_at) VALUES
 ('exec-wait','exec-wait',1,(unixepoch()-300)*1000,3,(unixepoch()-10)*1000),
 ('exec-old','exec-old',1,(unixepoch()-300)*1000,9,(unixepoch()-10)*1000);
INSERT INTO mailbox_identity(id,delivery_id,insert_projection_hash) VALUES
 ('mail-live-queued','delivery-live-queued','hash-1'),
 ('mail-live-lease','delivery-live-lease','hash-2'),
 ('mail-old-lease','delivery-old-lease','hash-3'),
 ('mail-dead-runner','delivery-dead-runner','hash-4');
INSERT INTO mailbox(id,delivery_id,from_agent,to_agent,recipient_kind,type,msg_class,content,created_at,state,claim_expires_at,relay_state) VALUES
 ('mail-live-queued','delivery-live-queued','lead','exec-mail','runner','instruction','model','SECRET_MAILBOX_CONTENT',strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 minutes'),'QUEUED',NULL,'terminal_disposed'),
 ('mail-live-lease','delivery-live-lease','lead','exec-mail','runner','instruction','model','SECRET_LIVE_LEASE',strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes'),'LEASED',strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes'),'terminal_disposed'),
 ('mail-old-lease','delivery-old-lease','lead','exec-mail','runner','instruction','model','SECRET_OLD_LEASE',strftime('%Y-%m-%dT%H:%M:%fZ','now','-25 hours'),'LEASED',strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours'),'terminal_disposed'),
 ('mail-dead-runner','delivery-dead-runner','lead','exec-old','runner','instruction','model','SECRET_DEAD_RUNNER',strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 minutes'),'QUEUED',NULL,'terminal_disposed');
INSERT INTO turn_wake_outbox(wake_id,execution_id,issue_id,epoch,purpose,envelope_json,backend,state,episode_id,created_at) VALUES
 ('wake-active','exec-wake','FLY-104',1,'turn','{"secret":"SECRET_WAKE_ENVELOPE"}','mailbox','pending','episode-active',(unixepoch()-1200)*1000),
 ('wake-terminal','exec-old','FLY-108',1,'turn','{"secret":"SECRET_WAKE_TERMINAL"}','mailbox','pending','episode-terminal',(unixepoch()-1200)*1000);
SQL

MAIN_OUT="$MAIN/out.txt"
if run_snapshot "$MAIN" "$MAIN_OUT"; then
  pass "main snapshot exits zero"
else
  fail "main snapshot exits zero"
fi
contains "$MAIN_OUT" "TURN_MISSING issue=FLY-100" "active issue without TURN is visible"
contains "$MAIN_OUT" "TURN_HOLDER_NOT_LIVE issue=FLY-101" "dead TURN holder is visible"
contains "$MAIN_OUT" "NO_TURN_STREAK issue=FLY-102" "live no-turn streak is visible"
not_contains "$MAIN_OUT" "issue=TE-999" "other project active run is filtered"
not_contains "$MAIN_OUT" "issue=FLY-108" "terminal run is filtered from active ledgers"
contains "$MAIN_OUT" "MAILBOX_STALE id=mail-live-qu" "old live-runner queued mail is visible"
contains "$MAIN_OUT" "MAILBOX_STALE id=mail-live-le" "recent expired live-runner lease is visible"
not_contains "$MAIN_OUT" "mail-old-lea" "ancient expired lease is filtered"
not_contains "$MAIN_OUT" "mail-dead-ru" "terminal runner mailbox is filtered"
contains "$MAIN_OUT" "WAKE_UNACKED wake=wake-active" "active integer-ms wake window is visible"
not_contains "$MAIN_OUT" "wake-terminal" "terminal wake is filtered"
contains "$MAIN_OUT" "DEAD_LETTER_PENDING id=dead-pending" "recent pending dead letter is visible"
not_contains "$MAIN_OUT" "dead-accepted" "accepted dead letter receipt is filtered"
contains "$MAIN_OUT" "VERDICT_HEAD_MISMATCH issue=FLY-105" "active binding/claim mismatch is visible"
for secret in SECRET_MAILBOX_CONTENT SECRET_LIVE_LEASE SECRET_OLD_LEASE SECRET_DEAD_RUNNER SECRET_WAKE_ENVELOPE SECRET_WAKE_TERMINAL SECRET_DEAD_SUMMARY SECRET_ACCEPTED_SUMMARY SECRET_CLAIM_EVIDENCE; do
  not_contains "$MAIN_OUT" "$secret" "secret projection excludes $secret"
done
for step in 1 2 3 4 5 6; do
  contains "$MAIN_OUT" "## STEP $step" "report contains STEP $step"
done
REPORT_PATH="$(sed -n 's/^REPORT_PATH=//p' "$MAIN_OUT" | tail -1)"
if [ -n "$REPORT_PATH" ] && [ -f "$REPORT_PATH" ]; then
  pass "report path exists"
else
  fail "report path exists ($REPORT_PATH)"
fi
if ! find "$MAIN/state/patrol-reports" -name '*.tmp.*' -print | grep -q .; then
  pass "atomic publication leaves no temp residue"
else
  fail "atomic publication leaves no temp residue"
fi

# Founder increment: canonical Runner panes are all captured in full, while a
# cmux mirror of the same window is excluded. Ownership spans project CommDBs.
PANES="$TMP/panes"
make_case "$PANES"
cat > "$PANES/bin/tmux" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "${TMUX_CALL_LOG:?}"
case "${1:-}" in
  list-windows)
    printf '%s\n' 'runner-flywheel: FLY-200 FLY-201 FLY-202' 'runner-tidal-echo: TE-300' 'runner-test-slot-2: TEST-1' 'cmux-FLY-200: FLY-200'
    ;;
  list-panes)
    printf '%%1\trunner-flywheel\trunner-flywheel:@1\tFLY-200\tclaude\t0\n'
    printf '%%2\trunner-flywheel\trunner-flywheel:@2\tFLY-201\tclaude\t0\n'
    printf '%%3\trunner-tidal-echo\trunner-tidal-echo:@3\tTE-300\tclaude\t0\n'
    printf '%%4\tcmux-FLY-200\tcmux-FLY-200:@4\tFLY-200\tclaude\t0\n'
    printf '%%5\trunner-test-slot-2\trunner-test-slot-2:@5\tTEST-1\tclaude\t0\n'
    printf '%%6\trunner-flywheel\trunner-flywheel:@6\tFLY-202\tclaude\t0\n'
    ;;
  capture-pane)
    target=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = -t ]; then target="${2:-}"; break; fi
      shift
    done
    if [ -n "${TMUX_CAPTURE_FAIL:-}" ] && [ "$target" = "$TMUX_CAPTURE_FAIL" ]; then
      exit 1
    fi
    case "$target" in
      %1) printf '%s\n' 'SECRET_PANE_TRANSCRIPT' 'Awaiting review' ;;
      %2) printf '%s\n' "You've hit your usage limit" 'Press Enter to confirm' ;;
      %3) printf '%s\n' 'Working on another project' ;;
      %5) printf '%s\n' 'QA slot is healthy' ;;
      %6) printf '%s\n' 'Runner cleanup pending' ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac
SH
chmod 0755 "$PANES/bin/tmux"
sqlite3 "$PANES/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,status,vendor) VALUES
 ('exec-pane-1','runner-flywheel:@1','flywheel','FLY-200','flywheel-eng-lead','running','claude'),
 ('exec-pane-2','runner-flywheel:@2','flywheel','FLY-201','flywheel-eng-lead','running','claude');
SQL
sqlite3 "$PANES/state/comm/tidal-echo/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,status,vendor) VALUES
 ('exec-pane-3','runner-tidal-echo:@3','tidal-echo','TE-300','tidal-echo-content-lead','running','claude');
SQL
mkdir -p "$PANES/state/patrol-reports/flywheel-eng-lead"
PANE_STATE_HASH="$(printf '%s' 'Awaiting review' | shasum -a 256 | awk '{print $1}')"
cat > "$PANES/state/patrol-reports/flywheel-eng-lead/20260819T000000Z-tickNA.md" <<EOF
pane_count=1
PANE_EVIDENCE pane=%1 target=runner-flywheel:@1 owner=owned exec=exec-pane-1 capture_sha256=old lines=2 bytes=20 state_sha256=$PANE_STATE_HASH last_change_epoch=$(($(date +%s) - 3700)) findings=none action=none result=clear
EOF
PANES_OUT="$PANES/out.txt"
TMUX_CALL_LOG="$PANES/tmux-calls.log" run_snapshot "$PANES" "$PANES_OUT" || fail "pane evidence snapshot exits zero"
contains "$PANES_OUT" "pane_count=5" "canonical Runner pane count excludes cmux mirror"
count_is "$PANES_OUT" "PANE_EVIDENCE " 5 "every canonical Runner pane has one evidence row"
for pane in %1 %2 %3 %5 %6; do
  contains "$PANES/tmux-calls.log" "capture-pane -p -S - -t $pane" "pane $pane uses full scrollback capture"
done
not_contains "$PANES/tmux-calls.log" "capture-pane -p -S - -t %4" "cmux mirror is not captured twice"
not_contains "$PANES_OUT" "SECRET_PANE_TRANSCRIPT" "raw pane transcript is never persisted"
contains "$PANES_OUT" "pane=%1 target=runner-flywheel:@1 owner=owned" "owned pane is mapped from current CommDB"
contains "$PANES_OUT" "pane=%1 target=runner-flywheel:@1 owner=owned exec=exec-pane-1" "owned evidence includes execution id"
contains "$PANES_OUT" "findings=STALLED_60M action=REQUIRED result=UNSET" "unchanged state for one hour is a required finding"
contains "$PANES_OUT" "pane=%2 target=runner-flywheel:@2 owner=owned" "second owned pane is mapped"
contains "$PANES_OUT" "findings=LIMIT_LIVE,INTERACTIVE_MENU action=REQUIRED result=UNSET" "live limit and menu are explicit findings"
contains "$PANES_OUT" "pane=%3 target=runner-tidal-echo:@3 owner=cross-boundary" "other-project pane uses machine-wide owner index"
contains "$PANES_OUT" "pane=%3 target=runner-tidal-echo:@3 owner=cross-boundary exec=exec-pane-3" "cross-boundary evidence preserves the mapped execution"
contains "$PANES_OUT" "findings=none action=none result=clear" "healthy cross-boundary pane is not a finding"
contains "$PANES_OUT" "pane=%5 target=runner-test-slot-2:@5 owner=foreign-registry" "QA-only session is classified without false orphan alert"
contains "$PANES_OUT" "result=foreign_registry_clear" "healthy foreign-registry pane auto-closes"
contains "$PANES_OUT" "pane=%6 target=runner-flywheel:@6 owner=unknown" "unclaimed registered pane remains visible"
contains "$PANES_OUT" "result=session_terminated" "first unclaimed observation gets teardown grace"

# The published first report is now prior evidence. A second observation of the
# same registered unclaimed target must become a real orphan finding.
PANES_SECOND_OUT="$PANES/second.txt"
TMUX_CALL_LOG="$PANES/tmux-calls-second.log" run_snapshot "$PANES" "$PANES_SECOND_OUT" || fail "second pane snapshot exits zero"
contains "$PANES_SECOND_OUT" "pane=%6 target=runner-flywheel:@6 owner=unknown" "persistent orphan stays attributed to its target"
contains "$PANES_SECOND_OUT" "findings=ORPHANED action=REQUIRED result=UNSET" "second unclaimed observation becomes a finding"

PANE_FAIL="$TMP/pane-fail"
make_case "$PANE_FAIL"
cp "$PANES/bin/tmux" "$PANE_FAIL/bin/tmux"
sqlite3 "$PANE_FAIL/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,status,vendor) VALUES
 ('exec-pane-1','runner-flywheel:@1','flywheel','FLY-200','flywheel-eng-lead','running','claude'),
 ('exec-pane-2','runner-flywheel:@2','flywheel','FLY-201','flywheel-eng-lead','running','claude');
SQL
sqlite3 "$PANE_FAIL/state/comm/tidal-echo/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,status,vendor) VALUES
 ('exec-pane-3','runner-tidal-echo:@3','tidal-echo','TE-300','tidal-echo-content-lead','running','claude');
SQL
PANE_FAIL_OUT="$PANE_FAIL/out.txt"
TMUX_CALL_LOG="$PANE_FAIL/tmux-calls.log" TMUX_CAPTURE_FAIL=%2 run_snapshot "$PANE_FAIL" "$PANE_FAIL_OUT" || fail "capture failure still publishes report"
contains "$PANE_FAIL_OUT" "STEP 2: UNAVAILABLE(structural: pane_capture_incomplete)" "one failed capture makes partial patrol visible"
contains "$PANE_FAIL_OUT" "pane_count=5" "capture failure does not hide declared pane count"
count_is "$PANE_FAIL_OUT" "PANE_EVIDENCE " 5 "capture failure still emits one row per pane"
contains "$PANE_FAIL_OUT" "pane=%2 target=runner-flywheel:@2 owner=owned" "failed pane keeps identity evidence"
contains "$PANE_FAIL_OUT" "findings=CAPTURE_FAILED action=REQUIRED result=UNSET" "failed pane requires explicit disposition"

INDEX_FAIL="$TMP/index-fail"
make_case "$INDEX_FAIL"
cp "$PANES/bin/tmux" "$INDEX_FAIL/bin/tmux"
sqlite3 "$INDEX_FAIL/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,status,vendor) VALUES
 ('exec-pane-1','runner-flywheel:@1','flywheel','FLY-200','flywheel-eng-lead','running','claude'),
 ('exec-pane-2','runner-flywheel:@2','flywheel','FLY-201','flywheel-eng-lead','running','claude');
SQL
sqlite3 "$INDEX_FAIL/state/comm/tidal-echo/comm.db" 'DROP TABLE sessions;'
INDEX_FAIL_OUT="$INDEX_FAIL/out.txt"
TMUX_CALL_LOG="$INDEX_FAIL/tmux-calls.log" run_snapshot "$INDEX_FAIL" "$INDEX_FAIL_OUT" || fail "owner-index failure still publishes report"
contains "$INDEX_FAIL_OUT" "STEP 2: UNAVAILABLE(structural: owner_index_incomplete)" "owner-index schema failure is UNAVAILABLE"
contains "$INDEX_FAIL_OUT" "pane=%3 target=runner-tidal-echo:@3 owner=unknown" "incomplete owner index keeps the affected pane visible"
contains "$INDEX_FAIL_OUT" "findings=OWNER_INDEX_INCOMPLETE action=REQUIRED result=UNSET" "incomplete index never becomes a false orphan finding"
not_contains "$INDEX_FAIL_OUT" "no such table" "raw owner-index error is not persisted"

DUPLICATE="$TMP/duplicate-owner"
make_case "$DUPLICATE"
cp "$PANES/bin/tmux" "$DUPLICATE/bin/tmux"
sqlite3 "$DUPLICATE/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,status,vendor) VALUES
 ('exec-pane-1','runner-flywheel:@1','flywheel','FLY-200','flywheel-eng-lead','running','claude');
SQL
sqlite3 "$DUPLICATE/state/comm/tidal-echo/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,status,vendor) VALUES
 ('exec-duplicate','runner-flywheel:@1','tidal-echo','TE-999','tidal-echo-content-lead','running','claude');
SQL
DUPLICATE_OUT="$DUPLICATE/out.txt"
TMUX_CALL_LOG="$DUPLICATE/tmux-calls.log" run_snapshot "$DUPLICATE" "$DUPLICATE_OUT" || fail "duplicate owner target still publishes report"
contains "$DUPLICATE_OUT" "STEP 2: UNAVAILABLE(structural: session_target_ambiguous)" "duplicate machine owner is fail-visible"
contains "$DUPLICATE_OUT" "pane=%1 target=runner-flywheel:@1 owner=unknown" "ambiguous pane remains individually attributable"
contains "$DUPLICATE_OUT" "findings=SESSION_TARGET_AMBIGUOUS action=REQUIRED result=UNSET" "ambiguous target requires disposition"

EMPTY="$TMP/empty"
make_case "$EMPTY"
EMPTY_OUT="$EMPTY/out.txt"
run_snapshot "$EMPTY" "$EMPTY_OUT" || fail "empty snapshot exits zero"
contains "$EMPTY_OUT" "STEP 3: OK-CANDIDATE" "empty step 3 is an OK candidate"
contains "$EMPTY_OUT" "STEP 4: OK-CANDIDATE" "empty step 4 is an OK candidate"
contains "$EMPTY_OUT" "STEP 1: LEAD-JUDGMENT-REQUIRED" "judgment step never auto-green"

ENV_LEAD_OUT="$EMPTY/env-lead.txt"
if HOME="$EMPTY/home" PATH="$EMPTY/bin:$PATH" \
  FLYWHEEL_STATE_DIR="$EMPTY/state" \
  FLYWHEEL_STATE_DB_PATH="$EMPTY/teamlead.db" \
  FLYWHEEL_PROJECTS_FILE="$EMPTY/state/projects.json" \
  FLYWHEEL_COMM_DB="$EMPTY/comm/flywheel/comm.db" \
  FLYWHEEL_LEAD_ID="flywheel-eng-lead" \
  bash "$SCRIPT" --project flywheel --tick-seq 42 > "$ENV_LEAD_OUT" 2>&1; then
  pass "lead env fallback and explicit tick sequence exit zero"
else
  fail "lead env fallback and explicit tick sequence exit zero"
fi
contains "$ENV_LEAD_OUT" "lead: flywheel-eng-lead" "FLYWHEEL_LEAD_ID supplies omitted --lead"
contains "$ENV_LEAD_OUT" "-tick42.md" "tick sequence is reflected in the artifact name"

MISSING_VALUE_OUT="$EMPTY/missing-value.txt"
HOME="$EMPTY/home" PATH="$EMPTY/bin:$PATH" \
  bash "$ROOT/scripts/lib/bounded-run.sh" 2 bash "$SCRIPT" --project \
  > "$MISSING_VALUE_OUT" 2>&1
MISSING_VALUE_RC=$?
if [ "$MISSING_VALUE_RC" -eq 2 ]; then
  pass "missing option value fails promptly with usage status"
else
  fail "missing option value must return 2, got $MISSING_VALUE_RC"
fi
not_contains "$MISSING_VALUE_OUT" "REPORT_PATH=" "missing option value creates no report"

BROKEN="$TMP/broken"
make_case "$BROKEN"
sqlite3 "$BROKEN/comm/flywheel/comm.db" 'DROP TABLE three_stage_turn;'
BROKEN_OUT="$BROKEN/out.txt"
if run_snapshot "$BROKEN" "$BROKEN_OUT"; then
  pass "fact-source schema failure still emits a report"
else
  fail "fact-source schema failure still emits a report"
fi
contains "$BROKEN_OUT" "STEP 3: UNAVAILABLE(structural: schema_missing)" "missing ledger is structural UNAVAILABLE"
contains "$BROKEN_OUT" "## STEP 4" "later steps survive an unavailable ledger"

GH_BROKEN="$TMP/gh-broken"
make_case "$GH_BROKEN"
GH_OUT="$GH_BROKEN/out.txt"
if GH_FAIL=1 run_snapshot "$GH_BROKEN" "$GH_OUT"; then
  pass "gh failure remains report-producing"
else
  fail "gh failure remains report-producing"
fi
contains "$GH_OUT" "STEP 5: UNAVAILABLE(structural: gh_unavailable)" "gh failure is explicit"
not_contains "$GH_OUT" "temporary gh failure" "raw changing gh error is not persisted"

GH_SCHEMA_DIR="$TMP/gh-schema"
make_case "$GH_SCHEMA_DIR"
GH_SCHEMA_OUT="$GH_SCHEMA_DIR/out.txt"
GH_SCHEMA=1 run_snapshot "$GH_SCHEMA_DIR" "$GH_SCHEMA_OUT" || fail "gh schema failure exits zero"
contains "$GH_SCHEMA_OUT" "STEP 5: UNAVAILABLE(structural: gh_schema)" "malformed gh JSON is explicit"
not_contains "$GH_SCHEMA_OUT" "SECRET_BAD_SCHEMA" "malformed gh payload is not persisted"

GH_EMPTY_DIR="$TMP/gh-empty"
make_case "$GH_EMPTY_DIR"
GH_EMPTY_OUT="$GH_EMPTY_DIR/out.txt"
GH_EMPTY=1 run_snapshot "$GH_EMPTY_DIR" "$GH_EMPTY_OUT" || fail "empty gh snapshot exits zero"
contains "$GH_EMPTY_OUT" "PR none" "empty open PR collection remains a valid fact"
contains "$GH_EMPTY_OUT" "RUN none" "empty action-run collection remains a valid fact"

DEFAULT="$TMP/default-path"
make_case "$DEFAULT"
mkdir -p "$DEFAULT/home/.flywheel"
cp "$DEFAULT/teamlead.db" "$DEFAULT/home/.flywheel/teamlead.db"
rm "$DEFAULT/teamlead.db"
DEFAULT_OUT="$DEFAULT/out.txt"
if env -u FLYWHEEL_STATE_DB_PATH -u TEAMLEAD_DB_PATH \
  HOME="$DEFAULT/home" PATH="$DEFAULT/bin:$PATH" \
  FLYWHEEL_STATE_DIR="$DEFAULT/state" \
  FLYWHEEL_PROJECTS_FILE="$DEFAULT/state/projects.json" \
  FLYWHEEL_COMM_DB="$DEFAULT/comm/flywheel/comm.db" \
  bash "$SCRIPT" --project flywheel --lead flywheel-eng-lead > "$DEFAULT_OUT" 2>&1; then
  pass "StateStore default ignores custom FLYWHEEL_STATE_DIR"
else
  fail "StateStore default ignores custom FLYWHEEL_STATE_DIR"
fi
not_contains "$DEFAULT_OUT" "state_db_unavailable" "fixed HOME StateStore path was used"

BAD_OUT="$TMP/bad-args.txt"
if HOME="$EMPTY/home" PATH="$EMPTY/bin:$PATH" FLYWHEEL_STATE_DIR="$EMPTY/state" \
  bash "$SCRIPT" --project '../bad' --lead flywheel-eng-lead > "$BAD_OUT" 2>&1; then
  fail "unsafe project input fails closed"
else
  pass "unsafe project input fails closed"
fi
not_contains "$BAD_OUT" "REPORT_PATH=" "unsafe input creates no report"

for unsafe_key_case in 'project:..' 'lead:..' 'project:.' 'lead:.'; do
  unsafe_kind="${unsafe_key_case%%:*}"
  unsafe_value="${unsafe_key_case#*:}"
  UNSAFE_KEY_OUT="$TMP/unsafe-${unsafe_kind}-${unsafe_value//./dot}.txt"
  if [ "$unsafe_kind" = "project" ]; then
    unsafe_project="$unsafe_value"
    unsafe_lead="flywheel-eng-lead"
  else
    unsafe_project="flywheel"
    unsafe_lead="$unsafe_value"
  fi
  if HOME="$EMPTY/home" PATH="$EMPTY/bin:$PATH" FLYWHEEL_STATE_DIR="$EMPTY/state" \
    bash "$SCRIPT" --project "$unsafe_project" --lead "$unsafe_lead" > "$UNSAFE_KEY_OUT" 2>&1; then
    fail "path-segment $unsafe_kind $unsafe_value fails closed"
  else
    pass "path-segment $unsafe_kind $unsafe_value fails closed"
  fi
  not_contains "$UNSAFE_KEY_OUT" "REPORT_PATH=" "path-segment $unsafe_kind $unsafe_value creates no report"
done

BAD_REPO="$TMP/bad-repo"
make_case "$BAD_REPO"
jq 'map(if .projectName == "flywheel" then .projectRepo = "owner/../../SECRET_REPO" else . end)' \
  "$BAD_REPO/state/projects.json" > "$BAD_REPO/state/projects.invalid.json"
mv "$BAD_REPO/state/projects.invalid.json" "$BAD_REPO/state/projects.json"
BAD_REPO_OUT="$BAD_REPO/out.txt"
run_snapshot "$BAD_REPO" "$BAD_REPO_OUT" || fail "invalid project repo remains report-producing"
contains "$BAD_REPO_OUT" "STEP 5: UNAVAILABLE(structural: gh_unavailable)" "invalid project repo disables external projection"
not_contains "$BAD_REPO_OUT" "SECRET_REPO" "invalid project repo is not persisted"

PUBLISH="$TMP/publish-failure"
make_case "$PUBLISH"
printf 'not a directory\n' > "$PUBLISH/state-file"
PUBLISH_OUT="$PUBLISH/out.txt"
if HOME="$PUBLISH/home" PATH="$PUBLISH/bin:$PATH" \
  FLYWHEEL_STATE_DIR="$PUBLISH/state-file" \
  FLYWHEEL_STATE_DB_PATH="$PUBLISH/teamlead.db" \
  FLYWHEEL_PROJECTS_FILE="$PUBLISH/state/projects.json" \
  FLYWHEEL_COMM_DB="$PUBLISH/comm/flywheel/comm.db" \
  bash "$SCRIPT" --project flywheel --lead flywheel-eng-lead > "$PUBLISH_OUT" 2>&1; then
  fail "report publication failure exits non-zero"
else
  pass "report publication failure exits non-zero"
fi
contains "$PUBLISH_OUT" "## STEP 1" "publication failure still returns collected facts"
not_contains "$PUBLISH_OUT" "REPORT_PATH=" "publication failure does not claim a durable artifact"

printf '\nFLY-1855 patrol snapshot: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
