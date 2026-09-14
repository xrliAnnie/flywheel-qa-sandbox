import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../lib/config.mjs";
import { currentPkgRoot, flipCurrent } from "../lib/install.mjs";
import { emptyLedger, readLedger } from "../lib/ledger.mjs";

function fixture() {
	const stateDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "fly2392-apply-")),
	);
	const cfg = resolveConfig({ FLYWHEEL_STATE_DIR: stateDir });
	function payload(ver) {
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
		return root;
	}
	return {
		cfg,
		payload,
		cleanup: () => fs.rmSync(stateDir, { recursive: true, force: true }),
	};
}

test("U5 verified local target is reused without download, flip intent precedes current change", async () => {
	const { applyVersion } = await import("../lib/apply.mjs");
	const f = fixture();
	try {
		const old = f.payload("1.2.3");
		const target = f.payload("1.2.4");
		flipCurrent(f.cfg, old);
		const ledger = emptyLedger();
		const phases = [];
		const result = await applyVersion(f.cfg, ledger, {
			ver: "1.2.4",
			fromVer: "1.2.3",
			fromPkgRoot: old,
			loadTarball: () => {
				throw new Error("must not download");
			},
			exec: (_cmd, args) => {
				assert.equal(
					args[0],
					path.join(target, "scripts/packaged/restart-packaged-services.sh"),
				);
				assert.equal(currentPkgRoot(f.cfg), target);
			},
			checkpoint: (name) => {
				phases.push(name);
				if (name === "flipped_intent") {
					assert.equal(readLedger(f.cfg).ledger.applying.phase, "flipped");
					assert.equal(currentPkgRoot(f.cfg), old);
				}
			},
		});
		assert.equal(result.outcome, "updated");
		assert.ok(phases.includes("flipped_intent"));
		assert.equal(readLedger(f.cfg).ledger.applying, null);
		assert.deepEqual(
			ledger.knownGood.map((g) => [g.ver, g.origin]),
			[
				["1.2.3", "outgoing"],
				["1.2.4", "health"],
			],
		);
	} finally {
		f.cleanup();
	}
});

test("U5b unhealthy reused target persists hold before restoring old services and keeps target directory", async () => {
	const { applyVersion } = await import("../lib/apply.mjs");
	const f = fixture();
	try {
		const old = f.payload("1.2.3");
		const target = f.payload("1.2.4");
		flipCurrent(f.cfg, old);
		const ledger = emptyLedger();
		const restarts = [];
		const result = await applyVersion(f.cfg, ledger, {
			ver: "1.2.4",
			fromVer: "1.2.3",
			fromPkgRoot: old,
			exec: (_cmd, [script]) => {
				restarts.push(script);
				if (script.startsWith(target)) throw new Error("unhealthy");
				assert.equal(readLedger(f.cfg).ledger.holds["1.2.4"].attempts, 1);
				assert.equal(currentPkgRoot(f.cfg), old);
			},
		});
		assert.equal(result.outcome, "rolled_back");
		assert.equal(restarts.length, 2);
		assert.ok(fs.existsSync(target));
		assert.equal(ledger.applying, null);
		assert.equal(ledger.holds["1.2.4"].reason, "health_failed");
	} finally {
		f.cleanup();
	}
});

test("U6 flipped target resumes from disk intent; healthy settlement commits outgoing known-good", async () => {
	const { settleInflight } = await import("../lib/apply.mjs");
	const { setApplying } = await import("../lib/ledger.mjs");
	const f = fixture();
	try {
		const old = f.payload("1.2.3");
		const target = f.payload("1.2.4");
		flipCurrent(f.cfg, target);
		const ledger = emptyLedger();
		setApplying(f.cfg, ledger, {
			operation: "update",
			ver: "1.2.4",
			fromVer: "1.2.3",
			fromPkgRoot: old,
			targetCreated: false,
			phase: "flipped",
			holdOutgoingReason: null,
			clearHoldOnVer: null,
			startedAt: "2026-09-14T00:00:00.000Z",
			trigger: "timer",
		});
		const restarted = readLedger(f.cfg).ledger;
		let calls = 0;
		const result = await settleInflight(f.cfg, restarted, {
			exec: () => {
				calls++;
			},
		});
		assert.equal(result.outcome, "settled");
		assert.equal(calls, 1);
		assert.equal(restarted.applying, null);
		assert.equal(restarted.knownGood[0].ver, "1.2.3");
		assert.equal(currentPkgRoot(f.cfg), target);
	} finally {
		f.cleanup();
	}
});

