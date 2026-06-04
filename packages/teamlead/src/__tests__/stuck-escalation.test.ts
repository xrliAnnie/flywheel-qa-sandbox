/**
 * FLY-195: tests for the Bridge wiring layer (plan §3.2 + §3.6) — the
 * escalation emitter, the Q7 Annie alerter, env knobs, guardrail membership,
 * and the Lead-rules pin (ladder constants must not drift from the prompt).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	GUARDRAIL_EVENT_TYPES,
	RETRYABLE_LEAD_EVENT_TYPES,
} from "../bridge/lead-runtime.js";
import {
	buildStuckRunnerDetector,
	createStuckEscalationEmitter,
	createStuckUnhandledAlerter,
	stuckDetectionEnabled,
	stuckEscalationEventId,
	stuckLeadGraceMs,
	stuckThresholdMs,
	stuckUnhandledEventId,
} from "../bridge/stuck-escalation.js";
import { LEAD_GRACE_MS } from "../bridge/stuck-runner-detector.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session } from "../StateStore.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "geo",
		projectRoot: "/tmp/geo",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "f",
				chatChannel: "c",
				match: { labels: ["Product"] },
			},
		],
	},
] as unknown as ProjectEntry[];

function makeSession(over: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-1",
		issue_id: "FLY-1",
		issue_identifier: "FLY-1",
		project_name: "geo",
		status: "running",
		issue_labels: "Product",
		...over,
	} as Session;
}

const EVIDENCE = {
	stuck_minutes: 12,
	tail: "❯ ",
	stream_error_signature: true,
	input_box_present: true,
};

function escalationPayload() {
	return {
		session: makeSession(),
		evidence: EVIDENCE,
		episodeFingerprint: "abcdef0123456789",
		episodeStartedAt: 1_000,
	};
}

function mockStore() {
	const appended: Array<{
		leadId: string;
		eventId: string;
		eventType: string;
		payload: string;
	}> = [];
	return {
		appended,
		appendLeadEvent: vi.fn(
			(leadId: string, eventId: string, eventType: string, payload: string) => {
				appended.push({ leadId, eventId, eventType, payload });
				return appended.length;
			},
		),
		isLeadEventDelivered: vi.fn(() => false),
		markLeadEventDelivered: vi.fn(),
		recordDeliveryFailure: vi.fn(),
		getStuckDisposition: vi.fn(() => undefined),
	};
}

function mockRegistry(delivered = true) {
	const deliver = vi.fn(async () => ({ delivered }));
	return {
		deliver,
		registry: { getForLead: vi.fn(() => ({ deliver })) },
	};
}

describe("guardrail membership", () => {
	it("runner_stuck_escalation is guardrail + retryable", () => {
		expect(GUARDRAIL_EVENT_TYPES.has("runner_stuck_escalation")).toBe(true);
		expect(RETRYABLE_LEAD_EVENT_TYPES.has("runner_stuck_escalation")).toBe(
			true,
		);
	});
});

describe("createStuckEscalationEmitter", () => {
	it("persists + delivers to the owning Lead with full evidence payload", async () => {
		const store = mockStore();
		const { registry, deliver } = mockRegistry();
		const emit = createStuckEscalationEmitter({
			store: store as never,
			projects: testProjects,
			runtimeRegistry: registry as never,
			log: () => {},
		});
		const ok = await emit(escalationPayload());
		expect(ok).toBe(true);
		expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);
		const row = store.appended[0]!;
		expect(row.leadId).toBe("product-lead");
		expect(row.eventType).toBe("runner_stuck_escalation");
		expect(row.eventId).toBe(
			stuckEscalationEventId("exec-1", "abcdef0123456789", 1_000),
		);
		const payload = JSON.parse(row.payload);
		expect(payload.stuck_minutes).toBe(12);
		expect(payload.episode_fingerprint).toBe("abcdef0123456789");
		expect(payload.stream_error_signature).toBe(true);
		expect(payload.input_box_present).toBe(true);
		expect(payload.terminal_tail).toBe("❯ ");
		// Lead guidance points at the two remanage endpoints + FLY-175 boundary.
		expect(payload.stage_context).toContain("recovery-nudge");
		expect(payload.stage_context).toContain("stuck-disposition");
		expect(payload.stage_context).toContain("FLY-175");
		expect(deliver).toHaveBeenCalledTimes(1);
		expect(store.markLeadEventDelivered).toHaveBeenCalledWith(1);
	});

	it("returns false when no owning Lead resolves (unknown project)", async () => {
		const store = mockStore();
		const { registry } = mockRegistry();
		const emit = createStuckEscalationEmitter({
			store: store as never,
			projects: testProjects,
			runtimeRegistry: registry as never,
			log: () => {},
		});
		const ok = await emit({
			...escalationPayload(),
			session: makeSession({ project_name: "ghost-project" }),
		});
		expect(ok).toBe(false);
		expect(store.appendLeadEvent).not.toHaveBeenCalled();
	});

	it("skips re-append for an already-delivered episode eventId", async () => {
		const store = mockStore();
		store.isLeadEventDelivered.mockReturnValue(true);
		const { registry } = mockRegistry();
		const emit = createStuckEscalationEmitter({
			store: store as never,
			projects: testProjects,
			runtimeRegistry: registry as never,
			log: () => {},
		});
		expect(await emit(escalationPayload())).toBe(true);
		expect(store.appendLeadEvent).not.toHaveBeenCalled();
	});

	it("records the delivery failure (guardrail retry owns redelivery) and still returns true", async () => {
		const store = mockStore();
		const { registry } = mockRegistry(false);
		const emit = createStuckEscalationEmitter({
			store: store as never,
			projects: testProjects,
			runtimeRegistry: registry as never,
			log: () => {},
		});
		expect(await emit(escalationPayload())).toBe(true);
		expect(store.recordDeliveryFailure).toHaveBeenCalledTimes(1);
		expect(store.markLeadEventDelivered).not.toHaveBeenCalled();
	});
});

describe("createStuckUnhandledAlerter (Q7)", () => {
	function unhandledPayload() {
		return {
			session: makeSession(),
			episodeFingerprint: "abcdef0123456789",
			stuckMinutes: 17,
			escalatedAt: 5_000,
		};
	}

	it("pages via the notifier with the MEDIUM-5 eventId format and no raw pane content", async () => {
		const alert = vi.fn(async () => ({ sent: true }));
		const alerter = createStuckUnhandledAlerter(
			testProjects,
			{ alert },
			() => {},
		);
		expect(await alerter(unhandledPayload())).toBe(true);
		expect(alert).toHaveBeenCalledTimes(1);
		const payload = alert.mock.calls[0]![0] as Record<string, unknown>;
		expect(payload.eventType).toBe("runner_stuck_unhandled");
		expect(payload.eventId).toBe(
			stuckUnhandledEventId("exec-1", "abcdef0123456789"),
		);
		expect(payload.eventId).toBe(
			"runner-stuck-unhandled:exec-1:abcdef0123456789",
		);
		expect(payload.leadId).toBe("product-lead");
		expect(payload.severity).toBe("warning");
		// privacy: body explains, but carries no terminal capture
		expect(String(payload.body)).not.toContain("❯");
	});

	it("treats queued and duplicate outcomes as resolved", async () => {
		for (const result of [
			{ queued: true },
			{ skipped: "duplicate" as const },
		]) {
			const alerter = createStuckUnhandledAlerter(
				testProjects,
				{ alert: vi.fn(async () => result) },
				() => {},
			);
			expect(await alerter(unhandledPayload())).toBe(true);
		}
	});

	it("unresolvable lead or hard-skip outcomes are NOT resolved (retry next poll)", async () => {
		const ghost = createStuckUnhandledAlerter(
			testProjects,
			{ alert: vi.fn(async () => ({ sent: true })) },
			() => {},
		);
		expect(
			await ghost({
				...unhandledPayload(),
				session: makeSession({ project_name: "ghost" }),
			}),
		).toBe(false);

		const skipped = createStuckUnhandledAlerter(
			testProjects,
			{ alert: vi.fn(async () => ({ skipped: "no-channel" as const })) },
			() => {},
		);
		expect(await skipped(unhandledPayload())).toBe(false);
	});
});

describe("env knobs (plan §3.7)", () => {
	it("master switch defaults ON; FLYWHEEL_STUCK_DETECT=0 disables", () => {
		expect(stuckDetectionEnabled({} as NodeJS.ProcessEnv)).toBe(true);
		expect(
			stuckDetectionEnabled({
				FLYWHEEL_STUCK_DETECT: "0",
			} as NodeJS.ProcessEnv),
		).toBe(false);
		expect(
			stuckDetectionEnabled({
				FLYWHEEL_STUCK_DETECT: "1",
			} as NodeJS.ProcessEnv),
		).toBe(true);
	});

	it("threshold/grace parse with safe fallbacks", () => {
		expect(stuckThresholdMs({} as NodeJS.ProcessEnv)).toBe(600_000);
		expect(stuckLeadGraceMs({} as NodeJS.ProcessEnv)).toBe(LEAD_GRACE_MS);
		expect(
			stuckThresholdMs({
				FLYWHEEL_STUCK_THRESHOLD_MS: "120000",
			} as NodeJS.ProcessEnv),
		).toBe(120_000);
		expect(
			stuckLeadGraceMs({
				FLYWHEEL_STUCK_LEAD_GRACE_MS: "60000",
			} as NodeJS.ProcessEnv),
		).toBe(60_000);
		for (const bad of ["abc", "-5", "0", ""]) {
			expect(
				stuckThresholdMs({
					FLYWHEEL_STUCK_THRESHOLD_MS: bad,
				} as NodeJS.ProcessEnv),
			).toBe(600_000);
		}
	});

	it("buildStuckRunnerDetector returns null when disabled", () => {
		const store = mockStore();
		const { registry } = mockRegistry();
		const detector = buildStuckRunnerDetector({
			store: store as never,
			projects: testProjects,
			runtimeRegistry: registry as never,
			notifier: { alert: vi.fn(async () => ({ sent: true })) },
			env: { FLYWHEEL_STUCK_DETECT: "0" } as NodeJS.ProcessEnv,
			log: () => {},
		});
		expect(detector).toBeNull();
		const enabled = buildStuckRunnerDetector({
			store: store as never,
			projects: testProjects,
			runtimeRegistry: registry as never,
			notifier: { alert: vi.fn(async () => ({ sent: true })) },
			env: {} as NodeJS.ProcessEnv,
			log: () => {},
		});
		expect(enabled).not.toBeNull();
	});
});

// ── Lead rules pin (Codex R2 LOW-R2-1: ladder constants must not drift) ──

describe("stuck-runner-remanage Lead rules pin", () => {
	const rulesPath = join(
		__dirname,
		"..",
		"..",
		"lead-rules-base",
		"stuck-runner-remanage.md",
	);
	const rules = readFileSync(rulesPath, "utf8");

	it("pins the bounded mailbox-wake wait (MAILBOX_WAKE_WAIT_MS = 60s)", () => {
		expect(rules).toContain("MAILBOX_WAKE_WAIT_MS");
		expect(rules).toMatch(/60[\s_]*seconds|60_000 ms/);
	});

	it("pins the nudge allowlist phrase and both endpoint paths", () => {
		expect(rules).toContain("`continue`");
		expect(rules).toContain("/recovery-nudge");
		expect(rules).toContain("/stuck-disposition");
	});

	it("pins the explicit disposition values and the FLY-175 boundary", () => {
		for (const d of [
			"false_positive",
			"legitimate_wait",
			"snooze",
			"needs_founder",
			"handled_remanaged",
		]) {
			expect(rules).toContain(d);
		}
		expect(rules).toContain("FLY-175");
	});

	it("pins the Q6 default cadence (ping on action, silent on false alarm)", () => {
		expect(rules).toMatch(/ping Annie once/i);
		expect(rules).toMatch(/stay silent/i);
	});

	it("claude-lead.sh loads the rules file for dept leads", () => {
		const sh = readFileSync(
			join(__dirname, "..", "..", "scripts", "claude-lead.sh"),
			"utf8",
		);
		expect(sh).toContain("stuck-runner-remanage.md");
	});
});
