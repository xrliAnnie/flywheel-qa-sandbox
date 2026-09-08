#!/usr/bin/env bash
# FLY-2403: hermetic Astra/Fable design-outcome report contract.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPORT="$ROOT/scripts/fly2403-design-model-comparison.sql"

if ! command -v sqlite3 >/dev/null 2>&1; then
	printf 'FAIL: sqlite3 is required for the FLY-2403 report suite\n' >&2
	exit 127
fi

if [[ ! -f "$REPORT" ]]; then
	printf 'FAIL: missing report SQL: %s\n' "$REPORT" >&2
	exit 1
fi

if grep -Eq 'session_events|stage_changed|approved_exit_stage' "$REPORT"; then
	printf 'FAIL: review corroboration must not depend on expiring session stage events\n' >&2
	exit 1
fi
if ! grep -q "'node_completed' AS design_completion_kind" "$REPORT"; then
	printf 'FAIL: report must pin the durable design completion event kind\n' >&2
	exit 1
fi

TMP_ROOT="$(mktemp -d -t fly2403-report.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT
DB="$TMP_ROOT/teamlead.db"
FIXTURE="$TMP_ROOT/fixture.mts"
ACTUAL="$TMP_ROOT/actual.csv"
EXPECTED="$TMP_ROOT/expected.csv"
FILTERED_REPORT="$TMP_ROOT/filtered-report.sql"
FILTERED_ACTUAL="$TMP_ROOT/filtered-actual.csv"

sha256_file() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | awk '{print $1}'
	elif command -v openssl >/dev/null 2>&1; then
		openssl dgst -sha256 -r "$1" | awk '{print $1}'
	else
		printf 'FAIL: no SHA-256 implementation found\n' >&2
		return 127
	fi
}

cat >"$FIXTURE" <<'TS'
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.env.REPO_ROOT;
const dbPath = process.env.DB_PATH;
if (!repoRoot || !dbPath) throw new Error("REPO_ROOT and DB_PATH are required");

const moduleUrl = pathToFileURL(
	join(repoRoot, "packages/teamlead/src/StateStore.ts"),
).href;
const { StateStore } = await import(moduleUrl);
const store = await StateStore.create(dbPath);
type DbSeam = { run(sql: string, params?: unknown[]): void };
const db = (store as unknown as { db: DbSeam }).db;
const runIds = new Set<string>();
const eventSequences = new Map<string, number>();

function sql(statement: string, params: unknown[] = []): void {
	db.run(statement, params);
}

function addRun(runId: string): void {
	if (runIds.has(runId)) return;
	runIds.add(runId);
	sql(
		`INSERT INTO workflow_run(run_id, issue_id, project_name, status, created_at)
		 VALUES (?, ?, 'flywheel', 'completed', '2026-09-01T00:00:00Z')`,
		[runId, `FLY-2403-${runId}`],
	);
}

function addActor(executionId: string, role: string): void {
	sql(
		`INSERT INTO workflow_actor(execution_id, project_name, issue_id, role, created_at)
		 VALUES (?, 'flywheel', 'FLY-2403', ?, '2026-09-01T00:00:00Z')`,
		[executionId, role],
	);
}

function addEvent(input: {
	runId: string;
	kind: string;
	nodeId?: string;
	edgeId?: string | null;
	executionId?: string;
	payload?: unknown;
}): void {
	const seq = (eventSequences.get(input.runId) ?? 0) + 1;
	eventSequences.set(input.runId, seq);
	sql(
		`INSERT INTO workflow_run_event
		 (run_id, seq, event_uid, kind, node_id, edge_id, execution_id, payload, at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-09-01T10:00:00Z')`,
		[
			input.runId,
			seq,
			`${input.runId}:event:${seq}`,
			input.kind,
			input.nodeId ?? null,
			input.edgeId ?? null,
			input.executionId ?? null,
			input.payload === undefined ? null : JSON.stringify(input.payload),
		],
	);
}

