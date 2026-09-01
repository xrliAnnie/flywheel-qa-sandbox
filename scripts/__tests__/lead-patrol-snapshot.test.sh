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

WRAPPER="$ROOT/scripts/flywheel-node-dwell-control.mjs"
WRAPPER_INDEX_MODE="$(git -C "$ROOT" ls-files -s scripts/flywheel-node-dwell-control.mjs | awk '{print $1; exit}')"
WRAPPER_SIZE="$(wc -c < "$WRAPPER" | tr -d ' ')"
SANITY_FLOOR="$(awk -F= '$1 == "FLYWHEEL_SCRIPT_MIN_BYTES" {print $2; exit}' "$ROOT/scripts/lib/script-sanity.sh")"
[ "$WRAPPER_INDEX_MODE" = "100755" ] && pass "node dwell wrapper is committed mode 100755" \
  || fail "node dwell wrapper must be committed mode 100755 (got ${WRAPPER_INDEX_MODE:-missing})"
[ -x "$WRAPPER" ] && pass "node dwell wrapper is executable in the checkout" \
  || fail "node dwell wrapper is executable in the checkout"
[ "$WRAPPER_SIZE" -gt "$SANITY_FLOOR" ] && pass "node dwell wrapper clears the script sanity floor" \
  || fail "node dwell wrapper must exceed $SANITY_FLOOR bytes (got $WRAPPER_SIZE)"

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
  local dir="$1" out="$2" lead_id="${3:-flywheel-eng-lead}" executable="${4:-$SCRIPT}"
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
    bash "$executable" --project flywheel --lead "$lead_id" > "$out" 2>&1
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
 ('run-106','FLY-106','flywheel','active',datetime('now')),
 ('run-109','FLY-109','flywheel','active',datetime('now')),
 ('run-110','FLY-110','flywheel','active',datetime('now')),
 ('run-111','FLY-111','flywheel','active',datetime('now')),
 ('run-108','FLY-108','flywheel','terminated',datetime('now')),
 ('run-999','TE-999','tidal-echo','active',datetime('now'));
INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at) VALUES
 ('run-100','implement',1,'running','exec-no-turn',datetime('now')),
 ('run-101','implement',1,'running','exec-holder',datetime('now')),
 ('run-102','implement',1,'running','exec-wait',datetime('now')),
 ('run-103','implement',1,'running','exec-mail',datetime('now')),
 ('run-104','implement',1,'running','exec-wake',datetime('now')),
 ('run-105','implement',1,'running','exec-claim',datetime('now')),
 ('run-106','implement',1,'running',NULL,datetime('now')),
 ('run-109','implement',1,'running','exec-foreign',datetime('now')),
 ('run-110','implement',1,'running',NULL,datetime('now')),
 ('run-111','implement',1,'running',NULL,datetime('now')),
 ('run-108','implement',1,'running','exec-old',datetime('now')),
 ('run-999','implement',1,'running','exec-other',datetime('now'));
INSERT INTO sessions(execution_id,issue_id,issue_identifier,issue_title,project_name,status) VALUES
 ('exec-no-turn','FLY-100','FLY-100','no turn','flywheel','running'),
 ('exec-holder','FLY-101','FLY-101','dead holder','flywheel','running'),
 ('exec-wait','FLY-102','FLY-102','wait streak','flywheel','running'),
 ('exec-mail','FLY-103','FLY-103','mail','flywheel','running'),
 ('exec-wake','FLY-104','FLY-104','wake','flywheel','running'),
 ('exec-claim','FLY-105','FLY-105','claim','flywheel','running'),
 ('exec-null-holder','FLY-106','FLY-106','null node exec','flywheel','running'),
 ('exec-foreign','FLY-109','FLY-109','foreign Lead','flywheel','running'),
	('exec-review-recent','FLY-112','FLY-112','recent review failure','flywheel','running'),
	('exec-review-scheduled','FLY-113','FLY-113','scheduled review failure','flywheel','running'),
	('exec-review-terminal','FLY-114','FLY-114','terminal review failure','flywheel','running'),
	('exec-review-foreign','FLY-115','FLY-115','foreign review owner','flywheel','running'),
	('exec-review-old','FLY-116','FLY-116','old review failure','flywheel','running'),
	('exec-review-dead','FLY-117','FLY-117','dead review runner','flywheel','terminated'),
	('exec-review-orphan','FLY-118','FLY-118','review owner row already pruned','flywheel','running'),
	('exec-review-other','TE-998','TE-998','other project review','tidal-echo','running'),
 ('exec-mail-parked','FLY-107','FLY-107','parked mail','flywheel','ship_parked'),
 ('exec-old','FLY-108','FLY-108','terminal','flywheel','terminated'),
 ('exec-other','TE-999','TE-999','other','tidal-echo','running');
INSERT INTO codex_review_job(
 request_id,execution_id,issue_id,project_name,review_type,round,question_id,
 status,failure_reason,failure_raw,retry_at,updated_at
) VALUES
 ('d1d1e9ba-8337-484b-b159-91887e26e987','exec-review-recent','SECRET_STALE_JOB_ISSUE','flywheel','code',2,'review-q-recent','failed','nonzero_exit','SECRET_REVIEW_FAILURE_RAW',NULL,datetime('now','-2 hours')),
 ('scheduled-review-request','exec-review-scheduled',NULL,'flywheel','design',1,'review-q-scheduled','failed','nonzero_exit','SECRET_SCHEDULED_FAILURE_RAW',datetime('now','+2 days'),datetime('now','-2 days')),
 ('terminal-head-moved','exec-review-terminal','FLY-114','flywheel','code',3,'terminal-q-1','failed','head_moved','SECRET_TERMINAL_HEAD',NULL,datetime('now','-1 hour')),
 ('terminal-gate-answered-externally','exec-review-terminal','FLY-114','flywheel','code',3,'terminal-q-2','failed','gate_answered_externally','SECRET_TERMINAL_EXTERNAL',NULL,datetime('now','-1 hour')),
 ('terminal-gate-answered','exec-review-terminal','FLY-114','flywheel','design',2,'terminal-q-3','failed','gate_answered','SECRET_TERMINAL_ANSWERED',NULL,datetime('now','-1 hour')),
 ('terminal-gate-expired','exec-review-terminal','FLY-114','flywheel','design',2,'terminal-q-4','failed','gate_expired','SECRET_TERMINAL_EXPIRED',NULL,datetime('now','-1 hour')),
 ('terminal-gate-mismatch','exec-review-terminal','FLY-114','flywheel','design',2,'terminal-q-5','failed','gate_mismatch','SECRET_TERMINAL_MISMATCH',NULL,datetime('now','-1 hour')),
 ('terminal-superseded','exec-review-recent','FLY-112','flywheel','design',2,'terminal-q-6','failed','superseded_by_revision','SECRET_TERMINAL_SUPERSEDED',NULL,datetime('now','-1 hour')),
 ('terminal-reviewed-wrong-head','exec-review-recent','FLY-112','flywheel','code',2,'terminal-q-7','failed','reviewed_wrong_head','SECRET_TERMINAL_WRONG_HEAD',NULL,datetime('now','-1 hour')),
 ('terminal-gate-missing','exec-review-recent','FLY-112','flywheel','design',2,'terminal-q-8','failed','gate_missing','SECRET_TERMINAL_MISSING',NULL,datetime('now','-1 hour')),
 ('terminal-gate-unknown','exec-review-recent','FLY-112','flywheel','design',2,'terminal-q-9','failed','gate_unknown','SECRET_TERMINAL_UNKNOWN',NULL,datetime('now','-1 hour')),
 ('old-unscheduled-review','exec-review-old','FLY-116','flywheel','design',1,'review-q-old','failed','timeout','SECRET_OLD_REVIEW_RAW',NULL,datetime('now','-2 days')),
 ('foreign-lead-review','exec-review-foreign','FLY-115','flywheel','code',1,'review-q-foreign','failed','timeout','SECRET_FOREIGN_REVIEW_RAW',NULL,datetime('now','-1 hour')),
 ('dead-runner-review','exec-review-dead','FLY-117','flywheel','code',1,'review-q-dead','failed','timeout','SECRET_DEAD_REVIEW_RAW',NULL,datetime('now','-1 hour')),
 ('orphan-comm-review','exec-review-orphan','FLY-118','flywheel','code',1,'review-q-orphan','failed','timeout','SECRET_ORPHAN_REVIEW_RAW',NULL,datetime('now','-1 hour')),
 ('foreign-project-review','exec-review-other','TE-998','tidal-echo','code',1,'review-q-other','failed','timeout','SECRET_OTHER_REVIEW_RAW',NULL,datetime('now','-1 hour'));
WITH RECURSIVE historical(n) AS (
 SELECT 1 UNION ALL SELECT n + 1 FROM historical WHERE n < 100
)
INSERT INTO codex_review_job(
 request_id,execution_id,issue_id,project_name,review_type,round,question_id,
 status,failure_reason,failure_raw,updated_at
)
SELECT printf('historical-review-%03d',n), printf('missing-exec-%03d',n),
       printf('FLY-HIST-%03d',n),'flywheel','design',1,printf('historical-q-%03d',n),
       'failed','timeout','SECRET_HISTORICAL_REVIEW_RAW',datetime('now','-1 hour')
