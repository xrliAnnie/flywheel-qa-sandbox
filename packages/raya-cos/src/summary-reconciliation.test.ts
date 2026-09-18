import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BusinessRound } from "./business-round.js";

const roots: string[] = [];
const roundId = "summary-absorption:2026-09-14T20:00:00.000Z",
	head = "a".repeat(40),
	commit = "b".repeat(40),
	path = "summaries/flywheel/2026-09-13--eng--01.md";
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "summary-reconcile-"));
	roots.push(root);
	const round = new BusinessRound(root);
	const prepared = round.prepare({
		schemaVersion: 2,
		kind: "summary_round",
		roundId,
		mainCommit: commit,
		sourceStatus: "available",
		inventory: [],
		frozenEvent: {
			round_ledger: "ok",
			producers: [],
			absent: [],
			undelivered: [],
			delivery_unknown: [],
			report_line: "本轮 0/0 份已交",
		},
	});
	return { root, round, prepared };
}
const canonical = {
	pr: 41,
	head,
	project: "flywheel",
	roundId: "summary-absorption:2026-09-13T20:00:00.000Z",
	files: [path],
};
function result(provenance: object[] = []) {
	return {
		canonicalStatus: "available",
		canonicalMainCommit: commit,
		canonicalMerged: [canonical],
		memory: { status: "clean", commit, provenance },
	};
}
function record(round: BusinessRound, revision: number, value: object) {
	return round.record({
		schemaVersion: 2,
		operationId: `summary-round:${roundId}`,
		expectedRevision: revision,
		tool: "current_turn",
		callId: "reconciliation-read-1",
		result: value,
	});
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("canonical summary memory reconciliation", () => {
	it("finds missing provenance in an empty unread round without treating merged material as unread", () => {
		const { round, prepared } = fixture();
		const observed = record(round, prepared.revision, result());
		expect(observed.material).toMatchObject({
			progress: {
				reconciliation: {
					status: "memory_needed",
					missing: [
						{
							pr: canonical.pr,
							head,
							project: canonical.project,
							roundId: canonical.roundId,
							path,
						},
					],
				},
			},
		});
		expect(observed.next).toMatchObject({ tool: "current_turn" });
	});
	it("requires exact path, PR, head and historical round provenance", () => {
		const { round, prepared } = fixture();
		const correct = { pr: 41, head, path, roundId: canonical.roundId };
		const first = record(
			round,
			prepared.revision,
			result([{ ...correct, head: "c".repeat(40) }]),
		);
		expect(first.material).toMatchObject({
			progress: { reconciliation: { status: "memory_needed" } },
		});
		expect(
			record(round, first.revision, result([correct])).material,
		).toMatchObject({
			progress: { reconciliation: { status: "ready", missing: [] } },
		});
	});
	it("preserves unknown and dirty memory without authorizing updates", () => {
		const { round, prepared } = fixture();
		const unknown = record(round, prepared.revision, {
			canonicalStatus: "unavailable",
			memory: { status: "unavailable" },
		});
		expect(unknown.material).toMatchObject({
			progress: { reconciliation: { status: "unknown" } },
		});
		const dirty = record(round, unknown.revision, {
			...result(),
			memory: { status: "dirty", commit, provenance: [] },
		});
		expect(dirty.material).toMatchObject({
			progress: { reconciliation: { status: "memory_dirty" } },
		});
	});
	it("rejects stale main and cross-project canonical file attribution", () => {
		const { round, prepared } = fixture();
		expect(() =>
			record(round, prepared.revision, {
				...result(),
				canonicalMainCommit: "c".repeat(40),
			}),
		).toThrow(/main/);
		expect(() =>
			record(round, prepared.revision, {
				...result(),
				canonicalMerged: [{ ...canonical, project: "other" }],
			}),
		).toThrow(/project/);
	});
});
