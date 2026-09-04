/**
 * createLeadRuntime preflight error surfacing (FLY-142 verify, 2026-05-12).
 *
 * QA found two related bugs in Bridge's mailbox path that combined to silently
 * disable the FLY-142 wake bug fix in prod:
 *
 * **Bug #2** (Adapter-layer, fixed in PR 1.1): plugin.ts:120 called
 * `transport.preflight({})` without a logger; `ClaudeCodeAdapter` dereferenced
 * `opts.logger.info(...)` and threw. The throw was caught in the adapter and
 * misclassified as a `claude-code:cli-not-found` error signal, even though
 * the CLI was actually fine.
 *
 * **Bug #3** (Caller-layer, this test): plugin.ts read `preflight.failures`
 * which doesn't exist on `PreflightResult` (schema is `availabilitySignals` +
 * `message`). So every preflight failure surfaced as `"unknown"` — hiding the
 * real signal detail that would have shown Bug #2 immediately.
 *
 * These tests pin: when preflight returns a structured error result,
 * createLeadRuntime's thrown error MUST include the real signal name + detail,
 * NOT "unknown".
 */

import type {
	IAgentTeamTransport,
	MailboxMessage,
	MailboxWriteResult,
	PreflightResult,
} from "flywheel-agent-team-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LeadConfig } from "../ProjectConfig.js";

// This integration imports the full Bridge plugin graph on its first assertion.
// Keep the budget above a cold transform so a timed-out import cannot leak into
// the following assertion and replace its mocked preflight result.
vi.setConfig({ testTimeout: 15_000 });

// createLeadRuntime mailbox branch only reads `lead.agentId` — keep the
// fixture minimal and cast through unknown to LeadConfig.
const baseLeadInput = {
	agentId: "cos-lead",
} as unknown;

function makeMockTransport(preflight: PreflightResult): IAgentTeamTransport {
	return {
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
		write: vi.fn(
			async (): Promise<MailboxWriteResult> => ({
				flywheelId: "test-id",
				idempotent: false,
				wroteAt: 1_700_000_000_000,
				finalized: true,
			}),
		),
		verifyLastWrite: vi.fn(async () => {}),
		readUnread: vi.fn(async (): Promise<MailboxMessage[]> => []),
		ack: vi.fn(async () => {}),
		dedupeKey: (msg: MailboxMessage) => msg.id,
		createReceiver: () => null,
		buildRunnerSpawnConfig: () => ({ args: [], env: {} }),
		buildLeadSpawnConfig: () => ({ args: [], env: {} }),
		preflight: vi.fn(async () => preflight),
	};
}

const baseLead = baseLeadInput as LeadConfig;

// Stub the dynamic `import("flywheel-agent-team-transport")` that plugin.ts
// runs inside createLeadRuntime so we control what preflight returns.
let mockTransport: IAgentTeamTransport;
vi.mock("flywheel-agent-team-transport", async () => {
	return {
		AgentTeamTransportFactory: {
			fromEnv: () => mockTransport,
		},
	};
});

describe("createLeadRuntime — preflight error surfacing", () => {
	const ORIGINAL_BACKEND = process.env.FLYWHEEL_COMM_BACKEND;
	beforeEach(() => {
		process.env.FLYWHEEL_COMM_BACKEND = "mailbox";
	});
	afterEach(() => {
		if (ORIGINAL_BACKEND === undefined)
			delete process.env.FLYWHEEL_COMM_BACKEND;
		else process.env.FLYWHEEL_COMM_BACKEND = ORIGINAL_BACKEND;
	});

	it("surfaces preflight.message in the thrown error (QA Bug #3)", async () => {
		mockTransport = makeMockTransport({
			ok: false,
			availabilitySignals: [
				{
					kind: "error",
					name: "claude-code:cli-not-found",
					detail: "spawn claude ENOENT",
				},
			],
			message: "claude CLI not found on PATH: spawn claude ENOENT",
		});

		// Late-import so vi.mock above takes effect.
		const { createLeadRuntime } = await import("../bridge/plugin.js");

		await expect(
			createLeadRuntime(baseLead, {} as never, "test-project"),
		).rejects.toThrow(/claude CLI not found on PATH: spawn claude ENOENT/);
	});

	it("falls back to error signal name + detail when message is absent (QA Bug #3)", async () => {
		mockTransport = makeMockTransport({
			ok: false,
			availabilitySignals: [
				{
					kind: "ok",
					name: "claude-code:cli-version",
					detail: "2.1.139 (Claude Code)",
				},
				{
					kind: "error",
					name: "claude-code:codec-roundtrip-failed",
					detail: "expected 1 message, got 0",
				},
			],
			// no message field
		});

		const { createLeadRuntime } = await import("../bridge/plugin.js");

		// Must surface the real failure, not "unknown".
		await expect(
			createLeadRuntime(baseLead, {} as never, "test-project"),
		).rejects.toThrow(
			/claude-code:codec-roundtrip-failed: expected 1 message, got 0/,
		);
		// Sanity: must NOT regress to the old "unknown" output.
		await expect(
			createLeadRuntime(baseLead, {} as never, "test-project"),
		).rejects.not.toThrow(/unknown/);
	});

	it("falls back to 'unknown' only when neither message nor error signals exist", async () => {
		mockTransport = makeMockTransport({
			ok: false,
			availabilitySignals: [],
		});

		const { createLeadRuntime } = await import("../bridge/plugin.js");

		await expect(
			createLeadRuntime(baseLead, {} as never, "test-project"),
		).rejects.toThrow(/preflight failed — unknown$/);
	});

	it("passes a logger to transport.preflight (QA Bug #2 defense in depth)", async () => {
		mockTransport = makeMockTransport({
			ok: true,
			availabilitySignals: [],
		});

		const { createLeadRuntime } = await import("../bridge/plugin.js");

		await createLeadRuntime(baseLead, {} as never, "test-project");

		// Verify preflight was called with a logger that has info/warn/error.
		const preflightCall = (mockTransport.preflight as ReturnType<typeof vi.fn>)
			.mock.calls[0];
		const opts = preflightCall?.[0];
		expect(opts).toBeDefined();
		expect(typeof opts.logger?.debug).toBe("function");
		expect(typeof opts.logger?.info).toBe("function");
		expect(typeof opts.logger?.warn).toBe("function");
		expect(typeof opts.logger?.error).toBe("function");
	});
});