FROM historical;
INSERT INTO dead_letter_alerts(id,source_kind,recipient,through_dead_seq,lead_id,project_name,dead_count,summary,state,created_at) VALUES
 ('dead-pending','runner_unroutable','exec-wake',1,'flywheel-eng-lead','flywheel',1,'SECRET_DEAD_SUMMARY','pending',strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')),
 ('dead-other-lead','runner_unroutable','exec-foreign',2,'honey-lemon-lead','flywheel',1,'SECRET_OTHER_LEAD_DEAD','pending',strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')),
 ('dead-other-project','runner_unroutable','exec-other',3,'flywheel-eng-lead','tidal-echo',1,'SECRET_OTHER_PROJECT_DEAD','pending',strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes')),
 ('dead-accepted','runner_unroutable','exec-wake-accepted',2,'flywheel-eng-lead','flywheel',1,'SECRET_ACCEPTED_SUMMARY','accepted',strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes'));
INSERT INTO workflow_node_pr_binding(run_id,node_id,attempt,pr_number,head_sha,target_repo_identity,probe_repo_slug,target_repo_path,worktree_binding_generation,receipt_id,bound_at)
 VALUES('run-105','implement',1,105,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','__main__','xrliAnnie/flywheel','.', 'gen-1','receipt-105',datetime('now'));
INSERT INTO workflow_claims(server_seq,issued_at,issue_id,workflow_run_id,node_id,decision_kind,attempt,predicate,issuer_kind,subject_kind,subject_digest,expires_at,permanent,evidence,authority_id)
 VALUES(105,datetime('now'),'FLY-105','run-105','implement','code_review',1,'codex_approved','bridge_policy','git_head','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',datetime('now','+1 day'),0,'{"secret":"SECRET_CLAIM_EVIDENCE"}','authority-105');
SQL
sqlite3 "$MAIN/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,started_at,status) VALUES
 ('exec-no-turn','runner-flywheel:pending','flywheel','FLY-100','flywheel-eng-lead',datetime('now','-2 hours'),'running'),
 ('exec-holder','runner-flywheel:pending','flywheel','FLY-101','flywheel-eng-lead',datetime('now','-2 hours'),'running'),
 ('exec-wait','runner-flywheel:pending','flywheel','FLY-102','flywheel-eng-lead',datetime('now','-2 hours'),'running'),
 ('exec-mail','runner-flywheel:pending','flywheel','FLY-103','flywheel-eng-lead',datetime('now','-2 hours'),'running'),
 ('exec-wake','runner-flywheel:pending','flywheel','FLY-104','flywheel-eng-lead',datetime('now','-2 hours'),'running'),
 ('exec-claim','runner-flywheel:pending','flywheel','FLY-105','flywheel-eng-lead',datetime('now','-2 hours'),'running'),
 ('exec-null-holder','runner-flywheel:pending','flywheel','FLY-106','flywheel-eng-lead',datetime('now','-2 hours'),'running'),
 ('exec-mail-parked','runner-flywheel:pending','flywheel','FLY-107','flywheel-eng-lead',datetime('now','-2 hours'),'completed'),
 ('exec-foreign','runner-flywheel:pending','flywheel','FLY-109','honey-lemon-lead',datetime('now','-2 hours'),'running'),
	('exec-review-recent','runner-flywheel:pending','flywheel','FLY-112','flywheel-eng-lead',datetime('now','-2 hours'),'running'),
	('exec-review-scheduled','runner-flywheel:pending','flywheel','FLY-113','flywheel-eng-lead',datetime('now','-2 hours'),'running'),
	('exec-review-foreign','runner-flywheel:pending','flywheel','FLY-115','honey-lemon-lead',datetime('now','-2 hours'),'running'),
 ('exec-110-old','runner-flywheel:pending','flywheel','FLY-110','lead-a',datetime('now','-3 hours'),'completed'),
 ('exec-110-current','runner-flywheel:pending','flywheel','FLY-110','flywheel-eng-lead',datetime('now','-1 hour'),'running'),
 ('exec-111-old','runner-flywheel:pending','flywheel','FLY-111','lead-a',datetime('now','-3 hours'),'completed'),
 ('exec-111-latest','runner-flywheel:pending','flywheel','FLY-111','flywheel-eng-lead',datetime('now','-1 hour'),'completed');
INSERT INTO three_stage_turn(issue_id,holder_exec_id,phase,epoch,granted_at) VALUES
 ('FLY-101','ghost-holder','implement',1,unixepoch()*1000),
 ('FLY-102','exec-wait','implement',1,unixepoch()*1000),
 ('FLY-103','exec-mail','implement',1,unixepoch()*1000),
 ('FLY-104','exec-wake','implement',1,unixepoch()*1000),
 ('FLY-105','exec-claim','implement',1,unixepoch()*1000),
 ('FLY-106','exec-null-holder','implement',1,unixepoch()*1000),
 ('FLY-108','exec-old','implement',1,unixepoch()*1000);
INSERT INTO turn_wait_ledger(execution_id,holder_exec_id,epoch,first_seen_at,no_turn_streak,last_no_turn_at) VALUES
 ('exec-wait','exec-wait',1,(unixepoch()-300)*1000,3,(unixepoch()-10)*1000),
 ('exec-old','exec-old',1,(unixepoch()-300)*1000,9,(unixepoch()-10)*1000);
INSERT INTO mailbox_identity(id,delivery_id,insert_projection_hash) VALUES
 ('mail-live-queued','delivery-live-queued','hash-1'),
 ('mail-live-lease','delivery-live-lease','hash-2'),
 ('mail-old-lease','delivery-old-lease','hash-3'),
 ('mail-dead-runner','delivery-dead-runner','hash-4'),
 ('mail-parked-queued','delivery-parked-queued','hash-5'),
 ('mail-foreign','delivery-foreign','hash-6');
INSERT INTO mailbox(id,delivery_id,from_agent,to_agent,recipient_kind,type,msg_class,content,created_at,state,claim_expires_at,relay_state) VALUES
 ('mail-live-queued','delivery-live-queued','lead','exec-mail','runner','instruction','model','SECRET_MAILBOX_CONTENT',strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 minutes'),'QUEUED',NULL,'terminal_disposed'),
 ('mail-live-lease','delivery-live-lease','lead','exec-mail','runner','instruction','model','SECRET_LIVE_LEASE',strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes'),'LEASED',strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 minutes'),'terminal_disposed'),
 ('mail-old-lease','delivery-old-lease','lead','exec-mail','runner','instruction','model','SECRET_OLD_LEASE',strftime('%Y-%m-%dT%H:%M:%fZ','now','-25 hours'),'LEASED',strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours'),'terminal_disposed'),
 ('mail-dead-runner','delivery-dead-runner','lead','exec-old','runner','instruction','model','SECRET_DEAD_RUNNER',strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 minutes'),'QUEUED',NULL,'terminal_disposed'),
 ('mail-parked-queued','delivery-parked-queued','lead','exec-mail-parked','runner','instruction','model','SECRET_PARKED_MAIL',strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 minutes'),'QUEUED',NULL,'terminal_disposed'),
 ('mail-foreign','delivery-foreign','lead','exec-foreign','runner','instruction','model','SECRET_FOREIGN_MAIL',strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 minutes'),'QUEUED',NULL,'terminal_disposed');
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
mkdir -p "$MAIN/bin/lib"
ln -sfn "$SCRIPT" "$MAIN/bin/flywheel-patrol-snapshot"
ln -sfn "$WRAPPER" "$MAIN/bin/flywheel-node-dwell-control"
ln -sfn "$ROOT/scripts/lib/bounded-run.sh" "$MAIN/bin/lib/bounded-run.sh"
DEPLOYED_OUT="$MAIN/deployed-out.txt"
if run_snapshot "$MAIN" "$DEPLOYED_OUT" flywheel-eng-lead "$MAIN/bin/flywheel-patrol-snapshot" \
  && grep -Eq '^STEP DWELL: (OK|FINDING)$' "$DEPLOYED_OUT"; then
  pass "deployed extensionless snapshot and helper symlinks execute together"
else
  fail "deployed extensionless snapshot and helper symlinks execute together"
fi
contains "$MAIN_OUT" "TURN_MISSING issue=FLY-100" "active issue without TURN is visible"
contains "$MAIN_OUT" "TURN_HOLDER_NOT_LIVE issue=FLY-101" "dead TURN holder is visible"
contains "$MAIN_OUT" "NO_TURN_STREAK issue=FLY-102" "live no-turn streak is visible"
contains "$MAIN_OUT" "NODE_SESSION_NOT_LIVE issue=FLY-106 exec=none" "NULL node execution id is a visible divergence"
contains "$MAIN_OUT" "NODE_SESSION_NOT_LIVE issue=FLY-110 exec=none" "current owner wins over historical Lead handoff"
contains "$MAIN_OUT" "NODE_SESSION_NOT_LIVE issue=FLY-111 exec=none" "latest historical cohort resolves a missing execution mapping"
not_contains "$MAIN_OUT" "issue=FLY-109" "other Lead active workflow is outside this report"
not_contains "$MAIN_OUT" "issue=TE-999" "other project active run is filtered"
not_contains "$MAIN_OUT" "issue=FLY-108" "terminal run is filtered from active ledgers"
contains "$MAIN_OUT" "MAILBOX_STALE id=mail-live-qu" "old live-runner queued mail is visible"
contains "$MAIN_OUT" "MAILBOX_STALE id=mail-live-le" "recent expired live-runner lease is visible"
contains "$MAIN_OUT" "MAILBOX_STALE id=mail-parked-" "old parked-runner queued mail is visible"
not_contains "$MAIN_OUT" "mail-old-lea" "ancient expired lease is filtered"
not_contains "$MAIN_OUT" "mail-dead-ru" "terminal runner mailbox is filtered"
not_contains "$MAIN_OUT" "mail-foreign" "other Lead mailbox is outside this report"
contains "$MAIN_OUT" "WAKE_UNACKED wake=wake-active" "active integer-ms wake window is visible"
not_contains "$MAIN_OUT" "wake-terminal" "terminal wake is filtered"
contains "$MAIN_OUT" "DEAD_LETTER_PENDING id=dead-pending" "recent pending dead letter is visible"
not_contains "$MAIN_OUT" "dead-accepted" "accepted dead letter receipt is filtered"
not_contains "$MAIN_OUT" "dead-other-lead" "other Lead dead letter is outside this report"
not_contains "$MAIN_OUT" "dead-other-project" "other project dead letter is outside this report"
contains "$MAIN_OUT" "VERDICT_HEAD_MISMATCH issue=FLY-105" "active binding/claim mismatch is visible"
contains "$MAIN_OUT" "REVIEW_JOB_FAILED issue=FLY-112 request=d1d1e9ba-8337-484b-b159-91887e26e987 type=code round=2 reason=nonzero_exit" "recent failed review is visible with live-session issue identity"
contains "$MAIN_OUT" "REVIEW_JOB_FAILED issue=FLY-113 request=scheduled-review-request type=design round=1 reason=nonzero_exit" "old durable scheduled retry remains patrol-visible"
contains "$MAIN_OUT" "STEP 4: FINDING-CANDIDATE" "review without a CommDB owner cannot black out STEP 4"
contains "$MAIN_OUT" "recovery=POST_/review-requests_same_requestId" "failed review exposes the idempotent replay entrance"
not_contains "$MAIN_OUT" "REVIEW_JOB_FAILED issue=FLY-114" "terminally invalid review failures are excluded"
not_contains "$MAIN_OUT" "request=terminal-superseded" "benign review supersede is excluded"
not_contains "$MAIN_OUT" "request=terminal-reviewed-wrong-head" "mismatched-head review is not replayable"
not_contains "$MAIN_OUT" "request=terminal-gate-missing" "missing-gate review is not replayable"
not_contains "$MAIN_OUT" "request=terminal-gate-unknown" "unknown-gate review does not guess a replay path"
not_contains "$MAIN_OUT" "old-unscheduled-review" "old unscheduled review failure is excluded"
not_contains "$MAIN_OUT" "dead-runner-review" "failed review without a live session is excluded"
not_contains "$MAIN_OUT" "orphan-comm-review" "failed review without a resolvable CommDB owner is pruned before attribution"
not_contains "$MAIN_OUT" "historical-review-" "historical rows without sessions are pruned before attribution"
not_contains "$MAIN_OUT" "SECRET_STALE_JOB_ISSUE" "review issue identity is derived from the live session"
for secret in SECRET_MAILBOX_CONTENT SECRET_LIVE_LEASE SECRET_OLD_LEASE SECRET_DEAD_RUNNER SECRET_PARKED_MAIL SECRET_FOREIGN_MAIL SECRET_WAKE_ENVELOPE SECRET_WAKE_TERMINAL SECRET_DEAD_SUMMARY SECRET_OTHER_LEAD_DEAD SECRET_OTHER_PROJECT_DEAD SECRET_ACCEPTED_SUMMARY SECRET_CLAIM_EVIDENCE SECRET_REVIEW_FAILURE_RAW SECRET_SCHEDULED_FAILURE_RAW SECRET_TERMINAL_HEAD SECRET_TERMINAL_EXTERNAL SECRET_TERMINAL_ANSWERED SECRET_TERMINAL_EXPIRED SECRET_TERMINAL_MISMATCH SECRET_TERMINAL_SUPERSEDED SECRET_TERMINAL_WRONG_HEAD SECRET_TERMINAL_MISSING SECRET_TERMINAL_UNKNOWN SECRET_OLD_REVIEW_RAW SECRET_FOREIGN_REVIEW_RAW SECRET_DEAD_REVIEW_RAW SECRET_ORPHAN_REVIEW_RAW SECRET_OTHER_REVIEW_RAW SECRET_HISTORICAL_REVIEW_RAW; do
  not_contains "$MAIN_OUT" "$secret" "secret projection excludes $secret"
done

MAIN_HONEY_OUT="$MAIN/honey.txt"
run_snapshot "$MAIN" "$MAIN_HONEY_OUT" honey-lemon-lead || fail "other Lead queue snapshot exits zero"
contains "$MAIN_HONEY_OUT" "TURN_MISSING issue=FLY-109" "other Lead sees its active workflow"
not_contains "$MAIN_HONEY_OUT" "issue=FLY-100" "other Lead does not see this Lead's workflow"
contains "$MAIN_HONEY_OUT" "MAILBOX_STALE id=mail-foreign" "other Lead sees its stale mailbox"
not_contains "$MAIN_HONEY_OUT" "MAILBOX_STALE id=mail-live-qu" "other Lead does not see this Lead's mailbox"
contains "$MAIN_HONEY_OUT" "DEAD_LETTER_PENDING id=dead-other-lead" "other Lead sees its dead letter"
contains "$MAIN_HONEY_OUT" "REVIEW_JOB_FAILED issue=FLY-115 request=foreign-lead-review" "other Lead sees its owned failed review"
not_contains "$MAIN_HONEY_OUT" "request=d1d1e9ba-8337-484b-b159-91887e26e987" "other Lead does not see this Lead's failed review"
not_contains "$MAIN_HONEY_OUT" "DEAD_LETTER_PENDING id=dead-pending" "other Lead does not see this Lead's dead letter"
not_contains "$MAIN_HONEY_OUT" "dead-other-project" "other Lead does not see cross-project dead letters"
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

# FLY-2152: the sixth patrol dimension lives inside STEP 4. The durable
# claim_written marker, rather than a deployment cutover sequence, selects the
# new contract so a fresh database cannot silently skip its first verdict.
CLAIMS="$TMP/verdict-delivery"
make_case "$CLAIMS"
sqlite3 "$CLAIMS/teamlead.db" <<'SQL'
INSERT INTO workflow_run(run_id,issue_id,project_name,status,created_at) VALUES
 ('run-401','FLY-401','flywheel','active',datetime('now')),
 ('run-402','FLY-402','flywheel','active',datetime('now')),
 ('run-403','FLY-403','flywheel','active',datetime('now')),
 ('run-404','FLY-404','flywheel','active',datetime('now')),
 ('run-405','FLY-405','flywheel','active',datetime('now')),
 ('run-406','FLY-406-FOREIGN','flywheel','active',datetime('now')),
 ('run-407','FLY-407-TERMINAL','flywheel','terminated',datetime('now')),
 ('run-408','FLY-408-FOUNDER','flywheel','active',datetime('now')),
 ('run-409','FLY-409-POLICY','flywheel','active',datetime('now')),
 ('run-411','FLY-411','flywheel','active',datetime('now'));
INSERT INTO workflow_claims(
 id,server_seq,issued_at,issue_id,workflow_run_id,node_id,decision_kind,attempt,predicate,
 issuer_kind,issuer_execution_id,issuer_node_id,issuer_vendor,issuer_model,
 subject_producer_execution_id,subject_kind,subject_digest,permanent,submission_digest,
 client_request_id,evidence,authority_id
) VALUES
 (401,401,'2026-08-29T10:01:00Z','FLY-401','run-401','qa','qa_verdict',1,'qa_failed',
  'runner_node','exec-401','qa','codex','gpt-5','exec-401','git_head','4014014014014014014014014014014014014014',1,'digest-401','request-401','{"secret":"SECRET_CLAIM_401"}','authority-401'),
 (402,402,'2026-08-29T10:02:00Z','FLY-402','run-402','qa','qa_verdict',2,'qa_failed',
  'runner_node','exec-402','qa','codex','gpt-5','exec-402','git_head','4024024024024024024024024024024024024024',1,'digest-402','request-402','{"secret":"SECRET_CLAIM_402"}','authority-402'),
 (403,403,'2026-08-29T10:03:00Z','FLY-403','run-403','code_review','code_review',3,'codex_approved',
  'runner_node','exec-403','code_review','codex','gpt-5','exec-403','git_head','4034034034034034034034034034034034034034',1,'digest-403','request-403','{"secret":"SECRET_CLAIM_403"}','authority-403'),
 (404,404,'2026-08-29T10:04:00Z','FLY-404','run-404','qa','qa_verdict',4,'qa_passed',
  'runner_node','exec-404','qa','codex','gpt-5','exec-404','git_head','4044044044044044044044044044044044044044',1,'digest-404','request-404','{"secret":"SECRET_CLAIM_404"}','authority-404'),
 (405,405,'2026-08-29T10:05:00Z','FLY-405','run-405','qa','qa_verdict',5,'qa_failed',
  'runner_node','exec-405','qa','codex','gpt-5','exec-405','git_head','4054054054054054054054054054054054054054',1,'digest-405','request-405','{"secret":"SECRET_LEGACY_CLAIM"}','authority-405'),
 (406,406,'2026-08-29T10:06:00Z','FLY-406-FOREIGN','run-406','qa','qa_verdict',6,'qa_failed',
  'runner_node','exec-406','qa','codex','gpt-5','exec-406','git_head','4064064064064064064064064064064064064064',1,'digest-406','request-406','{"secret":"SECRET_FOREIGN_CLAIM"}','authority-406'),
 (407,407,'2026-08-29T10:07:00Z','FLY-407-TERMINAL','run-407','qa','qa_verdict',7,'qa_failed',
  'runner_node','exec-407','qa','codex','gpt-5','exec-407','git_head','4074074074074074074074074074074074074074',1,'digest-407','request-407','{"secret":"SECRET_TERMINAL_CLAIM"}','authority-407'),
 (408,408,'2026-08-29T10:08:00Z','FLY-408-FOUNDER','run-408',NULL,'founder_review',NULL,'founder_approved',
  'founder_challenge',NULL,NULL,NULL,NULL,NULL,'snapshot_digest','founder-digest',1,NULL,NULL,'{"secret":"SECRET_FOUNDER_CLAIM"}','authority-408'),
 (409,409,'2026-08-29T10:09:00Z','FLY-409-POLICY','run-409',NULL,'qa_exemption',NULL,'qa_exempt',
  'bridge_policy',NULL,NULL,NULL,NULL,NULL,'snapshot_digest','policy-digest',1,NULL,NULL,'{"secret":"SECRET_POLICY_CLAIM"}','authority-409'),
 (411,411,'2026-08-29T10:11:00Z','FLY-411','run-411','qa','qa_verdict',1,'qa_failed',
  'runner_node','exec-411','qa','codex','gpt-5','exec-411','git_head','4114114114114114114114114114114114114114',1,'digest-411','request-411','{"secret":"SECRET_OWNER_MISSING"}','authority-411');
INSERT INTO workflow_run_event(run_id,seq,event_uid,kind,node_id,execution_id,payload,at) VALUES
 ('run-401',1,'credential_claim_written:401','claim_written','qa','exec-401','{"claimId":401,"leadEventRequired":true,"leadEventId":"workflow_claim:401"}',datetime('now')),
 ('run-402',1,'credential_claim_written:402','claim_written','qa','exec-402','{"claimId":402,"leadEventRequired":true,"leadEventId":"workflow_claim:402"}',datetime('now')),
 ('run-403',1,'credential_claim_written:403','claim_written','code_review','exec-403','{"claimId":403,"leadEventRequired":true,"leadEventId":"workflow_claim:403"}',datetime('now')),
 ('run-404',1,'credential_claim_written:404','claim_written','qa','exec-404','{"claimId":404,"leadEventRequired":true,"leadEventId":"workflow_claim:404"}',datetime('now')),
 ('run-405',1,'credential_claim_written:405','claim_written','qa','exec-405','{"claimId":405,"serverSeq":405,"predicate":"qa_failed"}',datetime('now')),
 ('run-406',1,'credential_claim_written:406','claim_written','qa','exec-406','{"claimId":406,"leadEventRequired":true,"leadEventId":"workflow_claim:406"}',datetime('now')),
 ('run-407',1,'credential_claim_written:407','claim_written','qa','exec-407','{"claimId":407,"leadEventRequired":true,"leadEventId":"workflow_claim:407"}',datetime('now')),
 ('run-411',1,'credential_claim_written:411','claim_written','qa','exec-411','{"claimId":411,"leadEventRequired":true,"leadEventId":"workflow_claim:411"}',datetime('now'));
INSERT INTO lead_events(lead_id,event_id,event_type,payload,delivered_at) VALUES
 ('flywheel-eng-lead','workflow_claim:402','workflow_claim_recorded','{"project_name":"flywheel","issue_id":"FLY-402","summary":"SECRET_PENDING_SUMMARY"}',NULL),
 ('honey-lemon-lead','workflow_claim:403','workflow_claim_recorded','{"project_name":"flywheel","issue_id":"FLY-403","summary":"SECRET_MISMATCH_SUMMARY"}',NULL),
 ('flywheel-eng-lead','workflow_claim:404','workflow_claim_recorded','{"project_name":"flywheel","issue_id":"FLY-404","summary":"SECRET_DELIVERED_SUMMARY"}',datetime('now'));
SQL
sqlite3 "$CLAIMS/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,started_at,status) VALUES
 ('exec-401','runner-flywheel:pending','flywheel','FLY-401','flywheel-eng-lead',datetime('now'),'running'),
 ('exec-402','runner-flywheel:pending','flywheel','FLY-402','flywheel-eng-lead',datetime('now'),'running'),
 ('exec-403','runner-flywheel:pending','flywheel','FLY-403','flywheel-eng-lead',datetime('now'),'running'),
 ('exec-404','runner-flywheel:pending','flywheel','FLY-404','flywheel-eng-lead',datetime('now'),'running'),
 ('exec-405','runner-flywheel:pending','flywheel','FLY-405','flywheel-eng-lead',datetime('now'),'running'),
 ('exec-406','runner-flywheel:pending','flywheel','FLY-406-FOREIGN','honey-lemon-lead',datetime('now'),'running'),
 ('exec-407','runner-flywheel:pending','flywheel','FLY-407-TERMINAL','flywheel-eng-lead',datetime('now'),'completed');
SQL
CLAIMS_OUT="$CLAIMS/out.txt"
run_snapshot "$CLAIMS" "$CLAIMS_OUT" || fail "verdict delivery snapshot exits zero"
contains "$CLAIMS_OUT" "CLAIM_DELIVERY_MISSING issue=FLY-401 claim=401 decision=qa_verdict predicate=qa_failed issued=2026-08-29T10:01:00Z node=qa attempt=1 exec=exec-401" "fresh-db first marked claim without event is visible"
contains "$CLAIMS_OUT" "CLAIM_DELIVERY_PENDING issue=FLY-402 claim=402 decision=qa_verdict predicate=qa_failed issued=2026-08-29T10:02:00Z node=qa attempt=2 exec=exec-402" "undelivered marked claim is visible"
contains "$CLAIMS_OUT" "CLAIM_DELIVERY_OWNER_MISMATCH issue=FLY-403 claim=403 decision=code_review predicate=codex_approved issued=2026-08-29T10:03:00Z node=code_review attempt=3 exec=exec-403" "wrong-owner marked claim is visible"
count_is "$CLAIMS_OUT" "CLAIM_DELIVERY_" 3 "only missing, pending, and owner mismatch claims are findings"
contains "$CLAIMS_OUT" "CLAIM_ATTRIBUTION_INCOMPLETE reason=owner_missing count=1" "one ownerless marked claim is aggregated without suppressing attributable findings"
not_contains "$CLAIMS_OUT" "claim_delivery_marker_invalid" "legacy pre-contract marker is excluded without poisoning the verdict dimension"
for hidden in FLY-404 FLY-405 FLY-406-FOREIGN FLY-407-TERMINAL FLY-408-FOUNDER FLY-409-POLICY FLY-411 SECRET_CLAIM SECRET_LEGACY SECRET_FOREIGN SECRET_TERMINAL SECRET_FOUNDER SECRET_POLICY SECRET_OWNER_MISSING SECRET_PENDING_SUMMARY SECRET_MISMATCH_SUMMARY SECRET_DELIVERED_SUMMARY; do
  not_contains "$CLAIMS_OUT" "$hidden" "verdict projection excludes non-finding or secret $hidden"
done

# Claim attribution/marker failures close only the claim branch. Existing
# mailbox and wake facts in STEP 4 remain available and visible.
CLAIM_ATTRIB="$TMP/verdict-attribution"
make_case "$CLAIM_ATTRIB"
sqlite3 "$CLAIM_ATTRIB/teamlead.db" <<'SQL'
INSERT INTO workflow_run(run_id,issue_id,project_name,status,created_at) VALUES
 ('run-410','FLY-410','flywheel','active',datetime('now'));
INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at) VALUES
 ('run-410','qa',1,'running','exec-410',datetime('now'));
INSERT INTO sessions(execution_id,issue_id,issue_identifier,issue_title,project_name,status) VALUES
 ('exec-410','FLY-410','FLY-410','claim marker invalid','flywheel','running');
INSERT INTO workflow_claims(
 id,server_seq,issued_at,issue_id,workflow_run_id,node_id,decision_kind,attempt,predicate,
 issuer_kind,issuer_execution_id,issuer_node_id,issuer_vendor,issuer_model,
 subject_producer_execution_id,subject_kind,subject_digest,permanent,submission_digest,
 client_request_id,evidence,authority_id
) VALUES
 (410,410,'2026-08-29T10:10:00Z','FLY-410','run-410','qa','qa_verdict',1,'qa_failed',
  'runner_node','exec-410','qa','codex','gpt-5','exec-410','git_head','4104104104104104104104104104104104104104',1,'digest-410','request-410','{"secret":"SECRET_INVALID_MARKER"}','authority-410');
INSERT INTO workflow_run_event(run_id,seq,event_uid,kind,node_id,execution_id,payload,at) VALUES
 ('run-410',1,'credential_claim_written:410-a','claim_written','qa','exec-410','{"claimId":410,"leadEventRequired":true,"leadEventId":"workflow_claim:410"}',datetime('now')),
 ('run-410',2,'credential_claim_written:410-b','claim_written','qa','exec-410','{"claimId":410,"leadEventRequired":true,"leadEventId":"workflow_claim:410"}',datetime('now'));
SQL
sqlite3 "$CLAIM_ATTRIB/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,started_at,status) VALUES
 ('exec-410','runner-flywheel:pending','flywheel','FLY-410','flywheel-eng-lead',datetime('now','-1 hour'),'running');
INSERT INTO mailbox_identity(id,delivery_id,insert_projection_hash) VALUES
 ('mail-410','delivery-410','hash-410');
INSERT INTO mailbox(id,delivery_id,from_agent,to_agent,recipient_kind,type,msg_class,content,created_at,state,relay_state) VALUES
 ('mail-410','delivery-410','lead','exec-410','runner','instruction','model','SECRET_ATTRIB_MAIL',strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 minutes'),'QUEUED','terminal_disposed');
INSERT INTO turn_wake_outbox(wake_id,execution_id,issue_id,epoch,purpose,envelope_json,backend,state,episode_id,created_at) VALUES
 ('wake-410','exec-410','FLY-410',1,'turn','{"secret":"SECRET_ATTRIB_WAKE"}','mailbox','pending','episode-410',(unixepoch()-1200)*1000);
SQL
CLAIM_ATTRIB_OUT="$CLAIM_ATTRIB/out.txt"
run_snapshot "$CLAIM_ATTRIB" "$CLAIM_ATTRIB_OUT" || fail "claim attribution failure still publishes report"
contains "$CLAIM_ATTRIB_OUT" "CLAIM_ATTRIBUTION_INCOMPLETE reason=claim_delivery_marker_invalid count=1" "duplicate claim marker is aggregated"
contains "$CLAIM_ATTRIB_OUT" "MAILBOX_STALE id=mail-410" "claim attribution failure does not suppress mailbox facts"
contains "$CLAIM_ATTRIB_OUT" "WAKE_UNACKED wake=wake-410" "claim attribution failure does not suppress wake facts"
not_contains "$CLAIM_ATTRIB_OUT" "SECRET_INVALID_MARKER" "claim attribution aggregate excludes evidence"
not_contains "$CLAIM_ATTRIB_OUT" "SECRET_ATTRIB_MAIL" "claim attribution fixture excludes mailbox content"
not_contains "$CLAIM_ATTRIB_OUT" "SECRET_ATTRIB_WAKE" "claim attribution fixture excludes wake envelope"

# FLY-2118: unresolved or ambiguous owner attribution fails the entire STEP
# closed and emits only aggregate, identifier-free diagnostics.
ATTRIB3="$TMP/owner-attribution-step3"
make_case "$ATTRIB3"
sqlite3 "$ATTRIB3/teamlead.db" <<'SQL'
INSERT INTO workflow_run(run_id,issue_id,project_name,status,created_at) VALUES
 ('run-300','FLY-300','flywheel','active',datetime('now')),
 ('run-302','FLY-302','flywheel','active',datetime('now')),
 ('run-303','FLY-303','flywheel','active',datetime('now')),
 ('run-304','FLY-304','flywheel','active',datetime('now'));
INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at) VALUES
 ('run-300','implement',1,'running',NULL,datetime('now')),
 ('run-302','implement',1,'running',NULL,datetime('now')),
 ('run-303','implement',1,'running',NULL,datetime('now')),
 ('run-304','implement',1,'running','exec-blank-lead',datetime('now'));
SQL
sqlite3 "$ATTRIB3/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,started_at,status) VALUES
 ('exec-300-a','runner-flywheel:pending','flywheel','FLY-300','flywheel-eng-lead',datetime('now','-1 hour'),'running'),
 ('exec-300-b','runner-flywheel:pending','flywheel','FLY-300','honey-lemon-lead',datetime('now','-1 hour'),'blocked'),
 ('exec-302-a','runner-flywheel:pending','flywheel','FLY-302','flywheel-eng-lead','2026-08-28T10:00:00Z','completed'),
 ('exec-302-b','runner-flywheel:pending','flywheel','FLY-302','honey-lemon-lead','2026-08-28T10:00:00Z','failed'),
 ('exec-blank-lead','runner-flywheel:pending','flywheel','FLY-304',NULL,datetime('now','-1 hour'),'completed');
SQL
ATTRIB3_OUT="$ATTRIB3/out.txt"
run_snapshot "$ATTRIB3" "$ATTRIB3_OUT" || fail "STEP 3 attribution failure still publishes report"
contains "$ATTRIB3_OUT" "STEP 3: UNAVAILABLE(structural: owner_attribution_incomplete)" "STEP 3 fails closed for incomplete owner attribution"
contains "$ATTRIB3_OUT" "OWNER_ATTRIBUTION_INCOMPLETE reason=current_owner_ambiguous count=1" "current owner ambiguity is aggregated"
contains "$ATTRIB3_OUT" "OWNER_ATTRIBUTION_INCOMPLETE reason=latest_owner_ambiguous count=1" "latest cohort tie is aggregated"
contains "$ATTRIB3_OUT" "OWNER_ATTRIBUTION_INCOMPLETE reason=owner_missing count=1" "missing execution and issue owner is aggregated"
contains "$ATTRIB3_OUT" "OWNER_ATTRIBUTION_INCOMPLETE reason=execution_owner_invalid count=1" "blank exact owner is aggregated"
for hidden in FLY-300 FLY-302 FLY-303 FLY-304 exec-blank honey-lemon-lead; do
  not_contains "$ATTRIB3_OUT" "$hidden" "STEP 3 aggregate hides foreign identifier $hidden"
done

# FLY-2210 review regression: durable receipt lineage is a DWELL-only fallback.
# It must not override the live issue cohort or poison the shared STEP 3 owner
# resolver when the exact execution's live session has already been pruned.
LINEAGE_SCOPE="$TMP/lineage-scope"
make_case "$LINEAGE_SCOPE"
sqlite3 "$LINEAGE_SCOPE/teamlead.db" <<'SQL'
INSERT INTO workflow_run(run_id,issue_id,project_name,status,created_at) VALUES
 ('run-8000','FLY-8000','flywheel','active',datetime('now')),
 ('run-8001','FLY-8001','flywheel','active',datetime('now'));
INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at) VALUES
 ('run-8000','implement',1,'running','exec-stale-lineage',datetime('now','-5 hours')),
 ('run-8001','implement',1,'running','exec-blank-lineage',datetime('now','-5 hours'));
SQL
sqlite3 "$LINEAGE_SCOPE/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,started_at,status) VALUES
 ('exec-current-8000','runner-flywheel:pending','flywheel','FLY-8000','flywheel-eng-lead',datetime('now','-1 hour'),'running'),
 ('exec-current-8001','runner-flywheel:pending','flywheel','FLY-8001','flywheel-eng-lead',datetime('now','-1 hour'),'running');
INSERT INTO session_receipt_lineage(execution_id,project_name,issue_id,lead_id) VALUES
 ('exec-stale-lineage','flywheel','FLY-8000','retired-old-lead'),
 ('exec-blank-lineage','flywheel','FLY-8001',NULL);
SQL
LINEAGE_SCOPE_OUT="$LINEAGE_SCOPE/out.txt"
run_snapshot "$LINEAGE_SCOPE" "$LINEAGE_SCOPE_OUT" || fail "lineage scope snapshot exits zero"
contains "$LINEAGE_SCOPE_OUT" "NODE_SESSION_NOT_LIVE issue=FLY-8000 exec=exec-sta" "stale lineage cannot steal STEP 3 from the live issue cohort"
contains "$LINEAGE_SCOPE_OUT" "NODE_SESSION_NOT_LIVE issue=FLY-8001 exec=exec-bla" "blank lineage cannot poison STEP 3 owner attribution"
not_contains "$LINEAGE_SCOPE_OUT" "STEP 3: UNAVAILABLE(structural: owner_attribution_incomplete)" "DWELL lineage fallback does not alter shared STEP 3 attribution"
contains "$LINEAGE_SCOPE_OUT" "NODE_DWELL issue=FLY-8000" "stale lineage cannot hide an overdue node from STEP DWELL"
contains "$LINEAGE_SCOPE_OUT" "NODE_DWELL issue=FLY-8001" "blank lineage yields to the live issue cohort in STEP DWELL"
count_is "$LINEAGE_SCOPE_OUT" "over_threshold=yes route=deep_dive" 2 "both live-cohort overdue nodes remain actionable"

HISTORICAL_LINEAGE="$TMP/historical-lineage-precedence"
make_case "$HISTORICAL_LINEAGE"
sqlite3 "$HISTORICAL_LINEAGE/teamlead.db" <<'SQL'
INSERT INTO workflow_run(run_id,issue_id,project_name,status,created_at) VALUES
 ('run-8100','FLY-8100','flywheel','active',datetime('now','-5 hours')),
 ('run-8101','FLY-8101','flywheel','active',datetime('now','-5 hours'));
INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at) VALUES
 ('run-8100','founder_gate',1,'review',NULL,datetime('now','-5 hours')),
 ('run-8101','implement',1,'running','exec-stale-exact',datetime('now','-5 hours'));
SQL
sqlite3 "$HISTORICAL_LINEAGE/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,started_at,status) VALUES
 ('exec-historical-8100','runner-flywheel:closed','flywheel','FLY-8100','flywheel-eng-lead',datetime('now','-2 hours'),'completed'),
 ('exec-historical-8101','runner-flywheel:closed','flywheel','FLY-8101','flywheel-eng-lead',datetime('now','-2 hours'),'completed');
INSERT INTO session_receipt_lineage(execution_id,project_name,issue_id,lead_id) VALUES
 ('exec-stale-null','flywheel','FLY-8100','retired-old-lead'),
 ('exec-stale-exact','flywheel','FLY-8101','retired-old-lead');
SQL
HISTORICAL_LINEAGE_OUT="$HISTORICAL_LINEAGE/out.txt"
run_snapshot "$HISTORICAL_LINEAGE" "$HISTORICAL_LINEAGE_OUT" || fail "historical lineage precedence snapshot exits zero"
contains "$HISTORICAL_LINEAGE_OUT" "NODE_DWELL issue=FLY-8100" "historical cohort keeps a NULL-exec founder gate visible"
contains "$HISTORICAL_LINEAGE_OUT" "NODE_DWELL issue=FLY-8100 run=run-8100 node=founder_gate attempt=1 state=review" "historical cohort owns the NULL-exec founder gate"
contains "$HISTORICAL_LINEAGE_OUT" "NODE_DWELL issue=FLY-8101 run=run-8101 node=implement attempt=1 state=running" "historical cohort outranks exact stale lineage"
count_is "$HISTORICAL_LINEAGE_OUT" "over_threshold=yes route=founder_reminder" 1 "historical NULL-exec founder gate still routes to reminder"
count_is "$HISTORICAL_LINEAGE_OUT" "over_threshold=yes route=deep_dive" 1 "historical cohort keeps exact-exec overdue work actionable"
not_contains "$HISTORICAL_LINEAGE_OUT" "NODE_DWELL_ATTRIBUTION_INCOMPLETE" "stale lineage cannot poison a usable historical cohort"

ATTRIB4="$TMP/owner-attribution-step4"
make_case "$ATTRIB4"
sqlite3 "$ATTRIB4/teamlead.db" <<'SQL'
INSERT INTO sessions(execution_id,issue_id,issue_identifier,issue_title,project_name,status) VALUES
 ('exec-mail-ambiguous','FLY-301','FLY-301','ambiguous mail owner','flywheel','running');
SQL
sqlite3 "$ATTRIB4/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,started_at,status) VALUES
 ('exec-301-a','runner-flywheel:pending','flywheel','FLY-301','flywheel-eng-lead',datetime('now','-1 hour'),'running'),
 ('exec-301-b','runner-flywheel:pending','flywheel','FLY-301','honey-lemon-lead',datetime('now','-1 hour'),'blocked');
INSERT INTO mailbox_identity(id,delivery_id,insert_projection_hash) VALUES
 ('mail-ambiguous','delivery-ambiguous','hash-ambiguous');
INSERT INTO mailbox(id,delivery_id,from_agent,to_agent,recipient_kind,type,msg_class,content,created_at,state,relay_state) VALUES
 ('mail-ambiguous','delivery-ambiguous','lead','exec-mail-ambiguous','runner','instruction','model','SECRET_AMBIGUOUS_MAIL',strftime('%Y-%m-%dT%H:%M:%fZ','now','-40 minutes'),'QUEUED','terminal_disposed');
SQL
ATTRIB4_OUT="$ATTRIB4/out.txt"
run_snapshot "$ATTRIB4" "$ATTRIB4_OUT" || fail "STEP 4 attribution failure still publishes report"
contains "$ATTRIB4_OUT" "STEP 4: UNAVAILABLE(structural: owner_attribution_incomplete)" "STEP 4 fails closed for incomplete owner attribution"
contains "$ATTRIB4_OUT" "OWNER_ATTRIBUTION_INCOMPLETE reason=current_owner_ambiguous count=1" "STEP 4 ambiguity is aggregated"
for hidden in FLY-301 mail-ambiguous exec-mail-ambiguous honey-lemon-lead SECRET_AMBIGUOUS_MAIL; do
  not_contains "$ATTRIB4_OUT" "$hidden" "STEP 4 aggregate hides foreign identifier $hidden"
done

# FLY-2118: owner-first capture. Two Leads sharing one tmux server must each
# capture only their own panes; foreign, unclaimed, QA, and cmux panes stay out.
PANES="$TMP/panes"
make_case "$PANES"
cat > "$PANES/bin/tmux" <<'SH'
#!/bin/bash
printf '%s\n' "$*" >> "${TMUX_CALL_LOG:?}"
case "${1:-}" in
  list-windows)
    printf '%s\n' 'runner-flywheel: FLY-200 FLY-201 FLY-202 FLY-207' 'runner-tidal-echo: TE-300' 'runner-test-slot-2: TEST-1' 'cmux-FLY-200: FLY-200'
    ;;
  list-panes)
    printf '%%1\trunner-flywheel\trunner-flywheel:@1\tFLY-200\tclaude\t0\n'
    printf '%%2\trunner-flywheel\trunner-flywheel:@2\tFLY-201\tclaude\t0\n'
    printf '%%3\trunner-tidal-echo\trunner-tidal-echo:@3\tTE-300\tclaude\t0\n'
    printf '%%4\tcmux-FLY-200\tcmux-FLY-200:@4\tFLY-200\tclaude\t0\n'
    printf '%%5\trunner-test-slot-2\trunner-test-slot-2:@5\tTEST-1\tclaude\t0\n'
    printf '%%6\trunner-flywheel\trunner-flywheel:@6\tFLY-202\tclaude\t0\n'
    printf '%%7\trunner-flywheel\trunner-flywheel:@7\tFLY-207\tclaude\t0\n'
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
      %7) printf '%s\n' 'Honey Lemon runner is healthy' ;;
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
 ('exec-pane-2','runner-flywheel:@2','flywheel','FLY-201','flywheel-eng-lead','running','claude'),
 ('exec-pane-7','runner-flywheel:@7','flywheel','FLY-207','honey-lemon-lead','running','claude');
SQL
sqlite3 "$PANES/state/comm/tidal-echo/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,status,vendor) VALUES
 ('exec-pane-3','runner-tidal-echo:@3','tidal-echo','TE-300','tidal-echo-content-lead','running','claude');
SQL
mkdir -p "$PANES/state/patrol-reports/flywheel-eng-lead"
mkdir -p "$PANES/state/patrol-continuity/flywheel-eng-lead"
PANE_STATE_HASH="$(printf '%s' 'Awaiting review' | shasum -a 256 | awk '{print $1}')"
cat > "$PANES/state/patrol-reports/flywheel-eng-lead/20260819T000000Z-tickNA.md" <<EOF
pane_count=1
PANE_EVIDENCE pane=%1 target=runner-flywheel:@1 owner=owned exec=exec-pane-1 capture_sha256=old lines=2 bytes=20 state_sha256=$PANE_STATE_HASH last_change_epoch=$(($(date +%s) - 3700)) findings=none action=none result=clear
EOF
printf 'runner-flywheel:@1\t%s\t%s\n' "$PANE_STATE_HASH" "$(($(date +%s) - 3700))" \
  > "$PANES/state/patrol-continuity/flywheel-eng-lead/flywheel.tsv"
PANES_OUT="$PANES/out.txt"
TMUX_CALL_LOG="$PANES/tmux-calls.log" run_snapshot "$PANES" "$PANES_OUT" || fail "pane evidence snapshot exits zero"
contains "$PANES_OUT" "pane_count=2" "Lead pane count contains only its two owned panes"
count_is "$PANES_OUT" "PANE_EVIDENCE " 2 "only owned panes have evidence rows"
for pane in %1 %2; do
  contains "$PANES/tmux-calls.log" "capture-pane -p -S - -t $pane" "pane $pane uses full scrollback capture"
done
for pane in %3 %4 %5 %6 %7; do
  not_contains "$PANES/tmux-calls.log" "capture-pane -p -S - -t $pane" "pane $pane is outside this Lead's capture surface"
done
not_contains "$PANES_OUT" "SECRET_PANE_TRANSCRIPT" "raw pane transcript is never persisted"
contains "$PANES_OUT" "pane=%1 target=runner-flywheel:@1 owner=owned" "owned pane is mapped from current CommDB"
contains "$PANES_OUT" "pane=%1 target=runner-flywheel:@1 owner=owned exec=exec-pane-1" "owned evidence includes execution id"
contains "$PANES_OUT" "findings=STALLED_60M action=REQUIRED result=UNSET" "unchanged state for one hour is a required finding"
contains "$PANES_OUT" "pane=%2 target=runner-flywheel:@2 owner=owned" "second owned pane is mapped"
contains "$PANES_OUT" "findings=LIMIT_LIVE,INTERACTIVE_MENU action=REQUIRED result=UNSET" "live limit and menu are explicit findings"
for hidden in 'runner-tidal-echo:@3' 'runner-test-slot-2:@5' 'runner-flywheel:@6' 'runner-flywheel:@7' 'exec-pane-3' 'exec-pane-7'; do
  not_contains "$PANES_OUT" "$hidden" "foreign/unclaimed fact $hidden is absent from this Lead report"
done
contains "$PANES/state/patrol-continuity/flywheel-eng-lead/flywheel.tsv" "runner-flywheel:@1" "stall continuity is persisted outside the Lead-editable report"
not_contains "$PANES/state/patrol-continuity/flywheel-eng-lead/flywheel.tsv" "runner-flywheel:@6" "orphan continuity is no longer kept by department Leads"

HONEY_OUT="$PANES/honey.txt"
TMUX_CALL_LOG="$PANES/tmux-calls-honey.log" run_snapshot "$PANES" "$HONEY_OUT" honey-lemon-lead || fail "second Lead snapshot exits zero"
contains "$HONEY_OUT" "pane_count=1" "second Lead sees only its one owned pane"
contains "$HONEY_OUT" "pane=%7 target=runner-flywheel:@7 owner=owned exec=exec-pane-7" "second Lead owns its pane"
for pane in %1 %2 %3 %4 %5 %6; do
  not_contains "$PANES/tmux-calls-honey.log" "capture-pane -p -S - -t $pane" "second Lead does not capture pane $pane"
done
count_is "$PANES/tmux-calls.log" "capture-pane -p -S - -t %1" 1 "owner captures pane %1 exactly once"
count_is "$PANES/tmux-calls.log" "capture-pane -p -S - -t %2" 1 "owner captures pane %2 exactly once"
count_is "$PANES/tmux-calls-honey.log" "capture-pane -p -S - -t %7" 1 "owner captures pane %7 exactly once"

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
contains "$PANE_FAIL_OUT" "pane_count=2" "capture failure does not hide owned pane count"
count_is "$PANE_FAIL_OUT" "PANE_EVIDENCE " 2 "capture failure still emits one row per owned pane"
contains "$PANE_FAIL_OUT" "pane=%2 target=runner-flywheel:@2 owner=owned" "failed pane keeps identity evidence"
contains "$PANE_FAIL_OUT" "findings=CAPTURE_FAILED action=REQUIRED result=UNSET" "failed pane requires explicit disposition"

HASH_FAIL="$TMP/hash-fail"
make_case "$HASH_FAIL"
cp "$PANES/bin/tmux" "$HASH_FAIL/bin/tmux"
sqlite3 "$HASH_FAIL/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,status,vendor) VALUES
 ('exec-pane-1','runner-flywheel:@1','flywheel','FLY-200','flywheel-eng-lead','running','claude'),
 ('exec-pane-2','runner-flywheel:@2','flywheel','FLY-201','flywheel-eng-lead','running','claude');
SQL
cat > "$HASH_FAIL/bin/shasum" <<'SH'
#!/bin/bash
exit 127
SH
chmod 0755 "$HASH_FAIL/bin/shasum"
HASH_FAIL_OUT="$HASH_FAIL/out.txt"
TMUX_CALL_LOG="$HASH_FAIL/tmux-calls.log" run_snapshot "$HASH_FAIL" "$HASH_FAIL_OUT" || fail "hash failure still publishes report"
contains "$HASH_FAIL_OUT" "STEP 2: UNAVAILABLE(structural: hash_unavailable)" "hash failure is fail-closed"
contains "$HASH_FAIL_OUT" "findings=HASH_UNAVAILABLE action=REQUIRED result=UNSET" "hash failure requires explicit disposition"
contains "$HASH_FAIL_OUT" "capture_sha256=unavailable" "hash failure preserves a well-formed capture evidence field"
contains "$HASH_FAIL_OUT" "state_sha256=unavailable" "hash failure preserves a well-formed state evidence field"
not_contains "$HASH_FAIL/state/patrol-continuity/flywheel-eng-lead/flywheel.tsv" $'\t\t' "hash failure writes no empty continuity field"

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
count_is "$INDEX_FAIL_OUT" "PANE_EVIDENCE " 0 "incomplete machine owner index captures no pane"
not_contains "$INDEX_FAIL_OUT" "runner-tidal-echo:@3" "incomplete foreign index leaks no foreign pane"
[ -e "$INDEX_FAIL/tmux-calls.log" ] || : > "$INDEX_FAIL/tmux-calls.log"
not_contains "$INDEX_FAIL/tmux-calls.log" "capture-pane" "incomplete owner index fails closed before capture"
not_contains "$INDEX_FAIL_OUT" "no such table" "raw owner-index error is not persisted"

REGISTRY_FAIL="$TMP/registry-fail"
make_case "$REGISTRY_FAIL"
cp "$PANES/bin/tmux" "$REGISTRY_FAIL/bin/tmux"
rm -f "$REGISTRY_FAIL/state/projects.json"
REGISTRY_FAIL_OUT="$REGISTRY_FAIL/out.txt"
TMUX_CALL_LOG="$REGISTRY_FAIL/tmux-calls.log" run_snapshot "$REGISTRY_FAIL" "$REGISTRY_FAIL_OUT" || fail "missing registry still publishes report"
contains "$REGISTRY_FAIL_OUT" "STEP 2: UNAVAILABLE(structural: owner_index_incomplete)" "missing owner registry is fail-closed"
count_is "$REGISTRY_FAIL_OUT" "PANE_EVIDENCE " 0 "missing registry yields zero pane evidence"
[ -e "$REGISTRY_FAIL/tmux-calls.log" ] || : > "$REGISTRY_FAIL/tmux-calls.log"
not_contains "$REGISTRY_FAIL/tmux-calls.log" "capture-pane" "missing registry performs no capture"

DUPLICATE="$TMP/duplicate-owner"
make_case "$DUPLICATE"
cp "$PANES/bin/tmux" "$DUPLICATE/bin/tmux"
sqlite3 "$DUPLICATE/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,status,vendor) VALUES
 ('exec-pane-1','runner-flywheel:@1','flywheel','FLY-200','flywheel-eng-lead','running','claude');
SQL
sqlite3 "$DUPLICATE/state/comm/tidal-echo/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,status,vendor) VALUES
 ('exec-duplicate','runner-flywheel:@1','flywheel','FLY-999','honey-lemon-lead','running','claude');
SQL
DUPLICATE_OUT="$DUPLICATE/out.txt"
TMUX_CALL_LOG="$DUPLICATE/tmux-calls.log" run_snapshot "$DUPLICATE" "$DUPLICATE_OUT" || fail "duplicate owner target still publishes report"
contains "$DUPLICATE_OUT" "STEP 2: UNAVAILABLE(structural: session_target_ambiguous)" "duplicate machine owner is fail-visible"
count_is "$DUPLICATE_OUT" "PANE_EVIDENCE " 0 "ambiguous target emits no pane capture evidence"
not_contains "$DUPLICATE/tmux-calls.log" "capture-pane -p -S - -t %1" "ambiguous target is captured by neither claimant"
DUPLICATE_HONEY_OUT="$DUPLICATE/honey.txt"
TMUX_CALL_LOG="$DUPLICATE/tmux-calls-honey.log" run_snapshot "$DUPLICATE" "$DUPLICATE_HONEY_OUT" honey-lemon-lead || fail "other duplicate claimant still publishes report"
contains "$DUPLICATE_HONEY_OUT" "STEP 2: UNAVAILABLE(structural: session_target_ambiguous)" "other claimant sees the same structural ambiguity"
not_contains "$DUPLICATE/tmux-calls-honey.log" "capture-pane -p -S - -t %1" "other claimant also performs zero capture"

MISSING_PANE="$TMP/missing-owned-pane"
make_case "$MISSING_PANE"
cp "$PANES/bin/tmux" "$MISSING_PANE/bin/tmux"
sqlite3 "$MISSING_PANE/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,status,vendor) VALUES
 ('exec-missing-pane','runner-flywheel:@99','flywheel','FLY-299','flywheel-eng-lead','running','claude');
SQL
MISSING_PANE_OUT="$MISSING_PANE/out.txt"
TMUX_CALL_LOG="$MISSING_PANE/tmux-calls.log" run_snapshot "$MISSING_PANE" "$MISSING_PANE_OUT" || fail "missing owned pane still publishes report"
contains "$MISSING_PANE_OUT" "ROSTER_EVIDENCE target=runner-flywheel:@99 exec=exec-missing-pane live_panes=0 findings=MISSING_PANE" "owned roster row without a pane is visible"
count_is "$MISSING_PANE_OUT" "PANE_EVIDENCE " 0 "missing pane cannot be captured"

BLANK_OWNER="$TMP/blank-owner"
make_case "$BLANK_OWNER"
cp "$PANES/bin/tmux" "$BLANK_OWNER/bin/tmux"
sqlite3 "$BLANK_OWNER/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,status,vendor) VALUES
 ('exec-blank-owner','runner-flywheel:@1','flywheel','FLY-200',NULL,'running','claude');
SQL
BLANK_OWNER_OUT="$BLANK_OWNER/out.txt"
TMUX_CALL_LOG="$BLANK_OWNER/tmux-calls.log" run_snapshot "$BLANK_OWNER" "$BLANK_OWNER_OUT" || fail "blank owner still publishes report"
contains "$BLANK_OWNER_OUT" "STEP 2: UNAVAILABLE(structural: owner_index_incomplete)" "bound target with blank lead fails closed"
count_is "$BLANK_OWNER_OUT" "PANE_EVIDENCE " 0 "blank owner yields zero pane evidence"
[ -e "$BLANK_OWNER/tmux-calls.log" ] || : > "$BLANK_OWNER/tmux-calls.log"
not_contains "$BLANK_OWNER/tmux-calls.log" "capture-pane" "blank owner performs no capture"

DEAD_PANE="$TMP/dead-pane"
make_case "$DEAD_PANE"
cat > "$DEAD_PANE/bin/tmux" <<'SH'
#!/bin/bash
case "${1:-}" in
  list-windows) printf '%s\n' 'runner-flywheel: FLY-210' ;;
  list-panes) printf '%%9\trunner-flywheel\trunner-flywheel:@9\tFLY-210\tclaude\t1\n' ;;
  capture-pane) printf '%s\n' 'process exited' ;;
  *) exit 2 ;;
