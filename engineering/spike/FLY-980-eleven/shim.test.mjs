// FLY-980 V1 — shim contract tests (node --test, no external deps).
// Covers the four V1 contract cases (SSE stream + [DONE], tools tolerance,
// Bearer 401, client-abort cleanup) plus the Codex R2 adapter/session/cwd
// guardrail cases. Brains are injected fakes — no ElevenLabs / claude needed.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	BrainSessions,
	CwdProcessRunner,
	createShimServer,
	dedupeFinalEcho,
	deriveConversationKey,
	mapMessages,
	maybeToolCall,
} from "./lib/shim-core.mjs";

const TOKEN = "test-token-123";

function makeFakeBrainFactory(pieces = ["hello ", "world"], opts = {}) {
	const factory = (info) => {
		const brain = {
			info,
			sawAbort: false,
			async *respond(_turn, { signal }) {
				signal.addEventListener("abort", () => {
					brain.sawAbort = true;
				});
				for (const p of pieces) {
					if (signal.aborted) return;
					if (opts.delayMs) {
						await new Promise((r) => setTimeout(r, opts.delayMs));
					}
					if (signal.aborted) return;
					yield p;
				}
				if (opts.hang) {
					await new Promise((resolve) => {
						if (signal.aborted) {
							resolve();
							return;
						}
						signal.addEventListener("abort", () => resolve());
					});
				}
			},
		};
		factory.created.push(brain);
		return brain;
	};
	factory.created = [];
	return factory;
}

async function startServer(overrides = {}) {
	const workDir = mkdtempSync(join(tmpdir(), "fly980-test-"));
	const brainFactory = overrides.brainFactory ?? makeFakeBrainFactory();
	const sessions = new BrainSessions({
		brainFactory,
		resume: overrides.resume ?? true,
	});
	const server = createShimServer({
		token: TOKEN,
		sessions,
		workDir,
		log: () => {},
		toolMode: overrides.toolMode ?? "off",
		...overrides.serverOpts,
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	const url = `http://127.0.0.1:${port}/v1/chat/completions`;
	return { server, url, workDir, brainFactory, sessions };
}

function chatBody(extra = {}) {
	return {
		model: "flywheel-claude-brain",
		stream: true,
		messages: [
			{ role: "system", content: "You are Tadashi, the eng lead." },
			{ role: "user", content: "hi there" },
		],
		...extra,
	};
}

async function readSse(res) {
	const raw = await res.text();
	const events = raw
		.split("\n\n")
		.map((b) => b.trim())
		.filter(Boolean)
		.map((b) => b.replace(/^data: /, ""));
	const done = events.includes("[DONE]");
	const chunks = events.filter((e) => e !== "[DONE]").map((e) => JSON.parse(e));
	return { chunks, done };
}

// ---- V1 case 1: streaming chunks + [DONE] ----
test("SSE contract: role frame, content deltas, stop, [DONE]", async () => {
	const { server, url } = await startServer();
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(chatBody()),
		});
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type"), /text\/event-stream/);
		const { chunks, done } = await readSse(res);
		assert.ok(done, "must end with [DONE]");
		assert.equal(chunks[0].choices[0].delta.role, "assistant");
		const content = chunks
			.map((c) => c.choices[0].delta.content ?? "")
			.join("");
		assert.equal(content, "hello world");
		const last = chunks.at(-1);
		assert.equal(last.choices[0].finish_reason, "stop");
		assert.equal(chunks[0].object, "chat.completion.chunk");
	} finally {
		server.close();
	}
});

// ---- V1 case 2: tools array tolerated ----
test("tools array present → still a normal streamed reply", async () => {
	const { server, url } = await startServer();
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(
				chatBody({
					tools: [
						{
							type: "function",
							function: { name: "language_detection", parameters: {} },
						},
					],
				}),
			),
		});
		assert.equal(res.status, 200);
		const { chunks, done } = await readSse(res);
		assert.ok(done);
		const content = chunks
			.map((c) => c.choices[0].delta.content ?? "")
			.join("");
		assert.equal(content, "hello world");
	} finally {
		server.close();
	}
});

// ---- V1 case 3: Bearer auth ----
test("missing / wrong bearer token → 401", async () => {
	const { server, url } = await startServer();
	try {
		for (const headers of [
			{ "content-type": "application/json" },
			{
				authorization: "Bearer wrong",
				"content-type": "application/json",
			},
		]) {
			const res = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(chatBody()),
			});
			assert.equal(res.status, 401);
		}
	} finally {
		server.close();
	}
});

