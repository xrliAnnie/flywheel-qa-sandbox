import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const scheduleModule = () => import("../lib/schedule.mjs");

test("schedule defaults and every supported interval include the install hour", async () => {
	const { readSchedule, scheduleTicks } = await scheduleModule();
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-schedule-"));
	try {
		const cfg = { stateDir };
		const defaults = readSchedule(cfg);
		assert.equal(defaults.invalid, false);
		assert.deepEqual(
			scheduleTicks(defaults),
			[3, 9, 15, 21].map((hour) => ({ hour, minute: 0 })),
		);
		for (const checkEveryHours of [1, 2, 3, 4, 6, 8, 12, 24]) {
			fs.writeFileSync(
				path.join(stateDir, "auto-update.json"),
				JSON.stringify({
					schemaVersion: 1,
					checkEveryHours,
					applyHour: 23,
					applyGraceHours: 2,
				}),
			);
			const config = readSchedule(cfg);
			assert.equal(config.invalid, false);
			const ticks = scheduleTicks(config);
			assert.equal(ticks.length, 24 / checkEveryHours);
			assert.ok(ticks.some((tick) => tick.hour === 23));
		}
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("invalid schedule files fall back without changing the original bytes", async () => {
	const { readSchedule } = await scheduleModule();
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-schedule-"));
	try {
		for (const value of [
			null,
			[],
			{},
			{ schemaVersion: 2 },
			...[
				{ checkEveryHours: 5 },
				{ checkEveryHours: "6" },
				{ applyHour: 24 },
				{ applyHour: -1 },
				{ applyHour: 3.5 },
				{ applyGraceHours: 0 },
				{ applyGraceHours: 7 },
			].map((fields) => ({
				schemaVersion: 1,
				checkEveryHours: 6,
				applyHour: 3,
				applyGraceHours: 2,
				...fields,
			})),
		]) {
			const file = path.join(stateDir, "auto-update.json");
			const bytes = JSON.stringify(value);
			fs.writeFileSync(file, bytes);
			assert.deepEqual(readSchedule({ stateDir }), {
				schemaVersion: 1,
				checkEveryHours: 6,
				applyHour: 3,
				applyGraceHours: 2,
				invalid: true,
			});
			assert.equal(fs.readFileSync(file, "utf8"), bytes);
		}
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("local apply windows cross midnight; next dates are future calendar occurrences", async () => {
	const { inApplyWindow, nextApplyAt, nextCheckAt } = await scheduleModule();
	const config = { checkEveryHours: 6, applyHour: 23, applyGraceHours: 2 };
	for (const [hour, minute, expected] of [
		[22, 59, false],
		[23, 0, true],
		[0, 59, true],
		[1, 0, false],
	]) {
		assert.equal(
			inApplyWindow(config, new Date(2026, 8, 13, hour, minute)),
			expected,
		);
	}
	const now = new Date(2026, 8, 13, 23, 30);
	assert.equal(
		nextCheckAt(config, now),
		new Date(2026, 8, 14, 5).toISOString(),
	);
	assert.equal(
		nextApplyAt(config, new Date(2026, 8, 13, 22)),
		new Date(2026, 8, 13, 23).toISOString(),
	);
	assert.equal(
		nextApplyAt(config, now),
		new Date(2026, 8, 14, 23).toISOString(),
	);
});

test("lock excludes another process, survives child exec, and releases after SIGKILL on darwin", async () => {
	const { spawn, spawnSync } = await import("node:child_process");
	const { once } = await import("node:events");
	const { acquireLock } = await import("../lib/lock.mjs");
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-lock-"));
	const moduleUrl = new URL("../lib/lock.mjs", import.meta.url).href;
	const source = `import {acquireLock} from ${JSON.stringify(moduleUrl)}; try { const lock = acquireLock({stateDir:process.argv[1]}); console.log('locked'); setInterval(()=>{},1000); } catch(e) { process.exit(e.exitCode ?? 1); }`;
	let holder;
	try {
		const lock = acquireLock({ stateDir });
		const competitor = spawnSync(
			process.execPath,
			["--input-type=module", "-e", source, stateDir],
			{ encoding: "utf8", timeout: 3000 },
		);
		assert.equal(competitor.status, 75, competitor.stderr);
		assert.equal(
			fs.existsSync(path.join(stateDir, "update-ledger.json")),
			false,
		);
		assert.match(
			fs.readFileSync(path.join(stateDir, "logs/auto-update.log"), "utf8"),
			/另一个更新/,
		);
		lock.release();
		lock.release(); // releasing twice must not close an unrelated fd
		holder = spawn(process.execPath, [
			"--input-type=module",
			"-e",
			source,
			stateDir,
		]);
		await Promise.race([
			once(holder.stdout, "data"),
			once(holder, "exit").then(() => {
				throw new Error("holder exited before acquiring");
			}),
		]);
		const exited = once(holder, "exit");
		holder.kill("SIGKILL");
		await exited;
		if (process.platform === "darwin") {
			const after = acquireLock({ stateDir });
			after.release();
			assert.ok(fs.existsSync(path.join(stateDir, "update.lock")));
		} else {
			assert.throws(
				() => acquireLock({ stateDir }),
				(error) => error.exitCode === 75,
			);
		}
	} finally {
		if (holder && holder.exitCode === null && holder.signalCode === null)
			holder.kill("SIGKILL");
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test(
	"darwin refuses an inode replaced between open and stat, closing both attempted descriptors",
	{ skip: process.platform !== "darwin" },
	async () => {
		const { acquireLock } = await import("../lib/lock.mjs");
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-lock-"));
		let opened = 0;
		let closed = 0;
		try {
			assert.throws(
				() =>
					acquireLock(
						{ stateDir },
						{
							fsImpl: {
								...fs,
								openSync(...args) {
									opened++;
									return fs.openSync(...args);
								},
								statSync(file) {
									const stat = fs.statSync(file);
									return { ...stat, ino: stat.ino + 1 };
								},
								closeSync(fd) {
									closed++;
									fs.closeSync(fd);
								},
							},
						},
					),
				(error) => error.exitCode === 75,
			);
			assert.equal(opened, 2);
			assert.equal(closed, 2);
			acquireLock({ stateDir }).release();
		} finally {
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	},
);

test("non-darwin dead owner never auto-reclaims the lock and gives the recovery instruction", async () => {
	const { acquireLock } = await import("../lib/lock.mjs");
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-lock-"));
	try {
		const directory = path.join(stateDir, "update.lock.d");
		fs.mkdirSync(directory);
		const file = path.join(directory, "owner.json");
		const bytes = JSON.stringify({
			pid: 2147483647,
			created: "2020-01-01T00:00:00.000Z",
		});
		fs.writeFileSync(file, bytes);
		assert.throws(
			() => acquireLock({ stateDir }, { platform: "linux" }),
			(error) => {
				assert.equal(error.exitCode, 75);
				assert.match(error.message, /上次更新异常退出.*update.lock.d/);
				return true;
			},
		);
		assert.equal(fs.readFileSync(file, "utf8"), bytes);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("ledger read distinguishes missing, valid and corrupt without overwriting evidence", async () => {
	const { readLedger, writeLedger } = await import("../lib/ledger.mjs");
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-ledger-"));
	try {
		const cfg = { stateDir };
		const missing = readLedger(cfg);
		assert.equal(missing.state, "missing");
		assert.deepEqual(missing.ledger.knownGood, []);
		writeLedger(cfg, missing.ledger);
		assert.deepEqual(readLedger(cfg), {
			state: "valid",
			ledger: missing.ledger,
		});
		const file = path.join(stateDir, "update-ledger.json");
		assert.equal(fs.statSync(file).mode & 0o777, 0o644);
		for (const bytes of [
			"not-json",
			"null",
			"{}",
			JSON.stringify({ ...missing.ledger, schemaVersion: 2 }),
		]) {
			fs.writeFileSync(file, bytes);
			assert.equal(readLedger(cfg).state, "corrupt");
			assert.equal(fs.readFileSync(file, "utf8"), bytes);
		}
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("ledger rejects malformed recovery intentions and history before any write", async () => {
	const { readLedger, emptyLedger, writeLedger } = await import(
		"../lib/ledger.mjs"
	);
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-ledger-"));
	const cfg = { stateDir };
	const at = "2026-09-14T00:00:00.000Z";
	const intent = {
		operation: "update",
		ver: "1.2.4",
		fromVer: "1.2.3",
		fromPkgRoot: "/fixture/1.2.3",
		targetCreated: true,
		phase: "installing",
		holdOutgoingReason: null,
		clearHoldOnVer: null,
		startedAt: at,
		trigger: "timer",
	};
	try {
		const valid = { ...emptyLedger(), applying: intent };
		writeLedger(cfg, valid);
		assert.equal(readLedger(cfg).state, "valid");
		for (const change of [
			{ applying: {} },
			...[
				{ operation: "unknown" },
				{ phase: "done" },
				{ ver: "../escape" },
				{ targetCreated: "yes" },
				{ fromPkgRoot: 3 },
				{ startedAt: "yesterday" },
				{ trigger: "unknown" },
				{ holdOutgoingReason: "arbitrary" },
				{ holdOutgoingReason: "manual_rollback" },
				{ clearHoldOnVer: "1.2.2" },
			].map((fields) => ({ applying: { ...intent, ...fields } })),
			{ knownGood: [{ ver: "../escape", origin: "health", at }] },
			{ knownGood: [{ ver: "1.2.3", origin: "invented", at }] },
			{
				holds: {
					"1.2.3": {
						reason: "health_failed",
						at,
						attempts: -1,
						lastAttemptId: at,
					},
				},
			},
			{ pendingVersion: "../../escape" },
			{ lastRun: { at, outcome: "invented" } },
		]) {
			const bytes = JSON.stringify({ ...valid, ...change });
			const file = path.join(stateDir, "update-ledger.json");
			fs.writeFileSync(file, bytes);
			assert.equal(readLedger(cfg).state, "corrupt", bytes);
			assert.throws(
				() => writeLedger(cfg, JSON.parse(bytes)),
				/invalid update ledger/,
			);
			assert.equal(fs.readFileSync(file, "utf8"), bytes);
		}
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("failure receipts count distinct attempts only and hold retry limits are exact", async () => {
	const { emptyLedger, setHold, clearHold, holdBlocks } = await import(
		"../lib/ledger.mjs"
	);
	const ledger = emptyLedger();
	const at = "2026-09-14T00:00:00.000Z";
	assert.equal(holdBlocks(ledger, "1.2.3", Date.parse(at)), false);
	setHold(ledger, "1.2.3", "health_failed", at, at);
	setHold(ledger, "1.2.3", "health_failed", at, at);
	assert.equal(ledger.holds["1.2.3"].attempts, 1);
	assert.equal(holdBlocks(ledger, "1.2.3", Date.parse(at) + 3599999), true);
	assert.equal(holdBlocks(ledger, "1.2.3", Date.parse(at) + 3600000), false);
	const later = "2026-09-14T01:00:00.000Z";
	setHold(ledger, "1.2.3", "health_failed", later, later);
	setHold(ledger, "1.2.3", "health_failed", later, later);
	assert.equal(ledger.holds["1.2.3"].attempts, 2);
	assert.equal(holdBlocks(ledger, "1.2.3", Date.parse(at) + 86400000), true);
	for (const reason of ["manual_rollback", "withdrawn_observed"]) {
		clearHold(ledger, "1.2.3");
		setHold(ledger, "1.2.3", reason, at, at);
		assert.equal(holdBlocks(ledger, "1.2.3", Date.parse(at) + 86400000), true);
	}
});

test("apply success consumes durable intent in one atomic write and failed rename preserves evidence", async () => {
	const { emptyLedger, writeLedger, readLedger, commitApplySuccess, setHold } =
		await import("../lib/ledger.mjs");
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-ledger-"));
	const cfg = { stateDir };
	const at = "2026-09-14T00:00:00.000Z";
	try {
		const ledger = emptyLedger();
		ledger.applying = {
			operation: "rollback",
			ver: "1.2.3",
			fromVer: "1.2.4",
			fromPkgRoot: "/fixture/1.2.4",
			targetCreated: false,
			phase: "flipped",
			holdOutgoingReason: "manual_rollback",
			clearHoldOnVer: null,
			startedAt: at,
			trigger: "manual",
		};
		writeLedger(cfg, ledger);
		const file = path.join(stateDir, "update-ledger.json");
		const before = fs.readFileSync(file, "utf8");
		assert.throws(
			() =>
				commitApplySuccess(cfg, ledger, {
					at,
					fsImpl: {
						...fs,
						renameSync() {
							throw new Error("disk unavailable");
						},
					},
				}),
			/disk unavailable/,
		);
		assert.equal(fs.readFileSync(file, "utf8"), before);
		assert.equal(ledger.applying.operation, "rollback");
		let writes = 0;
		commitApplySuccess(cfg, ledger, {
			at,
			fsImpl: {
				...fs,
				renameSync(...args) {
					writes++;
					fs.renameSync(...args);
				},
			},
		});
		assert.equal(writes, 1);
		assert.equal(ledger.applying, null);
		assert.equal(
			readLedger(cfg).ledger.holds["1.2.4"].reason,
			"manual_rollback",
		);
		assert.equal(ledger.knownGood.at(-1).ver, "1.2.3");
		setHold(ledger, "1.2.4", "health_failed", "2026-09-14T01:00:00.000Z");
		ledger.applying = {
			operation: "install_version",
			ver: "1.2.4",
			fromVer: "1.2.3",
			fromPkgRoot: "/fixture/1.2.3",
			targetCreated: false,
			phase: "flipped",
			holdOutgoingReason: null,
			clearHoldOnVer: "1.2.4",
			startedAt: at,
			trigger: "manual",
		};
		writeLedger(cfg, ledger);
		commitApplySuccess(cfg, ledger, { at });
		assert.equal(Object.hasOwn(readLedger(cfg).ledger.holds, "1.2.4"), false);
		assert.deepEqual(
			ledger.knownGood.map((g) => [g.ver, g.origin]),
			[
				["1.2.3", "outgoing"],
				["1.2.4", "health"],
			],
		);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("previous-good is derived from verified unheld local payloads, with bounded history", async () => {
	const { emptyLedger, addKnownGood, recordRun, previousGood, setHold } =
		await import("../lib/ledger.mjs");
	const { resolveConfig } = await import("../lib/config.mjs");
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-ledger-"));
	const cfg = resolveConfig({ FLYWHEEL_STATE_DIR: stateDir });
	const at = "2026-09-14T00:00:00.000Z";
	try {
		const ledger = emptyLedger();
		for (let i = 0; i < 12; i++) addKnownGood(ledger, `1.2.${i}`, "health", at);
		assert.equal(ledger.knownGood.length, 10);
		assert.equal(ledger.knownGood[0].ver, "1.2.2");
		for (let i = 0; i < 35; i++)
			recordRun(ledger, {
				at,
				trigger: "timer",
				outcome: "held",
				latest: "1.2.11",
				detail: "",
			});
		assert.equal(ledger.runs.length, 30);
		assert.equal(previousGood(cfg, ledger, "1.2.11"), null);
		for (const ver of ["1.2.7", "1.2.8", "1.2.9", "1.2.10", "1.2.11"]) {
			const root = path.join(cfg.versionsDir, ver, "node_modules/payload");
			for (const file of [
				".flywheel-prebuilt",
				"dist/run-bridge.js",
				"scripts/flywheel-onboard.sh",
				"scripts/packaged/create-compat-mirror.sh",
				"scripts/packaged/restart-packaged-services.sh",
			]) {
				fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
				fs.writeFileSync(
					path.join(root, file),
					file === ".flywheel-prebuilt" ? ver : "fixture",
				);
			}
		}
		fs.unlinkSync(
			path.join(
				cfg.versionsDir,
				"1.2.10/node_modules/payload/dist/run-bridge.js",
			),
		);
		setHold(ledger, "1.2.9", "manual_rollback", at);
		assert.equal(previousGood(cfg, ledger, "1.2.11").ver, "1.2.8");
		assert.equal(
			previousGood(cfg, ledger, "1.2.11").pkgRoot,
			path.join(cfg.versionsDir, "1.2.8/node_modules/payload"),
		);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("applying setters persist before publishing memory state and refuse invalid intentions", async () => {
	const { emptyLedger, setApplying, clearApplying, readLedger } = await import(
		"../lib/ledger.mjs"
	);
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-ledger-"));
	const cfg = { stateDir };
	try {
		const ledger = emptyLedger();
		const applying = {
			operation: "update",
			ver: "1.2.3",
			fromVer: null,
			fromPkgRoot: null,
			targetCreated: true,
			phase: "installing",
			holdOutgoingReason: null,
			clearHoldOnVer: null,
			startedAt: "2026-09-14T00:00:00.000Z",
			trigger: "timer",
		};
		setApplying(cfg, ledger, applying);
		assert.deepEqual(readLedger(cfg).ledger.applying, applying);
		assert.throws(
			() =>
				setApplying(
					cfg,
					ledger,
					{ ...applying, phase: "flipped" },
					{
						fsImpl: {
							...fs,
							renameSync() {
								throw new Error("injected");
							},
						},
					},
				),
			/injected/,
		);
		assert.equal(ledger.applying.phase, "installing");
		assert.equal(readLedger(cfg).ledger.applying.phase, "installing");
		assert.throws(
			() => setApplying(cfg, ledger, { ...applying, operation: "unknown" }),
			/invalid update ledger/,
		);
		clearApplying(cfg, ledger);
		assert.equal(readLedger(cfg).ledger.applying, null);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test(
	"darwin exec child does not inherit the held lock descriptor",
	{ skip: process.platform !== "darwin" },
	async () => {
		const { spawnSync } = await import("node:child_process");
		const { acquireLock } = await import("../lib/lock.mjs");
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-lock-"));
		let descriptor;
		const lock = acquireLock(
			{ stateDir },
			{
				fsImpl: {
					...fs,
					openSync(...args) {
						descriptor = fs.openSync(...args);
						return descriptor;
					},
				},
			},
		);
		try {
			const result = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`import fs from 'node:fs'; import assert from 'node:assert/strict'; assert.throws(() => fs.fstatSync(Number(process.argv[1])), e => e.code === 'EBADF');`,
					String(descriptor),
				],
				{ encoding: "utf8" },
			);
			assert.equal(result.status, 0, result.stderr);
		} finally {
			lock.release();
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	},
);

test("non-darwin live owner exclusion leaves its owner record intact", async () => {
	const { acquireLock } = await import("../lib/lock.mjs");
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-lock-"));
	const lock = acquireLock({ stateDir }, { platform: "linux" });
	try {
		const file = path.join(stateDir, "update.lock.d/owner.json");
		const before = fs.readFileSync(file, "utf8");
		assert.throws(
			() => acquireLock({ stateDir }, { platform: "linux" }),
			(error) => error.exitCode === 75 && /另一个更新/.test(error.message),
		);
		assert.equal(fs.readFileSync(file, "utf8"), before);
	} finally {
		lock.release();
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});