esac
SH
chmod 0755 "$DEAD_PANE/bin/tmux"
sqlite3 "$DEAD_PANE/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,status,vendor) VALUES
 ('exec-dead-pane','runner-flywheel:@9','flywheel','FLY-210','flywheel-eng-lead','running','claude');
SQL
DEAD_PANE_OUT="$DEAD_PANE/out.txt"
run_snapshot "$DEAD_PANE" "$DEAD_PANE_OUT" || fail "dead pane snapshot exits zero"
contains "$DEAD_PANE_OUT" "pane=%9 target=runner-flywheel:@9 owner=owned" "dead pane keeps canonical identity"
contains "$DEAD_PANE_OUT" "findings=PANE_DEAD action=REQUIRED result=UNSET" "tmux pane_dead is an immediate finding"

NO_SERVER="$TMP/no-server"
make_case "$NO_SERVER"
cat > "$NO_SERVER/bin/tmux" <<'SH'
#!/bin/bash
echo 'no server running on /tmp/tmux-501/default' >&2
exit 1
SH
chmod 0755 "$NO_SERVER/bin/tmux"
NO_SERVER_OUT="$NO_SERVER/out.txt"
run_snapshot "$NO_SERVER" "$NO_SERVER_OUT" || fail "absent tmux server still publishes report"
contains "$NO_SERVER_OUT" "STEP 1: UNAVAILABLE(transient: tmux_server_absent)" "absent tmux server is not mislabeled structural"
contains "$NO_SERVER_OUT" "STEP 2: UNAVAILABLE(transient: tmux_server_absent)" "pane step carries the accurate tmux absence token"

