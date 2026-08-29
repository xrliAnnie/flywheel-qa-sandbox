/**
 * FLY-1065 real-Gemini E2E — turn aggregation against the PRODUCTION Live
 * model, through the REAL GeminiLiveBackend (not the raw SDK): the C1 flush
 * chain must produce exactly one turn-level final per side, the user final
 * must NOT wait ~10s for turnComplete, and the JSONL sink must hold the
 * aggregated rows.
 *
 * Follows the mini-spike harness form (evidence/finished-flag-probe.md); the
 * spoken input is the probe's synthesized Chinese sentence (16kHz mono s16le
 * PCM). Run:
 *
 *   GEMINI_API_KEY=…  node e2e/fly1065-live-aggregation.mjs
 *   PROBE_PCM=…       # default /tmp/fly1065-probe.pcm
 *   FLYWHEEL_VOICE_GEMINI_MODEL=…  # default gemini-3.1-flash-live-preview
 *
 * Output: assertion table on stdout + raw event timeline JSON at
 * FLY1065_E2E_OUT (default /tmp/fly1065-aggregation-e2e.json). Exit 0 = all
 * assertions hold.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createGenaiTransport,
	GeminiLiveBackend,
	JsonlTranscriptSink,
} from "../dist/index.js";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
	console.error("missing env GEMINI_API_KEY");
	process.exit(2);
}
const model =
	process.env.FLYWHEEL_VOICE_GEMINI_MODEL ?? "gemini-3.1-flash-live-preview";
const pcmPath = process.env.PROBE_PCM ?? "/tmp/fly1065-probe.pcm";
const outPath =
	process.env.FLY1065_E2E_OUT ?? "/tmp/fly1065-aggregation-e2e.json";

const pcm = readFileSync(pcmPath);
const sinkPath = join(tmpdir(), `fly1065-e2e-${Date.now()}.jsonl`);

const backend = new GeminiLiveBackend({
	transport: createGenaiTransport({ apiKey }),
	profile: { model, asyncFunctionCalling: false },
});
const brain = {
	// the model may or may not call ask_lead for this prompt — answer inertly.
	async *respond() {
		yield "(e2e brain — nothing to add)";
	},
};

const t0 = Date.now();
const timeline = [];
const mark = (type, extra = {}) => {
	timeline.push({ atMs: Date.now() - t0, type, ...extra });
};

const session = await backend.createConversation({
	brain,
	transcriptSink: new JsonlTranscriptSink(sinkPath),
});
mark("connected", { model });

let responseDoneAt = null;
session.on("transcript", (t) => {
	mark(t.final ? "final" : "fragment", {
		role: t.role,
		text: t.text,
		...(t.interrupted ? { interrupted: true } : {}),
	});
});
session.on("response-started", () => mark("response-started"));
session.on("response-audio", () => {
	// counted, not stored — audio bytes are irrelevant to the aggregation chain
	const last = timeline[timeline.length - 1];
	if (last?.type === "response-audio") last.count++;
	else
		timeline.push({ atMs: Date.now() - t0, type: "response-audio", count: 1 });
});
session.on("response-done", () => {
	responseDoneAt = Date.now() - t0;
	mark("response-done");
});
session.on("error", (e) => mark("error", { message: e.message }));

// stream the founder's sentence at realtime pacing (20ms frames), then commit
// the turn the way the voice-bridge does (Discord gives no trailing silence).
const FRAME = 640; // 20ms @16kHz mono s16le
for (let off = 0; off < pcm.length; off += FRAME) {
	session.sendAudio(pcm.subarray(off, off + FRAME), {
		encoding: "pcm16",
		sampleRateHz: 16_000,
		channels: 1,
	});
	await new Promise((r) => setTimeout(r, 20));
}
session.endUserTurn();
mark("audio-committed");

// wait for the full round: user final + assistant final + response-done.
const deadline = Date.now() + 60_000;
const finals = () => timeline.filter((e) => e.type === "final");
while (Date.now() < deadline) {
	const f = finals();
	if (
		f.some((e) => e.role === "user") &&
		f.some((e) => e.role === "assistant") &&
		responseDoneAt !== null
	) {
		break;
	}
	await new Promise((r) => setTimeout(r, 200));
}
await session.close();
mark("closed");

// ---- assertions ----
const f = finals();
const userFinals = f.filter((e) => e.role === "user");
const assistantFinals = f.filter((e) => e.role === "assistant");
const assistantFragments = timeline.filter(
	(e) => e.type === "fragment" && e.role === "assistant",
);
let sinkRows = [];
try {
	sinkRows = readFileSync(sinkPath, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
} catch {
	// no finals ever flushed → the sink file was never created; the assertion
	// table below reports the failure with the timeline as evidence.
}

const checks = [
	[
		"exactly ONE user final (turn aggregate, no per-fragment finals)",
		userFinals.length === 1,
	],
	[
		"exactly ONE assistant final (multi-signal never double-emits)",
		assistantFinals.length === 1,
	],
	[
		"user final text is the aggregated sentence (not a fragment)",
		(userFinals[0]?.text?.length ?? 0) >= 10,
	],
	[
		"assistant final = concatenation of its fragments",
		assistantFinals[0]?.text === assistantFragments.map((e) => e.text).join(""),
	],
	[
		"user final arrives BEFORE the assistant final (she flushes on first model output)",
		userFinals[0]?.atMs < assistantFinals[0]?.atMs,
	],
	[
		"assistant final arrives BEFORE response-done (generation-complete flush, not the ~10s turnComplete wait)",
		assistantFinals[0]?.atMs < responseDoneAt,
	],
	[
		"JSONL sink holds exactly the two aggregated rows (final:true)",
		sinkRows.length === 2 && sinkRows.every((r) => r.final === true),
	],
	[
		"sink rows carry both roles with the aggregated texts",
		sinkRows.some((r) => r.role === "user" && r.text === userFinals[0]?.text) &&
			sinkRows.some(
				(r) => r.role === "assistant" && r.text === assistantFinals[0]?.text,
			),
	],
];

const evidence = {
	model,
	sinkPath,
	responseDoneAt,
	assistantFinalAt: assistantFinals[0]?.atMs ?? null,
	userFinalAt: userFinals[0]?.atMs ?? null,
	assistantFinalLeadOverTurnCompleteMs:
		responseDoneAt !== null && assistantFinals[0]
			? responseDoneAt - assistantFinals[0].atMs
			: null,
	checks: checks.map(([name, ok]) => ({ name, ok })),
	timeline,
};
writeFileSync(outPath, JSON.stringify(evidence, null, 2));

let failed = 0;
for (const [name, ok] of checks) {
	console.log(`${ok ? "✅" : "❌"} ${name}`);
	if (!ok) failed++;
}
console.log(
	`\nuser final @${evidence.userFinalAt}ms · assistant final @${evidence.assistantFinalAt}ms · response-done @${responseDoneAt}ms (caption lead over turn-complete: ${evidence.assistantFinalLeadOverTurnCompleteMs}ms)`,
);
console.log(`evidence: ${outPath}\nsink: ${sinkPath}`);
process.exit(failed === 0 ? 0 : 1);
