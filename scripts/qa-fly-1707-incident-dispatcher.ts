import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { canonicalSubmissionDigest } from "../packages/config/src/index.ts";
import { WorkflowEngineDispatcher } from "../packages/teamlead/src/bridge/workflow-engine-dispatcher.ts";
import { resolveWorkflowResumeTarget } from "../packages/teamlead/src/bridge/workflow-resume-resolver.ts";
import { StateStore } from "../packages/teamlead/src/StateStore.ts";
import { resolveNodeDispatchAtLaunch } from "../packages/teamlead/src/workflow-dispatch-resolution.ts";
import { parseWorkflowRunSnapshot } from "../packages/teamlead/src/workflow-run-snapshot.ts";

const { values } = parseArgs({
	options: {
		db: { type: "string" },
		repo: { type: "string", default: process.cwd() },
	},
});
if (!values.db) throw new Error("snapshot_db_required");
const requestedDb = resolve(values.db);
const canonicalProductionDb = resolve(homedir(), ".flywheel/teamlead.db");
if (requestedDb === canonicalProductionDb) {
	throw new Error("production_db_refused");
}
const dbPath = realpathSync(requestedDb);
if (
	existsSync(canonicalProductionDb) &&
	dbPath === realpathSync(canonicalProductionDb)
) {
	throw new Error("production_db_refused");
}
const repoPath = resolve(values.repo);
const body = "FLY-1707 historical credential reconstruction replay";
const bodyDigest = createHash("sha256").update(body).digest("hex");
const legacyDesignNodeId = "design"; // FLY-2121-history: these pinned August runs predate the node-id cutover.
const cases = [
	{
		issueId: "FLY-1645",
		runId: "626e90ce-3604-4839-9c57-cb563f92517b",
		target: "qa",
		attempt: 1,
		executionId: "2f5f2a89-83a1-4235-a19e-1016082373ea",
		head: "d2b41ba4fda67a58473ab92ebe3013c36e7744de",
		review: "d2b41ba4fda67a58473ab92ebe3013c36e7744de",
	},
	{
		issueId: "FLY-1680",
		runId: "c79c6f10-068b-4632-b65c-2570beeebbb9",
		target: "implement",
		attempt: 2,
		executionId: "78951b2e-ccfd-4296-a23e-39b7a231467f",
		head: "98e0e4b61740251f9360f42690058e34a0840c8d",
		review: "98e0e4b61740251f9360f42690058e34a0840c8d",
	},
	{
		issueId: "FLY-1614",
		runId: "9bd7a57e-5334-4fb3-a287-75056c3f7d77",
		target: "implement",
		attempt: 2,
		executionId: "d7874f91-7c0b-45e9-b33c-7d6ff104f093",
		head: "253b283feea72cb441089a9157342dafc97babbc",
		review: "69dc8697eb7f6f6dbdb0708c926ba23c4e81b950",
	},
	{
		issueId: "FLY-1686",
		runId: "10333fac-a57c-4854-9f6c-0e4e52d71d87",
		target: "implement",
		attempt: 2,
		executionId: "674e0b7d-54f6-41f9-9adb-c58146cae601",
		head: "cba1446b009bc861e60721548c1c8b34225392af",
		review: "f942a4faef2497ed8e9b8f7d6bb0ecec5925fa3f",
	},
] as const;

function lineage(review: string, head: string): boolean {
	try {
		execFileSync(
			"git",
			["-C", repoPath, "cat-file", "-e", `${head}^{commit}`],
			{ stdio: "ignore" },
		);
		execFileSync(
			"git",
			["-C", repoPath, "merge-base", "--is-ancestor", review, head],
			{ stdio: "ignore" },
		);
		return true;
	} catch {
		return false;
	}
}

const store = await StateStore.create(dbPath);
const db = (
	store as unknown as {
		db: { run(sql: string, params?: unknown[]): void };
	}
).db;
db.run("UPDATE workflow_run SET status = 'terminated' WHERE status = 'active'");
db.run(
	"UPDATE workflow_side_effect_ledger SET state = 'abandoned' WHERE state IN ('intent_recorded','started')",
);

