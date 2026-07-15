/**
 * FLY-1160 §3.1 — ResidentClaudeBrain turn state machine (fake ProcessRunner).
 *
 * Contract under test (plan §3.4):
 *   multi-turn serial on ONE process / new turn awaits old barrier / interrupt
 *   whitelist (error_during_execution) / interrupt-barrier timeout → kill /
 *   watchdog mandatory non-zero / out-of-turn crash → --resume respawn /
 *   first-turn crash → fresh + re-injection / mid-turn crash throws + recovering
 *   + NO replay / respawn rate-limit → failed / lifetime-expiry event-only /
 *   dispose EOF→eofGrace→TERM→termGrace→KILL (fake-timer sentinel) /
 *   appendContext bounded cache + ack = normal terminal result only +
 *   retained re-injection with seq markers / >64KB frame chunked write never
 *   respawns / AbortSignal → in-band interrupt (process survives).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ResidentBrainEvent,
	type ResidentBrainOptions,
	ResidentClaudeBrain,
} from "../brain/ResidentClaudeBrain.js";
import { NodeProcessRunner } from "../process.js";
import type { VoiceError } from "../types.js";
import { type FakeProcessHandle, FakeProcessRunner } from "./fakes.js";

const cleanup: string[] = [];
const brains: ResidentClaudeBrain[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const b of brains) {
		try {
			b.forceKill();
		} catch {}
	}
	brains.length = 0;
	for (const d of cleanup) rmSync(d, { recursive: true, force: true });
	cleanup.length = 0;
});

function identityFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "voice-identity-"));
	cleanup.push(dir);
	const p = join(dir, "identity.md");
	writeFileSync(p, "You are Tadashi. SECRET_PERSONA_MARKER.");
	return p;
}

const SID = "sess-1160";
const line = (obj: unknown) => `${JSON.stringify(obj)}\n`;
const initLine = () =>
	line({ type: "system", subtype: "init", session_id: SID });
const deltaLine = (text: string) =>
	line({
		type: "stream_event",
		session_id: SID,
		event: { type: "content_block_delta", delta: { type: "text_delta", text } },
	});
const finalLine = (text: string) =>
	line({
		type: "assistant",
		session_id: SID,
		message: { role: "assistant", content: [{ type: "text", text }] },
	});
const resultLine = (subtype = "success") =>
	line({ type: "result", subtype, session_id: SID });

function setup(overrides: Partial<ResidentBrainOptions> = {}) {
	const runner = new FakeProcessRunner();
	const events: ResidentBrainEvent[] = [];
	const brain = new ResidentClaudeBrain({
		claudeBin: "claude",
		identityFile: identityFile(),
		runner,
		onEvent: (e) => events.push(e),
		...overrides,
	});
	brains.push(brain);
	const handle = (i?: number): FakeProcessHandle =>
		runner.handles[i ?? runner.handles.length - 1];
	return { runner, brain, events, handle };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
		await new Promise((r) => setTimeout(r, 5));
	}
}

async function drain(iter: AsyncIterable<string>): Promise<string[]> {
	const out: string[] = [];
	for await (const c of iter) out.push(c);
	return out;
}

const signal = () => new AbortController().signal;

/** decode the user frames off the wire (JSON-escaped) into their prompt texts. */
function userTexts(h: FakeProcessHandle): string[] {
	return h.written
		.join("")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l) as {
					type?: string;
					message?: { content?: { text?: string }[] };
				};
			} catch {
				return null;
			}
		})
		.filter((o) => o?.type === "user")
		.map((o) => (o?.message?.content ?? []).map((c) => c.text ?? "").join(""));
}

/** start a turn and wait until its user frame reached the child's stdin. */
async function startTurn(
	brain: ResidentClaudeBrain,
	h: FakeProcessHandle,
	text: string,
	sig = signal(),
): Promise<{ done: Promise<string[]> }> {
	const before = h.written.length;
	const done = drain(brain.respond({ text, history: [] }, { signal: sig }));
	done.catch(() => {}); // inspected later; avoid unhandled-rejection noise
	await waitFor(() => h.written.length > before);
	return { done };
}