for (const phase of ["installing", "flipped", "recovering"]) {
	for (const position of ["from", "none", "other"]) {
		test(`U6 settlement ${phase}/${position} preserves unrelated current and records failures once`, async () => {
			const { settleInflight } = await import("../lib/apply.mjs");
			const { setApplying } = await import("../lib/ledger.mjs");
			const f = fixture();
			try {
				const old = f.payload("1.2.3");
				const target = f.payload("1.2.4");
				const other = f.payload("1.2.5");
				if (position !== "none")
					flipCurrent(f.cfg, position === "from" ? old : other);
				const ledger = emptyLedger();
				setApplying(f.cfg, ledger, {
					operation: "update",
					ver: "1.2.4",
					fromVer: "1.2.3",
					fromPkgRoot: old,
					targetCreated: true,
					phase,
					holdOutgoingReason: null,
					clearHoldOnVer: null,
					startedAt: "2026-09-14T00:00:00.000Z",
					trigger: "timer",
				});
				let restarts = 0;
				const result = await settleInflight(f.cfg, ledger, {
					exec: () => {
						restarts++;
					},
				});
				assert.equal(ledger.applying, null);
				if (phase === "installing") {
					assert.equal(restarts, 0);
					assert.equal(ledger.holds["1.2.4"], undefined);
					assert.equal(fs.existsSync(target), false);
				} else {
					assert.equal(ledger.holds["1.2.4"].attempts, 1);
					assert.equal(
						result.outcome,
						position === "other" ? "degraded" : "rolled_back",
					);
					assert.equal(restarts, position === "other" ? 0 : 1);
					if (position === "other")
						assert.equal(ledger.lastRun.detail, "current_changed");
				}
				assert.equal(
					currentPkgRoot(f.cfg),
					position === "other"
						? other
						: phase === "installing" && position === "none"
							? null
							: old,
				);
			} finally {
				f.cleanup();
			}
		});
	}
}

for (const phase of ["flipped", "recovering"]) {
	test(`R5 self-reapply ${phase}/target failure preserves current and counts one attempt across replay`, async () => {
		const { settleInflight } = await import("../lib/apply.mjs");
		const { setApplying } = await import("../lib/ledger.mjs");
		const f = fixture();
		try {
			const target = f.payload("1.2.4");
			flipCurrent(f.cfg, target);
			const ledger = emptyLedger();
			setApplying(f.cfg, ledger, {
				operation: "install_version",
				ver: "1.2.4",
				fromVer: "1.2.4",
				fromPkgRoot: null,
				targetCreated: false,
				phase,
				holdOutgoingReason: null,
				clearHoldOnVer: "1.2.4",
				startedAt: "2026-09-14T00:00:00.000Z",
				trigger: "manual",
			});
			await assert.rejects(
				settleInflight(f.cfg, ledger, {
					exec: () => {
						throw new Error("unhealthy");
					},
					checkpoint: (name) => {
						if (name === "failure_receipt") throw new Error("simulated crash");
					},
				}),
				/simulated crash/,
			);
			const reloaded = readLedger(f.cfg).ledger;
			assert.equal(reloaded.applying.phase, "recovering");
			const result = await settleInflight(f.cfg, reloaded, {
				exec: () => {
					throw new Error("unhealthy");
				},
			});
			assert.equal(result.outcome, "degraded");
			assert.equal(reloaded.holds["1.2.4"].attempts, 1);
			assert.equal(currentPkgRoot(f.cfg), target);
			assert.ok(fs.existsSync(target));
		} finally {
			f.cleanup();
		}
	});
}

test("receipt write failure still restores old services and retains flipped intent for next settlement", async () => {
	const { settleInflight } = await import("../lib/apply.mjs");
	const { setApplying } = await import("../lib/ledger.mjs");
	const f = fixture();
	try {
		const old = f.payload("1.2.3");
		const target = f.payload("1.2.4");
		flipCurrent(f.cfg, target);
		const ledger = emptyLedger();
		setApplying(f.cfg, ledger, {
			operation: "update",
			ver: "1.2.4",
			fromVer: "1.2.3",
			fromPkgRoot: old,
			targetCreated: false,
			phase: "flipped",
			holdOutgoingReason: null,
			clearHoldOnVer: null,
			startedAt: "2026-09-14T00:00:00.000Z",
			trigger: "timer",
		});
		const result = await settleInflight(f.cfg, ledger, {
			exec: (_cmd, [script]) => {
				if (script.startsWith(target)) throw new Error("unhealthy");
			},
			fsImpl: {
				...fs,
				renameSync() {
					throw new Error("no disk space");
				},
			},
		});
		assert.equal(result.outcome, "degraded");
		assert.equal(currentPkgRoot(f.cfg), old);
		assert.equal(readLedger(f.cfg).ledger.applying.phase, "flipped");
		const restarted = readLedger(f.cfg).ledger;
		assert.equal(
			(await settleInflight(f.cfg, restarted, { exec: () => {} })).outcome,
			"rolled_back",
		);
		assert.equal(restarted.holds["1.2.4"].attempts, 1);
	} finally {
		f.cleanup();
	}
});

