/**
 * FLY-799 — founder ship-approval factory (RED first).
 *
 * Produces the `tryFounderShipApproval` callback the deliverer calls, gating it
 * on the default-ON flag (FLYWHEEL_FOUNDER_AUTO_APPROVE !== "0") + per-project
 * denylist + a resolvable canonical founder id. Any gate failing → the callback
 * returns null (deliverer falls back to WAKE-only). Env is read per-call so ops
 * can flip the kill-switch without a restart.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeFounderShipApprovalCallback } from "../approval-signal/founder-ship-approval-factory.js";

const ctx = { issueId: "I", threadId: "T", projectName: "proj" } as never;
const shipGates = [
	{
		questionId: "Q-1",
		checkpoint: "approve_to_ship",
		executionId: "E-1",
		createdAtMs: 1,
	},
];
const callArgs = {
	msg: { id: "MSG-1", content: "ship it", authorId: "FOUNDER-1" },
	shipGates,
	ctx,
	db: {} as never,
};

afterEach(() => {
	delete process.env.FLYWHEEL_FOUNDER_AUTO_APPROVE;
});

function make(over = {}) {
	const handlerImpl = vi
		.fn()
		.mockResolvedValue({ handled: ["Q-1"], retrySafe: true });
	const cb = makeFounderShipApprovalCallback({
		discordOwnerUserId: "FOUNDER-1",
		store: { getSession: vi.fn() },
		handlerImpl,
		...over,
	});
	return { cb, handlerImpl };
}

describe("makeFounderShipApprovalCallback — gating", () => {
	it("default-ON: delegates to the handler when nothing disables it", async () => {
		const { cb, handlerImpl } = make();
		const r = await cb(callArgs);
		expect(r).toEqual({ handled: ["Q-1"], retrySafe: true });
		expect(handlerImpl).toHaveBeenCalledOnce();
	});

	it("kill-switch FLYWHEEL_FOUNDER_AUTO_APPROVE=0 → null, never delegates", async () => {
		process.env.FLYWHEEL_FOUNDER_AUTO_APPROVE = "0";
		const { cb, handlerImpl } = make();
		const r = await cb(callArgs);
		expect(r).toBeNull();
		expect(handlerImpl).not.toHaveBeenCalled();
	});

	it("per-project denylist → null, never delegates", async () => {
		const { cb, handlerImpl } = make({ denylistProjects: new Set(["proj"]) });
		const r = await cb(callArgs);
		expect(r).toBeNull();
		expect(handlerImpl).not.toHaveBeenCalled();
	});

	it("no resolvable canonical founder id → null (fail-closed)", async () => {
		const { cb, handlerImpl } = make({
			discordOwnerUserId: undefined,
			founderConsentUserId: undefined,
		});
		const r = await cb(callArgs);
		expect(r).toBeNull();
		expect(handlerImpl).not.toHaveBeenCalled();
	});

	it("mismatched founder ids across sources → null (fail-closed)", async () => {
		const { cb, handlerImpl } = make({
			discordOwnerUserId: "A",
			founderConsentUserId: "B",
		});
		const r = await cb(callArgs);
		expect(r).toBeNull();
		expect(handlerImpl).not.toHaveBeenCalled();
	});

	it("passes the canonical founder id + ctx/db through to the handler", async () => {
		const { cb, handlerImpl } = make();
		await cb(callArgs);
		const [hArgs, hDeps] = handlerImpl.mock.calls[0];
		expect(hDeps.canonicalFounderId).toBe("FOUNDER-1");
		expect(hArgs.ctx).toMatchObject({ issueId: "I", threadId: "T" });
		expect(hDeps.db).toBe(callArgs.db);
	});
});
