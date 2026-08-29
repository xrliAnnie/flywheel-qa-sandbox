// FLY-997 S3 architecture comparison (plan §5 S3, V6/V7) — DEGRADED MODE per
// plan risk 3, recorded honestly:
//   voice-core's ConversationSession is audio-in only (sendAudio; no text
//   face), and this Runner box has no mic pipeline. So the Live side is
//   driven over the SAME Live API + SAME live model that voice-core's
//   GeminiLiveBackend wraps, but with TEXT turns instead of audio. The
//   delegate-tool seam semantics (Live model holds tools; results injected
//   back) are identical; real speech latency is NOT measured here and is
//   left to the build phase.
//
// Part A (mode a, V6): two-layer — Live holds ONE delegate tool (agent_task);
//   handler returns an immediate ACK; the spike's own loop (deep brain, flash
//   tier) runs the N1-short chain against the mock in the background; on
//   completion the result is injected as a new turn and the Live model
//   announces it. Measured: ACK turnaround, announcement feasibility.
// Part B (mode b probe): declare the delegate tool with behavior NON_BLOCKING
//   → record whether the current live model accepts true async FC.
// Part C (V7): single-layer — Live directly holds 4 real tools, single-step
//   dispatch × 10 rounds. Measured: success + turnaround.

import { writeFileSync } from "node:fs";
import { Behavior, Modality } from "@google/genai";
import { runAgent } from "./agent-loop.mjs";
import { CONFIG } from "./config.mjs";
import { initHarness, jsonlWriter, origins, withMock } from "./harness.mjs";
import { SYSTEM_INSTRUCTION } from "./judge.mjs";
import { registryFor, validateArgs } from "./tools.mjs";

const { ai } = initHarness();
const raw = jsonlWriter(`${CONFIG.paths.outDir}s3-live.jsonl`);
const MOCK = `http://${CONFIG.mock.host}:${CONFIG.mock.port}`;

const LIVE_SYSTEM = `${SYSTEM_INSTRUCTION}\n\nYou are the voice front-end: keep replies short and speakable (Chinese), one or two sentences.`;

/** Drive one Live round: send text, dispatch tool calls via handler, resolve
 * on turn completion. Collects timing + transcript. */
function liveRound({ model, tools, handleToolCall, timeoutMs = 60_000 }) {
	const events = [];
	let session;
	const api = {
		events,
		async send(text) {
			events.push({ t: Date.now(), kind: "send", text });
			session.sendClientContent({
				turns: [{ role: "user", parts: [{ text }] }],
				turnComplete: true,
			});
		},
		close() {
			try {
				session?.close();
			} catch {}
		},
	};
	let onTurnComplete = null;
	api.nextTurn = (ms = timeoutMs) =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("live turn timeout")),
				ms,
			);
			onTurnComplete = (texts) => {
				clearTimeout(timer);
				resolve(texts);
			};
		});

	let turnTexts = [];
	// gemini-3.1-flash-live-preview rejects TEXT response modality outright
	// ("combination of response modalities (TEXT) is not supported" — recorded
	// in findings). So: AUDIO out + outputAudioTranscription, and we read the
	// transcription text (audio bytes discarded). Input stays text turns.
	const connectPromise = ai.live.connect({
		model,
		config: {
			responseModalities: [Modality.AUDIO],
			outputAudioTranscription: {},
			systemInstruction: LIVE_SYSTEM,
			tools,
		},
		callbacks: {
			onopen: () => events.push({ t: Date.now(), kind: "open" }),
			onmessage: async (msg) => {
				if (msg.toolCall?.functionCalls?.length) {
					events.push({
						t: Date.now(),
						kind: "toolCall",
						calls: msg.toolCall.functionCalls.map((fc) => ({
							name: fc.name,
							args: fc.args,
						})),
					});
					const responses = [];
					for (const fc of msg.toolCall.functionCalls) {
						const response = await handleToolCall(fc);
						responses.push({ id: fc.id, name: fc.name, response });
					}
					session.sendToolResponse({ functionResponses: responses });
					events.push({ t: Date.now(), kind: "toolResponseSent" });
				}
				const parts = msg.serverContent?.modelTurn?.parts ?? [];
				for (const p of parts) {
					if (p.text) turnTexts.push(p.text);
				}
				if (msg.serverContent?.outputTranscription?.text) {
					turnTexts.push(msg.serverContent.outputTranscription.text);
				}
				if (msg.serverContent?.turnComplete) {
					events.push({
						t: Date.now(),
						kind: "turnComplete",
						text: turnTexts.join(""),
					});
					const texts = turnTexts.join("");
					turnTexts = [];
					onTurnComplete?.(texts);
				}
			},
			onerror: (e) =>
				events.push({
					t: Date.now(),
					kind: "error",
					message: String(e?.message ?? e),
				}),
			onclose: (e) =>
				events.push({ t: Date.now(), kind: "close", reason: e?.reason }),
		},
	});
	return connectPromise.then((s) => {
		session = s;
		return api;
	});
}

