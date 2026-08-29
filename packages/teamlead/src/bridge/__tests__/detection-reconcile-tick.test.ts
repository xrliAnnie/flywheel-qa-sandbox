/**
 * FLY-1048 PR-C (C4+C5): the reconcile-tick assembly — one GatePoller
 * piggyback pass that (in order) rebounds lapsed CLEARING mutes, auto-
 * resolves recovered targets, runs the FN4 delivery reconcile (fire+clear),
 * and drives the ~30min grace escalation (founder page / fleet aggregate).
 * Plus the CLEARING notify-mute guard (C5).
 */

import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import type { DetectionEscalationInput } from "../detection-escalation.js";
import {
	DEFAULT_CLEARING_TTL_MS,
	notifyUnlessClearing,
	resolveClearedGapEpisodes,
	runDetectionReconcileTick,
} from "../detection-reconcile-tick.js";

const T0 = 1_700_000_000_000;
const GRACE_MS = 1_800_000;

async function freshStore(): Promise<StateStore> {
	const s = await StateStore.create(":memory:");
	s.upsertSession({
		execution_id: "exec-1",
		issue_id: "FLY-9",
		project_name: "geo",
		status: "running",
	});
	return s;
}

function seedEpisode(
	s: StateStore,
	over: {
		kind?: string;
		fp?: string;
		target?: string;
		notifiedAt?: number;
	} = {},
): { kind: string; fp: string; target: string } {
	const kind = over.kind ?? "detection_stuck_confirmed";
	const fp = over.fp ?? "fp:1";
	const target = over.target ?? "exec-1";
	s.upsertDetectionEscalation({
		targetKey: target,
		kind,
		episodeFingerprint: fp,
		issueId: "FLY-9",
		ownerLeadId: "eng-lead",
		firstDetectedAtMs: T0 - 60_000,
	});
	s.markDetectionEscalationLeadNotified(
		target,
		kind,
		fp,
		over.notifiedAt ?? T0 - GRACE_MS - 1,
	);
	return { kind, fp, target };
}

interface TickOver {
	pageFounder?: ReturnType<typeof vi.fn>;
	fleetSink?: ReturnType<typeof vi.fn>;
	notify?: ReturnType<typeof vi.fn>;
	recoveryProbe?: (targetKey: string) => {
		terminal: boolean;
		lastActivityAtMs: number | null;
	} | null;
	now?: number;
	clearingTtlMs?: number;
}

async function tick(s: StateStore, over: TickOver = {}) {
	const pageFounder = over.pageFounder ?? vi.fn(async () => true);
	const fleetSink = over.fleetSink ?? vi.fn(async () => {});
	const notify = over.notify ?? vi.fn(async () => {});
	await runDetectionReconcileTick({
		store: s,
		pageFounder,
		fleetSink,
		notify,
		recoveryProbe: over.recoveryProbe ?? (() => null),
		graceMs: GRACE_MS,
		fleetThreshold: 4,
		clearingTtlMs: over.clearingTtlMs,
		fn4OverdueMs: 3_600_000,
		now: () => over.now ?? T0,
		logger: () => {},
	});
	return { pageFounder, fleetSink, notify };
}

