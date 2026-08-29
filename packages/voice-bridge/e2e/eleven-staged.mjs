/**
 * FLY-1006 S8 — "/eleven 真机能起一轮" staged smoke (plan P5, leg 0).
 *
 * Follows gemini-staged.mjs discipline: real bots, real daemon, real
 * ElevenLabs agent + shim rig (session-front runbook assets, m1-rig.md),
 * short-lived VC presence, evidence to stdout. The autostart QA seam opens
 * one /eleven round; the invocation/preflight/slot chain IS the acceptance.
 *
 *   env: HUDDLE_ORCH_BOT_TOKEN HUDDLE_EARS_BOT_TOKEN     # staging bots
 *        ELEVENLABS_AGENT_ID                             # rig agent (runbook)
 *        ELEVENLABS_API_KEY                              # ~/.flywheel/.env
 *        STAGED_GUILD_ID / STAGED_VC_ID                  # 529-room VC
 *        ELEVEN_SHIM_HEALTH_URL (default http://127.0.0.1:8980/health)
 *        STAGED_HEALTH_PORT (default 9879) / STAGED_HOLD_MS (default 45000)
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVoiceBridge } from "../dist/cli.js";

const need = (k) => {
	const v = process.env[k];
	if (!v) {
		console.error(`missing env ${k}`);
		process.exit(2);
	}
	return v;
};

const guildId = need("STAGED_GUILD_ID");
const voiceChannelId = need("STAGED_VC_ID");
const agentId = need("ELEVENLABS_AGENT_ID");
need("ELEVENLABS_API_KEY");

// isolation guards (bf8369b1 precedent): never touch prod surfaces.
const healthPort = Number(process.env.STAGED_HEALTH_PORT ?? 9879);
if (healthPort === 9878) {
	console.error(
		"refusing to run staged /eleven on the production voice-bridge health port (9878)",
	);
	process.exit(2);
}
if (/:9876(\/|$)/.test(process.env.FLYWHEEL_BRIDGE_URL ?? "")) {
	console.error("refusing to run with FLYWHEEL_BRIDGE_URL on prod port 9876");
	process.exit(2);
}

const evidence = [];
const log = (msg) => {
	const line = `[${new Date().toISOString()}] ${msg}`;
	evidence.push(line);
	console.log(line);
};

process.env.FLYWHEEL_ELEVEN_AUTOSTART ??= "staged /eleven 冒烟";

// verdict source (Codex code review R1: a timed hold alone can false-green
// when preflight/autostart/WS fails): the session writes session_live +
// metadata into its transcript jsonl — assert it before exiting 0.
const stateDir = mkdtempSync(join(tmpdir(), "fly1006-staged-state-"));

const runtime = await runVoiceBridge({
	config: {
		projectName: process.env.STAGED_PROJECT_NAME ?? "flywheel",
		projectRoot: process.cwd(),
		guildId,
		voiceChannelId,
		commandName: "meet",
		moveMembers: false,
		orchestratorToken: need("HUDDLE_ORCH_BOT_TOKEN"),
		earsToken: need("HUDDLE_EARS_BOT_TOKEN"),
		leads: [],
		backchannelMs: 350,
		allowUserIds: [],
		healthPort,
		ffmpegBin: process.env.FFMPEG_BIN ?? "ffmpeg",
	},
	assistant: null,
	eleven: {
		commandName: process.env.STAGED_COMMAND_NAME ?? "eleven",
		agentId,
		apiKeyEnv: "ELEVENLABS_API_KEY",
		shimHealthUrl:
			process.env.ELEVEN_SHIM_HEALTH_URL ?? "http://127.0.0.1:8980/health",
		voiceId: process.env.STAGED_VOICE_ID,
		waitingCuePath: process.env.STAGED_WAITING_CUE,
	},
	elevenWiring: { stateDir },
	log,
});
log(`daemon up — health :${healthPort}, /eleven autostart armed`);

const shutdown = async (why) => {
	log(`shutting down (${why})`);
	await runtime.close();
	// fail-closed verdict: the /eleven round must have gone LIVE (transcript
	// jsonl carries session_live) — a clean daemon boot alone is not a PASS.
	const transcript = existsSync(stateDir)
		? readdirSync(stateDir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => readFileSync(join(stateDir, f), "utf-8"))
				.join("\n")
		: "";
	const live = transcript.includes('"type":"session_live"');
	const meta = transcript.includes('"type":"metadata"');
	log(
		live && meta
			? "VERDICT: PASS — /eleven session went live (session_live + platform metadata in jsonl)"
			: `VERDICT: FAIL — no live /eleven session evidence in ${stateDir} (live=${live} metadata=${meta})`,
	);
	console.log("\n===== EVIDENCE =====");
	for (const l of evidence) console.log(l);
	process.exit(live && meta ? 0 : 1);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

const HOLD_MS = Number(process.env.STAGED_HOLD_MS ?? 45_000);
await new Promise((r) => setTimeout(r, HOLD_MS));
await shutdown("staged hold elapsed");
