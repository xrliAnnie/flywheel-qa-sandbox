/**
 * FLY-1006 P6 — persistent LIVE /eleven venue for Annie's terminal verification.
 * NOT a QA harness: no autostart (Annie triggers /eleven herself), no timed
 * shutdown. Points at the real guild+VC Annie is in, the alive shim/tunnel rig,
 * and the cue-fixed build. Stays up until killed.
 *
 * env: HUDDLE_ORCH_BOT_TOKEN HUDDLE_EARS_BOT_TOKEN ELEVENLABS_API_KEY
 *      P6_GUILD_ID P6_VC_ID ELEVENLABS_AGENT_ID [P6_HEALTH_PORT] [P6_CUE]
 */
import { runVoiceBridge } from "../dist/cli.js";

const need = (k) => {
	const v = process.env[k];
	if (!v) {
		console.error(`missing env ${k}`);
		process.exit(2);
	}
	return v;
};

const guildId = need("P6_GUILD_ID");
const voiceChannelId = need("P6_VC_ID");
const agentId = need("ELEVENLABS_AGENT_ID");
need("ELEVENLABS_API_KEY");
need("HUDDLE_ORCH_BOT_TOKEN");
need("HUDDLE_EARS_BOT_TOKEN");

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

// explicitly DO NOT set FLYWHEEL_ELEVEN_AUTOSTART — Annie invokes /eleven.
delete process.env.FLYWHEEL_ELEVEN_AUTOSTART;

const runtime = await runVoiceBridge({
	config: {
		projectName: "flywheel",
		projectRoot: process.cwd(),
		guildId,
		voiceChannelId,
		commandName: "meet",
		moveMembers: false,
		orchestratorToken: process.env.HUDDLE_ORCH_BOT_TOKEN,
		earsToken: process.env.HUDDLE_EARS_BOT_TOKEN,
		leads: [],
		backchannelMs: 350,
		// Annie is a human → EarsReceiver.isHuman admits her automatically; no
		// allowUserIds needed (that seam is only for non-human QA injectors).
		allowUserIds: [],
		healthPort: Number(process.env.P6_HEALTH_PORT ?? 9885),
		ffmpegBin: process.env.FFMPEG_BIN ?? "ffmpeg",
	},
	assistant: null,
	eleven: {
		commandName: "eleven",
		agentId,
		apiKeyEnv: "ELEVENLABS_API_KEY",
		shimHealthUrl:
			process.env.ELEVEN_SHIM_HEALTH_URL ?? "http://127.0.0.1:8980/health",
		// per-session voice override; unset → the agent's baked-in default.
		// P6: Jason (Chinese-native) per Annie's ① candidate, not Eric.
		voiceId: process.env.P6_VOICE || undefined,
		// the cue-fixed behavior Annie's ② feedback was about — a soft
		// placeholder "processing" tone (formal clip is follow-up).
		waitingCuePath: process.env.P6_CUE,
	},
	log,
});
log(
	`P6 live venue UP — guild ${guildId} VC ${voiceChannelId}, /eleven registered, note-taker resident. Annie: join the VC → /eleven → talk.`,
);

// keep the process alive; a SIGTERM tears the venue down cleanly.
const bye = async (sig) => {
	log(`received ${sig} — closing venue`);
	await runtime.close();
	process.exit(0);
};
process.on("SIGTERM", () => void bye("SIGTERM"));
process.on("SIGINT", () => void bye("SIGINT"));
