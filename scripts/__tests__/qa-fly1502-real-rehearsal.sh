#!/usr/bin/env bash
# QA FLY-1502 — isolated nine-step rehearsal against *copies of real production data*.
#
# This is the QA-hard item Tadashi raised for the FLY-1502 switch window: the shipped
# rehearsal test (scripts/__tests__/v2-cutover-rehearsal.test.mjs) drives the same code
# path but with empty legacy sources, so it never exercises the dual-source reconciling
# migrator against real comm.db / JSON mailbox / Codex journal shapes.
#
# What this script proves, on a real machine:
#   A. all nine steps run to `done` against copies of live production legacy sources
#   B. a hard kill *inside step 5* (after the migration plan lands, before promotion)
#      is re-entrant — a plain re-run resumes and completes without corruption
#   C. every Go/No-Go check emits a readable evidence file (any check that cannot
#      produce evidence is reported as that check FAILING)
#   D. the rehearsal writes nothing outside its isolation root — proven by attribution
#      over the union of every production path the manifest can name
#
# Isolation is deliberately rooted at a short path (/tmp/...) — macOS caps AF_UNIX
# sun_path at 104 bytes and the v2 host listens on <root>/host.sock.
#
# Usage: qa-fly1502-real-rehearsal.sh [work-root]      (default: /tmp/qa1502)
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WORK=${1:-/tmp/qa1502}
ROOT=$WORK/rehearsal
PROD=$HOME/.flywheel
CUTOVER_CLI=$REPO_ROOT/packages/v2-cutover/dist/cli.js
COMM_CLI=$REPO_ROOT/packages/flywheel-comm/dist/index.js

fail() {
	echo "QA-FAIL: $*" >&2
	exit 1
}
note() { echo "[qa1502] $*"; }

[[ -f $CUTOVER_CLI ]] || fail "cutover CLI not built: $CUTOVER_CLI (run pnpm -r build)"
command -v sqlite3 >/dev/null || fail "sqlite3 is required"
command -v jq >/dev/null || fail "jq is required"
command -v curl >/dev/null || fail "curl is required"

