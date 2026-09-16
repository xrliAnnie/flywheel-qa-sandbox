import { describe, expect, it } from "vitest";
import { summaryPresentationPayloadDigest } from "../bridge/summary-presentation-store.js";
import { StateStore } from "../StateStore.js";

function roundPayload(
	projectName: string,
	roundId: string,
	contractVersion?: number,
): string {
	return JSON.stringify({
		event_type: "summary_absorption_round",
		execution_id: roundId,
		project_name: projectName,
		...(contractVersion ? { contract_version: contractVersion } : {}),
	});
}

function appendLegacyRound(
	store: StateStore,
	input: { projectName: string; leadId: string; slotStartMs: number },
): { roundId: string; seq: number; payload: string } {
	const roundId = `summary-absorption:${new Date(input.slotStartMs).toISOString()}`;
	const payload = roundPayload(input.projectName, roundId);
	const seq = store.appendLeadEvent(
		input.leadId,
		roundId,
		"summary_absorption_round",
		payload,
		"summary-absorption",
	);
	return { roundId, seq, payload };
}

function appendV2Rounds(
	store: StateStore,
	projectName: string,
	leadId: string,
	slots: number[],
): void {
	store.appendSummaryPresentationRounds(
		slots.map((slotStartMs) => {
			const eventId = `summary-absorption:${new Date(slotStartMs).toISOString()}`;
			return {
				leadId,
				eventId,
				projectName,
				slotStartMs,
				payload: roundPayload(projectName, eventId, 2),
			};
		}),
	);
}

function completeEmptyMigration(
	store: StateStore,
	projectName: string,
	leadId: string,
): void {
	const sourceDigests = { journal: "empty-at-cutover" };
	store.summaryPresentations.beginMigration({
		projectName,
		leadId,
		boundarySeq: 0,
		sourceDigests,
	});
	store.summaryPresentations.completeMigration({
		projectName,
		leadId,
		sourceDigests,
	});
}

