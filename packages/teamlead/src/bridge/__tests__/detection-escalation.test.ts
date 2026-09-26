import { describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	type DetectionEscalationInput,
	formatEscalationLeadNote,
	type NotifyLeadFirstDeps,
	notifyLeadFirst,
} from "../detection-escalation.js";
import {
	formatDetectionEscalation,
	type HookPayload,
} from "../hook-payload.js";
import { GUARDRAIL_EVENT_TYPES } from "../lead-runtime.js";

/**
 * FLY-1048 PR-C Task C2: the Lead-first notification leg (PRD §4.3/§4.5).
 * Natural language, quiet issue-thread note + Lead inbox event; the durable
 * detection_escalations row (C1) is the authoritative once-per-episode dedup
 * and the anchor of the ~30min grace timer.
 */

const INPUT: DetectionEscalationInput = {
	targetKey: "exec-1",
	kind: "detection_stuck_confirmed",
	episodeFingerprint: "fp:abc",
	executionId: "exec-1",
	issueId: "issue-uuid-1",
	issueIdentifier: "FLY-1048",
	projectName: "flywheel",
	firstDetectedAtMs: 1_000,
	reason: "错误后冻结:同一错误画面停留超过两轮巡检",
	nextStep: "按 937 capture pane 排查",
};

interface Call {
	kind: string;
	args: unknown[];
}

function makeDeps(
	store: StateStore,
	overrides: Partial<NotifyLeadFirstDeps> = {},
): { deps: NotifyLeadFirstDeps; calls: Call[] } {
	const calls: Call[] = [];
	const deps: NotifyLeadFirstDeps = {
		store,
		runtimeRegistry: {
			getForLead: () => ({
				deliver: async (env) => {
					calls.push({ kind: "deliver", args: [env] });
					return { delivered: true };
				},
			}),
		},
		resolveOwner: () => ({
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			executionId: "exec-1",
			issueId: "issue-uuid-1",
		}),
		emitThreadNote: async (input, owner) => {
			calls.push({ kind: "threadNote", args: [input, owner] });
		},
		logger: () => {},
		now: () => 50_000,
		...overrides,
	};
	return { deps, calls };
}

async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

