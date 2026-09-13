import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	receipt: null as any,
	stopped: false,
	configured: false,
	manifest: false,
	plist: false,
	seeded: false,
	active: false,
	events: [] as string[],
	authority: true,
	preflightFail: false,
	sha: "b".repeat(40),
}));
vi.mock("flywheel-comm/lead-backend-migration-runtime", async (original) => ({
	...(await original<any>()),
	readMigrationRegistry: () => ({}),
	readMigrationIntentRecord: () => ({
		intentSha: "a".repeat(64),
		plan: {
			deploymentSha: "b".repeat(40),
			expected: { manifestSha: "c".repeat(64), plistSha: "d".repeat(64) },
		},
	}),
	resolveMigrationIdentities: () => ({
		projectRoot: "/root",
		source: { identityDigest: "e".repeat(64) },
		target: { identityDigest: "f".repeat(64) },
		botTokenEnv: "TEST_MIGRATION_BOT",
		botUserId: "123456789012345678",
		channelIds: ["223456789012345678"],
	}),
	renderMigrationArtifacts: () => ({
		manifest: "target-manifest",
		plist: "target-plist",
	}),
	loadMigrationReceipt: () => state.receipt,
	saveMigrationReceipt: (_h: string, r: any) => {
		state.receipt = structuredClone(r);
	},
	preserveMigrationArtifacts: () => {},
	restoreMigrationFilesLocked: () => {
		Object.assign(state, { configured: false, manifest: false, plist: false });
		state.events.push("restore-files");
	},
	migrateRegistryFieldsLocked: () => {
		state.configured = true;
		state.events.push("configure");
	},
	replaceMigrationArtifact: (_h: string, _p: unknown, kind: string) => {
		if (kind === "manifest") state.manifest = true;
		else state.plist = true;
	},
	observeMigrationRegistry: () => ({
		state: state.configured ? "post" : "pre",
		proofSha: "1".repeat(64),
	}),
	observeMigrationArtifact: (_h: string, _p: unknown, kind: string) => ({
		state: (kind === "manifest" ? state.manifest : state.plist)
			? "post"
			: "pre",
		proofSha: "2".repeat(64),
	}),
	assertMigrationWriterStopped: () => {
		if (!state.stopped || state.active) throw Error("not stopped");
		return "3".repeat(64);
	},
}));
vi.mock("./backend-migration-authority.js", () => ({
	readMigrationDeploymentHead: () => state.sha,
	createMigrationWindowGuard: (_j: string, _t: unknown, sha: string) => () => {
		if (sha !== state.sha) throw Error("migration deployment HEAD conflict");
		if (!state.authority) throw Error("expired");
	},
}));
vi.mock("./backend-migration-config-lock.js", () => ({
	withMigrationConfigLock: async (
		_i: unknown,
		fn: (assert: () => void) => void,
	) => fn(() => {}),
}));
vi.mock("./backend-migration-lifecycle.js", () => ({
	runMigrationStaticPreflight: async () => ({
		codexHome: "/codex",
		stateDir: "/state",
	}),
	runMigrationLifecycle: async (_i: unknown, op: string) => {
		state.events.push(op);
		if (op === "preflight" && state.preflightFail)
			throw Error("preflight failed");
		if (op === "stop") state.stopped = true;
		if (op === "load") {
			state.active = state.configured;
			if (!state.configured) state.stopped = false;
		}
	},
}));
vi.mock("./backend-migration-activation.js", () => ({
	observeMigrationSource: async () =>
		state.configured || state.stopped
			? null
			: {
					carrier: { pid: 100, start: "old", command: "old" },
					proofSha: "4".repeat(64),
				},
	observeMigrationActivation: async () => {
		if (!state.active) throw Error("not ready");
		return "5".repeat(64);
	},
}));
vi.mock("./collect-seed-backend-migration.js", () => ({
	collectAndSeedBackendMigration: async () => {
		state.seeded = true;
		state.events.push("seed");
	},
	observeBackendMigrationSeed: () => ({
		state: state.seeded ? "post" : "pre",
		proofSha: "6".repeat(64),
	}),
}));

import { executeMigrationEntry } from "./execute-backend-migration.js";