DWELL="$TMP/dwell"
make_case "$DWELL"
sqlite3 "$DWELL/teamlead.db" <<'SQL'
INSERT INTO workflow_run(run_id,issue_id,project_name,status,created_at)
VALUES ('run-dwell','FLY-2210','flywheel','active',datetime('now','-4 hours'));
INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at)
VALUES ('run-dwell','implement',1,'running','exec-dwell',datetime('now','-4 hours'));
INSERT INTO sessions(execution_id,issue_id,issue_identifier,issue_title,project_name,status)
VALUES ('exec-dwell','FLY-2210','FLY-2210','dwell fixture','flywheel','running');
SQL
sqlite3 "$DWELL/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,started_at,status)
VALUES ('exec-dwell','runner-flywheel:pending','flywheel','FLY-2210','flywheel-eng-lead',datetime('now','-4 hours'),'running');
SQL
DWELL_OUT="$DWELL/out.txt"
run_snapshot "$DWELL" "$DWELL_OUT" || fail "four-hour dwell snapshot exits zero"
contains "$DWELL_OUT" "STEP DWELL: FINDING" "four-hour active node forces a dwell finding"
contains "$DWELL_OUT" "NODE_DWELL issue=FLY-2210 run=run-dwell node=implement attempt=1" "owned overdue node is listed"
contains "$DWELL_OUT" "route=deep_dive" "ordinary overdue node routes to deep dive"
if grep -Eq '^NODE_DWELL .* baseline=[^ ]+ dwell_hours=' "$DWELL_OUT"; then
  pass "dwell baseline is a single parse-safe field"
