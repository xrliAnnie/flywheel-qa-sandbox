import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import type { BridgeConfig } from "../types.js";
import * as routes from "../voice-session-routes.js";
import { createVoiceSessionServices } from "../voice-session-services.js";

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
		store,
		env: {},
		homeDir: root,
		cwd: root,
		fetchImpl: fetchImpl as typeof fetch,
		projects: [
			{
				projectName: "flywheel",
				projectRoot: root,
				huddle: { guildId: "100000000000000001" },
				leads: [
					{
						agentId: "lead-a",
						botToken: "test-token",
						botUserId: "100000000000000005",
						chatChannel: "100000000000000003",
					},
				],
			},
		] as ProjectEntry[],
		config: { discordOwnerUserId: "100000000000000004" } as BridgeConfig,
	});
	const tick = runtime.tick();
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