function addDesign(input: {
	runId: string;
	executionId: string;
	attempt?: number;
	model: string;
	state?: string;
	startedAt: string;
	endedAt: string | null;
	receipt?: false | { model: string };
}): void {
	addRun(input.runId);
	addActor(input.executionId, "design");
	sql(
		`INSERT INTO workflow_run_node
		 (run_id, node_id, attempt, state, execution_id, started_at, ended_at)
		 VALUES (?, 'eng_design', ?, ?, ?, ?, ?)`,
		[
			input.runId,
			input.attempt ?? 1,
			input.state ?? "done",
			input.executionId,
			input.startedAt,
			input.endedAt,
		],
	);
	sql(
		`INSERT INTO workflow_execution_runtime
		 (execution_id, run_id, node_id, attempt, vendor, model, effort,
		  resolved_family, capabilities_digest, created_at)
		 VALUES (?, ?, 'eng_design', ?, ?, ?, 'medium', ?, 'fixture-digest',
		         '2026-09-01T00:00:00Z')`,
		[
			input.executionId,
			input.runId,
			input.attempt ?? 1,
			input.model.startsWith("claude-fable-") ? "claude" : "codex",
			input.model,
			input.model.startsWith("claude-fable-") ? "claude" : "codex",
		],
	);
	if (input.receipt !== false) {
		addEvent({
			runId: input.runId,
			kind: "dispatch_vendor_resolved",
			nodeId: "eng_design",
			executionId: input.executionId,
			payload: {
				dispatch: { model: input.receipt?.model ?? input.model },
			},
		});
	}
}

function addObservationNode(
	runId: string,
	nodeId: "qa" | "founder_gate",
	state = "done",
): void {
	const executionId = `${runId}-${nodeId}`;
	addActor(executionId, nodeId);
	sql(
		`INSERT INTO workflow_run_node
		 (run_id, node_id, attempt, state, execution_id, started_at, ended_at)
		 VALUES (?, ?, 1, ?, ?, '2026-09-01T05:00:00Z', ?)`,
		[
			runId,
			nodeId,
			state,
			executionId,
			state === "done" ? "2026-09-01T06:00:00Z" : null,
		],
	);
}

function addCodexReview(
	executionId: string,
	requestId: string,
	status: "done" | "failed" | "pending" | "skipped",
	verdict: string | null,
	round = 1,
): void {
	sql(
		`INSERT INTO codex_review_job
		 (request_id, execution_id, issue_id, project_name, review_type, round,
		  question_id, status, verdict, created_at, updated_at)
		 VALUES (?, ?, 'FLY-2403', 'flywheel', 'design', ?, ?, ?, ?,
		         '2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z')`,
		[requestId, executionId, round, `question-${requestId}`, status, verdict],
	);
}

function addFableReview(
	executionId: string,
	revision: number,
	requestId: string,
	isCurrent: 0 | 1,
	delivered: boolean,
): void {
	sql(
		`INSERT INTO design_review_manifest
		 (execution_id, revision, request_id, project_name, source_event_id,
		  expected_plan_path, expected_blob_sha, is_current, created_at, delivered_at)
		 VALUES (?, ?, ?, 'flywheel', ?, 'docs/design.md', 'fixture-blob', ?,
		         '2026-09-01T00:00:00Z', ?)`,
		[
			executionId,
			revision,
			requestId,
			`source-${requestId}`,
			isCurrent,
			delivered ? "2026-09-01T01:00:00Z" : null,
		],
	);
}

// Both author families may enter implement only after their design-review gate
// passed. Pair this common durable gate-exit signal with each lane's round
// ledger so the report never treats a request/delivery alone as approval.
function addDesignCompletion(runId: string, executionId: string): void {
	addEvent({
		runId,
		kind: "node_completed",
		nodeId: "eng_design",
		executionId,
		payload: { route: "phase_design_complete" },
	});
}

