import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { createLeadCapabilityTargetLockRouter } from "../lead-capability-target-lock.js";

const state = vi.hoisted(() => ({ enabled: true, current: true }));
vi.mock("flywheel-comm/lead-lease", () => ({
	forwardedLeadAuthorizationEnv: () => ({}),
}));
vi.mock("../lead-capability-scope.js", () => ({
	captureLeadCapabilityScope: () => ({
		lead: { voiceBackground: { enabled: state.enabled } },
		assertSourceCurrent: () => {
			if (!state.current) throw new Error("denied");
		},
	}),
}));
let store: StateStore;
let server: Server;
let origin: string;
const SESSION = "10000000-0000-4000-8000-000000000001";
const REQUEST = "20000000-0000-4000-8000-000000000001";
const base = {
	projectName: "flywheel",
	leadId: "eng",
	identityDigest: "a".repeat(64),
	authority: { kind: "carrier", carrierClaim: "carrier" },
	activationId: "resident:1",
	operationId: "linear.issue.update",
	requestId: REQUEST,
	targetKey: "flywheel:linear:fly-2886",
};
beforeEach(async () => {
	state.enabled = true;
	state.current = true;
	store = await StateStore.create(":memory:");
	const app = express();
	app.use(express.json());
	app.use(createLeadCapabilityTargetLockRouter({ store, now: () => 1_500 }));
	server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	store.close();
});
const post = (path: string, body: unknown) =>
	fetch(origin + path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
it("serves disabled/draining policy and checks only existing targets after rollback", async () => {
	state.enabled = false;
	expect(
		await (await post("/policy", { ...base, deadline: 5_000 })).json(),
	).toMatchObject({ status: "disabled" });
	const owner = {
		targetKey: base.targetKey,
		projectName: base.projectName,
		leadId: base.leadId,
		actor: "voice" as const,
		activationId: `voice:${SESSION}`,
		requestId: REQUEST,
		now: 1_000,
		deadline: 2_000,
	};
	const lock = store.acquireCapabilityTargetLock(owner);
	if (lock.status !== "acquired") throw new Error("fixture");
	store.markCapabilityTargetLockDispatched({
		...owner,
		fence: lock.fence,
		now: 1_100,
	});
	expect(
		await (await post("/policy", { ...base, deadline: 5_000 })).json(),
	).toMatchObject({ status: "draining" });
	expect(
		await (await post("/acquire", { ...base, deadline: 5_000 })).json(),
	).toMatchObject({ status: "target_pending_reconcile" });
	expect(
		await (
			await post("/acquire", {
				...base,
				targetKey: "flywheel:linear:other",
				deadline: 5_000,
			})
		).json(),
	).toMatchObject({ status: "unguarded" });
	expect(
		store.getCapabilityTargetLock("flywheel:linear:other"),
	).toBeUndefined();
	expect(store.getCapabilityTargetLock(base.targetKey)?.holderActor).toBe(
		"voice",
	);
});
it("rejects a voice activation alias and foreign project target before creating a lock", async () => {
	expect(
		(
			await post("/acquire", {
				...base,
				targetKey: "foreign:linear:fly-2886",
				deadline: 5_000,
			})
		).status,
	).toBe(403);
	expect(
		(
			await post("/acquire", {
				...base,
				authority: {
					kind: "voice_session",
					sessionId: SESSION,
					leaseFence: "lease",
				},
				deadline: 5_000,
			})
		).status,
	).toBe(403);
	expect(store.getCapabilityTargetLock(base.targetKey)).toBeUndefined();
});

it("accepts only the original fence for terminal settlement after authority revocation", async () => {
	const owner = {
		targetKey: base.targetKey,
		projectName: base.projectName,
		leadId: base.leadId,
		actor: "voice" as const,
		activationId: `voice:${SESSION}`,
		requestId: REQUEST,
		now: 1_000,
		deadline: 2_000,
	};
	const lock = store.acquireCapabilityTargetLock(owner);
	if (lock.status !== "acquired") throw new Error("fixture");
	store.markCapabilityTargetLockDispatched({
		...owner,
		fence: lock.fence,
		now: 1_100,
	});
	state.current = false;
	state.enabled = false;
	const terminal = {
		...base,
		activationId: owner.activationId,
		authority: {
			kind: "voice_session",
			sessionId: SESSION,
			leaseFence: "lease",
		},
		fence: lock.fence,
		outcome: "succeeded",
	};
	expect(
		(
			await post("/release", {
				...terminal,
				fence: "30000000-0000-4000-8000-000000000001",
			})
		).status,
	).toBe(403);
	expect(await (await post("/release", terminal)).json()).toMatchObject({
		status: "released",
	});
	expect(store.getCapabilityTargetLock(base.targetKey)).toBeUndefined();
	expect((await post("/acquire", { ...base, deadline: 5_000 })).status).toBe(
		403,
	);
});