describe("ResidentClaudeBrain — spawn shape", () => {
	it("spawns ONE resident process with frozen safety flags; prompt via stdin, never argv", async () => {
		const { runner, brain, handle } = setup({ model: "sonnet" });
		const { done } = await startTurn(brain, handle(), "hi resident");
		handle().emitStdout(initLine() + deltaLine("好") + resultLine());
		await done;
		const argv = runner.spawnCalls[0].args;
		expect(argv).toContain("-p");
		expect(argv).toContain("--input-format");
		expect(argv).toContain("stream-json");
		expect(argv).toContain("--include-partial-messages");
		expect(argv).toContain("--strict-mcp-config");
		expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
		expect(argv[argv.indexOf("--settings") + 1]).toContain(
			'"alwaysThinkingEnabled":false',
		);
		expect(argv).toContain("--model");
		expect(argv).toContain("sonnet");
		expect(argv).toContain("--append-system-prompt-file");
		expect(argv.join(" ")).not.toContain("hi resident");
		expect(argv.join(" ")).not.toContain("SECRET_PERSONA_MARKER");
		expect(runner.spawnCalls.length).toBe(1);
	});

	it("construction fails loud on a non-positive turn timeout (FLY-1158 root cause #1)", () => {
		const runner = new FakeProcessRunner();
		expect(
			() =>
				new ResidentClaudeBrain({
					claudeBin: "claude",
					identityFile: identityFile(),
					runner,
					turnTimeoutMs: 0,
				}),
		).toThrow(/turnTimeoutMs/);
		expect(runner.spawnCalls.length).toBe(0);
	});

	it("fails fast when the identity file is missing", () => {
		expect(
			() =>
				new ResidentClaudeBrain({
					claudeBin: "claude",
					identityFile: "/no/such/id.md",
					runner: new FakeProcessRunner(),
				}),
		).toThrow(/identity/);
	});
});

describe("ResidentClaudeBrain — turns", () => {
	it("serves multiple turns on the SAME process, yields deltas only (final-echo suppressed)", async () => {
		const { runner, brain, handle } = setup();
		const h = handle();

		const t1 = await startTurn(brain, h, "turn one");
		h.emitStdout(initLine() + deltaLine("你") + deltaLine("好"));
		h.emitStdout(finalLine("你好") + resultLine());
		expect(await t1.done).toEqual(["你", "好"]);

		const t2 = await startTurn(brain, h, "turn two");
		h.emitStdout(deltaLine("再见") + finalLine("再见") + resultLine());
		expect(await t2.done).toEqual(["再见"]);

		expect(runner.spawnCalls.length).toBe(1); // zero per-turn spawn
		expect(brain.health().turns).toBe(2);
		expect(brain.health().sessionId).toBe(SID);
	});

	it("falls back to the assistant-final text ONLY when a turn produced no delta", async () => {
		const { brain, handle } = setup();
		const h = handle();
		const t = await startTurn(brain, h, "no partials this turn");
		h.emitStdout(finalLine("完整回答。") + resultLine());
		expect(await t.done).toEqual(["完整回答。"]);
	});

	it("first turn injects voice-context via stdin; later turns do not repeat it after a success", async () => {
		const { brain, handle } = setup({
			voiceContext: "VOICE_REGISTER_MARKER",
			sessionPreamble: "MEETING_PREAMBLE_MARKER",
		});
		const h = handle();
		const t1 = await startTurn(brain, h, "first");
		expect(h.written.join("")).toContain("VOICE_REGISTER_MARKER");
		expect(h.written.join("")).toContain("MEETING_PREAMBLE_MARKER");
		h.emitStdout(initLine() + deltaLine("ok") + resultLine());
		await t1.done;

		const before = h.written.join("");
		const t2 = await startTurn(brain, h, "second");
		h.emitStdout(deltaLine("ok") + resultLine());
		await t2.done;
		const secondFrame = h.written.join("").slice(before.length);
		expect(secondFrame).not.toContain("VOICE_REGISTER_MARKER");
	});

	it("serializes turns: a new respond() waits for the previous turn's terminal result", async () => {
		const { brain, handle } = setup();
		const h = handle();
		const t1 = await startTurn(brain, h, "slow turn");
		const done2 = drain(
			brain.respond({ text: "queued turn", history: [] }, { signal: signal() }),
		);
		done2.catch(() => {});
		await tick();
		// only ONE user frame on the wire while turn 1 is in flight
		expect(h.written.filter((w) => w.includes('"type":"user"')).length).toBe(1);
		h.emitStdout(deltaLine("一") + resultLine());
		expect(await t1.done).toEqual(["一"]);
		await waitFor(
			() => h.written.filter((w) => w.includes('"type":"user"')).length === 2,
		);
		h.emitStdout(deltaLine("二") + resultLine());
		expect(await done2).toEqual(["二"]);
	});
});