// Positive Astra: final approved round five, one QA kickback, two founder
// kickbacks, and two hours of completed design wall time. Earlier failed,
// pending, and skipped rows advance round numbers but remain non-evidence.
addDesign({
	runId: "astra-clean",
	executionId: "astra-clean-design",
	model: "gpt-6-astra",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T02:00:00Z",
});
addCodexReview("astra-clean-design", "astra-clean-r1", "done", "CHANGES_REQUESTED", 1);
addCodexReview("astra-clean-design", "astra-clean-failed", "failed", "APPROVED", 2);
addCodexReview("astra-clean-design", "astra-clean-pending", "pending", "APPROVED", 3);
addCodexReview("astra-clean-design", "astra-clean-skipped", "skipped", "CHANGES_REQUESTED", 4);
addCodexReview("astra-clean-design", "astra-clean-r2", "done", "APPROVED", 5);
addCodexReview("astra-clean-design", "astra-clean-nonterminal-verdict", "done", "ERROR", 6);
addDesignCompletion("astra-clean", "astra-clean-design");
addObservationNode("astra-clean", "qa");
addEvent({ runId: "astra-clean", kind: "loop_iteration", edgeId: "qa_retry" });
addEvent({ runId: "astra-clean", kind: "loop_iteration", edgeId: "other_retry" });
addObservationNode("astra-clean", "founder_gate");
addEvent({ runId: "astra-clean", kind: "founder_feedback_kickback" });
addEvent({ runId: "astra-clean", kind: "founder_feedback_kickback" });

// Positive Fable: current delivered revision seven plus the common gate-exit
// stage proves approved completion. MAX(revision)=7 still differs from row count.
// Its observed QA and founder windows intentionally retain legitimate zeroes.
addDesign({
	runId: "fable-clean",
	executionId: "fable-clean-design",
	model: "claude-fable-4.2",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T01:00:00Z",
});
addFableReview("fable-clean-design", 2, "fable-clean-r1", 0, true);
addFableReview("fable-clean-design", 7, "fable-clean-r2", 1, true);
addDesignCompletion("fable-clean", "fable-clean-design");
addObservationNode("fable-clean", "qa");
addObservationNode("fable-clean", "founder_gate");

// Neither lane qualifies from request-looking evidence alone. Astra lacks a
// done APPROVED job; Fable lacks both a delivered current manifest and gate exit.
addDesign({
	runId: "astra-no-review",
	executionId: "astra-no-review-design",
	model: "gpt-6-astra",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T04:00:00Z",
});
addCodexReview("astra-no-review-design", "astra-no-review-failed", "failed", "APPROVED");
addDesignCompletion("astra-no-review", "astra-no-review-design");
addObservationNode("astra-no-review", "qa");
addEvent({ runId: "astra-no-review", kind: "loop_limit_escalated", edgeId: "qa_retry" });
addObservationNode("astra-no-review", "founder_gate");

addDesign({
	runId: "fable-no-review",
	executionId: "fable-no-review-design",
	model: "claude-fable-4.1",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T03:00:00Z",
});
addFableReview("fable-no-review-design", 1, "fable-no-review-r1", 0, false);
addFableReview("fable-no-review-design", 2, "fable-no-review-r2", 1, false);
addObservationNode("fable-no-review", "qa");
addObservationNode("fable-no-review", "founder_gate");

// A legacy loop receipt with no edge makes only the QA metric unknown.
addDesign({
	runId: "astra-null-edge",
	executionId: "astra-null-edge-design",
	model: "gpt-6-astra",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T03:00:00Z",
});
addCodexReview("astra-null-edge-design", "astra-null-edge-r1", "done", "APPROVED");
addDesignCompletion("astra-null-edge", "astra-null-edge-design");
addObservationNode("astra-null-edge", "qa");
addEvent({ runId: "astra-null-edge", kind: "loop_iteration", edgeId: null });
addEvent({ runId: "astra-null-edge", kind: "loop_limit_escalated", edgeId: "" });
addEvent({ runId: "astra-null-edge", kind: "loop_iteration", edgeId: "qa_retry" });
addObservationNode("astra-null-edge", "founder_gate");

