// FLY-980 shim core — OpenAI-compatible /v1/chat/completions in front of a
// BrainAdapter (plan.md S1). Pure node http + injected brain factory so the V1
// contract tests run with zero external deps. The CLI entry (../shim.mjs) wires
// real brains (echo / anthropic api / HeadlessClaudeBrain) into this core.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";

// ---------------------------------------------------------------- adapter ---

/**
 * OpenAI chat messages → BrainAdapter turn shape (deterministic spec, Codex
 * R1#1): last user message = turn text; other user/assistant messages become
 * ordered history; system/developer messages are collected separately (they go
 * to the per-conversation identity file, never into history).
 */
export function mapMessages(messages) {
	const system = [];
	const convo = [];
	for (const m of messages ?? []) {
		if (!m || typeof m.role !== "string") continue;
		const text = contentToText(m.content);
		if (m.role === "system" || m.role === "developer") {
			if (text) system.push(text);
			continue;
		}
		if (m.role === "user" || m.role === "assistant") {
			convo.push({ role: m.role, text });
		}
	}
	let lastUserIdx = -1;
	for (let i = convo.length - 1; i >= 0; i--) {
		if (convo[i].role === "user") {
			lastUserIdx = i;
			break;
		}
	}
	const turnText = lastUserIdx >= 0 ? convo[lastUserIdx].text : "";
	const history = convo
		.filter((_, i) => i !== lastUserIdx)
		.map((t) => ({ role: t.role, text: t.text, ts: "" }));
	return { systemText: system.join("\n\n"), turnText, history };
}

function contentToText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((p) => p?.type === "text" && typeof p.text === "string")
			.map((p) => p.text)
			.join("");
	}
	return "";
}

/**
 * Conversation key — prefers identifiable per-conversation fields; falls back
 * to a documented single-active-session assumption (echo-tier evidence
 * confirms which fields the platform actually sends, R7).
 */
export function deriveConversationKey(body) {
	const extra = body?.elevenlabs_extra_body ?? {};
	const candidates = [
		extra.conversation_id,
		extra.session_id,
		body?.conversation_id,
		body?.user_id,
	];
	for (const c of candidates) {
		if (typeof c === "string" && c.length > 0) return c;
	}
	return "single-session";
}

// ------------------------------------------------------- identity + brains ---

/** Per-conversation persona file — makes per-session prompt override real E2E. */
export function writeIdentityFile(workDir, key, systemText) {
	mkdirSync(workDir, { recursive: true });
	const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
	const file = join(workDir, `identity-${hash}.md`);
	const content =
		systemText && systemText.trim().length > 0
			? systemText
			: "You are a helpful Flywheel voice assistant.";
	writeFileSync(file, content);
	return file;
}

/**
 * Brain instances bucketed by conversation key. resume=true keeps one stateful
 * brain per conversation (claude --resume path); resume=false builds a fresh
 * brain every request (full history re-injection is the honest condition).
 */
export class BrainSessions {
	constructor({ brainFactory, resume }) {
		this.brainFactory = brainFactory;
		this.resume = resume;
		this.byKey = new Map();
	}

	getBrain(key, identityFile) {
		if (!this.resume) {
			return this.brainFactory({ key, identityFile, useResume: false });
		}
		let brain = this.byKey.get(key);
		if (!brain) {
			brain = this.brainFactory({ key, identityFile, useResume: true });
			this.byKey.set(key, brain);
		}
		return brain;
	}
}

// ------------------------------------------------------------- cwd runner ---

/**
 * ProcessRunner wrapper pinning cwd (empty dir) for every claude -p spawn —
 * HeadlessClaudeBrainOptions has no cwd param (Codex R1#2), but voice-core's
 * spawn/run already accept {cwd}, so the seam is the injected runner.
 */
export class CwdProcessRunner {
	constructor(inner, cwd) {
		this.inner = inner;
		this.cwd = cwd;
	}

	run(cmd, args, opts = {}) {
		return this.inner.run(cmd, args, { ...opts, cwd: this.cwd });
	}

