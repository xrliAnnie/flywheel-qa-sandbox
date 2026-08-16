/**
 * FLY-799 — founder REACTION ship-approval factory (RED first).
 *
 * Produces the per-gate reaction callback the gate-poller's reaction pass calls.
 * Same gating as the text factory (per-project denylist + resolvable canonical
 * founder id); any gate failing → null (the pass simply skips, re-checks next
 * tick).
 */

import { describe, expect, it, vi } from "vitest";
import { makeFounderReactionApprovalCallback } from "../approval-signal/founder-reaction-approval-factory.js";

const gate = {
	questionId: "Q-1",
	executionId: "E-1",
	checkpoint: "approve_to_ship",
	createdAtMs: 1,
};
const callArgs = {
	gate,
	ctx: { issueId: "I", threadId: "T", projectName: "proj" },
	db: {} as never,
	reactionFetcherImpl: vi.fn(),
};

function make(over = {}) {
	const handlerImpl = vi
		.fn()
		.mockResolvedValue({ handled: ["Q-1"], retrySafe: true });
	const cb = makeFounderReactionApprovalCallback({
		discordOwnerUserId: "FOUNDER-1",
		store: { getSession: vi.fn() },
		readBindingImpl: vi.fn(),
		handlerImpl,
		...over,
	});
	return { cb, handlerImpl };
}

describe("makeFounderReactionApprovalCallback — gating", () => {
	it("default-ON: delegates to the reaction handler", async () => {
		const { cb, handlerImpl } = make();
		const r = await cb(callArgs);
		expect(r).toEqual({ handled: ["Q-1"], retrySafe: true });
		expect(handlerImpl).toHaveBeenCalledOnce();
	});

	it("per-project denylist → null", async () => {
		const { cb, handlerImpl } = make({ denylistProjects: new Set(["proj"]) });
		expect(await cb(callArgs)).toBeNull();
		expect(handlerImpl).not.toHaveBeenCalled();
	});

	it("no resolvable canonical founder id → null (fail-closed)", async () => {
		const { cb, handlerImpl } = make({
			discordOwnerUserId: undefined,
			founderConsentUserId: undefined,
		});
		expect(await cb(callArgs)).toBeNull();
		expect(handlerImpl).not.toHaveBeenCalled();
	});

	it("mismatched founder ids across sources → null (fail-closed)", async () => {
		const { cb, handlerImpl } = make({
			discordOwnerUserId: "A",
			founderConsentUserId: "B",
		});
		expect(await cb(callArgs)).toBeNull();
		expect(handlerImpl).not.toHaveBeenCalled();
	});

	it("passes canonical id + gate/ctx/db through to the handler", async () => {
		const { cb, handlerImpl } = make();
		await cb(callArgs);
		const [hArgs, hDeps] = handlerImpl.mock.calls[0];
		expect(hDeps.canonicalFounderId).toBe("FOUNDER-1");
		expect(hArgs.gate).toMatchObject({ questionId: "Q-1", executionId: "E-1" });
		expect(hArgs.ctx).toMatchObject({ issueId: "I", threadId: "T" });
		expect(hDeps.db).toBe(callArgs.db);
		expect(hDeps.reactionFetcherImpl).toBe(callArgs.reactionFetcherImpl);
	});
});
