import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { livenessCommand } from "../lib/qa-fly-2456-liveness.mjs";

test("actual one-command wrapper probes a temporary socket process and emits all ownership fields", async (t) => {
	const root = mkdtempSync("/tmp/f2456-live-");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const stateDir = join(root, "sessions"),
		socketRoot = join(root, "sock"),
		executionId = "fixture-exec";
	mkdirSync(join(stateDir, executionId), { recursive: true });
	mkdirSync(socketRoot);
	const socketPath = join(
		socketRoot,
		`${createHash("sha1").update(executionId).digest("hex").slice(0, 16)}.sock`,
	);
	const child = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			"import net from 'node:net';net.createServer(s=>s.end()).listen(process.argv[1],()=>process.stdout.write('ready\\n'));",
			socketPath,
		],
		{ detached: true, stdio: ["ignore", "pipe", "pipe"] },
	);
	t.after(async () => {
		if (child.exitCode === null) {
			child.kill("SIGTERM");
			await once(child, "exit");
		}
	});
	await Promise.race([
		once(child.stdout, "data"),
		once(child, "exit").then(() => {
			throw new Error("fixture exited before ready");
		}),
		new Promise((_, reject) => {
			const timer = setTimeout(
				() => reject(new Error("fixture startup timeout")),
				5000,
			);
			timer.unref();
		}),
	]);
	const pgid = child.pid; // detached child is the fixture process-group leader
	const sessionFile = join(stateDir, executionId, "session.json");
	writeFileSync(sessionFile, JSON.stringify({ daemonPgid: pgid }));
	const command = livenessCommand({
		runtimeModule: resolve(
			"packages/claude-runner/dist/codex-daemon-runtime.js",
		),
		stateDir,
		socketRoot,
		markerDir: join(root, "markers"),
		executions: [executionId],
	});
	const rows = JSON.parse(
		execFileSync("/bin/bash", ["-c", command], {
			encoding: "utf8",
			timeout: 15000,
			env: { ...process.env, BASH_ENV: "/dev/null" },
		}),
	);
	assert.equal(rows.length, 1);
	const r = rows[0];
	assert.equal(r.executionId, executionId);
	assert.equal(r.verdict, "alive", JSON.stringify(r));
	assert.equal(r.socketPath, socketPath);
	assert.equal(r.persistedPgidBefore, pgid);
	assert.equal(r.persistedPgidAfter, pgid);
	assert.equal(r.groupState, "alive");
	assert.ok(r.holderPids.some((p) => p.pid === child.pid && p.pgid === pgid));
	writeFileSync(sessionFile, JSON.stringify({ daemonPid: pgid }));
	const fallback = JSON.parse(
		execFileSync("/bin/bash", ["-c", command], {
			encoding: "utf8",
			timeout: 15000,
			env: { ...process.env, BASH_ENV: "/dev/null" },
		}),
	);
	assert.equal(fallback[0].persistedPgidBefore, pgid);
	assert.equal(fallback[0].verdict, "alive");
});
