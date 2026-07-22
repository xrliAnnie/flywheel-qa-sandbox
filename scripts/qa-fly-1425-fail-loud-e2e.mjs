#!/usr/bin/env node

/**
 * FLY-1425 real-machine isolated-Bridge fail-loud drill.
 *
 * The caller starts an isolated QA Testing Room Bridge, then points this driver
 * at that slot's file-backed StateStore and loopback URL. The driver seeds
 * isolated engine-owned QA attempts and proves both credential-loss barriers
 * plus the credential-backed decision path without opening production state or
 * alert directories.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { StateStore } = await import(
	join(repoRoot, "packages/teamlead/dist/StateStore.js")
);
const { loadBundledWorkflowSeeds } = await import(
	join(repoRoot, "packages/teamlead/dist/workflow-template.js")
);

const engineFlags = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

function parseArgs(argv) {
	const parsed = {};
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith("--") || value === undefined) {
			throw new Error(`invalid argument near ${key ?? "<end>"}`);
		}
		parsed[key.slice(2)] = value;
	}
	return parsed;
}

function required(args, name) {
	const value = args[name]?.trim();
	if (!value) throw new Error(`--${name} is required`);
	return value;
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function withStore(dbPath, action) {
	const store = await StateStore.create(dbPath);
	try {
		return await action(store);
	} finally {
		store.close();
	}
}

function rawDb(store) {
	return store.db;
}

function seedQaAttempt(store, input) {
	const startedIso = new Date(input.nowMs - 2 * 60_000).toISOString();
	const expiresAt = new Date(input.nowMs + 60 * 60_000).toISOString();
	const absoluteDeadlineAt = new Date(
		input.nowMs + 24 * 60 * 60_000,
	).toISOString();
	const designExecutionId = `${input.executionId}-design`;
	const implementExecutionId = `${input.executionId}-implement`;
	const seed = loadBundledWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy",
	);
	assert(seed, "bundled tpl_eng_heavy workflow seed missing");
	store.importWorkflowTemplateSeed(seed);
	store.bindWorkflowCategory({
		project: input.projectName,
		taskCategory: "code",
		templateId: seed.templateId,
		updatedBy: "fly1425-e2e",
	});
	store.materializeWorkflowRun({
		runId: input.runId,
		issueId: input.issueId,
		projectName: input.projectName,
		taskCategory: "code",
		claimsReadEnrolled: true,
		actor: "fly1425-e2e",
		env: engineFlags,
		startReservation: {
			idempotencyKey: `start:${input.runId}`,
			selectionDigest: `selection:${input.runId}`,
			nodeId: "design",
			attempt: 1,
			executionId: designExecutionId,
			createdAt: startedIso,
		},
	});
	store.upsertWorkflowRunNode({
		runId: input.runId,
		nodeId: "design",
		attempt: 1,
		state: "done",
		executionId: designExecutionId,
	});
	store.upsertWorkflowRunNode({
		runId: input.runId,
		nodeId: "implement",
		attempt: 1,
		state: "pending",
		executionId: implementExecutionId,
	});
	const implementAdmission = store.admitGeneralizedWorkflowExecution({
		runId: input.runId,
		nodeId: "implement",
		executionId: implementExecutionId,
		attempt: 1,
		expiresAt,
		absoluteDeadlineAt,
		now: startedIso,
		env: engineFlags,
	});
	assert(
		implementAdmission.ok,
		`implement admission failed: ${implementAdmission.reason ?? "unknown"}`,
	);
	store.upsertWorkflowRunNode({
		runId: input.runId,
		nodeId: "implement",
		attempt: 1,
		state: "done",
		executionId: implementExecutionId,
	});
	store.upsertWorkflowRunNode({
		runId: input.runId,
		nodeId: "qa",
		attempt: 1,
		state: "pending",
		executionId: input.executionId,
	});
	const qaAdmission = store.admitGeneralizedWorkflowExecution({
		runId: input.runId,
		nodeId: "qa",
		executionId: input.executionId,
		attempt: 1,
		expiresAt,
		absoluteDeadlineAt,
		now: startedIso,
		env: engineFlags,
	});
	assert(
		qaAdmission.ok && qaAdmission.submissionCredential,
		`QA admission failed: ${qaAdmission.reason ?? "credential missing"}`,
	);
	store.upsertWorkflowRunNode({
		runId: input.runId,
		nodeId: "qa",
		attempt: 1,
		state: "running",
		executionId: input.executionId,
	});
	rawDb(store).run(
		"UPDATE workflow_run_node SET started_at = ? WHERE run_id = ? AND node_id = 'qa' AND attempt = 1",
		[startedIso, input.runId],
	);
	store.upsertSession({
		execution_id: implementExecutionId,
		issue_id: input.issueId,
		project_name: input.projectName,
		status: "completed",
		session_role: "implement",
		chat_thread_role: "implement",
		adapter_type: "codex-tmux",
		worktree_path: repoRoot,
		workflow_node_id: "implement",
		issue_identifier: "FLY-1425",
		issue_title: "qa-result credential-loss fail-loud",
	});
	store.upsertSession({
		execution_id: input.executionId,
		issue_id: input.issueId,
		project_name: input.projectName,
		status: "running",
		session_role: "qa",
		chat_thread_role: "qa",
		adapter_type: "claude-tmux",
		runner_model: "claude-opus-4-8",
		worktree_path: repoRoot,
		workflow_node_id: "qa",
		issue_identifier: "FLY-1425",
		issue_title: "qa-result credential-loss fail-loud",
	});
	const credential = store.getWorkflowSubmissionCredentialByToken(
		qaAdmission.submissionCredential,
	);
	assert(credential?.id, `seeded credential missing for ${input.executionId}`);
	return {
		credentialId: Number(credential.id),
		credential: qaAdmission.submissionCredential,
		implementExecutionId,
	};
}

function runQaResult(input) {
	const env = {
		...process.env,
		HOME: input.scratchHome,
		FLYWHEEL_EXEC_ID: input.executionId,
		FLYWHEEL_ISSUE_ID: "FLY-1425",
		FLYWHEEL_PROJECT_NAME: input.projectName,
		FLYWHEEL_BRIDGE_URL: input.bridgeUrl,
		FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL: input.credential ?? "",
		FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED: input.expected ? "1" : "",
		FLYWHEEL_INGEST_TOKEN: input.ingestToken,
	};
	return spawnSync(
		process.execPath,
		[
			join(repoRoot, "packages/flywheel-comm/dist/index.js"),
			"qa-result",
			"--exec-id",
			input.executionId,
			"--target-exec",
			input.targetExecutionId,
			"--status",
			"pass",
			"--summary",
			input.summary,
		],
		{ env, encoding: "utf8", cwd: repoRoot },
	);
}

const args = parseArgs(process.argv.slice(2));
const dbPath = resolve(required(args, "db"));
const bridgeUrl = required(args, "bridge-url").replace(/\/$/, "");
assert(
	/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(bridgeUrl),
	"--bridge-url must be a loopback QA Bridge; production endpoints are forbidden",
);
assert(
	dbPath.startsWith("/tmp/flywheel-test-slot-") ||
		dbPath.startsWith("/private/tmp/flywheel-fly1425-isolated."),
	"--db must live in a QA slot or flywheel-fly1425 isolated temp room",
);
const projectName = required(args, "project");
assert(
	/^test-slot-\d+$/.test(projectName),
	"--project must be a QA slot project",
);
const ingestTokenEnv = args["ingest-token-env"];
const ingestToken = ingestTokenEnv ? (process.env[ingestTokenEnv] ?? "") : "";
const runNonce = `${Date.now()}-${process.pid}`;
const runId = `qa-fly1425-client-${runNonce}`;
const executionId = `qa-fly1425-client-exec-${runNonce}`;
const happyRunId = `qa-fly1425-happy-${runNonce}`;
const happyExecutionId = `qa-fly1425-happy-exec-${runNonce}`;
const scratchHome = mkdtempSync(join(tmpdir(), "qa-fly1425-home-"));
const nowMs = Date.now();

let clientSeed;
let happySeed;
await withStore(dbPath, async (store) => {
	clientSeed = seedQaAttempt(store, {
		runId,
		executionId,
		issueId: `FLY-1425-client-${runNonce}`,
		projectName,
		nowMs,
	});
	happySeed = seedQaAttempt(store, {
		runId: happyRunId,
		executionId: happyExecutionId,
		issueId: `FLY-1425-happy-${runNonce}`,
		projectName,
		nowMs,
	});
});

const localFailure = runQaResult({
	executionId,
	targetExecutionId: clientSeed.implementExecutionId,
	projectName,
	bridgeUrl,
	scratchHome,
	ingestToken,
	expected: true,
	summary: "isolated local fail-loud probe",
});
assert(localFailure.status !== 0, "missing credential + sentinel exited zero");
assert(
	localFailure.stderr.includes(
		"FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL is missing",
	),
	"local fail-loud error did not name the missing credential",
);

const serverFailure = runQaResult({
	executionId,
	targetExecutionId: clientSeed.implementExecutionId,
	projectName,
	bridgeUrl,
	scratchHome,
	ingestToken,
	expected: false,
	summary: "isolated server authority probe",
});
assert(serverFailure.status !== 0, "engine-owned /events misroute exited zero");
assert(
	serverFailure.stderr.includes("workflow_submission_required"),
	"server authority guard did not return workflow_submission_required",
);

const happyPath = runQaResult({
	executionId: happyExecutionId,
	targetExecutionId: happySeed.implementExecutionId,
	projectName,
	bridgeUrl,
	scratchHome,
	ingestToken,
	expected: true,
	credential: happySeed.credential,
	summary: "isolated credential-backed decision probe",
});
assert(happyPath.status === 0, "credential-backed qa-result exited non-zero");
const decisionConsumedLog = happyPath.stdout
	.split("\n")
	.find((line) => line.includes("[qa-result] decision consumed ("));
assert(
	decisionConsumedLog,
	"credential-backed path omitted decision-consumed log",
);
assert(
	!happyPath.stdout.includes("accepted by /events"),
	"credential-backed path printed the legacy /events acceptance log",
);

const final = await withStore(dbPath, async (store) => ({
	client: {
		events: store.getEventsByExecution(executionId),
		credential: store.getWorkflowSubmissionCredential(clientSeed.credentialId),
		node: store.getWorkflowRunNode(runId, "qa", 1),
	},
	happy: {
		events: store.getEventsByExecution(happyExecutionId),
		credential: store.getWorkflowSubmissionCredential(happySeed.credentialId),
		node: store.getWorkflowRunNode(happyRunId, "qa", 1),
		gate: store.getWorkflowRunNode(happyRunId, "founder_gate", 1),
		run: store.getWorkflowRun(happyRunId),
	},
}));
assert(final.client.events.length === 0, "misrouted qa_result was persisted");
assert(
	final.client.credential?.consumed_at === null,
	"credential-loss probe consumed the credential",
);
assert(
	final.client.node?.state === "running",
	"credential-loss probe advanced QA",
);
assert(
	final.happy.events.some((event) => event.event_type === "workflow_decision"),
	"credential-backed path omitted the durable workflow_decision event",
);
assert(
	typeof final.happy.credential?.consumed_at === "string" &&
		final.happy.credential.consumed_at.length > 0,
	"credential-backed path did not consume the credential",
);
assert(
	final.happy.node?.state === "done",
	"credential-backed path left QA running",
);
assert(
	final.happy.run?.current_node_id === "founder_gate" &&
		final.happy.gate?.state === "review",
	"credential-backed path did not advance to the founder gate",
);

console.log(
	JSON.stringify(
		{
			ok: true,
			isolation: { bridge: bridgeUrl, dbPath, projectName },
			clientFailLoud: {
				localExit: localFailure.status,
				serverExit: serverFailure.status,
				eventsPersisted: final.client.events.length,
				credentialConsumed: Boolean(final.client.credential?.consumed_at),
				nodeState: final.client.node?.state,
			},
			credentialHappyPath: {
				exit: happyPath.status,
				log: decisionConsumedLog,
				decisionEvents: final.happy.events.filter(
					(event) => event.event_type === "workflow_decision",
				).length,
				credentialConsumed: Boolean(final.happy.credential?.consumed_at),
				qaNodeState: final.happy.node?.state,
				runCurrentNode: final.happy.run?.current_node_id,
				founderGateState: final.happy.gate?.state,
			},
		},
		null,
		2,
	),
);
