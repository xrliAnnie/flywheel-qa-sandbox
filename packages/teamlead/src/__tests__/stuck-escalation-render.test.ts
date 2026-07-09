/**
 * FLY-195 hotfix: runner_stuck_escalation rendering + ROUND-TRIP.
 *
 * Production incident (2026-06-03, GEO-397 double-page): the escalation event
 * carried `episode_fingerprint`, but neither Lead runtime rendered it. The
 * Lead's disposition POST then failed fingerprint validation, the grace
 * window expired, and every escalation false-paged Annie.
 *
 * The round-trip test here is the gap closure: REAL emitter → persisted
 * payload → REAL runtime renderer → extract the fingerprint the way a Lead
 * reads the text → POST to the REAL disposition/nudge routes → accepted.
 * No stage is mocked-out of the text path again.
 */

import type http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommDBLeadRuntime } from "../bridge/commdb-lead-runtime.js";
import {
	formatStuckEscalation,
	type HookPayload,
} from "../bridge/hook-payload.js";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { MailboxLeadRuntime } from "../bridge/mailbox-lead-runtime.js";
import { fingerprintOutput } from "../bridge/stuck-candidate.js";
import { createStuckEscalationEmitter } from "../bridge/stuck-escalation.js";
import { createStuckRemanageRouter } from "../bridge/stuck-remanage-routes.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const projects: ProjectEntry[] = [
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

/** Realistic frozen frame (current TUI shape, idle input box at bottom). */
const STUCK_FRAME = [
	"⎿ API Error: Stream idle timeout - partial response received",
	"────────────────────────────────────── @runner ──",
	"❯ ",
	"──────────────────────────────────────────────────",
	"  Opus 4.8 | runner | ctx 40%",
	"  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");
const STUCK_FP = fingerprintOutput(STUCK_FRAME);

/**
 * Extract the fingerprint the way the Lead rules tell the Lead to: from the
 * labeled `Episode-Fingerprint:` line of the rendered event text.
 */
function extractFingerprintAsLeadWould(rendered: string): string | undefined {
	return rendered.match(/Episode-Fingerprint:\s*([0-9a-f]{16})\b/)?.[1];
}

function envelope(event: HookPayload, seq = 7): LeadEventEnvelope {
	return {
		seq,
		event,
		sessionKey: event.execution_id,
		leadId: "product-lead",
		timestamp: "2026-06-04T05:00:00.000Z",
	};
}

function stuckEvent(over: Partial<HookPayload> = {}): HookPayload {
	return {
		event_type: "runner_stuck_escalation",
		execution_id: "exec-1",
		issue_id: "GEO-397",
		issue_identifier: "GEO-397",
		project_name: "geo",
		status: "running",
		session_role: "main",
		stuck_minutes: 32,
		episode_fingerprint: STUCK_FP,
		terminal_tail: STUCK_FRAME,
		stream_error_signature: true,
		input_box_present: true,
		stage_context: "FLY-195 stuck-runner escalation: …",
		...over,
	};
}

describe("formatStuckEscalation (shared renderer)", () => {
	it("renders the fingerprint on the machine-extractable labeled line", () => {
		const text = formatStuckEscalation(envelope(stuckEvent()));
		expect(text).toContain(`Episode-Fingerprint: ${STUCK_FP}`);
		expect(extractFingerprintAsLeadWould(text)).toBe(STUCK_FP);
	});

	it("renders stuck_minutes, evidence flags, tail, and guidance note", () => {
		const text = formatStuckEscalation(envelope(stuckEvent()));
		expect(text).toContain("output unchanged for 32 min");
		expect(text).toContain(
			"Evidence: input_box_present=true | stream_error_signature=true",
		);
		expect(text).toContain("terminal tail");
		expect(text).toContain("❯");
		expect(text).toContain("Note: FLY-195 stuck-runner escalation");
		expect(text).toContain("NOT a verdict");
	});

	it("FLY-1048 (A3): renders the error-signature KIND when present, never the raw line", () => {
		const text = formatStuckEscalation(
			envelope(stuckEvent({ error_signature: "enoent_loop" })),
		);
		expect(text).toContain("Error-Signature: enoent_loop");
		// Absent → no signature line at all.
		const plain = formatStuckEscalation(envelope(stuckEvent()));
		expect(plain).not.toContain("Error-Signature:");
	});

	it("truncates a long tail (lines + chars bounded)", () => {
		const longTail = Array.from(
			{ length: 50 },
			(_, i) => `line-${i} ${"x".repeat(80)}`,
		).join("\n");
		const text = formatStuckEscalation(
			envelope(stuckEvent({ terminal_tail: longTail })),
		);
		expect(text).not.toContain("line-0 ");
		expect(text).toContain("line-49");
		const tailSection = text.split("--- terminal tail")[1] ?? "";
		expect(tailSection.length).toBeLessThan(800);
	});

	it("missing fingerprint renders an explicit (missing) marker, never silence", () => {
		const text = formatStuckEscalation(
			envelope(stuckEvent({ episode_fingerprint: undefined })),
		);
		expect(text).toContain("Episode-Fingerprint: (missing)");
		expect(extractFingerprintAsLeadWould(text)).toBeUndefined();
	});

	it("omitted tail keeps the rest of the message intact", () => {
		const text = formatStuckEscalation(
			envelope(stuckEvent({ terminal_tail: undefined })),
		);
		expect(text).not.toContain("terminal tail");
		expect(text).toContain(`Episode-Fingerprint: ${STUCK_FP}`);
	});
});

