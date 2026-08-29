#!/usr/bin/env node
/**
 * FLY-1160 spike — resident claude CLI session via stream-json input mode.
 *
 * Verifies the 4 load-bearing claims of the design (exploration §3 option A):
 *   1. one process serves MULTIPLE turns (no per-turn spawn)
 *   2. warm-turn latency: t(user message written) → t(first text_delta)
 *   3. session_id is captured from the stream (crash → --resume path)
 *   4. in-band interrupt: control_request {subtype:"interrupt"} cancels an
 *      in-flight turn without killing the process
 * Then proves the recovery path: kill the process, `--resume <sessionId>` a
 * fresh one, and check the conversation memory survived.
 *
 * Run: node spike-resident-stream-json.mjs [modelArg]
 *   modelArg e.g. "haiku" | "sonnet" — omitted = CLI default.
 */
import { spawn } from "node:child_process";

const MODEL = process.argv[2];
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const now = () => Date.now();
const log = (s) =>
	console.log(`[spike +${((now() - T0) / 1000).toFixed(2)}s] ${s}`);
const T0 = now();

const baseArgs = [
	"-p",
	"--input-format",
	"stream-json",
	"--output-format",
	"stream-json",
	"--include-partial-messages",
	"--verbose",
	"--tools",
	"",
	"--strict-mcp-config",
	"--append-system-prompt",
	"你是语音助手 spike 测试。用一句简短中文回答。记住对话内容。",
	...(MODEL ? ["--model", MODEL] : []),
];

function userMsg(text) {
	return `${JSON.stringify({
		type: "user",
		message: { role: "user", content: [{ type: "text", text }] },
	})}\n`;
}

function interruptMsg(id) {
	return `${JSON.stringify({
		type: "control_request",
		request_id: id,
		request: { subtype: "interrupt" },
	})}\n`;
}

class Child {
	constructor(args) {
		this.proc = spawn(CLAUDE, args, { stdio: ["pipe", "pipe", "pipe"] });
		this.buf = "";
		this.handlers = new Set();
		this.sessionId = undefined;
		this.proc.stdout.on("data", (c) => this.onData(c.toString("utf8")));
		this.proc.stderr.on("data", (c) => {
			const s = c.toString("utf8").trim();
			if (s) console.error(`[stderr] ${s.slice(0, 300)}`);
		});
		this.exited = new Promise((res) =>
			this.proc.on("exit", (code) => res(code)),
		);
	}
	onData(chunk) {
		this.buf += chunk;
		let i;
		// biome-ignore lint/suspicious/noAssignInExpressions: spike loop, kept as-run
		while ((i = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, i);
			this.buf = this.buf.slice(i + 1);
			if (!line.trim()) continue;
			let obj;
			try {
				obj = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof obj.session_id === "string") this.sessionId = obj.session_id;
			for (const h of [...this.handlers]) h(obj);
		}
	}
	on(h) {
		this.handlers.add(h);
		return () => this.handlers.delete(h);
	}
	write(s) {
		this.proc.stdin.write(s);
	}
}

/** send one turn, resolve {ttftMs, totalMs, text} on result event. */
function turn(child, text, { interruptAfterMs } = {}) {
	return new Promise((resolve, reject) => {
		const t0 = now();
		let tFirst;
		let acc = "";
		let interrupted = false;
		const timer = setTimeout(() => {
			off();
			reject(new Error(`turn timeout 120s (acc="${acc.slice(0, 80)}")`));
		}, 120_000);
		let intTimer;
		if (interruptAfterMs) {
			intTimer = setTimeout(() => {
				log(`>> sending control_request interrupt`);
				interrupted = true;
				child.write(interruptMsg(`req-${t0}`));
			}, interruptAfterMs);
		}
		const off = child.on((obj) => {
			const ev = obj.event;
			if (
				ev?.type === "content_block_delta" &&
				ev.delta?.type === "text_delta"
			) {
				if (tFirst === undefined) tFirst = now();
				acc += ev.delta.text;
			}
			if (obj.type === "control_response") {
				log(`<< control_response: ${JSON.stringify(obj).slice(0, 200)}`);
			}
			if (obj.type === "result") {
				clearTimeout(timer);
				if (intTimer) clearTimeout(intTimer);
				off();
				resolve({
					ttftMs: tFirst === undefined ? -1 : tFirst - t0,
					totalMs: now() - t0,
					text: acc,
					interrupted,
					resultSubtype: obj.subtype,
				});
			}
		});
		child.write(userMsg(text));
	});
}

const main = async () => {
	log(`spawning resident: ${CLAUDE} ${baseArgs.join(" ").slice(0, 120)}...`);
	const child = new Child(baseArgs);
	const tSpawn = now();
	// FINDING (first run): in stream-json input mode NO init event arrives before
	// the first user message — a resident impl must NOT block on init. Record it
	// whenever it shows up instead.
	child.on((o) => {
		if (o.type === "system" && o.subtype === "init") {
			log(
				`init event observed — spawn→init ${now() - tSpawn} ms; session_id=${child.sessionId}`,
			);
		}
	});

	const t1 = await turn(
		child,
		"我最喜欢的颜色是青色。记住它。然后用一句话确认。",
	);
	log(
		`TURN1 ttft=${t1.ttftMs}ms total=${t1.totalMs}ms text="${t1.text.slice(0, 60)}"`,
	);
	const t2 = await turn(child, "我刚才说我最喜欢的颜色是什么?");
	log(
		`TURN2(warm) ttft=${t2.ttftMs}ms total=${t2.totalMs}ms text="${t2.text.slice(0, 60)}"`,
	);
	const memoryOk = t2.text.includes("青");
	log(`in-session memory: ${memoryOk ? "PASS" : "FAIL"}`);
	const t3 = await turn(child, "从 1 数到 50,每个数字一行。", {
		interruptAfterMs: 1500,
	});
	log(
		`TURN3(interrupt) ttft=${t3.ttftMs}ms total=${t3.totalMs}ms subtype=${t3.resultSubtype} len=${t3.text.length}`,
	);
	const aliveAfterInterrupt = child.proc.exitCode === null;
	log(
		`process alive after interrupt: ${aliveAfterInterrupt ? "PASS" : "FAIL"}`,
	);
	const t4 = await turn(child, "好,继续:我最喜欢的颜色还记得吗?一句话。");
	log(
		`TURN4(post-interrupt) ttft=${t4.ttftMs}ms total=${t4.totalMs}ms text="${t4.text.slice(0, 60)}"`,
	);

	const sessionId = child.sessionId;
	log(`killing resident (simulate crash); sessionId=${sessionId}`);
	child.proc.kill("SIGKILL");
	await child.exited;

	// recovery: fresh resident with --resume (no init-wait — see FINDING above)
	const child2 = new Child([...baseArgs, "--resume", sessionId]);
	const t5 = await turn(child2, "崩溃恢复测试:我最喜欢的颜色是什么?一句话。");
	log(
		`TURN5(post---resume) ttft=${t5.ttftMs}ms total=${t5.totalMs}ms text="${t5.text.slice(0, 60)}"`,
	);
	log(`resume memory: ${t5.text.includes("青") ? "PASS" : "FAIL"}`);
	child2.proc.stdin.end();
	await child2.exited;
	log("done — resident exits cleanly on stdin EOF");
};

main().catch((e) => {
	console.error("SPIKE FAIL:", e);
	process.exit(1);
});