	spawn(cmd, args, opts = {}) {
		return this.inner.spawn(cmd, args, { ...opts, cwd: this.cwd });
	}
}

// ------------------------------------------------------------- tool calls ---

/**
 * V7a tool-call decision. Modes:
 *   - "off": never fire.
 *   - "force:<name>": fire the named tool once per request if the platform
 *     offered it (spike lever — verifies the platform-side round trip without
 *     needing brain-side tool intelligence).
 *   - "auto": language_detection heuristic — fire when the user text is
 *     dominantly Latin while the agent language is zh (and vice versa is left
 *     to the platform's own detection).
 * Returns {name, arguments} or null.
 */
export function maybeToolCall(tools, turnText, mode) {
	if (!mode || mode === "off") return null;
	if (!Array.isArray(tools) || tools.length === 0) return null;
	const names = tools
		.map((t) => t?.function?.name)
		.filter((n) => typeof n === "string");
	if (mode.startsWith("force:")) {
		const wanted = mode.slice("force:".length);
		if (!names.includes(wanted)) return null;
		const args =
			wanted === "language_detection"
				? { reason: "user switched language", language: guessLang(turnText) }
				: {};
		return { name: wanted, arguments: args };
	}
	if (mode === "auto" && names.includes("language_detection")) {
		const lang = guessLang(turnText);
		if (lang === "en") {
			return {
				name: "language_detection",
				arguments: { reason: "user speaking English", language: "en" },
			};
		}
	}
	return null;
}

function guessLang(text) {
	const cjk = (text.match(/[一-鿿]/g) ?? []).length;
	const latin = (text.match(/[a-zA-Z]/g) ?? []).length;
	return cjk >= latin / 4 ? "zh" : "en";
}

// ------------------------------------------------------------------ server ---

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * OpenAI-compatible shim server.
 * opts: { token, sessions, workDir, log, toolMode, injectFacts, modelName }
 *   log(event) — jsonl sink; caller owns the file. Events carry timing marks
 *   (t_req_arrival / t_first_delta / t_done / aborted) for the latency ladder.
 */
