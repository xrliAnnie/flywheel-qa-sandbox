import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BusinessRound } from "../business-round.js";
import { type Goal, renderGoalsFile } from "../contracts/goals.js";

const roots: string[] = [];
const start = Date.parse("2026-09-15T04:00:00Z");
const groups = {
	checkoutHead: [
		"branch",
		"lastCommit",
		"lastNonChoreCommit",
		"commits30d",
		"nonChoreCommits30d",
		"dirtyCount",
		"worktreeCount",
	],
	canonical: ["defaultBranch", "lastCommit"],
	prActivity: ["number", "state", "updatedAt", "mergedAt"],
	openPrs: [
		"returnedCount",
		"truncated",
		"newestUpdatedAt",
		"oldestUpdatedAt",
		"sample",
	],
	linear: ["projectState", "projectUpdatedAt", "activeIssues"],
	deployedCheckoutSummaryFiles: ["count", "latestDate", "checkoutSha"],
	activity: [
		"latestObservedActivityAt",
		"coverage",
		"daysSinceLatestObservedActivity",
	],
};
const goal: Goal = {
	id: "g-20260915-01",
	operationId: "111111111111111111:record:0",
	recordedAt: new Date(start).toISOString(),
	sourceUrl: "https://discord.com/channels/1/2/111111111111111111",
	status: "active",
	text: "稳定性优先",
	kind: "inference",
	projects: ["flywheel"],
	revision: 1,
};
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "patrol-round-"));
	roots.push(root);
	let now = start;
	const round = new BusinessRound(root, () => now);
	mkdirSync(join(root, "memory"));
	writeFileSync(join(root, "memory/goals.md"), renderGoalsFile([goal]));
	const sample = round.prepare({
		schemaVersion: 2,
		kind: "portfolio_sample",
		operationId: "sample:patrol",
		sourceRefs: ["summary:tick"],
		directory: {
			projectsDigest: "a".repeat(64),
			projects: [
				{
					projectName: "flywheel",
					projectRoot: "/projects/flywheel",
					projectRepo: "owner/flywheel",
					linear: null,
				},
			],
		},
	});
	const values = Object.fromEntries(
		Object.entries(groups).map(([group, keys]) => [
			group,
			Object.fromEntries(
				keys.map((key) => [key, { ok: false, reason: "unavailable" }]),
			),
		]),
	);
	values.openPrs = {
		...values.openPrs,
		returnedCount: { ok: true, value: 3, at: new Date(start).toISOString() },
	};
	const sampled = round.record({
		schemaVersion: 2,
		operationId: sample.operationId,
		expectedRevision: sample.revision,
		tool: "current_turn",
		callId: "read",
		result: {
			projects: [
				{
					projectName: "flywheel",
					repo: "owner/flywheel",
					linearBinding: null,
					...values,
				},
			],
		},
	});
	return {
		root,
		round,
		sampled,
		advance: () => {
			now += 300001;
		},
	};
}
function prepare(round: BusinessRound) {
	return round.prepare({
		schemaVersion: 2,
		kind: "patrol",
		operationId: "patrol:tick",
		sourceRefs: ["summary:tick"],
		snapshotOperationId: "sample:patrol",
	});
}
function decide(
	round: BusinessRound,
	view: { operationId: string; revision: number },
	result: object,
) {
	return round.record({
		schemaVersion: 2,
		operationId: view.operationId,
		expectedRevision: view.revision,
		tool: "current_turn",
		callId: "judge",
		result,
	});
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("standard-turn durable patrol", () => {
	it("validates observations before send and rechecks changed goals on resume", () => {
		const { root, round, sampled } = fixture();
		const initial = prepare(round);
		const snapshot = sampled.material?.snapshot as { snapshotId: string };
		const observation = decide(round, initial, {
			action: "observation",
			text: `【偏离】\n依据: snapshot=${snapshot.snapshotId} goals=${goal.id} readings=flywheel.openPrs.returnedCount\n这三个待处理 PR 是否影响稳定性目标？`,
		});
		expect(observation.next?.tool).toBe("lead_actions.discord_send");
		writeFileSync(
			join(root, "memory/goals.md"),
			renderGoalsFile([
				{
					...goal,
					status: "withdrawn",
					withdrawOperationId: "222222222222222222:withdraw:0",
					withdrawnAt: new Date(start).toISOString(),
					withdrawnSourceUrl:
						"https://discord.com/channels/1/2/222222222222222222",
				},
			]),
		);
		expect(round.resume(observation.operationId)).toMatchObject({
			next: null,
			material: { publishBlocked: "goals_changed" },
		});
	});
	it("expires a prepared send instead of issuing stale evidence on the next turn", () => {
		const { round, sampled, advance } = fixture();
		const initial = prepare(round);
		const snapshot = sampled.material?.snapshot as { snapshotId: string };
		const observation = decide(round, initial, {
			action: "observation",
			text: `【偏离】\n依据: snapshot=${snapshot.snapshotId} goals=${goal.id} readings=flywheel.openPrs.returnedCount\n需要核对。`,
		});
		advance();
		expect(round.resume(observation.operationId)).toMatchObject({
			next: null,
			material: { publishBlocked: "stale_snapshot" },
		});
	});
	it("records a reasoned silent outcome without a sending intention", () => {
		const { round } = fixture();
		const initial = prepare(round);
		expect(
			decide(round, initial, {
				action: "silent",
				reason: "材料不足，尚不能判断偏离",
			}),
		).toMatchObject({ stage: "complete", next: null });
	});
});

describe("patrol outbound recovery", () => {
	function observation() {
		const f = fixture(),
			initial = prepare(f.round);
		const snapshot = f.sampled.material?.snapshot as { snapshotId: string };
		const prepared = decide(f.round, initial, {
			action: "observation",
			text: `【偏离】\n依据: snapshot=${snapshot.snapshotId} goals=${goal.id} readings=flywheel.openPrs.returnedCount\n需要核对。`,
		});
		return { ...f, prepared };
	}
	it("blocks a substituted latest snapshot and unsafe goals files", () => {
		const { root, round, prepared } = observation();
		const path = join(root, "state/portfolio/latest.json");
		const latest = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(
			path,
			JSON.stringify({
				...latest,
				snapshotId: "replacement",
				seq: latest.seq + 1,
			}),
		);
		expect(round.resume(prepared.operationId)).toMatchObject({
			next: null,
			material: { publishBlocked: "snapshot_changed" },
		});
		writeFileSync(path, JSON.stringify(latest));
		rmSync(join(root, "memory/goals.md"));
		symlinkSync(path, join(root, "memory/goals.md"));
		expect(round.resume(prepared.operationId)).toMatchObject({
			next: null,
			material: { publishBlocked: "evidence_unavailable" },
		});
	});
	it("retains ambiguous sends for reconciliation and records late confirmed facts", () => {
		const { round, prepared, advance } = observation();
		const eventId = prepared.next?.arguments.eventId;
		const pending = round.record({
			schemaVersion: 2,
			operationId: prepared.operationId,
			expectedRevision: prepared.revision,
			tool: "lead_actions.discord_send",
			callId: "send",
			result: {
				project: "raya",
				leadId: "raya",
				target: "chat",
				eventId,
				status: "ambiguous",
			},
		});
		expect(pending).toMatchObject({
			stage: "unknown",
			next: null,
			needsReconciliation: true,
		});
		advance();
		const complete = round.record({
			schemaVersion: 2,
			operationId: pending.operationId,
			expectedRevision: pending.revision,
			tool: "lead_actions.discord_send",
			callId: "reconcile",
			result: {
				project: "raya",
				leadId: "raya",
				target: "chat",
				eventId,
				status: "sent",
				messageId: "333333333333333333",
				channelId: "222222222222222222",
			},
		});
		expect(complete).toMatchObject({
			stage: "complete",
			next: null,
			needsReconciliation: false,
		});
		expect(complete.receipts).toHaveLength(3);
		expect(round.resume(complete.operationId)).toEqual(complete);
	});
});

describe("patrol directed questions", () => {
	function question(round: BusinessRound, source = "patrol:tick") {
		return round.prepare({
			schemaVersion: 2,
			kind: "question",
			operationId: "question:patrol",
			sourceRefs: [source],
			requestId: "patrol:tick",
			requestRevision: 1,
			to: { project: "flywheel", leadId: "eng" },
			body: "缺少 checkout 读数，请确认当前进展。",
			expiresAt: start + 3600000,
			directory: {
				projectsDigest: "a".repeat(64),
				leads: [
					{
						ref: { project: "flywheel", leadId: "eng" },
						external: false,
						botUserId: "444444444444444444",
						roundtableChannel: "555555555555555555",
						displayName: "Flywheel",
					},
				],
			},
		});
	}
	it("allows questions about unavailable readings but completes only on confirmed sending", () => {
		const { round } = fixture(),
			initial = prepare(round),
			q = question(round);
		const linked = decide(round, initial, {
			action: "question",
			questionOperationId: q.operationId,
			target: { project: "flywheel", leadId: "eng" },
			evidenceRefs: ["flywheel.checkoutHead.branch"],
		});
		expect(linked).toMatchObject({
			stage: "awaiting_question",
			next: {
				tool: "current_turn",
				arguments: { action: "resume_question", operationId: q.operationId },
			},
		});
		const eventId = q.next?.arguments.eventId;
		const uncertain = round.record({
			schemaVersion: 2,
			operationId: q.operationId,
			expectedRevision: q.revision,
			tool: "lead_actions.discord_send",
			callId: "send",
			result: {
				project: "raya",
				leadId: "raya",
				target: "roundtable",
				eventId,
				status: "ambiguous",
			},
		});
		expect(round.resume(linked.operationId)).toMatchObject({
			stage: "awaiting_question",
			next: null,
			needsReconciliation: true,
		});
		round.record({
			schemaVersion: 2,
			operationId: q.operationId,
			expectedRevision: uncertain.revision,
			tool: "lead_actions.discord_send",
			callId: "reconcile",
			result: {
				project: "raya",
				leadId: "raya",
				target: "roundtable",
				eventId,
				status: "sent",
				messageId: "666666666666666666",
				channelId: "555555555555555555",
				engagement: "ready",
				threadId: "666666666666666666",
			},
		});
		const done = round.resume(linked.operationId);
		expect(done).toMatchObject({
			stage: "complete",
			next: null,
			material: { questionOutcome: "asked" },
		});
		expect(round.resume(linked.operationId)).toEqual(done);
	});
	it("records cancellation without claiming a question was sent", () => {
		const { round } = fixture(),
			initial = prepare(round),
			q = question(round);
		const linked = decide(round, initial, {
			action: "question",
			questionOperationId: q.operationId,
			target: { project: "flywheel", leadId: "eng" },
			evidenceRefs: ["flywheel.checkoutHead.branch"],
		});
		round.record({
			schemaVersion: 2,
			operationId: q.operationId,
			expectedRevision: q.revision,
			tool: "business_decision",
			callId: "cancel",
			result: {
				action: "cancel",
				reason: "后续消息已解释",
				sourceRef: "reply:later",
			},
		});
		expect(round.resume(linked.operationId)).toMatchObject({
			stage: "complete",
			next: null,
			material: {
				questionOutcome: "cancelled",
				questionReceipt: { messageId: null },
			},
		});
	});
	it("rejects unrelated questions and nonexistent or cross-target evidence", () => {
		const { round } = fixture(),
			initial = prepare(round),
			q = question(round, "different:round");
		expect(() =>
			decide(round, initial, {
				action: "question",
				questionOperationId: q.operationId,
				target: { project: "flywheel", leadId: "eng" },
				evidenceRefs: ["flywheel.checkoutHead.branch"],
			}),
		).toThrow(/question source/);
		const f = fixture(),
			p = prepare(f.round),
			bound = question(f.round);
		for (const evidenceRefs of [
			["raya.checkoutHead.branch"],
			["flywheel.missing.leaf"],
		]) {
			expect(() =>
				decide(f.round, p, {
					action: "question",
					questionOperationId: bound.operationId,
					target: { project: "flywheel", leadId: "eng" },
					evidenceRefs,
				}),
			).toThrow(/question evidence/);
		}
	});
});