describe("ResidentClaudeBrain — interrupt", () => {
	it("interrupt() writes an in-band control_request and the error_during_execution terminal is whitelisted (clean end, process alive)", async () => {
		const { runner, brain, handle } = setup();
		const h = handle();
		const t = await startTurn(brain, h, "count to fifty");
		h.emitStdout(deltaLine("一、"));
		await tick();
		const barrier = brain.interrupt();
		await waitFor(() =>
			h.written.some((w) => w.includes('"subtype":"interrupt"')),
		);
		h.emitStdout(resultLine("error_during_execution"));
		await barrier; // resolves at the turn's terminal result
		expect(await t.done).toEqual(["一、"]); // clean end, no throw
		expect(h.kills).toEqual([]); // process survives
		expect(runner.spawnCalls.length).toBe(1);
	});

	it("interrupt barrier timeout → SIGKILL → respawn with --resume", async () => {
		const { runner, brain, handle } = setup({ interruptGraceMs: 20 });
		const h = handle();
		const t = await startTurn(brain, h, "unresponsive turn");
		h.emitStdout(initLine()); // session id observed
		const barrier = brain.interrupt();
		await waitFor(() => h.kills.includes("SIGKILL"));
		h.emitExit(null, "SIGKILL");
		await barrier;
		await t.done; // externally interrupted turn ends clean even on the kill path
		await waitFor(() => runner.spawnCalls.length === 2);
		expect(runner.spawnCalls[1].args).toContain("--resume");
		expect(runner.spawnCalls[1].args).toContain(SID);
	});

	it("AbortSignal → in-band interrupt (NOT SIGKILL — per-turn semantics stay in HeadlessClaudeBrain); respond throws cancelled", async () => {
		const { runner, brain, handle } = setup();
		const h = handle();
		const ctrl = new AbortController();
		const t = await startTurn(brain, h, "aborted turn", ctrl.signal);
		ctrl.abort();
		await waitFor(() =>
			h.written.some((w) => w.includes('"subtype":"interrupt"')),
		);
		h.emitStdout(resultLine("error_during_execution"));
		const err = await t.done.catch((e) => e);
		expect((err as VoiceError).code).toBe("cancelled");
		expect(h.kills).toEqual([]);
		expect(runner.spawnCalls.length).toBe(1);
	});

	it("abort while QUEUED behind another turn: the cancelled turn never reaches the wire (Codex #550 R1)", async () => {
		const { brain, handle } = setup();
		const h = handle();
		const t1 = await startTurn(brain, h, "in flight");
		const ctrl = new AbortController();
		const done2 = drain(
			brain.respond(
				{ text: "queued then cancelled", history: [] },
				{ signal: ctrl.signal },
			),
		);
		done2.catch(() => {});
		ctrl.abort();
		h.emitStdout(deltaLine("一") + resultLine());
		await t1.done;
		const err = await done2.catch((e) => e);
		expect((err as VoiceError).code).toBe("cancelled");
		await tick();
		expect(h.written.filter((w) => w.includes('"type":"user"')).length).toBe(1);
	});

	it("interrupted turn ending with a NON-whitelisted subtype fails loud — only error_during_execution is a normal interrupted ending (Codex #550 R1)", async () => {
		const { brain, handle } = setup();
		const h = handle();
		const t = await startTurn(brain, h, "q");
		const barrier = brain.interrupt();
		await waitFor(() =>
			h.written.some((w) => w.includes('"subtype":"interrupt"')),
		);
		h.emitStdout(resultLine("error_max_turns"));
		await barrier;
		const err = await t.done.catch((e) => e);
		expect((err as VoiceError).code).toBe("subprocess-failed");
	});

	it("watchdog: turn timeout → interrupt; grace expiry → SIGKILL → respawn; respond throws timeout", async () => {
		const { runner, brain, handle } = setup({
			turnTimeoutMs: 30,
			interruptGraceMs: 20,
		});
		const h = handle();
		const t = await startTurn(brain, h, "hung turn");
		await waitFor(() =>
			h.written.some((w) => w.includes('"subtype":"interrupt"')),
		);
		await waitFor(() => h.kills.includes("SIGKILL"));
		h.emitExit(null, "SIGKILL");
		const err = await t.done.catch((e) => e);
		expect((err as VoiceError).code).toBe("timeout");
		await waitFor(() => runner.spawnCalls.length === 2);
	});
});

