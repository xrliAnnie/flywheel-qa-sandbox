import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../lib/config.mjs";
import { currentPkgRoot, flipCurrent } from "../lib/install.mjs";
import {
	emptyLedger,
	holdBlocks,
	readLedger,
	setHold,
	writeLedger,
} from "../lib/ledger.mjs";

function fixture() {
	const stateDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-crash-")),
	);
	const cfg = resolveConfig({ FLYWHEEL_STATE_DIR: stateDir });
	const old = path.join(cfg.versionsDir, "1.2.3", "node_modules/payload");
	const target = path.join(cfg.versionsDir, "1.2.4", "node_modules/payload");
	for (const [root, ver] of [
		[old, "1.2.3"],
		[path.join(stateDir, "template"), "1.2.4"],
	]) {
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
	flipCurrent(cfg, old);
	return {
		cfg,
		old,
		target,
		cleanup: () => fs.rmSync(stateDir, { recursive: true, force: true }),
	};
}
function run(f, mode, point, failure = "target") {
	const result = spawnSync(
		process.execPath,
		[
			new URL("fixtures/apply-crash-child.mjs", import.meta.url).pathname,
			JSON.stringify(f.cfg),
			mode,
			point,
			failure,
		],
		{ encoding: "utf8", timeout: 5000 },
	);
	// Linux dead-owner cleanup is an explicit test/operator action, never runtime reclamation.
	if (result.signal === "SIGKILL" && process.platform !== "darwin")
		fs.rmSync(path.join(f.cfg.stateDir, "update.lock.d"), {
			recursive: true,
			force: true,
		});
	return result;
}
function restarts(f) {
	try {
		return fs
			.readFileSync(path.join(f.cfg.stateDir, "restarts.log"), "utf8")
			.trim()
			.split("\n");
	} catch {
		return [];
	}
}

for (const [point, phase, pointer, before, after, held, outcome] of [
	["installed", "installing", "old", [], [], false, "settled"],
	["flipped_intent", "flipped", "old", [], ["old"], true, "rolled_back"],
	["flipped", "flipped", "target", [], ["target"], false, "settled"],
	[
		"restart_failed",
		"flipped",
		"target",
		["target"],
		["target", "target", "old"],
		true,
		"rolled_back",
	],
	[
		"failure_receipt",
		"recovering",
		"target",
		["target"],
		["target", "old"],
		true,
		"rolled_back",
	],
	[
		"target_cleaned",
		"recovering",
		null,
		["target"],
		["target", "old"],
		true,
		"rolled_back",
	],
	[
		"restored_pointer",
		"recovering",
		"old",
		["target"],
		["target", "old"],
		true,
		"rolled_back",
	],
	[
		"restored_health",
		"recovering",
		"old",
		["target", "old"],
		["target", "old", "old"],
		true,
		"rolled_back",
	],
	[
		"healthy",
		"flipped",
		"target",
		["target"],
		["target", "target"],
		false,
		"settled",
	],
]) {
	test(`U6 SIGKILL at ${point}: durable ${phase}/${pointer}, then ${outcome}`, () => {
		const f = fixture();
		try {
			const healthy = ["flipped", "healthy"].includes(point);
			const child = run(f, "apply", point, healthy ? "none" : "target");
			assert.equal(child.signal, "SIGKILL", child.stderr);
			assert.equal(readLedger(f.cfg).ledger.applying.phase, phase);
			assert.equal(currentPkgRoot(f.cfg), pointer === null ? null : f[pointer]);
			assert.deepEqual(restarts(f), before);
			const resume = run(f, "settle", "none", healthy ? "none" : "target");
			assert.equal(resume.status, 0, resume.stderr);
			const ledger = readLedger(f.cfg).ledger;
			assert.equal(ledger.applying, null);
			assert.equal(ledger.lastRun.outcome, outcome);
			assert.equal(ledger.holds["1.2.4"]?.attempts, held ? 1 : undefined);
			assert.equal(currentPkgRoot(f.cfg), healthy ? f.target : f.old);
			assert.equal(fs.existsSync(f.target), healthy);
			assert.deepEqual(restarts(f), after);
		} finally {
			f.cleanup();
		}
	});
}