else
  fail "dwell baseline must be normalized without spaces"
fi
contains "$DWELL_OUT" "DWELL_ACTION step=DWELL issue=FLY-2210 route=deep_dive action=REQUIRED result=UNSET" "snapshot emits an explicit deep-dive action placeholder"
not_contains "$DWELL_OUT" "FINDING step=DWELL owner=flywheel-eng-lead" "snapshot never emits a malformed finalized DWELL finding"
count_is "$DWELL_OUT" "STEP DWELL:" 1 "snapshot emits one independent dwell status"
numeric_step_count="$(grep -Ec '^STEP [1-6]:' "$DWELL_OUT" || true)"
[ "$numeric_step_count" -eq 6 ] && pass "dwell step preserves exactly six numeric statuses" \
  || fail "dwell step preserves exactly six numeric statuses (got $numeric_step_count)"

DB_PATH="$DWELL/teamlead.db" RAW_TO=0 node --input-type=module -e '
  import { StateStore } from "./packages/teamlead/dist/StateStore.js";
  const store = await StateStore.create(process.env.DB_PATH);
  const result = store.applyScopedFlagValueChange({
    name: "node_dwell", scope: "flywheel", op: "set",
    rawTo: process.env.RAW_TO,
    expectedChangeSeq: store.getFlagValueChangeSeq("node_dwell", "flywheel"),
    actor: "fixture", reason: "exercise the node dwell patrol kill switch",
  });
  store.close();
  if (!result.ok) throw new Error(JSON.stringify(result));'