test("fresh download failure clears applying without changing current or recording a health hold", async () => {
	const { applyVersion } = await import("../lib/apply.mjs");
	const f = fixture();
	try {
		const old = f.payload("1.2.3");
		flipCurrent(f.cfg, old);
		const ledger = emptyLedger();
		const result = await applyVersion(f.cfg, ledger, {
			ver: "1.2.4",
			fromVer: "1.2.3",
			fromPkgRoot: old,
			loadTarball: async () => {
				throw new Error("download unavailable");
			},
			exec: () => {
				throw new Error("must not restart");
			},
		});
		assert.equal(result.outcome, "error");
		assert.equal(currentPkgRoot(f.cfg), old);
		assert.equal(readLedger(f.cfg).ledger.applying, null);
		assert.deepEqual(ledger.holds, {});
		assert.equal(fs.existsSync(path.join(f.cfg.versionsDir, "1.2.4")), false);
	} finally {
		f.cleanup();
	}
});

test("invalid current cannot be deleted; invalid inactive prefix is removed only after durable intent", async () => {
	const { applyVersion } = await import("../lib/apply.mjs");
	const f = fixture();
	try {
		const old = f.payload("1.2.3");
		flipCurrent(f.cfg, old);
		fs.unlinkSync(path.join(old, "dist/run-bridge.js"));
		const ledger = emptyLedger();
		await assert.rejects(
			applyVersion(f.cfg, ledger, {
				ver: "1.2.3",
				fromVer: "1.2.3",
				fromPkgRoot: null,
				operation: "install_version",
			}),
		);
		assert.ok(fs.existsSync(old));
		assert.equal(readLedger(f.cfg).state, "missing");
		const broken = f.payload("1.2.4");
		fs.unlinkSync(path.join(broken, "dist/run-bridge.js"));
		const result = await applyVersion(f.cfg, ledger, {
			ver: "1.2.4",
			fromVer: "1.2.3",
			fromPkgRoot: old,
			loadTarball: async () => {
				assert.equal(readLedger(f.cfg).ledger.applying.phase, "installing");
				assert.equal(fs.existsSync(broken), false);
				throw new Error("download failed");
			},
		});
		assert.equal(result.outcome, "error");
		assert.ok(fs.existsSync(old));
	} finally {
		f.cleanup();
	}
});

test("preflight rejects corrupt ledger and releases lock; unattended off wins before ledger parsing", async () => {
	const { mutatorPreflight } = await import("../lib/preflight.mjs");
	const { acquireLock } = await import("../lib/lock.mjs");
	const f = fixture();
	try {
		fs.writeFileSync(
			path.join(f.cfg.stateDir, "update-ledger.json"),
			"corrupt",
		);
		await assert.rejects(
			mutatorPreflight(f.cfg),
			(error) => error.code === "ledger_corrupt",
		);
		acquireLock(f.cfg).release();
		fs.writeFileSync(path.join(f.cfg.stateDir, "auto-update.off"), "");
		const ctx = await mutatorPreflight(f.cfg, { unattended: true });
		assert.equal(ctx.disabled, true);
		ctx.lock.release();
		assert.equal(
			fs.readFileSync(path.join(f.cfg.stateDir, "update-ledger.json"), "utf8"),
			"corrupt",
		);
	} finally {
		f.cleanup();
	}
});

for (const command of ["onboard", "license"]) {
	test(`U12/U13 ${command} refuses corrupt ledger before prompt/network/handoff`, async () => {
		const f = fixture();
		try {
			const target = f.payload("1.2.3");
			flipCurrent(f.cfg, target);
			fs.writeFileSync(
				path.join(f.cfg.stateDir, "update-ledger.json"),
				"corrupt",
			);
			const module = await import(`../lib/${command}.mjs`);
			const run =
				command === "onboard" ? module.runOnboard : module.runLicenseSet;
			const errors = [];
			let effects = 0;
			const forbidden = () => {
				effects++;
				throw new Error("forbidden");
			};
			assert.equal(
				await run(f.cfg, {
					io: { out() {}, err: (line) => errors.push(line) },
					exec: forbidden,
					fetchImpl: forbidden,
					promptFn: forbidden,
				}),
				1,
			);
			assert.equal(effects, 0);
			assert.match(errors.join(""), /更新记录损坏/);
			assert.equal(currentPkgRoot(f.cfg), target);
		} finally {
			f.cleanup();
		}
	});
}