// Missing and negative node timestamps exclude only duration.
addDesign({
	runId: "astra-missing-duration",
	executionId: "astra-missing-duration-design",
	model: "gpt-6-astra",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: null,
});
addCodexReview("astra-missing-duration-design", "astra-missing-duration-r1", "done", "APPROVED");
addDesignCompletion("astra-missing-duration", "astra-missing-duration-design");
addObservationNode("astra-missing-duration", "qa");
addObservationNode("astra-missing-duration", "founder_gate");

addDesign({
	runId: "fable-negative-duration",
	executionId: "fable-negative-duration-design",
	model: "claude-fable-4.0",
	startedAt: "2026-09-01T04:00:00Z",
	endedAt: "2026-09-01T03:00:00Z",
});
addFableReview("fable-negative-duration-design", 1, "fable-negative-duration-r1", 1, true);
addDesignCompletion("fable-negative-duration", "fable-negative-duration-design");
addObservationNode("fable-negative-duration", "qa");
addObservationNode("fable-negative-duration", "founder_gate");

// This run has reached design completion but not QA or founder observation.
addDesign({
	runId: "astra-before-qa",
	executionId: "astra-before-qa-design",
	model: "gpt-6-astra",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T01:00:00Z",
});
addCodexReview("astra-before-qa-design", "astra-before-qa-r1", "done", "APPROVED");
addDesignCompletion("astra-before-qa", "astra-before-qa-design");

// An eligible but unfinished design execution has countable-looking review
// evidence. It must not open either design-completion observation window.
addDesign({
	runId: "astra-unfinished-design",
	executionId: "astra-unfinished-design-exec",
	model: "gpt-6-astra",
	state: "running",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: null,
});
addCodexReview(
	"astra-unfinished-design-exec",
	"astra-unfinished-design-r1",
	"done",
	"APPROVED",
);

// Completed designs do not create fake zero observations for downstream nodes
// that exist but have not completed.
addDesign({
	runId: "fable-unfinished-qa",
	executionId: "fable-unfinished-qa-design",
	model: "claude-fable-4.2",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T02:00:00Z",
});
addFableReview("fable-unfinished-qa-design", 1, "fable-unfinished-qa-r1", 1, true);
addDesignCompletion("fable-unfinished-qa", "fable-unfinished-qa-design");
addObservationNode("fable-unfinished-qa", "qa", "running");

addDesign({
	runId: "fable-unfinished-founder",
	executionId: "fable-unfinished-founder-design",
	model: "claude-fable-4.2",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T02:00:00Z",
});
addFableReview(
	"fable-unfinished-founder-design",
	1,
	"fable-unfinished-founder-r1",
	1,
	true,
);
addDesignCompletion("fable-unfinished-founder", "fable-unfinished-founder-design");
addObservationNode("fable-unfinished-founder", "founder_gate", "running");

// Two same-arm completed design executions roll up to one run observation.
// Their lane-specific requests and wall times are summed before AVG/N.
addDesign({
	runId: "astra-multi-design",
	executionId: "astra-multi-design-1",
	attempt: 1,
	model: "gpt-6-astra",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T01:00:00Z",
});
addDesign({
	runId: "astra-multi-design",
	executionId: "astra-multi-design-2",
	attempt: 2,
	model: "gpt-6-astra",
	startedAt: "2026-09-01T01:00:00Z",
	endedAt: "2026-09-01T03:00:00Z",
});
addCodexReview(
	"astra-multi-design-1",
	"astra-multi-design-r1",
	"done",
	"APPROVED",
	2,
);
addDesignCompletion("astra-multi-design", "astra-multi-design-1");
addCodexReview(
	"astra-multi-design-2",
	"astra-multi-design-r2-changes",
	"done",
	"CHANGES_REQUESTED",
	2,
);
addCodexReview(
	"astra-multi-design-2",
	"astra-multi-design-r2-approved",
	"done",
	"APPROVED",
	3,
);
addDesignCompletion("astra-multi-design", "astra-multi-design-2");
addObservationNode("astra-multi-design", "qa");
addObservationNode("astra-multi-design", "founder_gate");

