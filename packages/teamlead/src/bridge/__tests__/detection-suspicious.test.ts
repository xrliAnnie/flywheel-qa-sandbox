/**
 * FLY-1048 Task A5: fail-suspicious delivery contract.
 *
 * "Never silent": mechanical uncertainty becomes a QUIET owner-Lead report —
 * lead_event (guardrail-retried) + optional issue-thread note (reason only).
 * Echo-poisoning guard: pane lines are ▏-quoted so re-captured panes never
 * re-trigger the scanners. Founder face NEVER carries raw pane content.
 */

import { describe, expect, it, vi } from "vitest";
import { CommDBLeadRuntime } from "../commdb-lead-runtime.js";
import {
	deliverSuspiciousReport,
	formatSuspiciousThreadNote,
	quotePaneTail,
	type SuspiciousDeliveryDeps,
	type SuspiciousReport,
	suspiciousEventId,
} from "../detection-suspicious.js";
import { scanErrorSignatures } from "../error-signatures.js";
import {
	formatDetectionSuspicious,
	type HookPayload,
} from "../hook-payload.js";
import {
	GUARDRAIL_EVENT_TYPES,
	type LeadEventEnvelope,
} from "../lead-runtime.js";
import { MailboxLeadRuntime } from "../mailbox-lead-runtime.js";

function report(over: Partial<SuspiciousReport> = {}): SuspiciousReport {
	return {
		targetKind: "lead",
		targetKey: "geoforge3d:cos-lead",
		reason: "frozen_extended_thinking: cannot conclude idle vs hung",
		paneTail: "✢ Pondering… (11m 3s · almost done thinking)\n❯",
		episodeFingerprint: "abc123",
		...over,
	};
}

interface StoreStub {
	insertEvent: ReturnType<typeof vi.fn>;
	appendLeadEvent: ReturnType<typeof vi.fn>;
	markLeadEventDelivered: ReturnType<typeof vi.fn>;
	recordDeliveryFailure: ReturnType<typeof vi.fn>;
	inserted: Set<string>;
}

function makeStore(): StoreStub {
	const inserted = new Set<string>();
	return {
		inserted,
		insertEvent: vi.fn((e: { event_id: string }) => {
			if (inserted.has(e.event_id)) return false;
			inserted.add(e.event_id);
			return true;
		}),
		appendLeadEvent: vi.fn(() => 42),
		markLeadEventDelivered: vi.fn(),
		recordDeliveryFailure: vi.fn(),
	};
}

function makeDeps(
	store: StoreStub,
	over: Partial<SuspiciousDeliveryDeps> = {},
): SuspiciousDeliveryDeps & {
	delivered: LeadEventEnvelope[];
} {
	const delivered: LeadEventEnvelope[] = [];
	return {
		delivered,
		store,
		runtimeRegistry: {
			getForLead: () => ({
				deliver: async (env: LeadEventEnvelope) => {
					delivered.push(env);
					return { delivered: true };
				},
			}),
		},
		resolveOwner: (r: SuspiciousReport) =>
			r.targetKind === "lead"
				? { leadId: "cos-lead", projectName: "geoforge3d" }
				: {
						leadId: "eng-lead",
						projectName: "flywheel",
						executionId: r.targetKey,
						issueId: "FLY-1",
					},
		...over,
	} as never;
}

describe("quotePaneTail (echo-poisoning guard)", () => {
	it("prefixes every line with ▏ and the scanner skips them", () => {
		const quoted = quotePaneTail(
			"  ⎿  Error: ENOENT: no such file, open '/tmp/x'\nNot logged in.",
		);
		for (const line of quoted.split("\n")) {
			expect(line.startsWith("▏")).toBe(true);
		}
		expect(scanErrorSignatures(quoted)).toEqual([]);
	});
});