test("license continuation reuses preflight lock and releases it before handoff", async () => {
	const { runLicenseSet } = await import("../lib/license.mjs");
	const { acquireLock } = await import("../lib/lock.mjs");
	const f = fixture();
	try {
		flipCurrent(f.cfg, f.payload("1.2.3"));
		let handoffs = 0;
		assert.equal(
			await runLicenseSet(f.cfg, {
				io: { out() {}, err() {} },
				promptFn: async () => "fixture-key",
				fetchImpl: async () =>
					new Response(
						JSON.stringify({
							latest: "1.2.3",
							versions: [{ ver: "1.2.3", sha256: "a".repeat(64) }],
						}),
					),
				exec: () => {
					handoffs++;
					acquireLock(f.cfg).release();
				},
			}),
			0,
		);
		assert.equal(handoffs, 1);
	} finally {
		f.cleanup();
	}
});

test("preflight will not continue after recovery restored services but could not persist its receipt", async () => {
	const { mutatorPreflight } = await import("../lib/preflight.mjs");
	const { setApplying } = await import("../lib/ledger.mjs");
	const f = fixture();
	try {
		const old = f.payload("1.2.3");
		const target = f.payload("1.2.4");
		flipCurrent(f.cfg, target);
		setApplying(f.cfg, emptyLedger(), {
			operation: "update",
			ver: "1.2.4",
			fromVer: "1.2.3",
			fromPkgRoot: old,
			targetCreated: false,
			phase: "flipped",
			holdOutgoingReason: null,
			clearHoldOnVer: null,
			startedAt: "2026-09-14T00:00:00.000Z",
			trigger: "timer",
		});
		await assert.rejects(
			mutatorPreflight(f.cfg, {
				exec: (_cmd, [script]) => {
					if (script.startsWith(target)) throw new Error("unhealthy");
				},
				fsImpl: {
					...fs,
					renameSync() {
						throw new Error("write failed");
					},
				},
			}),
			/settlement could not be persisted/,
		);
		assert.equal(currentPkgRoot(f.cfg), old);
	} finally {
		f.cleanup();
	}
});

test("update preflights before network and reuses a local healthy target through durable apply", async () => {
	const { runUpdate } = await import("../lib/update.mjs");
	const { persistKey } = await import("../lib/key.mjs");
	const f = fixture();
	try {
		const old = f.payload("1.2.3");
		const target = f.payload("1.2.4");
		flipCurrent(f.cfg, old);
		persistKey(f.cfg.envFile, "fixture-key");
		let fetches = 0;
		const options = {
			io: { out() {}, err() {} },
			fetchImpl: async (url) => {
				fetches++;
				assert.ok(url.endsWith("/manifest"));
				return new Response(
					JSON.stringify({
						latest: "1.2.4",
						versions: [
							{ ver: "1.2.3", sha256: "b".repeat(64) },
							{ ver: "1.2.4", sha256: "a".repeat(64) },
						],
					}),
				);
			},
			exec: () => {},
		};
		fs.writeFileSync(
			path.join(f.cfg.stateDir, "update-ledger.json"),
			"corrupt",
		);
		assert.equal(await runUpdate(f.cfg, options), 1);
		assert.equal(fetches, 0);
		fs.unlinkSync(path.join(f.cfg.stateDir, "update-ledger.json"));
		assert.equal(await runUpdate(f.cfg, options), 0);
		assert.equal(fetches, 1);
		assert.equal(currentPkgRoot(f.cfg), target);
		assert.equal(readLedger(f.cfg).ledger.lastRun.outcome, "updated");
	} finally {
		f.cleanup();
	}
});

