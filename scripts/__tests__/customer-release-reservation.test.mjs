import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(
	new URL("../../packages/teamlead/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const rootRequire = createRequire(
	new URL("../../package.json", import.meta.url),
);

test(
	"two processes contending for one week return one frozen cycle and one audit event",
	{ timeout: 120_000 },
	async (context) => {
		const root = mkdtempSync(join(tmpdir(), "fly2391-reservation-race-"));
		const path = join(root, "state.db");
		const children = [];
		const db = new Database(path);
		try {
			const start = async () => {
				const child = fork(
					fileURLToPath(
						new URL(
							"./fixtures/customer-release-reserve-worker.mjs",
							import.meta.url,
						),
					),
					[path],
					{
						execArgv: ["--import", rootRequire.resolve("tsx")],
						stdio: ["ignore", "ignore", "pipe", "ipc"],
					},
				);
				children.push(child);
				let stderr = "";
				child.stderr.on("data", (chunk) => {
					stderr += chunk;
				});
				const messages = [];
				const waiters = new Map();
				context.signal.addEventListener(
					"abort",
					() => {
						for (const waiter of waiters.values())
							waiter.reject(context.signal.reason);
					},
					{ once: true },
				);
				child.on("message", (message) => {
					messages.push(message);
					waiters.get(message.kind)?.resolve(message);
					if (message.kind === "error") {
						for (const waiter of waiters.values())
							waiter.reject(new Error(message.message));
					}
				});
				child.on("error", (error) => {
					for (const waiter of waiters.values()) waiter.reject(error);
				});
				child.on("exit", (code) => {
					if (code !== 0)
						for (const waiter of waiters.values())
							waiter.reject(new Error(stderr || `child exited ${code}`));
				});
				const wait = (kind) => {
					const seen = messages.find((message) => message.kind === kind);
					return seen
						? Promise.resolve(seen)
						: new Promise((resolve, reject) =>
								waiters.set(kind, { resolve, reject }),
							);
				};
				await wait("ready");
				return { child, wait };
			};
			// Finish migration before the contested operation; no startup sleep guesses.
			const first = await start();
			const second = await start();
			assert.notEqual(first.child.pid, second.child.pid);
			const input = {
				projectId: "flywheel",
				slotDate: "2026-09-15",
				releaseId: "release-first",
				activationEpoch: 1,
				policyRevision: "c".repeat(64),
				betaVersion: "1.2.3-beta.1",
				now: 1_789_488_000_000,
				manifest: {
					versions: {
						"1.2.3-beta.1": {
							channel: "beta",
							status: "active",
							sourceCommit: "a".repeat(40),
							sha256: "b".repeat(64),
						},
					},
				},
			};
			const results = Promise.all([
				first.wait("result"),
				second.wait("result"),
			]);
			// Hold the write lock until both independent processes announce reserve.
			db.exec("BEGIN IMMEDIATE");
			first.child.send(input);
			second.child.send({
				...input,
				slotDate: "2026-09-18",
				releaseId: "release-second",
				activationEpoch: 2,
			});
			await Promise.all([first.wait("attempting"), second.wait("attempting")]);
			db.exec("COMMIT");
			const [left, right] = await results;
			assert.deepEqual(left.cycle, right.cycle);
			assert.ok(
				["release-first", "release-second"].includes(left.cycle.releaseId),
			);
			assert.equal(left.cycle.weekStart, "2026-09-14");
			assert.deepEqual(
				db.prepare("SELECT count(*) AS n FROM customer_release_cycles").get(),
				{ n: 1 },
			);
			assert.deepEqual(
				db.prepare("SELECT kind FROM customer_release_events").all(),
				[{ kind: "cycle_reserved" }],
			);
		} finally {
			if (db.inTransaction) db.exec("ROLLBACK");
			db.close();
			await Promise.all(
				children.map(async (child) => {
					if (child.exitCode !== null || child.signalCode !== null) return;
					const exited = once(child, "exit");
					child.kill();
					await exited;
				}),
			);
			rmSync(root, { recursive: true, force: true });
		}
	},
);
