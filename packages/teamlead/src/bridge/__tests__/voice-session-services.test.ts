import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import type { BridgeConfig } from "../types.js";
import * as routes from "../voice-session-routes.js";
import { createVoiceSessionServices } from "../voice-session-services.js";

const validProbe = vi.fn(async ({ lead }) => ({
	version: 1 as const,
	leadId: lead.agentId,
	botUserId: lead.botUserId,
	runtimeId: "12345678-1234-4123-8123-123456789012",
	nonce: "0".repeat(64),
	auth: "1".repeat(64),
	ready: true,
	selfDropped: true,
	unknownDropped: true,
	otherPassed: true,
}));
let store: StateStore;
let root: string;
const SESSION_ID = "10000000-0000-4000-8000-000000000001";
beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "flywheel-voice-services-"));
	store = await StateStore.create(join(root, "teamlead.db"));
	store.reserveVoiceSession({
		sessionId: SESSION_ID,
		mode: "meeting",
		projectName: "flywheel",
		leadId: "lead-a",
		guildId: "100000000000000001",
		voiceBotUserId: "100000000000000005",
		voiceChannelId: "100000000000000002",
		requestedBy: "master",
		credentialTier: "master",
		createdAt: new Date(Date.now() - 121_000).toISOString(),
	});
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	store.close();
	rmSync(root, { recursive: true });
});

it("passes the runtime deadline into the actual provisioner fetch", async () => {
	vi.useFakeTimers();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	let signal: AbortSignal | undefined;
	const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
		signal = init?.signal ?? undefined;
		return new Promise<Response>((_resolve, reject) => {
			signal?.addEventListener("abort", () => reject(signal?.reason), {
				once: true,
			});
		});
	});
	const { runtime } = createVoiceSessionServices({
		probeSelfFilter: validProbe,
		store,
		env: { LEAD_TOKEN: "test-token" },
		homeDir: root,
		cwd: root,
		fetchImpl: fetchImpl as typeof fetch,
		projects: [
			{
				projectName: "flywheel",
				projectRoot: root,
				voiceRoom: {
					guildId: "100000000000000001",
					voiceChannelId: "100000000000000002",
				},
				leads: [
					{
						agentId: "lead-a",
						botToken: "test-token",
						botTokenEnv: "LEAD_TOKEN",
						botUserId: "100000000000000005",
						chatChannel: "100000000000000003",
					},
				],
			},
		] as ProjectEntry[],
		config: { discordOwnerUserId: "100000000000000004" } as BridgeConfig,
	});
	const tick = runtime.tick();
	await vi.advanceTimersByTimeAsync(0);
	expect(fetchImpl).toHaveBeenCalledTimes(1);
	expect(signal).toBeInstanceOf(AbortSignal);
	await vi.advanceTimersByTimeAsync(30_000);
	await tick;
	expect(signal?.aborted).toBe(true);
	expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
		state: "provisioning",
		provisioningStep: "reserved",
		rootRequestedAt: null,
	});
	expect(vi.getTimerCount()).toBe(0);
});

it("keeps pre-claim errors visible to the router provisioning callback", async () => {
	const factory = vi.spyOn(routes, "createVoiceSessionRouter");
	createVoiceSessionServices({
		probeSelfFilter: validProbe,
		store,
		env: {},
		homeDir: root,
		cwd: root,
		projects: [],
		config: {} as BridgeConfig,
		fetchImpl: vi.fn(),
	});
	const provision = factory.mock.calls[0]![0].provisionSession;
	await expect(provision(SESSION_ID)).rejects.toThrow(
		"voice_session_registry_drift",
	);
	expect(store.getVoiceSession(SESSION_ID)?.state).toBe("provisioning");
});

function configuredProject(): ProjectEntry {
	return {
		projectName: "flywheel",
		projectRoot: root,
		voiceRoom: {
			guildId: "100000000000000001",
			voiceChannelId: "100000000000000002",
		},
		leads: [
			{
				agentId: "lead-a",
				botTokenEnv: "LEAD_TOKEN",
				botUserId: "100000000000000005",
				chatChannel: "100000000000000003",
				match: {},
				summaryRole: "producer",
			},
		],
	} as ProjectEntry;
}