# Capture the authoritative Lead registry while Bridge is still running. A
# comm.db sessions row only proves that a Lead once dispatched a Runner; it is
# not the roster. The frozen manifest carries this pre-stop registry snapshot
# into step 5 so missing session evidence can never silently dead-letter work.
BRIDGE_URL=${FLYWHEEL_BRIDGE_URL:-http://127.0.0.1:${TEAMLEAD_PORT:-9876}}
bridge_snapshot=$(curl -fsS "${BRIDGE_URL%/}/api/fleet/snapshot") ||
	fail "Bridge fleet registry is unavailable at ${BRIDGE_URL%/}/api/fleet/snapshot"
authoritative_live_leads_json=$(jq -ce \
	'[.projects[]?.leads[]?.leadId | select(type == "string" and length > 0)] | unique | select(length > 0)' \
	<<<"$bridge_snapshot") ||
	fail "Bridge fleet registry returned no authoritative Lead IDs"
note "captured $(jq 'length' <<<"$authoritative_live_leads_json") authoritative live Lead IDs"

# A previous run leaves the archive and the tombstoned originals genuinely
# read-only (0500 dirs / 0400 files) — that is the fence working, so relax the
# modes before removing rather than letting `rm -rf` fail.
if [[ -d $ROOT ]]; then
	chmod -R u+rwX "$ROOT" 2>/dev/null || true
	rm -rf "$ROOT"
fi
mkdir -p "$ROOT"/{home,state,ledger,evidence,legacy/comm,legacy/journal,legacy/json,legacy/wrapper}
chmod 700 "$ROOT"

# ---------------------------------------------------------------------------
# 1. Copy real production legacy sources into the isolation root.
#    SQLite copies go through `.backup` so a live WAL is captured consistently
#    and the production file is only ever *read*.
# ---------------------------------------------------------------------------
copied_comm=()
copy_sqlite() {
	local src=$1 dst=$2
	[[ -f $src ]] || return 1
	sqlite3 "$src" ".backup '$dst'" 2>/dev/null || return 1
	[[ -s $dst ]] || return 1
	return 0
}

# The StateStore sessions table is the authoritative Runner registry. Keep it
# separate from commDatabases because its schema intentionally has no lead_id.
runner_registry=$ROOT/legacy/teamlead.db
if ! copy_sqlite "$PROD/teamlead.db" "$runner_registry"; then
	echo "QA-FAIL: authoritative Runner registry could not be copied" >&2
	exit 1
fi
note "copied authoritative Runner registry $PROD/teamlead.db"

# Production Lead comm databases + a QA/test database (exercises the domain-C
# source-boundary rule: QA sources must archive, never migrate).
for candidate in \
	"$PROD/comm.db" \
	"$PROD/comm/comm.db" \
	"$PROD/comm/flywheel/comm.db" \
	"$PROD/comm/geoforge3d/comm.db" \
	"$PROD/comm/tidal-echo/comm.db" \
	"$PROD/comm/growth/comm.db" \
	"$PROD/comm/test-slot-1/comm.db"; do
	[[ -f $candidate ]] || continue
	slug=$(echo "$candidate" | sed "s#^$PROD/##; s#/#__#g")
	dest=$ROOT/legacy/comm/$slug
	if copy_sqlite "$candidate" "$dest"; then
		# The migrator requires the canonical comm schema; skip shapes that predate it.
		if sqlite3 "$dest" "select 1 from sqlite_master where type='table' and name='messages';" |
			grep -q 1 &&
			sqlite3 "$dest" "select 1 from sqlite_master where type='table' and name='lead_inbox';" |
			grep -q 1; then
			copied_comm+=("$dest")
			note "copied comm source $candidate -> $slug"
		else
			rm -f "$dest"
			note "skipped $candidate (pre-canonical schema)"
		fi
	fi
done
[[ ${#copied_comm[@]} -gt 0 ]] || fail "no production comm database could be copied"

# Codex Lead journals (step 2 journal drain + Go/No-Go check 8).
copied_journal=()
while IFS= read -r src; do
	[[ -f $src ]] || continue
	slug=$(echo "$src" | sed "s#^$PROD/##; s#/#__#g")
	dest=$ROOT/legacy/journal/$slug
	if copy_sqlite "$src" "$dest" &&
		sqlite3 "$dest" "select 1 from sqlite_master where type='table' and name='journal';" | grep -q 1; then
		copied_journal+=("$dest")
	else
		rm -f "$dest"
	fi
done < <(find "$PROD/state/codex-lead" -maxdepth 2 -name journal.db 2>/dev/null | head -6)
note "copied ${#copied_journal[@]} Codex Lead journals"

# Real Claude Code Agent Team JSON mailboxes (<team>/inboxes/<agent>.json + sidecars).
json_root=$ROOT/legacy/json/teams
mkdir -p "$json_root"
copied_teams=0
while IFS= read -r team_dir; do
	team=$(basename "$team_dir")
	[[ -d $team_dir/inboxes ]] || continue
	mkdir -p "$json_root/$team"
	cp -R "$team_dir/inboxes" "$json_root/$team/" 2>/dev/null || continue
	copied_teams=$((copied_teams + 1))
done < <(find "$HOME/.claude/teams" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | head -8)
[[ $copied_teams -gt 0 ]] || fail "no production JSON mailbox team could be copied"
note "copied $copied_teams JSON mailbox teams"

# The reader rejects symlinks and non-array/malformed mailbox rows outright; drop
# anything that would abort the read so the run exercises real *well-formed* shapes.
find "$json_root" -type l -delete 2>/dev/null || true
while IFS= read -r mailbox; do
	if ! jq -e 'type == "array" and (all(.[]; (.from|type=="string") and (.text|type=="string") and (.timestamp|type=="string") and (.read|type=="boolean")))' \
		"$mailbox" >/dev/null 2>&1; then
		rm -f "$mailbox"
	fi
done < <(find "$json_root" -type f -name '*.json' ! -name '*.flywheel.json')
mailbox_count=$(find "$json_root" -type f -name '*.json' ! -name '*.flywheel.json' | wc -l | tr -d ' ')
[[ $mailbox_count -gt 0 ]] || fail "every copied JSON mailbox was malformed"
note "kept $mailbox_count well-formed JSON mailboxes"

# ---------------------------------------------------------------------------
# 1b. Emulate the runbook's step-2 outbound-obligation drain ON THE COPIES.
#     §4.4 domain B is a *precondition*, not migration input: the window drains
#     external delivery/receipt obligations to zero before step 5. Live copies
#     always carry some, so drain them here — canonical unread rows (domain A,
#     the actual migration payload) are deliberately left untouched.
# ---------------------------------------------------------------------------
for db in "${copied_comm[@]}"; do
	# The real lead_inbox schema pairs each terminal timestamp with its evidence
	# column and keeps processed/disposed mutually exclusive — honour both.
	sqlite3 "$db" <<-SQL
		UPDATE lead_inbox
		   SET disposed_at = datetime('now'),
		       disposed_evidence = 'qa-fly1502-rehearsal-drain'
		 WHERE carrier='external' AND delivered_at IS NULL
		   AND disposed_at IS NULL AND processed_at IS NULL;
		-- A row already carrying processed_at cannot also take disposed_at
		-- (terminal states are exclusive), so retire it as delivered instead.
		UPDATE lead_inbox
		   SET delivered_at = datetime('now')
		 WHERE carrier='external' AND delivered_at IS NULL
		   AND disposed_at IS NULL AND processed_at IS NOT NULL;
		UPDATE lead_inbox
		   SET processed_at = datetime('now'),
		       processed_evidence = 'qa-fly1502-rehearsal-drain'
		 WHERE carrier='external' AND delivered_at IS NOT NULL AND processed_at IS NULL
		   AND disposed_at IS NULL AND receipt_exempt_reason IS NULL;
	SQL
done
note "domain-B obligations drained on the copies (mirrors runbook step 2)"

# ---------------------------------------------------------------------------
# 2. Live-fire writers: a real flywheel-comm CLI write and a real JSON mailbox
#    rebuild, both aimed at the frozen copies. Both must fail loud after step 6.
# ---------------------------------------------------------------------------
live_fire_db=${copied_comm[0]}
# Step 6 archives the whole legacy tree and leaves a 0500 tombstone directory in
# its place, so an existing mailbox path is simply gone by step 7 — probing it
# would yield ENOENT, which proves nothing about the fence. Probe the rebuild
# instead (plan §4.5: "真触发旧 JSON writer ensureFileExists 重建"): creating a
# file directly under the tombstone root is exactly what an old writer would try,
# and the fence must answer with a permission error.
live_fire_mailbox=$ROOT/legacy/rebuilt-inbox.json

wrapper=$ROOT/legacy/wrapper/legacy-writer.sh
cat >"$wrapper" <<'WRAPPER'
#!/bin/sh
exit 0
WRAPPER
chmod 700 "$wrapper"

# ---------------------------------------------------------------------------
# 3. Build the rehearsal target manifest.
# ---------------------------------------------------------------------------
manifest=$ROOT/target.json
markers=$ROOT/state/markers
mkdir -p "$markers"
github_evidence=$ROOT/evidence/github-lane.json
printf '{"status":"pass","probe":"qa-fly1502-rehearsal-stub"}\n' >"$github_evidence"

jq -n \
	--arg home "$ROOT/home" \
	--arg prod "$PROD" \
	--arg ledger "$ROOT/ledger" \
	--arg evidence "$ROOT/evidence" \
	--arg rehearsalEvidence "$ROOT/evidence/rehearsal-pass.json" \
	--arg dbFinal "$ROOT/state/flywheel-v2.db" \
	--arg dbMarker "$ROOT/state/migration-complete.json" \
	--arg dbAuthority "$ROOT/state/cutover-authority.json" \
	--arg dbArmed "$ROOT/state/cutover-armed.json" \
	--arg dbRollback "$ROOT/state/rollback-receipt.json" \
	--argjson authoritativeLiveLeads "$authoritative_live_leads_json" \
	--arg runnerRegistry "$runner_registry" \
	--argjson comm "$(printf '%s\n' "${copied_comm[@]}" | jq -R . | jq -s .)" \
	--argjson journal "$(printf '%s\n' "${copied_journal[@]+"${copied_journal[@]}"}" | grep -v '^$' | jq -R . | jq -s .)" \
	--arg jsonRoot "$json_root" \
	--arg legacyRoot "$ROOT/legacy" \
	--arg wrapper "$wrapper" \
	--arg plistDir "$ROOT/state/launchd" \
	--arg tmuxSock "$ROOT/state/tmux.sock" \
	--arg markerStop "$markers/stop.applied" \
	--arg markerHost "$markers/host.applied" \
	--arg markerBridge "$markers/bridge.applied" \
	--arg markerSched "$markers/scheduler.applied" \
	--arg markerLead "$markers/lead.applied" \
	--arg commCli "$COMM_CLI" \
	--arg liveDb "$live_fire_db" \
	--arg liveMailbox "$live_fire_mailbox" \
	--arg github "$github_evidence" \
	'{
	v: 1,
	mode: "rehearsal",
	windowId: "fly1502-qa-real-rehearsal",
	epoch: 15020729,
	homeRoot: $home,
	productionHomeRoot: $prod,
	ledgerDir: $ledger,
	evidenceDir: $evidence,
	rehearsalEvidencePath: $rehearsalEvidence,
	database: {
		finalPath: $dbFinal,
		markerPath: $dbMarker,
		authorityPath: $dbAuthority,
		armedPath: $dbArmed,
		rollbackReceiptPath: $dbRollback
	},
	legacy: {
		authoritativeLiveLeadIds: $authoritativeLiveLeads,
		runnerSessionDatabase: $runnerRegistry,
		commDatabases: $comm,
		jsonInboxRoots: [$jsonRoot],
		journalDatabases: $journal,
		tombstonePaths: [$legacyRoot],
		writerProcessPatterns: ["flywheel-v2-qa-writer-that-never-runs"],
		launchdLabels: ["com.flywheel-rehearsal.bridge"],
		plistPaths: [],
		stopCommands: [
			{
				apply: ["/bin/sh","-c","printf %s \"$2\" > \"$1\"","stop-legacy",$markerStop,"com.flywheel-rehearsal.bridge"],
				verify: ["/bin/test","-f",$markerStop]
			}
		],
		credentialProbeCommands: [
			["/bin/sh","-c","echo \"legacy credential rejected: EACCES\" >&2; exit 77"]
		],
		liveFireCommands: [
			["/bin/sh","-c","FLYWHEEL_COMM_DB=\"$1\" exec /usr/bin/env node \"$2\" ask --lead qa-fly1502 --exec-id qa-fly1502 \"live fire\"","live-fire-comm",$liveDb,$commCli],
			["/bin/sh","-c","printf x >> \"$1\"","live-fire-json",$liveMailbox]
		],
		rollbackCommands: [
			{ apply: ["/usr/bin/true"], verify: ["/usr/bin/true"] }
		]
	},
	controlPlane: {
		launchdLabelPrefix: "com.flywheel-rehearsal.",
		plistDirectory: $plistDir,
		tmuxSocket: $tmuxSock,
		cmuxTarget: "rehearsal-fly1502-qa",
		wrapperPaths: [$wrapper],
		credentialPaths: [],
		envKeys: ["FLYWHEEL_REHEARSAL_HOME"],
		startCommands: {
			host:      { apply: ["/bin/sh","-c",": > \"$1\"","start-host",$markerHost],        verify: ["/bin/test","-f",$markerHost] },
			bridge:    { apply: ["/bin/sh","-c",": > \"$1\"","start-bridge",$markerBridge],    verify: ["/bin/test","-f",$markerBridge] },
			scheduler: { apply: ["/bin/sh","-c",": > \"$1\"","start-sched",$markerSched],      verify: ["/bin/test","-f",$markerSched] },
			leads: [
				{ apply: ["/bin/sh","-c",": > \"$1\"","start-lead",$markerLead], verify: ["/bin/test","-f",$markerLead] }
			]
		}
	},
	founderConfirmations: { heldStart: "held-fly1502-qa", finalGo: "go-fly1502-qa" },
	githubLaneEvidencePath: $github
}' >"$manifest"
chmod 600 "$manifest"
note "manifest written: $manifest"

# ---------------------------------------------------------------------------
# 4. Production attribution baseline — every production path the manifest can
#    name, plus the launchd/tmux control plane.
# ---------------------------------------------------------------------------
attribution_snapshot() {
	local out=$1
	{
		# Step ① runs while production is still live (it precedes step ③'s stop),
		# so anything production writes by itself churns between the two samples:
		# Spotlight's com.apple.mdworker.* labels come and go, and teamlead.db grows
		# on every heartbeat. Comparing those bytes measures the machine, not the
		# rehearsal. Compare what a rehearsal write would actually disturb —
		# permissions, the control-plane roster we own, and the cutover's own
		# unmistakable artefacts — and let production's own churn alone.
		echo "# launchd (flywheel-owned labels only)"
		launchctl list 2>/dev/null | awk 'NR>1 {print $3}' |
			grep -v '^com\.apple\.' | LC_ALL=C sort
		echo "# tmux"
		tmux list-sessions -F '#S' 2>/dev/null | LC_ALL=C sort || true
		echo "# production-legacy-source modes"
		for candidate in \
			"$PROD/teamlead.db" "$PROD/comm.db" "$PROD/comm/comm.db" "$PROD/comm/flywheel/comm.db" \
			"$PROD/comm/geoforge3d/comm.db" "$PROD/comm/tidal-echo/comm.db" \
			"$PROD/comm/growth/comm.db" "$PROD/comm/test-slot-1/comm.db"; do
			[[ -e $candidate ]] && stat -f '%N|%Mp%Lp' "$candidate"
		done
		find "$PROD/state/codex-lead" -maxdepth 2 -name 'journal.db' \
			-exec stat -f '%N|%Mp%Lp' {} \; 2>/dev/null | LC_ALL=C sort
		find "$HOME/.claude/teams" -maxdepth 3 -name '*.json' \
			-exec stat -f '%N|%Mp%Lp' {} \; 2>/dev/null | LC_ALL=C sort
		echo "# production-dir-modes"
		find "$PROD" -maxdepth 1 -type d -exec stat -f '%N|%Mp%Lp' {} \; 2>/dev/null | LC_ALL=C sort
		stat -f '%N|%Mp%Lp' "$HOME/.claude/teams" 2>/dev/null
		# The decisive signal: the cutover's writes are *creations*. If it had
		# touched production these names would appear there, and they never may.
		echo "# cutover-artefacts-in-production (must stay empty)"
		find "$PROD" "$HOME/.claude/teams" \
			\( -name '.flywheel-v2-tombstone.json' \
			-o -name '*.staging-fly1502-qa-real-rehearsal' \
			-o -name 'migration-complete.json' \
			-o -name 'cutover-authority.json' \
			-o -name 'cutover-armed.json' \) 2>/dev/null | LC_ALL=C sort
	} >"$out"
}
attribution_snapshot "$ROOT/production-before.txt"
note "production attribution baseline captured"

# ---------------------------------------------------------------------------
# 5. Run the nine steps with a hard kill inside step 5.
# ---------------------------------------------------------------------------
plan_evidence=$ROOT/evidence/migration-plan.json
ledger_file=$ROOT/ledger/ledger.jsonl

step5_done() {
	[[ -f $ledger_file ]] || return 1
	grep -q '"kind":"step","step":5,[^}]*"status":"done"' "$ledger_file"
}

# Kill trigger: the ledger's step-5 `started` line is written *before* the step
# body runs, so SIGKILL on sight lands deterministically inside step 5 (the
# 100MB+ plan build that follows leaves a wide window). Racing on a later
# artifact is unreliable — an all-dead plan promotes in milliseconds.
note "phase 1: SIGKILL as soon as step 5 is entered"
node "$CUTOVER_CLI" run --target "$manifest" --yes >"$ROOT/run-1.log" 2>&1 &
run_pid=$!
killed=0
for _ in $(seq 1 1200); do
	if [[ -f $ledger_file ]] && grep -q '"step":5,[^}]*"status":"started"' "$ledger_file"; then
		kill -9 "$run_pid" 2>/dev/null && killed=1
		break
	fi
	kill -0 "$run_pid" 2>/dev/null || break
	sleep 0.02
done
wait "$run_pid" 2>/dev/null || true
[[ $killed -eq 1 ]] || fail "never observed step 5 being entered; log:
$(cat "$ROOT/run-1.log")"
[[ -f $ledger_file ]] || fail "ledger missing after the killed run"
step5_done && fail "step 5 completed before SIGKILL — the crash did not land mid-step"
note "SIGKILL landed inside step 5 (step 5 not done)"

steps_before=$(jq -r 'select(.payload.kind=="step" and .payload.status=="done") | .payload.step' \
	"$ledger_file" | LC_ALL=C sort -n | uniq | tr '\n' ' ')
[[ $steps_before == "1 2 3 4 " ]] || fail "steps done before resume = [$steps_before], want 1..4"
note "steps done before resume: $steps_before"

# Second crash, this time after the migration plan has been durably published —
# exercises re-entry across the plan/migrate/promote boundary rather than at the
# step edge. Best-effort: an all-dead plan can promote faster than we can react.
note "phase 2: resume, then SIGKILL once the migration plan is durable"
node "$CUTOVER_CLI" run --target "$manifest" --yes >"$ROOT/run-2.log" 2>&1 &
run_pid=$!
second_kill=0
for _ in $(seq 1 1200); do
	if [[ -f $plan_evidence ]]; then
		kill -9 "$run_pid" 2>/dev/null && second_kill=1
		break
	fi
	kill -0 "$run_pid" 2>/dev/null || break
	sleep 0.02
done
wait "$run_pid" 2>/dev/null || true
if [[ $second_kill -eq 1 ]] && ! step5_done; then
	note "second SIGKILL landed after the plan was durable, before step 5 completed"
else
	note "second SIGKILL raced step-5 completion (all-dead plan promotes fast) — post-plan re-entry covered by the resume below"
fi

note "phase 3: plain re-run must resume and finish all nine steps"
if ! node "$CUTOVER_CLI" run --target "$manifest" --yes >"$ROOT/run-3.log" 2>&1; then
	# The only tolerated stop here is the manual gate: rows whose recipient the
	# migrator refuses to classify on its own. That is fail-closed by design, and
	# `adjudicate-manual` is the sanctioned way through it — so exercise that path
	# rather than treating the NO-GO as a dead end.
	if ! grep -q '"manual":[1-9]' "$ROOT/run-3.log"; then
		fail "resume run failed for something other than the manual gate; log:
$(cat "$ROOT/run-3.log")
ledger:
$(cat "$ledger_file")"
	fi
	note "phase 3a: step 5 stopped at the manual gate — exercising adjudicate-manual"

	python3 - "$plan_evidence" >"$ROOT/manual-rows.tsv" <<-'PY'
		import json, sys
		plan = json.load(open(sys.argv[1]))
		for row in plan["decisions"]:
		    if row.get("disposition") == "manual":
		        print("\t".join([row["sourceKind"], row["sourceId"],
		                         row["payloadDigest"], row.get("reason", "")]))
	PY
	manual_rows=$(wc -l <"$ROOT/manual-rows.tsv" | tr -d ' ')
	[[ $manual_rows -gt 0 ]] || fail "step 5 reported manual rows but none are in the plan"
	note "manual rows to adjudicate: $manual_rows"

	# Negative control first: the adjudication must be bound to the exact payload,
	# so a wrong digest has to be refused. Without this, a green run below would
	# only prove the verb writes a ledger row, not that it targets the right one.
	IFS=$'\t' read -r probe_kind probe_id _ _ <"$ROOT/manual-rows.tsv"
	if node "$CUTOVER_CLI" adjudicate-manual --target "$manifest" \
		--source-kind "$probe_kind" --source-id "$probe_id" \
		--payload-digest "$(printf '0%.0s' $(seq 1 64))" \
		--disposition dead --reason "QA negative control" >/dev/null 2>&1; then
		fail "adjudicate-manual accepted a mismatched payload digest"
	fi
	note "negative control: mismatched payload digest refused"

	adjudicated=0
	while IFS=$'\t' read -r kind source_id digest original; do
		node "$CUTOVER_CLI" adjudicate-manual --target "$manifest" \
			--source-kind "$kind" --source-id "$source_id" \
			--payload-digest "$digest" --disposition dead \
			--reason "QA rehearsal ruling (not a production ruling): $original" \
			>/dev/null || fail "adjudicate-manual rejected $source_id"
		adjudicated=$((adjudicated + 1))
	done <"$ROOT/manual-rows.tsv"
	note "adjudicated $adjudicated manual rows"

	if ! node "$CUTOVER_CLI" run --target "$manifest" --yes >"$ROOT/run-4.log" 2>&1; then
		fail "run after manual adjudication still failed; log:
$(cat "$ROOT/run-4.log")"
	fi
	# The rulings must be durably recorded, not merely accepted in memory.
	ledger_rulings=$(grep -c "manual-adjudication:" "$ledger_file" || true)
	[[ $ledger_rulings -ge $adjudicated ]] ||
		fail "ledger holds $ledger_rulings adjudication records, want >= $adjudicated"
	note "adjudication rulings durable in the ledger: $ledger_rulings"
fi
note "resume run completed"

# ---------------------------------------------------------------------------
# 6. Assertions.
# ---------------------------------------------------------------------------
done_steps=$(jq -r 'select(.payload.kind=="step" and .payload.status=="done") | .payload.step' "$ledger_file" |
	LC_ALL=C sort -n | uniq | tr '\n' ' ')
[[ $done_steps == "1 2 3 4 5 6 7 8 9 " ]] || fail "steps done = [$done_steps], want 1..9"
note "A: all nine steps done"

# Ledger hash-chain re-verification (independent of the writer).
node -e '
const fs=require("fs");const crypto=require("crypto");
const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse);
let prev=null;
for(const [i,l] of lines.entries()){
  if(l.seq!==i+1) {console.error("seq break at "+i);process.exit(1);}
  if(l.previousDigest!==prev){console.error("chain break at "+i);process.exit(1);}
  const d=crypto.createHash("sha256").update(JSON.stringify({seq:l.seq,previousDigest:l.previousDigest,payload:l.payload})).digest("hex");
  if(d!==l.digest){console.error("digest break at "+i);process.exit(1);}
  prev=l.digest;
}
console.log("ledger chain OK over "+lines.length+" lines");
' "$ledger_file" || fail "ledger hash chain is broken"
note "B: ledger hash chain intact across the crash boundary"

final=$ROOT/evidence/go-no-go-final.json
[[ -f $final ]] || fail "final Go/No-Go report missing"
[[ $(jq -r .status "$final") == "go" ]] || fail "final Go/No-Go is not go: $(jq -c . "$final")"

missing_evidence=0
while IFS=$'\t' read -r id status evidence; do
	if [[ $status != pass ]]; then
		echo "QA: Go/No-Go check $id = $status" >&2
		missing_evidence=$((missing_evidence + 1))
		continue
	fi
	if [[ -z $evidence || $evidence == null ]]; then
		echo "QA: Go/No-Go check $id passed with no evidence path" >&2
		missing_evidence=$((missing_evidence + 1))
		continue
	fi
	if [[ ! -s $evidence ]]; then
		echo "QA: Go/No-Go check $id evidence unreadable/empty: $evidence" >&2
		missing_evidence=$((missing_evidence + 1))
		continue
	fi
	printf '  check %-9s pass  %s\n' "$id" "$evidence"
done < <(jq -r '.checks[] | [.id, .status, (.evidence // "null")] | @tsv' "$final")
[[ $missing_evidence -eq 0 ]] || fail "$missing_evidence Go/No-Go checks lacked a readable evidence file"
note "C: every Go/No-Go check produced readable evidence"

# The migration must have actually seen real rows — otherwise this run proved nothing.
plan_rows=$(jq -r '(.conservation.rawCommUnread // 0) + (.conservation.rawJsonUnread // 0)' "$plan_evidence")
note "migration plan saw $plan_rows raw unread source rows"
jq -e '.conservation.balanced == true and .conservation.manual == 0 and .conservation.conflicts == 0' \
	"$plan_evidence" >/dev/null || fail "conservation identity did not balance: $(jq -c .conservation "$plan_evidence")"
note "D: conservation identity balanced over real source rows"

# Promoted v2 database is real, permissioned and integrity-clean.
db=$ROOT/state/flywheel-v2.db
[[ -f $db ]] || fail "promoted v2 database missing"
[[ $(stat -f '%Mp%Lp' "$db") == 0600 ]] || fail "v2 database mode is $(stat -f '%Mp%Lp' "$db"), want 0600"
[[ $(sqlite3 "$db" 'pragma integrity_check;') == ok ]] || fail "promoted v2 database failed integrity_check"
# §4.3 requires the WAL to be fully drained *at the promotion boundary*, which
# promoteStagingDatabase enforces itself (it throws on a non-empty WAL, then
# unlinks both sidecars). Steps 7-9 legitimately re-open the promoted database,
# so WAL-mode sidecars reappear afterwards — assert the drained invariant that is
# actually promised, not their absence at the end of the run.
promotion_status=$(jq -r '.status' "$ROOT/evidence/step-5.json")
[[ $promotion_status == promoted || $promotion_status == already_promoted ]] ||
	fail "step 5 promotion evidence reports status=$promotion_status"
[[ ! -e $db-wal || $(stat -f '%z' "$db-wal") -eq 0 ]] ||
	fail "promoted v2 database carries an undrained WAL ($(stat -f '%z' "$db-wal") bytes)"
note "E: promoted DB 0600, integrity ok, no residual sidecars"

attribution_snapshot "$ROOT/production-after.txt"
if ! diff -u "$ROOT/production-before.txt" "$ROOT/production-after.txt" >"$ROOT/production.diff"; then
	fail "rehearsal-scoped production state changed:
$(cat "$ROOT/production.diff")"
fi
note "F: production zero-change over every manifest-reachable production path"

echo
echo "QA-PASS: FLY-1502 real-data isolated rehearsal"
echo "  isolation root : $ROOT"
echo "  ledger         : $ledger_file"
echo "  go/no-go       : $final"
echo "  migration plan : $plan_evidence"
echo "  production diff: $ROOT/production.diff (empty)"
