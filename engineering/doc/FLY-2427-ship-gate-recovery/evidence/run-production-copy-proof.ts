import { CommDB } from "../../../../packages/flywheel-comm/src/db.ts";
import { StateStore } from "../../../../packages/teamlead/src/StateStore.ts";
import {
	createWorkflowGateOriginInspector,
	createWorkflowGateOriginPreflight,
} from "../../../../packages/teamlead/src/bridge/gate-origin-preflight.ts";
import { materializeWorkflowGateHolder } from "../../../../packages/teamlead/src/bridge/gate-materializer.ts";
import { reconcileUnanswerableWorkflowGates } from "../../../../packages/teamlead/src/bridge/unanswerable-workflow-gate-reconciler.ts";
import { probeWorkflowPr } from "../../../../packages/teamlead/src/bridge/workflow-pr-probe.ts";

const teamleadPath = process.argv[2];
const commPath = process.argv[3];
if (!teamleadPath || !commPath) {
	throw new Error("usage: run-production-copy-proof.ts TEAMLEAD_COPY COMM_COPY");
}

const targetIssues = new Set(["FLY-2381", "FLY-2394", "FLY-2408"]);
const healthyIssues = new Set([
	"FLY-2379",
	"FLY-2383",
	"FLY-2397",
	"FLY-2403",
]);

const store = await StateStore.create(teamleadPath);
let clockMs = Date.now();
const now = () => new Date(clockMs++).toISOString();
const candidates = store.listWorkflowGateQuestionRecoveryCandidates("flywheel", 20);
const holderBefore = Object.fromEntries(
	candidates.map((candidate) => [
		candidate.issueId,
		structuredClone(store.getWorkflowGateHolderByQuestionId(candidate.questionId)),
	]),
);
const runBefore = Object.fromEntries(
	candidates.map((candidate) => [
		candidate.issueId,
		structuredClone(store.getWorkflowRun(candidate.runId)),
	]),
);
const gateNodesBefore = Object.fromEntries(
	candidates.map((candidate) => [
		candidate.issueId,
		structuredClone(
			store.listWorkflowRunNodes(candidate.runId, candidate.gateNodeId),
		),
	]),
);
const sessionBefore = Object.fromEntries(
	candidates.map((candidate) => [
		candidate.issueId,
		structuredClone(store.getSession(candidate.sourceExecutionId)),
	]),
);

const comm = new CommDB(commPath, false, false);
const questionInspection = Object.fromEntries(
	candidates.map((candidate) => [
		candidate.issueId,
		comm.inspectFounderShipGateQuestion(candidate.questionId, "flywheel"),
	]),
);
comm.close();

const probes: unknown[] = [];
const inspector = createWorkflowGateOriginInspector({
	store,
	now,
	prProbe: async (input) => {
		const output = await probeWorkflowPr(input);
		probes.push({ input, output });
		return output;
	},
});
const preflight = createWorkflowGateOriginPreflight({
	store,
	now,
	inspector,
});
const reconcileDeps = {
	enabled: true,
	projectName: "flywheel",
	commDbPath: commPath,
	store,
	openDb: (path: string) => new CommDB(path, false, false),
	inspectOrigin: inspector,
	resolveAlertIdentity: () => ({
		leadId: "flywheel-eng-lead",
		projectName: "flywheel",
		leadResolution: "resolved" as const,
	}),
	now,
	limit: 20,
	minIntervalMs: 30_000,
	log: (message: string) => console.error(message),
};

const first = await reconcileUnanswerableWorkflowGates(reconcileDeps);
const firstPosts: unknown[] = [];
const firstMaterialization: unknown[] = [];
for (const [index, questionId] of first.newQuestionIds.entries()) {
	const result = await materializeWorkflowGateHolder(
		{
			store,
			commDbPath: commPath,
			leadId: "flywheel-eng-lead",
			threadId: "copy-proof-thread",
			preflight,
			postCard: async (input) => {
				const posted = {
					questionId: input.questionId,
					issueId: input.issueId,
					headSha: input.headSha,
					messageId: `copy-proof-card-${index + 1}`,
				};
				firstPosts.push(posted);
				return { kind: "posted" as const, messageId: posted.messageId };
			},
			now,
		},
		questionId,
	);
	firstMaterialization.push({ questionId, result });
}

