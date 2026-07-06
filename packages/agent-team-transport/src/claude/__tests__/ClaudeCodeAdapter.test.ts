/**
 * ClaudeCodeAdapter unit tests.
 *
 * Per plan v1.27.1 §A acceptance:
 * - vendorId() / capabilities() return expected shape
 * - buildRunnerSpawnConfig + buildLeadSpawnConfig produce expected CLI/env
 *   (snapshot-style — Codex r1 §2.2 spec)
 * - write/verifyLastWrite/readUnread/ack roundtrip works
 * - createReceiver returns null for claude-code (builtin poller)
 * - preflight passes when claude CLI present + codec works
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailabilitySignal, ILogger } from "../../types.js";
import { ClaudeCodeAdapter } from "../ClaudeCodeAdapter.js";

let tempDir: string;
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalStateDir = process.env.FLYWHEEL_STATE_DIR;

const noopLogger: ILogger = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "claude-adapter-"));
	process.env.CLAUDE_CONFIG_DIR = tempDir;
	process.env.FLYWHEEL_STATE_DIR = join(tempDir, "state");
});

afterEach(async () => {
	if (originalConfigDir === undefined) {
		delete process.env.CLAUDE_CONFIG_DIR;
	} else {
		process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
	}
	if (originalStateDir === undefined) {
		delete process.env.FLYWHEEL_STATE_DIR;
	} else {
		process.env.FLYWHEEL_STATE_DIR = originalStateDir;
	}
	await rm(tempDir, { recursive: true, force: true });
});

// ============================================================================
// Identity + capabilities
// ============================================================================

describe("ClaudeCodeAdapter — identity + capabilities", () => {
	it("vendorId returns 'claude-code'", () => {
		const a = new ClaudeCodeAdapter();
		expect(a.vendorId()).toBe("claude-code");
	});

	it("capabilities returns expected shape (Codex r5 contract)", () => {
		const a = new ClaudeCodeAdapter();
		expect(a.capabilities()).toEqual({
			wakeMode: "builtin-receiver",
			preflightIsHardGate: true,
			preservesMetadata: true,
			maxPayloadBytes: 1_000_000,
			requiresStableAgentIdentity: true,
		});
	});

	it("getInboxPath uses CLAUDE_CONFIG_DIR + /teams (Codex r1 high #5)", () => {
		const a = new ClaudeCodeAdapter();
		expect(a.getInboxPath("cos-lead", "runner-FLY-142")).toBe(
			join(tempDir, "teams", "cos-lead", "inboxes", "runner-FLY-142.json"),
		);
	});

	it("getStateDir uses FLYWHEEL_STATE_DIR", () => {
		const a = new ClaudeCodeAdapter();
		expect(a.getStateDir()).toBe(join(tempDir, "state"));
	});
});

// ============================================================================
// Spawn config (snapshot — §2.2 spec)
// ============================================================================

describe("ClaudeCodeAdapter — buildRunnerSpawnConfig", () => {
	it("emits identity flags + agent-teams env (per §2.2 spike α revision)", () => {
		const a = new ClaudeCodeAdapter();
		const cfg = a.buildRunnerSpawnConfig({
			leadName: "cos-lead",
			runnerName: "runner-FLY-142-abc1",
			teamName: "cos-lead",
			parentSessionId: "lead-session-uuid",
			color: "cyan",
			sessionId: "runner-session-uuid",
			permissionMode: "bypassPermissions",
		});

		// args: NO --agent-teams flag (stripped from external claude builds —
		// Spike α). Identity flags + parent + color + session + permission.
		expect(cfg.args).toEqual([
			"--agent-id",
			"runner-FLY-142-abc1@cos-lead",
			"--agent-name",
			"runner-FLY-142-abc1",
			"--team-name",
			"cos-lead",
			"--parent-session-id",
			"lead-session-uuid",
			"--agent-color",
			"cyan",
			"--session-id",
			"runner-session-uuid",
			"--permission-mode",
			"bypassPermissions",
		]);

		// env: agent-teams enabled + claude config dir passed through.
		expect(cfg.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
		expect(cfg.env.FLYWHEEL_AGENT_BACKEND).toBe("claude-code");
		expect(cfg.env.CLAUDE_CONFIG_DIR).toBe(tempDir);
		expect(cfg.env.FLYWHEEL_STATE_DIR).toBe(join(tempDir, "state"));
	});

	it("omits optional flags when ctx fields not set", () => {
		const a = new ClaudeCodeAdapter();
		const cfg = a.buildRunnerSpawnConfig({
			leadName: "cos-lead",
			runnerName: "minimal-runner",
			teamName: "cos-lead",
		});
		expect(cfg.args).toEqual([
			"--agent-id",
			"minimal-runner@cos-lead",
			"--agent-name",
			"minimal-runner",
			"--team-name",
			"cos-lead",
		]);
	});
});

describe("ClaudeCodeAdapter — buildLeadSpawnConfig", () => {
	it("emits Lead identity flags + same env as Runner spawn (§2.2)", () => {
		const a = new ClaudeCodeAdapter();
		const cfg = a.buildLeadSpawnConfig({
			leadName: "cos-lead",
			teamName: "cos-lead",
			parentSessionId: "outer-session",
		});
		expect(cfg.args).toEqual([
			"--agent-id",
			"cos-lead@cos-lead",
			"--agent-name",
			"cos-lead",
			"--team-name",
			"cos-lead",
			"--parent-session-id",
			"outer-session",
		]);
		expect(cfg.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
	});
});

// ============================================================================
// IMailboxWriter / IMailboxReader roundtrip
// ============================================================================

describe("ClaudeCodeAdapter — write/read/ack roundtrip", () => {
	it("write → readUnread sees the message; ack flips read=true", async () => {
		const a = new ClaudeCodeAdapter();

		const result = await a.write({
			leadName: "cos-lead",
			recipient: "runner-x",
			payload: {
				from: "cos-lead",
				to: "runner-x",
				content: "hello runner",
				metadata: { flywheelId: "test-1" },
			},
		});
		expect(result.idempotent).toBe(false);
		expect(result.flywheelId).toBe("test-1");

		const unread = await a.readUnread({
			leadName: "cos-lead",
			agentName: "runner-x",
		});
		expect(unread).toHaveLength(1);
		expect(unread[0]?.from).toBe("cos-lead");
		expect(unread[0]?.content).toBe("hello runner");
		expect(unread[0]?.read).toBe(false);

		// dedupeKey is vendor-stable
		const id = unread[0]!.id;
		expect(a.dedupeKey(unread[0]!)).toBe(id);

		// ack flips read=true
		await a.ack({
			leadName: "cos-lead",
			agentName: "runner-x",
			messageIds: [id],
		});
		const afterAck = await a.readUnread({
			leadName: "cos-lead",
			agentName: "runner-x",
		});
		expect(afterAck).toHaveLength(0);
	});

	it("idempotent write returns idempotent: true on retry with same flywheelId", async () => {
		const a = new ClaudeCodeAdapter();
		const payload = {
			from: "cos-lead",
			to: "runner-x",
			content: "duplicate-safe",
			metadata: { flywheelId: "dedupe-key" },
		};
		const r1 = await a.write({
			leadName: "cos-lead",
			recipient: "runner-x",
			payload,
		});
		const r2 = await a.write({
			leadName: "cos-lead",
			recipient: "runner-x",
			payload,
		});
		expect(r1.idempotent).toBe(false);
		expect(r2.idempotent).toBe(true);

		const unread = await a.readUnread({
			leadName: "cos-lead",
			agentName: "runner-x",
		});
		expect(unread).toHaveLength(1);
	});

	it("verifyLastWrite passes on match, throws on mismatch", async () => {
		const a = new ClaudeCodeAdapter();
		await a.write({
			leadName: "cos-lead",
			recipient: "runner-x",
			payload: {
				from: "cos-lead",
				to: "runner-x",
				content: "expected content",
				metadata: { flywheelId: "verify-1" },
			},
		});

		await expect(
			a.verifyLastWrite({
				leadName: "cos-lead",
				recipient: "runner-x",
				expected: {
					from: "cos-lead",
					to: "runner-x",
					content: "expected content",
				},
			}),
		).resolves.toBeUndefined();

		await expect(
			a.verifyLastWrite({
				leadName: "cos-lead",
				recipient: "runner-x",
				expected: {
					from: "cos-lead",
					to: "runner-x",
					content: "wrong content",
				},
			}),
		).rejects.toThrow(/verifyLastWrite mismatch/);
	});

	it("FLY-142 PR #186 Codex Round 1 HIGH: verifyLastWrite tolerates concurrent writes (no false `verify_mismatch` when our entry isn't last)", async () => {
		// Reproduces Codex's race finding:
		// 1. Writer A finalizes msg-A with flywheelId "verify-race-A"
		// 2. Writer B appends msg-B with different flywheelId "verify-race-B"
		//    (now main.last === msg-B)
		// 3. Writer A calls verifyLastWrite expecting msg-A — old impl
		//    falsely threw because messages[last] was msg-B.
		const a = new ClaudeCodeAdapter();
		await a.write({
			leadName: "cos-lead",
			recipient: "runner-race",
			payload: {
				from: "cos-lead",
				to: "runner-race",
				content: "msg-A from A",
				metadata: { flywheelId: "verify-race-A" },
			},
		});
		await a.write({
			leadName: "cos-lead",
			recipient: "runner-race",
			payload: {
				from: "cos-lead",
				to: "runner-race",
				content: "msg-B from B (queued after A)",
				metadata: { flywheelId: "verify-race-B" },
			},
		});

		// Writer A's verify must still pass — its message is in the inbox,
		// just no longer at the tail.
		await expect(
			a.verifyLastWrite({
				leadName: "cos-lead",
				recipient: "runner-race",
				expected: {
					from: "cos-lead",
					to: "runner-race",
					content: "msg-A from A",
					metadata: { flywheelId: "verify-race-A" },
				},
			}),
		).resolves.toBeUndefined();

		// Writer B's verify obviously passes (last entry path).
		await expect(
			a.verifyLastWrite({
				leadName: "cos-lead",
				recipient: "runner-race",
				expected: {
					from: "cos-lead",
					to: "runner-race",
					content: "msg-B from B (queued after A)",
					metadata: { flywheelId: "verify-race-B" },
				},
			}),
		).resolves.toBeUndefined();

		// Sanity: a payload that was never written still throws.
		await expect(
			a.verifyLastWrite({
				leadName: "cos-lead",
				recipient: "runner-race",
				expected: {
					from: "cos-lead",
					to: "runner-race",
					content: "msg-C never written",
				},
			}),
		).rejects.toThrow(/verifyLastWrite mismatch/);
	});

	it("rejects payloads exceeding maxPayloadBytes", async () => {
		const a = new ClaudeCodeAdapter({ maxPayloadBytes: 100 });
		await expect(
			a.write({
				leadName: "cos-lead",
				recipient: "runner-x",
				payload: {
					from: "cos-lead",
					to: "runner-x",
					content: "x".repeat(200),
				},
			}),
		).rejects.toThrow(/exceeds adapter cap/);
	});
});

// ============================================================================
// Receiver wake (claude-code uses builtin)
// ============================================================================

describe("ClaudeCodeAdapter — createReceiver", () => {
	it("returns null (claude-code uses builtin useInboxPoller)", () => {
		const a = new ClaudeCodeAdapter();
		expect(
			a.createReceiver({
				leadName: "cos-lead",
				runnerName: "runner-x",
				teamName: "cos-lead",
			}),
		).toBeNull();
	});
});

// ============================================================================
// Preflight
// ============================================================================

describe("ClaudeCodeAdapter — preflight", () => {
	it("passes when claude CLI is on PATH (uses real claude binary)", async () => {
		const a = new ClaudeCodeAdapter();
		const result = await a.preflight({ logger: noopLogger });
		expect(result.ok).toBe(true);
		const cliSig = result.availabilitySignals.find(
			(s) => s.name === "claude-code:cli-version",
		);
		expect(cliSig?.kind).toBe("ok");
		expect(cliSig?.detail).toMatch(/Claude Code/);
		const codecSig = result.availabilitySignals.find(
			(s) => s.name === "claude-code:codec-roundtrip-pass",
		);
		expect(codecSig?.kind).toBe("ok");
	});

	it("fails with availabilitySignal when claude CLI missing", async () => {
		const a = new ClaudeCodeAdapter({
			claudeCommand: "/nonexistent/claude-binary-xyz",
		});
		const result = await a.preflight({ logger: noopLogger });
		expect(result.ok).toBe(false);
		const sig = result.availabilitySignals.find(
			(s) => s.name === "claude-code:cli-not-found",
		);
		expect(sig?.kind).toBe("error");
	});

	// FLY-142 verify (2026-05-12): QA found Bridge `plugin.ts` was calling
	// `transport.preflight({})` — no logger. ClaudeCodeAdapter dereferenced
	// `opts.logger.info(...)` and threw; the throw was caught and
	// misclassified as a "claude-code:cli-not-found" signal, even though
	// the CLI was actually fine. Result: Bridge never instantiated a
	// MailboxLeadRuntime in prod and the wake bug fix silently no-op'd.
	//
	// These regression tests pin the contract: `preflight()` MUST be
	// callable without a logger, with `{}`, and with `{ logger: undefined }`,
	// and must NOT throw or produce false-positive error signals when the
	// CLI is actually healthy.
	it("preflight() with no arg does not throw + CLI signal stays 'ok'", async () => {
		const a = new ClaudeCodeAdapter();
		// Optional-opts signature lets callers drop the arg entirely —
		// this is the Bridge `createLeadRuntime` call site before
		// QA-found Bug #2 was fixed.
		const result = await a.preflight();
		const cliSig = result.availabilitySignals.find(
			(s: AvailabilitySignal) => s.name === "claude-code:cli-version",
		);
		expect(cliSig?.kind).toBe("ok");
	});

	it("preflight({}) does not throw + CLI signal stays 'ok'", async () => {
		const a = new ClaudeCodeAdapter();
		const result = await a.preflight({});
		const cliSig = result.availabilitySignals.find(
			(s) => s.name === "claude-code:cli-version",
		);
		expect(cliSig?.kind).toBe("ok");
	});

	it("preflight({ logger: undefined }) does not throw + CLI signal stays 'ok'", async () => {
		const a = new ClaudeCodeAdapter();
		const result = await a.preflight({ logger: undefined });
		const cliSig = result.availabilitySignals.find(
			(s) => s.name === "claude-code:cli-version",
		);
		expect(cliSig?.kind).toBe("ok");
	});
});
