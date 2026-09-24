import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

it("isolates the default voice health state root under Vitest", () => {
	expect(process.env.FLYWHEEL_STATE_DIR).toBeTruthy();
	expect(process.env.FLYWHEEL_STATE_DIR).not.toBe(join(homedir(), ".flywheel"));
	expect(process.env.FLYWHEEL_STATE_DIR?.startsWith(tmpdir())).toBe(true);
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

function configuredResidentProject(): ProjectEntry {
	return {
		projectName: "flywheel",
		projectRoot: root,
		huddle: {
			guildId: "100000000000000001",
			voiceChannelId: "100000000000000099",
			orchestratorBotTokenEnv: "ORCHESTRATOR_TOKEN",
			orchestratorBotUserId: "100000000000000008",
			earsBotTokenEnv: "EARS_TOKEN",
			earsBotUserId: "100000000000000009",
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

it("does not poll Discord outbound replies when Engine A owns Lead delivery", async () => {
	const now = new Date().toISOString();
	store.updateVoiceProvisioning({
		sessionId: SESSION_ID,
		expectedStep: "reserved",
		nextStep: "done",
		nextState: "desired",
		updatedAt: now,
	});
	store.claimVoiceSession({
		sessionId: SESSION_ID,
		daemonBootId: "boot",
		now,
		leaseTtlMs: 3_600_000,
	});
	const db = new Database(join(root, "teamlead.db"));
	db.prepare(
		`UPDATE voice_sessions
		 SET state = 'live', root_message_id = ?, bound_channel_ids = ?, outbound_cursor = ?
		 WHERE session_id = ?`,
	).run(
		"100000000000000006",
		JSON.stringify(["100000000000000003"]),
		JSON.stringify({ "100000000000000003": "100000000000000007" }),
		SESSION_ID,
	);
	db.close();
	const fetchImpl = vi.fn(async () =>
		new Response("[]", {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	);
	const { runtime } = createVoiceSessionServices({
		probeSelfFilter: validProbe,
		store,
		projects: [configuredProject()],
		env: {
			LEAD_TOKEN: "test-token",
			FLYWHEEL_VOICE_ENGINE: "openai-live",
		},
		homeDir: root,
		cwd: root,
		fetchImpl: fetchImpl as typeof fetch,
		config: { discordOwnerUserId: "founder" } as BridgeConfig,
	});

	await runtime.tick();

	expect(fetchImpl).not.toHaveBeenCalled();
});

function residentStartBody(overrides: Record<string, unknown> = {}) {
	const observedAt = new Date().toISOString();
	return {
		requestId: "resident-request-1",
		mode: "meeting",
		projectName: "flywheel",
		leadId: "lead-a",
		ownerBootId: "resident-boot-1",
		sessionGeneration: 7,
		bindingProof: {
			version: 1,
			projectName: "flywheel",
			guildId: "100000000000000001",
			voiceChannelId: "100000000000000099",
			ownerBootId: "resident-boot-1",
			sessionGeneration: 7,
			outputBotUserId: "100000000000000008",
			earsBotUserId: "100000000000000009",
			outputBotDropped: true,
			earsBotDropped: true,
			unknownDropped: true,
			allowedHumanPassed: true,
			observedAt,
			expiresAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
		},
		...overrides,
	};
}

it("resolves and validates a resident claim from registered huddle identities without daemon effects", async () => {
	const factory = vi.spyOn(routes, "createVoiceSessionRouter");
	const fetchImpl = vi.fn();
	const { runtime } = createVoiceSessionServices({
		store,
		projects: [configuredResidentProject()],
		env: {},
		homeDir: root,
		cwd: root,
		fetchImpl,
		config: {} as BridgeConfig,
	});
	const deps = factory.mock.calls[0]![0];
	const resolved = await deps.resolveResidentStart!(residentStartBody());
	expect(resolved.reservation).toMatchObject({
		mode: "meeting",
		projectName: "flywheel",
		leadId: "lead-a",
		guildId: "100000000000000001",
		voiceChannelId: "100000000000000099",
		voiceBotUserId: "100000000000000008",
		requestedBy: "master",
		credentialTier: "master",
	});
	expect(resolved.inputDigest).toMatch(/^[0-9a-f]{64}$/);

	store.setVoiceSessionState({
		sessionId: SESSION_ID,
		state: "ended",
		now: new Date().toISOString(),
	});
	const claimed = store.reserveAndClaimResidentVoiceSession({
		...resolved,
		leaseTtlMs: 15_000,
	});
	expect("session" in claimed).toBe(true);
	if (!("session" in claimed)) throw new Error("resident claim failed");
	await expect(
		deps.validateSession?.(claimed.session),
	).resolves.toBeUndefined();
	await expect(
		deps.validateSession?.({
			...claimed.session,
			residentBindingProof: {
				...claimed.session.residentBindingProof!,
				observedAt: "1999-12-31T23:59:00.000Z",
				expiresAt: "2000-01-01T00:00:00.000Z",
			},
		}),
	).rejects.toThrow("self_filter_unverified");
	await runtime.tick();
	expect(fetchImpl).not.toHaveBeenCalled();
	expect(store.getVoiceSession(claimed.session.sessionId)).toMatchObject({
		carrierKind: "resident",
		state: "claimed",
		ownerBootId: "resident-boot-1",
		sessionGeneration: 7,
	});
});

it("fails closed when a resident claim cannot prove the registered room and bot bindings", async () => {
	const factory = vi.spyOn(routes, "createVoiceSessionRouter");
	createVoiceSessionServices({
		store,
		projects: [configuredResidentProject()],
		env: {},
		homeDir: root,
		cwd: root,
		config: {} as BridgeConfig,
	});
	const resolveResidentStart = factory.mock.calls[0]![0].resolveResidentStart!;
	expect(() =>
		resolveResidentStart(
			residentStartBody({
				bindingProof: {
					...residentStartBody().bindingProof,
					earsBotUserId: "100000000000000010",
				},
			}),
		),
	).toThrowError(
		expect.objectContaining({
			status: 503,
			code: "voice_unavailable",
			reason: "resident_binding_invalid",
		}),
	);
	expect(() =>
		resolveResidentStart(
			residentStartBody({
				bindingProof: {
					...residentStartBody().bindingProof,
					allowedHumanPassed: false,
				},
			}),
		),
	).toThrowError(
		expect.objectContaining({
			status: 503,
			code: "voice_unavailable",
			reason: "self_filter_unverified",
		}),
	);
});

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
		sessionGeneration: 1,
		guildId: "100000000000000001",
		voiceChannelId: "100000000000000002",
		voiceBotUserId: "100000000000000005",
	});
});

it("projects authoritative demand into the durable voice health store", async () => {
	const now = new Date().toISOString();
	const db = new Database(join(root, "teamlead.db"));
	db.prepare(
		"UPDATE voice_sessions SET created_at = ?, updated_at = ? WHERE session_id = ?",
	).run(now, now, SESSION_ID);
	db.close();
	const stateRoot = join(root, "health-state");
	const { runtime } = createVoiceSessionServices({
		probeSelfFilter: validProbe,
		store,
		projects: [configuredProject()],
		env: {
			LEAD_TOKEN: "test-token",
			FLYWHEEL_STATE_DIR: stateRoot,
		},
		homeDir: root,
		cwd: root,
		config: { discordOwnerUserId: "founder" } as BridgeConfig,
		fetchImpl: vi.fn(),
	});

	await runtime.tick();
	const health = new Database(
		join(stateRoot, "state", "voice-health", "observations.sqlite"),
		{ readonly: true },
	);
	const demand = health
		.prepare(
			"SELECT demand_state AS state, demand_event_cursor AS cursor FROM health",
		)
		.get() as { state: string; cursor: number };
	health.close();
	expect(demand).toEqual({ state: "required", cursor: 1 });
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