const oldVoidEligible = store
	.listWorkflowGateHoldersForCardVoid(now(), 20)
	.filter((holder) => holder.superseded_reason === "question_unanswerable_recovery")
	.map((holder) => holder.question_id);

clockMs += 31_000;
const second = await reconcileUnanswerableWorkflowGates(reconcileDeps);
const secondPosts: unknown[] = [];
for (const holder of store.listWorkflowGateHoldersForMaterialization(20)) {
	await materializeWorkflowGateHolder(
		{
			store,
			commDbPath: commPath,
			leadId: "flywheel-eng-lead",
			threadId: "copy-proof-thread",
			preflight,
			postCard: async (input) => {
				secondPosts.push(input);
				return { kind: "posted" as const, messageId: "unexpected-second-card" };
			},
			now,
		},
		holder.question_id,
	);
}

const currentAfter = Object.fromEntries(
	candidates.map((candidate) => [
		candidate.issueId,
		structuredClone(
			store.getCurrentWorkflowGateHolder(candidate.runId, candidate.gateNodeId),
		),
	]),
);
const oldAfter = Object.fromEntries(
	candidates.map((candidate) => [
		candidate.issueId,
		structuredClone(store.getWorkflowGateHolderByQuestionId(candidate.questionId)),
	]),
);
const runAfter = Object.fromEntries(
	candidates.map((candidate) => [
		candidate.issueId,
		structuredClone(store.getWorkflowRun(candidate.runId)),
	]),
);
const gateNodesAfter = Object.fromEntries(
	candidates.map((candidate) => [
		candidate.issueId,
		structuredClone(
			store.listWorkflowRunNodes(candidate.runId, candidate.gateNodeId),
		),
	]),
);
const sessionAfter = Object.fromEntries(
	candidates.map((candidate) => [
		candidate.issueId,
		structuredClone(store.getSession(candidate.sourceExecutionId)),
	]),
);
const recoveryCounts = Object.fromEntries(
	candidates
		.filter((candidate) => targetIssues.has(candidate.issueId))
		.map((candidate) => [
			candidate.issueId,
			store
				.listWorkflowRunEvents(candidate.runId)
				.filter((event) => event.kind === "gate_question_recovered").length,
		]),
);

console.log(
	JSON.stringify(
		{
			candidateIssues: candidates.map((candidate) => candidate.issueId),
			questionInspection,
			first,
			firstPosts,
			firstMaterialization,
			probes,
			oldVoidEligible,
			second,
			secondPosts,
			recoveredIssues: firstPosts.map(
				(entry) => (entry as { issueId: string }).issueId,
			),
			healthyHolderUnchanged: Object.fromEntries(
				[...healthyIssues].map((issueId) => [
					issueId,
					JSON.stringify(holderBefore[issueId]) ===
						JSON.stringify(oldAfter[issueId]),
				]),
			),
			healthyGateNodesUnchanged: Object.fromEntries(
				[...healthyIssues].map((issueId) => [
					issueId,
					JSON.stringify(gateNodesBefore[issueId]) ===
						JSON.stringify(gateNodesAfter[issueId]),
				]),
			),
			targetSuccessorNode: Object.fromEntries(
				candidates
					.filter((candidate) => targetIssues.has(candidate.issueId))
					.map((candidate) => {
						const current = currentAfter[candidate.issueId];
						return [
							candidate.issueId,
							gateNodesAfter[candidate.issueId]?.find(
								(node) => node.attempt === current?.attempt,
							),
						];
					}),
			),
			runUnchanged: Object.fromEntries(
				candidates.map((candidate) => [
					candidate.issueId,
					JSON.stringify(runBefore[candidate.issueId]) ===
						JSON.stringify(runAfter[candidate.issueId]),
				]),
			),
			sessionUnchanged: Object.fromEntries(
				candidates.map((candidate) => [
					candidate.issueId,
					JSON.stringify(sessionBefore[candidate.issueId]) ===
						JSON.stringify(sessionAfter[candidate.issueId]),
				]),
			),
			recoveryCounts,
			holderBefore,
			oldAfter,
			currentAfter,
			gateNodesBefore,
			gateNodesAfter,
		},
		null,
		2,
	),
);
store.close();
