/**
 * QA · FLY-1065 — real Discord staged leg. Exercises the EXACT FLY-1065
 * production code against REAL services:
 *   real GEMINI_API_KEY → real GeminiLiveBackend turn aggregation (fed the
 *   probe's real synthesized speech) → real JsonlTranscriptSink on disk →
 *   real TivPresenter through the REAL discordWiring send/edit path
 *   (channel.send / channel.messages.edit on the staged VC text channel) →
 *   real captions + single-flight status posted to Discord → real
 *   AssistantLanding reading that SAME file → real Linear summary +
 *   verbatim-record comments on a real staged issue → close.
 *
 * The only thing NOT going through the VC mic is audio ingestion (EarsReceiver /
 * VC join) — FLY-967 territory, unchanged by FLY-1065; the audio is fed straight
 * into the real Gemini session exactly as the aggregation E2E does.
 *
 * Run (from repo root, with the 967 staged env sourced):
 *   set -a; source ~/.flywheel/qa-fly967-staged/.env.staged; set +a
 *   STAGED_VC_ID=1485787273193853170 \
 *     node packages/voice-bridge/e2e/fly1065-staged-discord.mjs
 *
 * Evidence: real Discord message ids + re-fetched content + Linear comment urls,
 * printed to stdout and written to FLY1065_STAGED_OUT (default /tmp).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LinearClient } from "@linear/sdk";
import { Client, GatewayIntentBits } from "discord.js";
import {
	createGenaiTransport,
	GeminiLiveBackend,
	JsonlTranscriptSink,
} from "../../voice-core/dist/index.js";
import { AssistantLanding } from "../dist/assistant/AssistantLanding.js";
import { TivPresenter } from "../dist/discord/TivPresenter.js";

const need = (k) => {
	const v = process.env[k];
	if (!v) {
		console.error(`missing env ${k}`);
		process.exit(2);
	}
	return v;
};

const orchToken = need("HUDDLE_ORCH_BOT_TOKEN");
const geminiKey = need("GEMINI_API_KEY");
const linearKey = need("LINEAR_API_KEY");
const channelId = need("STAGED_VC_ID");
const model =
	process.env.FLYWHEEL_VOICE_GEMINI_MODEL ?? "gemini-3.1-flash-live-preview";
const pcmPath = process.env.PROBE_PCM ?? "/tmp/fly1065-probe.pcm";
const stateDir =
	process.env.FLY1065_STAGED_STATE ?? "/tmp/fly1065-staged-state";
const outPath =
	process.env.FLY1065_STAGED_OUT ?? "/tmp/fly1065-staged-out.json";
const sessionId = `qa-fly1065-staged-${Date.now()}`;
const jsonlPath = join(stateDir, `${sessionId}.jsonl`);

const evidence = {
	sessionId,
	model,
	channelId,
	captions: [],
	statusMsgIds: [],
};

// ── real Discord client (orchestrator bot — the /gemini mouth) ───────────────
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildVoiceStates,
	],
});
await new Promise((res, rej) => {
	client.once("clientReady", res);
	client.once("error", rej);
	client.login(orchToken).catch(rej);
});
console.log(`[staged] discord bot ready: ${client.user.tag}`);
const channel = await client.channels.fetch(channelId);
console.log(`[staged] target channel: #${channel?.name ?? channelId}`);

// the REAL production send path (discordWiring.ts sendMessage/sendMessageForId/edit)
const sentCaptionIds = [];
const deps = {
	async send(text) {
		const m = await channel.send(text);
		sentCaptionIds.push(String(m.id));
		evidence.captions.push({ id: String(m.id), text });
	},
	async sendForId(text) {
		const m = await channel.send(text);
		evidence.statusMsgIds.push(String(m.id));
		return { messageId: String(m.id) };
	},
	async edit(messageId, text) {
		await channel.messages.edit(messageId, text);
	},
};
const tiv = new TivPresenter({ deps, statusThrottleMs: 1000 });

await channel.send(
	`—— QA·FLY-1065 staged 真机腿 · ${new Date().toISOString()} · session ${sessionId} ——`,
);
tiv.status("🎧 正在听…");

// ── real Gemini Live round (probe speech → real bidirectional transcripts) ───
const backend = new GeminiLiveBackend({
	transport: createGenaiTransport({ apiKey: geminiKey }),
	profile: { model, asyncFunctionCalling: false },
});
const brain = {
	async *respond() {
		yield "(staged brain — nothing to add)";
	},
};
const sink = new JsonlTranscriptSink(jsonlPath);
const session = await backend.createConversation({
	brain,
	transcriptSink: sink,
});
console.log(`[staged] gemini live connected (${model})`);

const quotes = [];
let recapText = "";
let responseDone = false;
session.on("transcript", (t) => {
	if (!t.final) return;
	tiv.caption(t.role, t.interrupted ? `${t.text} (被打断)` : t.text);
	if (t.role === "user") quotes.push({ ts: hhmmss(), text: t.text });
	else if (!t.interrupted) recapText += (recapText ? "\n" : "") + t.text;
	console.log(`[staged] FINAL ${t.role}: ${t.text}`);
});
session.on("response-started", () => tiv.status("💭 助理正在回答…"));
session.on("response-done", () => {
	responseDone = true;
});

const pcm = readFileSync(pcmPath);
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
console.log("[staged] audio committed — waiting for the round…");

const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
	if (quotes.length > 0 && recapText.length > 0 && responseDone) break;
	await new Promise((r) => setTimeout(r, 250));
}
await session.close();
tiv.status("🛬 正在落纪要…");
await new Promise((r) => setTimeout(r, 1500));

// ── real Linear landing (real staged issue → summary + verbatim comments) ────
const linear = new LinearClient({ apiKey: linearKey });
const teams = await linear.teams();
const team = teams.nodes.find((t) => t.key === "FLY") ?? teams.nodes[0];
const created = await linear.createIssue({
	teamId: team.id,
	title: `QA·FLY-1065 staged 逐字记录验证 · ${sessionId}`,
	description:
		"三段式 QA 的真机 Discord 腿自动创建;AssistantLanding 落纪要+逐字记录后自动关闭。",
});
const issue = await created.issue;
evidence.linearIssue = { id: issue.identifier, url: issue.url };
console.log(`[staged] staged issue: ${issue.identifier} ${issue.url}`);

const landingComments = [];
const landingLinear = {
	async comment(issueId, body) {
		const res = await linear.createComment({ issueId, body });
		const c = await res.comment;
		landingComments.push({ url: c?.url, head: body.split("\n").slice(0, 2) });
		return { url: c?.url };
	},
	async closeIssue(issueId) {
		const states = await team.states();
		// only a genuine `completed`-type state closes the issue — matching on
		// name alone could pick a non-terminal state and leave it open while
		// Landing reports success (Codex R1). Fail loudly if none exists.
		const done = states.nodes.find((s) => s.type === "completed");
		if (!done) {
			throw new Error(
				`no completed-type workflow state on team ${team.key}; cannot close ${issueId}`,
			);
		}
		await linear.updateIssue(issueId, { stateId: done.id });
	},
};
const landing = new AssistantLanding({
	linear: landingLinear,
	receiptPath: join(stateDir, `${sessionId}.landing-receipt.json`),
	transcriptPath: jsonlPath,
	commandName: "gemini",
	log: (l) => console.log(`[landing] ${l}`),
});
const result = await landing.run({
	issueId: issue.id,
	sessionId,
	recapText,
	quotes,
	confirmed: true,
});
evidence.landing = { result, comments: landingComments };
console.log(`[staged] landing result: ${JSON.stringify(result)}`);

// ── re-fetch the captions from Discord to PROVE they really landed ───────────
const refetched = [];
for (const id of sentCaptionIds) {
	try {
		const m = await channel.messages.fetch(id);
		refetched.push({ id, content: m.content });
	} catch (e) {
		refetched.push({ id, error: String(e?.message ?? e) });
	}
}
evidence.refetchedCaptions = refetched;

evidence.jsonl = readFileSync(jsonlPath, "utf8").trim().split("\n");
writeFileSync(outPath, JSON.stringify(evidence, null, 2));
console.log(`\n[staged] evidence → ${outPath}`);

// pass/fail gate — this harness must FAIL LOUDLY, never exit 0 on a bad round
// (Gemini timeout, caption re-fetch miss, no landing, empty JSONL). A green
// exit here is a real claim (Codex R1).
const refetchedOk = refetched.filter((r) => r.content).length;
const capText = evidence.captions.map((c) => c.text);
const hasUserCap = capText.some((t) => t.startsWith("🗣️"));
const hasAssistantCap = capText.some((t) => t.startsWith("💬"));
const checks = [
	// both sides shown, not just ≥2 of one role (Codex R2) — Annie's who-said-what
	["a user caption (🗣️) was posted", hasUserCap],
	["an assistant caption (💬) was posted", hasAssistantCap],
	[
		"all captions re-fetched from Discord",
		refetchedOk === sentCaptionIds.length && refetchedOk === capText.length,
	],
	// exactly one status anchor — 0 (send failed) or >1 (self-healed a 2nd) both
	// mean the single-flight no-spam invariant broke (Codex R2).
	["exactly one status anchor (no spam)", evidence.statusMsgIds.length === 1],
	["landing ok", result.ok === true],
	["≥2 landing comments (summary + verbatim)", landingComments.length >= 2],
	["JSONL sink non-empty", evidence.jsonl.filter((l) => l.trim()).length >= 2],
];
let failed = 0;
for (const [name, ok] of checks) {
	console.log(`${ok ? "✅" : "❌"} ${name}`);
	if (!ok) failed++;
}
console.log(
	`[staged] captions posted: ${evidence.captions.length}, re-fetched OK: ${refetchedOk}, landing comments: ${landingComments.length}`,
);

await client.destroy();
process.exit(failed === 0 ? 0 : 1);

function hhmmss() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
