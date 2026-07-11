// FLY-1006 S2 — M1 talk-page server (127.0.0.1-only, key server-side).
//
// Routes:
//   GET  /                      → talk.html
//   GET  /api/signed-url?lead=X → get-signed-url REST (xi-api-key stays in
//                                 this process) → {signedUrl, lead:{voiceId,
//                                 prompt, firstMessage, ...}} — voiceId +
//                                 persona prompt are non-secret and travel to
//                                 the page so it can build startSession
//                                 overrides (plan.md §S2 / Codex R1#4).
//   POST /api/log               → append page rough-timestamp events to
//                                 ~/fly1006-eleven/talk-events.jsonl (S3.3)
//
// usage: FLY1006_AGENT_ID=<agent_id> node serve.mjs   [FLY1006_PORT=8988]
// env: ELEVENLABS_API_KEY via ~/.flywheel/.env (never argv, never logged)
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireApiKey } from "../FLY-980-eleven/lib/eleven.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// 3-Lead 表（声线 = FLY-980 v9-voices.md 终选;persona = personas/*.md 入库文件）
export const LEADS = {
	tadashi: {
		name: "Tadashi",
		voiceName: "Eric",
		voiceId: "cjVigY5qzO86Huf0OWal",
		personaFile: "personas/tadashi.md",
		firstMessage: "嗨，我是 Tadashi。链路通了，想聊什么都行。",
	},
	cass: {
		name: "Aunt Cass",
		voiceName: "Sarah",
		voiceId: "EXAVITQu4vr4xnSDxMaL",
		personaFile: "personas/cass.md",
		firstMessage: "你好呀，我是 Cass。今天想聊点什么？",
	},
	belle: {
		name: "Belle",
		voiceName: "Alice",
		voiceId: "Xb7hH8MSUJpSbSDYk0k2",
		personaFile: "personas/belle.md",
		firstMessage: "嗨嗨，我是 Belle！我在听～",
	},
	// Annie M1 反馈①(Eric 中文带怪口音)的备选,「中文口音干净度」对比:
	// 中文原生声线(shared library 入库,Lead 批的 3 坑,可逆)优先;George 留作
	// 980 v9 双语 audition 过的英文 premade 对照。persona 不变,只换声线。
	tadashi_alt_jason: {
		name: "Tadashi",
		voiceName: "Jason(备选A·中文原生·北京腔)",
		voiceId: "DowyQ68vDpgFYdWVGjc3",
		personaFile: "personas/tadashi.md",
		firstMessage:
			"嗨，我是 Tadashi。这条是备选声线 A，中文原生，你听听顺不顺。",
	},
	tadashi_alt_haoran: {
		name: "Tadashi",
		voiceName: "Haoran(备选B·中文原生·沉稳)",
		voiceId: "pU9NaAwkoR3v0Mrg3uKz",
		personaFile: "personas/tadashi.md",
		firstMessage:
			"嗨，我是 Tadashi。这条是备选声线 B，中文原生，你听听顺不顺。",
	},
	tadashi_alt_george: {
		name: "Tadashi",
		voiceName: "George(备选C·英文premade对照)",
		voiceId: "JBFqnCBsd6RMkjVDRZzb",
		personaFile: "personas/tadashi.md",
		firstMessage: "嗨，我是 Tadashi。这条是备选声线 C，你听听中文顺不顺。",
	},
	cass_alt_amy: {
		name: "Aunt Cass",
		voiceName: "Amy(备选·中文原生·自然)",
		voiceId: "bhJUNIXWQQ94l8eI2VUf",
		personaFile: "personas/cass.md",
		firstMessage: "你好呀，我是 Cass。这条是中文原生备选声线，你听听顺不顺。",
	},
};

/** startup fail-loud: every lead's persona file must exist and be non-empty. */
export function loadPersonas(baseDir = HERE) {
	const personas = {};
	for (const [id, lead] of Object.entries(LEADS)) {
		const path = join(baseDir, lead.personaFile);
		let text;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			throw new Error(`persona file missing: ${lead.personaFile} (${id})`);
		}
		if (!text.trim()) {
			throw new Error(`persona file empty: ${lead.personaFile} (${id})`);
		}
		personas[id] = text;
	}
	return personas;
}