for (const mode of [
	"deferred",
	"held",
	"withdrawn",
	"paused",
	"unauthorized",
	"off",
]) {
	test(`unattended update ${mode} respects schedule, holds, pause and never prompts`, async () => {
		const { runUpdate } = await import("../lib/update.mjs");
		const { persistKey } = await import("../lib/key.mjs");
		const { setHold, writeLedger } = await import("../lib/ledger.mjs");
		const f = fixture();
		try {
			const old = f.payload("1.2.3");
			const target = f.payload("1.2.4");
			flipCurrent(f.cfg, old);
			persistKey(f.cfg.envFile, "fixture-key");
			const at = new Date(2026, 8, 14, 12).toISOString();
			if (mode === "held") {
				const ledger = emptyLedger();
				setHold(ledger, "1.2.4", "manual_rollback", at);
				writeLedger(f.cfg, ledger);
			}
			if (mode === "off")
				fs.writeFileSync(path.join(f.cfg.stateDir, "auto-update.off"), "");
			let fetches = 0;
			let prompts = 0;
			let restarts = 0;
			const rc = await runUpdate(f.cfg, {
				unattended: true,
				now: () => at,
				io: { out() {}, err() {} },
				promptFn: () => {
					prompts++;
					throw new Error("unattended prompt");
				},
				exec: () => {
					restarts++;
				},
				fetchImpl: async () => {
					fetches++;
					if (mode === "paused")
						return new Response('{"error":"no-release-available"}', {
							status: 503,
						});
					if (mode === "unauthorized")
						return new Response(null, { status: 401 });
					return new Response(
						JSON.stringify({
							latest: "1.2.4",
							versions: [
								{ ver: "1.2.4", sha256: "a".repeat(64) },
								...(mode === "withdrawn"
									? []
									: [{ ver: "1.2.3", sha256: "b".repeat(64) }]),
							],
						}),
					);
				},
			});
			assert.equal(prompts, 0);
			assert.equal(rc, mode === "unauthorized" ? 1 : 0);
			assert.equal(restarts, mode === "withdrawn" ? 1 : 0);
			assert.equal(currentPkgRoot(f.cfg), mode === "withdrawn" ? target : old);
			if (mode === "off") assert.equal(fetches, 0);
			else {
				const ledger = readLedger(f.cfg).ledger;
				assert.equal(
					ledger.lastRun.outcome,
					mode === "withdrawn" ? "updated" : mode,
				);
				if (mode === "withdrawn")
					assert.equal(ledger.holds["1.2.3"].reason, "withdrawn_observed");
			}
		} finally {
			f.cleanup();
		}
	});
}

test("CLI update --unattended respects off marker without requiring a key", async () => {
	const { spawnSync } = await import("node:child_process");
	const f = fixture();
	try {
		fs.writeFileSync(path.join(f.cfg.stateDir, "auto-update.off"), "");
		const result = spawnSync(
			process.execPath,
			[
				new URL("../bin/flywheel-onboard.js", import.meta.url).pathname,
				"update",
				"--unattended",
			],
			{
				env: { ...process.env, FLYWHEEL_STATE_DIR: f.cfg.stateDir },
				encoding: "utf8",
			},
		);
		assert.equal(result.status, 0, result.stderr);
	} finally {
		f.cleanup();
	}
});

test("prune keeps current and verified previous-good only after a successful ledger commit", async () => {
	const { pruneVersions } = await import("../lib/prune.mjs");
	const { addKnownGood, writeLedger, recordRun } = await import(
		"../lib/ledger.mjs"
	);
	const f = fixture();
	try {
		for (const ver of ["1.2.1", "1.2.2", "1.2.3"]) f.payload(ver);
		flipCurrent(f.cfg, f.payload("1.2.4"));
		const ledger = emptyLedger();
		addKnownGood(ledger, "1.2.3", "outgoing");
		addKnownGood(ledger, "1.2.4", "health");
		writeLedger(f.cfg, ledger);
		pruneVersions(f.cfg);
		assert.equal(fs.readdirSync(f.cfg.versionsDir).length, 4);
		recordRun(ledger, {
			at: new Date().toISOString(),
			trigger: "manual",
			outcome: "updated",
			latest: "1.2.4",
			detail: "",
		});
		writeLedger(f.cfg, ledger);
		pruneVersions(f.cfg);
		assert.deepEqual(fs.readdirSync(f.cfg.versionsDir).sort(), [
			"1.2.3",
			"1.2.4",
		]);
		f.payload("1.2.5");
		fs.writeFileSync(
			path.join(f.cfg.stateDir, "update-ledger.json"),
			"corrupt",
		);
		pruneVersions(f.cfg);
		assert.ok(fs.existsSync(path.join(f.cfg.versionsDir, "1.2.5")));
	} finally {
		f.cleanup();
	}
});