describe("ResidentClaudeBrain — crash semantics (no blind replay)", () => {
	it("out-of-turn crash → background respawn with --resume; memory path via session id", async () => {
		const { runner, brain, events, handle } = setup();
		const h = handle();
		const t1 = await startTurn(brain, h, "remember cyan");
		h.emitStdout(initLine() + deltaLine("记住了") + resultLine());
		await t1.done;

		h.emitExit(1, null); // crash OUTSIDE a turn
		await waitFor(() => runner.spawnCalls.length === 2);
		expect(runner.spawnCalls[1].args).toContain("--resume");
		expect(runner.spawnCalls[1].args).toContain(SID);
		expect(
			events.some((e) => e.type === "state" && e.state === "recovering"),
		).toBe(true);
		expect(events.some((e) => e.type === "respawned")).toBe(true);

		const h2 = handle();
		const t2 = await startTurn(brain, h2, "what color?");
		h2.emitStdout(deltaLine("青色") + resultLine());
		expect(await t2.done).toEqual(["青色"]);
	});

	it("crash before any session id → FRESH process + preamble/context re-injection (no --resume)", async () => {
		const { runner, brain, handle } = setup({
			voiceContext: "VOICE_REGISTER_MARKER",
		});
		expect(brain.appendContext("fact-alpha").accepted).toBe(true);
		handle().emitExit(1, null); // first process dies before any turn
		await waitFor(() => runner.spawnCalls.length === 2);
		expect(runner.spawnCalls[1].args).not.toContain("--resume");

		const h2 = handle();
		const t = await startTurn(brain, h2, "hello");
		const frame = userTexts(h2)[0];
		expect(frame).toContain("VOICE_REGISTER_MARKER");
		expect(frame).toContain("fact-alpha");
		expect(frame).toContain('seq="1"');
		h2.emitStdout(deltaLine("ok") + resultLine());
		await t.done;
	});

	it("mid-turn crash: respond throws subprocess-failed, recovering event fires, and the turn is NOT replayed", async () => {
		const { runner, brain, events, handle } = setup();
		const h = handle();
		const t = await startTurn(brain, h, "half spoken");
		h.emitStdout(initLine() + deltaLine("半句"));
		await tick();
		h.emitExit(null, "SIGKILL");
		const err = await t.done.catch((e) => e);
		expect((err as VoiceError).code).toBe("subprocess-failed");
		expect(
			events.some((e) => e.type === "state" && e.state === "recovering"),
		).toBe(true);
		await waitFor(() => runner.spawnCalls.length === 2);
		// NO user frame auto-written on the fresh child — replay is the consumer's decision
		expect(
			handle().written.filter((w) => w.includes('"type":"user"')).length,
		).toBe(0);
	});

	it("missing claude binary (real spawn ENOENT): fail-loud failed state, never an eternal thinking freeze (Codex #550 R1)", async () => {
		const events: ResidentBrainEvent[] = [];
		const brain = new ResidentClaudeBrain({
			claudeBin: "/no/such/claude-fly1160",
			identityFile: identityFile(),
			runner: new NodeProcessRunner(),
			maxRespawns: 1,
			onEvent: (e) => events.push(e),
		});
		brains.push(brain);
		await waitFor(() => brain.health().state === "failed");
		const err = await drain(
			brain.respond({ text: "hi", history: [] }, { signal: signal() }),
		).catch((e) => e);
		expect((err as VoiceError).code).toBe("subprocess-failed");
	});

	it("respawn rate-limit: over maxRespawns in the window → state=failed, fail-loud, no more spawns", async () => {
		const { runner, brain, events, handle } = setup({ maxRespawns: 2 });
		handle().emitExit(1, null);
		await waitFor(() => runner.spawnCalls.length === 2);
		handle().emitExit(1, null);
		await waitFor(() => runner.spawnCalls.length === 3);
		handle().emitExit(1, null);
		await tick();
		expect(runner.spawnCalls.length).toBe(3); // third respawn refused
		expect(brain.health().state).toBe("failed");
		expect(events.some((e) => e.type === "state" && e.state === "failed")).toBe(
			true,
		);
		const err = await drain(
			brain.respond({ text: "hi", history: [] }, { signal: signal() }),
		).catch((e) => e);
		expect((err as VoiceError).code).toBe("subprocess-failed");
	});

	it("lifetime expiry emits ONE event and nothing else — landing belongs to the orchestrator", async () => {
		const { runner, events, handle } = setup({ maxLifetimeMs: 30 });
		await waitFor(() => events.some((e) => e.type === "lifetime-expiry"));
		expect(handle().kills).toEqual([]);
		expect(runner.spawnCalls.length).toBe(1);
	});
});

