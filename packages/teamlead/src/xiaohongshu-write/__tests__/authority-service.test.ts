import { expect, it, vi } from "vitest";
import { startAuthorityService } from "../authority-service.js";

const state = vi.hoisted(() => ({
	events: [] as string[],
	failReady: false,
	failStop: false,
	failDrain: false,
	exit: Promise.withResolvers<unknown>(),
	drain: Promise.withResolvers<void>(),
}));
vi.mock("../provider-process.js", () => ({
	startGuardedProviderProcess: async () => {
		state.events.push("spawn");
		return {
			exited: state.exit.promise,
			stop: async () => {
				state.events.push("provider-stop");
				if (state.failStop) throw Error("stop unconfirmed");
			},
		};
	},
}));
vi.mock("../provider-client.js", () => ({ XhsProviderClient: class {} }));
vi.mock("../provider-readiness.js", () => ({
	waitForGuardedProvider: async () => {
		state.events.push("ready");
		if (state.failReady) throw Error("private failure");
	},
}));
vi.mock("../authority-handlers.js", () => ({
	createAuthorityHandlers: () => {
		state.events.push("handlers");
		return {
			ingress: () => {},
			authority: () => {},
			close: () => {
				state.events.push("guard-close");
			},
		};
	},
}));
vi.mock("../inherited-listeners.js", () => ({
	startInheritedAuthorityListeners: async () => {
		state.events.push("listen");
		return {
			close: async () => {
				state.events.push("listener-close");
				await state.drain.promise;
				state.events.push("listener-drained");
				if (state.failDrain) throw Error("drain unconfirmed");
			},
		};
	},
}));
vi.mock("../authority-workers.js", () => ({
	startAuthorityWorkers: () => {
		state.events.push("workers");
		return {
			close: async () => {
				state.events.push("workers-close");
			},
		};
	},
}));
function setup() {
	state.events = [];
	state.failReady = false;
	state.failStop = false;
	state.failDrain = false;
	state.exit = Promise.withResolvers();
	state.drain = Promise.withResolvers();
	return {
		config: {
			serviceUid: 501,
			serviceGid: 501,
			peerHelper: {},
			providerConfig: {},
			provider: { providerBinary: {}, providerSocket: "/private.sock" },
		},
		store: {
			close: () => {
				state.events.push("store-close");
			},
		},
		key: Buffer.alloc(32, 1),
		artifacts: {},
		transport: {},
		attachmentLimit: 1024,
		assertCurrent: () => {},
		observers: () => [],
		notifications: { poll: async () => {} },
	} as unknown as Parameters<typeof startAuthorityService>[0];
}
it("opens ingress only after provider readiness and drains before stopping provider and closing ledger", async () => {
	const options = setup();
	const service = await startAuthorityService(options);
	expect(state.events).toEqual([
		"spawn",
		"ready",
		"handlers",
		"listen",
		"workers",
	]);
	const closing = service.close();
	await Promise.resolve();
	expect(state.events).toContain("guard-close");
	expect(state.events).not.toContain("store-close");
	expect(state.events).not.toContain("provider-stop");
	state.drain.resolve();
	await closing;
	await service.close();
	expect(state.events.indexOf("listener-drained")).toBeLessThan(
		state.events.indexOf("provider-stop"),
	);
	expect(state.events.slice(-2)).toEqual(["provider-stop", "store-close"]);
	expect(state.events.filter((e) => e === "store-close")).toHaveLength(1);
	expect(options.key.every((byte) => byte === 0)).toBe(true);
});
it("cleans startup failure without listening or starting workers", async () => {
	const options = setup();
	state.failReady = true;
	await expect(startAuthorityService(options)).rejects.toThrow(
		"authority_service_unavailable",
	);
	expect(state.events).toEqual([
		"spawn",
		"ready",
		"provider-stop",
		"store-close",
	]);
	expect(options.key.every((byte) => byte === 0)).toBe(true);
});
it("closes admission on unexpected provider exit and drains before releasing private state", async () => {
	const service = await startAuthorityService(setup());
	state.exit.resolve({ code: 1 });
	await new Promise((resolve) => setImmediate(resolve));
	expect(state.events).toContain("guard-close");
	expect(state.events).not.toContain("store-close");
	state.drain.resolve();
	await expect(service.closed).rejects.toThrow("authority_provider_exited");
	expect(state.events.at(-1)).toBe("store-close");
});

it.each(["failStop", "failDrain"] as const)(
	"retains private state if %s prevents confirmed cleanup",
	async (failure) => {
		const options = setup();
		const service = await startAuthorityService(options);
		state[failure] = true;
		state.drain.resolve();
		await expect(service.close()).rejects.toThrow(
			"authority_cleanup_unconfirmed",
		);
		await expect(service.closed).rejects.toThrow(
			"authority_cleanup_unconfirmed",
		);
		expect(state.events).toContain("provider-stop");
		expect(state.events).not.toContain("store-close");
		expect(options.key.every((byte) => byte === 1)).toBe(true);
	},
);