DWELL_OFF_OUT="$DWELL/off.txt"
run_snapshot "$DWELL" "$DWELL_OFF_OUT" || fail "disabled dwell snapshot exits zero"
contains "$DWELL_OFF_OUT" "STEP DWELL: OK" "disabled dwell mechanism is not a forced finding"
count_is "$DWELL_OFF_OUT" "NODE_DWELL " 0 "disabled dwell mechanism emits no node rows"
count_is "$DWELL_OFF_OUT" "DWELL_ACTION step=DWELL" 0 "disabled dwell mechanism emits no action placeholders"

DB_PATH="$DWELL/teamlead.db" RAW_TO=1 node --input-type=module -e '
  import { StateStore } from "./packages/teamlead/dist/StateStore.js";
  const store = await StateStore.create(process.env.DB_PATH);
  const result = store.applyScopedFlagValueChange({
    name: "node_dwell", scope: "flywheel", op: "set",
    rawTo: process.env.RAW_TO,
    expectedChangeSeq: store.getFlagValueChangeSeq("node_dwell", "flywheel"),
    actor: "fixture", reason: "resume node dwell patrol without restart",
  });
  store.close();
  if (!result.ok) throw new Error(JSON.stringify(result));'
DWELL_REENABLED_OUT="$DWELL/re-enabled.txt"
run_snapshot "$DWELL" "$DWELL_REENABLED_OUT" || fail "re-enabled dwell snapshot exits zero"
contains "$DWELL_REENABLED_OUT" "STEP DWELL: FINDING" "re-enabled dwell mechanism takes effect on the next tick"
contains "$DWELL_REENABLED_OUT" "NODE_DWELL issue=FLY-2210" "re-enabled dwell mechanism restores node rows"

DWELL_FLAG_FAILURE="$TMP/dwell-flag-failure"
make_case "$DWELL_FLAG_FAILURE"
sqlite3 "$DWELL_FLAG_FAILURE/teamlead.db" "DROP TABLE flag_values;"
DWELL_FLAG_FAILURE_OUT="$DWELL_FLAG_FAILURE/out.txt"
run_snapshot "$DWELL_FLAG_FAILURE" "$DWELL_FLAG_FAILURE_OUT" || fail "unreadable dwell flag snapshot exits zero"
contains "$DWELL_FLAG_FAILURE_OUT" "STEP DWELL: UNAVAILABLE(structural: maintenance_schema_mismatch)" "unreadable dwell flag is fail-visible"
contains "$DWELL_FLAG_FAILURE_OUT" "UNAVAILABLE_CAUSE step=DWELL class=structural token=maintenance_schema_mismatch" "unreadable dwell flag preserves its stable cause"
count_is "$DWELL_FLAG_FAILURE_OUT" "NODE_DWELL " 0 "unreadable dwell flag never masquerades as enabled output"

DWELL_RECEIPT_OUT="$DWELL/receipt.txt"
if printf '%s\n' '{"items":[{"runId":"run-dwell","nodeId":"implement","attempt":1}]}' | \
  HOME="$DWELL/home" PATH="$DWELL/bin:$PATH" \
  FLYWHEEL_STATE_DIR="$DWELL/state" \
  FLYWHEEL_STATE_DB_PATH="$DWELL/teamlead.db" \
  FLYWHEEL_PROJECTS_FILE="$DWELL/state/projects.json" \
  FLYWHEEL_COMM_DB="$DWELL/comm/flywheel/comm.db" \
  FLYWHEEL_LEAD_ID="flywheel-eng-lead" \
  bash "$SCRIPT" --project flywheel --lead flywheel-eng-lead \
    --record-dwell-receipts normal --note "deep dive completed" \
    > "$DWELL_RECEIPT_OUT" 2>&1; then
  pass "explicit dwell receipt batch exits zero"
else
  fail "explicit dwell receipt batch exits zero"
fi
contains "$DWELL_RECEIPT_OUT" "RECEIPT_BATCH_OK issue=FLY-2210 written=1" "receipt frontend reports the committed batch"

DWELL_RESET_OUT="$DWELL/reset.txt"
run_snapshot "$DWELL" "$DWELL_RESET_OUT" || fail "receipt-reset snapshot exits zero"
contains "$DWELL_RESET_OUT" "STEP DWELL: OK" "new receipt resets the dwell baseline"
contains "$DWELL_RESET_OUT" "over_threshold=no route=none" "same-round node is no longer overdue"
not_contains "$DWELL_RESET_OUT" "route=deep_dive" "same-round receipt suppresses duplicate deep dive"

sqlite3 "$DWELL/teamlead.db" \
  "UPDATE node_dwell_review SET examined_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 hours') WHERE run_id='run-dwell';"
