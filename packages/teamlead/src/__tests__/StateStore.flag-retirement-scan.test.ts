import type {
	FlagKeepAnchor,
	FlagScanScopeState,
	FlagScanState,
	ProposedFlagScan,
} from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

function state(
	flagName: string,
	overrides: Partial<FlagScanState> = {},
): FlagScanState {
	return {
		flagName,
		canonical: `{"k":"bool","v":false}`,
		streakStartedAt: 1,
		streakSamples: 2,
		lastSampledAt: 10,
		indeterminateStreak: 0,
		indeterminateClass: null,
		lastRetiringIssue: null,
		askCount: 0,
		lastAskedRunId: null,
		...overrides,
	};
}

function proposed(
	input: {
		states?: FlagScanState[];
		scopeStates?: FlagScanScopeState[];
		anchors?: FlagKeepAnchor[];
		candidates?: ProposedFlagScan["candidates"];
		claimed?: ProposedFlagScan["claimed"];
		noClock?: ProposedFlagScan["noClock"];
		keepUnbound?: ProposedFlagScan["keepUnbound"];
		departures?: ProposedFlagScan["departures"];
	} = {},
): ProposedFlagScan {
	return {
		nextState: input.states ?? [],
		nextScopeState: input.scopeStates ?? [],
		nextAnchors: input.anchors ?? [],
		candidates: input.candidates ?? [],
		claimed: input.claimed ?? [],
		noClock: input.noClock ?? [],
		keepUnbound: input.keepUnbound ?? [],
		departures: input.departures ?? [],
	};
}

function scopeState(
	flagName: string,
	scope: string,
	overrides: Partial<FlagScanScopeState> = {},
): FlagScanScopeState {
	return {
		flagName,
		scope,
		canonical: `{"k":"bool","v":false}`,
		streakStartedAt: 1,
		streakSamples: 2,
		lastSampledAt: 10,
		...overrides,
	};
}

function candidate(flagName: string) {
	return {
		flagName,
		canonical: `{"k":"bool","v":false}`,
		stableForMs: 7 * 24 * 60 * 60 * 1_000,
		askPhrase: "删掉这个 flag?",
		reason: null,
		previousAskCount: 0,
	};
}