export function createShimServer(opts) {
	const {
		token,
		sessions,
		workDir,
		log = () => {},
		toolMode = "off",
		injectFacts = false,
		modelName = "flywheel-claude-brain",
	} = opts;

	return http.createServer((req, res) => {
		if (req.method === "GET" && req.url === "/health") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
			return;
		}
		if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "not found" } }));
			return;
		}
		const auth = req.headers.authorization ?? "";
		if (auth !== `Bearer ${token}`) {
			log({ type: "auth_reject" });
			res.writeHead(401, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "unauthorized" } }));
			return;
		}
		let raw = "";
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				res.writeHead(413);
				res.end();
				req.destroy();
				return;
			}
			raw += chunk;
		});
		req.on("end", () => {
			let body;
			try {
				body = JSON.parse(raw);
			} catch {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "bad json" } }));
				return;
			}
			handleCompletion(req, res, body).catch((err) => {
				log({ type: "handler_error", error: String(err?.message ?? err) });
				if (!res.headersSent) {
					res.writeHead(500, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: { message: "internal error" } }));
				} else {
					res.end();
				}
			});
		});
	});

	async function handleCompletion(_req, res, body) {
		const tReqArrival = Date.now();
		const requestId = `req-${tReqArrival}-${Math.floor(Math.random() * 1e6)}`;
		const key = deriveConversationKey(body);
		const { systemText, turnText, history } = mapMessages(body.messages);
		// full messages logged verbatim — R7 evidence of what the platform injects
		log({
			type: "req_arrival",
			requestId,
			key,
			t_req_arrival: tReqArrival,
			model: body.model,
			stream: body.stream,
			has_tools: Array.isArray(body.tools) ? body.tools.length : 0,
			elevenlabs_extra_body: body.elevenlabs_extra_body ?? null,
			user_id: body.user_id ?? null,
			messages: body.messages,
		});

		const streamId = `chatcmpl-${requestId}`;
		const created = Math.floor(tReqArrival / 1000);
		const chunkFrame = (delta, finish = null) =>
			`data: ${JSON.stringify({
				id: streamId,
				object: "chat.completion.chunk",
				created,
				model: body.model ?? modelName,
				choices: [{ index: 0, delta, finish_reason: finish }],
			})}\n\n`;

		// V7a: platform-offered tool → OpenAI function-call response
		const toolCall = maybeToolCall(body.tools, turnText, toolMode);
		if (toolCall) {
			log({ type: "tool_call", requestId, name: toolCall.name });
			res.writeHead(200, sseHeaders());
			res.write(chunkFrame({ role: "assistant" }));
			res.write(
				chunkFrame({
					tool_calls: [
						{
							index: 0,
							id: `call-${requestId}`,
							type: "function",
							function: {
								name: toolCall.name,
								arguments: JSON.stringify(toolCall.arguments),
							},
						},
					],
				}),
			);
			res.write(chunkFrame({}, "tool_calls"));
			res.write("data: [DONE]\n\n");
			res.end();
			return;
		}

		// V7b: shim-side data injection (mock issue_status digest)
		let finalTurnText = turnText;
		if (injectFacts && /status|状态|进展|issue/i.test(turnText)) {
			finalTurnText = `${MOCK_FACTS}\n\nFounder (voice): ${turnText}`;
			log({ type: "facts_injected", requestId });
		}

		const identityFile = writeIdentityFile(workDir, key, systemText);
		const brain = sessions.getBrain(key, identityFile);

		const ac = new AbortController();
		let finished = false;
		res.on("close", () => {
			if (!finished) {
				log({ type: "aborted", requestId, t: Date.now() - tReqArrival });
				ac.abort();
			}
		});

		let tFirstDelta = null;
		const pieces = [];
		const wantStream = body.stream !== false;
		if (wantStream) res.writeHead(200, sseHeaders());
		if (wantStream) res.write(chunkFrame({ role: "assistant" }));
		try {
			for await (const piece of brain.respond(
				{ text: finalTurnText, history },
				{ signal: ac.signal },
			)) {
				if (ac.signal.aborted) break;
				if (tFirstDelta === null) {
					tFirstDelta = Date.now();
					log({
						type: "first_delta",
						requestId,
						first_delta_ms: tFirstDelta - tReqArrival,
					});
				}
				if (wantStream) {
					res.write(chunkFrame({ content: piece }));
				} else {
					pieces.push(piece);
				}
			}
		} catch (err) {
			if (!ac.signal.aborted) {
				log({
					type: "brain_error",
					requestId,
					error: String(err?.message ?? err),
				});
				if (wantStream) {
					res.write(chunkFrame({ content: "(brain error)" }, "stop"));
					res.write("data: [DONE]\n\n");
				} else if (!res.headersSent) {
					res.writeHead(500, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: { message: "brain error" } }));
					finished = true;
					return;
				}
				finished = true;
				res.end();
				return;
			}
		}
		if (ac.signal.aborted) {
			finished = true;
			try {
				res.end();
			} catch {
				// client is gone
			}
			return;
		}
		const tDone = Date.now();
		log({
			type: "done",
			requestId,
			first_delta_ms: tFirstDelta === null ? null : tFirstDelta - tReqArrival,
			total_ms: tDone - tReqArrival,
		});
		finished = true;
		if (wantStream) {
			res.write(chunkFrame({}, "stop"));
			res.write("data: [DONE]\n\n");
			res.end();
		} else {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: streamId,
					object: "chat.completion",
					created,
					model: body.model ?? modelName,
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: pieces.join("") },
							finish_reason: "stop",
						},
					],
				}),
			);
		}
	}
}

function sseHeaders() {
	return {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache",
		connection: "keep-alive",
	};
}

const MOCK_FACTS = [
	'<injected-data source="mock issue_status">',
	"FLY-980 status: In Progress. PR not yet open. Latency spike running.",
	"Latest: shim contract tests green; real-machine E2E ladder is next.",
	"</injected-data>",
].join("\n");
