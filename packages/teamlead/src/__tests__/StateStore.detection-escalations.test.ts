import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

/**
 * FLY-1048 PR-C Task C1: detection_escalations durable table — the single
 * authoritative episode store for the unified escalation flow (PRD §3.3b +
 * §4.3). The ~30min Lead-grace timer and notification dedup MUST survive a
 * Bridge restart, so every transition lives here, not in memory.
 * Keyed (target_key, kind, episode_fingerprint) — same episode key family as
 * stuck_dispositions.
 */
async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

const KEY = {
	targetKey: "exec-1",
	kind: "detection_stuck_confirmed",
	episodeFingerprint: "fp:abc",
} as const;

describe("StateStore detection_escalations (FLY-1048 C1)", () => {
	it("upsert creates a NEW row with the detection clock; re-upsert of the same episode returns the existing row without resetting it", async () => {
		const s = await freshStore();
		const first = s.upsertDetectionEscalation({
			...KEY,
			issueId: "FLY-1048",
			ownerLeadId: "flywheel-eng-lead",
			firstDetectedAtMs: 1_000,
		});
		expect(first.created).toBe(true);
		expect(first.row.status).toBe("NEW");
		expect(first.row.first_detected_at_ms).toBe(1_000);
		expect(first.row.attempts).toBe(0);

		const again = s.upsertDetectionEscalation({
			...KEY,
			issueId: "FLY-1048",
			ownerLeadId: "flywheel-eng-lead",
			firstDetectedAtMs: 99_000,
		});
		expect(again.created).toBe(false);
		// Episode continuity: the original detection clock survives (the 30min
		// grace must not restart just because the detector re-observed it).
		expect(again.row.first_detected_at_ms).toBe(1_000);
		expect(again.row.status).toBe("NEW");
	});

	it("distinct targets / kinds / fingerprints are independent rows", async () => {
		const s = await freshStore();
		s.upsertDetectionEscalation({ ...KEY, firstDetectedAtMs: 1 });
		s.upsertDetectionEscalation({
			...KEY,
			kind: "delivery_unconsumed",
			firstDetectedAtMs: 2,
		});
		s.upsertDetectionEscalation({
			...KEY,
			targetKey: "exec-2",
			firstDetectedAtMs: 3,
		});
		s.upsertDetectionEscalation({
			...KEY,
			episodeFingerprint: "fp:def",
			firstDetectedAtMs: 4,
		});
		expect(s.getDetectionEscalationsForReconcile()).toHaveLength(4);
	});

	it("markLeadNotified stamps LEAD_NOTIFIED once; the first notification timestamp wins on repeat", async () => {
		const s = await freshStore();
		expect(
			s.markDetectionEscalationLeadNotified(
				KEY.targetKey,
				KEY.kind,
				KEY.episodeFingerprint,
				5_000,
			),
		).toBe(false); // no row yet
		s.upsertDetectionEscalation({ ...KEY, firstDetectedAtMs: 1_000 });
		expect(
			s.markDetectionEscalationLeadNotified(
				KEY.targetKey,
				KEY.kind,
				KEY.episodeFingerprint,
				5_000,
			),
		).toBe(true);
		// Repeat notify must not slide the grace window forward.
		s.markDetectionEscalationLeadNotified(
			KEY.targetKey,
			KEY.kind,
			KEY.episodeFingerprint,
			9_000,
		);
		const row = s.getDetectionEscalationsForReconcile()[0]!;
		expect(row.status).toBe("LEAD_NOTIFIED");
		expect(row.lead_notified_at_ms).toBe(5_000);
	});

	it("ack transitions to ACKED with lead_ack_at_ms; resolve/dismiss dispositions terminate the row; missing row → false", async () => {
		const s = await freshStore();
		expect(
			s.ackDetectionEscalation(
				KEY.targetKey,
				KEY.kind,
				KEY.episodeFingerprint,
				{ atMs: 6_000, disposition: "ack" },
			),
		).toBe(false);
		s.upsertDetectionEscalation({ ...KEY, firstDetectedAtMs: 1_000 });
		s.markDetectionEscalationLeadNotified(
			KEY.targetKey,
			KEY.kind,
			KEY.episodeFingerprint,
			5_000,
		);
		expect(
			s.ackDetectionEscalation(
				KEY.targetKey,
				KEY.kind,
				KEY.episodeFingerprint,
				{ atMs: 6_000, disposition: "ack" },
			),
		).toBe(true);
		let row = s.getDetectionEscalationsForReconcile()[0]!;
		expect(row.status).toBe("ACKED");
		expect(row.lead_ack_at_ms).toBe(6_000);

		expect(
			s.ackDetectionEscalation(
				KEY.targetKey,
				KEY.kind,
				KEY.episodeFingerprint,
				{ atMs: 7_000, disposition: "resolve" },
			),
		).toBe(true);
		expect(s.getDetectionEscalationsForReconcile()).toHaveLength(0);
		row = s.getDetectionEscalation(
			KEY.targetKey,
			KEY.kind,
			KEY.episodeFingerprint,
		)!;
		expect(row.status).toBe("RESOLVED");
	});

	it("markEscalated stamps ESCALATED + founder_paged_at_ms — callers only invoke it on a CONFIRMED founder page (C3 contract)", async () => {
		const s = await freshStore();
		s.upsertDetectionEscalation({ ...KEY, firstDetectedAtMs: 1_000 });
		s.markDetectionEscalationLeadNotified(
			KEY.targetKey,
			KEY.kind,
			KEY.episodeFingerprint,
			5_000,
		);
		expect(
			s.markDetectionEscalationEscalated(
				KEY.targetKey,
				KEY.kind,
				KEY.episodeFingerprint,
				2_000_000,
			),
		).toBe(true);
		const row = s.getDetectionEscalation(
			KEY.targetKey,
			KEY.kind,
			KEY.episodeFingerprint,
		)!;
		expect(row.status).toBe("ESCALATED");
		expect(row.founder_paged_at_ms).toBe(2_000_000);
		// Codex code R1 #2: ESCALATED rows STAY in the reconcile view so the
		// recovery pass keeps probing their target — "never re-page" is
		// enforced by the grace leg's LEAD_NOTIFIED filter, not by hiding
		// the row.
		expect(
			s.getDetectionEscalationsForReconcile().map((r) => r.status),
		).toEqual(["ESCALATED"]);
	});

	it("CLEARING mutes the episode; revert-to-NEW (TTL rebound) re-arms it so a wedged cleanup cannot silence forever", async () => {
		const s = await freshStore();
		s.upsertDetectionEscalation({ ...KEY, firstDetectedAtMs: 1_000 });
		expect(
			s.markDetectionEscalationClearing(
				KEY.targetKey,
				KEY.kind,
				KEY.episodeFingerprint,
				10_000,
			),
		).toBe(true);
		let row = s.getDetectionEscalation(
			KEY.targetKey,
			KEY.kind,
			KEY.episodeFingerprint,
		)!;
		expect(row.status).toBe("CLEARING");
		// CLEARING rows stay visible to reconcile (the TTL check needs them).
		expect(s.getDetectionEscalationsForReconcile()).toHaveLength(1);
		expect(
			s.revertDetectionEscalationClearingToNew(
				KEY.targetKey,
				KEY.kind,
				KEY.episodeFingerprint,
			),
		).toBe(true);
		row = s.getDetectionEscalation(
			KEY.targetKey,
			KEY.kind,
			KEY.episodeFingerprint,
		)!;
		expect(row.status).toBe("NEW");
		// Revert only applies to CLEARING rows.
		expect(
			s.revertDetectionEscalationClearingToNew(
				KEY.targetKey,
				KEY.kind,
				KEY.episodeFingerprint,
			),
		).toBe(false);
	});

	it("getDetectionEscalationsForReconcile returns only non-terminal rows", async () => {
		const s = await freshStore();
		const mk = (fp: string) =>
			s.upsertDetectionEscalation({
				...KEY,
				episodeFingerprint: fp,
				firstDetectedAtMs: 1,
			});
		mk("fp:new");
		mk("fp:notified");
		s.markDetectionEscalationLeadNotified(
			KEY.targetKey,
			KEY.kind,
			"fp:notified",
			2,
		);
		mk("fp:acked");
		s.ackDetectionEscalation(KEY.targetKey, KEY.kind, "fp:acked", {
			atMs: 3,
			disposition: "ack",
		});
		mk("fp:resolved");
		s.ackDetectionEscalation(KEY.targetKey, KEY.kind, "fp:resolved", {
			atMs: 4,
			disposition: "resolve",
		});
		mk("fp:escalated");
		s.markDetectionEscalationEscalated(
			KEY.targetKey,
			KEY.kind,
			"fp:escalated",
			5,
		);
		mk("fp:clearing");
		s.markDetectionEscalationClearing(
			KEY.targetKey,
			KEY.kind,
			"fp:clearing",
			6,
		);

		const fps = s
			.getDetectionEscalationsForReconcile()
			.map((r) => r.episode_fingerprint)
			.sort();
		// Every ACTIVE (non-RESOLVED) status is visible — ESCALATED included
		// (Codex code R1 #2); only fp:resolved is gone.
		expect(fps).toEqual([
			"fp:acked",
			"fp:clearing",
			"fp:escalated",
			"fp:new",
			"fp:notified",
		]);
	});

	it("resolveDetectionEscalationsForTarget resolves every non-RESOLVED row of that target only (runner recovered → auto-RESOLVED)", async () => {
		const s = await freshStore();
		s.upsertDetectionEscalation({ ...KEY, firstDetectedAtMs: 1 });
		s.upsertDetectionEscalation({
			...KEY,
			kind: "delivery_unconsumed",
			firstDetectedAtMs: 2,
		});
		s.markDetectionEscalationEscalated(
			KEY.targetKey,
			KEY.kind,
			KEY.episodeFingerprint,
			3,
		);
		s.upsertDetectionEscalation({
			...KEY,
			targetKey: "exec-other",
			firstDetectedAtMs: 4,
		});
		const n = s.resolveDetectionEscalationsForTarget(KEY.targetKey);
		// Both the active row AND the ESCALATED row close out on recovery.
		expect(n).toBe(2);
		expect(
			s.getDetectionEscalation(KEY.targetKey, KEY.kind, KEY.episodeFingerprint)
				?.status,
		).toBe("RESOLVED");
		expect(
			s.getDetectionEscalation(
				KEY.targetKey,
				"delivery_unconsumed",
				KEY.episodeFingerprint,
			)?.status,
		).toBe("RESOLVED");
		expect(
			s.getDetectionEscalation("exec-other", KEY.kind, KEY.episodeFingerprint)
				?.status,
		).toBe("NEW");
	});

	it("countActiveDetectionEscalationsByKind counts non-RESOLVED episodes detected in the window (C3 fleet guard input)", async () => {
		const s = await freshStore();
		const mk = (target: string, at: number) =>
			s.upsertDetectionEscalation({
				...KEY,
				targetKey: target,
				firstDetectedAtMs: at,
			});
		mk("e1", 1_000);
		mk("e2", 2_000);
		mk("e3", 50_000);
		s.resolveDetectionEscalationsForTarget("e2");
		s.upsertDetectionEscalation({
			targetKey: "e4",
			kind: "delivery_unconsumed",
			episodeFingerprint: "fp:x",
			firstDetectedAtMs: 60_000,
		});
		expect(s.countActiveDetectionEscalationsByKind(KEY.kind, 0)).toBe(2);
		expect(s.countActiveDetectionEscalationsByKind(KEY.kind, 10_000)).toBe(1);
		expect(
			s.countActiveDetectionEscalationsByKind("delivery_unconsumed", 0),
		).toBe(1);
	});

	it("survives a reopen of the same DB file — the 30min grace timer continues across a Bridge restart", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "fly1048c1-store-"));
		const dbPath = join(dir, "teamlead.db");
		try {
			const s1 = await StateStore.create(dbPath);
			s1.upsertDetectionEscalation({
				...KEY,
				issueId: "FLY-1048",
				ownerLeadId: "flywheel-eng-lead",
				firstDetectedAtMs: 1_000,
			});
			s1.markDetectionEscalationLeadNotified(
				KEY.targetKey,
				KEY.kind,
				KEY.episodeFingerprint,
				5_000,
			);
			s1.close();
			const s2 = await StateStore.create(dbPath);
			const row = s2.getDetectionEscalation(
				KEY.targetKey,
				KEY.kind,
				KEY.episodeFingerprint,
			)!;
			expect(row.status).toBe("LEAD_NOTIFIED");
			expect(row.lead_notified_at_ms).toBe(5_000);
			expect(row.first_detected_at_ms).toBe(1_000);
			expect(row.issue_id).toBe("FLY-1048");
			expect(row.owner_lead_id).toBe("flywheel-eng-lead");
			s2.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * FLY-1048 PR-C Task C5: target-level CLEARING (cleanup-in-progress mute).
 * Entering cleanup (close-runner / reap / dismiss-with-cleanup) marks every
 * ACTIVE episode of the target CLEARING; ESCALATED and RESOLVED rows are
 * deliberately untouched — a CLEARING→TTL→NEW rebound of an ESCALATED row
 * would re-page the founder (FLY-970's re-alert bug, the exact thing C5 kills).
 */
describe("StateStore detection_escalations C5 target-clearing (FLY-1048)", () => {
	it("markDetectionEscalationsClearingForTarget: NEW/LEAD_NOTIFIED/ACKED → CLEARING with clearing_since_ms; ESCALATED/RESOLVED untouched", async () => {
		const s = await freshStore();
		const mk = (kind: string, fp: string) =>
			s.upsertDetectionEscalation({
				targetKey: "exec-1",
				kind,
				episodeFingerprint: fp,
				firstDetectedAtMs: 1,
			});
		mk("detection_stuck_confirmed", "fp:new");
		mk("delivery_unconsumed", "fp:notified");
		s.markDetectionEscalationLeadNotified(
			"exec-1",
			"delivery_unconsumed",
			"fp:notified",
			10,
		);
		mk("lead_ask_unanswered", "fp:acked");
		s.ackDetectionEscalation("exec-1", "lead_ask_unanswered", "fp:acked", {
			atMs: 20,
			disposition: "ack",
		});
		mk("runner_parked_unreported", "fp:escalated");
		s.markDetectionEscalationEscalated(
			"exec-1",
			"runner_parked_unreported",
			"fp:escalated",
			30,
		);
		mk("delivery_failed_reconcile", "fp:resolved");
		s.ackDetectionEscalation(
			"exec-1",
			"delivery_failed_reconcile",
			"fp:resolved",
			{ atMs: 40, disposition: "resolve" },
		);
		// A different target must be untouched by the sweep.
		s.upsertDetectionEscalation({
			targetKey: "exec-2",
			kind: "detection_stuck_confirmed",
			episodeFingerprint: "fp:other",
			firstDetectedAtMs: 1,
		});

		const n = s.markDetectionEscalationsClearingForTarget("exec-1", 50_000);
		expect(n).toBe(3);

		const status = (kind: string, fp: string) =>
			s.getDetectionEscalation("exec-1", kind, fp)?.status;
		expect(status("detection_stuck_confirmed", "fp:new")).toBe("CLEARING");
		expect(status("delivery_unconsumed", "fp:notified")).toBe("CLEARING");
		expect(status("lead_ask_unanswered", "fp:acked")).toBe("CLEARING");
		expect(status("runner_parked_unreported", "fp:escalated")).toBe(
			"ESCALATED",
		);
		expect(status("delivery_failed_reconcile", "fp:resolved")).toBe("RESOLVED");
		expect(
			s.getDetectionEscalation("exec-1", "detection_stuck_confirmed", "fp:new")
				?.clearing_since_ms,
		).toBe(50_000);
		expect(
			s.getDetectionEscalation(
				"exec-2",
				"detection_stuck_confirmed",
				"fp:other",
			)?.status,
		).toBe("NEW");
	});

	it("hasClearingDetectionEscalationForTarget: true iff the target has a CLEARING row", async () => {
		const s = await freshStore();
		s.upsertDetectionEscalation({
			targetKey: "exec-1",
			kind: "detection_stuck_confirmed",
			episodeFingerprint: "fp:1",
			firstDetectedAtMs: 1,
		});
		expect(s.hasClearingDetectionEscalationForTarget("exec-1")).toBe(false);
		s.markDetectionEscalationsClearingForTarget("exec-1", 10);
		expect(s.hasClearingDetectionEscalationForTarget("exec-1")).toBe(true);
		expect(s.hasClearingDetectionEscalationForTarget("exec-2")).toBe(false);
	});

	it("hasActiveDetectionEscalationForEpisode: any non-RESOLVED row for (target, fingerprint) across kinds", async () => {
		const s = await freshStore();
		s.upsertDetectionEscalation({
			targetKey: "exec-1",
			kind: "delivery_unconsumed",
			episodeFingerprint: "fp:x",
			firstDetectedAtMs: 1,
		});
		expect(s.hasActiveDetectionEscalationForEpisode("exec-1", "fp:x")).toBe(
			true,
		);
		expect(s.hasActiveDetectionEscalationForEpisode("exec-1", "fp:y")).toBe(
			false,
		);
		s.ackDetectionEscalation("exec-1", "delivery_unconsumed", "fp:x", {
			atMs: 5,
			disposition: "resolve",
		});
		expect(s.hasActiveDetectionEscalationForEpisode("exec-1", "fp:x")).toBe(
			false,
		);
	});
});

/**
 * FLY-1048 PR-C (C4/FN4): the delivery-failure reconcile inputs — undelivered
 * lead_events whose retry budget is exhausted or whose age crossed the
 * overdue cutoff, plus the per-seq delivered probe the clear pass uses.
 */
describe("StateStore FN4 delivery-failure queries (FLY-1048 C4)", () => {
	it("returns undelivered rows past the attempts budget", async () => {
		const s = await freshStore();
		const seq = s.appendLeadEvent(
			"eng-lead",
			"ev-1",
			"runner_question",
			"{}",
			"exec-1",
		);
		for (let i = 0; i < 3; i++) s.recordDeliveryFailure(seq, "boom");

		const rows = s.getUndeliveredLeadEventsForReconcile({
			maxAttempts: 3,
			overdueCutoffMs: 0, // epoch cutoff → nothing is "overdue"
		});
		expect(rows.map((r) => r.seq)).toContain(seq);
	});

	it("returns undelivered rows older than the cutoff even with zero attempts", async () => {
		const s = await freshStore();
		const seq = s.appendLeadEvent(
			"eng-lead",
			"ev-2",
			"runner_question",
			"{}",
			"exec-1",
		);
		// A cutoff in the future makes every existing row "overdue" without
		// having to backdate sqlite's datetime('now') created_at.
		const rows = s.getUndeliveredLeadEventsForReconcile({
			maxAttempts: 99,
			overdueCutoffMs: Date.now() + 3_600_000,
		});
		expect(rows.map((r) => r.seq)).toContain(seq);
	});

	it("excludes delivered rows and fresh under-budget rows", async () => {
		const s = await freshStore();
		const delivered = s.appendLeadEvent(
			"eng-lead",
			"ev-3",
			"runner_question",
			"{}",
			"exec-1",
		);
		s.markLeadEventDelivered(delivered);
		const fresh = s.appendLeadEvent(
			"eng-lead",
			"ev-4",
			"runner_question",
			"{}",
			"exec-1",
		);

		const rows = s.getUndeliveredLeadEventsForReconcile({
			maxAttempts: 3,
			overdueCutoffMs: 0,
		});
		const seqs = rows.map((r) => r.seq);
		expect(seqs).not.toContain(delivered);
		expect(seqs).not.toContain(fresh);
	});

	it("isLeadEventDeliveredBySeq: false → true after delivery; null for unknown", async () => {
		const s = await freshStore();
		const seq = s.appendLeadEvent(
			"eng-lead",
			"ev-5",
			"runner_question",
			"{}",
			"exec-1",
		);
		expect(s.isLeadEventDeliveredBySeq(seq)).toBe(false);
		s.markLeadEventDelivered(seq);
		expect(s.isLeadEventDeliveredBySeq(seq)).toBe(true);
		expect(s.isLeadEventDeliveredBySeq(999_999)).toBeNull();
	});
});

/**
 * FLY-1048 PR-C (C5): target-level CLEARING helpers — the bulk mark used by
 * the close-runner cleanup hook, and the mute probe the notify leg consults.
 */
describe("StateStore CLEARING target helpers (FLY-1048 C5)", () => {
	it("bulk-marks every active episode of a target CLEARING without touching other targets or refreshing an existing CLEARING clock", async () => {
		const s = await freshStore();
		for (const [target, fp] of [
			["exec-1", "fp:a"],
			["exec-1", "fp:b"],
			["exec-2", "fp:c"],
		] as const) {
			s.upsertDetectionEscalation({
				targetKey: target,
				kind: "detection_stuck_confirmed",
				episodeFingerprint: fp,
				issueId: "FLY-1",
				ownerLeadId: "lead",
				firstDetectedAtMs: 0,
			});
		}
		// fp:a is ALREADY clearing since t=100 — the bulk mark must not extend
		// its TTL clock (a re-close must not push the rebound out).
		s.markDetectionEscalationClearing(
			"exec-1",
			"detection_stuck_confirmed",
			"fp:a",
			100,
		);

		const n = s.markDetectionEscalationsClearingForTarget("exec-1", 5_000);
		expect(n).toBe(1); // only fp:b transitions
		expect(
			s.getDetectionEscalation("exec-1", "detection_stuck_confirmed", "fp:a")
				?.clearing_since_ms,
		).toBe(100);
		expect(
			s.getDetectionEscalation("exec-1", "detection_stuck_confirmed", "fp:b")
				?.status,
		).toBe("CLEARING");
		expect(
			s.getDetectionEscalation("exec-2", "detection_stuck_confirmed", "fp:c")
				?.status,
		).toBe("NEW");
	});

	it("hasClearingDetectionEscalationForTarget probes the target-level mute", async () => {
		const s = await freshStore();
		s.upsertDetectionEscalation({
			targetKey: "exec-1",
			kind: "detection_stuck_confirmed",
			episodeFingerprint: "fp:a",
			issueId: "FLY-1",
			ownerLeadId: "lead",
			firstDetectedAtMs: 0,
		});
		expect(s.hasClearingDetectionEscalationForTarget("exec-1")).toBe(false);
		s.markDetectionEscalationClearing(
			"exec-1",
			"detection_stuck_confirmed",
			"fp:a",
			100,
		);
		expect(s.hasClearingDetectionEscalationForTarget("exec-1")).toBe(true);
		expect(s.hasClearingDetectionEscalationForTarget("exec-2")).toBe(false);
	});
});

/**
 * FLY-1048 Codex code R1 #1: a RESOLVED fingerprint must never permanently
 * silence a RECURRENCE — but a Lead dismissing a STILL-frozen pane keeps its
 * receipt. Boundary = the new detection is NEWER than the resolution moment.
 */
describe("StateStore detection_escalations RESOLVED-revive boundary (Codex R1 #1)", () => {
	it("re-detection NEWER than a RECOVERY resolution revives the episode as NEW", async () => {
		const s = await freshStore();
		s.upsertDetectionEscalation({ ...KEY, firstDetectedAtMs: 1_000 });
		s.markDetectionEscalationLeadNotified(
			KEY.targetKey,
			KEY.kind,
			KEY.episodeFingerprint,
			2_000,
		);
		s.ackDetectionEscalation(KEY.targetKey, KEY.kind, KEY.episodeFingerprint, {
			atMs: 3_000,
			disposition: "resolve",
			via: "recovery", // machine-proven clear (progress / condition gone)
		});

		const revived = s.upsertDetectionEscalation({
			...KEY,
			firstDetectedAtMs: 10_000, // after the 3_000 resolution → recurrence
		});
		expect(revived.created).toBe(true);
		expect(revived.row.status).toBe("NEW");
		expect(revived.row.first_detected_at_ms).toBe(10_000);
		expect(revived.row.lead_notified_at_ms).toBeNull();
		expect(revived.row.lead_ack_at_ms).toBeNull();
		expect(revived.row.founder_paged_at_ms).toBeNull();
	});

	it("a LEAD resolution never revives — restart-reset clocks must not re-notify a dismissed condition (Codex R2 #1)", async () => {
		const s = await freshStore();
		s.upsertDetectionEscalation({ ...KEY, firstDetectedAtMs: 1_000 });
		s.ackDetectionEscalation(KEY.targetKey, KEY.kind, KEY.episodeFingerprint, {
			atMs: 3_000,
			disposition: "resolve", // default via: 'lead' — a human receipt
		});

		// A Bridge restart rebuilds the in-process detection clock: the same
		// persistent condition re-arrives with firstDetectedAtMs = "now".
		const afterRestart = s.upsertDetectionEscalation({
			...KEY,
			firstDetectedAtMs: 999_999,
		});
		expect(afterRestart.created).toBe(false);
		expect(afterRestart.row.status).toBe("RESOLVED");
	});

	it("a dismissed-but-unchanged episode (same detection start) stays RESOLVED", async () => {
		const s = await freshStore();
		s.upsertDetectionEscalation({ ...KEY, firstDetectedAtMs: 1_000 });
		s.ackDetectionEscalation(KEY.targetKey, KEY.kind, KEY.episodeFingerprint, {
			atMs: 3_000,
			disposition: "dismiss",
		});

		// The pane never changed: re-detections keep carrying the ORIGINAL
		// episode start, which predates the Lead's dismissal.
		const again = s.upsertDetectionEscalation({
			...KEY,
			firstDetectedAtMs: 1_000,
		});
		expect(again.created).toBe(false);
		expect(again.row.status).toBe("RESOLVED");
	});

	it("recovery resolutions without an ack stamp revive on any newer detection", async () => {
		const s = await freshStore();
		s.upsertDetectionEscalation({ ...KEY, firstDetectedAtMs: 1_000 });
		// resolveDetectionEscalationsForTarget stamps NO lead_ack_at_ms — the
		// boundary falls back to first_detected_at_ms.
		s.resolveDetectionEscalationsForTarget(KEY.targetKey);

		const revived = s.upsertDetectionEscalation({
			...KEY,
			firstDetectedAtMs: 5_000,
		});
		expect(revived.created).toBe(true);
		expect(revived.row.status).toBe("NEW");
	});
});

/**
 * Codex PR-C R3 finding 3 (MEDIUM): the FN4 reconcile query must exclude the
 * detection-family event types BEFORE its LIMIT — 100 excluded rows must
 * never starve a later genuine delivery failure out of every pass.
 */
describe("getUndeliveredLeadEventsForReconcile excludes detection-family pre-LIMIT (Codex R3 #3)", () => {
	it("a real failure behind 100+ excluded rows is still returned", async () => {
		const s = await freshStore();
		for (let i = 0; i < 110; i++) {
			s.appendLeadEvent(
				"eng-lead",
				`det-${i}`,
				"detection_escalation",
				"{}",
				`exec-${i}`,
			);
		}
		const realSeq = s.appendLeadEvent(
			"eng-lead",
			"real-1",
			"runner_question",
			"{}",
			"exec-real",
		);
		for (let i = 0; i < 5; i++) {
			s.recordDeliveryFailure(realSeq, "boom");
		}
		const rows = s.getUndeliveredLeadEventsForReconcile({
			maxAttempts: 5,
			// Future cutoff ⇒ every undelivered row (the 110 excluded ones too) is
			// "overdue" — without pre-LIMIT exclusion they fill all 100 slots.
			overdueCutoffMs: Date.now() + 600_000,
			excludedEventTypes: ["detection_escalation", "detection_suspicious"],
		});
		expect(rows.some((r) => r.seq === realSeq)).toBe(true);
		expect(rows.every((r) => r.event_type !== "detection_escalation")).toBe(
			true,
		);
	});
});

/**
 * Codex PR-C R6 finding 1+2 (HIGH): the durable lead-event append and the
 * NEW→LEAD_NOTIFIED claim must be ONE durability unit (single save() commit
 * point — the exported snapshot carries both or neither), and the claim
 * backfills owner_lead_id so a no_owner→recovered retry cannot strand the
 * fleet escalation on "unassigned".
 */
describe("appendAndClaimDetectionEscalation (Codex R6 #1/#2)", () => {
	const KEY6 = {
		targetKey: "exec-6",
		kind: "detection_stuck_confirmed",
		episodeFingerprint: "fp:r6",
	} as const;

	it("the winner gets {claimed:true, seq}, the row is LEAD_NOTIFIED, and the event exists", async () => {
		const s = await freshStore();
		s.upsertDetectionEscalation({ ...KEY6, firstDetectedAtMs: 1 });
		const r = s.appendAndClaimDetectionEscalation({
			leadId: "eng-lead",
			eventId: "ev-r6",
			eventType: "detection_escalation",
			payload: "{}",
			sessionKey: "exec-6",
			...KEY6,
			ownerLeadId: "eng-lead",
			atMs: 9_000,
		});
		expect(r.claimed).toBe(true);
		expect(r.seq).toBeGreaterThan(0);
		const row = s.getDetectionEscalation(
			KEY6.targetKey,
			KEY6.kind,
			KEY6.episodeFingerprint,
		)!;
		expect(row.status).toBe("LEAD_NOTIFIED");
		expect(row.lead_notified_at_ms).toBe(9_000);
	});

	it("a second call LOSES: {claimed:false}, same seq, no new event row", async () => {
		const s = await freshStore();
		s.upsertDetectionEscalation({ ...KEY6, firstDetectedAtMs: 1 });
		const args = {
			leadId: "eng-lead",
			eventId: "ev-r6",
			eventType: "detection_escalation",
			payload: "{}",
			sessionKey: "exec-6",
			...KEY6,
			ownerLeadId: "eng-lead",
			atMs: 9_000,
		};
		const first = s.appendAndClaimDetectionEscalation(args);
		const second = s.appendAndClaimDetectionEscalation({
			...args,
			atMs: 10_000,
		});
		expect(second.claimed).toBe(false);
		expect(second.seq).toBe(first.seq);
		// First notification timestamp wins (grace anchor).
		expect(
			s.getDetectionEscalation(
				KEY6.targetKey,
				KEY6.kind,
				KEY6.episodeFingerprint,
			)?.lead_notified_at_ms,
		).toBe(9_000);
	});

	it("the claim BACKFILLS a null owner_lead_id (no_owner → recovered), never overwrites an existing one", async () => {
		const s = await freshStore();
		// Seeded by an ownerless first detection.
		s.upsertDetectionEscalation({
			...KEY6,
			ownerLeadId: null,
			firstDetectedAtMs: 1,
		});
		s.appendAndClaimDetectionEscalation({
			leadId: "eng-lead",
			eventId: "ev-r6",
			eventType: "detection_escalation",
			payload: "{}",
			sessionKey: "exec-6",
			...KEY6,
			ownerLeadId: "eng-lead",
			atMs: 9_000,
		});
		expect(
			s.getDetectionEscalation(
				KEY6.targetKey,
				KEY6.kind,
				KEY6.episodeFingerprint,
			)?.owner_lead_id,
		).toBe("eng-lead");
	});
});
