#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
// FLY-1547 R2-F4 spike: the proposed v2 codex RUNNER form — remote-control
// daemon + thread/start + first bootstrap turn; later a second connection sends
// the bell turn. Phase argument: "boot" | "bell".
import {
	CodexDaemonClient,
	connectDaemonTransport,
	spawnCodexDaemon,
} from "/Users/xiaorongli/Dev/flywheel-FLY-1547/packages/claude-runner/dist/index.js";

const HOME = "/tmp/f47home";
const SOCK = "/tmp/f47sock/app.sock";
const CWD = "/tmp/f47cwd";
const STATE = "/tmp/f47home/spike-state.json";
const phase = process.argv[2];

async function client() {
	const transport = await connectDaemonTransport({
		socketPath: SOCK,
		connectTimeoutMs: 10_000,
	});
	const c = new CodexDaemonClient({ transport, clientName: "fly1547-spike" });
	await c.initialize();
	return c;
}

if (phase === "boot") {
	const handle = await spawnCodexDaemon({
		codexBin: "codex",
		codexHome: HOME,
		socketPath: SOCK,
		logger: (m) => console.log(`[daemon] ${m}`),
	});
	console.log(`[spike] daemon pid=${handle.pid}`);
	const c = await client();
	const threadId = await c.startThread({
		cwd: CWD,
		sandbox: "workspace-write",
		approvalPolicy: "never",
	});
	console.log(`[spike] threadId=${threadId}`);
	await c.startTurn(
		threadId,
		"You are a FLY-1547 spike runner session. Say READY and wait silently.",
		120_000,
		"fly1547-bootstrap-turn",
	);
	console.log("[spike] bootstrap turn completed");
	writeFileSync(STATE, JSON.stringify({ threadId, daemonPid: handle.pid }));
	c.close?.();
	process.exit(0);
} else if (phase === "bell") {
	const { threadId } = JSON.parse(readFileSync(STATE, "utf8"));
	const c = await client();
	await c.startTurn(
		threadId,
		"[flywheel-v2 mailbox bell] 你有新信(2 封 pending,最老 kind=instruction)。这是经远控 daemon turn/start 注入的铃指针。请回复 BELL-RECEIVED。",
		120_000,
		"fly1547-bell-1",
	);
	console.log("[spike] bell turn completed");
	c.close?.();
	process.exit(0);
} else {
	console.error("usage: remote-runner-spike.mjs boot|bell");
	process.exit(2);
}