test("update retries a health failure after one hour once, then holds the third attempt", async () => {
	const { runUpdate } = await import("../lib/update.mjs");
	const { persistKey } = await import("../lib/key.mjs");
	const f = fixture();
	try {
		const old = f.payload("1.2.3");
		const target = f.payload("1.2.4");
		flipCurrent(f.cfg, old);
		persistKey(f.cfg.envFile, "fixture-key");
		let starts = 0;
		for (const [hour, rc, attempts, outcome] of [
			[3, 1, 1, "rolled_back"],
			[4, 1, 2, "rolled_back"],
			[5, 0, 2, "held"],
		]) {
			assert.equal(
				await runUpdate(f.cfg, {
					io: { out() {}, err() {} },
					now: () => new Date(2026, 8, 14, hour).toISOString(),
					exec: (_cmd, [script]) => {
						if (script.startsWith(target)) {
							starts++;
							throw new Error("bad health");
						}
					},
					fetchImpl: async () =>
						new Response(
							JSON.stringify({
								latest: "1.2.4",
								versions: ["1.2.3", "1.2.4"].map((ver) => ({
									ver,
									sha256: "a".repeat(64),
								})),
							}),
						),
				}),
				rc,
			);
			const ledger = readLedger(f.cfg).ledger;
			assert.equal(ledger.holds["1.2.4"].attempts, attempts);
			assert.equal(ledger.lastRun.outcome, outcome);
		}
		assert.equal(starts, 2);
	} finally {
		f.cleanup();
	}
});

for (const failure of ["phase_write", "flip"]) {
	test(`preflip ${failure} failure clears intent, leaves current and reused target intact`, async () => {
		const { applyVersion } = await import("../lib/apply.mjs");
		const f = fixture();
		try {
			const old = f.payload("1.2.3");
			const target = f.payload("1.2.4");
			flipCurrent(f.cfg, old);
			const ledger = emptyLedger();
			let writes = 0;
			let restarts = 0;
			const result = await applyVersion(f.cfg, ledger, {
				ver: "1.2.4",
				fromVer: "1.2.3",
				fromPkgRoot: old,
				flip:
					failure === "flip"
						? () => {
								throw new Error("flip failure");
							}
						: flipCurrent,
				fsImpl: {
					...fs,
					renameSync(...args) {
						if (++writes === 2 && failure === "phase_write")
							throw new Error("phase write failure");
						fs.renameSync(...args);
					},
				},
				exec: () => {
					restarts++;
				},
			});
			assert.equal(result.outcome, "error");
			assert.equal(restarts, 0);
			assert.equal(currentPkgRoot(f.cfg), old);
			assert.ok(fs.existsSync(target));
			assert.equal(readLedger(f.cfg).ledger.applying, null);
		} finally {
			f.cleanup();
		}
	});
}

test("rollback uses local previous-good and commits outgoing hold with successful apply", async () => {
	const { runRollback } = await import("../lib/rollback.mjs");
	const { addKnownGood, writeLedger } = await import("../lib/ledger.mjs");
	const f = fixture();
	try {
		const old = f.payload("1.2.3");
		const current = f.payload("1.2.4");
		flipCurrent(f.cfg, current);
		const ledger = emptyLedger();
		addKnownGood(ledger, "1.2.3", "outgoing");
		addKnownGood(ledger, "1.2.4", "health");
		writeLedger(f.cfg, ledger);
		assert.equal(
			await runRollback(f.cfg, { io: { out() {}, err() {} }, exec: () => {} }),
			0,
		);
		assert.equal(currentPkgRoot(f.cfg), old);
		assert.equal(
			readLedger(f.cfg).ledger.holds["1.2.4"].reason,
			"manual_rollback",
		);
	} finally {
		f.cleanup();
	}
});

test("explicit install refuses invisible version before payload request and overrides a held current", async () => {
	const { runInstallVersion } = await import("../lib/install-version.mjs");
	const { setHold, writeLedger } = await import("../lib/ledger.mjs");
	const { persistKey } = await import("../lib/key.mjs");
	const f = fixture();
	try {
		const current = f.payload("1.2.4");
		flipCurrent(f.cfg, current);
		persistKey(f.cfg.envFile, "fixture-key");
		const ledger = emptyLedger();
		setHold(ledger, "1.2.4", "manual_rollback");
		writeLedger(f.cfg, ledger);
		let starts = 0;
		const opts = {
			io: { out() {}, err() {} },
			exec: () => {
				starts++;
			},
			fetchImpl: async (url) => {
				assert.ok(url.endsWith("/manifest"));
				return new Response(
					JSON.stringify({
						latest: "1.2.4",
						versions: [{ ver: "1.2.4", sha256: "a".repeat(64) }],
					}),
				);
			},
		};
		assert.equal(await runInstallVersion(f.cfg, "1.2.3", opts), 1);
		assert.equal(starts, 0);
		assert.equal(await runInstallVersion(f.cfg, "1.2.4", opts), 0);
		assert.equal(starts, 1);
		assert.equal(readLedger(f.cfg).ledger.holds["1.2.4"], undefined);
		assert.equal(currentPkgRoot(f.cfg), current);
	} finally {
		f.cleanup();
	}
});