// ---- V1 case 4: client abort → brain signal aborted ----
test("client abort propagates AbortSignal to the brain", async () => {
	const factory = makeFakeBrainFactory(["a", "b", "c"], {
		delayMs: 50,
		hang: true,
	});
	const { server, url } = await startServer({ brainFactory: factory });
	try {
		const ac = new AbortController();
		const p = fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(chatBody()),
			signal: ac.signal,
		}).catch(() => null);
		await new Promise((r) => setTimeout(r, 120));
		ac.abort();
		await p;
		// poll until the brain observed the abort (event loop turn-around)
		const brain = factory.created[0];
		for (let i = 0; i < 50 && !brain.sawAbort; i++) {
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.ok(brain, "brain was created");
		assert.ok(brain.sawAbort, "brain must observe the abort signal");
	} finally {
		server.close();
	}
});

// ---- adapter: messages → Turn[] mapping ----
test("mapMessages: last user = turn text, history ordered, system excluded", () => {
	const { systemText, turnText, history } = mapMessages([
		{ role: "system", content: "persona here" },
		{ role: "user", content: "first question" },
		{ role: "assistant", content: "first answer" },
		{ role: "user", content: "second question" },
	]);
	assert.equal(systemText, "persona here");
	assert.equal(turnText, "second question");
	assert.deepEqual(
		history.map((t) => [t.role, t.text]),
		[
			["user", "first question"],
			["assistant", "first answer"],
		],
	);
});

test("mapMessages: array content parts + missing user tolerated", () => {
	const mapped = mapMessages([
		{
			role: "user",
			content: [
				{ type: "text", text: "part1 " },
				{ type: "text", text: "part2" },
			],
		},
	]);
	assert.equal(mapped.turnText, "part1 part2");
	assert.deepEqual(mapMessages([]).turnText, "");
});

// ---- conversation key derivation ----
test("deriveConversationKey: extra_body id wins, fallback single-session", () => {
	assert.equal(
		deriveConversationKey({
			user_id: "u1",
			elevenlabs_extra_body: { conversation_id: "conv-9" },
		}),
		"conv-9",
	);
	assert.equal(deriveConversationKey({ user_id: "u1" }), "u1");
	assert.equal(deriveConversationKey({}), "single-session");
});

// ---- system prompt → per-conversation identity file ----
test("system message lands in a per-conversation identity file", async () => {
	const factory = makeFakeBrainFactory();
	const { server, url } = await startServer({ brainFactory: factory });
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(
				chatBody({ elevenlabs_extra_body: { conversation_id: "conv-A" } }),
			),
		});
		await res.text();
		const brain = factory.created[0];
		assert.ok(brain.info.identityFile, "factory receives identityFile");
		const content = readFileSync(brain.info.identityFile, "utf8");
		assert.match(content, /Tadashi, the eng lead/);
	} finally {
		server.close();
	}
});

// ---- session isolation: two conversation keys → two brains ----
test("two conversation keys never share one resume brain", async () => {
	const factory = makeFakeBrainFactory();
	const { server, url } = await startServer({
		brainFactory: factory,
		resume: true,
	});
	try {
		for (const conv of ["conv-A", "conv-B", "conv-A"]) {
			const res = await fetch(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${TOKEN}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(
					chatBody({ elevenlabs_extra_body: { conversation_id: conv } }),
				),
			});
			await res.text();
		}
		// resume mode: conv-A reused on 3rd call → exactly 2 brains created
		assert.equal(factory.created.length, 2);
		assert.notEqual(factory.created[0], factory.created[1]);
	} finally {
		server.close();
	}
});

// ---- FLY980_RESUME=0 semantics: fresh brain per turn ----
test("resume=false creates a fresh brain every request", async () => {
	const factory = makeFakeBrainFactory();
	const { server, url } = await startServer({
		brainFactory: factory,
		resume: false,
	});
	try {
		for (let i = 0; i < 2; i++) {
			const res = await fetch(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${TOKEN}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(
					chatBody({ elevenlabs_extra_body: { conversation_id: "conv-A" } }),
				),
			});
			await res.text();
		}
		assert.equal(factory.created.length, 2);
		assert.equal(factory.created[0].info.useResume, false);
	} finally {
		server.close();
	}
});

