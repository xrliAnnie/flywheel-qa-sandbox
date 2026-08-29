/**
 * FLY-799 Part A — ReactionSource (RED first).
 *
 * The zero-AI primary path: a founder ✅ on the ship-gate message = deterministic
 * approval. Reuses the battle-tested `checkReactionConfirmation` (pagination +
 * fail-closed on 403/404/429/malformed). MUST be bound to the durable
 * `targetMessageId` (A-0b): no binding → no approval (never inferred from the
 * thread). Only the canonical founder's ✅ counts; anything else / any REST
 * failure → null (no signal → keep waiting).
 */

import { describe, expect, it, vi } from "vitest";
import { evaluateReactionSource } from "../approval-signal/reaction-approval-source.js";
import type { GateBinding } from "../approval-signal/types.js";

const GATE: GateBinding = {
	questionId: "Q-1",
	executionId: "EXEC-1",
	issueId: "issue-uuid",
	issueIdentifier: "FLY-799",
	prHeadSha: "a".repeat(40),
	prNumber: 799,
	threadId: "T-1",
	canonicalFounderId: "FOUNDER-1",
	targetMessageId: "GATE-MSG-1",
};

const fetchReactors = (ids: string[], status = 200) =>
	vi.fn().mockResolvedValue({ status, body: ids.map((id) => ({ id })) });

describe("evaluateReactionSource — approve", () => {
	it("founder ✅ on the bound gate message → deterministic approve", async () => {
		const sig = await evaluateReactionSource(GATE, {
			fetcherImpl: fetchReactors(["someone", "FOUNDER-1"]),
		});
		expect(sig).toEqual({
			source: "reaction",
			kind: "approve",
			questionId: "Q-1",
			prHeadSha: GATE.prHeadSha,
			targetMessageId: "GATE-MSG-1",
			emoji: "✅",
			reactorUserId: "FOUNDER-1",
		});
	});

	it("polls exactly the bound targetMessageId in the thread channel", async () => {
		const fetcherImpl = fetchReactors(["FOUNDER-1"]);
		await evaluateReactionSource(GATE, { fetcherImpl });
		const [args] = fetcherImpl.mock.calls[0] as [
			{ channelId: string; messageId: string; emoji: string },
		];
		expect(args.channelId).toBe("T-1");
		expect(args.messageId).toBe("GATE-MSG-1");
		expect(args.emoji).toBe("✅");
	});
});

describe("evaluateReactionSource — no signal (null)", () => {
	it("missing durable targetMessageId → null WITHOUT polling (A-0b)", async () => {
		const fetcherImpl = fetchReactors(["FOUNDER-1"]);
		const sig = await evaluateReactionSource(
			{ ...GATE, targetMessageId: undefined },
			{ fetcherImpl },
		);
		expect(sig).toBeNull();
		expect(fetcherImpl).not.toHaveBeenCalled();
	});

	it("founder has not reacted → null", async () => {
		const sig = await evaluateReactionSource(GATE, {
			fetcherImpl: fetchReactors(["someone-else"]),
		});
		expect(sig).toBeNull();
	});

	it("REST failure (403) → null (fail-closed)", async () => {
		const sig = await evaluateReactionSource(GATE, {
			fetcherImpl: vi.fn().mockResolvedValue({ status: 403 }),
		});
		expect(sig).toBeNull();
	});

	it("rate-limited (429) → null (fail-closed)", async () => {
		const sig = await evaluateReactionSource(GATE, {
			fetcherImpl: vi.fn().mockResolvedValue({ status: 429 }),
		});
		expect(sig).toBeNull();
	});
});
