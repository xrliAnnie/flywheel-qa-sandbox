import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../lib/config.mjs";

function fixture() {
	const stateDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-controls-")),
	);
	const cfg = resolveConfig({ FLYWHEEL_STATE_DIR: stateDir });
	const current = path.join(stateDir, "payload");
	fs.mkdirSync(path.join(current, "scripts/packaged"), { recursive: true });
	fs.mkdirSync(path.join(current, "scripts/lib"), { recursive: true });
	fs.writeFileSync(path.join(current, ".flywheel-prebuilt"), "1.2.3");
	fs.writeFileSync(
		path.join(current, "scripts/packaged/bootstrap-services.sh"),
		"# --only support\n",
	);
	fs.writeFileSync(
		path.join(current, "scripts/lib/supervisor.sh"),
		"# fixture\n",
	);
	fs.mkdirSync(cfg.runtimeRoot, { recursive: true });
	fs.symlinkSync(current, cfg.currentLink);
	return {
		cfg,
		current,
		marker: path.join(stateDir, "auto-update.off"),
		cleanup: () => fs.rmSync(stateDir, { recursive: true, force: true }),
	};
}

test("off persists disable marker even when supervisor stop fails", async () => {
	const { runAutoUpdate } = await import("../lib/auto-update.mjs");
	const f = fixture();
	try {
		let calls = 0;
		assert.equal(
			await runAutoUpdate(f.cfg, "off", {
				io: { out() {}, err() {} },
				exec: () => {
					calls++;
					assert.ok(fs.existsSync(f.marker));
					throw new Error("unavailable");
				},
			}),
			0,
		);
		assert.ok(fs.existsSync(f.marker));
		assert.equal(calls, 1);
	} finally {
		f.cleanup();
	}
});

test("on provisions while disabled, releases lock before triggering, and strips keys", async () => {
	const { runAutoUpdate } = await import("../lib/auto-update.mjs");
	const { acquireLock } = await import("../lib/lock.mjs");
	const f = fixture();
	try {
		const calls = [];
		const env = { ...process.env, FLYWHEEL_LICENSE_KEY: "private-test-key" };
		assert.equal(
			await runAutoUpdate(f.cfg, "on", {
				io: { out() {}, err() {} },
				env,
				exec: (_command, args, opts) => {
					assert.equal(opts.env.FLYWHEEL_LICENSE_KEY, undefined);
					calls.push(args);
					if (args[0] === "-c") {
						assert.match(args[1], /supervisor_trigger/);
						assert.ok(!fs.existsSync(f.marker));
						const lock = acquireLock(f.cfg);
						lock.release();
					} else {
						assert.ok(fs.existsSync(f.marker));
						assert.deepEqual(args.slice(1), [
							"--only",
							"auto-update",
							"--state-dir",
							f.cfg.stateDir,
						]);
						assert.ok(
							fs.existsSync(
								path.join(
									f.cfg.stateDir,
									"shell/current/bin/flywheel-onboard.js",
								),
							),
						);
					}
				},
			}),
			0,
		);
		assert.equal(calls.length, 2);
		assert.ok(!fs.existsSync(f.marker));
		assert.equal(env.FLYWHEEL_LICENSE_KEY, "private-test-key");
	} finally {
		f.cleanup();
	}
});

for (const failure of ["bootstrap", "trigger", "corrupt-ledger", "refresh"]) {
	test(`on keeps disabled marker after ${failure} failure`, async () => {
		const { runAutoUpdate } = await import("../lib/auto-update.mjs");
		const f = fixture();
		try {
			if (failure === "corrupt-ledger")
				fs.writeFileSync(
					path.join(f.cfg.stateDir, "update-ledger.json"),
					"bad",
				);
			if (failure === "refresh")
				fs.writeFileSync(path.join(f.cfg.stateDir, "shell"), "not a directory");
			let calls = 0;
			const code = await runAutoUpdate(f.cfg, "on", {
				io: { out() {}, err() {} },
				exec: (_command, args) => {
					calls++;
					if (failure === "bootstrap" || args[0] === "-c")
						throw new Error("failed");
				},
			});
			assert.equal(code, 1);
			assert.ok(fs.existsSync(f.marker));
			if (["corrupt-ledger", "refresh"].includes(failure))
				assert.equal(calls, 0);
		} finally {
			f.cleanup();
		}
	});
}

test("old payload cannot enable updater and leaves marker", async () => {
	const { runAutoUpdate } = await import("../lib/auto-update.mjs");
	const f = fixture();
	try {
		fs.writeFileSync(
			path.join(f.current, "scripts/packaged/bootstrap-services.sh"),
			"# old bootstrap",
		);
		let message = "";
		assert.equal(
			await runAutoUpdate(f.cfg, "on", {
				io: {
					out() {},
					err(s) {
						message += s;
					},
				},
				exec: () => {
					throw new Error("must not execute");
				},
			}),
			1,
		);
		assert.ok(fs.existsSync(f.marker));
		assert.match(message, /flywheel-onboard update/);
	} finally {
		f.cleanup();
	}
});