for (const point of ["healthy", "committed"]) {
	test(`rollback SIGKILL at ${point} resumes in a new process and preserves outgoing hold`, async () => {
		const { spawnSync } = await import("node:child_process");
		const { addKnownGood, writeLedger } = await import("../lib/ledger.mjs");
		const f = fixture();
		try {
			const old = f.payload("1.2.3");
			flipCurrent(f.cfg, f.payload("1.2.4"));
			const ledger = emptyLedger();
			addKnownGood(ledger, "1.2.3", "health");
			writeLedger(f.cfg, ledger);
			const code = `import {runRollback} from ${JSON.stringify(new URL("../lib/rollback.mjs", import.meta.url).href)}; await runRollback(JSON.parse(process.argv[1]), {io:{out(){},err(){}},exec(){},checkpoint(name){if(name===process.argv[2])process.kill(process.pid,'SIGKILL');}});`;
			const child = spawnSync(
				process.execPath,
				["--input-type=module", "-e", code, JSON.stringify(f.cfg), point],
				{ encoding: "utf8", timeout: 5000 },
			);
			assert.equal(child.signal, "SIGKILL", child.stderr);
			assert.equal(currentPkgRoot(f.cfg), old);
			if (point === "healthy")
				assert.equal(
					readLedger(f.cfg).ledger.applying.holdOutgoingReason,
					"manual_rollback",
				);
			// Linux's deliberately non-reclaimed mkdir lock requires operator cleanup after a killed process.
			if (process.platform !== "darwin")
				fs.rmSync(path.join(f.cfg.stateDir, "update.lock.d"), {
					recursive: true,
					force: true,
				});
			const resume = `import {mutatorPreflight} from ${JSON.stringify(new URL("../lib/preflight.mjs", import.meta.url).href)};const ctx=await mutatorPreflight(JSON.parse(process.argv[1]),{exec(){}});ctx.lock.release();`;
			const next = spawnSync(
				process.execPath,
				["--input-type=module", "-e", resume, JSON.stringify(f.cfg)],
				{ encoding: "utf8", timeout: 5000 },
			);
			assert.equal(next.status, 0, next.stderr);
			assert.equal(readLedger(f.cfg).ledger.applying, null);
			assert.equal(
				readLedger(f.cfg).ledger.holds["1.2.4"].reason,
				"manual_rollback",
			);
		} finally {
			f.cleanup();
		}
	});
}

test("held-current install SIGKILL after failure receipt replays without removing current or recounting", async () => {
	const { spawnSync } = await import("node:child_process");
	const { setHold, writeLedger } = await import("../lib/ledger.mjs");
	const { persistKey } = await import("../lib/key.mjs");
	const f = fixture();
	try {
		const target = f.payload("1.2.4");
		flipCurrent(f.cfg, target);
		persistKey(f.cfg.envFile, "fixture-key");
		const ledger = emptyLedger();
		setHold(ledger, "1.2.4", "manual_rollback", "2026-09-13T00:00:00.000Z");
		writeLedger(f.cfg, ledger);
		const code = `import {runInstallVersion} from ${JSON.stringify(new URL("../lib/install-version.mjs", import.meta.url).href)};await runInstallVersion(JSON.parse(process.argv[1]),'1.2.4',{io:{out(){},err(){}},fetchImpl:async()=>new Response(JSON.stringify({latest:'1.2.4',versions:[{ver:'1.2.4',sha256:'a'.repeat(64)}]})),exec(){throw new Error('unhealthy')},checkpoint(name){if(name==='failure_receipt')process.kill(process.pid,'SIGKILL')}});`;
		const child = spawnSync(
			process.execPath,
			["--input-type=module", "-e", code, JSON.stringify(f.cfg)],
			{ encoding: "utf8", timeout: 5000 },
		);
		assert.equal(child.signal, "SIGKILL", child.stderr);
		const attempts = readLedger(f.cfg).ledger.holds["1.2.4"].attempts;
		if (process.platform !== "darwin")
			fs.rmSync(path.join(f.cfg.stateDir, "update.lock.d"), {
				recursive: true,
				force: true,
			});
		const resume = `import {mutatorPreflight} from ${JSON.stringify(new URL("../lib/preflight.mjs", import.meta.url).href)};const ctx=await mutatorPreflight(JSON.parse(process.argv[1]),{exec(){throw new Error('unhealthy')}});ctx.lock.release();`;
		const next = spawnSync(
			process.execPath,
			["--input-type=module", "-e", resume, JSON.stringify(f.cfg)],
			{ encoding: "utf8", timeout: 5000 },
		);
		assert.equal(next.status, 0, next.stderr);
		assert.equal(currentPkgRoot(f.cfg), target);
		assert.ok(fs.existsSync(target));
		assert.equal(readLedger(f.cfg).ledger.holds["1.2.4"].attempts, attempts);
		assert.equal(readLedger(f.cfg).ledger.lastRun.outcome, "degraded");
	} finally {
		f.cleanup();
	}
});