describe("FLY-2619 summary presentation ledger", () => {
	it("gates begin on migration and claims all 65 eligible rounds as one chronological group", async () => {
		const store = await StateStore.create(":memory:");
		try {
			expect(store.summaryPresentations.begin("flywheel", "raya")).toEqual({
				result: "migration_required",
				migrationState: "missing",
			});
			completeEmptyMigration(store, "flywheel", "raya");
			const slots = Array.from(
				{ length: 65 },
				(_, index) => (65 - index) * 60_000,
			);
			appendV2Rounds(store, "flywheel", "raya", slots);

			const begun = store.summaryPresentations.begin("flywheel", "raya", 7_000);
			expect(begun.result).toBe("group");
			if (begun.result !== "group") return;
			expect(begun.members).toHaveLength(65);
			expect(begun.members.map((member) => member.slotStartMs)).toEqual(
				[...slots].sort((left, right) => left - right),
			);
			expect(begun.group.groupClaimSeq).toBe(
				Math.max(...begun.members.map((member) => member.sourceSeq)),
			);
			expect(store.summaryPresentations.begin("flywheel", "raya")).toEqual(
				begun,
			);
		} finally {
			store.close();
		}
	});

	it("requires a complete idempotent historical classification before new rounds can begin", async () => {
		const store = await StateStore.create(":memory:");
		try {
			const historical = Array.from({ length: 100 }, (_, index) =>
				appendLegacyRound(store, {
					projectName: "flywheel",
					leadId: "raya",
					slotStartMs: index * 60_000,
				}),
			);
			const sourceDigests = { journal: "fixture-v1", receipts: "fixture-v1" };
			store.summaryPresentations.beginMigration({
				projectName: "flywheel",
				leadId: "raya",
				boundarySeq: historical.at(-1)!.seq,
				sourceDigests,
			});
			for (const [index, row] of historical.slice(0, 50).entries()) {
				store.summaryPresentations.classifyHistoricalRound({
					projectName: "flywheel",
					leadId: "raya",
					roundId: row.roundId,
					sourceSeq: row.seq,
					slotStartMs: index * 60_000,
					disposition: "historical_presented",
					sourceDigest: summaryPresentationPayloadDigest(row.payload),
					evidenceRef: `receipt:${index}`,
				});
			}
			expect(() =>
				store.summaryPresentations.completeMigration({
					projectName: "flywheel",
					leadId: "raya",
					sourceDigests,
				}),
			).toThrow("summary_presentation_migration_gap:51");

			for (const [offset, row] of historical.slice(50).entries()) {
				const index = offset + 50;
				const disposition =
					index < 75
						? "historical_silent"
						: index < 90
							? "needs_reconciliation"
							: "eligible";
				store.summaryPresentations.classifyHistoricalRound({
					projectName: "flywheel",
					leadId: "raya",
					roundId: row.roundId,
					sourceSeq: row.seq,
					slotStartMs: index * 60_000,
					disposition,
					sourceDigest: summaryPresentationPayloadDigest(row.payload),
					evidenceRef: `migration:${index}`,
				});
			}
			expect(
				store.summaryPresentations.completeMigration({
					projectName: "flywheel",
					leadId: "raya",
					sourceDigests,
				}).state,
			).toBe("complete");
			appendV2Rounds(
				store,
				"flywheel",
				"raya",
				[100, 200, 300].map((n) => 7_000_000 + n),
			);

			const begun = store.summaryPresentations.begin("flywheel", "raya");
			expect(begun.result).toBe("group");
			if (begun.result !== "group") return;
			expect(begun.members).toHaveLength(13);
			expect(
				historical
					.slice(75, 90)
					.every((row) =>
						begun.members.every((member) => member.roundId !== row.roundId),
					),
			).toBe(true);
		} finally {
			store.close();
		}
	});

	it("keeps incomplete groups collecting and finalizes two silent rounds without an outbound", async () => {
		const store = await StateStore.create(":memory:");
		try {
			completeEmptyMigration(store, "flywheel", "raya");
			appendV2Rounds(store, "flywheel", "raya", [60_000, 120_000]);
			const begun = store.summaryPresentations.begin("flywheel", "raya");
			if (begun.result !== "group") throw new Error("expected group");
			store.summaryPresentations.record({
				projectName: "flywheel",
				leadId: "raya",
				groupId: begun.group.id,
				roundId: begun.members[0]!.roundId,
				businessState: "complete",
				outcome: { changed: false },
				evidenceRef: "ledger:first",
			});
			const incomplete = store.summaryPresentations.prepareFinalize({
				projectName: "flywheel",
				leadId: "raya",
				groupId: begun.group.id,
				decision: "silent",
				reason: "no substantive change",
			});
			expect(incomplete).toMatchObject({
				result: "incomplete",
				group: { state: "collecting" },
			});
			store.summaryPresentations.record({
				projectName: "flywheel",
				leadId: "raya",
				groupId: begun.group.id,
				roundId: begun.members[1]!.roundId,
				businessState: "complete",
				outcome: { changed: false },
				evidenceRef: "ledger:second",
			});
			expect(
				store.summaryPresentations.prepareFinalize({
					projectName: "flywheel",
					leadId: "raya",
					groupId: begun.group.id,
					decision: "silent",
					reason: "no substantive change",
				}),
			).toMatchObject({
				result: "silent",
				group: { state: "silent", outboundKey: null, messageId: null },
			});
			expect(
				store.summaryPresentations.listMembers(begun.group.id),
			).toHaveLength(2);
			expect(store.summaryPresentations.begin("flywheel", "raya")).toEqual({
				result: "empty",
			});
		} finally {
			store.close();
		}
	});

	it("alerts stale groups and migrations once and permits an audited support failure", async () => {
		const store = await StateStore.create(":memory:");
		try {
			completeEmptyMigration(store, "flywheel", "raya");
			appendV2Rounds(store, "flywheel", "raya", [60_000]);
			const begun = store.summaryPresentations.begin("flywheel", "raya", 100);
			if (begun.result !== "group") throw new Error("expected group");
			const cadenceMs = 6 * 60 * 60_000;
			const first = store.summaryPresentations.claimStaleSignals({
				projectName: "flywheel",
				leadId: "raya",
				cadenceMs,
				nowMs: 100 + cadenceMs * 2,
			});
			expect(first).toEqual([
				expect.objectContaining({
					kind: "collecting",
					diagnosticRef: expect.stringMatching(/^summary-stale:[0-9a-f]{20}$/),
					internalRef: `group:${begun.group.id}`,
				}),
			]);
			expect(
				store.summaryPresentations.claimStaleSignals({
					projectName: "flywheel",
					leadId: "raya",
					cadenceMs,
					nowMs: 100 + cadenceMs * 4,
				}),
			).toEqual([]);

			const member = store.summaryPresentations.supportRecordMember({
				projectName: "flywheel",
				leadId: "raya",
				groupId: begun.group.id,
				roundId: begun.members[0]!.roundId,
				operator: "support-test",
				reason: "evidence schema could not be repaired",
				evidenceRef: "support:ticket:2619",
				nowMs: 500,
			});
			expect(member).toMatchObject({
				businessState: "failed",
				outcome: {
					supportDisposition: "failed",
					operator: "support-test",
				},
			});
			expect(
				store.summaryPresentations.prepareFinalize({
					projectName: "flywheel",
					leadId: "raya",
					groupId: begun.group.id,
					decision: "silent",
					reason: "support-recorded failure has no founder-facing value",
				}),
			).toMatchObject({ result: "silent" });

			store.summaryPresentations.beginMigration({
				projectName: "migration-fixture",
				leadId: "raya",
				boundarySeq: 0,
				sourceDigests: { journal: "empty" },
				nowMs: 1_000,
			});
			expect(
				store.summaryPresentations.claimStaleSignals({
					projectName: "migration-fixture",
					leadId: "raya",
					cadenceMs,
					nowMs: 1_000 + cadenceMs * 2,
				}),
			).toEqual([
				expect.objectContaining({
					kind: "migration",
					internalRef: "migration:v2",
				}),
			]);
		} finally {
			store.close();
		}
	});

	it("releases an ambiguous group without changing its key or re-claiming its members", async () => {
		const store = await StateStore.create(":memory:");
		try {
			completeEmptyMigration(store, "flywheel", "raya");
			appendV2Rounds(store, "flywheel", "raya", [60_000]);
			const first = store.summaryPresentations.begin("flywheel", "raya");
			if (first.result !== "group") throw new Error("expected first group");
			store.summaryPresentations.record({
				projectName: "flywheel",
				leadId: "raya",
				groupId: first.group.id,
				roundId: first.members[0]!.roundId,
				businessState: "complete",
				outcome: { changed: true },
				evidenceRef: "ledger:one",
			});
			const ready = store.summaryPresentations.prepareFinalize({
				projectName: "flywheel",
				leadId: "raya",
				groupId: first.group.id,
				decision: "substantive",
				reason: "new product fact",
				text: "发现一项值得你知道的新进展。",
			});
			expect(ready).toMatchObject({
				result: "ready",
				group: { outboundKey: `summary-presentation:${first.group.id}` },
			});
			store.summaryPresentations.markSending(first.group.id);
			const ambiguous = store.summaryPresentations.markAmbiguous(
				first.group.id,
				{
					error: "socket closed after write",
					diagnosticRef: "diagnostic:send-1",
				},
			);
			expect(ambiguous.state).toBe("ambiguous");

			appendV2Rounds(store, "flywheel", "raya", [120_000]);
			const second = store.summaryPresentations.begin("flywheel", "raya");
			expect(second).toMatchObject({ result: "group" });
			if (second.result !== "group") return;
			expect(second.group.id).not.toBe(first.group.id);
			expect(second.members.map((member) => member.roundId)).toEqual([
				"summary-absorption:1970-01-01T00:02:00.000Z",
			]);
			expect(
				store.summaryPresentations.reconcileAmbiguous({
					groupId: first.group.id,
					messageId: "123456789",
					operator: "qa-operator",
					reason: "durable sender receipt matched the frozen key",
					evidenceRef: "receipt:sender-1",
				}).state,
			).toBe("sent");
		} finally {
			store.close();
		}
	});
});