describe("notifyLeadFirst (FLY-1048 C2)", () => {
	it("new episode → both legs fire and the durable row lands LEAD_NOTIFIED at now()", async () => {
		const store = await freshStore();
		const { deps, calls } = makeDeps(store);
		const outcome = await notifyLeadFirst(deps, INPUT);
		expect(outcome).toBe("notified");

		const row = store.getDetectionEscalation(
			INPUT.targetKey,
			INPUT.kind,
			INPUT.episodeFingerprint,
		)!;
		expect(row.status).toBe("LEAD_NOTIFIED");
		expect(row.lead_notified_at_ms).toBe(50_000);
		expect(row.first_detected_at_ms).toBe(1_000);
		expect(row.owner_lead_id).toBe("flywheel-eng-lead");

		expect(calls.map((c) => c.kind).sort()).toEqual(["deliver", "threadNote"]);
		const env = calls.find((c) => c.kind === "deliver")!.args[0] as {
			event: HookPayload;
			leadId: string;
		};
		expect(env.leadId).toBe("flywheel-eng-lead");
		expect(env.event.event_type).toBe("detection_escalation");
	});

	it("second call for the SAME episode is a no-op (already_notified) — no double post, no timer slide", async () => {
		const store = await freshStore();
		const { deps, calls } = makeDeps(store);
		await notifyLeadFirst(deps, INPUT);
		const before = calls.length;
		const outcome = await notifyLeadFirst(deps, {
			...INPUT,
			firstDetectedAtMs: 99_999,
		});
		expect(outcome).toBe("already_notified");
		expect(calls.length).toBe(before);
		const row = store.getDetectionEscalation(
			INPUT.targetKey,
			INPUT.kind,
			INPUT.episodeFingerprint,
		)!;
		expect(row.lead_notified_at_ms).toBe(50_000);
		expect(row.first_detected_at_ms).toBe(1_000);
	});

	it("no owner resolvable → no_owner, row stays NEW so the next reconcile retries (never silently dropped)", async () => {
		const store = await freshStore();
		const { deps, calls } = makeDeps(store, { resolveOwner: () => null });
		const outcome = await notifyLeadFirst(deps, INPUT);
		expect(outcome).toBe("no_owner");
		expect(calls).toHaveLength(0);
		const row = store.getDetectionEscalation(
			INPUT.targetKey,
			INPUT.kind,
			INPUT.episodeFingerprint,
		)!;
		expect(row.status).toBe("NEW");
	});

	it("thread-note leg failure is non-fatal: the Lead leg still lands and the row is LEAD_NOTIFIED", async () => {
		const store = await freshStore();
		const { deps, calls } = makeDeps(store, {
			emitThreadNote: async () => {
				throw new Error("discord down");
			},
		});
		const outcome = await notifyLeadFirst(deps, INPUT);
		expect(outcome).toBe("notified");
		expect(calls.some((c) => c.kind === "deliver")).toBe(true);
		expect(
			store.getDetectionEscalation(
				INPUT.targetKey,
				INPUT.kind,
				INPUT.episodeFingerprint,
			)?.status,
		).toBe("LEAD_NOTIFIED");
	});

	it("missing thread binding (caller pre-guard: emitThreadNote omitted) → Lead leg alone still notifies", async () => {
		const store = await freshStore();
		const { deps, calls } = makeDeps(store, { emitThreadNote: undefined });
		const outcome = await notifyLeadFirst(deps, INPUT);
		expect(outcome).toBe("notified");
		expect(calls.map((c) => c.kind)).toEqual(["deliver"]);
	});

	it("runtime deliver failure/throw records the failure but STILL marks LEAD_NOTIFIED — the guardrail redelivery loop owns the retry", async () => {
		const store = await freshStore();
		const { deps } = makeDeps(store, {
			runtimeRegistry: {
				getForLead: () => ({
					deliver: async () => {
						throw new Error("lead runtime gone");
					},
				}),
			},
		});
		const outcome = await notifyLeadFirst(deps, INPUT);
		expect(outcome).toBe("notified");
		const row = store.getDetectionEscalation(
			INPUT.targetKey,
			INPUT.kind,
			INPUT.episodeFingerprint,
		)!;
		expect(row.status).toBe("LEAD_NOTIFIED");
		// The lead_event row exists with a recorded failure for redelivery.
		const events = store.getUndeliveredGuardrailEvents(
			"flywheel-eng-lead",
			["detection_escalation"],
			5,
		);
		expect(events).toHaveLength(1);
	});

	it("payload carries the escalation fields and NEVER any raw pane text field", async () => {
		const store = await freshStore();
		const { deps, calls } = makeDeps(store);
		await notifyLeadFirst(deps, INPUT);
		const env = calls.find((c) => c.kind === "deliver")!.args[0] as {
			event: HookPayload;
		};
		expect(env.event.escalation_kind).toBe("detection_stuck_confirmed");
		expect(env.event.escalation_reason).toBe(INPUT.reason);
		expect(env.event.episode_fingerprint).toBe("fp:abc");
		expect(env.event.suspicious_pane_tail).toBeUndefined();
	});

	it("detection_escalation is a guardrail event type (failed delivery is re-driven)", () => {
		expect(GUARDRAIL_EVENT_TYPES.has("detection_escalation")).toBe(true);
	});
});

describe("formatEscalationLeadNote (FLY-1048 C2)", () => {
	it("is the formatParkAlert-family truthful one-liner: identifier + reason + next step, no pane text", () => {
		const note = formatEscalationLeadNote(INPUT);
		expect(note).toContain("[FLY-1048]");
		expect(note).toContain(INPUT.reason);
		expect(note).toContain("下一步=按 937 capture pane 排查");
	});

	it("falls back to issueId when identifier is missing and to a default next step", () => {
		const note = formatEscalationLeadNote({
			...INPUT,
			issueIdentifier: undefined,
			nextStep: undefined,
		});
		expect(note).toContain("[issue-uuid-1]");
		expect(note).toContain("下一步=");
	});
});

describe("formatDetectionEscalation renderer (FLY-1048 C2 — Lead inbox rendering)", () => {
	it("renders kind + reason + next step + the 30min-grace contract; a generic formatter would drop these fields", () => {
		const rendered = formatDetectionEscalation({
			seq: 7,
			event: {
				event_type: "detection_escalation",
				execution_id: "exec-1",
				issue_id: "issue-uuid-1",
				issue_identifier: "FLY-1048",
				project_name: "flywheel",
				detection_target_key: "exec-1",
				escalation_kind: "detection_stuck_confirmed",
				escalation_reason: INPUT.reason,
				escalation_next_step: INPUT.nextStep,
				episode_fingerprint: "fp:abc",
			},
			sessionKey: "exec-1",
			leadId: "flywheel-eng-lead",
			timestamp: "2026-07-09T00:00:00.000Z",
		});
		expect(rendered).toContain("detection_escalation");
		expect(rendered).toContain("detection_stuck_confirmed");
		expect(rendered).toContain(INPUT.reason);
		expect(rendered).toContain(INPUT.nextStep!);
		expect(rendered).toContain("FLY-1048");
		expect(rendered).toContain("~30min");
		expect(rendered).toContain("fp:abc");
	});
});

