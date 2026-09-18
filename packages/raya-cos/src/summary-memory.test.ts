import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BusinessRound } from "./business-round.js";
import { OperationStore } from "./operation-store.js";
import { assertSummaryRegistered } from "./summary-round.js";

const roots: string[] = [];
const roundId = "summary-absorption:2026-09-14T20:00:00.000Z",
	head = "a".repeat(40),
	baseCommit = "b".repeat(40),
	path = "summaries/flywheel/2026-09-13--eng--01.md";
const source = {
	pr: 41,
	head,
	project: "flywheel",
	roundId: "summary-absorption:2026-09-13T20:00:00.000Z",
	path,
};
const baseBody = "# Memory\n\nExisting commitments stay intact.\n";
function record(
	round: BusinessRound,
	revision: number,
	result: object,
	tool = "current_turn",
) {
	return round.record({
		schemaVersion: 2,
		operationId: `summary-round:${roundId}`,
		expectedRevision: revision,
		tool,
		callId: `current-turn-${revision}`,
		result,
	});
}
function fixture(inventory: object[] = []) {
	const root = mkdtempSync(join(tmpdir(), "summary-memory-"));
	roots.push(root);
	const round = new BusinessRound(root);
	const prepared = round.prepare({
		schemaVersion: 2,
		kind: "summary_round",
		roundId,
		mainCommit: baseCommit,
		sourceStatus: "available",
		inventory,
		frozenEvent: {
			round_ledger: "ok",
			producers: [],
			absent: [],
			undelivered: [],
			delivery_unknown: [],
			report_line: "本轮 0/0 份已交",
		},
	});
	const observed = record(round, prepared.revision, {
		canonicalStatus: "available",
		canonicalMainCommit: baseCommit,
		canonicalMerged: [{ ...source, files: [path] }],
		memory: {
			status: "clean",
			commit: baseCommit,
			bodySha256: createHash("sha256").update(baseBody).digest("hex"),
			provenance: [],
		},
	});
	return { root, round, revision: observed.revision };
}
const draft = {
	action: "memory_plan",
	baseCommit,
	baseBody,
	entries: [
		{
			...source,
			understanding: "Implementation is ready; QA still gates shipping.",
		},
	],
};
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("summary memory draft", () => {
	it("preserves existing content and freezes provenance and expected base before any write", () => {
		const { round, revision } = fixture();
		const planned = record(round, revision, draft);
		expect(planned.material).toMatchObject({
			progress: {
				memoryDraft: {
					baseCommit,
					baseSha256: createHash("sha256").update(baseBody).digest("hex"),
					stage: "draft",
				},
			},
		});
		const body = String(
			(planned.material?.progress as { memoryDraft: { body: string } })
				.memoryDraft.body,
		);
		expect(body.startsWith(baseBody)).toBe(true);
		expect(body).toContain(path);
		expect(body).toContain(head);
		expect(body).toContain(source.roundId);
		expect(planned.next).toMatchObject({
			tool: "current_turn",
			arguments: { task: expect.stringContaining("draft") },
		});
	});
	it("rejects stale bases, empty understanding and foreign provenance", () => {
		const { round, revision } = fixture();
		for (const input of [
			{ ...draft, baseCommit: "c".repeat(40) },
			{ ...draft, entries: [{ ...draft.entries[0], understanding: "" }] },
			{ ...draft, entries: [{ ...draft.entries[0], head: "c".repeat(40) }] },
		])
			expect(() => record(round, revision, input)).toThrow();
	});
	it("preserves a frozen base on replay and rejects replacing a prepared entry", () => {
		const { root, round, revision } = fixture();
		const planned = record(round, revision, draft);
		const reopened = new BusinessRound(root);
		const replay = record(reopened, planned.revision, draft);
		expect(replay.material).toMatchObject({
			progress: { memoryDraft: { stage: "draft" } },
		});
		expect(() =>
			record(reopened, replay.revision, { ...draft, baseBody: "replacement" }),
		).toThrow(/base/);
		expect(() =>
			record(reopened, replay.revision, {
				...draft,
				entries: [{ ...draft.entries[0], understanding: "replacement" }],
			}),
		).toThrow(/entry/);
	});
	it("freezes finalization and reconciles an unknown commit without offering another write", () => {
		const { root, round, revision } = fixture();
		const planned = record(round, revision, draft);
		const finalized = record(round, planned.revision, {
			action: "memory_finalize",
		});
		expect(finalized.material).toMatchObject({
			progress: { memoryDraft: { stage: "prepared" } },
		});
		const unknown = record(round, finalized.revision, {
			action: "memory_result",
			outcome: "unknown",
		});
		expect(unknown.next).toMatchObject({
			arguments: { task: expect.stringContaining("read-only") },
		});
		const bodyHash = (
			unknown.material?.progress as { memoryDraft: { bodySha256: string } }
		).memoryDraft.bodySha256;
		const reopened = new BusinessRound(root);
		const committed = record(reopened, unknown.revision, {
			action: "memory_result",
			outcome: "committed",
			commit: "c".repeat(40),
			parent: baseCommit,
			bodySha256: bodyHash,
			changedPaths: ["MEMORY.md"],
			message: `Absorb summaries ${roundId}`,
		});
		expect(committed.material).toMatchObject({
			progress: { memoryDraft: { stage: "committed", commit: "c".repeat(40) } },
		});
		expect(() => record(reopened, committed.revision, draft)).toThrow();
		const failedPush = record(reopened, committed.revision, {
			action: "memory_push",
			commit: "c".repeat(40),
			outcome: "failed",
			reason: "network unavailable",
		});
		expect(failedPush.material).toMatchObject({
			progress: { memoryDraft: { stage: "committed", push: "failed" } },
		});
		expect(
			record(reopened, failedPush.revision, {
				action: "memory_push",
				commit: "c".repeat(40),
				outcome: "pushed",
			}).material,
		).toMatchObject({
			progress: { memoryDraft: { stage: "committed", push: "pushed" } },
		});
	});
	it("rejects unrelated commit content and mismatched parent", () => {
		const { round, revision } = fixture();
		const planned = record(round, revision, draft);
		const finalized = record(round, planned.revision, {
			action: "memory_finalize",
		});
		const bodyHash = (
			finalized.material?.progress as { memoryDraft: { bodySha256: string } }
		).memoryDraft.bodySha256;
		const valid = {
			action: "memory_result",
			outcome: "committed",
			commit: "c".repeat(40),
			parent: baseCommit,
			bodySha256: bodyHash,
			changedPaths: ["MEMORY.md"],
			message: `Absorb summaries ${roundId}`,
		};
		for (const bad of [
			{ ...valid, parent: "d".repeat(40) },
			{ ...valid, bodySha256: "0".repeat(64) },
			{ ...valid, changedPaths: ["MEMORY.md", "other.txt"] },
		])
			expect(() => record(round, finalized.revision, bad)).toThrow();
	});

	it("does not finalize while a frozen PR has no review outcome", () => {
		const { round, revision } = fixture([
			{ pr: 42, head, project: "flywheel", lead: "eng" },
		]);
		const planned = record(round, revision, draft);
		expect(() =>
			record(round, planned.revision, { action: "memory_finalize" }),
		).toThrow(/inventory/);
	});
	it("does not omit historical provenance gaps from the final commit", () => {
		const { round, revision } = fixture();
		const observed = record(round, revision, {
			canonicalStatus: "available",
			canonicalMainCommit: baseCommit,
			canonicalMerged: [
				{ ...source, files: [path, "summaries/flywheel/second.md"] },
			],
			memory: {
				status: "clean",
				commit: baseCommit,
				bodySha256: createHash("sha256").update(baseBody).digest("hex"),
				provenance: [],
			},
		});
		const planned = record(round, observed.revision, draft);
		expect(() =>
			record(round, planned.revision, { action: "memory_finalize" }),
		).toThrow(/provenance/);
	});
	it("admits unread work only after every historical gap has a frozen draft on the clean observed base", () => {
		const item = { pr: 42, head, project: "flywheel", lead: "eng" };
		const { root, round, revision } = fixture([item]);
		const store = new OperationStore(root);
		const snapshot = { ...item, roundId, mainCommit: baseCommit };
		expect(() => assertSummaryRegistered(store, snapshot)).toThrow(
			/provenance/,
		);
		const planned = record(round, revision, draft);
		expect(planned.material).toMatchObject({
			progress: {
				memoryDraft: { entries: [{ origin: "historical" }], stage: "draft" },
				reconciliation: { status: "memory_needed" },
			},
		});
		expect(() => assertSummaryRegistered(store, snapshot)).not.toThrow();
		record(round, planned.revision, {
			canonicalStatus: "available",
			canonicalMainCommit: baseCommit,
			canonicalMerged: [{ ...source, files: [path] }],
			memory: { status: "dirty", commit: baseCommit, provenance: [] },
		});
		expect(() => assertSummaryRegistered(store, snapshot)).toThrow(
			/provenance/,
		);
	});
	it("offers grouped presentation after the frozen memory commit is pushed", () => {
		const { round, revision } = fixture();
		const planned = record(round, revision, draft);
		const finalized = record(round, planned.revision, {
			action: "memory_finalize",
		});
		const bodySha256 = (
			finalized.material?.progress as { memoryDraft: { bodySha256: string } }
		).memoryDraft.bodySha256;
		const committed = record(round, finalized.revision, {
			action: "memory_result",
			outcome: "committed",
			commit: "c".repeat(40),
			parent: baseCommit,
			bodySha256,
			changedPaths: ["MEMORY.md"],
			message: `Absorb summaries ${roundId}`,
		});
		const pushed = record(round, committed.revision, {
			action: "memory_push",
			outcome: "pushed",
			commit: "c".repeat(40),
		});
		expect(pushed).toMatchObject({
			stage: "registered",
			next: {
				arguments: { task: expect.stringContaining("summary_presentation") },
			},
		});
		expect(pushed.next?.arguments.task).not.toContain("round report");
	});
	it("keeps the original memory commit recoverable after a failed presentation", () => {
		const { round, revision } = fixture();
		const planned = record(round, revision, draft);
		const finalized = record(round, planned.revision, {
			action: "memory_finalize",
		});
		const bodySha256 = (
			finalized.material?.progress as { memoryDraft: { bodySha256: string } }
		).memoryDraft.bodySha256;
		const committed = record(round, finalized.revision, {
			action: "memory_result",
			outcome: "committed",
			commit: "c".repeat(40),
			parent: baseCommit,
			bodySha256,
			changedPaths: ["MEMORY.md"],
			message: `Absorb summaries ${roundId}`,
		});
		const failed = record(round, committed.revision, {
			action: "memory_push",
			outcome: "failed",
			commit: "c".repeat(40),
		});
		const presented = record(
			round,
			failed.revision,
			{
				status: "recorded",
				member: {
					projectName: "raya",
					leadId: "raya",
					groupId: "group-1",
					roundId,
					sourceSeq: 42,
					slotStartMs: Date.parse(roundId.slice("summary-absorption:".length)),
					businessState: "failed",
					outcome: { errorCode: "round_processing_failed" },
					evidenceRef: "cos:memory:pending",
				},
			},
			"lead_actions.summary_presentation",
		);
		expect(presented.stage).toBe("presented_pending");
		expect(presented.next?.arguments.task).toContain("push");
		const recovered = record(round, presented.revision, {
			action: "memory_push",
			outcome: "pushed",
			commit: "c".repeat(40),
		});
		expect(recovered.stage).toBe("complete");
		expect(recovered.next).toBeNull();
	});
	it("reconciles prepared and unknown memory commits after a failed presentation", () => {
		for (const initialStage of ["prepared", "unknown"]) {
			const { round, revision } = fixture();
			const planned = record(round, revision, draft);
			const finalized = record(round, planned.revision, {
				action: "memory_finalize",
			});
			const bodySha256 = (
				finalized.material?.progress as { memoryDraft: { bodySha256: string } }
			).memoryDraft.bodySha256;
			const unresolved =
				initialStage === "unknown"
					? record(round, finalized.revision, {
							action: "memory_result",
							outcome: "unknown",
						})
					: finalized;
			const presented = record(
				round,
				unresolved.revision,
				{
					status: "recorded",
					member: {
						projectName: "raya",
						leadId: "raya",
						groupId: `group-${initialStage}`,
						roundId,
						sourceSeq: 42,
						slotStartMs: Date.parse(
							roundId.slice("summary-absorption:".length),
						),
						businessState: "failed",
						outcome: { errorCode: "memory_commit_unresolved" },
						evidenceRef: `cos:memory:${initialStage}`,
					},
				},
				"lead_actions.summary_presentation",
			);
			expect(presented).toMatchObject({
				stage: "presented_pending",
				next: { arguments: { task: expect.stringContaining("read-only") } },
			});
			expect(presented.needsReconciliation).toBe(initialStage === "unknown");
			const committed = record(round, presented.revision, {
				action: "memory_result",
				outcome: "committed",
				commit: "c".repeat(40),
				parent: baseCommit,
				bodySha256,
				changedPaths: ["MEMORY.md"],
				message: `Absorb summaries ${roundId}`,
			});
			expect(committed).toMatchObject({
				stage: "presented_pending",
				next: { arguments: { task: expect.stringContaining("push") } },
			});
			expect(
				record(round, committed.revision, {
					action: "memory_push",
					outcome: "pushed",
					commit: "c".repeat(40),
				}),
			).toMatchObject({ stage: "complete", next: null });
		}
	});
});
