/**
 * MailboxTransport unit tests (FLY-142 Phase 0 PR 1.3, no-behavior-flip).
 *
 * Validates:
 * - writeVerified: happy path → write + verify both called, returns wroteAt
 * - writeVerified: idempotent skip → verify NOT called (nothing to verify)
 * - writeVerified: verify mismatch → MailboxWriteError propagated
 * - writeVerified: write throw → propagated as-is
 * - readUnreadFromInbox: thin wrapper passes args through
 * - ackMessages: thin wrapper passes args through
 */

import {
	type IAgentTeamTransport,
	type MailboxMessage,
	type MailboxPayload,
	MailboxWriteError,
	type MailboxWriteResult,
} from "flywheel-agent-team-transport";
import { describe, expect, it, vi } from "vitest";
import { MailboxTransport } from "../MailboxTransport.js";

function makeMockTransport(
	overrides: Partial<IAgentTeamTransport> = {},
): IAgentTeamTransport {
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
		preflight: vi.fn(async () => ({ ok: true, availabilitySignals: [] })),
		...overrides,
	};
}

const basePayload: MailboxPayload = {
	from: "cos-lead",
	to: "runner-x",
	content: "hello",
	metadata: { flywheelId: "stable-1" },
};

describe("MailboxTransport", () => {
	describe("writeVerified", () => {
		it("happy path: calls write + verify, returns wroteAt + flywheelId", async () => {
			const t = makeMockTransport();
			const mt = new MailboxTransport(t);

			const result = await mt.writeVerified({
				leadName: "cos-lead",
				recipient: "runner-x",
				payload: basePayload,
			});

			expect(t.write).toHaveBeenCalledWith({
				leadName: "cos-lead",
				recipient: "runner-x",
				payload: basePayload,
			});
			expect(t.verifyLastWrite).toHaveBeenCalledWith({
				leadName: "cos-lead",
				recipient: "runner-x",
				expected: basePayload,
			});
			expect(result.idempotent).toBe(false);
			expect(result.flywheelId).toBe("test-id");
			expect(result.wroteAt).toBe(1_700_000_000_000);
		});

		it("idempotent hit: STILL calls verify (Codex r1 PR 1.3 HIGH #1)", async () => {
			// Adapter's idempotent=true does NOT guarantee a finalized main
			// entry exists — could be a recent <60s pending sidecar. ALWAYS
			// verify to catch the gap where main is still empty.
			const t = makeMockTransport({
				write: vi.fn(async () => ({
					flywheelId: "stable-1",
					idempotent: true,
					wroteAt: 1_700_000_000_000,
				})),
			});
			const mt = new MailboxTransport(t);

			const result = await mt.writeVerified({
				leadName: "cos-lead",
				recipient: "runner-x",
				payload: basePayload,
			});

			expect(t.write).toHaveBeenCalled();
			// MUST be called even on idempotent — see HIGH #1.
			expect(t.verifyLastWrite).toHaveBeenCalledWith({
				leadName: "cos-lead",
				recipient: "runner-x",
				expected: basePayload,
			});
			expect(result.idempotent).toBe(true);
		});

		it("idempotent + finalized: skips verify (Codex r2 PR 1.3 HIGH #1)", async () => {
			// Legitimate case: prior write durably committed. verifyLastWrite
			// would falsely fail if a NEWER message has been appended after.
			// finalized: true tells us we can trust the prior write — skip verify.
			const t = makeMockTransport({
				write: vi.fn(async () => ({
					flywheelId: "stable-1",
					idempotent: true,
					wroteAt: 1_700_000_000_000,
					finalized: true,
				})),
			});
			const mt = new MailboxTransport(t);

			const result = await mt.writeVerified({
				leadName: "cos-lead",
				recipient: "runner-x",
				payload: basePayload,
			});

			expect(t.verifyLastWrite).not.toHaveBeenCalled();
			expect(result.idempotent).toBe(true);
		});

		it("idempotent + NOT finalized: STILL calls verify (catches pending writer race)", async () => {
			// Recent <60s pending sidecar — main may still be empty.
			// Verify should run; if main is empty it throws verify_mismatch.
			const t = makeMockTransport({
				write: vi.fn(async () => ({
					flywheelId: "stable-1",
					idempotent: true,
					wroteAt: 1_700_000_000_000,
					finalized: false,
				})),
				verifyLastWrite: vi.fn(async () => {
					throw new MailboxWriteError(
						"verifyLastWrite mismatch — main empty",
						"verify_mismatch",
						"runner-x",
						false,
					);
				}),
			});
			const mt = new MailboxTransport(t);

			await expect(
				mt.writeVerified({
					leadName: "cos-lead",
					recipient: "runner-x",
					payload: basePayload,
				}),
			).rejects.toMatchObject({ code: "verify_mismatch" });
		});

		it("idempotent + finalized undefined: defensively verifies", async () => {
			// Adapter doesn't track finalization (legacy / non-claude). Treat
			// as defensive default — always verify.
			const t = makeMockTransport({
				write: vi.fn(async () => ({
					flywheelId: "stable-1",
					idempotent: true,
					wroteAt: 1_700_000_000_000,
					// finalized intentionally omitted
				})),
			});
			const mt = new MailboxTransport(t);

			await mt.writeVerified({
				leadName: "cos-lead",
				recipient: "runner-x",
				payload: basePayload,
			});

			expect(t.verifyLastWrite).toHaveBeenCalled();
		});

		it("verify mismatch: MailboxWriteError propagated", async () => {
			const t = makeMockTransport({
				verifyLastWrite: vi.fn(async () => {
					throw new MailboxWriteError(
						"verifyLastWrite mismatch for runner-x",
						"verify_mismatch",
						"runner-x",
						false,
					);
				}),
			});
			const mt = new MailboxTransport(t);

			await expect(
				mt.writeVerified({
					leadName: "cos-lead",
					recipient: "runner-x",
					payload: basePayload,
				}),
			).rejects.toThrow(MailboxWriteError);

			await expect(
				mt.writeVerified({
					leadName: "cos-lead",
					recipient: "runner-x",
					payload: basePayload,
				}),
			).rejects.toMatchObject({ code: "verify_mismatch" });
		});

		it("write throw: propagated as-is", async () => {
			const t = makeMockTransport({
				write: vi.fn(async () => {
					throw new MailboxWriteError(
						"lock timeout",
						"lock_timeout",
						"runner-x",
						true,
					);
				}),
			});
			const mt = new MailboxTransport(t);

			await expect(
				mt.writeVerified({
					leadName: "cos-lead",
					recipient: "runner-x",
					payload: basePayload,
				}),
			).rejects.toMatchObject({ code: "lock_timeout", retryable: true });
		});

		it("isWriteError typeguard correctly identifies MailboxWriteError", () => {
			const err = new MailboxWriteError("test", "verify_mismatch", "x", false);
			expect(MailboxTransport.isWriteError(err)).toBe(true);
			expect(MailboxTransport.isWriteError(new Error("plain"))).toBe(false);
			expect(MailboxTransport.isWriteError("string")).toBe(false);
			expect(MailboxTransport.isWriteError(null)).toBe(false);
		});
	});

	describe("readUnreadFromInbox", () => {
		it("passes args through to transport.readUnread", async () => {
			const messages: MailboxMessage[] = [
				{
					id: "msg-1",
					from: "cos-lead",
					to: "runner-x",
					content: "hi",
					ts: Date.now(),
					read: false,
				},
			];
			const t = makeMockTransport({
				readUnread: vi.fn(async () => messages),
			});
			const mt = new MailboxTransport(t);

			const result = await mt.readUnreadFromInbox({
				leadName: "cos-lead",
				agentName: "runner-x",
			});

			expect(t.readUnread).toHaveBeenCalledWith({
				leadName: "cos-lead",
				agentName: "runner-x",
			});
			expect(result).toEqual(messages);
		});

		it("returns empty array when no unread messages", async () => {
			const t = makeMockTransport({
				readUnread: vi.fn(async () => []),
			});
			const mt = new MailboxTransport(t);

			const result = await mt.readUnreadFromInbox({
				leadName: "cos-lead",
				agentName: "runner-x",
			});

			expect(result).toEqual([]);
		});
	});

	describe("ackMessages", () => {
		it("passes args through to transport.ack", async () => {
			const t = makeMockTransport();
			const mt = new MailboxTransport(t);

			await mt.ackMessages({
				leadName: "cos-lead",
				agentName: "runner-x",
				messageIds: ["msg-1", "msg-2"],
			});

			expect(t.ack).toHaveBeenCalledWith({
				leadName: "cos-lead",
				agentName: "runner-x",
				messageIds: ["msg-1", "msg-2"],
			});
		});

		it("empty messageIds array is a no-op", async () => {
			const ackFn = vi.fn(async () => {});
			const t = makeMockTransport({ ack: ackFn });
			const mt = new MailboxTransport(t);

			await mt.ackMessages({
				leadName: "cos-lead",
				agentName: "runner-x",
				messageIds: [],
			});

			// Adapter's own ack handles empty array no-op (per ClaudeCodeAdapter).
			// We just verify we call through.
			expect(ackFn).toHaveBeenCalledWith({
				leadName: "cos-lead",
				agentName: "runner-x",
				messageIds: [],
			});
		});
	});
});