/**
 * FLY-1048 PR-C Task C5: cleanup-in-progress mute. While ANY of the target's
 * episodes is CLEARING (close-runner / reap in flight), NEW detections of
 * EVERY kind stay quiet — cleanup churn must not spam the Lead (FLY-970).
 * The episode row is still upserted (detection-clock continuity), so when the
 * cleanup times out (TTL rebound) or resolves, the record is intact.
 */
describe("notifyLeadFirst C5 target-clearing mute (FLY-1048)", () => {
	it("a CLEARING target mutes a NEW episode of a DIFFERENT kind — no legs fire, row upserted and left NEW", async () => {
		const store = await freshStore();
		// An unrelated episode of the same target enters cleanup.
		store.upsertDetectionEscalation({
			targetKey: "exec-1",
			kind: "delivery_unconsumed",
			episodeFingerprint: "fp:cleanup",
			firstDetectedAtMs: 1,
		});
		store.markDetectionEscalationsClearingForTarget("exec-1", 10_000);

		const { deps, calls } = makeDeps(store);
		const outcome = await notifyLeadFirst(deps, INPUT);
		expect(outcome).toBe("target_clearing");
		expect(calls).toHaveLength(0); // neither deliver nor threadNote
		const row = store.getDetectionEscalation(
			INPUT.targetKey,
			INPUT.kind,
			INPUT.episodeFingerprint,
		)!;
		expect(row.status).toBe("NEW"); // continuity kept; notify resumes post-cleanup
	});

	it("a CLEARING row on a DIFFERENT target does not mute", async () => {
		const store = await freshStore();
		store.upsertDetectionEscalation({
			targetKey: "exec-other",
			kind: "delivery_unconsumed",
			episodeFingerprint: "fp:cleanup",
			firstDetectedAtMs: 1,
		});
		store.markDetectionEscalationsClearingForTarget("exec-other", 10_000);
		const { deps, calls } = makeDeps(store);
		const outcome = await notifyLeadFirst(deps, INPUT);
		expect(outcome).toBe("notified");
		expect(calls.map((c) => c.kind).sort()).toEqual(["deliver", "threadNote"]);
	});
});

/**
 * Codex PR-C R5 finding 2 (HIGH): two concurrent detections of the SAME
 * episode (production has two fire-and-forget case-c entrants) must deliver
 * exactly once — the durable NEW→LEAD_NOTIFIED transition is an atomic CLAIM
 * taken BEFORE any await / outward side effect; the loser sees
 * already_notified and produces no delivery and no thread note.
 */
describe("notifyLeadFirst concurrent single-delivery claim (Codex R5 #2)", () => {
	it("two concurrent notifies → one delivery, one thread note, one notified", async () => {
		const store = await freshStore();
		let releaseFirst!: () => void;
		const firstHeld = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let deliveries = 0;
		let threadNotes = 0;
		const deps: NotifyLeadFirstDeps = {
			store,
			runtimeRegistry: {
				getForLead: () => ({
					deliver: async () => {
						deliveries += 1;
						if (deliveries === 1) await firstHeld; // hold the winner mid-flight
						return { delivered: true };
					},
				}),
			},
			resolveOwner: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				executionId: "exec-1",
				issueId: "issue-uuid-1",
			}),
			emitThreadNote: async () => {
				threadNotes += 1;
			},
			logger: () => {},
			now: () => 50_000,
		};
		const p1 = notifyLeadFirst(deps, INPUT);
		const p2 = notifyLeadFirst(deps, INPUT); // enters while p1 is held
		await new Promise((r) => setTimeout(r, 10));
		releaseFirst();
		const outcomes = (await Promise.all([p1, p2])).sort();
		expect(outcomes).toEqual(["already_notified", "notified"]);
		expect(deliveries).toBe(1);
		expect(threadNotes).toBe(1);
		expect(
			store.getDetectionEscalation(
				INPUT.targetKey,
				INPUT.kind,
				INPUT.episodeFingerprint,
			)?.status,
		).toBe("LEAD_NOTIFIED");
	});
});

/**
 * Codex PR-C R6: crash/retry surfaces of the atomic append+claim.
 */
