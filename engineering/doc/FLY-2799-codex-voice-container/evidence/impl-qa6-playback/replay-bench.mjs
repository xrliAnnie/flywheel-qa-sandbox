// FLY-2799 qa6 rework: replay the founder session's recorded upstream timing
// (every assistant audio delta and final, session 3cedfff5) through the real
// CodexVoiceBackend into a real WaitingMouth, with a player stand-in taking
// one frame per real 20ms slot and reporting playbackDuration like a
// discord.js AudioResource. No network. Items are replayed back to back with
// a 1.5s gap, each keeping its own recorded delta/final offsets.
// Usage: node replay-bench.mjs <outJson> [stallMs]
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WT = "/Users/xiaorongli/Dev/flywheel-FLY-2799";
const { CodexVoiceBackend } = await import(`${WT}/packages/voice-codex/dist/codex/CodexVoiceBackend.js`);
const { WaitingMouth } = await import(`${WT}/packages/voice-codex/dist/audio.js`);
const EV = join(homedir(), ".flywheel/artifacts/FLY-2799-qa/qa6-slot2-founder-live");
const [, , outJson, stallArg = "0"] = process.argv;
const STALL_MS = Number(stallArg); // periodic synthetic event-loop stall

const rows = readFileSync(join(EV, "meeting-1790360785452/voice-evidence/events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const finals = readFileSync(join(EV, "session/codex-transcript.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.role === "assistant");
const items = new Map();
for (const r of rows) {
	if (r.kind !== "codex_output_audio_frame") continue;
	const at = Date.parse(r.ts);
	const item = items.get(r.itemId) ?? { itemId: r.itemId, deltas: [] };
	item.deltas.push({ at, bytes: r.pcmBytes });
	items.set(r.itemId, item);
}
for (const f of finals) {
	const itemId = f.transcriptId.split(":")[2];
	const item = items.get(itemId);
	if (item && item.finalAt === undefined) item.finalAt = Date.parse(f.ts);
}
const plan = [...items.values()].filter((i) => i.finalAt !== undefined).sort((a, b) => a.deltas[0].at - b.deltas[0].at);

const t0 = performance.now();
const ms = () => performance.now() - t0;
const resources = [];
let current;
const heard = [];
const createResource = (source) => {
	const resource = { frames: [], playbackDuration: 0 };
	source.stream.on("data", (frame) => resource.frames.push(frame));
	resources.push(resource);
	return resource;
};
const player = { play: (r) => { current = r; }, stop: () => { current = undefined; } };
// @discordjs/voice 0.19.2 audioCycleStep: nextTime += 20 each cycle and the
// next cycle is setTimeout(max(1, nextTime - now)), so after a stall the
// player catches up the missed slots back to back.
let nextTime = Date.now();
const cycle = () => {
	nextTime += 20;
	const r = current;
	if (r) {
		const frame = r.frames[r.playbackDuration / 20];
		if (frame) r.playbackDuration += 20;
		heard.push({ t: ms(), speech: Boolean(frame) && frame.readInt16LE(0) !== 0, missing: !frame });
	}
	setTimeout(cycle, Math.max(1, nextTime - Date.now()));
};
setImmediate(cycle);
if (STALL_MS > 0) {
	// Block the event loop every 1.4s, as measured in the room.
	setInterval(() => {
		const until = performance.now() + STALL_MS;
		while (performance.now() < until) {}
	}, 1_400);
}
const diagnostics = [];
const LEAD = process.env.LEAD ? Number(process.env.LEAD) : undefined; // control: frames kept queued
const mouth = new WaitingMouth({
	player,
	createResource,
	onDiagnostic: (d) => diagnostics.push({ t: ms(), ...d }),
	...(LEAD === undefined ? {} : { speechLeadFrames: LEAD, idleLeadFrames: LEAD }),
});
mouth.start();

let callbacks;
const started = new Map();
const backend = new CodexVoiceBackend({
	sessionId: "replay-3cedfff5",
	voice: "marin",
	container: {
		open: async (input) => {
			callbacks = input.realtime;
			return {
				generation: 1,
				transport: { appendAudio: () => "sent", appendSpeech: async () => undefined, appendText: async () => undefined, cancel: async () => undefined },
				close: async () => undefined,
			};
		},
	},
	loadContext: async () => ({}),
	openAudio: ({ itemId }) => {
		const output = mouth.openSpeech(itemId);
		output.done.then(() => { started.get(itemId).doneAt = ms(); }, () => undefined);
		return output;
	},
	onEvidence: () => undefined,
});
const conversation = await backend.createConversation({ brain: { async *respond() {} } });
const errors = [];
conversation.on("error", (e) => errors.push(String(e?.message ?? e)));

const sleepUntil = (t) => new Promise((r) => setTimeout(r, Math.max(0, t - ms())));
let base = ms() + 500;
for (const item of plan) {
	const first = item.deltas[0].at;
	const events = [
		...item.deltas.map((d) => ({ at: d.at - first, kind: "audio", bytes: d.bytes })),
		{ at: item.finalAt - first, kind: "final" },
	].sort((a, b) => a.at - b.at);
	const record = { itemId: item.itemId, audioMs: item.deltas.reduce((s, d) => s + d.bytes, 0) / 48, upstreamSpanMs: item.deltas.at(-1).at - first, finalAfterFirstDeltaMs: item.finalAt - first };
	started.set(item.itemId, record);
	callbacks.onItem({ generation: 1, itemId: item.itemId, role: "assistant", raw: {} });
	for (const e of events) {
		await sleepUntil(base + e.at);
		if (e.kind === "audio") {
			if (record.firstDeltaAt === undefined) record.firstDeltaAt = ms();
			const pcm = Buffer.alloc(e.bytes);
			for (let o = 0; o < pcm.length; o += 2) pcm.writeInt16LE(1_000, o);
			callbacks.onAudio({ generation: 1, itemId: item.itemId, pcm24Mono: pcm, sampleRate: 24_000, numChannels: 1, samplesPerChannel: e.bytes / 2, raw: {} });
		} else {
			callbacks.onTranscript({ generation: 1, itemId: item.itemId, association: "preceding_item", role: "assistant", text: item.itemId, final: true, raw: {} });
		}
	}
	// wait for this item to finish playing, then a short pause
	while (record.doneAt === undefined && ms() - base < 60_000) await sleepUntil(ms() + 50);
	await sleepUntil(ms() + Math.ceil(item.deltas.reduce((s, d) => s + d.bytes, 0) / 48) + 1_500);
	base = ms();
}

// First speech frame heard after each item's first delta.
const results = [...started.values()].map((r) => {
	const firstHeard = heard.find((h) => h.t >= r.firstDeltaAt && h.speech);
	return {
		itemId: r.itemId,
		audioMs: Math.round(r.audioMs),
		wholeItemWaitMs: Math.round(r.finalAfterFirstDeltaMs),
		streamedStartMs: firstHeard ? Math.round(firstHeard.t - r.firstDeltaAt) : null,
	};
});
// A missing slot whose nearest heard neighbours on both sides are speech is a
// break inside an answer.
let gaps = 0;
for (let i = 0; i < heard.length; i += 1) {
	if (!heard[i].missing) continue;
	let before = i - 1;
	while (before >= 0 && heard[before].missing) before -= 1;
	let after = i + 1;
	while (after < heard.length && heard[after].missing) after += 1;
	if (before >= 0 && after < heard.length && heard[before].speech && heard[after].speech) gaps += 1;
}
const summary = {
	stallMs: STALL_MS,
	lead: LEAD ?? "default",
	items: results.length,
	errors,
	underruns: diagnostics.filter((d) => d.kind === "playback_underrun").length,
	missingSlotsInsideSpeech: gaps,
	speechFramesHeard: heard.filter((h) => h.speech).length,
	expectedSpeechFrames: Math.round(results.reduce((s, r) => s + r.audioMs, 0) / 20),
	results,
};
writeFileSync(outJson, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
await conversation.close();
mouth.stop();
process.exit(0);