test("status JSON reports corrupt ledger without mutating it or exposing raw bytes", async () => {
	const { runAutoUpdate } = await import("../lib/auto-update.mjs");
	const f = fixture();
	try {
		const file = path.join(f.cfg.stateDir, "update-ledger.json");
		fs.writeFileSync(file, "private-corrupt-bytes");
		fs.writeFileSync(f.marker, "");
		let output = "";
		assert.equal(
			await runAutoUpdate(f.cfg, "status", {
				json: true,
				io: {
					out(s) {
						output += s;
					},
					err() {},
				},
				exec: () => {
					throw new Error("not loaded");
				},
			}),
			0,
		);
		const status = JSON.parse(output);
		assert.equal(status.enabled, false);
		assert.equal(status.supervisorLoaded, false);
		assert.equal(status.ledgerState, "corrupt");
		assert.equal(status.currentVersion, "1.2.3");
		assert.equal(status.shellVersion, null);
		assert.equal(status.schedule.checkEveryHours, 6);
		assert.equal(status.lastRun, null);
		assert.ok(!output.includes("private-corrupt-bytes"));
		assert.equal(fs.readFileSync(file, "utf8"), "private-corrupt-bytes");
	} finally {
		f.cleanup();
	}
});

test("status without payload reports not installed without creating files", async () => {
	const { runAutoUpdate } = await import("../lib/auto-update.mjs");
	const f = fixture();
	try {
		fs.unlinkSync(f.cfg.currentLink);
		const before = fs.readdirSync(f.cfg.stateDir);
		let output = "";
		assert.equal(
			await runAutoUpdate(f.cfg, "status", {
				io: {
					out(s) {
						output += s;
					},
					err() {},
				},
				exec: () => {
					throw new Error("must not execute");
				},
			}),
			0,
		);
		assert.match(output, /未安装/);
		assert.deepEqual(fs.readdirSync(f.cfg.stateDir), before);
	} finally {
		f.cleanup();
	}
});

test("CLI accepts status JSON and rejects surplus control arguments without reflecting them", async () => {
	const { spawnSync } = await import("node:child_process");
	const cli = new URL("../bin/flywheel-onboard.js", import.meta.url);
	const f = fixture();
	try {
		fs.unlinkSync(f.cfg.currentLink);
		const env = { ...process.env, FLYWHEEL_STATE_DIR: f.cfg.stateDir };
		const status = spawnSync(
			process.execPath,
			[cli.pathname, "auto-update", "status", "--json"],
			{ env, encoding: "utf8" },
		);
		assert.equal(status.status, 0, status.stderr);
		assert.equal(JSON.parse(status.stdout).currentVersion, null);
		for (const args of [
			["on", "private-argument"],
			["off", "--json"],
			["status", "--json", "extra"],
			["unknown"],
		]) {
			const result = spawnSync(
				process.execPath,
				[cli.pathname, "auto-update", ...args],
				{ env, encoding: "utf8" },
			);
			assert.equal(result.status, 2);
			assert.ok(!result.stderr.includes("private-argument"));
		}
	} finally {
		f.cleanup();
	}
});

test("existing installation enables from no shell copy and first real trigger records unattended outcome", async () => {
	const { spawn } = await import("node:child_process");
	const { createServer } = await import("node:http");
	const f = fixture();
	let requests = 0;
	const server = createServer((req, res) => {
		assert.equal(req.headers.authorization, "Bearer fixture-license");
		assert.equal(req.url, "/manifest");
		requests++;
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				latest: "1.2.3",
				versions: [{ ver: "1.2.3", sha256: "a".repeat(64) }],
			}),
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		fs.writeFileSync(f.cfg.envFile, "FLYWHEEL_LICENSE_KEY=fixture-license\n", {
			mode: 0o600,
		});
		fs.writeFileSync(
			path.join(f.current, "scripts/packaged/bootstrap-services.sh"),
			`#!/bin/bash
# --only auto-update fixture: supervisor boundary is isolated from the host.
mkdir -p "$4/bin"
cp "$FLY2392_WRAPPER" "$4/bin/flywheel-auto-update.sh"
`,
		);
		fs.writeFileSync(
			path.join(f.current, "scripts/lib/supervisor.sh"),
			`supervisor_trigger() { bash "$FLYWHEEL_STATE_DIR/bin/flywheel-auto-update.sh" "$FLYWHEEL_STATE_DIR"; }\n`,
		);
		const env = {
			...process.env,
			FLYWHEEL_STATE_DIR: f.cfg.stateDir,
			FLYWHEEL_ONBOARD_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
			FLY2392_WRAPPER: new URL(
				"../../../scripts/packaged/flywheel-auto-update.sh",
				import.meta.url,
			).pathname,
		};
		const child = spawn(
			process.execPath,
			[
				new URL("../bin/flywheel-onboard.js", import.meta.url).pathname,
				"auto-update",
				"on",
			],
			{ env, stdio: ["ignore", "pipe", "pipe"] },
		);
		let output = "";
		child.stdout.on("data", (b) => {
			output += b;
		});
		child.stderr.on("data", (b) => {
			output += b;
		});
		const code = await new Promise((resolve) => child.on("close", resolve));
		assert.equal(code, 0, output);
		assert.equal(requests, 1);
		const ledger = JSON.parse(
			fs.readFileSync(path.join(f.cfg.stateDir, "update-ledger.json"), "utf8"),
		);
		assert.equal(ledger.lastRun.trigger, "timer");
		assert.equal(ledger.lastRun.outcome, "up_to_date");
		const log = fs.readFileSync(
			path.join(f.cfg.stateDir, "logs/auto-update.log"),
			"utf8",
		);
		assert.match(log, /outcome=up_to_date/);
		assert.ok(!log.includes("fixture-license"));
		assert.ok(!fs.existsSync(f.marker));
	} finally {
		await new Promise((resolve) => server.close(resolve));
		f.cleanup();
	}
});