// ---- cwd wrapper forwards {cwd} to the inner runner ----
test("CwdProcessRunner forwards cwd on run() and spawn()", async () => {
	const seen = [];
	const inner = {
		run(cmd, _args, opts) {
			seen.push(["run", cmd, opts]);
			return Promise.resolve({ stdout: Buffer.alloc(0), stderr: "", code: 0 });
		},
		spawn(cmd, _args, opts) {
			seen.push(["spawn", cmd, opts]);
			return {
				pid: 1,
				kill() {},
				onStdout() {},
				onStderr() {},
				onExit() {},
				write() {},
				end() {},
			};
		},
	};
	const runner = new CwdProcessRunner(inner, "/tmp/empty-cwd");
	await runner.run("claude", ["-p"]);
	runner.spawn("claude", ["-p"], { env: { A: "1" } });
	assert.equal(seen[0][2].cwd, "/tmp/empty-cwd");
	assert.equal(seen[1][2].cwd, "/tmp/empty-cwd");
	assert.equal(seen[1][2].env.A, "1", "existing opts preserved");
});

// ---- V7a: forced tool call emitted in OpenAI format ----
test("toolMode force → SSE tool_calls response with finish_reason tool_calls", async () => {
	const { server, url } = await startServer({
		toolMode: "force:language_detection",
	});
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(
				chatBody({
					tools: [
						{
							type: "function",
							function: {
								name: "language_detection",
								parameters: {
									type: "object",
									properties: { language: { type: "string" } },
								},
							},
						},
					],
				}),
			),
		});
		assert.equal(res.status, 200);
		const { chunks, done } = await readSse(res);
		assert.ok(done);
		const toolChunk = chunks.find((c) => c.choices[0].delta.tool_calls);
		assert.ok(toolChunk, "must emit a tool_calls delta");
		const call = toolChunk.choices[0].delta.tool_calls[0];
		assert.equal(call.function.name, "language_detection");
		assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
	} finally {
		server.close();
	}
});

test("maybeToolCall: off mode and absent tools never fire", () => {
	const tools = [
		{ type: "function", function: { name: "language_detection" } },
	];
	assert.equal(maybeToolCall(tools, "hello", "off"), null);
	assert.equal(
		maybeToolCall(undefined, "hello", "force:language_detection"),
		null,
	);
	const forced = maybeToolCall(tools, "hello", "force:language_detection");
	assert.equal(forced.name, "language_detection");
});

// ---- dedupe: claude -p stream-json emits deltas AND a final full assistant
// message; voice-core forwards both → the reply would be spoken twice ----
test("dedupeFinalEcho drops the final full-text echo, keeps real deltas", async () => {
	const collect = async (pieces) => {
		const brain = {
			async *respond() {
				yield* pieces;
			},
		};
		const out = [];
		for await (const p of dedupeFinalEcho(brain).respond(
			{ text: "", history: [] },
			{ signal: new AbortController().signal },
		)) {
			out.push(p);
		}
		return out;
	};
	// delta, delta, final echo == joined deltas → echo dropped
	assert.deepEqual(await collect(["链路", "通了。", "链路通了。"]), [
		"链路",
		"通了。",
	]);
	// single delta + echo
	assert.deepEqual(await collect(["hello", "hello"]), ["hello"]);
	// no echo (non-partial single message) → kept
	assert.deepEqual(await collect(["full reply"]), ["full reply"]);
	// unrelated repeat that is not the full accumulation → kept
	assert.deepEqual(await collect(["a", "b", "b"]), ["a", "b", "b"]);
});

// ---- stream:false → aggregated JSON completion ----
test("stream:false returns a single chat.completion JSON", async () => {
	const { server, url } = await startServer();
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${TOKEN}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(chatBody({ stream: false })),
		});
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.object, "chat.completion");
		assert.equal(body.choices[0].message.content, "hello world");
		assert.equal(body.choices[0].finish_reason, "stop");
	} finally {
		server.close();
	}
});

