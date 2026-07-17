/**
 * FLY-967 staged E2E — "/gemini 真机能起一轮 + 会议简报出" (plan P9, QA-B1 ②).
 *
 * Follows the FLY-545 pr1-loop.mjs discipline: real bots, real daemon, real
 * Gemini, short-lived VC presence, evidence to stdout for the doc. Run it
 * with the staged env (see engineering/doc/FLY-967-gemini-live-assistant/
 * evidence/ once executed):
 *
 *   HUDDLE_ORCH_BOT_TOKEN=…   # orchestrator mouth (pool-06, or pool-05 rig)
 *   HUDDLE_EARS_BOT_TOKEN=…   # Note-taker (pool-04)
 *   FLYWHEEL_API_TOKEN=…      # Bridge bearer (TEAMLEAD_API_TOKEN value)
 *   GEMINI_API_KEY=…
 *   FLYWHEEL_GEMINI_AUTOSTART="staged E2E"   # QA seam: opens one round
 *   STAGED_GUILD_ID / STAGED_VC_ID           # 529-room / approved VC
 *   STAGED_PROJECT_NAME (default flywheel — needs a linear binding on the
 *                        Bridge side, see deploy checklist)
 *
 * The script starts the daemon, waits for the autostart round to open (issue
 * created + briefing-preambled conversation + opening prompt), captures the
 * evidence lines, then shuts down cleanly. It does NOT wait for a full
 * conversation — the round-opening chain IS the ② acceptance; the human
 * conversation round is the founder's A8 step.
 */
import { runVoiceBridge } from "../dist/cli.js";
import { buildStagedConfig } from "./lib/rig-config.mjs";

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
const geminiApiKey = need("GEMINI_API_KEY");
const apiToken = need("FLYWHEEL_API_TOKEN");
const orchestratorToken = need("HUDDLE_ORCH_BOT_TOKEN");
const earsToken = need("HUDDLE_EARS_BOT_TOKEN");
// isolation guard (Codex R7 HIGH): the wiring falls back to the PROD Bridge
// (127.0.0.1:9876) when FLYWHEEL_BRIDGE_URL is unset — a staged run must be
// pinned to the staged Bridge explicitly, and pointing it at the prod port
// is refused outright.
process.env.FLYWHEEL_BRIDGE_URL ??= "http://127.0.0.1:9877";
if (/:9876(\/|$)/.test(process.env.FLYWHEEL_BRIDGE_URL)) {
	console.error(
		"refusing to run staged E2E against the production Bridge port (9876) — start e2e/staged-bridge.mjs and point FLYWHEEL_BRIDGE_URL at it",
	);
	process.exit(2);
}

const config = buildStagedConfig({
	...process.env,
	STAGED_GUILD_ID: guildId,
	STAGED_VC_ID: voiceChannelId,
	GEMINI_API_KEY: geminiApiKey,
	FLYWHEEL_API_TOKEN: apiToken,
	HUDDLE_ORCH_BOT_TOKEN: orchestratorToken,
	HUDDLE_EARS_BOT_TOKEN: earsToken,
});

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
	localBargeIn: false,
};

const evidence = [];
const log = (msg) => {
	const line = `[${new Date().toISOString()}] ${msg}`;
	evidence.push(line);
	console.log(line);
};

process.env.FLYWHEEL_GEMINI_AUTOSTART ??= "staged E2E 冒烟";
// FLY-1353: a headless rig has no human in the VC. Override this to "0"
// for the required negative control, which must remain stalled in invoked.
process.env.FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE ??= "1";

const runtime = await runVoiceBridge({ config, assistant, log });
log(
	`daemon up — health :${config.healthPort}, assistant=/${assistant.commandName}`,
);

// give the autostart chain time to open the round (issue → VC → Gemini →
// opening prompt → first audio). Evidence is in the log lines above.
const HOLD_MS = Number(process.env.STAGED_HOLD_MS ?? 60_000);
await new Promise((r) => setTimeout(r, HOLD_MS));

log("staged hold elapsed — shutting down");
await runtime.close();
console.log("\n===== EVIDENCE =====");
for (const l of evidence) console.log(l);