describe("runDetectionReconcileTick (FLY-1048 C4+C5)", () => {
	it("overdue LEAD_NOTIFIED → founder page → ESCALATED", async () => {
		const s = await freshStore();
		const { kind, fp } = seedEpisode(s);
		const { pageFounder } = await tick(s);
		expect(pageFounder).toHaveBeenCalledTimes(1);
		expect(s.getDetectionEscalation("exec-1", kind, fp)?.status).toBe(
			"ESCALATED",
		);
	});

	it("ESCALATED never re-pages (FLY-970)", async () => {
		const s = await freshStore();
		const { kind, fp } = seedEpisode(s);
		s.markDetectionEscalationEscalated("exec-1", kind, fp, T0 - 1);
		const { pageFounder } = await tick(s);
		expect(pageFounder).not.toHaveBeenCalled();
	});

	it("CLEARING rows are never founder-paged, even when overdue", async () => {
		const s = await freshStore();
		const { kind, fp } = seedEpisode(s);
		s.markDetectionEscalationClearing("exec-1", kind, fp, T0 - 1);
		const { pageFounder } = await tick(s);
		expect(pageFounder).not.toHaveBeenCalled();
	});

	it("CLEARING past the TTL rebounds to NEW (cleanup that never finished must not mute forever)", async () => {
		const s = await freshStore();
		const { kind, fp } = seedEpisode(s);
		s.markDetectionEscalationClearing(
			"exec-1",
			kind,
			fp,
			T0 - DEFAULT_CLEARING_TTL_MS - 1,
		);
		await tick(s);
		expect(s.getDetectionEscalation("exec-1", kind, fp)?.status).toBe("NEW");
	});

	it("CLEARING under the TTL stays muted", async () => {
		const s = await freshStore();
		const { kind, fp } = seedEpisode(s);
		s.markDetectionEscalationClearing("exec-1", kind, fp, T0 - 60_000);
		await tick(s);
		expect(s.getDetectionEscalation("exec-1", kind, fp)?.status).toBe(
			"CLEARING",
		);
	});

	it("recovered target (terminal probe) → episodes auto-RESOLVED, no page", async () => {
		const s = await freshStore();
		const { kind, fp } = seedEpisode(s);
		const { pageFounder } = await tick(s, {
			recoveryProbe: () => ({ terminal: true, lastActivityAtMs: null }),
		});
		expect(s.getDetectionEscalation("exec-1", kind, fp)?.status).toBe(
			"RESOLVED",
		);
		expect(pageFounder).not.toHaveBeenCalled();
	});

	it("fleet-scale group (≥ threshold, same kind) → one aggregate, zero founder pages", async () => {
		const s = await freshStore();
		for (let i = 0; i < 4; i++) {
			s.upsertSession({
				execution_id: `exec-f${i}`,
				issue_id: `FLY-${i}`,
				project_name: "geo",
				status: "running",
			});
			seedEpisode(s, { target: `exec-f${i}`, fp: `fp:f${i}` });
		}
		const { pageFounder, fleetSink } = await tick(s);
		expect(fleetSink).toHaveBeenCalledTimes(1);
		expect(pageFounder).not.toHaveBeenCalled();
	});

	// ── FN4 ──

	it("FN4 fire: exhausted undelivered lead_event → one delivery_failed_reconcile notify", async () => {
		const s = await freshStore();
		const seq = s.appendLeadEvent(
			"eng-lead",
			"ev-1",
			"runner_question",
			"{}",
			"exec-1",
		);
		for (let i = 0; i < 3; i++) s.recordDeliveryFailure(seq, "boom");
		const { notify } = await tick(s);
		expect(notify).toHaveBeenCalledTimes(1);
		const input = notify.mock.calls[0]![0] as DetectionEscalationInput;
		expect(input.kind).toBe("delivery_failed_reconcile");
		expect(input.episodeFingerprint).toBe(`fn4:eng-lead:${seq}`);
		expect(input.targetKey).toBe("exec-1");
	});

	it("FN4 fire is skipped when the event's session is gone (unroutable)", async () => {
		const s = await freshStore();
		const seq = s.appendLeadEvent(
			"eng-lead",
			"ev-2",
			"runner_question",
			"{}",
			"exec-gone",
		);
		for (let i = 0; i < 3; i++) s.recordDeliveryFailure(seq, "boom");
		const { notify } = await tick(s);
		expect(notify).not.toHaveBeenCalled();
	});

	it("FN4 clear: the event got delivered → episode auto-RESOLVED", async () => {
		const s = await freshStore();
		const seq = s.appendLeadEvent(
			"eng-lead",
			"ev-3",
			"runner_question",
			"{}",
			"exec-1",
		);
		seedEpisode(s, {
			kind: "delivery_failed_reconcile",
			fp: `fn4:eng-lead:${seq}`,
		});
		s.markLeadEventDelivered(seq);
		await tick(s);
		expect(
			s.getDetectionEscalation(
				"exec-1",
				"delivery_failed_reconcile",
				`fn4:eng-lead:${seq}`,
			)?.status,
		).toBe("RESOLVED");
	});

	it("an ESCALATED-only target still recovers (terminal probe → RESOLVED) — Codex R1 #2", async () => {
		const s = await freshStore();
		const { kind, fp } = seedEpisode(s);
		s.markDetectionEscalationEscalated("exec-1", kind, fp, T0 - 1);
		await tick(s, {
			recoveryProbe: () => ({ terminal: true, lastActivityAtMs: null }),
		});
		expect(s.getDetectionEscalation("exec-1", kind, fp)?.status).toBe(
			"RESOLVED",
		);
	});

	it("FN4 resolves the execution id from the event PAYLOAD when session_key is a hook key — Codex R1 #5", async () => {
		const s = await freshStore();
		const seq = s.appendLeadEvent(
			"eng-lead",
			"ev-mixed",
			"runner_question",
			JSON.stringify({ execution_id: "exec-1" }),
			"flywheel:FLY-9", // production hook-key encoding, NOT an execution id
		);
		for (let i = 0; i < 3; i++) s.recordDeliveryFailure(seq, "boom");
		const { notify } = await tick(s);
		expect(notify).toHaveBeenCalledTimes(1);
		const input = notify.mock.calls[0]![0] as DetectionEscalationInput;
		expect(input.targetKey).toBe("exec-1");
	});

	it("FN4 clear: the event row vanished (pruned) → episode auto-RESOLVED (evidence gone)", async () => {
		const s = await freshStore();
		seedEpisode(s, {
			kind: "delivery_failed_reconcile",
			fp: "fn4:eng-lead:999999",
		});
		await tick(s);
		expect(
			s.getDetectionEscalation(
				"exec-1",
				"delivery_failed_reconcile",
				"fn4:eng-lead:999999",
			)?.status,
		).toBe("RESOLVED");
	});
});

