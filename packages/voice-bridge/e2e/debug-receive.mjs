// FLY-545 debug probe: why does the ears connection see no speaking events?
// Joins both bots, hooks raw voice-ws packets (op5 Speaking), subscribes the
// speaker's opus stream DIRECTLY (not waiting for speaking events), plays a
// clip, and counts what arrives at each layer.
import { BotRegistry, createDiscordDeps, LeadSpeaker } from "../dist/index.js";

const [, , clip] = process.argv;
const {
	FLY545_EARS_TOKEN,
	FLY545_SPEAKER_TOKEN,
	FLY545_GUILD_ID,
	FLY545_CHANNEL_ID,
	FLY545_SPEAKER_BOT_ID,
} = process.env;

const deps = await createDiscordDeps();
const registry = new BotRegistry({
	createClient: deps.createClient,
	joinVoice: deps.joinVoice,
});
await registry.start([
	{ id: "ears", token: FLY545_EARS_TOKEN },
	{ id: "speaker", token: FLY545_SPEAKER_TOKEN },
]);
console.error("bots online");
const earsConn = await registry.join("ears", {
	guildId: FLY545_GUILD_ID,
	channelId: FLY545_CHANNEL_ID,
	selfMute: true,
	selfDeaf: false,
});
const spkConn = await registry.join("speaker", {
	guildId: FLY545_GUILD_ID,
	channelId: FLY545_CHANNEL_ID,
	selfMute: false,
	selfDeaf: true,
});
console.error("joined");

let op5 = 0;
let wsHooked = false;
const hookWs = () => {
	const ws = earsConn?.state?.networking?.state?.ws;
	if (!ws || wsHooked) return;
	wsHooked = true;
	ws.on("packet", (p) => {
		if (p?.op === 5) {
			op5++;
			console.error("op5 speaking packet:", JSON.stringify(p.d));
		}
	});
	console.error("ws hooked");
};
setInterval(hookWs, 300).unref();
hookWs();

earsConn.receiver.speaking.on("start", (u) =>
	console.error("SPEAKING-START", u),
);
earsConn.receiver.speaking.on("end", (u) => console.error("SPEAKING-END", u));

// direct subscribe, don't wait for speaking events
let opusPackets = 0;
let pcmBytes = 0;
const opus = deps.subscribeManual(earsConn)(FLY545_SPEAKER_BOT_ID);
const decoder = deps.createDecoder();
opus.on("data", () => opusPackets++);
opus.pipe(decoder);
decoder.on("data", (d) => {
	pcmBytes += d.length;
});
decoder.on("error", (e) => console.error("decoder error:", e.message));
opus.on("error", (e) => console.error("opus error:", e.message));

console.error(
	"ears networking state:",
	earsConn.state?.status,
	"| speaker:",
	spkConn.state?.status,
);

const speaker = new LeadSpeaker({
	player: deps.createPlayer(spkConn),
	createResource: deps.createResource,
});
const r = await speaker.speak({ kind: "file", path: clip });
console.error("playback done", JSON.stringify(r));
await new Promise((res) => setTimeout(res, 2000));
console.log(
	JSON.stringify({
		op5,
		opusPackets,
		pcmBytes,
		speakingUsers: [...earsConn.receiver.speaking.users.keys()],
	}),
);
await registry.destroyAll();
process.exit(0);