const designBefore = new Map<string, number>();
let mutationRefused = false;
for (const item of cases) {
	db.run(
		"UPDATE workflow_run SET status = 'active', engine_owned = 1, current_node_id = ? WHERE run_id = ?",
		[item.target, item.runId],
	);
	designBefore.set(
		item.runId,
		store.listWorkflowRunNodes(item.runId, legacyDesignNodeId).length,
	);
	const run = store.getWorkflowRun(item.runId)!;
	const snapshot = parseWorkflowRunSnapshot(run.snapshot!);
	const node = snapshot.resolved.nodes.find(
		(candidate) => candidate.id === item.target,
	)!;
	const writerExecutionId = `incident-source-${item.issueId}`;
	const dispatch = resolveNodeDispatchAtLaunch(store, {
		runId: item.runId,
		nodeId: item.target,
		env: {},
	}).dispatch;
	db.run(
		`INSERT INTO workflow_actor
		 (execution_id, project_name, issue_id, role, created_at)
		 VALUES (?, ?, ?, ?, '2026-08-11T14:29:00.000Z')`,
		[writerExecutionId, run.project_name, item.issueId, item.target],
	);
	db.run(
		"UPDATE workflow_run_node SET execution_id = ? WHERE run_id = ? AND node_id = ? AND attempt = ?",
		[writerExecutionId, item.runId, item.target, item.attempt],
	);
	db.run(
		`INSERT INTO workflow_execution_runtime
		 (execution_id, run_id, node_id, attempt, vendor, model, effort,
		  resolved_family, capabilities_digest, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-08-11T14:29:00.000Z')`,
		[
			writerExecutionId,
			item.runId,
			item.target,
			item.attempt,
			dispatch.vendor,
			dispatch.model,
			dispatch.effort ?? "",
			dispatch.vendor,
			canonicalSubmissionDigest(node.capabilities),
		],
	);
	store.upsertSession({
		execution_id: writerExecutionId,
		issue_id: item.issueId,
		project_name: run.project_name,
		status: "failed",
		session_role: item.target,
	});
	const runtime = store.getWorkflowExecutionRuntime(writerExecutionId)!;
	const runtimeDigest = canonicalSubmissionDigest({
		vendor: runtime.vendor,
		model: runtime.model,
		effort: runtime.effort ?? "",
		resolvedFamily: runtime.resolved_family,
		capabilitiesDigest: runtime.capabilities_digest,
	});
	const baselineUid = `issue_input_baseline:replay:${item.issueId}`;
	const receiptUid = `writer_replacement:replay:${item.issueId}`;
	const receiptPayload = {
		targetNodeId: item.target,
		targetAttempt: item.attempt,
		historicalAuthority: {
			executionId: item.executionId,
			materializedHead: item.head,
			reviewedHead: item.review,
		},
	};
	store.appendWorkflowRunEventChecked({
		runId: item.runId,
		eventUid: baselineUid,
		kind: "issue_input_baseline",
		payload: { outcome: "authoritative", bodyDigest },
	});
	store.appendWorkflowRunEventChecked({
		runId: item.runId,
		eventUid: receiptUid,
		kind: "writer_replacement",
		nodeId: item.target,
		executionId: writerExecutionId,
		payload: receiptPayload,
	});
	store.appendWorkflowRunEventChecked({
		runId: item.runId,
		eventUid: `issue_delivery:replay:${item.issueId}`,
		kind: "issue_delivery",
		nodeId: item.target,
		executionId: writerExecutionId,
		payload: { sourceKind: "authoritative", body, bodyDigest },
	});
	const attachmentId = `replay-${item.issueId}`;
	db.run(
		`INSERT INTO workflow_resume_attachment
		 (attachment_id, run_id, target_node_id, target_attempt, transition_uid,
		  receipt_kind, receipt_digest, carrier_kind, anchor_ref, anchor_commit,
		  repo_identity, snapshot_digest, resolved_node_digest,
		  runtime_semantics_digest, rework_authority_digest, envelope_json, created_at)
		 VALUES (?, ?, ?, ?, ?, 'writer_replacement', ?, 'git_checkpoint', ?, ?,
		         '__main__', ?, ?, ?, 'none', ?, '2026-08-11T14:30:00.000Z')`,
		[
			attachmentId,
			item.runId,
			item.target,
			item.attempt,
			receiptUid,
			canonicalSubmissionDigest(receiptPayload),
			`refs/flywheel/checkpoints/${item.runId}/${attachmentId}`,
			item.head,
			snapshot.snapshot_digest,
			canonicalSubmissionDigest(node),
			runtimeDigest,
			JSON.stringify({
				issueBaselineUid: baselineUid,
				historicalAuthority: receiptPayload.historicalAuthority,
			}),
		],
	);
	db.run(
		`INSERT INTO workflow_resume_attachment_state
		 (attachment_id, state, resolved_anchor_commit, store_locator,
		  envelope_stamped_json, runtime_semantics_stamped, updated_at)
		 VALUES (?, 'ready', ?, '{}', ?, ?, '2026-08-11T14:30:00.000Z')`,
		[
			attachmentId,
			item.head,
			JSON.stringify({
				schemaVersion: 1,
				issueBaseline: { uid: baselineUid, bodyDigest },
			}),
			runtimeDigest,
		],
	);
	const resolution = resolveWorkflowResumeTarget(store, {
		runId: item.runId,
		requestedEntry: item.target,
		envelopeObservation: { source: "incident_replay", digest: bodyDigest },
		env: {},
		verifyAnchor: ({ effectiveAnchor }) =>
			effectiveAnchor === item.head && lineage(item.review, effectiveAnchor),
	});
	if (!resolution.ok) throw new Error(`${item.issueId}:${resolution.reason}`);
	if (item.issueId === "FLY-1614") {
		const mutated = `${item.head[0] === "0" ? "1" : "0"}${item.head.slice(1)}`;
		const refused = resolveWorkflowResumeTarget(store, {
			runId: item.runId,
			requestedEntry: item.target,
			envelopeObservation: { source: "incident_replay", digest: bodyDigest },
			env: {},
			verifyAnchor: () => lineage(item.review, mutated),
		});
		mutationRefused = !refused.ok && refused.reason === "anchor_unreachable";
		if (!mutationRefused) throw new Error("FLY-1614 mutation accepted");
	}
	const admission = store.admitWorkflowResume({
		admissionKey: `incident-replay:${item.issueId}`,
		admissionDigest: createHash("sha256")
			.update(`incident-replay:${item.issueId}`)
			.digest("hex"),
		runId: item.runId,
		actionKind: "redispatch_execution",
		sourceAttachmentId: attachmentId,
		targetNodeId: item.target,
		targetAttempt: item.attempt,
		runtimeSemanticsDigest: runtimeDigest,
		observedBodyDigest: bodyDigest,
		effectiveAnchor: item.head,
		frozenBody: body,
		requestedEntry: item.target,
		newExecutionId: `incident-replay-${item.issueId}`,
		now: "2026-08-11T14:31:00.000Z",
	});
	if (!admission.ok) throw new Error(`${item.issueId}:${admission.reason}`);
}