DWELL_REAGED_OUT="$DWELL/reaged.txt"
run_snapshot "$DWELL" "$DWELL_REAGED_OUT" || fail "re-aged receipt snapshot exits zero"
contains "$DWELL_REAGED_OUT" "STEP DWELL: FINDING" "node reports again after another threshold window"
contains "$DWELL_REAGED_OUT" "over_threshold=yes route=deep_dive" "re-aged receipt restores deep-dive route"

FOUNDER_DWELL="$TMP/founder-dwell"
make_case "$FOUNDER_DWELL"
sqlite3 "$FOUNDER_DWELL/teamlead.db" <<'SQL'
INSERT INTO workflow_run(run_id,issue_id,project_name,status,created_at) VALUES
 ('run-founder','FLY-2210','flywheel','active',datetime('now','-11 hours'));
INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at) VALUES
 ('run-founder','founder_gate',1,'review','exec-founder-direct',datetime('now','-11 hours')),
 ('run-founder','implement',1,'running','exec-founder-approve',datetime('now','-11 hours'));
INSERT INTO sessions(execution_id,issue_id,issue_identifier,issue_title,project_name,status) VALUES
 ('exec-founder-direct','FLY-2210','FLY-2210','founder direct','flywheel','running'),
 ('exec-founder-approve','FLY-2210','FLY-2210','founder approve','flywheel','running');
INSERT INTO workflow_gate_holder(
 run_id,gate_node_id,attempt,head_sha,source_execution_id,question_id,
 state,materialization_stage,created_at,updated_at
) VALUES (
 'run-founder','founder_gate',1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
 'exec-founder-approve','q-approve-dwell','awaiting_review','completed',
 datetime('now','-11 hours'),datetime('now','-11 hours')
);
SQL
sqlite3 "$FOUNDER_DWELL/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,started_at,status) VALUES
 ('exec-founder-direct','runner-flywheel:pending','flywheel','FLY-2210','flywheel-eng-lead',datetime('now','-4 hours'),'running'),
 ('exec-founder-approve','runner-flywheel:pending','flywheel','FLY-2210','flywheel-eng-lead',datetime('now','-4 hours'),'running');
SQL
COMM_DB_PATH="$FOUNDER_DWELL/comm/flywheel/comm.db" node --input-type=module -e \
  'import { CommDB } from "./packages/flywheel-comm/dist/lib.js"; const db = new CommDB(process.env.COMM_DB_PATH); db.insertQuestion("exec-founder-approve","flywheel-eng-lead","approve",{id:"q-approve-dwell",checkpoint:"approve_to_ship"}); db.close();'
FOUNDER_DWELL_OUT="$FOUNDER_DWELL/out.txt"
run_snapshot "$FOUNDER_DWELL" "$FOUNDER_DWELL_OUT" || fail "founder-wait dwell snapshot exits zero"
contains "$FOUNDER_DWELL_OUT" "node=founder_gate attempt=1 state=review" "founder_gate review is included"
contains "$FOUNDER_DWELL_OUT" "run=run-founder node=implement" "unanswered approve-to-ship holder is included"
count_is "$FOUNDER_DWELL_OUT" "over_threshold=yes route=founder_reminder" 2 "both founder-wait OR branches route to reminders"
not_contains "$FOUNDER_DWELL_OUT" "over_threshold=yes route=deep_dive" "founder-wait nodes never route to deep dive"
count_is "$FOUNDER_DWELL_OUT" "DWELL_ACTION step=DWELL issue=FLY-2210 route=founder_reminder action=REQUIRED result=UNSET" 1 "same-issue founder waits produce one reminder action"

MIXED_TIMESTAMP_DWELL="$TMP/mixed-timestamp-dwell"
make_case "$MIXED_TIMESTAMP_DWELL"
sqlite3 "$MIXED_TIMESTAMP_DWELL/teamlead.db" <<'SQL'
INSERT INTO workflow_run(run_id,issue_id,project_name,status,created_at)
VALUES ('run-mixed-time','FLY-9600','flywheel','active','2026-08-31T03:40:00.000Z');
INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at)
VALUES ('run-mixed-time','founder_gate',1,'review','exec-mixed-time','2026-08-31 04:01:25');
INSERT INTO sessions(execution_id,issue_id,issue_identifier,issue_title,project_name,status)
VALUES ('exec-mixed-time','FLY-9600','FLY-9600','mixed timestamp founder episode','flywheel','running');
INSERT INTO workflow_gate_holder(
 run_id,gate_node_id,attempt,head_sha,source_execution_id,question_id,
 state,materialization_stage,created_at,updated_at
) VALUES (
 'run-mixed-time','founder_gate',1,'cccccccccccccccccccccccccccccccccccccccc',
 'exec-mixed-time','q-mixed-time','awaiting_review','completed',
 '2026-08-31T03:51:25.000Z','2026-08-31T03:51:25.000Z'
);
INSERT INTO node_dwell_review(
 run_id,node_id,attempt,cycle_no,verdict,examined_at,examined_by,note
) VALUES (
 'run-mixed-time','founder_gate',1,1,'waiting_founder',
 '2026-08-31T03:56:25.000Z','flywheel-eng-lead','previous episode reminder delivered'
);
SQL
sqlite3 "$MIXED_TIMESTAMP_DWELL/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,started_at,status)
VALUES (
 'exec-mixed-time','runner-flywheel:pending','flywheel','FLY-9600',
 'flywheel-eng-lead','2026-08-31T03:40:00.000Z','running'
);
SQL
MIXED_TIMESTAMP_DWELL_OUT="$MIXED_TIMESTAMP_DWELL/out.txt"
run_snapshot "$MIXED_TIMESTAMP_DWELL" "$MIXED_TIMESTAMP_DWELL_OUT" || fail "mixed timestamp dwell snapshot exits zero"
contains "$MIXED_TIMESTAMP_DWELL_OUT" "baseline=2026-08-31T04:01:25.000Z" "same-date episode ordering chooses the chronologically latest node admission"
contains "$MIXED_TIMESTAMP_DWELL_OUT" "waiting_episode_reminded=no over_threshold=yes route=founder_reminder" "new admission rearms a mixed-format founder episode"
count_is "$MIXED_TIMESTAMP_DWELL_OUT" "DWELL_ACTION step=DWELL issue=FLY-9600 route=founder_reminder action=REQUIRED result=UNSET" 1 "mixed-format rearmed episode produces one founder reminder"

FOUNDER_RECEIPT_OUT="$FOUNDER_DWELL/receipt.txt"
if printf '%s\n' '{"items":[{"runId":"run-founder","nodeId":"founder_gate","attempt":1},{"runId":"run-founder","nodeId":"implement","attempt":1}]}' | \
  HOME="$FOUNDER_DWELL/home" PATH="$FOUNDER_DWELL/bin:$PATH" \
  FLYWHEEL_STATE_DIR="$FOUNDER_DWELL/state" \
  FLYWHEEL_STATE_DB_PATH="$FOUNDER_DWELL/teamlead.db" \
  FLYWHEEL_PROJECTS_FILE="$FOUNDER_DWELL/state/projects.json" \
  FLYWHEEL_COMM_DB="$FOUNDER_DWELL/comm/flywheel/comm.db" \
  FLYWHEEL_LEAD_ID="flywheel-eng-lead" \
  bash "$SCRIPT" --project flywheel --lead flywheel-eng-lead \
    --record-dwell-receipts waiting_founder --note "founder reminder delivered" \
    > "$FOUNDER_RECEIPT_OUT" 2>&1; then
  pass "founder reminder receipt batch exits zero"
else
  fail "founder reminder receipt batch exits zero"
fi
sqlite3 "$FOUNDER_DWELL/teamlead.db" \
  "UPDATE node_dwell_review SET examined_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 hours') WHERE run_id='run-founder';"
FOUNDER_SILENT_OUT="$FOUNDER_DWELL/silent.txt"
run_snapshot "$FOUNDER_DWELL" "$FOUNDER_SILENT_OUT" || fail "silent founder wait snapshot exits zero"
contains "$FOUNDER_SILENT_OUT" "STEP DWELL: OK" "silent founder wait stays non-actionable across two threshold windows"
count_is "$FOUNDER_SILENT_OUT" "waiting_episode_reminded=yes" 2 "durable receipts mark both nodes reminded in the current episode"
count_is "$FOUNDER_SILENT_OUT" "DWELL_ACTION step=DWELL issue=FLY-2210 route=founder_reminder" 0 "pure time never emits a second founder reminder"

FOUNDER_RESTART_OUT="$FOUNDER_DWELL/restart.txt"
run_snapshot "$FOUNDER_DWELL" "$FOUNDER_RESTART_OUT" || fail "restarted silent founder wait snapshot exits zero"
count_is "$FOUNDER_RESTART_OUT" "waiting_episode_reminded=yes" 2 "restart preserves the durable waiting episode"
count_is "$FOUNDER_RESTART_OUT" "DWELL_ACTION step=DWELL issue=FLY-2210 route=founder_reminder" 0 "restart does not re-notify the same waiting episode"

sqlite3 "$FOUNDER_DWELL/teamlead.db" <<'SQL'
INSERT INTO chat_threads(thread_id,channel_id,issue_id,lead_id,created_at)
VALUES ('1544067592115720253','1516209714097291335','FLY-2210','flywheel-eng-lead',datetime('now','-1 day'));
SQL
COMM_DB_PATH="$FOUNDER_DWELL/comm/flywheel/comm.db" node --input-type=module -e '
  import { CommDB } from "./packages/flywheel-comm/dist/lib.js";
  const db = new CommDB(process.env.COMM_DB_PATH);
  const ts = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  db.ingestDiscordChat({
    leadId: "flywheel-eng-lead", chatId: "1544067592115720253",
    originChannelId: "1516209714097291335", messageId: "1544190576554147963",
    authorId: "1138241636057481306", founderId: "1138241636057481306", authorName: "Founder",
    ts, msgKind: "guild", attachments: [], text: "following up",
  });
  db.close();'
FOUNDER_REARMED_OUT="$FOUNDER_DWELL/rearmed.txt"
run_snapshot "$FOUNDER_DWELL" "$FOUNDER_REARMED_OUT" || fail "founder-message rearmed snapshot exits zero"
count_is "$FOUNDER_REARMED_OUT" "over_threshold=yes route=founder_reminder" 2 "founder thread activity rearms both waiting nodes after a fresh threshold"
count_is "$FOUNDER_REARMED_OUT" "DWELL_ACTION step=DWELL issue=FLY-2210 route=founder_reminder action=REQUIRED result=UNSET" 1 "founder thread activity permits one new grouped reminder"

if printf '%s\n' '{"items":[{"runId":"run-founder","nodeId":"founder_gate","attempt":1},{"runId":"run-founder","nodeId":"implement","attempt":1}]}' | \
  HOME="$FOUNDER_DWELL/home" PATH="$FOUNDER_DWELL/bin:$PATH" \
  FLYWHEEL_STATE_DIR="$FOUNDER_DWELL/state" \
  FLYWHEEL_STATE_DB_PATH="$FOUNDER_DWELL/teamlead.db" \
  FLYWHEEL_PROJECTS_FILE="$FOUNDER_DWELL/state/projects.json" \
  FLYWHEEL_COMM_DB="$FOUNDER_DWELL/comm/flywheel/comm.db" \
  FLYWHEEL_LEAD_ID="flywheel-eng-lead" \
  bash "$SCRIPT" --project flywheel --lead flywheel-eng-lead \
    --record-dwell-receipts waiting_founder --note "second founder reminder delivered" \
    > "$FOUNDER_DWELL/second-receipt.txt" 2>&1; then
  pass "rearmed founder reminder receipt batch exits zero"
else
  fail "rearmed founder reminder receipt batch exits zero"
fi

sqlite3 "$FOUNDER_DWELL/teamlead.db" <<'SQL'
UPDATE node_dwell_review
SET examined_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 hours')
WHERE run_id='run-founder';
UPDATE workflow_gate_holder
SET state='superseded', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 hours')
WHERE run_id='run-founder' AND question_id='q-approve-dwell';
INSERT INTO workflow_gate_holder(
 run_id,gate_node_id,attempt,head_sha,source_execution_id,question_id,
 state,materialization_stage,created_at,updated_at
) VALUES (
 'run-founder','founder_gate',2,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
 'exec-founder-approve','q-approve-dwell-2','awaiting_review','completed',
 strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 hours'),
 strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 hours')
);
SQL
COMM_DB_PATH="$FOUNDER_DWELL/comm/flywheel/comm.db" node --input-type=module -e '
  import { CommDB } from "./packages/flywheel-comm/dist/lib.js";
  const db = new CommDB(process.env.COMM_DB_PATH);
  db.insertQuestion("exec-founder-approve", "flywheel-eng-lead", "approve new head", {
    id: "q-approve-dwell-2", checkpoint: "approve_to_ship",
  });
  db.close();'