// A run is not review-observable unless every completed design execution has
// final-round evidence. The first execution's round four must not leak through.
addDesign({
	runId: "astra-partial-review",
	executionId: "astra-partial-review-1",
	attempt: 1,
	model: "gpt-6-astra",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T01:00:00Z",
});
addDesign({
	runId: "astra-partial-review",
	executionId: "astra-partial-review-2",
	attempt: 2,
	model: "gpt-6-astra",
	startedAt: "2026-09-01T01:00:00Z",
	endedAt: "2026-09-01T02:00:00Z",
});
addCodexReview(
	"astra-partial-review-1",
	"astra-partial-review-approved",
	"done",
	"APPROVED",
	4,
);
addDesignCompletion("astra-partial-review", "astra-partial-review-1");
addCodexReview(
	"astra-partial-review-2",
	"astra-partial-review-approved-stale",
	"done",
	"APPROVED",
	4,
);
addCodexReview(
	"astra-partial-review-2",
	"astra-partial-review-changes",
	"done",
	"CHANGES_REQUESTED",
	5,
);
addDesignCompletion("astra-partial-review", "astra-partial-review-2");
addObservationNode("astra-partial-review", "qa");
addObservationNode("astra-partial-review", "founder_gate");

// Sanctioned rework may reuse one immutable execution identity across design
// node attempts. Attribute and review it once, but sum both attempt durations.
addDesign({
	runId: "astra-reused-execution",
	executionId: "astra-reused-execution-design",
	attempt: 1,
	model: "gpt-6-astra",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T01:00:00Z",
	receipt: false,
});
sql(
	`INSERT INTO workflow_run_node
	 (run_id, node_id, attempt, state, execution_id, started_at, ended_at)
	 VALUES ('astra-reused-execution', 'eng_design', 2, 'done',
	         'astra-reused-execution-design',
	         '2026-09-01T01:00:00Z', '2026-09-01T03:00:00Z')`,
);
addCodexReview(
	"astra-reused-execution-design",
	"astra-reused-execution-r3",
	"done",
	"APPROVED",
	3,
);
addDesignCompletion("astra-reused-execution", "astra-reused-execution-design");

// Attribution failures after every observation window: mismatched receipt,
// mixed arms, and the two contamination cases below. A missing dispatch audit
// is not an attribution failure when immutable runtime authority is present.
addDesign({
	runId: "attribution-mismatch",
	executionId: "attribution-mismatch-design",
	model: "gpt-6-astra",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T01:00:00Z",
	receipt: { model: "claude-fable-4.2" },
});
addObservationNode("attribution-mismatch", "qa");
addObservationNode("attribution-mismatch", "founder_gate");

addDesign({
	runId: "attribution-missing",
	executionId: "attribution-missing-design",
	model: "claude-fable-4.2",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T01:00:00Z",
	receipt: false,
});
addObservationNode("attribution-missing", "qa");
addObservationNode("attribution-missing", "founder_gate");

addDesign({
	runId: "attribution-mixed",
	executionId: "attribution-mixed-astra",
	attempt: 1,
	model: "gpt-6-astra",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T01:00:00Z",
});
addDesign({
	runId: "attribution-mixed",
	executionId: "attribution-mixed-fable",
	attempt: 2,
	model: "claude-fable-4.2",
	startedAt: "2026-09-01T01:00:00Z",
	endedAt: "2026-09-01T02:00:00Z",
});
addObservationNode("attribution-mixed", "qa");
addObservationNode("attribution-mixed", "founder_gate");