describe("StateStore FLY-1781 weekly flag scan", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => store.close());

	it("migrates the complete durable scan schema idempotently", () => {
		store.migrate();
		const db = (
			store as unknown as {
				db: { raw: { prepare(sql: string): { all(): unknown[] } } };
			}
		).db.raw;
		const rows = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table'")
			.all() as Array<{
			name: string;
		}>;
		const tables = new Set(rows.map(({ name }) => name));
		for (const table of [
			"flag_scan_state",
			"flag_scan_scope_state",
			"flag_scan_runs",
			"flag_scan_run_legs",
			"flag_scan_run_items",
			"flag_keep_anchor",
			"flag_provenance",
			"flag_departures",
			"flag_scan_failure_alert_intents",
		]) {
			expect(tables.has(table), table).toBe(true);
		}
	});

	it("persists per-scope clocks across commits and prunes scopes outside the next registry/roster set", () => {
		const first = store.commitFlagScan({
			expectedLatestCommittedAt: null,
			runToken: "scope-first",
			now: 100,
			proposed: proposed({
				states: [state("project")],
				scopeStates: [
					scopeState("project", "alpha"),
					scopeState("project", "beta"),
				],
			}),
			items: [],
			provenance: [],
			requiredLegs: [],
		});
		if (!first.committed) throw new Error("scope seed failed");
		expect(store.getFlagScanScopeState()).toMatchObject([
			{ flagName: "project", scope: "alpha", streakSamples: 2 },
			{ flagName: "project", scope: "beta", streakSamples: 2 },
		]);

		const second = store.commitFlagScan({
			expectedLatestCommittedAt: first.run.committedAt,
			runToken: "scope-second",
			now: 200,
			proposed: proposed({
				states: [state("project")],
				scopeStates: [
					scopeState("project", "beta", {
						streakSamples: 3,
						lastSampledAt: 200,
					}),
					scopeState("project", "gamma", {
						canonical: `{"k":"bool","v":true}`,
						streakStartedAt: 200,
						streakSamples: 1,
						lastSampledAt: 200,
					}),
				],
			}),
			items: [],
			provenance: [],
			requiredLegs: [],
		});
		expect(second).toMatchObject({ committed: true });
		expect(store.getFlagScanScopeState()).toMatchObject([
			{ flagName: "project", scope: "beta", streakSamples: 3 },
			{ flagName: "project", scope: "gamma", streakSamples: 1 },
		]);
	});

	it("freezes the exact owed legs for candidate, lead-only, and healthy-empty runs", async () => {
		const candidateStore = store;
		const candidateResult = candidateStore.commitFlagScan({
			expectedLatestCommittedAt: null,
			runToken: "candidate-run",
			now: 100,
			proposed: proposed({
				states: [state("candidate")],
				candidates: [candidate("candidate")],
			}),
			items: [
				{
					flagName: "candidate",
					bucket: "candidate",
					canonical: `{"k":"bool","v":false}`,
					description: "Controls the weekly candidate behavior.",
					currentValue: "false",
					stableForMs: 7 * 24 * 60 * 60 * 1_000,
					askPhrase: "删掉这个 flag?",
					reason: null,
					provenance: null,
				},
			],
			provenance: [],
			requiredLegs: ["linear", "report", "discord"],
		});
		expect(candidateResult).toMatchObject({ committed: true });
		if (!candidateResult.committed) throw new Error("candidate commit failed");
		expect(
			candidateStore.getFlagScanRun(candidateResult.run.runId)?.status,
		).toBe("committed");
		expect(
			candidateStore
				.getFlagScanRunLegs(candidateResult.run.runId)
				.map(({ leg }) => leg),
		).toEqual(["discord", "linear", "report"]);
		expect(candidateStore.getFlagScanState()[0]).toMatchObject({
			flagName: "candidate",
			askCount: 1,
			lastAskedRunId: candidateResult.run.runId,
		});
		expect(
			candidateStore.getFlagScanRunItems(candidateResult.run.runId)[0],
		).toMatchObject({
			askCount: 1,
			description: "Controls the weekly candidate behavior.",
			currentValue: "false",
			stableForMs: 7 * 24 * 60 * 60 * 1_000,
		});

		const leadOnly = await StateStore.create(":memory:");
		try {
			const result = leadOnly.commitFlagScan({
				expectedLatestCommittedAt: null,
				runToken: "lead-only-run",
				now: 100,
				proposed: proposed({
					states: [state("no-clock")],
					noClock: [
						{
							flagName: "no-clock",
							class: "read_unavailable",
							reason: "config unavailable",
							indeterminateStreak: 1,
						},
					],
				}),
				items: [
					{
						flagName: "no-clock",
						bucket: "no_clock",
						canonical: null,
						askPhrase: null,
						reason: "config unavailable",
						provenance: null,
					},
				],
				provenance: [],
				requiredLegs: ["lead_notify"],
			});
			if (!result.committed) throw new Error("lead-only commit failed");
			expect(leadOnly.getFlagScanRunLegs(result.run.runId)).toMatchObject([
				{ leg: "lead_notify", status: "pending" },
			]);
		} finally {
			leadOnly.close();
		}

		const empty = await StateStore.create(":memory:");
		try {
			const result = empty.commitFlagScan({
				expectedLatestCommittedAt: null,
				runToken: "empty-run",
				now: 100,
				proposed: proposed({ states: [state("healthy")] }),
				items: [],
				provenance: [],
				requiredLegs: [],
			});
			if (!result.committed) throw new Error("empty commit failed");
			expect(result.run.status).toBe("published");
			expect(empty.getFlagScanRunLegs(result.run.runId)).toEqual([]);
		} finally {
			empty.close();
		}
	});

	it("uses a pending-run uniqueness/CAS fence so two writers cannot create two batches", () => {
		const first = store.commitFlagScan({
			expectedLatestCommittedAt: null,
			runToken: "run-one",
			now: 100,
			proposed: proposed({
				states: [state("candidate")],
				scopeStates: [scopeState("candidate", "*")],
				candidates: [candidate("candidate")],
			}),
			items: [],
			provenance: [],
			requiredLegs: ["linear"],
		});
		expect(first).toMatchObject({ committed: true });
		const second = store.commitFlagScan({
			expectedLatestCommittedAt: null,
			runToken: "run-two",
			now: 101,
			proposed: proposed({
				states: [state("candidate")],
				scopeStates: [
					scopeState("candidate", "*", {
						canonical: `{"k":"bool","v":true}`,
						streakSamples: 1,
					}),
				],
			}),
			items: [],
			provenance: [],
			requiredLegs: ["linear"],
		});
		expect(second).toEqual({ committed: false, reason: "pending_exists" });
		expect(store.listFlagScanRuns()).toHaveLength(1);
		expect(store.getFlagScanScopeState()).toMatchObject([
			{
				flagName: "candidate",
				scope: "*",
				canonical: `{"k":"bool","v":false}`,
				streakSamples: 2,
			},
		]);
	});

	it("deduplicates failure alert milestones and ignores legacy alert receipts", () => {
		const initial = store.ensureFlagScanFailureAlertIntent({
			baselineRunId: 0,
			failureClass: "provenance",
			milestone: "initial",
			eventId: "flag-scan-failed:0:provenance:initial",
			now: 100,
		});
		const duplicate = store.ensureFlagScanFailureAlertIntent({
			baselineRunId: 0,
			failureClass: "provenance",
			milestone: "initial",
			eventId: "flag-scan-failed:0:provenance:initial",
			now: 200,
		});
		expect(duplicate).toEqual(initial);
		expect(store.listFlagScanFailureAlertIntents()).toHaveLength(1);
		expect(
			store.claimFlagScanFailureAlertIntent({
				intentId: initial.intentId,
				leaseOwner: "worker",
				now: 100,
				leaseMs: 10,
			}),
		).toBe(true);
		store.recordAlertDeliveryReceipt(initial.eventId, "sent", "2026-08-16");
		expect(store.listFlagScanFailureAlertIntents()[0]?.state).toBe("claimed");
		expect(
			store.markFlagScanFailureAlertIntentAmbiguous({
				intentId: initial.intentId,
				leaseOwner: "worker",
				error: "Lead mailbox ACK pending",
			}),
		).toBe(true);
		expect(store.listFlagScanFailureAlertIntents()[0]?.state).toBe("ambiguous");
	});

	it("settles a failure intent from the dedicated Lead mailbox ACK path without forging an alert receipt", () => {
		const intent = store.ensureFlagScanFailureAlertIntent({
			baselineRunId: 0,
			failureClass: "source",
			milestone: "initial",
			eventId: "flag-scan-failed:0:source:initial",
			now: 100,
		});
		expect(
			store.claimFlagScanFailureAlertIntent({
				intentId: intent.intentId,
				leaseOwner: "worker",
				now: 100,
				leaseMs: 10,
			}),
		).toBe(true);
		expect(store.getAlertDeliveryReceipt(intent.eventId)).toBeUndefined();
		expect(
			store.settleFlagScanFailureMailboxIntent({
				intentId: intent.intentId,
				leaseOwner: "worker",
			}),
		).toBe(true);
		expect(store.listFlagScanFailureAlertIntents()[0]?.state).toBe("done");
		expect(store.getAlertDeliveryReceipt(intent.eventId)).toBeUndefined();
	});

	it("commits registry departures atomically with state/anchor/provenance cleanup", () => {
		const first = store.commitFlagScan({
			expectedLatestCommittedAt: null,
			runToken: "seed",
			now: 100,
			proposed: proposed({
				states: [
					state("gone", { lastRetiringIssue: "FLY-123" }),
					state("stays"),
				],
				anchors: [
					{
						flagName: "gone",
						anchorCanonical: `{"k":"bool","v":false}`,
						boundRunToken: "older",
						decidedAt: "2026-08-01",
					},
				],
			}),
			items: [],
			provenance: [
				{
					flagName: "gone",
					incarnationCommit: "abc",
					status: "resolved",
					sourceIssue: "FLY-1",
					author: "Tadashi",
					committedAt: 50,
					prNumber: 1,
				},
			],
			requiredLegs: [],
		});
		if (!first.committed) throw new Error("seed failed");

		const second = store.commitFlagScan({
			expectedLatestCommittedAt: first.run.committedAt,
			runToken: "departure",
			now: 200,
			proposed: proposed({
				states: [state("stays")],
				departures: [{ flagName: "gone", kind: "governance_cleared" }],
			}),
			items: [],
			provenance: [],
			requiredLegs: [],
		});
		expect(second).toMatchObject({ committed: true });
		expect(store.getFlagScanState().map(({ flagName }) => flagName)).toEqual([
			"stays",
		]);
		expect(store.getFlagKeepAnchors()).toEqual([]);
		expect(store.getFlagProvenance("gone")).toBeUndefined();
		expect(store.listFlagDepartures()).toMatchObject([
			{ flagName: "gone", kind: "governance_cleared" },
		]);
	});

	it("fences leg completion by lease owner and enforces Discord dependencies", () => {
		const committed = store.commitFlagScan({
			expectedLatestCommittedAt: null,
			runToken: "legs",
			now: 100,
			proposed: proposed({
				states: [state("candidate")],
				candidates: [candidate("candidate")],
			}),
			items: [],
			provenance: [],
			requiredLegs: ["linear", "report", "discord"],
		});
		if (!committed.committed) throw new Error("commit failed");
		const runId = committed.run.runId;

		expect(
			store.claimFlagScanLeg({
				runId,
				leg: "discord",
				leaseOwner: "worker-a",
				now: 110,
				leaseMs: 100,
			}),
		).toEqual({ claimed: false, reason: "dependencies_unsettled" });

		expect(
			store.claimFlagScanLeg({
				runId,
				leg: "linear",
				leaseOwner: "worker-a",
				now: 110,
				leaseMs: 100,
			}),
		).toMatchObject({ claimed: true });
		expect(
			store.completeFlagScanLeg({
				runId,
				leg: "linear",
				leaseOwner: "stale-worker",
				evidence: "https://linear.app/issue/FLY-1",
			}),
		).toBe(false);
		expect(
			store.completeFlagScanLeg({
				runId,
				leg: "linear",
				leaseOwner: "worker-a",
				evidence: "https://linear.app/issue/FLY-1",
			}),
		).toBe(true);

		store.claimFlagScanLeg({
			runId,
			leg: "report",
			leaseOwner: "worker-b",
			now: 110,
			leaseMs: 100,
		});
		expect(
			store.completeFlagScanLeg({
				runId,
				leg: "report",
				leaseOwner: "worker-b",
				evidence: "https://report.invalid/token",
			}),
		).toBe(true);
		expect(
			store.claimFlagScanLeg({
				runId,
				leg: "discord",
				leaseOwner: "worker-c",
				now: 120,
				leaseMs: 100,
			}),
		).toMatchObject({ claimed: true });
	});

	it("does not re-create an ambiguous external effect before its visibility fence", () => {
		const committed = store.commitFlagScan({
			expectedLatestCommittedAt: null,
			runToken: "ambiguous",
			now: 100,
			proposed: proposed({ states: [state("candidate")] }),
			items: [],
			provenance: [],
			requiredLegs: ["linear"],
		});
		if (!committed.committed) throw new Error("commit failed");
		const runId = committed.run.runId;
		store.claimFlagScanLeg({
			runId,
			leg: "linear",
			leaseOwner: "worker-a",
			now: 110,
			leaseMs: 100,
		});
		expect(
			store.markFlagScanLegAmbiguous({
				runId,
				leg: "linear",
				leaseOwner: "worker-a",
				now: 120,
				reconcileNotBefore: 500,
			}),
		).toBe(true);
		expect(
			store.requeueAmbiguousFlagScanLeg({ runId, leg: "linear", now: 499 }),
		).toBe(false);
		expect(
			store.requeueAmbiguousFlagScanLeg({ runId, leg: "linear", now: 500 }),
		).toBe(true);
		expect(
			store.claimFlagScanLeg({
				runId,
				leg: "linear",
				leaseOwner: "worker-b",
				now: 501,
				leaseMs: 100,
			}),
		).toMatchObject({ claimed: true });
		expect(
			store.completeFlagScanLeg({
				runId,
				leg: "linear",
				leaseOwner: "worker-a",
				evidence: "stale completion",
			}),
		).toBe(false);
	});
});
