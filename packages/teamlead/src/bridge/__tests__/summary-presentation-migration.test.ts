import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { runSummaryPresentationMigration } from "../summary-presentation-migration.js";

function payload(
	projectName: string,
	roundId: string,
	version?: number,
): string {
	return JSON.stringify({
		event_type: "summary_absorption_round",
		execution_id: roundId,
		project_name: projectName,
		...(version ? { contract_version: version } : {}),
	});
}

function appendRound(
	store: StateStore,
	index: number,
	version?: number,
): { roundId: string; seq: number } {
	const slotStartMs = Date.UTC(2026, 8, 1, index * 6);
	const roundId = `summary-absorption:${new Date(slotStartMs).toISOString()}`;
	const seq = store.appendLeadEvent(
		"raya",
		roundId,
		"summary_absorption_round",
		payload("raya", roundId, version),
		"summary-absorption",
	);
	if (version === 2) {
		store.summaryPresentations.admitRound({
			projectName: "raya",
			leadId: "raya",
			roundId,
			sourceSeq: seq,
			slotStartMs,
			sourceDigest: store.summaryPresentations
				.listMigrationJournalRounds("raya", "raya")
				.at(-1)!.sourceDigest,
		});
	}
	return { roundId, seq };
}

describe("FLY-2619 summary presentation historical migration", () => {
	const cleanups: string[] = [];
	afterEach(() => {
		for (const root of cleanups.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("resumes 100 bounded rounds, keeps unknown history out, and groups proven backlog with new rounds", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2619-migration-"));
		cleanups.push(root);
		const state = join(root, "state");
		mkdirSync(state);
		const store = await StateStore.create(join(root, "teamlead.db"));
		try {
			const rounds = Array.from({ length: 100 }, (_, index) =>
				appendRound(store, index),
			);
			const ledger: string[] = [];
			for (const [index, round] of rounds.entries()) {
				if (index < 40) {
					ledger.push(
						JSON.stringify({
							type: "report_attempt",
							roundId: round.roundId,
							eventId: `${round.roundId}:report`,
						}),
						JSON.stringify({
							type: "report",
							roundId: round.roundId,
							messageId: String(1_540_000_000_000_000_000n + BigInt(index)),
							channelId: "1542079099928059987",
						}),
					);
				} else if (index >= 60 && index < 70) {
					ledger.push(
						JSON.stringify({
							type: "report_attempt",
							roundId: round.roundId,
						}),
					);
				}
			}
			writeFileSync(
				join(state, "summary-merge-receipts.jsonl"),
				`${ledger.join("\n")}\n`,
			);
			const decisions = [
				...rounds.slice(40, 60).map((round, index) => ({
					roundId: round.roundId,
					disposition: "historical_silent",
					operator: "migration-test",
					reason: "explicit legacy silence",
					evidenceRef: `decision:silent:${index}`,
				})),
				...rounds.slice(70, 80).map((round, index) => ({
					roundId: round.roundId,
					disposition: "eligible",
					operator: "migration-test",
					reason: "verified unprocessed with no send attempt",
					evidenceRef: `decision:eligible:${index}`,
				})),
			];
			writeFileSync(
				join(state, "summary-presentation-migration-decisions.jsonl"),
				`${decisions.map((row) => JSON.stringify(row)).join("\n")}\n`,
			);

			const first = runSummaryPresentationMigration({
				store: store.summaryPresentations,
				projectName: "raya",
				leadId: "raya",
				workspaceRoot: root,
				maxRows: 37,
			});
			expect(first).toMatchObject({ state: "building", processed: 37 });
			expect(store.summaryPresentations.begin("raya", "raya")).toEqual({
				result: "migration_required",
				migrationState: "building",
			});

			appendRound(store, 100, 2);
			appendRound(store, 101, 2);
			appendRound(store, 102, 2);
			const second = runSummaryPresentationMigration({
				store: store.summaryPresentations,
				projectName: "raya",
				leadId: "raya",
				workspaceRoot: root,
			});
			expect(second).toMatchObject({
				state: "complete",
				processed: 63,
				dispositions: {
					historical_presented: 3,
					historical_silent: 20,
					eligible: 10,
					needs_reconciliation: 30,
				},
			});
			const group = store.summaryPresentations.begin("raya", "raya");
			expect(group.result).toBe("group");
			if (group.result !== "group") return;
			expect(group.members).toHaveLength(13);
			expect(
				group.members.every(
					(member) =>
						!rounds
							.slice(60, 70)
							.some((round) => round.roundId === member.roundId),
				),
			).toBe(true);
		} finally {
			store.close();
		}
	});

	it("preserves v2 rounds admitted before migration bootstrap", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2619-migration-preadmitted-"));
		cleanups.push(root);
		const state = join(root, "state");
		mkdirSync(state);
		writeFileSync(join(state, "summary-merge-receipts.jsonl"), "");
		const store = await StateStore.create(join(root, "teamlead.db"));
		try {
			const historical = appendRound(store, 0);
			const preadmitted = appendRound(store, 1, 2);

			expect(
				runSummaryPresentationMigration({
					store: store.summaryPresentations,
					projectName: "raya",
					leadId: "raya",
					workspaceRoot: root,
				}),
			).toMatchObject({
				state: "complete",
				processed: 2,
				dispositions: { eligible: 1, needs_reconciliation: 1 },
			});
			expect(
				store.summaryPresentations.getRound("raya", "raya", historical.roundId),
			).toMatchObject({ disposition: "needs_reconciliation" });
			expect(
				store.summaryPresentations.getRound(
					"raya",
					"raya",
					preadmitted.roundId,
				),
			).toMatchObject({ disposition: "eligible" });

			const group = store.summaryPresentations.begin("raya", "raya");
			expect(group.result).toBe("group");
			if (group.result === "group") {
				expect(group.members.map((member) => member.roundId)).toEqual([
					preadmitted.roundId,
				]);
			}
		} finally {
			store.close();
		}
	});

	it("keeps a completed migration closed when live ledger sources later drift", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2619-migration-complete-"));
		cleanups.push(root);
		const state = join(root, "state");
		mkdirSync(state);
		const ledgerPath = join(state, "summary-merge-receipts.jsonl");
		writeFileSync(ledgerPath, "");
		const store = await StateStore.create(join(root, "teamlead.db"));
		try {
			const historical = appendRound(store, 0);
			const first = runSummaryPresentationMigration({
				store: store.summaryPresentations,
				projectName: "raya",
				leadId: "raya",
				workspaceRoot: root,
			});
			expect(first).toMatchObject({ state: "complete", processed: 1 });

			appendFileSync(ledgerPath, '{"type":"merge","roundId":"summary-abso\n');
			expect(
				runSummaryPresentationMigration({
					store: store.summaryPresentations,
					projectName: "raya",
					leadId: "raya",
					workspaceRoot: root,
				}),
			).toMatchObject({
				state: "complete",
				processed: 0,
				boundarySeq: historical.seq,
				sourceDigests: first.sourceDigests,
			});

			appendFileSync(
				ledgerPath,
				`${JSON.stringify({ type: "merge", roundId: historical.roundId })}\n`,
			);
			expect(
				runSummaryPresentationMigration({
					store: store.summaryPresentations,
					projectName: "raya",
					leadId: "raya",
					workspaceRoot: root,
				}),
			).toMatchObject({
				state: "complete",
				processed: 0,
				sourceDigests: first.sourceDigests,
			});
		} finally {
			store.close();
		}
	});

	it("rechecks unconfirmed classifications when bounded source evidence changes", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2619-migration-refresh-"));
		cleanups.push(root);
		const state = join(root, "state");
		mkdirSync(state);
		writeFileSync(join(state, "summary-merge-receipts.jsonl"), "");
		const decisionsPath = join(
			state,
			"summary-presentation-migration-decisions.jsonl",
		);
		writeFileSync(decisionsPath, "");
		const store = await StateStore.create(join(root, "teamlead.db"));
		try {
			const firstRound = appendRound(store, 0);
			const secondRound = appendRound(store, 1);
			expect(
				runSummaryPresentationMigration({
					store: store.summaryPresentations,
					projectName: "raya",
					leadId: "raya",
					workspaceRoot: root,
					maxRows: 1,
				}),
			).toMatchObject({ state: "building", processed: 1 });
			expect(
				store.summaryPresentations.getRound("raya", "raya", firstRound.roundId),
			).toMatchObject({ disposition: "needs_reconciliation" });

			appendFileSync(
				decisionsPath,
				`${JSON.stringify({
					roundId: firstRound.roundId,
					disposition: "eligible",
					operator: "migration-test",
					reason: "verified no handling and no send attempt",
					evidenceRef: "decision:eligible:refresh",
				})}\n`,
			);
			expect(
				runSummaryPresentationMigration({
					store: store.summaryPresentations,
					projectName: "raya",
					leadId: "raya",
					workspaceRoot: root,
				}),
			).toMatchObject({ state: "complete", processed: 2 });
			expect(
				store.summaryPresentations.getRound("raya", "raya", firstRound.roundId),
			).toMatchObject({ disposition: "eligible" });
			expect(
				store.summaryPresentations.getRound(
					"raya",
					"raya",
					secondRound.roundId,
				),
			).toMatchObject({ disposition: "needs_reconciliation" });
		} finally {
			store.close();
		}
	});

	it("does not treat transport ACK metadata as presentation evidence", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2619-migration-ack-"));
		cleanups.push(root);
		const state = join(root, "state");
		mkdirSync(state);
		writeFileSync(join(state, "summary-merge-receipts.jsonl"), "");
		const store = await StateStore.create(join(root, "teamlead.db"));
		try {
			const round = appendRound(store, 0);
			store.markLeadEventDelivered("raya", round.seq);
			runSummaryPresentationMigration({
				store: store.summaryPresentations,
				projectName: "raya",
				leadId: "raya",
				workspaceRoot: root,
			});
			expect(
				store.summaryPresentations.getRound("raya", "raya", round.roundId),
			).toMatchObject({ disposition: "needs_reconciliation" });
		} finally {
			store.close();
		}
	});
});