// A matching dispatch receipt does not sanitize another receipt for the same
// execution. Conflicting and duplicate-same-model extras are both contaminated.
addDesign({
	runId: "attribution-conflicting-extra",
	executionId: "attribution-conflicting-extra-design",
	model: "gpt-6-astra",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T01:00:00Z",
});
addEvent({
	runId: "attribution-conflicting-extra",
	kind: "dispatch_vendor_resolved",
	nodeId: "eng_design",
	executionId: "attribution-conflicting-extra-design",
	payload: { dispatch: { model: "claude-fable-4.2" } },
});
addObservationNode("attribution-conflicting-extra", "qa");
addObservationNode("attribution-conflicting-extra", "founder_gate");

addDesign({
	runId: "attribution-duplicate-extra",
	executionId: "attribution-duplicate-extra-design",
	model: "claude-fable-4.2",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T01:00:00Z",
});
addEvent({
	runId: "attribution-duplicate-extra",
	kind: "dispatch_vendor_resolved",
	nodeId: "eng_design",
	executionId: "attribution-duplicate-extra-design",
	payload: { dispatch: { model: "claude-fable-4.2" } },
});
addObservationNode("attribution-duplicate-extra", "qa");
addObservationNode("attribution-duplicate-extra", "founder_gate");

// A recognized Astra runtime cannot label unverified design work in the same
// run. Sol runtime work and a node with no runtime both contaminate the run.
addDesign({
	runId: "attribution-astra-plus-sol",
	executionId: "attribution-astra-plus-sol-astra",
	attempt: 1,
	model: "gpt-6-astra",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T01:00:00Z",
});
addDesign({
	runId: "attribution-astra-plus-sol",
	executionId: "attribution-astra-plus-sol-sol",
	attempt: 2,
	model: "gpt-5.6-sol",
	startedAt: "2026-09-01T01:00:00Z",
	endedAt: "2026-09-01T03:00:00Z",
});
addCodexReview(
	"attribution-astra-plus-sol-astra",
	"attribution-astra-plus-sol-r1",
	"done",
	"APPROVED",
	2,
);
addCodexReview(
	"attribution-astra-plus-sol-sol",
	"attribution-astra-plus-sol-r2",
	"done",
	"APPROVED",
	7,
);
addObservationNode("attribution-astra-plus-sol", "qa");
addObservationNode("attribution-astra-plus-sol", "founder_gate");

addDesign({
	runId: "attribution-astra-plus-missing-runtime",
	executionId: "attribution-astra-plus-missing-runtime-astra",
	attempt: 1,
	model: "gpt-6-astra",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T01:00:00Z",
});
addActor("attribution-astra-plus-missing-runtime-node", "design");
sql(
	`INSERT INTO workflow_run_node
	 (run_id, node_id, attempt, state, execution_id, started_at, ended_at)
	 VALUES ('attribution-astra-plus-missing-runtime', 'eng_design', 2, 'done',
	         'attribution-astra-plus-missing-runtime-node',
	         '2026-09-01T01:00:00Z', '2026-09-01T04:00:00Z')`,
);
addEvent({
	runId: "attribution-astra-plus-missing-runtime",
	kind: "dispatch_vendor_resolved",
	nodeId: "eng_design",
	executionId: "attribution-astra-plus-missing-runtime-node",
	payload: { dispatch: { model: "gpt-6-astra" } },
});
addCodexReview(
	"attribution-astra-plus-missing-runtime-astra",
	"attribution-astra-plus-missing-runtime-r1",
	"done",
	"APPROVED",
	2,
);
addCodexReview(
	"attribution-astra-plus-missing-runtime-node",
	"attribution-astra-plus-missing-runtime-r2",
	"done",
	"APPROVED",
	8,
);
addObservationNode("attribution-astra-plus-missing-runtime", "qa");
addObservationNode("attribution-astra-plus-missing-runtime", "founder_gate");