it.each(["bot", "room", "guild", "missing", "duplicate"])(
	"rejects %s registry drift before provision or projection effects",
	async (drift) => {
		const project = configuredProject();
		const projects = [project];
		if (drift === "bot") project.leads[0].botUserId = "100000000000000099";
		if (drift === "room")
			project.voiceRoom!.voiceChannelId = "100000000000000099";
		if (drift === "guild") project.voiceRoom!.guildId = "100000000000000099";
		if (drift === "missing") projects.length = 0;
		if (drift === "duplicate") projects.push(project);
		const factory = vi.spyOn(routes, "createVoiceSessionRouter");
		const fetchImpl = vi.fn();
		const { runtime } = createVoiceSessionServices({
			probeSelfFilter: validProbe,
			store,
			projects,
			env: { LEAD_TOKEN: "test-token" },
			homeDir: root,
			cwd: root,
			fetchImpl,
			config: { discordOwnerUserId: "founder" } as BridgeConfig,
		});
		const deps = factory.mock.calls[0]![0];
		expect(() =>
			deps.projectSession(store.getVoiceSession(SESSION_ID)!),
		).toThrow("voice_session_registry_drift");
		await runtime.tick();
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			state: "failed",
			reason: "voice_session_registry_drift",
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	},
);

it.each(["provisioning", "desired", "claimed", "warming", "live", "ending"])(
	"cleans legacy %s identity without any network effects",
	async (state) => {
		const db = new Database(join(root, "teamlead.db"));
		db.prepare(
			"UPDATE voice_sessions SET voice_bot_user_id = NULL, state = ?",
		).run(state);
		db.close();
		const fetchImpl = vi.fn();
		const { runtime } = createVoiceSessionServices({
			probeSelfFilter: validProbe,
			store,
			projects: [configuredProject()],
			env: { LEAD_TOKEN: "test-token" },
			homeDir: root,
			cwd: root,
			fetchImpl,
			config: {} as BridgeConfig,
		});
		await runtime.tick();
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			state: "failed",
			reason: "identity_binding_missing",
			voiceBotUserId: null,
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	},
);

it("projects the persisted tuple and permits token rotation with unchanged bot identity", () => {
	const factory = vi.spyOn(routes, "createVoiceSessionRouter");
	createVoiceSessionServices({
		probeSelfFilter: validProbe,
		store,
		projects: [configuredProject()],
		env: { LEAD_TOKEN: "rotated-token" },
		homeDir: root,
		cwd: root,
		config: {} as BridgeConfig,
	});
	expect(
		factory.mock.calls[0]![0].projectSession(
			store.getVoiceSession(SESSION_ID)!,
		),
	).toMatchObject({
		sessionId: SESSION_ID,
		guildId: "100000000000000001",
		voiceChannelId: "100000000000000002",
		voiceBotUserId: "100000000000000005",
	});
});

it.each(["provisioning", "desired", "claimed", "warming", "live", "ending"])(
	"stops %s when the carrier no longer proves self filtering",
	async (state) => {
		const db = new Database(join(root, "teamlead.db"));
		db.prepare("UPDATE voice_sessions SET state = ?").run(state);
		db.close();
		const fetchImpl = vi.fn();
		const { runtime } = createVoiceSessionServices({
			store,
			projects: [configuredProject()],
			env: { LEAD_TOKEN: "token" },
			homeDir: root,
			cwd: root,
			config: {} as BridgeConfig,
			fetchImpl,
			probeSelfFilter: async () => {
				throw new Error("old carrier");
			},
		});
		await runtime.tick();
		expect(store.getVoiceSession(SESSION_ID)).toMatchObject({
			state: "failed",
			reason: "self_filter_unverified",
		});
		expect(fetchImpl).not.toHaveBeenCalled();
	},
);