async function mockReset() {
	await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
}
async function mockState() {
	return (await fetch(`${MOCK}/__mock/state`)).json();
}

// ---------------------------------------------------------------------------
await withMock(async () => {
	const results = { partA: [], partB: null, partC: [] };

	// ===== Part A: two-layer delegate, mode a (5 rounds) =====
	const DELEGATE_DECL = {
		name: "agent_task",
		description:
			"Delegate a work request to the background dispatch agent (deep brain). It will create issues, dispatch Runners, and track them autonomously. Returns an immediate acceptance with a task id; completion is announced to you later as a system notification.",
		parameters: {
			type: "object",
			properties: {
				request: {
					type: "string",
					description: "The user's request, restated completely.",
				},
			},
			required: ["request"],
		},
	};

	for (let round = 0; round < 5; round++) {
		await mockReset();
		let delegateRequest = null;
		let tAck0 = null;
		const live = await liveRound({
			model: CONFIG.models.live,
			tools: [{ functionDeclarations: [DELEGATE_DECL] }],
			handleToolCall: async (fc) => {
				if (fc.name !== "agent_task")
					return { error: `unknown tool ${fc.name}` };
				delegateRequest = fc.args?.request ?? null;
				tAck0 = Date.now();
				return {
					result: {
						accepted: true,
						taskId: `T-${round + 1}`,
						note: "task accepted; completion will be announced",
					},
				};
			},
		});
		const rec = { part: "A", round, ok: false };
		try {
			const t0 = Date.now();
			await live.send(
				"帮我把『打印机固件温度漂移导致大件翘边』这个问题派出去修,派完之后盯到完成,有结果了告诉我。",
			);
			const ackText = await live.nextTurn();
			const tAck = Date.now();
			rec.delegateCalled = delegateRequest !== null;
			rec.ackText = ackText;
			rec.ackLatencyMs = tAck - t0;
			rec.ackAfterToolResultMs = tAck0 ? tAck - tAck0 : null;

			if (rec.delegateCalled) {
				// deep brain: real own-loop run of the N1-short chain against the mock
				const brain = await runAgent({
					ai,
					model: CONFIG.models.flash,
					surface: "interactions",
					systemInstruction: SYSTEM_INSTRUCTION,
					userMessage: `${delegateRequest}\n\n(把它建成 issue、派给 geoforge3d 的 Runner、盯到完成,最后一句话总结结果,包括 PR 链接。)`,
					registry: registryFor([
						"create_issue",
						"dispatch_runner",
						"query_status",
						"save_memory",
					]),
					maxSteps: 10,
					audit: () => {},
				});
				const mock = await mockState();
				rec.deepBrain = {
					steps: brain.steps,
					dispatched: mock.runs.length >= 1,
					polledToDone: (mock.runs[0]?.statusPolls ?? 0) >= 2,
					summary: brain.finalText.slice(0, 200),
				};
				// completion reinjection as a new turn (mode a mechanism)
				const tInject = Date.now();
				await live.send(
					`[系统通知,非用户发言] 委托任务 T-${round + 1} 已完成。结果:${brain.finalText.slice(0, 300)}\n请向用户口头播报这个结果。`,
				);
				const announceText = await live.nextTurn();
				rec.announceText = announceText;
				rec.announceLatencyMs = Date.now() - tInject;
				rec.announced = announceText.trim().length > 0;
			}
			rec.ok = rec.delegateCalled && rec.announced === true;
		} catch (err) {
			rec.error = String(err?.message ?? err);
		} finally {
			live.close();
		}
		rec.events = live.events;
		raw(rec);
		results.partA.push(rec);
		console.log(
			`[S3-A round ${round}] delegate=${rec.delegateCalled} ackMs=${rec.ackLatencyMs} announced=${rec.announced ?? false}${rec.error ? ` ERR=${rec.error}` : ""}`,
		);
	}

	// ===== Part B: NON_BLOCKING async FC probe (1 round) =====
	{
		await mockReset();
		const rec = { part: "B", probe: "behavior NON_BLOCKING on live model" };
		try {
			const live = await liveRound({
				model: CONFIG.models.live,
				tools: [
					{
						functionDeclarations: [
							{ ...DELEGATE_DECL, behavior: Behavior.NON_BLOCKING },
						],
					},
				],
				handleToolCall: async () => ({
					result: { accepted: true, taskId: "T-probe" },
					scheduling: "WHEN_IDLE",
				}),
			});
			try {
				await live.send("帮我把打印机固件的问题派出去修。");
				const text = await live.nextTurn(30_000);
				rec.accepted = true;
				rec.responseText = text;
				rec.events = live.events;
			} finally {
				live.close();
			}
		} catch (err) {
			rec.accepted = false;
			rec.error = String(err?.message ?? err);
		}
		raw(rec);
		results.partB = rec;
		console.log(
			`[S3-B] NON_BLOCKING accepted=${rec.accepted}${rec.error ? ` ERR=${rec.error}` : ""}`,
		);
	}

	// ===== Part C: single-layer, Live directly holds 4 tools (10 rounds) =====
	const singleLayerTools = registryFor([
		"create_issue",
		"dispatch_runner",
		"query_status",
		"search_memory",
	]);
	for (let round = 0; round < 10; round++) {
		await mockReset();
		const toolLog = [];
		const live = await liveRound({
			model: CONFIG.models.live,
			tools: [
				{
					functionDeclarations: Object.values(singleLayerTools).map(
						(t) => t.declaration,
					),
				},
			],
			handleToolCall: async (fc) => {
				const tool = singleLayerTools[fc.name];
				if (!tool) {
					toolLog.push({ name: fc.name, hallucinated: true });
					return { error: `unknown tool: ${fc.name}` };
				}
				const errors = validateArgs(tool.declaration.parameters, fc.args ?? {});
				if (errors.length) {
					toolLog.push({ name: fc.name, validationErrors: errors });
					return { error: `invalid arguments: ${errors.join("; ")}` };
				}
				const out = await tool.handler(fc.args);
				toolLog.push({ name: fc.name, httpStatus: out.httpStatus });
				return out;
			},
		});
		const rec = { part: "C", round, ok: false };
		try {
			const t0 = Date.now();
			await live.send(
				"把 issue MOCK-5 派给 geoforge3d 项目的 Runner 去处理,派完告诉我一声。",
			);
			// allow up to 3 turns for tool call + confirm
			let text = await live.nextTurn();
			const mock1 = await mockState();
			if (!mock1.runs.length) {
				// model may confirm intent first; nudge once
				await live.send("对,现在就派。");
				text = await live.nextTurn();
			}
			const mock = await mockState();
			rec.dispatched =
				mock.runs.length >= 1 && mock.runs[0].issueId === "MOCK-5";
			rec.finalText = text;
			rec.latencyMs = Date.now() - t0;
			rec.toolLog = toolLog;
			rec.ok = rec.dispatched && text.trim().length > 0;
		} catch (err) {
			rec.error = String(err?.message ?? err);
		} finally {
			live.close();
		}
		rec.events = live.events;
		raw(rec);
		results.partC.push(rec);
		console.log(
			`[S3-C round ${round}] dispatched=${rec.dispatched ?? false} latencyMs=${rec.latencyMs}${rec.error ? ` ERR=${rec.error}` : ""}`,
		);
	}

	// ===== committed evidence summary =====
	const a = results.partA;
	const c = results.partC;
	const summary = {
		ts: new Date().toISOString(),
		degradation:
			"Live side driven with TEXT input turns over the same Live API/model voice-core wraps (voice-core ConversationSession is audio-in only; no mic on this box). Output = AUDIO + outputAudioTranscription (the model rejects TEXT-only response modality); announcement text read from transcription, audio bytes discarded. Mic-to-ear speech latency NOT measured — build-phase item.",
		liveModel: CONFIG.models.live,
		partA: {
			rounds: a.length,
			delegateCalled: a.filter((r) => r.delegateCalled).length,
			announced: a.filter((r) => r.announced).length,
			ok: a.filter((r) => r.ok).length,
			ackLatencyMsAll: a.map((r) => r.ackLatencyMs ?? null),
			announceLatencyMsAll: a.map((r) => r.announceLatencyMs ?? null),
			deepBrainDispatched: a.filter((r) => r.deepBrain?.dispatched).length,
		},
		partB: {
			nonBlockingAccepted: results.partB?.accepted ?? false,
			error: results.partB?.error ?? null,
		},
		partC: {
			rounds: c.length,
			ok: c.filter((r) => r.ok).length,
			latencyMsAll: c.map((r) => r.latencyMs ?? null),
			hallucinated: c.reduce(
				(s, r) => s + (r.toolLog?.filter((t) => t.hallucinated).length ?? 0),
				0,
			),
		},
		outboundOrigins: origins(),
	};
	writeFileSync(
		`${CONFIG.paths.evidenceDir}s3-live-summary.json`,
		JSON.stringify(summary, null, 2),
	);
	console.log(
		"\n[S3] done →",
		`${CONFIG.paths.evidenceDir}s3-live-summary.json`,
	);
});
