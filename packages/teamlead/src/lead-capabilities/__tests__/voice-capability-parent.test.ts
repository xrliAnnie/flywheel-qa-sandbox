import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LeadRuntimeParentOptions } from "../runtime-factory.js";

/** FLY-2886 plan v12 §14.1 / §14.2: the voice parent's trusted composition. */
const state = vi.hoisted(() => ({
	options: undefined as LeadRuntimeParentOptions | undefined,
	parentClosed: 0,
	events: [] as string[],
	projectRoot: "",
}));
vi.mock("node:child_process", async (original) => ({
	...(await original<object>()),
	execFileSync: () => "codex-cli 0.156.1\n",
}));
vi.mock("flywheel-comm/lead-identity", () => ({
	resolveLeadIdentityRow: () => ({
		project: { projectName: "flywheel" },
		identity: {
			identityDigest: "d".repeat(64),
			backend: "codex-app-server",
			hasSummaryDuty: false,
		},
	}),
}));
vi.mock("../../ProjectConfig.js", () => ({
	parseAndValidateProjects: () => [
		{ projectName: "flywheel", projectRoot: state.projectRoot },
	],
}));
vi.mock("../voice-resolve.js", () => ({
	resolveVoiceBackgroundCapabilities: () => ({
		identity: { activationId: "voice:session" },
		operations: [],
	}),
}));
vi.mock("../deployment.js", () => ({
	verifyLeadDeployment: () => ({
		checkoutRoot: "fixture",
		headSha: "a".repeat(40),
		entrySha256: { a: "b" },
	}),
}));
vi.mock("../native-home.js", () => ({
	preparePinnedNativeSkillHome: () => ({
		assertCurrent: () => {},
		close: () => state.events.push("native.close"),
	}),
}));
vi.mock("../voice-capability-session.js", () => ({
	prepareVoiceCapabilityAuth: () => ({
		authSourcePath: "/fixture/auth.json",
		assertCurrent: () => {},
		close: () => state.events.push("auth.close"),
	}),
	openVoiceCapabilityJournal: () => ({
		operationReceipts: {
			listByActivation: () => [],
			listByDelivery: () => [],
		},
		close: () => state.events.push("journal.close"),
	}),
	createVoiceCapabilityTurns: () => ({
		beginTurn: () => {},
		endTurn: () => {},
		entryFor: () => undefined,
		close: () => state.events.push("turns.close"),
	}),
}));
vi.mock("../skill-discovery.js", () => ({
	discoverLeadRuleSources: () => ({ records: [], skillInventory: [] }),
}));
vi.mock("../../workflow-menu.js", () => ({ resolveLeadMenus: () => [] }));
vi.mock("../node-runtime-closure.js", () => ({
	leadNodeRuntimeReadPaths: (node: string) => [
		node,
		"/opt/closure/libnode.dylib",
	],
}));
vi.mock("../runtime-factory.js", () => ({
	startLeadRuntimeParent: async (options: LeadRuntimeParentOptions) => {
		state.options = options;
		return {
			manifest: {},
			pins: {},
			enterDeliveryContext: () => () => {},
			close: async () => {
				state.parentClosed++;
				state.events.push("parent.close");
			},
		};
	},
}));
vi.mock("../artifacts.js", () => ({
	LeadArtifactStore: class {
		close() {
			state.events.push("artifacts.close");
		}
	},
}));

let root: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "voice-parent-")));
	state.projectRoot = join(root, "project");
	for (const dir of ["project", "home", "activation", "state"])
		mkdirSync(join(root, dir), { mode: 0o700 });
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	state.options = undefined;
	state.parentClosed = 0;
	state.events = [];
});

async function start(env: NodeJS.ProcessEnv) {
	const { startVoiceCapabilityParent } = await import(
		"../voice-capability-parent.js"
	);
	return startVoiceCapabilityParent({
		projectName: "flywheel",
		leadId: "eng",
		sessionId: "11111111-2222-4333-8444-555555555555",
		leaseFence: "fence",
		browserMode: "off",
		codexHome: join(root, "home"),
		codexBin: process.execPath,
		activationRoot: join(root, "activation"),
		projectsPath: process.execPath,
		stateDir: join(root, "state"),
		assertLeaseCurrent: () => {},
		env: { HOME: root, ...env },
	});
}

it("fails before any allocation when the Bridge is not configured", async () => {
	await expect(
		start({ FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:1" }),
	).rejects.toThrow("voice_capability_bridge_unavailable");
	await expect(start({ FLYWHEEL_API_TOKEN: "token" })).rejects.toThrow(
		"voice_capability_bridge_unavailable",
	);
	expect(state.options).toBeUndefined();
});

it("starts without LINEAR_API_KEY and asks the factory to omit unavailable integrations", async () => {
	const parent = await start({
		FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:1",
		FLYWHEEL_API_TOKEN: "token",
	});
	try {
		expect(state.options?.integrationFailurePolicy).toBe("omit_integration");
		expect(state.options?.linearToken).toBeUndefined();
		expect(state.options?.secrets).not.toContain("");
		expect(state.options?.parent.permissionProfile.readPaths).toEqual(
			expect.arrayContaining([
				realpathSync(process.execPath),
				"/opt/closure/libnode.dylib",
			]),
		);
	} finally {
		await parent.close();
	}
});

it("revoke() is synchronous, refuses every later authority check and closes nothing", async () => {
	const parent = await start({
		FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:1",
		FLYWHEEL_API_TOKEN: "token",
		LINEAR_API_KEY: "linear",
	});
	const current = state.options!.assertActivationCurrent!;
	expect(() => current()).not.toThrow();
	parent.revoke();
	expect(() => current()).toThrow("voice_capability_closed");
	expect(state.parentClosed).toBe(0);
	expect(state.events).toEqual([]);
	await parent.close();
	expect(state.parentClosed).toBe(1);
	expect(() => current()).toThrow("voice_capability_closed");
});

it("close() revokes before it tears anything down", async () => {
	const parent = await start({
		FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:1",
		FLYWHEEL_API_TOKEN: "token",
	});
	const current = state.options!.assertActivationCurrent!;
	let revokedFirst: boolean | undefined;
	state.events.push = ((event: string) => {
		if (revokedFirst === undefined)
			try {
				current();
				revokedFirst = false;
			} catch {
				revokedFirst = true;
			}
		return Array.prototype.push.call(state.events, event);
	}) as typeof state.events.push;
	await parent.close();
	expect(revokedFirst).toBe(true);
});