// Sol-only design is outside the experiment, not an attribution exclusion.
addDesign({
	runId: "sol-only-control",
	executionId: "sol-only-control-design",
	model: "gpt-5.6-sol",
	startedAt: "2026-09-01T00:00:00Z",
	endedAt: "2026-09-01T05:00:00Z",
});
addObservationNode("sol-only-control", "qa");
addObservationNode("sol-only-control", "founder_gate");

// simple_code noise has a valid Astra-looking runtime/receipt but no eng_design.
addRun("simple-code-noise");
addActor("simple-code-noise-exec", "implement");
sql(
	`INSERT INTO workflow_run_node
	 (run_id, node_id, attempt, state, execution_id, started_at, ended_at)
	 VALUES ('simple-code-noise', 'simple_code', 1, 'done',
	         'simple-code-noise-exec', '2026-09-01T00:00:00Z',
	         '2026-09-01T06:00:00Z')`,
);
sql(
	`INSERT INTO workflow_execution_runtime
	 (execution_id, run_id, node_id, attempt, vendor, model, effort,
	  resolved_family, capabilities_digest, created_at)
	 VALUES ('simple-code-noise-exec', 'simple-code-noise', 'simple_code', 1,
	         'codex', 'gpt-6-astra', 'medium', 'codex', 'fixture-digest',
	         '2026-09-01T00:00:00Z')`,
);
addEvent({
	runId: "simple-code-noise",
	kind: "dispatch_vendor_resolved",
	nodeId: "simple_code",
	executionId: "simple-code-noise-exec",
	payload: { dispatch: { model: "gpt-6-astra" } },
});

// StateStore correctly creates production databases in WAL mode. Switch this
// closed fixture to a self-contained journal mode so sqlite3 can reopen the
// chmod-0444 main file without needing writable WAL/SHM sidecars.
db.run("PRAGMA journal_mode = DELETE");
store.close();
TS

REPO_ROOT="$ROOT" DB_PATH="$DB" \
	pnpm --dir "$ROOT" --filter flywheel-teamlead exec tsx "$FIXTURE"

chmod 0444 "$DB"
BEFORE_HASH="$(sha256_file "$DB")"
sqlite3 -readonly -header -csv "$DB" <"$REPORT" >"$ACTUAL"
AFTER_HASH="$(sha256_file "$DB")"

if [[ "$BEFORE_HASH" != "$AFTER_HASH" ]]; then
	printf 'FAIL: report mutated its read-only input database\n' >&2
	exit 1
fi

cat >"$EXPECTED" <<'CSV'
metric,astra_avg,astra_total,astra_n,fable_avg,fable_total,fable_n,attribution_excluded_n,dispatch_audit_missing_n,review_evidence_excluded_n,qa_ambiguous_excluded_n,duration_invalid_excluded_n,data_source,astra_window_n,fable_window_n,astra_coverage,fable_coverage
design_review_approval_rounds,2.666667,16,6,2.5,10,4,6,2,4,0,0,"codex_review_job / design_review_manifest + workflow_run_event(node_completed)",8,6,"6/8 样本","4/6 样本"
qa_kickbacks,0.4,2,5,0.0,0,4,6,1,0,1,0,"workflow_run_event(qa_retry) + workflow_run_node(qa done)",6,4,"5/6 样本","4/4 样本"
founder_kickbacks,0.333333,2,6,0.0,0,4,6,1,0,0,0,"workflow_run_event(founder_feedback_kickback) + workflow_run_node(founder_gate done)",6,4,"6/6 样本","4/4 样本"
design_duration_hours,2.571429,18.0,7,1.8,9.0,5,6,2,0,0,2,"workflow_run_node(eng_design started_at/ended_at)",8,6,"7/8 样本","5/6 样本"
CSV

if [[ "$(wc -l <"$ACTUAL" | tr -d ' ')" != 5 ]]; then
	printf 'FAIL: expected exactly one header and four metric rows\n' >&2
	cat "$ACTUAL" >&2
	exit 1
fi