beforeEach(() => {
	Object.assign(state, {
		receipt: null,
		stopped: false,
		configured: false,
		manifest: false,
		plist: false,
		seeded: false,
		active: false,
		events: [],
		authority: true,
		preflightFail: false,
		sha: "b".repeat(40),
	});
	vi.stubEnv("TEST_MIGRATION_BOT", "fixture");
});
const trusted = { home: "/home", root: "/root" };
const context = JSON.stringify({
	...trusted,
	restartPid: 123,
	restartStart: "start",
	lockDev: 1,
	lockIno: 2,
	leaseId: "12345678-1234-4234-8234-123456789abc",
	restartScript: "/root/scripts/restart-services.sh",
	updaterScript: "/root/scripts/update-flywheel.sh",
});
it("drives the actual coordinator through deployment and re-observes activation without repeating writes", async () => {
	const result = await executeMigrationEntry(context, trusted);
	expect(result.status).toBe("deployed_unverified");
	expect(state.events).toEqual([
		"stop",
		"configure",
		"seed",
		"preflight",
		"load",
	]);
	const before = [...state.events];
	expect((await executeMigrationEntry(context, trusted)).status).toBe(
		"skipped",
	);
	expect(state.events).toEqual(before);
});
it("rejects a foreign context and expired authority before any mutation", async () => {
	await expect(executeMigrationEntry("{}", trusted)).rejects.toThrow();
	state.authority = false;
	await expect(executeMigrationEntry(context, trusted)).rejects.toThrow(
		"expired",
	);
	expect(state.events).toEqual([]);
});

afterEach(() => vi.unstubAllEnvs());

it("skips an untouched stale plan without stopping or writing", async () => {
	state.sha = "c".repeat(40);
	expect(await executeMigrationEntry(context, trusted)).toMatchObject({
		status: "skipped",
		reason: "source_unchanged",
	});
	expect(state.events).toEqual([]);
	expect(state.receipt).toBeNull();
});
it("allows later waves after deployment while preserving the verification receipt", async () => {
	await executeMigrationEntry(context, trusted);
	const receipt = structuredClone(state.receipt);
	state.sha = "c".repeat(40);
	state.events = [];
	expect(await executeMigrationEntry(context, trusted)).toMatchObject({
		status: "skipped",
		reason: "awaiting_verification",
	});
	expect(state.events).toEqual([]);
	expect(state.receipt).toEqual(receipt);
});
it("rejects stale interrupted migration and unproven terminal state", async () => {
	await executeMigrationEntry(context, trusted);
	state.sha = "c".repeat(40);
	state.receipt.status = "held";
	state.receipt.pending = "activate";
	state.events = [];
	await expect(executeMigrationEntry(context, trusted)).rejects.toThrow();
	expect(state.events).toEqual([]);
	state.receipt.status = "deployed_unverified";
	state.receipt.pending = null;
	state.active = false;
	await expect(executeMigrationEntry(context, trusted)).rejects.toThrow();
	expect(state.events).toEqual([]);
});
it("skips restored failures only after observing the source again", async () => {
	await executeMigrationEntry(context, trusted);
	Object.assign(state, {
		configured: false,
		manifest: false,
		plist: false,
		stopped: false,
		active: false,
		events: [],
		sha: "c".repeat(40),
	});
	Object.assign(state.receipt, {
		status: "failed",
		pending: null,
		recovery: {
			reason: "activation_preflight_failed",
			state: "restored",
			proofSha: "1".repeat(64),
		},
	});
	expect(await executeMigrationEntry(context, trusted)).toMatchObject({
		status: "skipped",
		reason: "source_restored",
	});
	expect(state.events).toEqual([]);
	state.stopped = true;
	await expect(executeMigrationEntry(context, trusted)).rejects.toThrow();
	expect(state.events).toEqual([]);
});
it("skips a held static preflight only with the original live source", async () => {
	state.receipt = {
		version: 1,
		intentSha: "a".repeat(64),
		revision: 0,
		status: "held",
		pending: "preflight",
		completed: {},
		failure: "step_failed",
	};
	expect(await executeMigrationEntry(context, trusted)).toMatchObject({
		status: "skipped",
		reason: "source_unchanged",
	});
	expect(state.events).toEqual([]);
	state.stopped = true;
	state.sha = "c".repeat(40);
	await expect(executeMigrationEntry(context, trusted)).rejects.toThrow();
});

it("continues the same wave after a proved activation-preflight rollback", async () => {
	state.preflightFail = true;
	expect(await executeMigrationEntry(context, trusted)).toMatchObject({
		status: "skipped",
		reason: "source_restored",
	});
	expect(state.receipt).toMatchObject({
		status: "failed",
		recovery: { state: "restored" },
	});
	expect(state.events).toEqual([
		"stop",
		"configure",
		"seed",
		"preflight",
		"restore-files",
		"load",
	]);
});
it("refuses terminal artifact drift, mismatched receipts and revoked inspection authority", async () => {
	await executeMigrationEntry(context, trusted);
	state.events = [];
	state.sha = "c".repeat(40);
	state.manifest = false;
	await expect(executeMigrationEntry(context, trusted)).rejects.toThrow(
		"artifact unproven",
	);
	state.manifest = true;
	state.receipt.intentSha = "0".repeat(64);
	await expect(executeMigrationEntry(context, trusted)).rejects.toThrow(
		"receipt intent conflict",
	);
	state.receipt.intentSha = "a".repeat(64);
	state.authority = false;
	await expect(executeMigrationEntry(context, trusted)).rejects.toThrow(
		"expired",
	);
	expect(state.events).toEqual([]);
});