describe("resolveClearedGapEpisodes (gap conditions that provably cleared)", () => {
	it("resolves gap episodes absent from the sweep; active ones and case-c stay", async () => {
		const s = await freshStore();
		seedEpisode(s, { kind: "lead_ask_unanswered", fp: "gap:ask" });
		seedEpisode(s, { kind: "runner_parked_unreported", fp: "gap:park" });
		seedEpisode(s); // case-c — never touched by this pass

		const n = resolveClearedGapEpisodes(
			{ store: s, logger: () => {} },
			new Set(["runner_parked_unreported|exec-1"]), // park still true; ask cleared
			new Set([
				"runner_parked_unreported|exec-1",
				"lead_ask_unanswered|exec-1",
			]), // both judgements fully ran
			T0,
		);
		expect(n).toBe(1);
		expect(
			s.getDetectionEscalation("exec-1", "lead_ask_unanswered", "gap:ask")
				?.status,
		).toBe("RESOLVED");
		expect(
			s.getDetectionEscalation("exec-1", "runner_parked_unreported", "gap:park")
				?.status,
		).toBe("LEAD_NOTIFIED");
		expect(
			s.getDetectionEscalation("exec-1", "detection_stuck_confirmed", "fp:1")
				?.status,
		).toBe("LEAD_NOTIFIED");
	});

	it("the clear carries recovery provenance so a genuine recurrence revives", async () => {
		const s = await freshStore();
		seedEpisode(s, { kind: "lead_ask_unanswered", fp: "gap:ask" });
		resolveClearedGapEpisodes(
			{ store: s, logger: () => {} },
			new Set(),
			new Set(["lead_ask_unanswered|exec-1"]),
			T0,
		);
		const revived = s.upsertDetectionEscalation({
			targetKey: "exec-1",
			kind: "lead_ask_unanswered",
			episodeFingerprint: "gap:ask",
			issueId: "FLY-9",
			ownerLeadId: "eng-lead",
			firstDetectedAtMs: T0 + 60_000, // a NEW unanswered ask later
		});
		expect(revived.created).toBe(true);
		expect(revived.row.status).toBe("NEW");
	});
});