// ---- QA FLY-1006 round-3 ① — per-conversation single-flight ----
// Annie P6: platform retries/dupes pile concurrent claude -p runs onto one
// conversation and latency snowballs across rounds. A NEW request for a key
// must cleanly abort the previous in-flight run (fresh round starts from
// zero); different conversations stay independent.
test("single-flight: a new same-key request aborts the in-flight previous one", async () => {
	// brain #1 hangs until aborted; later brains answer normally. resume=false
	// gives each request its own brain instance so the order is observable.
	let n = 0;
	const factory = (info) => {
		n++;
		const brain = {
			info,
			n,
			sawAbort: false,
			async *respond(_turn, { signal }) {
				signal.addEventListener("abort", () => {
					brain.sawAbort = true;
				});
				if (brain.n === 1) {
					await new Promise((resolve) => {
						if (signal.aborted) return resolve();
						signal.addEventListener("abort", () => resolve());
					});
					return;
				}
				yield "fresh answer";
			},
		};
		factory.created.push(brain);
		return brain;
	};
	factory.created = [];
	const { server, url } = await startServer({
		brainFactory: factory,
		resume: false,
	});
	try {
		const post = (id) =>
			fetch(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${TOKEN}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(
					chatBody({ elevenlabs_extra_body: { conversation_id: id } }),
				),
			});
		const p1 = post("conv-1"); // hangs on brain #1
		await new Promise((r) => setTimeout(r, 100));
		const res2 = await post("conv-1"); // supersedes → must abort brain #1
		const sse2 = await readSse(res2);
		assert.equal(
			sse2.chunks.some(
				(c) => c.choices?.[0]?.delta?.content === "fresh answer",
			),
			true,
			"the new round streams normally",
		);
		const brain1 = factory.created[0];
		for (let i = 0; i < 50 && !brain1.sawAbort; i++) {
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.ok(brain1.sawAbort, "the superseded in-flight brain was aborted");
		await p1; // the aborted response terminates (no hang)
	} finally {
		server.close();
	}
});

test("single-flight: different conversation keys never abort each other", async () => {
	const factory = makeFakeBrainFactory(["ok"], { delayMs: 80 });
	const { server, url } = await startServer({
		brainFactory: factory,
		resume: false,
	});
	try {
		const post = (id) =>
			fetch(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${TOKEN}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(
					chatBody({ elevenlabs_extra_body: { conversation_id: id } }),
				),
			});
		const [a, b] = await Promise.all([post("conv-a"), post("conv-b")]);
		const [sa, sb] = [await readSse(a), await readSse(b)];
		assert.equal(sa.done && sb.done, true);
		assert.equal(
			factory.created.every((brain) => !brain.sawAbort),
			true,
			"no cross-conversation aborts",
		);
	} finally {
		server.close();
	}
});

test("single-flight: a same-key TOOL-CALL request also aborts the in-flight brain (Codex R3-fix-1)", async () => {
	// brain #1 hangs until aborted; the follow-up same-key request takes the
	// tool-call early-return path — it must STILL supersede the old run.
	const factory = (info) => {
		const brain = {
			info,
			sawAbort: false,
			async *respond(_turn, { signal }) {
				signal.addEventListener("abort", () => {
					brain.sawAbort = true;
				});
				await new Promise((resolve) => {
					if (signal.aborted) return resolve();
					signal.addEventListener("abort", () => resolve());
				});
			},
		};
		factory.created.push(brain);
		return brain;
	};
	factory.created = [];
	const { server, url } = await startServer({
		brainFactory: factory,
		resume: false,
		toolMode: "force:language_detection",
	});
	try {
		const post = (body) =>
			fetch(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${TOKEN}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			});
		// req1: NO tools offered → brain path → hangs
		const p1 = post(
			chatBody({ elevenlabs_extra_body: { conversation_id: "conv-t" } }),
		);
		await new Promise((r) => setTimeout(r, 100));
		// req2: same key, platform offers the tool → tool-call early return
		const res2 = await post(
			chatBody({
				elevenlabs_extra_body: { conversation_id: "conv-t" },
				tools: [{ type: "function", function: { name: "language_detection" } }],
				messages: [{ role: "user", content: "switching to English now" }],
			}),
		);
		const sse2 = await readSse(res2);
		assert.equal(sse2.done, true, "tool-call response completes");
		const brain1 = factory.created[0];
		for (let i = 0; i < 50 && !brain1?.sawAbort; i++) {
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.ok(brain1, "brain #1 was created");
		assert.ok(
			brain1.sawAbort,
			"the in-flight brain was aborted by the tool-call request",
		);
		await p1; // superseded response terminates (no hang)
	} finally {
		server.close();
	}
});