if ! diff -u "$EXPECTED" "$ACTUAL"; then
	printf 'FAIL: report metrics or exclusions differ from the contract\n' >&2
	exit 1
fi

if ! awk -F, '$1 == "design_review_approval_rounds" && $7 > 0 { found=1 } END { exit !found }' "$ACTUAL"; then
	printf 'FAIL: Fable review observations must remain nonzero\n' >&2
	exit 1
fi

if ! awk -F, '$1 == "design_review_approval_rounds" && $3 == 16 && $4 == 6 && $6 == 10 && $7 == 4 && $10 == 4 { found=1 } END { exit !found }' "$ACTUAL"; then
	printf 'FAIL: final approved rounds or visible review-evidence losses are wrong\n' >&2
	exit 1
fi

if ! awk -F, '$1 == "design_duration_hours" && $3 == 18 && $4 == 7 && $6 == 9 && $7 == 5 && $12 == 2 { found=1 } END { exit !found }' "$ACTUAL"; then
	printf 'FAIL: completed durations or visible invalid-duration losses are wrong\n' >&2
	exit 1
fi

if ! awk -F, '$1 == "qa_kickbacks" && $4 == 5 && $7 == 4 && $11 == 1 { found=1 } END { exit !found }' "$ACTUAL"; then
	printf 'FAIL: unfinished QA attempts entered the observation count\n' >&2
	exit 1
fi

if ! awk -F, '$1 == "founder_kickbacks" && $4 == 6 && $7 == 4 && $11 == 0 { found=1 } END { exit !found }' "$ACTUAL"; then
	printf 'FAIL: unfinished founder gates entered the observation count\n' >&2
	exit 1
fi

if ! awk -F, '$1 == "qa_kickbacks" && $6 == 0 && $7 == 4 { found=1 } END { exit !found }' "$ACTUAL"; then
	printf 'FAIL: observed Fable zero-kickback runs were not retained\n' >&2
	exit 1
fi

if ! awk -F, 'NR > 1 {
	if ($8 != 6) exit 1;
	expected_missing = ($1 == "design_review_approval_rounds" || $1 == "design_duration_hours") ? 2 : 1;
	if ($9 != expected_missing) exit 1;
	rows++
} END { exit rows == 4 ? 0 : 1 }' "$ACTUAL"; then
	printf 'FAIL: mixed verified/unverified design runs were not attribution exclusions\n' >&2
	exit 1
fi

# The founder has not frozen experiment cohort/model definitions. They must be
# editable in one parameter block rather than scattered through the report.
if [[ "$(grep -o "'gpt-6-astra'" "$REPORT" | wc -l | tr -d ' ')" != 1 ]] ||
	[[ "$(grep -o "'claude-fable-\*'" "$REPORT" | wc -l | tr -d ' ')" != 1 ]]; then
	printf 'FAIL: arm model definitions must live only in report_parameters\n' >&2
	exit 1
fi
sed "s/CAST(NULL AS TEXT) AS cohort_started_at/'2026-09-02T00:00:00Z' AS cohort_started_at/" \
	"$REPORT" >"$FILTERED_REPORT"
sqlite3 -readonly -header -csv "$DB" <"$FILTERED_REPORT" >"$FILTERED_ACTUAL"
if ! awk -F, 'NR > 1 {
	if ($4 != 0 || $7 != 0 || $8 != 0 || $9 != 0) exit 1;
	gsub(/^"|"$/, "", $16);
	gsub(/^"|"$/, "", $17);
	if ($14 != 0 || $15 != 0) exit 1;
	if ($16 != "0 样本 · 不可结论" || $17 != "0 样本 · 不可结论") exit 1;
	rows++
} END { exit rows == 4 ? 0 : 1 }' "$FILTERED_ACTUAL"; then
	printf 'FAIL: editable cohort parameter did not exclude pre-window runs\n' >&2
	exit 1
fi

printf 'PASS: FLY-2403 report emitted four deterministic read-only arm metrics\n'