describe("notifyLeadFirst atomic append+claim surfaces (Codex R6)", () => {
	it("no_owner → owner recovered on retry: notified AND the durable row's owner is backfilled (R6 #2)", async () => {
		const store = await freshStore();
		let ownerAvailable = false;
		const { deps, calls } = makeDeps(store, {
			resolveOwner: () =>
				ownerAvailable
					? {
							leadId: "flywheel-eng-lead",
							projectName: "flywheel",
							executionId: "exec-1",
							issueId: "issue-uuid-1",
						}
					: null,
		});
		expect(await notifyLeadFirst(deps, INPUT)).toBe("no_owner");
		expect(calls).toHaveLength(0);
		ownerAvailable = true;
		expect(await notifyLeadFirst(deps, INPUT)).toBe("notified");
		const row = store.getDetectionEscalation(
			INPUT.targetKey,
			INPUT.kind,
			INPUT.episodeFingerprint,
		)!;
		expect(row.status).toBe("LEAD_NOTIFIED");
		expect(row.owner_lead_id).toBe("flywheel-eng-lead");
	});

	it("a retry against an already-claimed episode performs ZERO deliveries (restart/heartbeat cannot be doubled — R6 #1)", async () => {
		const store = await freshStore();
		const { deps, calls } = makeDeps(store);
		expect(await notifyLeadFirst(deps, INPUT)).toBe("notified");
		const delivered = calls.filter((c) => c.kind === "deliver").length;
		expect(await notifyLeadFirst(deps, INPUT)).toBe("already_notified");
		expect(calls.filter((c) => c.kind === "deliver").length).toBe(delivered);
	});
});

/**
 * Codex PR-C R7 findings.
 */
describe("append+claim true atomicity + occurrence identity (Codex R7)", () => {
	it("R7/R6#1: a failure between append and claim ROLLS BACK the event (better-sqlite3 transaction, no stranded outbox row)", async () => {
		const store = await freshStore();
		store.upsertDetectionEscalation({
			targetKey: "exec-1",
			kind: "detection_stuck_confirmed",
			episodeFingerprint: "fp:abc",
			firstDetectedAtMs: 1_000,
		});
		// Fault-inject: the claim UPDATE throws inside the transaction.
		const shim = (
			store as unknown as {
				db: { run: (sql: string, params?: unknown[]) => void };
			}
		).db;
		const realRun = shim.run.bind(shim);
		shim.run = (sql: string, params?: unknown[]) => {
			if (sql.includes("SET status = 'LEAD_NOTIFIED'")) {
				throw new Error("injected crash between append and claim");
			}
			return realRun(sql, params);
		};
		expect(() =>
			store.appendAndClaimDetectionEscalation({
				leadId: "flywheel-eng-lead",
				eventId: "ev-atomic",
				eventType: "detection_escalation",
				payload: "{}",
				sessionKey: "exec-1",
				targetKey: "exec-1",
				kind: "detection_stuck_confirmed",
				episodeFingerprint: "fp:abc",
				ownerLeadId: "flywheel-eng-lead",
				atMs: 5_000,
			}),
		).toThrow(/injected crash/);
		shim.run = realRun;
		// The append must have been rolled back with the failed claim —
		// heartbeat can never deliver an event whose episode is still NEW.
		const undelivered = store.getUndeliveredGuardrailEvents(
			"flywheel-eng-lead",
			["detection_escalation"],
			99,
		);
		expect(undelivered).toHaveLength(0);
		expect(
			store.getDetectionEscalation(
				"exec-1",
				"detection_stuck_confirmed",
				"fp:abc",
			)?.status,
		).toBe("NEW");
	});

	it("R7 NEW-1: a revived same-fingerprint recurrence gets its OWN outbox row — heartbeat can retry occurrence 2 after its immediate delivery fails", async () => {
		const store = await freshStore();
		// Occurrence 1: notify succeeds (delivered).
		const { deps: deps1 } = makeDeps(store);
		expect(await notifyLeadFirst(deps1, INPUT)).toBe("notified");
		// Machine recovery resolves it.
		store.ackDetectionEscalation(
			INPUT.targetKey,
			INPUT.kind,
			INPUT.episodeFingerprint,
			{
				atMs: 60_000,
				disposition: "resolve",
				via: "recovery",
			},
		);
		// Occurrence 2: same fingerprint, NEWER detection → revives to NEW.
		const input2 = {
			...INPUT,
			firstDetectedAtMs: 120_000,
			reason: "second occurrence",
		};
		// Immediate delivery FAILS this time.
		const { deps: deps2 } = makeDeps(store, {
			runtimeRegistry: {
				getForLead: () => ({
					deliver: async () => ({ delivered: false, error: "transport down" }),
				}),
			},
			now: () => 130_000,
		});
		expect(await notifyLeadFirst(deps2, input2)).toBe("notified");
		// The recurrence must be durably retryable: a NEW undelivered event row
		// carrying occurrence 2's payload (not the delivered occurrence-1 row).
		const undelivered = store.getUndeliveredGuardrailEvents(
			"flywheel-eng-lead",
			["detection_escalation"],
			99,
		);
		expect(undelivered).toHaveLength(1);
		expect(undelivered[0]!.payload).toContain("second occurrence");
	});
});
