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
	resolveNodeRuntimeClosure: (node: string) => ({
		files: [node, "/opt/closure/libnode.dylib"],
		directories: [],
	}),
	leadNodeRuntimeReadPaths: (closure: { files: string[] }) => closure.files,
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
let activation: string;
beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "voice-parent-")));
	// Like the container: a short private root, whatever TMPDIR is.
	activation = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "vp-a-")));
	state.projectRoot = join(root, "project");
	for (const dir of ["project", "home", "state"])
		mkdirSync(join(root, dir), { mode: 0o700 });
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(activation, { recursive: true, force: true });
	state.options = undefined;
	state.parentClosed = 0;
	state.events = [];
});

async function start(env: NodeJS.ProcessEnv, activationRoot = activation) {
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
		activationRoot,
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

it("refuses an activation root whose broker socket cannot fit, before starting anything (QA@3 B1)", async () => {
	const { LEAD_BROKER_SOCKET_MAX_BYTES, leadBrokerSocketBytes } = await import(
		"../broker-socket.js"
	);
	const env = {
		FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:1",
		FLYWHEEL_API_TOKEN: "token",
	};
	// A child directory named with n bytes adds n + 1 bytes to the socket path.
	const child = (bytes: number, fill: string) => {
		const n = bytes - leadBrokerSocketBytes(activation) - 1;
		const path = join(activation, fill.repeat(n));
		mkdirSync(path, { mode: 0o700 });
		return path;
	};
	const over = child(LEAD_BROKER_SOCKET_MAX_BYTES + 1, "x");
	expect(leadBrokerSocketBytes(over)).toBe(LEAD_BROKER_SOCKET_MAX_BYTES + 1);
	await expect(start(env, over)).rejects.toThrow(
		"voice_capability_broker_socket_too_long",
	);
	expect(state.options).toBeUndefined();
	expect(state.events).toEqual([]);
	// Exactly at the limit starts.
	const at = child(LEAD_BROKER_SOCKET_MAX_BYTES, "y");
	expect(leadBrokerSocketBytes(at)).toBe(LEAD_BROKER_SOCKET_MAX_BYTES);
	const parent = await start(env, at);
	await parent.close();
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
		expect(parent.nodeRuntimeClosure).toEqual({
			files: [realpathSync(process.execPath), "/opt/closure/libnode.dylib"],
			directories: [],
		});
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

// QA@5 B2: at load 95–180 the synchronous `codex --version` blocked the voice
// daemon's event loop for 4.5 s during admission; it must not block at all.
it("reads the codex version without blocking the event loop", async () => {
	const { chmodSync, writeFileSync } = await import("node:fs");
	const { readCodexVersion } = await import("../voice-capability-parent.js");
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "vcap-ver-")));
	try {
		const bin = join(dir, "codex");
		writeFileSync(bin, "#!/bin/sh\nsleep 0.6\necho 'codex-cli 0.156.1'\n");
		chmodSync(bin, 0o755);
		let ticks = 0;
		const timer = setInterval(() => {
			ticks += 1;
		}, 50);
		try {
			await expect(readCodexVersion(bin, dir)).resolves.toBe("0.156.1");
		} finally {
			clearInterval(timer);
		}
		expect(ticks).toBeGreaterThanOrEqual(5);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
