/**
 * FLY-1160 §3.3 — daemon assembly: singleton ResidentBrainManager → BrainPort
 * (only when port config + FLYWHEEL_BRAIN_PORT_TOKEN are BOTH present) →
 * Discord wiring. Byte-compat sentinel: with no brain config the daemon's
 * /health JSON keys and listening-port set are unchanged. close() runs the
 * two-phase shutdown; the runtime exposes forceKillAll for the outer
 * hard-timer (never exit with a live resident child behind).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { DiscordDeps } from "../bots/discordWiring.js";
import { runVoiceBridge, type VoiceBridgeRuntime } from "../cli.js";
import type { HuddleBridgeConfig } from "../config.js";

function fakeDeps(): DiscordDeps {
	return {
		createClient: () => ({
			login: async () => "ok",
			isReady: () => true,
			once: () => {},
			destroy: () => {},
		}),
		joinVoice: async () => ({}),
		subscribeManual: () => () => {
			throw new Error("not used");
		},
		createDecoder: () => {
			throw new Error("not used");
		},
		createPlayer: () => {
			throw new Error("not used");
		},
		createResource: () => ({}),
		speakingEvents: () => ({ on: () => {} }),
		isHumanFactory: () => () => false,
	} as unknown as DiscordDeps;
}

const randPort = () => 22000 + Math.floor(Math.random() * 20000);

function config(
	port: number,
	brain?: HuddleBridgeConfig["brain"],
): HuddleBridgeConfig {
	return {
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		guildId: "g",
		voiceChannelId: "vc",
		commandName: "meet",
		moveMembers: true,
		orchestratorToken: "tok-orch",
		earsToken: "tok-ears",
		leads: [
			{ agentId: "flywheel-eng-lead", botTokenEnv: "X", botToken: "tok-lead" },
		],
		backchannelMs: 350,
		allowUserIds: [],
		healthPort: port,
		ffmpegBin: "ffmpeg",
		...(brain ? { brain } : {}),
	};
}

const okProbe = async () => ({ ok: true, detail: "fake ffmpeg" });
const TOKEN_ENV = "FLYWHEEL_BRAIN_PORT_TOKEN";

const runtimes: VoiceBridgeRuntime[] = [];
const savedToken = process.env[TOKEN_ENV];
afterEach(async () => {
	for (const r of runtimes) {
		try {
			await r.close();
		} catch {}
	}
	runtimes.length = 0;
	if (savedToken === undefined) delete process.env[TOKEN_ENV];
	else process.env[TOKEN_ENV] = savedToken;
});

async function run(cfg: HuddleBridgeConfig): Promise<VoiceBridgeRuntime> {
	const runtime = await runVoiceBridge({
		config: cfg,
		deps: fakeDeps(),
		probe: okProbe,
		log: () => {},
		assistant: null,
		eleven: null,
		shutdownBudgetMs: 200,
	});
	runtimes.push(runtime);
	return runtime;
}

describe("voice-bridge daemon — BrainPort assembly", () => {
	it("byte-compat: no brain config → health JSON keys unchanged, no brain listener, runtime still closes clean", async () => {
		delete process.env[TOKEN_ENV];
		const hp = randPort();
		const runtime = await run(config(hp));
		const body = (await (
			await fetch(`http://127.0.0.1:${hp}/health`)
		).json()) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(
			[
				"ok",
				"shuttingDown",
				"service",
				"project",
				"bots",
				"earsJoined",
				"assistant",
				// FLY-1159: the advanced command name joined the health contract
				// (mode off = explicit null) — an additive key, brain stays absent.
				"assistantAdvanced",
				"eleven",
			].sort(),
		);
		expect(typeof runtime.forceKillAll).toBe("function");
		await runtime.close();
		await expect(fetch(`http://127.0.0.1:${hp}/health`)).rejects.toThrow();
	});

	it("brain port configured but token env unset → BrainPort NOT started", async () => {
		delete process.env[TOKEN_ENV];
		const hp = randPort();
		const bp = randPort();
		await run(config(hp, { port: bp, model: "sonnet", maxSessions: 4 }));
		await expect(
			fetch(`http://127.0.0.1:${bp}/brain/health`),
		).rejects.toThrow();
	});

	it("a Phase-2 teardown failure never skips Phase 3: close() still resolves and the brain port is down (Codex #550 R1)", async () => {
		process.env[TOKEN_ENV] = "assembly-secret";
		const hp = randPort();
		const bp = randPort();
		const deps = fakeDeps();
		(deps as { createClient: unknown }).createClient = () => ({
			login: async () => "ok",
			isReady: () => true,
			once: () => {},
			destroy: () => {
				throw new Error("discord teardown boom");
			},
		});
		const failing = await runVoiceBridge({
			config: config(hp, { port: bp, model: "sonnet", maxSessions: 4 }),
			deps,
			probe: okProbe,
			log: () => {},
			assistant: null,
			eleven: null,
			shutdownBudgetMs: 200,
		});
		runtimes.push(failing);
		await failing.close(); // must resolve despite the Phase-2 explosion
		await expect(
			fetch(`http://127.0.0.1:${bp}/brain/health`),
		).rejects.toThrow();
	});

	it("brain port + token → Bearer-gated /brain/health live; close() takes it down", async () => {
		process.env[TOKEN_ENV] = "assembly-secret";
		const hp = randPort();
		const bp = randPort();
		const runtime = await run(
			config(hp, { port: bp, model: "sonnet", maxSessions: 4 }),
		);
		const unauth = await fetch(`http://127.0.0.1:${bp}/brain/health`);
		expect(unauth.status).toBe(401);
		const ok = await fetch(`http://127.0.0.1:${bp}/brain/health`, {
			headers: { authorization: "Bearer assembly-secret" },
		});
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ ok: true, active: 0 });
		await runtime.close();
		await expect(
			fetch(`http://127.0.0.1:${bp}/brain/health`),
		).rejects.toThrow();
	});
});
