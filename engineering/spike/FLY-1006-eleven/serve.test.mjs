// FLY-1006 S2 — talk-page server contract tests (TDD: written before serve.mjs).
// Contract (plan.md §S2 / Codex R1#4):
//   - GET /api/signed-url?lead=<id> → {signedUrl, lead:{voiceId, prompt, ...}}
//     — key only ever appears in the upstream request header, never in the
//     response body (key never leaves the process).
//   - lead table has 3 leads, each with non-empty voiceId + persona prompt.
//   - unknown / missing lead → 400 (fail-closed).
//   - persona file missing → loadPersonas throws (startup fail-loud).
// run: node --test serve.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTalkServer, LEADS, loadPersonas } from "./serve.mjs";

const FAKE_KEY = "fake-xi-key-for-tests-only";

function startServer({ fetchImpl, logDir, auditionDir } = {}) {
	const server = createTalkServer({
		agentId: "agent_test_123",
		key: FAKE_KEY,
		personas: loadPersonas(),
		fetchImpl,
		logDir,
		auditionDir,
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
		});
	});
}

test("lead table: 3 core leads + Tadashi voice alternates, each entry complete", () => {
	const personas = loadPersonas();
	const ids = Object.keys(LEADS);
	// 3 核心 Lead 必须在;Annie M1 反馈①的 Tadashi 中文口音备选(980 v9 已双语
	// audition 的 George/Will/Harry)作为额外可选项
	for (const core of ["tadashi", "cass", "belle"]) {
		assert.ok(ids.includes(core), `core lead present: ${core}`);
	}
	const alts = ids.filter((id) => id.startsWith("tadashi_alt_"));
	assert.ok(alts.length >= 2, "≥2 Tadashi voice alternates for Annie to try");
	const voiceIds = new Set(ids.map((id) => LEADS[id].voiceId));
	assert.equal(voiceIds.size, ids.length, "no duplicate voiceIds");
	for (const id of ids) {
		assert.ok(LEADS[id].voiceId?.length > 0, `${id}: voiceId`);
		assert.ok(LEADS[id].firstMessage?.length > 0, `${id}: firstMessage`);
		assert.ok(personas[id]?.trim().length > 0, `${id}: persona prompt`);
	}
});

test("loadPersonas: missing persona file → fail-loud throw", () => {
	const emptyDir = mkdtempSync(join(tmpdir(), "fly1006-personas-"));
	assert.throws(() => loadPersonas(emptyDir), /persona/);
});

test("signed-url route: key only goes upstream; response carries signedUrl + lead and never the key", async () => {
	const upstream = [];
	const fetchImpl = async (url, init) => {
		upstream.push({ url: String(url), headers: init?.headers ?? {} });
		return new Response(
			JSON.stringify({ signed_url: "wss://fake.signed/ws" }),
			{
				status: 200,
			},
		);
	};
	const { server, base } = await startServer({ fetchImpl });
	try {
		const res = await fetch(`${base}/api/signed-url?lead=tadashi`);
		assert.equal(res.status, 200);
		const text = await res.text();
		assert.ok(!text.includes(FAKE_KEY), "response body must not leak the key");
		const json = JSON.parse(text);
		assert.equal(json.signedUrl, "wss://fake.signed/ws");
		assert.equal(json.lead.voiceId, LEADS.tadashi.voiceId);
		assert.ok(json.lead.prompt.length > 0, "persona prompt travels to page");
		assert.ok(json.lead.firstMessage.length > 0);
		assert.equal(upstream.length, 1);
		assert.equal(upstream[0].headers["xi-api-key"], FAKE_KEY);
		assert.ok(upstream[0].url.includes("agent_id=agent_test_123"));
	} finally {
		server.close();
	}
});

test("signed-url route: unknown lead → 400", async () => {
	const { server, base } = await startServer({
		fetchImpl: async () => {
			throw new Error("must not reach upstream on bad lead");
		},
	});
	try {
		const res = await fetch(`${base}/api/signed-url?lead=nobody`);
		assert.equal(res.status, 400);
	} finally {
		server.close();
	}
});

test("signed-url route: missing lead param → 400", async () => {
	const { server, base } = await startServer({
		fetchImpl: async () => {
			throw new Error("must not reach upstream without lead");
		},
	});
	try {
		const res = await fetch(`${base}/api/signed-url`);
		assert.equal(res.status, 400);
	} finally {
		server.close();
	}
});

test("signed-url route: upstream failure → 502 and body still key-free", async () => {
	const { server, base } = await startServer({
		fetchImpl: async () =>
			new Response(JSON.stringify({ detail: "nope" }), { status: 500 }),
	});
	try {
		const res = await fetch(`${base}/api/signed-url?lead=cass`);
		assert.equal(res.status, 502);
		const text = await res.text();
		assert.ok(!text.includes(FAKE_KEY));
	} finally {
		server.close();
	}
});

test("GET / serves the talk page", async () => {
	const { server, base } = await startServer({});
	try {
		const res = await fetch(`${base}/`);
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /text\/html/);
		const html = await res.text();
		assert.ok(html.includes("FLY-1006"));
	} finally {
		server.close();
	}
});

test("GET /audition serves the static voice-audition page", async () => {
	const { server, base } = await startServer({});
	try {
		const res = await fetch(`${base}/audition`);
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /text\/html/);
		assert.ok((await res.text()).includes("声线"));
	} finally {
		server.close();
	}
});

test("GET /audition/audio/<file>.mp3 serves from auditionDir; traversal rejected", async () => {
	const auditionDir = mkdtempSync(join(tmpdir(), "fly1006-audition-"));
	writeFileSync(join(auditionDir, "jason-zh.mp3"), Buffer.from([0xff, 0xf3]));
	const { server, base } = await startServer({ auditionDir });
	try {
		const ok = await fetch(`${base}/audition/audio/jason-zh.mp3`);
		assert.equal(ok.status, 200);
		assert.match(ok.headers.get("content-type") ?? "", /audio\/mpeg/);
		const evil = await fetch(`${base}/audition/audio/..%2Fsecret.mp3`);
		assert.ok([400, 404].includes(evil.status), "traversal must be rejected");
		const missing = await fetch(`${base}/audition/audio/nope.mp3`);
		assert.equal(missing.status, 404);
	} finally {
		server.close();
	}
});

test("POST /api/log appends a jsonl line (page rough-timestamp archive)", async () => {
	const logDir = mkdtempSync(join(tmpdir(), "fly1006-log-"));
	const { server, base } = await startServer({ logDir });
	try {
		const res = await fetch(`${base}/api/log`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "mode", mode: "speaking", lead: "belle" }),
		});
		assert.equal(res.status, 200);
		const lines = readFileSync(join(logDir, "talk-events.jsonl"), "utf8")
			.trim()
			.split("\n");
		assert.equal(lines.length, 1);
		const evt = JSON.parse(lines[0]);
		assert.equal(evt.type, "mode");
		assert.equal(evt.mode, "speaking");
		assert.ok(typeof evt.ts === "number");
	} finally {
		server.close();
	}
});