const requests: any[] = [];
const startDispatcher = {
	async start(request: any) {
		requests.push(request);
		const committed = request.generalizedExecution?.commitWorkflowLaunch?.();
		if (!committed?.ok) throw new Error(committed?.reason ?? "not_committed");
		store.upsertSession({
			execution_id: request.generalizedExecution.executionId,
			issue_id: request.issueId,
			project_name: request.projectName,
			status: "running",
			session_role: request.sessionRole,
		});
		return {
			executionId: request.generalizedExecution.executionId,
			issueId: request.issueId,
		};
	},
	getInflightCount() {
		return 0;
	},
	validateAgentName() {
		return { ok: true as const };
	},
};
const logs: string[] = [];
const dispatcher = new WorkflowEngineDispatcher({
	store,
	startDispatcher: startDispatcher as never,
	stateRoot: mkdtempSync(join(tmpdir(), "fly1707-dispatch-replay-")),
	now: () => new Date("2026-08-11T14:32:00.000Z"),
	log: (message) => logs.push(message),
	resolvePredecessorHead: async () => {
		throw new Error("resume anchor bypassed");
	},
});
const result = await dispatcher.reconcile();
const output = {
	result,
	launches: requests.map((request) => ({
		issueId: request.issueId,
		nodeId: request.generalizedExecution.nodeId,
		attempt: request.generalizedExecution.attempt,
		startPoint: request.startPoint,
		resumeSource: request.workflowResume?.sourceAttachmentId,
	})),
	designAttempts: cases.map((item) => ({
		issueId: item.issueId,
		before: designBefore.get(item.runId),
		after: store.listWorkflowRunNodes(item.runId, legacyDesignNodeId).length,
	})),
	mutationRefused,
	logs,
	caveat:
		"8-11 历史 run 依赖凭据重建才能重放；4.1 小时是可避免墙钟上限，不代表当时机制已经运行。",
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
if (result.started !== 4 || result.held !== 0 || requests.length !== 4) {
	process.exitCode = 1;
}
store.close();
