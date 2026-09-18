import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BusinessRound } from "./business-round.js";
import { OperationStore } from "./operation-store.js";

const roots: string[] = [];
const roundId = "summary-absorption:2026-09-14T20:00:00.000Z";
const commit = "a".repeat(40);
const summaryRoundInput = {
	schemaVersion: 2,
	kind: "summary_round",
	roundId,
	mainCommit: commit,
	sourceStatus: "available",
	inventory: [],
	frozenEvent: {
		round_ledger: "ok",
		producers: [],
		absent: ["eng"],
		undelivered: [],
		delivery_unknown: [],
		report_line: "本轮 0/1 份已交；eng 缺交",
	},
};
function preparedFixture() {
	const root = mkdtempSync(join(tmpdir(), "summary-report-"));
	roots.push(root);
	const round = new BusinessRound(root);
	const start = round.prepare(summaryRoundInput);
	return { root, round, start };
}
function fixture() {
	const { root, round, start } = preparedFixture();
	const ready = record(round, start.revision, {
		canonicalStatus: "available",
		canonicalMainCommit: commit,
		canonicalMerged: [],
		memory: { status: "clean", commit, provenance: [] },
	});
	return { root, round, ready };
}
function presentationMember(overrides: Record<string, unknown> = {}) {
	return {
		projectName: "raya",
		leadId: "raya",
		roundId,
		groupId: "group-1",
		sourceSeq: 42,
		slotStartMs: Date.parse(roundId.slice("summary-absorption:".length)),
		businessState: "complete",
		outcome: { substantive: false },
		evidenceRef: "cos:round:empty",
		...overrides,
	};
}
function legacyPrepareInput() {
	const eventId = `summary:${roundId}:report`;
	return {
		schemaVersion: 2,
		kind: "announcement",
		operationId: eventId,
		sourceRefs: [roundId],
		target: "chat",
		eventId,
		text: `roundId: ${roundId}; 0/1 received`,
	};
}
function forceLegacyReporting(root: string, prepareInput: object) {
	const store = new OperationStore(root);
	const current = store.read(`summary-round:${roundId}`);
	if (!current) throw new Error("missing summary round fixture");
	const material = current.material as Record<string, unknown>;
	const progress = material.progress as Record<string, unknown>;
	store.commit(
		{
			...current,
			stage: "reporting",
			material: {
				...material,
				progress: { ...progress, report: { prepareInput } },
			},
		},
		current.revision,
	);
}
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
		callId: `turn-${revision}`,
		result,
	});
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("summary round reporting", () => {
	it("records an empty round without preparing any founder-visible announcement", () => {
		const { root, round, ready } = fixture();
		expect(() =>
			record(round, ready.revision, { action: "report_prepare" }),
		).toThrow(/disabled/);
		const complete = record(
			round,
			ready.revision,
			{
				status: "recorded",
				member: presentationMember(),
			},
			"lead_actions.summary_presentation",
		);
		expect(complete).toMatchObject({
			stage: "complete",
			next: null,
			material: {
				progress: {
					presentation: {
						memoryStatus: "unchanged",
						reviewed: 0,
						absorbed: 0,
						questionNeeded: 0,
						groupId: "group-1",
					},
				},
			},
		});
		const rows = readFileSync(
			join(root, "state/summary-merge-receipts.jsonl"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows.filter((row) => row.type === "report")).toEqual([]);
		expect(rows.filter((row) => row.type === "presentation_record")).toEqual([
			expect.objectContaining({
				type: "presentation_record",
				roundId,
				groupId: "group-1",
			}),
		]);
	});
	it("records a failed member without requiring completed round business state", () => {
		const { root, round, start } = preparedFixture();
		const complete = record(
			round,
			start.revision,
			{
				status: "recorded",
				member: presentationMember({
					businessState: "failed",
					outcome: { errorCode: "round_processing_failed" },
					evidenceRef: "cos:round:failed",
				}),
			},
			"lead_actions.summary_presentation",
		);
		expect(complete).toMatchObject({
			stage: "complete",
			needsReconciliation: false,
			material: {
				progress: {
					presentation: {
						businessState: "failed",
						evidenceRef: "cos:round:failed",
					},
				},
			},
		});
		const rows = readFileSync(
			join(root, "state/summary-merge-receipts.jsonl"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows.at(-1)).toMatchObject({
			type: "presentation_record",
			businessState: "failed",
		});
	});
	it("retires a legacy reporting announcement and converges on grouped presentation", () => {
		const { root, round } = fixture();
		const prepareInput = legacyPrepareInput();
		const eventId = prepareInput.eventId;
		expect(round.prepare(prepareInput)).toMatchObject({
			stage: "prepared",
			next: { tool: "lead_actions.discord_send" },
		});
		forceLegacyReporting(root, prepareInput);

		const recovered = round.prepare(summaryRoundInput);
		expect(recovered).toMatchObject({
			stage: "registered",
			next: {
				arguments: { task: expect.stringContaining("summary_presentation") },
			},
		});
		expect(round.resume(eventId)).toMatchObject({
			stage: "cancelled",
			next: null,
		});
		expect(
			record(
				round,
				recovered.revision,
				{ status: "recorded", member: presentationMember() },
				"lead_actions.summary_presentation",
			),
		).toMatchObject({ stage: "complete" });
	});
	it("preserves queued delivery uncertainty while retiring its resend path", () => {
		const { root, round } = fixture();
		const prepareInput = legacyPrepareInput();
		const prepared = round.prepare(prepareInput);
		expect(
			round.record({
				schemaVersion: 2,
				operationId: prepareInput.operationId,
				expectedRevision: prepared.revision,
				tool: "lead_actions.discord_send",
				callId: "legacy-queued",
				result: {
					project: "raya",
					leadId: "raya",
					target: "chat",
					eventId: prepareInput.eventId,
					status: "pending",
				},
			}),
		).toMatchObject({ stage: "pending" });
		forceLegacyReporting(root, prepareInput);
		round.prepare(summaryRoundInput);
		expect(round.resume(prepareInput.operationId)).toMatchObject({
			stage: "unknown",
			needsReconciliation: true,
			next: null,
		});
	});
	it("marks an already delivered legacy report as excluded from new visible text", () => {
		const { root, round } = fixture();
		const prepareInput = legacyPrepareInput();
		const prepared = round.prepare(prepareInput);
		expect(
			round.record({
				schemaVersion: 2,
				operationId: prepareInput.operationId,
				expectedRevision: prepared.revision,
				tool: "lead_actions.discord_send",
				callId: "legacy-sent",
				result: {
					project: "raya",
					leadId: "raya",
					target: "chat",
					eventId: prepareInput.eventId,
					status: "sent",
					messageId: "12345678901234567",
					channelId: "76543210987654321",
				},
			}),
		).toMatchObject({ stage: "complete" });
		forceLegacyReporting(root, prepareInput);
		const recovered = round.prepare(summaryRoundInput);
		expect(recovered.next?.arguments.task).toContain("already delivered");
		expect(recovered.next?.arguments.task).toContain("exclude");
		const unavailable = record(round, recovered.revision, {
			canonicalStatus: "unavailable",
			memory: { status: "unavailable" },
		});
		expect(unavailable).toMatchObject({
			needsReconciliation: true,
			next: { arguments: { task: expect.stringContaining("Reconcile") } },
		});
		expect(unavailable.next?.arguments.task).not.toContain("already delivered");
		expect(round.resume(prepareInput.operationId)).toMatchObject({
			stage: "complete",
		});
	});
	it("replays a committed presentation into the legacy ledger after append failure", () => {
		const { root, round, ready } = fixture();
		const ledger = join(root, "state/summary-merge-receipts.jsonl");
		const validLedger = readFileSync(ledger, "utf8");
		writeFileSync(ledger, validLedger.trimEnd());
		expect(() =>
			record(
				round,
				ready.revision,
				{ status: "recorded", member: presentationMember() },
				"lead_actions.summary_presentation",
			),
		).toThrow(/incomplete tail/);
		expect(
			round
				.status()
				.operations.find(
					(operation) => operation.operationId === `summary-round:${roundId}`,
				),
		).toMatchObject({ stage: "complete" });

		writeFileSync(ledger, validLedger);
		expect(round.resume(`summary-round:${roundId}`)).toMatchObject({
			stage: "complete",
		});
		const rows = readFileSync(ledger, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(
			rows.filter((row) => row.type === "presentation_record"),
		).toHaveLength(1);
	});
	it("hashes presentation members canonically and validates the Bridge receipt shape", () => {
		const first = fixture();
		const second = fixture();
		const ordered = presentationMember();
		const reversed = Object.fromEntries(Object.entries(ordered).reverse());
		const firstView = record(
			first.round,
			first.ready.revision,
			{ status: "recorded", member: ordered },
			"lead_actions.summary_presentation",
		);
		const secondView = record(
			second.round,
			second.ready.revision,
			{ status: "recorded", member: reversed },
			"lead_actions.summary_presentation",
		);
		const digest = (view: typeof firstView) =>
			(
				view.material?.progress as {
					presentation: { memberDigest: string };
				}
			).presentation.memberDigest;
		expect(digest(firstView)).toBe(digest(secondView));
		const malformed = fixture();
		expect(() =>
			record(
				malformed.round,
				malformed.ready.revision,
				{
					status: "recorded",
					member: { ...presentationMember(), sourceSeq: "42" },
				},
				"lead_actions.summary_presentation",
			),
		).toThrow(/receipt shape/);
		const wrongSlot = fixture();
		expect(() =>
			record(
				wrongSlot.round,
				wrongSlot.ready.revision,
				{
					status: "recorded",
					member: presentationMember({ slotStartMs: 0 }),
				},
				"lead_actions.summary_presentation",
			),
		).toThrow(/binding mismatch/);
	});
	it("refuses no-change closeout when memory is dirty or unknown", () => {
		for (const status of ["dirty", "unavailable"]) {
			const { round, ready } = fixture();
			const observed = record(round, ready.revision, {
				canonicalStatus: "available",
				canonicalMainCommit: commit,
				canonicalMerged: [],
				memory: { status, commit, provenance: [] },
			});
			expect(() =>
				record(
					round,
					observed.revision,
					{
						status: "recorded",
						member: presentationMember({
							outcome: {},
							evidenceRef: "cos:round:dirty",
						}),
					},
					"lead_actions.summary_presentation",
				),
			).toThrow(/memory/);
		}
	});
	it("rejects presentation receipts bound to another identity or round", () => {
		for (const memberOverride of [
			{ projectName: "other" },
			{ leadId: "other" },
			{ roundId: `${roundId}:other` },
			{ groupId: "" },
			{ evidenceRef: "x".repeat(513) },
			{ evidenceRef: "../secret" },
		]) {
			const { round, ready } = fixture();
			expect(() =>
				record(
					round,
					ready.revision,
					{
						status: "recorded",
						member: presentationMember(memberOverride),
					},
					"lead_actions.summary_presentation",
				),
			).toThrow(/binding mismatch/);
		}
	});
});