test("CLI dispatches rollback and rejects unsafe explicit install versions", async () => {
	const { spawnSync } = await import("node:child_process");
	const f = fixture();
	try {
		const bin = new URL("../bin/flywheel-onboard.js", import.meta.url).pathname;
		const options = {
			env: { ...process.env, FLYWHEEL_STATE_DIR: f.cfg.stateDir },
			encoding: "utf8",
			timeout: 5000,
		};
		const rollback = spawnSync(process.execPath, [bin, "rollback"], options);
		assert.equal(rollback.status, 1, rollback.stderr);
		assert.match(rollback.stderr, /没有可回退的本地版本/);
		const invalid = spawnSync(
			process.execPath,
			[bin, "install", "../escape"],
			options,
		);
		assert.equal(invalid.status, 2, invalid.stderr);
		assert.doesNotMatch(invalid.stderr, /\.\.\/escape/);
	} finally {
		f.cleanup();
	}
});

test("rollback unhealthy local target restores original services and retains target directory", async () => {
	const { runRollback } = await import("../lib/rollback.mjs");
	const { addKnownGood, writeLedger } = await import("../lib/ledger.mjs");
	const f = fixture();
	try {
		const old = f.payload("1.2.3");
		const current = f.payload("1.2.4");
		flipCurrent(f.cfg, current);
		const ledger = emptyLedger();
		addKnownGood(ledger, "1.2.3", "health");
		writeLedger(f.cfg, ledger);
		let restarts = 0;
		assert.equal(
			await runRollback(f.cfg, {
				io: { out() {}, err() {} },
				exec: (_cmd, [script]) => {
					restarts++;
					if (script.startsWith(old)) throw new Error("unhealthy");
				},
			}),
			1,
		);
		assert.equal(restarts, 2);
		assert.equal(currentPkgRoot(f.cfg), current);
		assert.ok(fs.existsSync(old));
		assert.equal(readLedger(f.cfg).ledger.holds["1.2.4"], undefined);
	} finally {
		f.cleanup();
	}
});

test("explicit install healthy current is a no-op; damaged current fails without modifying payload or ledger", async () => {
	const { runInstallVersion } = await import("../lib/install-version.mjs");
	const { persistKey } = await import("../lib/key.mjs");
	const f = fixture();
	try {
		const current = f.payload("1.2.4");
		flipCurrent(f.cfg, current);
		persistKey(f.cfg.envFile, "fixture-key");
		let starts = 0;
		const opts = {
			io: { out() {}, err() {} },
			exec: () => {
				starts++;
			},
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						latest: "1.2.4",
						versions: [{ ver: "1.2.4", sha256: "a".repeat(64) }],
					}),
				),
		};
		assert.equal(await runInstallVersion(f.cfg, "1.2.4", opts), 0);
		assert.equal(starts, 0);
		fs.unlinkSync(path.join(current, "dist/run-bridge.js"));
		const before = fs.readFileSync(
			path.join(current, ".flywheel-prebuilt"),
			"utf8",
		);
		assert.equal(await runInstallVersion(f.cfg, "1.2.4", opts), 1);
		assert.equal(readLedger(f.cfg).state, "missing");
		assert.equal(
			fs.readFileSync(path.join(current, ".flywheel-prebuilt"), "utf8"),
			before,
		);
		assert.equal(currentPkgRoot(f.cfg), current);
		assert.equal(starts, 0);
	} finally {
		f.cleanup();
	}
});

test("manual up-to-date update refreshes durable shell even without a payload upgrade", async () => {
	const { runUpdate } = await import("../lib/update.mjs");
	const { persistKey } = await import("../lib/key.mjs");
	const f = fixture();
	try {
		flipCurrent(f.cfg, f.payload("1.2.4"));
		persistKey(f.cfg.envFile, "fixture-key");
		assert.equal(
			await runUpdate(f.cfg, {
				io: { out() {}, err() {} },
				fetchImpl: async () =>
					new Response(
						JSON.stringify({
							latest: "1.2.4",
							versions: [{ ver: "1.2.4", sha256: "a".repeat(64) }],
						}),
					),
			}),
			0,
		);
		assert.ok(
			fs.existsSync(
				path.join(f.cfg.stateDir, "shell/current/bin/flywheel-onboard.js"),
			),
		);
	} finally {
		f.cleanup();
	}
});