describe("ResidentClaudeBrain — appendContext (silent context, ack = normal terminal result)", () => {
	it("bounded cache: accepts until the byte cap, then accepted:false (caller HOLDs its cursor)", () => {
		const { brain } = setup();
		expect(brain.appendContext("a".repeat(200 * 1024))).toMatchObject({
			accepted: true,
			seq: 1,
		});
		expect(brain.appendContext("b".repeat(100 * 1024)).accepted).toBe(false);
		expect(brain.appendContext("small fits").accepted).toBe(true);
	});

	it("context rides the NEXT turn (never self-triggers), acks on success with context-drained{upToSeq}", async () => {
		const { brain, events, handle } = setup();
		const h = handle();
		expect(brain.appendContext("fact-one").seq).toBe(1);
		expect(brain.appendContext("fact-two").seq).toBe(2);
		await tick();
		// silent: nothing written yet
		expect(h.written.length).toBe(0);

		const t1 = await startTurn(brain, h, "question");
		const frame1 = userTexts(h)[0];
		expect(frame1).toContain('seq="1"');
		expect(frame1).toContain("fact-one");
		expect(frame1).toContain('seq="2"');
		// arrives DURING the turn → next turn, not this frame
		expect(brain.appendContext("fact-three").seq).toBe(3);
		h.emitStdout(deltaLine("答") + resultLine());
		await t1.done;
		const drainedEvent = events.find((e) => e.type === "context-drained");
		expect(drainedEvent).toMatchObject({ upToSeq: 2 });

		const t2 = await startTurn(brain, h, "next question");
		const frame2 = userTexts(h)[1];
		expect(frame2).not.toContain("fact-one");
		expect(frame2).toContain('seq="3"');
		h.emitStdout(deltaLine("好") + resultLine());
		await t2.done;
	});

	it("interrupted turn does NOT ack: same seq re-injected next turn (explicit repeat over silent loss)", async () => {
		const { brain, events, handle } = setup();
		const h = handle();
		brain.appendContext("must-not-vanish");
		const t1 = await startTurn(brain, h, "q1");
		const barrier = brain.interrupt();
		await waitFor(() =>
			h.written.some((w) => w.includes('"subtype":"interrupt"')),
		);
		h.emitStdout(resultLine("error_during_execution"));
		await barrier;
		await t1.done;
		expect(events.some((e) => e.type === "context-drained")).toBe(false);

		const t2 = await startTurn(brain, h, "q2");
		const frame2 = userTexts(h)[1];
		expect(frame2).toContain("must-not-vanish");
		expect(frame2).toContain('seq="1"');
		h.emitStdout(deltaLine("ok") + resultLine());
		await t2.done;
		expect(events.some((e) => e.type === "context-drained")).toBe(true);
	});

	it("mid-turn crash after the frame drained: context survives, re-injected on the fresh child, cleared only after a normal result", async () => {
		const { brain, events, handle } = setup();
		const h = handle();
		brain.appendContext("crash-surviving-fact");
		const t1 = await startTurn(brain, h, "q1");
		h.emitExit(null, "SIGKILL"); // frame already handed over, then killed
		await t1.done.catch(() => {});
		await waitFor(() => handle() !== h);

		const h2 = handle();
		const t2 = await startTurn(brain, h2, "q2");
		const frame = userTexts(h2)[0];
		expect(frame).toContain("crash-surviving-fact");
		expect(frame).toContain('seq="1"');
		h2.emitStdout(deltaLine("ok") + resultLine());
		await t2.done;
		expect(events.some((e) => e.type === "context-drained")).toBe(true);
		expect(brain.appendContext("post").seq).toBe(2);
	});
});