describe("runtime renderers carry the fingerprint (mailbox/commdb parity)", () => {
	function mockTransport() {
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
		return { writes, transport };
	}

	it("MailboxLeadRuntime.deliver renders the labeled fingerprint line", async () => {
		const { transport, writes } = mockTransport();
		const runtime = new MailboxLeadRuntime({
			leadId: "product-lead",
			transport,
		});
		const result = await runtime.deliver(envelope(stuckEvent()));
		expect(result.delivered).toBe(true);
		const content = writes[0]?.payload.content ?? "";
		expect(extractFingerprintAsLeadWould(content)).toBe(STUCK_FP);
	});

	it("CommDBLeadRuntime formats identically (shared renderer parity)", () => {
		const env = envelope(stuckEvent());
		// Render via the prototype: the runner_stuck_escalation branch returns
		// before touching `this`, so no real CommDB needs to be opened.
		const rendered = (
			CommDBLeadRuntime.prototype as unknown as {
				formatEnvelope: (e: LeadEventEnvelope) => string;
			}
		).formatEnvelope.call({}, env);
		expect(extractFingerprintAsLeadWould(rendered)).toBe(STUCK_FP);
		expect(rendered).toBe(formatStuckEscalation(env));
	});
});

// ── ROUND-TRIP: emitter → render → Lead-style extraction → real endpoints ──

describe("round-trip: escalation text → disposition/nudge accepted", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let sendKeys: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "GEO-397",
			project_name: "geo",
			status: "running",
			issue_labels: JSON.stringify(["Product"]),
		});
		sendKeys = vi.fn(async () => ({ sent: true }));
		const app = express();
		app.use(express.json());
		app.use(
			"/api/sessions",
			createStuckRemanageRouter({
				store,
				projects,
				captureSessionFn: async () => ({
					output: STUCK_FRAME,
					tmux_target: "geo:@1",
					lines: 100,
					captured_at: "now",
				}),
				hasPendingGate: () => false,
				sendKeys,
				getTmuxTarget: () => ({ tmuxWindow: "geo:@1", sessionName: "geo" }),
			}),
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((r) => server.once("listening", r));
		const addr = server.address();
		baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) =>
			server.close((err) => (err ? reject(err) : resolve())),
		);
		store.close();
		vi.restoreAllMocks();
	});

	/** Run the REAL emitter and return the REAL rendered Lead message. */
	async function renderedEscalationText(): Promise<string> {
		const appended: string[] = [];
		const emitterStore = {
			appendLeadEvent: vi.fn(
				(_l: string, _id: string, _t: string, payload: string) => {
					appended.push(payload);
					return 1;
				},
			),
			isLeadEventDelivered: vi.fn(() => false),
			markLeadEventDelivered: vi.fn(),
			recordDeliveryFailure: vi.fn(),
		};
		const delivered: string[] = [];
		const runtime = new MailboxLeadRuntime({
			leadId: "product-lead",
			transport: {
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
					delivered.push(w.payload.content);
					return {
						flywheelId: "rt-id",
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
			} as never,
		});
		const emit = createStuckEscalationEmitter({
			store: emitterStore as never,
			projects,
			runtimeRegistry: { getForLead: () => runtime } as never,
			log: () => {},
		});
		const ok = await emit({
			session: {
				execution_id: "exec-1",
				issue_id: "GEO-397",
				issue_identifier: "GEO-397",
				project_name: "geo",
				status: "running",
				issue_labels: "Product",
			} as never,
			evidence: {
				stuck_minutes: 32,
				tail: STUCK_FRAME,
				stream_error_signature: true,
				input_box_present: true,
			},
			episodeFingerprint: STUCK_FP,
			episodeStartedAt: 1_000,
		});
		expect(ok).toBe(true);
		// The persisted payload and the delivered text must agree (the payload
		// is what guardrail retry redelivers — same renderer applies).
		expect(JSON.parse(appended[0]!).episode_fingerprint).toBe(STUCK_FP);
		return delivered[0]!;
	}

	it("Lead can extract the fingerprint from the REAL rendered text and write a disposition (the exact production failure)", async () => {
		const text = await renderedEscalationText();
		const fp = extractFingerprintAsLeadWould(text);
		expect(fp).toBe(STUCK_FP);

		const res = await fetch(
			`${baseUrl}/api/sessions/exec-1/stuck-disposition`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					leadId: "product-lead",
					episode_fingerprint: fp,
					disposition: "legitimate_wait",
					note: "background poll loop — quiet by design",
				}),
			},
		);
		expect(res.status).toBe(200);
		// FLY-253: legitimate_wait latches the EXECUTION — the receipt lands on
		// the '*' sentinel (read via the rows API the detector uses).
		expect(
			store.getStuckDispositionRows("exec-1", fp!).sentinel?.disposition,
		).toBe("legitimate_wait");
	});

	it("the same extracted fingerprint passes the recovery-nudge gates end-to-end", async () => {
		const text = await renderedEscalationText();
		const fp = extractFingerprintAsLeadWould(text);
		const res = await fetch(`${baseUrl}/api/sessions/exec-1/recovery-nudge`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ leadId: "product-lead", episode_fingerprint: fp }),
		});
		expect(res.status).toBe(200);
		expect(sendKeys).toHaveBeenCalledWith("geo:@1", "continue");
		expect(store.getStuckDisposition("exec-1", fp!)?.disposition).toBe(
			"handled_remanaged",
		);
	});
});