FOUNDER_GATE_REARMED_OUT="$FOUNDER_DWELL/gate-rearmed.txt"
run_snapshot "$FOUNDER_DWELL" "$FOUNDER_GATE_REARMED_OUT" || fail "gate-state rearmed snapshot exits zero"
count_is "$FOUNDER_GATE_REARMED_OUT" "over_threshold=yes route=founder_reminder" 2 "persisted gate-state activity rearms the waiting episode"
count_is "$FOUNDER_GATE_REARMED_OUT" "DWELL_ACTION step=DWELL issue=FLY-2210 route=founder_reminder action=REQUIRED result=UNSET" 1 "gate-state activity permits one new grouped reminder"

sqlite3 "$FOUNDER_DWELL/teamlead.db" <<'SQL'
INSERT INTO workflow_run(run_id,issue_id,project_name,status,created_at)
VALUES ('run-founder-second','FLY-2211','flywheel','active',datetime('now','-4 hours'));
INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at)
VALUES ('run-founder-second','founder_gate',1,'review','exec-founder-second',datetime('now','-4 hours'));
INSERT INTO sessions(execution_id,issue_id,issue_identifier,issue_title,project_name,status)
VALUES ('exec-founder-second','FLY-2211','FLY-2211','founder second','flywheel','running');
SQL
sqlite3 "$FOUNDER_DWELL/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,started_at,status)
VALUES ('exec-founder-second','runner-flywheel:pending','flywheel','FLY-2211','flywheel-eng-lead',datetime('now','-4 hours'),'running');
SQL
FOUNDER_MULTI_OUT="$FOUNDER_DWELL/multi-out.txt"
run_snapshot "$FOUNDER_DWELL" "$FOUNDER_MULTI_OUT" || fail "multi-issue founder-wait snapshot exits zero"
count_is "$FOUNDER_MULTI_OUT" "route=founder_reminder action=REQUIRED result=UNSET" 2 "two waiting issues produce two reminder actions"
contains "$FOUNDER_MULTI_OUT" "DWELL_ACTION step=DWELL issue=FLY-2210 route=founder_reminder" "first waiting issue keeps its reminder action"
contains "$FOUNDER_MULTI_OUT" "DWELL_ACTION step=DWELL issue=FLY-2211 route=founder_reminder" "second waiting issue keeps its reminder action"

PRUNED_FOUNDER="$TMP/pruned-founder"
make_case "$PRUNED_FOUNDER"
sqlite3 "$PRUNED_FOUNDER/teamlead.db" <<'SQL'
WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM seq WHERE n < 9)
INSERT INTO workflow_run(run_id,issue_id,project_name,status,created_at)
SELECT 'run-pruned-' || n, 'FLY-' || (3000 + n), 'flywheel', 'active', datetime('now','-4 hours') FROM seq;
WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM seq WHERE n < 9)
INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at)
SELECT 'run-pruned-' || n, 'founder_gate', 1, 'review', NULL, datetime('now','-4 hours') FROM seq;
SQL
COMM_DB_PATH="$PRUNED_FOUNDER/comm/flywheel/comm.db" node --input-type=module -e '
  import { CommDB } from "./packages/flywheel-comm/dist/lib.js";
  const db = new CommDB(process.env.COMM_DB_PATH);
  for (let n = 1; n <= 9; n += 1) db.registerSession(`exec-pruned-${n}`, "runner-flywheel:pending", "flywheel", `FLY-${3000 + n}`, "flywheel-eng-lead");
  db.close();'
sqlite3 "$PRUNED_FOUNDER/comm/flywheel/comm.db" "DELETE FROM sessions WHERE execution_id LIKE 'exec-pruned-%';"
PRUNED_FOUNDER_OUT="$PRUNED_FOUNDER/out.txt"
run_snapshot "$PRUNED_FOUNDER" "$PRUNED_FOUNDER_OUT" || fail "pruned founder snapshot exits zero"
count_is "$PRUNED_FOUNDER_OUT" "over_threshold=yes route=founder_reminder" 9 "all nine pruned founder gates route to reminders"
not_contains "$PRUNED_FOUNDER_OUT" "NODE_DWELL_ATTRIBUTION_INCOMPLETE" "pruned founder gates retain durable owner attribution"

LEGACY_GATE="$TMP/legacy-gate"
make_case "$LEGACY_GATE"
sqlite3 "$LEGACY_GATE/teamlead.db" <<'SQL'
INSERT INTO workflow_run(run_id,issue_id,project_name,status,created_at)
VALUES ('run-legacy-gate','FLY-2210','flywheel','active',datetime('now','-4 hours'));
INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at)
VALUES ('run-legacy-gate','implement',1,'running','exec-legacy-gate',datetime('now','-4 hours'));
INSERT INTO sessions(execution_id,issue_id,issue_identifier,issue_title,project_name,status)
VALUES ('exec-legacy-gate','FLY-2210','FLY-2210','legacy gate','flywheel','running');
SQL
sqlite3 "$LEGACY_GATE/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,started_at,status)
VALUES ('exec-legacy-gate','runner-flywheel:pending','flywheel','FLY-2210','flywheel-eng-lead',datetime('now','-4 hours'),'running');
SQL
COMM_DB_PATH="$LEGACY_GATE/comm/flywheel/comm.db" node --input-type=module -e \
  'import { CommDB } from "./packages/flywheel-comm/dist/lib.js"; const db = new CommDB(process.env.COMM_DB_PATH); db.insertQuestion("exec-legacy-gate","flywheel-eng-lead","legacy approve",{id:"q-legacy-approve",checkpoint:"approve_to_ship"}); db.close();'
LEGACY_GATE_OUT="$LEGACY_GATE/out.txt"
run_snapshot "$LEGACY_GATE" "$LEGACY_GATE_OUT" || fail "legacy approve gate snapshot exits zero"
contains "$LEGACY_GATE_OUT" "over_threshold=yes route=founder_reminder" "pre-holder approve gate uses unique historical mapping"
not_contains "$LEGACY_GATE_OUT" "over_threshold=yes route=deep_dive" "pre-holder approve gate never guesses deep dive"

AMBIGUOUS_GATE="$TMP/ambiguous-gate"
make_case "$AMBIGUOUS_GATE"
sqlite3 "$AMBIGUOUS_GATE/teamlead.db" <<'SQL'
INSERT INTO workflow_run(run_id,issue_id,project_name,status,created_at)
VALUES
 ('run-ambiguous-gate','FLY-2210','flywheel','active',datetime('now','-4 hours')),
 ('run-unrelated-deep-dive','FLY-2211','flywheel','active',datetime('now','-4 hours'));
INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at)
VALUES
 ('run-ambiguous-gate','implement',1,'running','exec-unmapped-founder-gate',datetime('now','-4 hours')),
 ('run-unrelated-deep-dive','implement',1,'running','exec-unrelated-deep-dive',datetime('now','-4 hours'));
INSERT INTO sessions(execution_id,issue_id,issue_identifier,issue_title,project_name,status)
VALUES
 ('exec-ambiguous-gate','FLY-2210','FLY-2210','ambiguous gate','flywheel','running'),
 ('exec-unrelated-deep-dive','FLY-2211','FLY-2211','unrelated deep dive','flywheel','running');
SQL
sqlite3 "$AMBIGUOUS_GATE/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,started_at,status)
VALUES
 ('exec-ambiguous-gate','runner-flywheel:pending','flywheel','FLY-2210','flywheel-eng-lead',datetime('now','-4 hours'),'running'),
 ('exec-unrelated-deep-dive','runner-flywheel:pending','flywheel','FLY-2211','flywheel-eng-lead',datetime('now','-4 hours'),'running');
SQL
COMM_DB_PATH="$AMBIGUOUS_GATE/comm/flywheel/comm.db" node --input-type=module -e \
  'import { CommDB } from "./packages/flywheel-comm/dist/lib.js"; const db = new CommDB(process.env.COMM_DB_PATH); db.insertQuestion("exec-unmapped-founder-gate","flywheel-eng-lead","ambiguous approve",{id:"q-ambiguous-approve",checkpoint:"approve_to_ship"}); db.close();'
AMBIGUOUS_GATE_OUT="$AMBIGUOUS_GATE/out.txt"
run_snapshot "$AMBIGUOUS_GATE" "$AMBIGUOUS_GATE_OUT" || fail "ambiguous approve gate snapshot exits zero"
contains "$AMBIGUOUS_GATE_OUT" "STEP DWELL: FINDING" "overdue node remains a finding when gate mapping is incomplete"
contains "$AMBIGUOUS_GATE_OUT" "NODE_DWELL_GATE_MAPPING_INCOMPLETE count=1" "incomplete historical gate mapping is explicit"
contains "$AMBIGUOUS_GATE_OUT" "over_threshold=yes route=unavailable_gate_mapping" "incomplete mapping fails closed"
contains "$AMBIGUOUS_GATE_OUT" "issue=FLY-2211 run=run-unrelated-deep-dive node=implement" "unrelated overdue node remains visible"
contains "$AMBIGUOUS_GATE_OUT" "issue=FLY-2211 run=run-unrelated-deep-dive node=implement attempt=1 state=running" "unrelated overdue node keeps exact identity"
contains "$AMBIGUOUS_GATE_OUT" "issue=FLY-2211 run=run-unrelated-deep-dive node=implement attempt=1 state=running baseline=" "unrelated overdue node has a dwell baseline"
contains "$AMBIGUOUS_GATE_OUT" "over_threshold=yes route=deep_dive" "unmapped historical gate does not suppress an unrelated deep dive"
count_is "$AMBIGUOUS_GATE_OUT" "DWELL_ACTION step=DWELL issue=aggregate route=repair_gate_mapping action=REQUIRED result=UNSET" 1 "incomplete mapping has one accountability action"

DWELL_TRUNCATED="$TMP/dwell-truncated"
make_case "$DWELL_TRUNCATED"
sqlite3 "$DWELL_TRUNCATED/teamlead.db" <<'SQL'
INSERT INTO workflow_run(run_id,issue_id,project_name,status,created_at) VALUES
 ('run-many','FLY-2300','flywheel','active',datetime('now','-1 hour')),
 ('run-ownerless','FLY-2301','flywheel','active',datetime('now','-1 hour'));
WITH RECURSIVE nodes(n) AS (
 SELECT 1 UNION ALL SELECT n + 1 FROM nodes WHERE n < 501
)
INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at)
SELECT 'run-many',printf('node-%03d',n),1,'running','exec-many',datetime('now','-1 hour')
FROM nodes;
INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id,started_at)
VALUES ('run-ownerless','implement',1,'running','exec-ownerless',datetime('now','-1 hour'));
SQL
sqlite3 "$DWELL_TRUNCATED/comm/flywheel/comm.db" <<'SQL'
INSERT INTO sessions(execution_id,tmux_window,project_name,issue_id,lead_id,started_at,status)
VALUES ('exec-many','runner-flywheel:pending','flywheel','FLY-2300','flywheel-eng-lead',datetime('now','-1 hour'),'running');
SQL
DWELL_TRUNCATED_OUT="$DWELL_TRUNCATED/out.txt"
run_snapshot "$DWELL_TRUNCATED" "$DWELL_TRUNCATED_OUT" || fail "bounded dwell snapshot exits zero"
count_is "$DWELL_TRUNCATED_OUT" "NODE_DWELL issue=FLY-2300" 500 "bounded dwell output keeps the first 500 owned rows"
contains "$DWELL_TRUNCATED_OUT" "NODE_DWELL_TRUNCATED count=1" "bounded dwell output reports omitted owned rows"
contains "$DWELL_TRUNCATED_OUT" "NODE_DWELL_ATTRIBUTION_INCOMPLETE reason=owner_missing count=1" "bounded dwell output never truncates degradation aggregates"
contains "$DWELL_TRUNCATED_OUT" "STEP DWELL: UNAVAILABLE(structural: node_dwell_incomplete)" "dwell truncation stays fail-visible"
contains "$DWELL_TRUNCATED_OUT" "DWELL_ACTION step=DWELL issue=aggregate route=repair_output_truncation action=REQUIRED result=UNSET" "dwell truncation has an accountability action"

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
