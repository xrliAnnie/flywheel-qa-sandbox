#!/usr/bin/env node
// FLY-1439 deterministic fault-injection shim for flywheel-comm/dist/index.js.
// Install only in the exclusive QA checkout by first renaming the real entry
// to index.real.js. The slot directory is derived from DISCORD_STATE_DIR.
import {
	appendFileSync,
	chmodSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const realCli = join(scriptDir, "index.real.js");
const stateDir = process.env.DISCORD_STATE_DIR;
const slotDir =
	process.env.FLY1439_QA_SLOT_DIR ||
	(stateDir ? dirname(resolve(stateDir)) : undefined);

if (!slotDir) {
	process.stderr.write(
		"FLY-1439 shim requires DISCORD_STATE_DIR or FLY1439_QA_SLOT_DIR\n",
	);
	process.exit(70);
}

const ledgerPath = join(slotDir, "shim-ledger.jsonl");
const modePath = join(slotDir, "shim-mode");
const callId = randomUUID();
const startedAt = Date.now();
const sub =
	argv[0] === "chat-receipt" && typeof argv[1] === "string"
		? argv[1]
		: undefined;
const flag = (name) => {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
};
const messageId = flag("--message-id");
let mode = "passthrough";

try {
	mode = readFileSync(modePath, "utf8").trim() || "passthrough";
} catch (error) {
	if (error?.code !== "ENOENT") throw error;
}

const append = (record) => {
	appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	chmodSync(ledgerPath, 0o600);
};
const finish = (exit) => {
	append({
		callId,
		phase: "end",
		ts: new Date().toISOString(),
		exit,
		durMs: Date.now() - startedAt,
	});
};

append({
	callId,
	phase: "start",
	ts: new Date(startedAt).toISOString(),
	argv,
	mode,
});

if (sub === "begin" && mode === "fail-begin") {
	process.stderr.write("FLY-1439 injected fail-begin\n");
	finish(1);
	process.exit(1);
}

if (
	messageId &&
	((sub === "complete" && mode === "hang-complete") ||
		(sub === "settle" && mode === "hang-settle"))
) {
	const barrierPath = join(slotDir, `shim-barrier-${sub}-${messageId}.json`);
	const tempPath = `${barrierPath}.${process.pid}.tmp`;
	writeFileSync(
		tempPath,
		`${JSON.stringify({
			shimPid: process.pid,
			callId,
			sub,
			msgId: messageId,
			ts: new Date().toISOString(),
		})}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	chmodSync(tempPath, 0o600);
	renameSync(tempPath, barrierPath);
	// No signal handler on the injected hang path: the runtime's SIGTERM (or
	// the driver's exact-PID cleanup) must leave start-without-end evidence.
	await new Promise(() => {
		setInterval(() => {}, 60_000);
	});
}

const child = spawn(process.execPath, [realCli, ...argv], {
	stdio: "inherit",
});

for (const signal of ["SIGTERM", "SIGINT"]) {
	process.on(signal, () => {
		if (!child.killed) child.kill(signal);
	});
}

child.once("error", (error) => {
	process.stderr.write(`FLY-1439 shim spawn failed: ${error.message}\n`);
	finish(1);
	process.exit(1);
});
child.once("exit", (code, signal) => {
	const exit = typeof code === "number" ? code : signal ? 128 : 1;
	finish(exit);
	process.exit(exit);
});
