import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BusinessRound } from "./business-round.js";

const roots: string[] = [];
const head = "a".repeat(40),
	path = "summaries/flywheel/2026-09-14--eng--01.md";
const input = {
	schemaVersion: 2,
	kind: "summary",
	operationId: "summary:round:pr:42",
	roundId: "summary-absorption:2026-09-14T20:00:00.000Z",
	mainCommit: "b".repeat(40),
	pr: 42,
	head,
	project: "flywheel",
	lead: "eng",
	completeDiff: true,
	files: [
		{
			path,
			content: "# Facts\nImplementation is ready.\n# Judgment\nWait for QA.",
		},
	],
};
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "summary-workflow-"));
	roots.push(root);
	const round = new BusinessRound(root);
	round.prepare({
		schemaVersion: 2,
		kind: "summary_round",
		roundId: input.roundId,
		mainCommit: input.mainCommit,
		sourceStatus: "available",
		inventory: [
			{
				pr: input.pr,
				head: input.head,
				project: input.project,
				lead: input.lead,
			},
		],
		frozenEvent: {
			round_ledger: "ok",
			producers: [],
			absent: [],
			undelivered: [],
			delivery_unknown: [],
			report_line: "本轮 0/0 份已交",
		},
	});
	round.record({
		schemaVersion: 2,
		operationId: `summary-round:${input.roundId}`,
		expectedRevision: 2,
		tool: "current_turn",
		callId: "fixture-source-read",
		result: {
			canonicalStatus: "available",
			canonicalMainCommit: input.mainCommit,
			canonicalMerged: [],
			memory: { status: "clean", commit: input.mainCommit, provenance: [] },
		},
	});
	return { root, round };
}
function record(
	round: BusinessRound,
	revision: number,
	tool: string,
	result: object,
) {
	return round.record({
		schemaVersion: 2,
		operationId: input.operationId,
		expectedRevision: revision,
		tool,
		callId: `call-${revision}`,
		result,
	});
}
const understood = {
	pr: 42,
	head,
	decision: "understood",
	understanding: "The implementation is ready but QA still gates shipping.",
	evidenceRefs: [`${path}@${head}`],
};
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("summary understanding and merge workflow", () => {
	it("requires understanding and a fresh head check before issuing expected-head merge", () => {
		const { round } = fixture();
		expect(round.prepare(input)).toMatchObject({
			stage: "reviewing",
			next: { tool: "current_turn" },
		});
		expect(() =>
			record(round, 1, "flywheel-comm", {
				ok: true,
				action: "merged",
				verifiedHeadSha: head,
			}),
		).toThrow();
		expect(record(round, 1, "current_turn", understood)).toMatchObject({
			stage: "head_check",
			next: { tool: "gh" },
		});
		const ready = record(round, 2, "gh", {
			number: 42,
			headRefOid: head,
			state: "OPEN",
		});
		expect(ready).toMatchObject({
			stage: "merge_ready",
			next: {
				tool: "flywheel-comm",
				arguments: {
					argv: [
						"summary",
						"merge",
						"--repo",
						"xrliAnnie/raya",
						"--pr",
						"42",
						"--round",
						input.roundId,
						"--expected-head",
						head,
					],
				},
			},
		});
		expect(
			record(round, 3, "flywheel-comm", {
				ok: true,
				action: "merged",
				verifiedHeadSha: head,
				fileCount: 1,
				files: [path],
				projects: ["flywheel"],
			}),
		).toMatchObject({ stage: "merged", next: null });
	});
	it("blocks changed heads and foreign evidence references", () => {
		const { round } = fixture();
		round.prepare(input);
		expect(() =>
			record(round, 1, "current_turn", {
				...understood,
				evidenceRefs: ["unrelated"],
			}),
		).toThrow(/evidence/);
		record(round, 1, "current_turn", understood);
		expect(
			record(round, 2, "gh", {
				number: 42,
				headRefOid: "c".repeat(40),
				state: "OPEN",
			}),
		).toMatchObject({ stage: "head_changed", next: null });
	});
	it("rejects incomplete or out-of-scope diff material", () => {
		for (const change of [
			{ completeDiff: false },
			{ files: [{ path: "package.json", content: "{}" }] },
			{ files: [] },
		])
			expect(() => fixture().round.prepare({ ...input, ...change })).toThrow();
	});
	it("keeps unclear material open and requires substantive understanding", () => {
		const { round } = fixture();
		round.prepare(input);
		expect(() =>
			record(round, 1, "current_turn", { ...understood, understanding: "" }),
		).toThrow();
		expect(
			record(round, 1, "current_turn", {
				...understood,
				decision: "question",
				understanding: "Need QA status.",
			}),
		).toMatchObject({ stage: "question_needed", next: null });
	});
	it("reconciles an uncertain merge against canonical GitHub state after restart", () => {
		const { root, round } = fixture();
		round.prepare(input);
		record(round, 1, "current_turn", understood);
		record(round, 2, "gh", { number: 42, headRefOid: head, state: "OPEN" });
		expect(
			record(round, 3, "flywheel-comm", { status: "unknown" }),
		).toMatchObject({ stage: "reconciling", next: { tool: "gh" } });
		const reopened = new BusinessRound(root);
		expect(
			record(reopened, 4, "gh", {
				number: 42,
				headRefOid: head,
				state: "MERGED",
			}),
		).toMatchObject({ stage: "merged", next: null });
		expect(reopened.prepare(input)).toMatchObject({ stage: "merged" });
	});
	it("requires evidence for every reviewed file and rejects missing Judgment", () => {
		const { round } = fixture();
		const second = "summaries/flywheel/2026-09-14--eng--02.md";
		round.prepare({
			...input,
			files: [
				...input.files,
				{ path: second, content: input.files[0]?.content },
			],
		});
		expect(() => record(round, 1, "current_turn", understood)).toThrow(
			/evidence/,
		);
		const other = fixture().round;
		other.prepare({
			...input,
			files: [{ path, content: "# Facts\nReady.\n# Judgment\n" }],
		});
		expect(() => record(other, 1, "current_turn", understood)).toThrow(
			/Judgment/,
		);
	});
});
