/**
 * FLY-1048 PR-C (C4): pure mapping from the observation layers (A6 gap scan /
 * A7 focused frames) into the unified escalation flow, plus the FN4
 * lead_events delivery reconcile (evidence-honest scope: only delivery
 * attempts that EXIST today — attempts exhausted / undelivered overdue).
 */

import { describe, expect, it } from "vitest";
import {
	buildCaseCEscalationInput,
	buildDeliveryFailureInput,
	buildGapEscalationInput,
	type DeliveryFailureCandidate,
	deliveryFailureFingerprint,
	evaluateDeliveryFailures,
	fallbackCaseCFingerprint,
	GAP_ESCALATION_KINDS,
	gapSuspicionFingerprint,
	parseDeliveryFailureFingerprint,
} from "../detection-detector-wiring.js";
import type { SuspicionRecord } from "../detection-gap-scan.js";
import { fingerprintOutput } from "../stuck-candidate.js";

const T0 = 1_700_000_000_000;

const SESSION = {
	execution_id: "exec-1",
	issue_id: "issue-uuid-1",
	issue_identifier: "FLY-1",
	project_name: "geo",
};

function record(over: Partial<SuspicionRecord> = {}): SuspicionRecord {
	return {
		kind: "gap1_parked_unreported",
		targetKey: "exec-1",
		projectName: "geo",
		firstSeenMs: T0,
		evidence: "parked/awaiting with no reporting artifact",
		...over,
	};
}

describe("gap suspicion → escalation input (FLY-1048 C4)", () => {
	it("maps the three notifiable gap kinds to their PRD escalation kinds", () => {
		expect(GAP_ESCALATION_KINDS.gap1_parked_unreported).toBe(
			"runner_parked_unreported",
		);
		expect(GAP_ESCALATION_KINDS.gap2_ask_unanswered).toBe(
			"lead_ask_unanswered",
		);
		expect(GAP_ESCALATION_KINDS.delivery_unconsumed).toBe(
			"delivery_unconsumed",
		);
	});

	it("pane_progress_suspect NEVER escalates directly (it only feeds A7)", () => {
		expect(
			buildGapEscalationInput(
				record({ kind: "pane_progress_suspect" }),
				SESSION,
			),
		).toBeNull();
	});

	it("builds a complete input: kind, stable fingerprint, evidence-bearing reason", () => {
		const input = buildGapEscalationInput(record(), SESSION);
		expect(input).not.toBeNull();
		expect(input!.kind).toBe("runner_parked_unreported");
		expect(input!.targetKey).toBe("exec-1");
		expect(input!.executionId).toBe("exec-1");
		expect(input!.issueId).toBe("issue-uuid-1");
		expect(input!.issueIdentifier).toBe("FLY-1");
		expect(input!.projectName).toBe("geo");
		expect(input!.firstDetectedAtMs).toBe(T0);
		expect(input!.reason).toContain("parked/awaiting with no reporting");
		expect(input!.nextStep).toBeTruthy();
		expect(input!.episodeFingerprint).toBe(gapSuspicionFingerprint(record()));
	});

	it("fingerprint is restart-durable: keyed by (kind, target) only (Codex R1 #9)", () => {
		expect(gapSuspicionFingerprint(record())).toBe(
			gapSuspicionFingerprint(record()),
		);
		// A Bridge restart resets the in-process firstSeenMs — the fingerprint
		// must NOT move with it, or the same persistent condition would mint a
		// duplicate episode with a fresh founder-grace clock. Recurrence after
		// a genuine clear re-arms via the store's RESOLVED-revive boundary.
		expect(gapSuspicionFingerprint(record({ firstSeenMs: T0 + 999_999 }))).toBe(
			gapSuspicionFingerprint(record()),
		);
		// Kinds never collide on the same target.
		expect(
			gapSuspicionFingerprint(record({ kind: "gap2_ask_unanswered" })),
		).not.toBe(gapSuspicionFingerprint(record()));
	});
});

