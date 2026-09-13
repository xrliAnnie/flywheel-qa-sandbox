import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	events: [] as string[],
	receipt: null as any,
	preflightFail: false,
	loadFail: false,
	steps: new Set<string>(),
}));
vi.mock(
	"flywheel-comm/lead-backend-migration-runtime",
	async (importOriginal) => ({
		...(await importOriginal<any>()),
		loadMigrationReceipt: () => state.receipt,
		saveMigrationReceipt: (_home: string, r: any) => {
			state.receipt = structuredClone(r);
		},
		preserveMigrationArtifacts: () => state.events.push("backup"),
		migrateRegistryFieldsLocked: () => {
			state.events.push("configure");
			state.steps.add("configure");
		},
		replaceMigrationArtifact: (_h: string, _e: unknown, kind: string) => {
			state.events.push(kind);
			state.steps.add(`stage_${kind}`);
		},
		restoreMigrationFilesLocked: () => state.events.push("restore-files"),
	}),
);
vi.mock("../bin/backend-migration-config-lock.js", () => ({
	withMigrationConfigLock: async (
		_i: unknown,
		fn: (assertHeld: () => void) => void,
	) => {
		state.events.push("lock");
		fn(() => {});
		state.events.push("unlock");
	},
}));
vi.mock("../bin/backend-migration-lifecycle.js", () => ({
	runMigrationLifecycle: async (_i: unknown, op: string) => {
		state.events.push(op);
		if (op === "preflight" && state.preflightFail) throw Error("failed");
		if (op === "load" && state.loadFail) throw Error("failed");
		if (op === "stop") state.steps.add("stop");
		if (op === "load") state.steps.add("activate");
	},
}));

import { runBackendMigrationWindow } from "../bin/backend-migration-window.js";

beforeEach(() => {
	state.events = [];
	state.receipt = null;
	state.preflightFail = false;
	state.loadFail = false;
	state.steps.clear();
});
function input() {
	return {
		home: "/home",
		root: "/root",
		intentSha: "a".repeat(64),
		plan: { expected: {} } as any,
		target: { manifest: "manifest", plist: "plist" },
		assertWindow: () => {},
		assertStopped: () => {},
		validateCandidate: () => {},
		captureSourceCarrier: async () => ({ pid: 123, start: "start" }),
		staticPreflight: async () => {
			state.events.push("static");
			state.steps.add("preflight");
		},
		seed: async () => {
			state.events.push("seed");
			state.steps.add("seed");
		},
		observe: async (step: string) => ({
			state: state.steps.has(step) ? ("post" as const) : ("pre" as const),
			proofSha: "b".repeat(64),
		}),
		observeRestoredSource: async () =>
			state.events.includes("load") ? "c".repeat(64) : null,
	};
}
it("composes bounded forward actions and exits deployed_unverified", async () => {
	const result = await runBackendMigrationWindow(input());
	expect(result.status).toBe("deployed_unverified");
	expect(state.events).toEqual([
		"static",
		"backup",
		"stop",
		"lock",
		"configure",
		"unlock",
		"manifest",
		"plist",
		"seed",
		"preflight",
		"load",
	]);
	await runBackendMigrationWindow(input());
	expect(state.events.filter((e) => e === "load")).toHaveLength(1);
});
it("restores files under lock then reloads the old owner only after activation preflight failure", async () => {
	state.preflightFail = true;
	const result = await runBackendMigrationWindow(input());
	expect(result.status).toBe("failed");
	expect(result.recovery?.state).toBe("restored");
	expect(state.events.slice(-5)).toEqual([
		"preflight",
		"lock",
		"restore-files",
		"unlock",
		"load",
	]);
});
it("does not automatically restore after an actual load failure", async () => {
	state.loadFail = true;
	await expect(runBackendMigrationWindow(input())).rejects.toThrow("failed");
	expect(state.receipt.status).toBe("held");
	expect(state.events).not.toContain("restore-files");
});
it("re-observes a restored source on recovery replay without reloading it", async () => {
	state.preflightFail = true;
	const first = await runBackendMigrationWindow(input());
	expect(first.recovery?.state).toBe("restored");
	const before = [...state.events];
	const replay = await runBackendMigrationWindow(input());
	expect(replay.status).toBe("failed");
	expect(state.events).toEqual(before);
});
it("refuses mutations when window authority is absent", async () => {
	const f = input();
	f.assertWindow = () => {
		throw Error("expired");
	};
	await expect(runBackendMigrationWindow(f)).rejects.toThrow("expired");
	expect(state.events).toEqual([]);
});
it("waits for a delayed restored owner without repeating load", async () => {
	state.preflightFail = true;
	const f = input();
	let reads = 0;
	f.observeRestoredSource = async () => (++reads >= 3 ? "c".repeat(64) : null);
	const result = await runBackendMigrationWindow(f);
	expect(result.recovery?.state).toBe("restored");
	expect(state.events.filter((e) => e === "load")).toHaveLength(1);
});