describe("ResidentClaudeBrain — stdin backpressure (§3.1b three-way split)", () => {
	it(">64KB single frame is chunk-written through drain waits — payload size NEVER triggers a kill", async () => {
		const { runner, brain, handle } = setup();
		const h = handle();
		h.writesBeforeBlock = 3; // accept 3 slices, then backpressure
		const bigText = `HEAD-${"x".repeat(100 * 1024)}-TAIL`;
		const t = await startTurn(brain, h, bigText);
		await tick();
		expect(h.kills).toEqual([]);
		h.emitDrain(); // child caught up — remainder flows
		await waitFor(() => h.written.join("").includes("-TAIL"));
		expect(h.kills).toEqual([]);
		expect(runner.spawnCalls.length).toBe(1);
		h.emitStdout(deltaLine("ok") + resultLine());
		await t.done;
	});

	it("wedge detection: NEW data piling up beyond the pending cap while drain stalls → kill (recovery path)", async () => {
		const { brain, handle } = setup();
		const h = handle();
		h.writesBeforeBlock = 0; // stdin accepts nothing — drain stalled
		const t = await startTurn(brain, h, "stuck frame");
		await tick();
		(brain as any).writeFrame(`{"pad":"${"y".repeat(70 * 1024)}"}\n`);
		expect(h.kills).toContain("SIGKILL");
		h.emitExit(null, "SIGKILL");
		await t.done.catch(() => {});
	});
});

describe("ResidentClaudeBrain — dispose", () => {
	it("dispose ladder: EOF → eofGrace → SIGTERM → termGrace → SIGKILL with budgets verbatim (fake-timer sentinel)", async () => {
		vi.useFakeTimers();
		const { brain, handle } = setup(); // defaults: eofGraceMs 2000, termGraceMs 2000
		const h = handle();
		const p = brain.dispose();
		await vi.advanceTimersByTimeAsync(0);
		expect(h.stdinClosed).toBe(true);
		await vi.advanceTimersByTimeAsync(1999);
		expect(h.kills).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.kills).toEqual(["SIGTERM"]);
		await vi.advanceTimersByTimeAsync(1999);
		expect(h.kills).toEqual(["SIGTERM"]);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.kills).toEqual(["SIGTERM", "SIGKILL"]);
		h.emitExit(null, "SIGKILL");
		await vi.advanceTimersByTimeAsync(0);
		await p;
		expect(brain.health().state).toBe("closed");
	});

	it("dispose exits at the first rung when the child leaves cleanly on EOF (spike-verified path)", async () => {
		const { brain, handle } = setup({ eofGraceMs: 200 });
		const h = handle();
		const p = brain.dispose();
		await waitFor(() => h.stdinClosed);
		h.emitExit(0, null);
		await p;
		expect(h.kills).toEqual([]);
		expect(brain.health().state).toBe("closed");
	});

	it("dispose during an in-flight turn interrupts FIRST (barrier), then closes; respond ends without replay", async () => {
		const { brain, handle } = setup({ interruptGraceMs: 30 });
		const h = handle();
		const t = await startTurn(brain, h, "mid turn");
		const d = brain.dispose();
		await waitFor(() =>
			h.written.some((w) => w.includes('"subtype":"interrupt"')),
		);
		h.emitStdout(resultLine("error_during_execution"));
		await waitFor(() => h.stdinClosed);
		h.emitExit(0, null);
		await d;
		await t.done; // interrupted turn ends clean
		const err = await drain(
			brain.respond({ text: "late", history: [] }, { signal: signal() }),
		).catch((e) => e);
		expect((err as VoiceError).code).toBe("cancelled");
		expect(brain.appendContext("late").accepted).toBe(false);
	});

	it("forceKill is synchronous SIGKILL (shutdown hard-timer path)", () => {
		const { brain, handle } = setup();
		brain.forceKill();
		expect(handle().kills).toContain("SIGKILL");
	});
});
