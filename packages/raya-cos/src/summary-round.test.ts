import {
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BusinessRound } from "./business-round.js";
import { OperationStore } from "./operation-store.js";

const roots: string[] = [];
const roundId = "summary-absorption:2026-09-14T20:00:00.000Z";
const head = "a".repeat(40),
	mainCommit = "b".repeat(40);
const input = {
	schemaVersion: 2,
	kind: "summary_round",
	roundId,
	mainCommit,
	sourceStatus: "available",
	inventory: [{ pr: 42, head, project: "flywheel", lead: "eng" }],
	frozenEvent: {
		round_ledger: "ok",
		producers: [],
		absent: [],
		undelivered: [],
		delivery_unknown: [],
		report_line: "本轮 0/0 份已交",
	},
};
const summary = {
	schemaVersion: 2,
	kind: "summary",
	operationId: "summary:pr42",
	roundId,
	mainCommit,
	pr: 42,
	head,
	project: "flywheel",
	lead: "eng",
	completeDiff: true,
	files: [
		{
			path: "summaries/flywheel/2026-09-14--eng--01.md",
			content: "# Facts\nReady\n# Judgment\nWait",
		},
	],
};
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "summary-round-"));
	roots.push(root);
	return { root, round: new BusinessRound(root) };
}
function reconcile(round: BusinessRound) {
	const operation = round
		.status()
		.operations.find((item) => item.operationId === `summary-round:${roundId}`);
	if (!operation) throw new Error("missing fixture round");
	round.record({
		schemaVersion: 2,
		operationId: operation.operationId,
		expectedRevision: operation.revision,
		tool: "current_turn",
		callId: "fixture-read",
		result: {
			canonicalStatus: "available",
			canonicalMainCommit: mainCommit,
			canonicalMerged: [],
			memory: { status: "clean", commit: mainCommit, provenance: [] },
		},
	});
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("frozen summary round registration", () => {
	it("refuses a per-PR operation without its frozen round inventory", () => {
		expect(() => fixture().round.prepare(summary)).toThrow(/round.*registered/);
	});
	it("writes the legacy round before exposing PR work and replay does not duplicate", () => {
		const { root, round } = fixture();
		expect(round.prepare(input)).toMatchObject({
			stage: "registered",
			next: { tool: "current_turn" },
		});
		const path = join(root, "state/summary-merge-receipts.jsonl");
		expect(JSON.parse(readFileSync(path, "utf8").trim())).toMatchObject({
			type: "round",
			roundId,
			reviewedPrs: [42],
		});
		reconcile(round);
		expect(round.prepare(summary)).toMatchObject({ stage: "reviewing" });
		new BusinessRound(root).prepare(input);
		expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
		expect(() =>
			round.prepare({ ...input, mainCommit: "c".repeat(40) }),
		).toThrow(/binding/);
		expect(() => round.prepare({ ...summary, head: "c".repeat(40) })).toThrow(
			/inventory/,
		);
	});
	it("keeps empty rounds registered with the exact frozen report line", () => {
		const { round } = fixture();
		const result = round.prepare({ ...input, inventory: [] });
		expect(result).toMatchObject({
			stage: "registered",
			material: { frozenEvent: input.frozenEvent, inventory: [] },
		});
		expect(() =>
			fixture().round.prepare({
				...input,
				sourceStatus: "unavailable",
				inventory: [],
			}),
		).toThrow(/unavailable/);
	});
	it("preserves corrupt or symlinked legacy ledgers and does not authorize PR work", () => {
		for (const mode of ["corrupt", "symlink"]) {
			const { root, round } = fixture();
			const path = join(root, "state/summary-merge-receipts.jsonl");
			if (mode === "corrupt") writeFileSync(path, "{bad\n");
			else {
				writeFileSync(join(root, "target"), "unchanged");
				symlinkSync(join(root, "target"), path);
			}
			expect(() => round.prepare(input)).toThrow();
			expect(() => round.prepare(summary)).toThrow(/round.*registered/);
			expect(readFileSync(path, "utf8")).toBe(
				mode === "corrupt" ? "{bad\n" : "unchanged",
			);
		}
	});
	it("recovers after legacy append but before the registered state commit", () => {
		const { root, round } = fixture();
		const original = OperationStore.prototype.commit;
		const fault = vi
			.spyOn(OperationStore.prototype, "commit")
			.mockImplementation(function (input, revision) {
				if (input.kind === "summary_round" && input.stage === "registered")
					throw new Error("injected registered write failure");
				return original.call(this, input, revision);
			});
		try {
			expect(() => round.prepare(input)).toThrow(/injected/);
		} finally {
			fault.mockRestore();
		}
		expect(() => round.prepare(summary)).toThrow(/not registered/);
		const reopened = new BusinessRound(root);
		expect(reopened.prepare(input)).toMatchObject({ stage: "registered" });
		expect(
			readFileSync(join(root, "state/summary-merge-receipts.jsonl"), "utf8")
				.trim()
				.split("\n"),
		).toHaveLength(1);
		reconcile(reopened);
		expect(reopened.prepare(summary)).toMatchObject({ stage: "reviewing" });
	});
	it("requires clean canonical provenance reconciliation before new unread work", () => {
		const { round } = fixture();
		round.prepare(input);
		expect(() => round.prepare(summary)).toThrow(/reconciliation/);
	});
	it("writes legacy question intent before sending and projects only a real sent receipt", () => {
		const { root, round } = fixture();
		round.prepare(input);
		reconcile(round);
		const review = round.prepare(summary);
		round.record({
			schemaVersion: 2,
			operationId: review.operationId,
			expectedRevision: review.revision,
			tool: "current_turn",
			callId: "understand",
			result: {
				pr: 42,
				head,
				decision: "question",
				understanding: "Need the owning release",
				evidenceRefs: [`${summary.files[0]?.path}@${head}`],
			},
		});
		const q = round.prepare(questionInput());
		const ledger = () =>
			readFileSync(join(root, "state/summary-merge-receipts.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		expect(ledger().filter((row) => row.type === "question")).toEqual([
			expect.objectContaining({
				roundId,
				pr: 42,
				status: "posting",
				eventId: `question:${roundId}:42:1`,
			}),
		]);
		const ambiguous = round.record({
			schemaVersion: 2,
			operationId: q.operationId,
			expectedRevision: q.revision,
			tool: "lead_actions.discord_send",
			callId: "ambiguous",
			result: {
				project: "raya",
				leadId: "raya",
				target: "roundtable",
				eventId: `question:${roundId}:42:1`,
				status: "ambiguous",
				messageId: "111111111111111111",
				channelId: "222222222222222222",
			},
		});
		expect(ledger().filter((row) => row.status === "posted")).toHaveLength(0);
		round.record({
			schemaVersion: 2,
			operationId: q.operationId,
			expectedRevision: ambiguous.revision,
			tool: "lead_actions.discord_send",
			callId: "send",
			result: {
				project: "raya",
				leadId: "raya",
				target: "roundtable",
				eventId: `question:${roundId}:42:1`,
				status: "sent",
				messageId: "111111111111111111",
				channelId: "222222222222222222",
				threadId: "111111111111111111",
				engagement: "ready",
			},
		});
		round.resume(q.operationId);
		expect(ledger().filter((row) => row.status === "posted")).toEqual([
			expect.objectContaining({
				roundId,
				pr: 42,
				messageId: "111111111111111111",
			}),
		]);
	});
	it("preserves a legacy posting with unknown delivery instead of offering a new send", () => {
		const { root, round } = fixture();
		round.prepare(input);
		reconcile(round);
		round.prepare(summary);
		const path = join(root, "state/summary-merge-receipts.jsonl");
		writeFileSync(
			path,
			readFileSync(path, "utf8") +
				JSON.stringify({
					type: "question",
					roundId,
					pr: 42,
					status: "posting",
					ts: "2026-09-14T20:00:00.000Z",
				}) +
				"\n",
		);
		const q = round.prepare(questionInput());
		expect(q).toMatchObject({
			stage: "unknown",
			next: null,
			needsReconciliation: true,
		});
		expect(round.prepare(questionInput()).next).toBeNull();
	});
	it("recovers registration after posting was appended but the prepared state failed", () => {
		const { root, round } = fixture();
		round.prepare(input);
		reconcile(round);
		round.prepare(summary);
		const original = OperationStore.prototype.commit;
		const fault = vi
			.spyOn(OperationStore.prototype, "commit")
			.mockImplementation(function (value, revision) {
				if (value.kind === "question" && value.stage === "prepared")
					throw new Error("injected prepared failure");
				return original.call(this, value, revision);
			});
		try {
			expect(() => round.prepare(questionInput())).toThrow(/injected/);
		} finally {
			fault.mockRestore();
		}
		expect(
			round
				.status()
				.operations.find(
					(op) => op.operationId === questionInput().operationId,
				),
		).toMatchObject({ stage: "registering", next: null });
		const resumed = new BusinessRound(root).prepare(questionInput());
		expect(resumed.stage).toBe("prepared");
		const rows = readFileSync(
			join(root, "state/summary-merge-receipts.jsonl"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(
			rows.filter((row) => row.type === "question" && row.status === "posting"),
		).toHaveLength(1);
	});
});

function questionInput() {
	return {
		schemaVersion: 2,
		kind: "question",
		operationId: `question:${roundId}:42:1`,
		requestId: `${roundId}:42`,
		requestRevision: 1,
		sourceRefs: [summary.operationId],
		to: { project: "flywheel", leadId: "eng" },
		body: "Which release owns this?",
		expiresAt: 4102444800000,
		directory: {
			projectsDigest: "a".repeat(64),
			leads: [
				{
					ref: { project: "flywheel", leadId: "eng" },
					displayName: "Engineering",
					botUserId: "333333333333333333",
					roundtableChannel: "222222222222222222",
					external: false,
				},
			],
		},
	};
}