test("U6l/o lost receipt plus two SIGKILLs persists exactly the second attempt and blocks retry", () => {
	const f = fixture();
	try {
		const ledger = emptyLedger();
		setHold(ledger, "1.2.4", "health_failed", "2026-09-13T00:00:00.000Z");
		writeLedger(f.cfg, ledger);
		assert.equal(
			run(f, "apply", "target_cleaned", "receipt").signal,
			"SIGKILL",
		);
		assert.equal(readLedger(f.cfg).ledger.applying.phase, "flipped");
		assert.equal(readLedger(f.cfg).ledger.holds["1.2.4"].attempts, 1);
		assert.equal(currentPkgRoot(f.cfg), null);
		assert.equal(run(f, "settle", "failure_receipt").signal, "SIGKILL");
		assert.equal(readLedger(f.cfg).ledger.holds["1.2.4"].attempts, 2);
		assert.equal(run(f, "settle", "none").status, 0);
		const final = readLedger(f.cfg).ledger;
		assert.equal(final.holds["1.2.4"].attempts, 2);
		assert.equal(
			holdBlocks(final, "1.2.4", Date.parse("2026-09-14T00:00:00Z")),
			true,
		);
		assert.equal(final.lastRun.outcome, "rolled_back");
		assert.equal(currentPkgRoot(f.cfg), f.old);
		assert.deepEqual(restarts(f), ["target", "old"]);
	} finally {
		f.cleanup();
	}
});

for (const point of ["partial_cleanup", "restored_health"]) {
	test(`U6m/n ${point} with failed receipt or partial deletion recovers honestly`, () => {
		const f = fixture();
		try {
			const failure = point === "restored_health" ? "both" : "target";
			assert.equal(run(f, "apply", point, failure).signal, "SIGKILL");
			const resume = run(f, "settle", "none", failure);
			assert.equal(resume.status, 0, resume.stderr);
			const ledger = readLedger(f.cfg).ledger;
			assert.equal(ledger.applying, null);
			assert.equal(ledger.holds["1.2.4"].attempts, 1);
			assert.equal(
				ledger.lastRun.outcome,
				failure === "both" ? "degraded" : "rolled_back",
			);
			assert.equal(currentPkgRoot(f.cfg), f.old);
			assert.ok(!fs.existsSync(f.target));
		} finally {
			f.cleanup();
		}
	});
}

for (const point of ["healthy", "committed"]) {
	test(`explicit install SIGKILL at ${point} clears hold from durable intent on restart`, () => {
		const f = fixture();
		try {
			fs.cpSync(path.join(f.cfg.stateDir, "template"), f.target, {
				recursive: true,
			});
			fs.writeFileSync(f.cfg.envFile, "FLYWHEEL_LICENSE_KEY=fixture-key\n", {
				mode: 0o600,
			});
			const ledger = emptyLedger();
			setHold(ledger, "1.2.4", "manual_rollback");
			writeLedger(f.cfg, ledger);
			assert.equal(run(f, "install", point, "none").signal, "SIGKILL");
			assert.equal(currentPkgRoot(f.cfg), f.target);
			if (point === "healthy")
				assert.equal(readLedger(f.cfg).ledger.applying.clearHoldOnVer, "1.2.4");
			assert.equal(run(f, "settle", "none", "none").status, 0);
			assert.equal(readLedger(f.cfg).ledger.holds["1.2.4"], undefined);
			assert.equal(readLedger(f.cfg).ledger.applying, null);
			assert.equal(currentPkgRoot(f.cfg), f.target);
		} finally {
			f.cleanup();
		}
	});
}

test("U6k old payload becomes unverifiable before recovery: clear dangling current and report degraded", () => {
	const f = fixture();
	try {
		assert.equal(run(f, "apply", "target_cleaned").signal, "SIGKILL");
		fs.unlinkSync(path.join(f.old, "dist/run-bridge.js"));
		assert.equal(run(f, "settle", "none").status, 0);
		assert.equal(currentPkgRoot(f.cfg), null);
		assert.equal(fs.existsSync(f.cfg.currentLink), false);
		const ledger = readLedger(f.cfg).ledger;
		assert.equal(ledger.applying, null);
		assert.equal(ledger.lastRun.outcome, "degraded");
		assert.equal(ledger.holds["1.2.4"].attempts, 1);
		assert.deepEqual(restarts(f), ["target"]);
	} finally {
		f.cleanup();
	}
});