describe("case-c escalation input (FLY-1048 C4)", () => {
	it("silence → the legacy full-output fingerprint family (old-flow key alignment)", () => {
		const frame = "frozen pane text";
		expect(
			fallbackCaseCFingerprint(
				{ silenceDelta: true, repeatedErrorSig: null },
				frame,
			),
		).toBe(fingerprintOutput(frame));
	});

	it("changing pane with a repeated signature → the sig: fingerprint family", () => {
		const fp = fallbackCaseCFingerprint(
			{
				silenceDelta: false,
				repeatedErrorSig: {
					kind: "enoent_loop",
					line: "ENOENT /tmp/x",
					signature: "enoent <path>",
				},
			},
			"pane that keeps changing",
		);
		expect(fp).toMatch(/^sig:[0-9a-f]{16}$/);
	});

	it("a static pane that ALSO carries a signature keys by the full output (legacy episode)", () => {
		const frame = "static error pane";
		expect(
			fallbackCaseCFingerprint(
				{
					silenceDelta: true,
					repeatedErrorSig: {
						kind: "not_logged_in",
						line: "Not logged in",
						signature: "not logged in",
					},
				},
				frame,
			),
		).toBe(fingerprintOutput(frame));
	});

	it("builds a pane-free input with the confirmed-c kind", () => {
		const input = buildCaseCEscalationInput(SESSION, "abcd1234abcd1234", {
			reason: "多帧静默无 token 流,case-c 已确认",
			firstDetectedAtMs: T0,
		});
		expect(input.kind).toBe("detection_stuck_confirmed");
		expect(input.episodeFingerprint).toBe("abcd1234abcd1234");
		expect(input.firstDetectedAtMs).toBe(T0);
		expect(input.reason).not.toContain("\n"); // one-liner, never a pane dump
	});
});

describe("FN4 delivery-failure reconcile (FLY-1048 C4, evidence-honest scope)", () => {
	function candidate(
		over: Partial<DeliveryFailureCandidate> = {},
	): DeliveryFailureCandidate {
		return {
			seq: 42,
			leadId: "eng-lead",
			eventType: "runner_question",
			sessionKey: "exec-1",
			deliveryAttempts: 0,
			createdAtMs: T0 - 60_000,
			...over,
		};
	}
	const OPTS = { maxAttempts: 3, overdueMs: 1_800_000 };

	it("attempts exhausted → attempts_exhausted finding", () => {
		const found = evaluateDeliveryFailures(
			[candidate({ deliveryAttempts: 3 })],
			T0,
			OPTS,
		);
		expect(found).toHaveLength(1);
		expect(found[0]!.reason).toBe("attempts_exhausted");
		expect(found[0]!.seq).toBe(42);
	});

	it("undelivered past the overdue window → undelivered_overdue finding", () => {
		const found = evaluateDeliveryFailures(
			[candidate({ createdAtMs: T0 - 1_800_001 })],
			T0,
			OPTS,
		);
		expect(found).toHaveLength(1);
		expect(found[0]!.reason).toBe("undelivered_overdue");
	});

	it("fresh row under both thresholds → no finding", () => {
		expect(evaluateDeliveryFailures([candidate()], T0, OPTS)).toHaveLength(0);
	});

	it("unknown created_at only fires on the attempts leg (never guess an age)", () => {
		expect(
			evaluateDeliveryFailures([candidate({ createdAtMs: null })], T0, OPTS),
		).toHaveLength(0);
		expect(
			evaluateDeliveryFailures(
				[candidate({ createdAtMs: null, deliveryAttempts: 5 })],
				T0,
				OPTS,
			),
		).toHaveLength(1);
	});

	it("rows without a sessionKey are skipped (unroutable — no issue to page into)", () => {
		expect(
			evaluateDeliveryFailures(
				[candidate({ sessionKey: undefined, deliveryAttempts: 5 })],
				T0,
				OPTS,
			),
		).toHaveLength(0);
	});

	it("detection-family events are excluded (a failing detection event must not recurse)", () => {
		for (const eventType of ["detection_escalation", "detection_suspicious"]) {
			expect(
				evaluateDeliveryFailures(
					[candidate({ eventType, deliveryAttempts: 5 })],
					T0,
					OPTS,
				),
			).toHaveLength(0);
		}
	});

	it("fingerprint is per (lead, seq) and round-trips through the parser", () => {
		const found = evaluateDeliveryFailures(
			[candidate({ deliveryAttempts: 3 })],
			T0,
			OPTS,
		)[0]!;
		const fp = deliveryFailureFingerprint(found);
		expect(fp).toBe("fn4:eng-lead:42");
		expect(parseDeliveryFailureFingerprint(fp)).toEqual({
			leadId: "eng-lead",
			seq: 42,
		});
		expect(parseDeliveryFailureFingerprint("gap:whatever")).toBeNull();
		expect(parseDeliveryFailureFingerprint("fn4:no-seq:")).toBeNull();
	});

	it("builds a delivery_failed_reconcile input naming the failed transport leg", () => {
		const found = evaluateDeliveryFailures(
			[candidate({ deliveryAttempts: 3 })],
			T0,
			OPTS,
		)[0]!;
		const input = buildDeliveryFailureInput(found, SESSION, T0);
		expect(input.kind).toBe("delivery_failed_reconcile");
		expect(input.episodeFingerprint).toBe("fn4:eng-lead:42");
		expect(input.targetKey).toBe("exec-1");
		expect(input.reason).toContain("eng-lead");
		expect(input.reason).toContain("runner_question");
	});
});
