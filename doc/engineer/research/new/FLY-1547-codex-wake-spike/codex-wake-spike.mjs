#!/usr/bin/env node
// FLY-1547 F5 spike: can an external `codex app-server` resume the thread of a
// LIVE plain-TUI codex session and start a bell turn? Records every frame.
import { spawn } from "node:child_process";

const threadId = process.argv[2];
if (!threadId) {
	console.error("usage: codex-wake-spike.mjs <threadId>");
	process.exit(2);
}

const child = spawn("codex", ["app-server"], {
	stdio: ["pipe", "pipe", "pipe"],
});
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));

let nextId = 1;
const pending = new Map();
function request(method, params) {
	const id = nextId++;
	child.stdin.write(
		`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
	);
	return new Promise((resolve, reject) =>
		pending.set(id, { resolve, reject, method }),
	);
}
function notify(method, params) {
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

let buffered = "";
child.stdout.on("data", (chunk) => {
	buffered += chunk;
	let nl = buffered.indexOf("\n");
	while (nl >= 0) {
		const raw = buffered.slice(0, nl).trim();
		buffered = buffered.slice(nl + 1);
		if (raw) {
			let msg;
			try {
				msg = JSON.parse(raw);
			} catch {
				console.log(`[unparsed] ${raw.slice(0, 300)}`);
				nl = buffered.indexOf("\n");
				continue;
			}
			if (
				msg.id !== undefined &&
				(msg.result !== undefined || msg.error !== undefined) &&
				pending.has(msg.id)
			) {
				const p = pending.get(msg.id);
				pending.delete(msg.id);
				console.log(
					`[response:${p.method}] ${JSON.stringify(msg).slice(0, 500)}`,
				);
				msg.error
					? p.reject(new Error(JSON.stringify(msg.error)))
					: p.resolve(msg.result);
			} else if (msg.method) {
				console.log(
					`[notify] ${msg.method} ${JSON.stringify(msg.params ?? {}).slice(0, 300)}`,
				);
				if (msg.id !== undefined) {
					child.stdin.write(
						`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unsupported" } })}\n`,
					);
				}
			}
		}
		nl = buffered.indexOf("\n");
	}
});

const deadline = setTimeout(() => {
	console.log("[spike] 45s deadline — closing");
	child.kill();
	process.exit(0);
}, 45_000);

try {
	await request("initialize", {
		clientInfo: { name: "fly1547-spike", version: "0" },
		capabilities: {},
	});
	notify("initialized", {});
	const resumed = await request("thread/resume", {
		threadId,
		approvalPolicy: "never",
		sandbox: "workspace-write",
		cwd: "/tmp/fly1547-codex-spike-cwd",
	});
	const tid =
		resumed?.thread?.id ?? resumed?.threadId ?? resumed?.id ?? threadId;
	console.log(`[spike] resumed thread ${tid}`);
	const turn = await request("turn/start", {
		threadId: tid,
		input: [
			{
				type: "text",
				text: "[flywheel-v2 mailbox bell test] 你有新信。这是外部 app-server 经 turn/start 注入的铃。请回复 BELL-RECEIVED。",
			},
		],
	});
	console.log(
		`[spike] turn/start returned ${JSON.stringify(turn).slice(0, 300)}`,
	);
	// wait for turn events until deadline
} catch (error) {
	console.log(`[spike] FAILED: ${error.message}`);
	clearTimeout(deadline);
	child.kill();
	process.exit(1);
}
