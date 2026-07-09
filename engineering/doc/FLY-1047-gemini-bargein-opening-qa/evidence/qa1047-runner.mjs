/**
 * FLY-1047 QA scratch runner — based on tracked e2e/gemini-staged.mjs @ 6c3ec409,
 * four deltas per the approved plan (engineering/doc/FLY-1047-gemini-bargein-opening-qa/plan.md P2.1):
 *   1. import points at the QA worktree's dist/cli.js (absolute path);
 *   2. allowUserIds = pool-06 (ears injection seam — the only new assembly point);
 *   3. hold = explicit quit-file poll (/tmp/fly1047-runner-quit) + bounded 12min cap;
 *   4. assistant block does NOT set bargeIn (under test: default ON).
 * Keeps the 9876 prod-port refusal guard + FLYWHEEL_BRIDGE_URL default :9877.
 */
import { existsSync } from "node:fs";
import { runVoiceBridge } from "/Users/xiaorongli/Dev/flywheel-FLY-1047-qa-target/packages/voice-bridge/dist/cli.js";

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
need("GEMINI_API_KEY");
need("FLYWHEEL_API_TOKEN");
process.env.FLYWHEEL_BRIDGE_URL ??= "http://127.0.0.1:9877";
if (/:9876(\/|$)/.test(process.env.FLYWHEEL_BRIDGE_URL)) {
	console.error(
		"refusing to run staged E2E against the production Bridge port (9876)",
	);
	process.exit(2);
}

const config = {
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
	allowUserIds: ["1523232391349403850"], // pool-06 probe — QA ears seam
	healthPort: Number(process.env.STAGED_HEALTH_PORT ?? 9879),
	ffmpegBin: process.env.FFMPEG_BIN ?? "ffmpeg",
};

const assistant = {
	commandName: process.env.STAGED_COMMAND_NAME ?? "gemini",
	voice: process.env.STAGED_VOICE ?? "Kore",
	assistantToken: null,
	briefing: {
		refreshSec: 600,
		maxAgeSec: 1800,
		charBudget: 8000,
		docs: [],
	},
	// NOTE: no `bargeIn` key on purpose — under test is the DEFAULT (ON).
	localBargeIn: false,
};

const log = (msg) => {
	console.log(`[${new Date().toISOString()}] ${msg}`);
};

process.env.FLYWHEEL_GEMINI_AUTOSTART ??= "FLY-1047 QA";

const runtime = await runVoiceBridge({ config, assistant, log });
log(
	`daemon up — health :${config.healthPort}, assistant=/${assistant.commandName}`,
);

// explicit-quit hold: poll quit file, bounded 12min (Gemini audio session ~15min cap)
const QUIT_FILE = "/tmp/fly1047-runner-quit";
const MAX_MS = Number(process.env.QA_MAX_HOLD_MS ?? 12 * 60 * 1000);
const t0 = Date.now();
while (Date.now() - t0 < MAX_MS) {
	if (existsSync(QUIT_FILE)) {
		log(`quit file seen after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
		break;
	}
	await new Promise((r) => setTimeout(r, 500));
}
log(`shutting down (session length ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
await runtime.close();
log("daemon closed");
process.exit(0);