const json = (res, status, body) => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
};

export function createTalkServer({
	agentId,
	key,
	personas,
	fetchImpl = fetch,
	htmlPath = join(HERE, "talk.html"),
	auditionHtmlPath = join(HERE, "audition.html"),
	auditionDir = join(homedir(), "fly1006-eleven", "audition"),
	logDir = join(homedir(), "fly1006-eleven"),
}) {
	return createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (req.method === "GET" && url.pathname === "/") {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(readFileSync(htmlPath));
				return;
			}
			if (req.method === "GET" && url.pathname === "/audition") {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				res.end(readFileSync(auditionHtmlPath));
				return;
			}
			if (req.method === "GET" && url.pathname.startsWith("/audition/audio/")) {
				const name = url.pathname.slice("/audition/audio/".length);
				// 白名单文件名——不许任何路径成分(防目录穿越)
				if (!/^[a-z0-9-]+\.mp3$/.test(name)) {
					json(res, 400, { error: "bad sample name" });
					return;
				}
				let buf;
				try {
					buf = readFileSync(join(auditionDir, name));
				} catch {
					json(res, 404, { error: "sample not found" });
					return;
				}
				res.writeHead(200, { "content-type": "audio/mpeg" });
				res.end(buf);
				return;
			}
			if (req.method === "GET" && url.pathname === "/api/signed-url") {
				const leadId = url.searchParams.get("lead");
				const lead = leadId ? LEADS[leadId] : undefined;
				if (!lead) {
					json(res, 400, { error: `unknown lead: ${leadId ?? "(missing)"}` });
					return;
				}
				const upstream = await fetchImpl(
					`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
					{ headers: { "xi-api-key": key } },
				);
				const body = await upstream.json().catch(() => ({}));
				if (!upstream.ok || !body.signed_url) {
					// key 绝不出现在响应/日志里;只回 upstream 状态码
					json(res, 502, {
						error: `get-signed-url failed (${upstream.status})`,
					});
					return;
				}
				json(res, 200, {
					signedUrl: body.signed_url,
					lead: {
						id: leadId,
						name: lead.name,
						voiceName: lead.voiceName,
						voiceId: lead.voiceId,
						prompt: personas[leadId],
						firstMessage: lead.firstMessage,
					},
				});
				return;
			}
			if (req.method === "POST" && url.pathname === "/api/log") {
				let raw = "";
				for await (const chunk of req) {
					raw += chunk;
					if (raw.length > 65536) {
						json(res, 413, { error: "log event too large" });
						return;
					}
				}
				let evt;
				try {
					evt = JSON.parse(raw);
				} catch {
					json(res, 400, { error: "invalid json" });
					return;
				}
				mkdirSync(logDir, { recursive: true });
				appendFileSync(
					join(logDir, "talk-events.jsonl"),
					`${JSON.stringify({ ts: Date.now(), ...evt })}\n`,
				);
				json(res, 200, { ok: true });
				return;
			}
			json(res, 404, { error: "not found" });
		} catch (err) {
			// fail-loud 但绝不外带 key/内部细节
			console.error("[fly1006-talk] request error:", err?.message ?? err);
			if (!res.headersSent) json(res, 500, { error: "internal error" });
		}
	});
}

const isMain =
	process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	const key = requireApiKey();
	const agentId = process.env.FLY1006_AGENT_ID ?? process.argv[2];
	if (!agentId) {
		console.error(
			"usage: FLY1006_AGENT_ID=<agent_id> node serve.mjs  (or node serve.mjs <agent_id>)",
		);
		process.exit(2);
	}
	const personas = loadPersonas(); // fail-loud before listen
	const port = Number(process.env.FLY1006_PORT ?? 8988);
	const server = createTalkServer({ agentId, key, personas });
	server.listen(port, "127.0.0.1", () => {
		console.log(
			`[fly1006-talk] http://127.0.0.1:${port}  agent=${agentId}  leads=${Object.keys(LEADS).join(",")}`,
		);
	});
}