describe("notifyUnlessClearing (FLY-1048 C5 target-level mute)", () => {
	const INPUT = {
		targetKey: "exec-1",
		kind: "lead_ask_unanswered",
		episodeFingerprint: "gap:x",
		executionId: "exec-1",
		issueId: "FLY-9",
		projectName: "geo",
		firstDetectedAtMs: T0,
		reason: "r",
	} satisfies DetectionEscalationInput;

	it("an active CLEARING episode on the target mutes EVERY detection kind for it", async () => {
		const s = await freshStore();
		const { kind, fp } = seedEpisode(s); // detection_stuck_confirmed episode
		s.markDetectionEscalationClearing("exec-1", kind, fp, T0);
		const notify = vi.fn(async () => {});
		await notifyUnlessClearing({ store: s, notify, logger: () => {} }, INPUT);
		expect(notify).not.toHaveBeenCalled();
	});

	it("no CLEARING → passes through", async () => {
		const s = await freshStore();
		const notify = vi.fn(async () => {});
		await notifyUnlessClearing({ store: s, notify, logger: () => {} }, INPUT);
		expect(notify).toHaveBeenCalledTimes(1);
	});
});

/**
 * Codex PR-C R3 finding 2 (HIGH): absence is durable clear evidence ONLY for
 * a condition the sweep could actually OBSERVE this pass. A transiently
 * unreadable comm.db (openGapReader → null skips the project) must not
 * resolve that project's active gap episodes.
 */
describe("resolveClearedGapEpisodes evaluated-set guard (Codex R3 #2 + R4 #1/#2)", () => {
	it("a condition whose judgement did NOT run (unreadable signal / skipped project / keep-alive target) is NOT resolved", async () => {
		const s = await freshStore();
		seedEpisode(s, { kind: "lead_ask_unanswered", fp: "gap:ask" });
		const n = resolveClearedGapEpisodes(
			{ store: s, logger: () => {} },
			new Set(),
			new Set(), // nothing was fully evaluated this pass
			T0,
		);
		expect(n).toBe(0);
		expect(
			s.getDetectionEscalation("exec-1", "lead_ask_unanswered", "gap:ask")
				?.status,
		).toBe("LEAD_NOTIFIED");
	});

	it("a fully-evaluated absent condition still resolves", async () => {
		const s = await freshStore();
		seedEpisode(s, { kind: "lead_ask_unanswered", fp: "gap:ask" });
		const n = resolveClearedGapEpisodes(
			{ store: s, logger: () => {} },
			new Set(),
			new Set(["lead_ask_unanswered|exec-1"]),
			T0,
		);
		expect(n).toBe(1);
	});

	it("evaluated is per-KIND: gap1 evaluated + absent resolves while an unevaluated gap2 on the SAME target is held", async () => {
		const s = await freshStore();
		seedEpisode(s, { kind: "runner_parked_unreported", fp: "gap:park" });
		seedEpisode(s, { kind: "lead_ask_unanswered", fp: "gap:ask" });
		const n = resolveClearedGapEpisodes(
			{ store: s, logger: () => {} },
			new Set(),
			new Set(["runner_parked_unreported|exec-1"]), // ask signal was unreadable
			T0,
		);
		expect(n).toBe(1);
		expect(
			s.getDetectionEscalation("exec-1", "runner_parked_unreported", "gap:park")
				?.status,
		).toBe("RESOLVED");
		expect(
			s.getDetectionEscalation("exec-1", "lead_ask_unanswered", "gap:ask")
				?.status,
		).toBe("LEAD_NOTIFIED");
	});
});