describe("deliverSuspiciousReport", () => {
	it("delivers a lead_event with typed payload fields + quoted tail", async () => {
		const store = makeStore();
		const deps = makeDeps(store);
		const r = report();
		const outcome = await deliverSuspiciousReport(deps, r);
		expect(outcome).toBe("delivered");
		expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);
		const [leadId, eventId, eventType, payloadJson] = store.appendLeadEvent.mock
			.calls[0] as string[];
		expect(leadId).toBe("cos-lead");
		expect(eventId).toBe(suspiciousEventId(r));
		expect(eventType).toBe("detection_suspicious");
		const payload = JSON.parse(payloadJson!) as HookPayload;
		expect(payload.detection_target_kind).toBe("lead");
		expect(payload.detection_target_key).toBe("geoforge3d:cos-lead");
		expect(payload.suspicious_reason).toContain("frozen_extended_thinking");
		// The pane tail travels QUOTED so a re-captured pane never re-triggers.
		for (const line of (payload.suspicious_pane_tail ?? "").split("\n")) {
			expect(line.startsWith("▏")).toBe(true);
		}
		expect(deps.delivered).toHaveLength(1);
		expect(store.markLeadEventDelivered).toHaveBeenCalledWith(42);
	});

	it("dedups per (targetKey, episodeFingerprint) — once, durable", async () => {
		const store = makeStore();
		const deps = makeDeps(store);
		expect(await deliverSuspiciousReport(deps, report())).toBe("delivered");
		expect(await deliverSuspiciousReport(deps, report())).toBe("duplicate");
		expect(store.appendLeadEvent).toHaveBeenCalledTimes(1);
	});

	it("same fingerprint on DIFFERENT targets is NOT cross-deduped", async () => {
		const store = makeStore();
		const deps = makeDeps(store);
		await deliverSuspiciousReport(deps, report());
		const other = report({ targetKey: "geoforge3d:ops-lead" });
		expect(await deliverSuspiciousReport(deps, other)).toBe("delivered");
	});

	it("records a delivery failure for guardrail retry (never throws)", async () => {
		const store = makeStore();
		const deps = makeDeps(store, {
			runtimeRegistry: {
				getForLead: () => ({
					deliver: async () => ({ delivered: false, error: "boom" }),
				}),
			},
		} as never);
		const outcome = await deliverSuspiciousReport(deps, report());
		expect(outcome).toBe("delivered");
		expect(store.recordDeliveryFailure).toHaveBeenCalledWith(42, "boom");
	});

	it("no resolvable owner → no_owner (logged, no throw, nothing appended)", async () => {
		const store = makeStore();
		const deps = makeDeps(store, { resolveOwner: () => null } as never);
		expect(await deliverSuspiciousReport(deps, report())).toBe("no_owner");
		expect(store.appendLeadEvent).not.toHaveBeenCalled();
	});

	it("thread-note leg is invoked when wired, and its text NEVER carries the pane", async () => {
		const store = makeStore();
		const notes: string[] = [];
		const deps = makeDeps(store, {
			emitThreadNote: async (r: SuspiciousReport) => {
				notes.push(formatSuspiciousThreadNote(r));
			},
		} as never);
		await deliverSuspiciousReport(deps, report());
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("frozen_extended_thinking");
		expect(notes[0]).not.toContain("Pondering");
		expect(notes[0]).not.toContain("▏");
	});
});

describe("detection_suspicious rendering (parity across runtimes)", () => {
	function suspiciousEnvelope(): LeadEventEnvelope {
		const payload: HookPayload = {
			event_type: "detection_suspicious",
			execution_id: "geoforge3d:cos-lead",
			issue_id: "unknown",
			project_name: "geoforge3d",
			status: "detection_suspicious",
			detection_target_kind: "lead",
			detection_target_key: "geoforge3d:cos-lead",
			suspicious_reason:
				"frozen_extended_thinking: cannot conclude idle vs hung",
			suspicious_pane_tail: quotePaneTail("✢ Pondering… (11m 3s)\n❯"),
			episode_fingerprint: "abc123",
		};
		return {
			seq: 9,
			event: payload,
			sessionKey: payload.execution_id,
			leadId: "cos-lead",
			timestamp: "2026-07-09T07:00:00.000Z",
		};
	}

	it("shared renderer surfaces reason + quoted tail + quiet framing", () => {
		const text = formatDetectionSuspicious(suspiciousEnvelope());
		expect(text).toContain("detection_suspicious");
		expect(text).toContain("frozen_extended_thinking");
		expect(text).toContain("▏ ✢ Pondering… (11m 3s)");
		expect(text.toLowerCase()).toContain("quiet");
		expect(text).toContain("never share the quoted pane lines");
	});

	it("MailboxLeadRuntime.deliver renders via the shared formatter", async () => {
		const writes: Array<{ payload: { content: string } }> = [];
		const transport = {
			vendorId: () => "claude-code",
			capabilities: () => ({
				wakeMode: "builtin-receiver",
				preflightIsHardGate: true,
				preservesMetadata: true,
				maxPayloadBytes: 1_000_000,
				requiresStableAgentIdentity: true,
			}),
			getInboxPath: () => "/dummy/inbox.json",
			getStateDir: () => "/dummy/state",
			write: vi.fn(async (w: { payload: { content: string } }) => {
				writes.push(w);
				return {
					flywheelId: "test-id",
					idempotent: false,
					wroteAt: 1_700_000_000_000,
					finalized: true,
				};
			}),
			verifyLastWrite: vi.fn(async () => {}),
			readUnread: vi.fn(async () => []),
			ack: vi.fn(async () => {}),
			dedupeKey: (m: { id: string }) => m.id,
			createReceiver: () => null,
			buildRunnerSpawnConfig: () => ({ args: [], env: {} }),
			buildLeadSpawnConfig: () => ({ args: [], env: {} }),
			preflight: vi.fn(async () => ({ ok: true, availabilitySignals: [] })),
		} as never;
		const runtime = new MailboxLeadRuntime({ leadId: "cos-lead", transport });
		const env = suspiciousEnvelope();
		const result = await runtime.deliver(env);
		expect(result.delivered).toBe(true);
		expect(writes[0]?.payload.content).toBe(formatDetectionSuspicious(env));
	});

	it("CommDBLeadRuntime formats identically (shared renderer parity)", () => {
		const env = suspiciousEnvelope();
		const rendered = (
			CommDBLeadRuntime.prototype as unknown as {
				formatEnvelope: (e: LeadEventEnvelope) => string;
			}
		).formatEnvelope.call({}, env);
		expect(rendered).toBe(formatDetectionSuspicious(env));
	});
});

describe("guardrail wiring", () => {
	it("detection_suspicious is a guardrail event type (failed delivery retried)", () => {
		expect(GUARDRAIL_EVENT_TYPES.has("detection_suspicious")).toBe(true);
	});
});
