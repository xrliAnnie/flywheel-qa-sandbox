// FLY-980 shim CLI — OpenAI-compatible endpoint wrapping the Flywheel Claude
// brain for ElevenLabs Custom LLM (plan.md S1).
//
// usage: node shim.mjs [port]
// env:
//   FLY980_BRAIN=echo|api|claude   brain tier (default echo)
//   FLY980_MODEL=haiku|sonnet|opus model tier (default haiku)
//   FLY980_RESUME=0|1              claude tier: 0 = fresh instance + full
//                                  history re-injection each turn; 1 =
//                                  per-conversation --resume (default 1)
//   FLY980_TOOL_MODE=off|auto|force:<name>   V7a tool-call lever (default off)
//   FLY980_INJECT_FACTS=1          V7b mock issue_status injection
//   FLY980_SLEEP_MS=<n>            V5b artificial slow-brain delay before reply
//   FLY980_CLAUDE_BIN=<path>       claude binary (default ~/.local/bin/claude)
//   FLY980_TOKEN=<token>           fixed bearer token (default: random,
//                                  printed once to stdout, never written)
//   ANTHROPIC_API_KEY              api tier only (via ~/.flywheel/.env)
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadFlywheelEnv } from "./lib/env.mjs";
import {
	BrainSessions,
	CwdProcessRunner,
	createShimServer,
	dedupeFinalEcho,
} from "./lib/shim-core.mjs";

loadFlywheelEnv();

const PORT = Number(process.argv[2] ?? process.env.FLY980_PORT ?? 8980);
const BRAIN = process.env.FLY980_BRAIN ?? "echo";
const MODEL = process.env.FLY980_MODEL ?? "haiku";
const RESUME = process.env.FLY980_RESUME !== "0";
const TOOL_MODE = process.env.FLY980_TOOL_MODE ?? "off";
const INJECT_FACTS = process.env.FLY980_INJECT_FACTS === "1";
const SLEEP_MS = Number(process.env.FLY980_SLEEP_MS ?? 0);
const CLAUDE_BIN =
	process.env.FLY980_CLAUDE_BIN ?? join(homedir(), ".local/bin/claude");

const workRoot = join(homedir(), "fly980-eleven");
const workDir = join(workRoot, "identities");
const emptyCwd = join(workRoot, "cwd-empty");
mkdirSync(workDir, { recursive: true });
mkdirSync(emptyCwd, { recursive: true });
mkdirSync("out", { recursive: true });

const logFile = `out/shim-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
const log = (e) => {
	appendFileSync(logFile, `${JSON.stringify({ ts: Date.now(), ...e })}\n`);
};

// ------------------------------------------------------------------ brains ---

const API_MODELS = {
	haiku: "claude-haiku-4-5-20251001",
	sonnet: "claude-sonnet-5",
	opus: "claude-opus-4-8",
};

const VOICE_CONTEXT = [
	"You are speaking with the founder over a VOICE channel.",
	"Answer in short, spoken, conversational sentences. No markdown, no code blocks, no bullet lists.",
	"You have NO tools and can execute nothing — do not output code blocks pretending to run commands.",
	"If asked to approve / ship / merge / deploy / restart / delete anything, you may DISCUSS it, but",
	"make clear you cannot perform actions here — real actions happen through the normal Lead + approval",
	"flow, not this voice session.",
].join(" ");

function withSleep(brain) {
	if (!SLEEP_MS) return brain;
	return {
		async *respond(turn, opts) {
			await new Promise((r) => setTimeout(r, SLEEP_MS));
			if (opts.signal.aborted) return;
			yield* brain.respond(turn, opts);
		},
	};
}

function makeEchoBrain() {
	return {
		async *respond(turn, { signal }) {
			const zh = /[一-鿿]/.test(turn.text);
			const text = zh
				? "收到，我在，这是回声测试。链路正常，你说的我都听到了。"
				: "Copy that, this is the echo test. The pipeline works and I heard you clearly.";
			for (let i = 0; i < text.length; i += 6) {
				if (signal.aborted) return;
				yield text.slice(i, i + 6);
			}
		},
	};
}

async function makeApiBrainFactory() {
	if (!process.env.ANTHROPIC_API_KEY) {
		console.error(
			"FLY980_BRAIN=api needs ANTHROPIC_API_KEY (~/.flywheel/.env)",
		);
		process.exit(2);
	}
	const { default: Anthropic } = await import("@anthropic-ai/sdk");
	const client = new Anthropic();
	const model = API_MODELS[MODEL] ?? MODEL;
	return ({ identityFile }) => ({
		async *respond(turn, { signal }) {
			const persona = readFileSync(identityFile, "utf8");
			const messages = [];
			for (const t of turn.history) {
				const role = t.role === "assistant" ? "assistant" : "user";
				const last = messages.at(-1);
				if (last && last.role === role) {
					last.content += `\n${t.text}`;
				} else {
					messages.push({ role, content: t.text });
				}
			}
			if (messages.at(-1)?.role === "user") {
				messages.at(-1).content += `\n${turn.text}`;
			} else {
				messages.push({ role: "user", content: turn.text });
			}
			const stream = client.messages.stream(
				{
					model,
					max_tokens: 1024,
					system: `${persona}\n\n${VOICE_CONTEXT}`,
					messages,
				},
				{ signal },
			);
			for await (const ev of stream) {
				if (
					ev.type === "content_block_delta" &&
					ev.delta?.type === "text_delta"
				) {
					yield ev.delta.text;
				}
			}
		},
	});
}

async function makeClaudeBrainFactory() {
	const { HeadlessClaudeBrain, NodeProcessRunner } = await import(
		"../../../packages/voice-core/dist/index.js"
	);
	// empty-cwd via the injected ProcessRunner seam — no voice-core changes (D8')
	const runner = new CwdProcessRunner(new NodeProcessRunner(), emptyCwd);
	return ({ identityFile, useResume }) =>
		new HeadlessClaudeBrain({
			claudeBin: CLAUDE_BIN,
			identityFile,
			voiceContext: VOICE_CONTEXT,
			runner,
			useResume,
			extraArgs: ["--model", MODEL],
			timeoutMs: 180_000,
		});
}

const brainFactory =
	BRAIN === "claude"
		? await makeClaudeBrainFactory()
		: BRAIN === "api"
			? await makeApiBrainFactory()
			: () => makeEchoBrain();

const sessions = new BrainSessions({
	brainFactory: (info) => withSleep(dedupeFinalEcho(brainFactory(info))),
	resume: RESUME,
});

const token = process.env.FLY980_TOKEN ?? randomBytes(24).toString("hex");
const server = createShimServer({
	token,
	sessions,
	workDir,
	log,
	toolMode: TOOL_MODE,
	injectFacts: INJECT_FACTS,
});
server.listen(PORT, () => {
	// token printed ONCE to stdout (never written to disk / evidence)
	console.log(`[fly980-shim] listening on http://localhost:${PORT}`);
	console.log(`[fly980-shim] bearer token: ${token}`);
	console.log(
		`[fly980-shim] brain=${BRAIN} model=${MODEL} resume=${RESUME ? 1 : 0} toolMode=${TOOL_MODE} injectFacts=${INJECT_FACTS ? 1 : 0} sleepMs=${SLEEP_MS}`,
	);
	console.log(`[fly980-shim] log=${logFile}`);
});
