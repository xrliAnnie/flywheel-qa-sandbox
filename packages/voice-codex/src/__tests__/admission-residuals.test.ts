import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AdmissionResidualRegistry,
	parseProcessTable,
	type ResidualSystem,
} from "../codex/admission-residuals.js";

/** A tiny process table: fork, exit (children reparent to launchd), stop, kill. */
class FakeHost implements ResidualSystem {
	readonly rows = new Map<
		number,
		{ ppid: number; start: string; stopped: boolean; zombie: boolean }
	>();
	readonly signals: Array<[number, string]> = [];
	private clock = Date.parse("2026-09-26T08:00:00.000Z");
	/** Runs after every signal; lets a test fork "during" the reap. */
	onSignal?: (pid: number, signal: string) => void;
	refuseKill = new Set<number>();
	failRemoveFile = false;
	removeFile(path: string) {
		if (this.failRemoveFile)
			throw Object.assign(new Error("EIO"), { code: "EIO" });
		rmSync(path, { force: true });
	}

	spawn(pid: number, ppid: number): number {
		this.clock += 1000;
		this.rows.set(pid, {
			ppid,
			start: new Date(this.clock).toUTCString(),
			stopped: false,
			zombie: false,
		});
		return pid;
	}
	exit(pid: number): void {
		this.rows.delete(pid);
		for (const row of this.rows.values()) if (row.ppid === pid) row.ppid = 1;
	}
	snapshot() {
		return [...this.rows].map(([pid, row]) => ({
			pid,
			ppid: row.ppid,
			start: row.start,
			zombie: row.zombie,
		}));
	}
	identityOf(pid: number) {
		const row = this.rows.get(pid);
		return row
			? { pid, ppid: row.ppid, start: row.start, zombie: row.zombie }
			: undefined;
	}
	signal(pid: number, signal: "SIGSTOP" | "SIGKILL") {
		this.signals.push([pid, signal]);
		const row = this.rows.get(pid);
		if (!row)
			throw Object.assign(new Error("no such process"), { code: "ESRCH" });
		if (signal === "SIGSTOP") row.stopped = true;
		else if (!this.refuseKill.has(pid)) this.exit(pid);
		this.onSignal?.(pid, signal);
	}
	removeDirectory(path: string) {
		rmSync(path, { recursive: true, force: true });
	}
	async pause() {}
}

let root: string;
let host: FakeHost;
let reports: string[];
let evidence: Record<string, unknown>[];
const DAEMON = 500;
const UNRELATED = 900;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "voice-residuals-"));
	host = new FakeHost();
	host.spawn(1, 0);
	host.spawn(DAEMON, 1);
	host.spawn(UNRELATED, 1);
	reports = [];
	evidence = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const registry = () =>
	new AdmissionResidualRegistry({
		root: join(root, "residuals"),
		system: host,
		report: (line) => reports.push(line),
		evidence: (record) => evidence.push(record),
	});
const SESSION = "10000000-0000-4000-8000-000000000001";
const file = () => join(root, "residuals", `${SESSION}.json`);

describe("admission residual reaping (FLY-2886 §14.2)", () => {
	it("parses macOS ps rows including lstart spaces and zombies", () => {
		expect(
			parseProcessTable(
				"  701   500 Ss   Sat Sep 26 08:00:01 2026\n  702   701 Z+   Sat Sep 26 08:00:02 2026\n",
			),
		).toEqual([
			{ pid: 701, ppid: 500, start: "Sat Sep 26 08:00:01 2026", zombie: false },
			{ pid: 702, ppid: 701, start: "Sat Sep 26 08:00:02 2026", zombie: true },
		]);
	});

	it("freezes then kills the registered worker and a helper it spawned, removes directories and settles", async () => {
		const dir = join(root, "admission");
		mkdirSync(dir);
		const residuals = registry().forSession(SESSION);
		residuals.registerSpawned(host.spawn(701, DAEMON));
		residuals.registerDirectory(dir);
		host.spawn(702, 701);
		expect(existsSync(file())).toBe(true);
		expect(await residuals.reap((record) => evidence.push(record))).toBe(
			"settled",
		);
		expect(host.rows.has(701)).toBe(false);
		expect(host.rows.has(702)).toBe(false);
		expect(host.rows.has(UNRELATED)).toBe(true);
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(file())).toBe(false);
		// Everything was stopped before anything was killed.
		const firstKill = host.signals.findIndex(([, s]) => s === "SIGKILL");
		expect(
			host.signals
				.slice(0, firstKill)
				.map(([pid, s]) => `${pid}:${s}`)
				.sort(),
		).toEqual(["701:SIGSTOP", "702:SIGSTOP"]);
		expect(reports).toEqual([]);
		expect(evidence.at(-1)).toMatchObject({
			kind: "codex_voice_admission_residual",
			outcome: "settled",
		});
	});

	it("registers and kills a child forked while the tree was being frozen", async () => {
		const residuals = registry().forSession(SESSION);
		residuals.registerSpawned(host.spawn(701, DAEMON));
		let forked = false;
		host.onSignal = (pid, signal) => {
			// A race: the worker forks right as the first stop lands.
			if (pid === 701 && signal === "SIGSTOP" && !forked) {
				forked = true;
				host.spawn(703, 701);
			}
		};
		expect(await residuals.reap()).toBe("settled");
		expect(host.rows.has(703)).toBe(false);
		expect(host.signals).toContainEqual([703, "SIGSTOP"]);
	});

	it("never signals an unrelated process, even one that looks related", async () => {
		const residuals = registry().forSession(SESSION);
		residuals.registerSpawned(host.spawn(701, DAEMON));
		// Older than the worker, now parented to it (as setpgid/reparenting could look):
		// not a descendant it could have created, so never inherited.
		host.rows.get(UNRELATED)!.ppid = 701;
		expect(await residuals.reap()).toBe("settled");
		expect(host.rows.has(UNRELATED)).toBe(true);
		expect(host.signals.map(([pid]) => pid)).not.toContain(UNRELATED);
	});

	it("does not touch a reused pid whose start time differs", async () => {
		const residuals = registry().forSession(SESSION);
		residuals.registerSpawned(host.spawn(701, DAEMON));
		host.exit(701);
		host.spawn(701, DAEMON); // same pid, new process
		expect(await residuals.reap()).toBe("settled");
		expect(host.rows.has(701)).toBe(true);
		expect(host.signals).toEqual([]);
		// The original exited before we could look at its children.
		expect(reports).toHaveLength(1);
		expect(reports[0]).toContain("reasonClass=admission_residual_unprovable");
	});

	it("keeps a first failure on file and finishes on a later periodic attempt", async () => {
		const residuals = registry().forSession(SESSION);
		residuals.registerSpawned(host.spawn(701, DAEMON));
		host.refuseKill.add(701);
		expect(await residuals.reap()).toBe("pending");
		expect(existsSync(file())).toBe(true);
		host.refuseKill.clear();
		await registry().sweep();
		expect(host.rows.has(701)).toBe(false);
		expect(existsSync(file())).toBe(false);
		expect(evidence.at(-1)).toMatchObject({ outcome: "settled", attempt: 2 });
	});

	it("reports once after three unsettled attempts", async () => {
		const residuals = registry().forSession(SESSION);
		residuals.registerSpawned(host.spawn(701, DAEMON));
		host.refuseKill.add(701);
		await residuals.reap();
		await registry().sweep();
		expect(reports).toEqual([]);
		await registry().sweep();
		await registry().sweep();
		expect(reports).toHaveLength(1);
		expect(reports[0]).toContain("reasonClass=admission_residual_unsettled");
		expect(reports[0]).toContain("attempts=3");
	});

	it("after a daemon restart, reaps a helper observed while its worker was alive", async () => {
		const residuals = registry().forSession(SESSION);
		residuals.registerSpawned(host.spawn(701, DAEMON));
		host.spawn(702, 701);
		host.refuseKill.add(701).add(702);
		await residuals.reap(); // observes 702 while 701 is alive; kill refused
		host.refuseKill.clear();
		// Worker dies and the daemon restarts; the helper is now under launchd.
		host.exit(701);
		host.exit(DAEMON);
		expect(host.rows.get(702)?.ppid).toBe(1);
		await registry().sweep();
		expect(host.rows.has(702)).toBe(false);
		expect(existsSync(file())).toBe(false);
	});

	it("leaves an orphan whose worker exited before any snapshot, and reports it", async () => {
		const residuals = registry().forSession(SESSION);
		residuals.registerSpawned(host.spawn(701, DAEMON));
		host.spawn(702, 701);
		host.exit(701); // before any reap snapshot: 702 goes to launchd unobserved
		expect(await residuals.reap()).toBe("settled");
		expect(host.rows.has(702)).toBe(true);
		expect(host.signals).toEqual([]);
		expect(reports).toHaveLength(1);
		expect(reports[0]).toContain("parent=701@");
	});

	it("treats a zombie as gone", async () => {
		const residuals = registry().forSession(SESSION);
		residuals.registerSpawned(host.spawn(701, DAEMON));
		await residuals.reap();
		host.spawn(801, DAEMON);
		const second = registry().forSession(
			"20000000-0000-4000-8000-000000000002",
		);
		second.registerSpawned(801);
		host.rows.get(801)!.zombie = true;
		expect(await second.reap()).toBe("settled");
		expect(host.signals.map(([pid]) => pid)).not.toContain(801);
	});
});

it.skipIf(process.platform !== "darwin")(
	"reaps a real worker and the helper it forked by exact identity (host ps and signals)",
	async () => {
		const { spawn } = await import("node:child_process");
		const { hostResidualSystem } = await import(
			"../codex/admission-residuals.js"
		);
		const bystander = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
		const worker = spawn(
			process.execPath,
			[
				"-e",
				"require('node:child_process').spawn('/bin/sleep',['30'],{stdio:'ignore'});setInterval(()=>{},1000)",
			],
			{ stdio: "ignore" },
		);
		try {
			const real = new AdmissionResidualRegistry({
				root: join(root, "real-residuals"),
				system: hostResidualSystem,
				report: (line) => reports.push(line),
			}).forSession(SESSION);
			await new Promise((resolve) => setTimeout(resolve, 300));
			real.registerSpawned(worker.pid!);
			const helper = () =>
				hostResidualSystem
					.snapshot()
					.find((row) => row.ppid === worker.pid && !row.zombie);
			await new Promise((resolve) => setTimeout(resolve, 200));
			const helperPid = helper()?.pid;
			expect(helperPid).toBeDefined();
			expect(await real.reap()).toBe("settled");
			const table = hostResidualSystem.snapshot();
			const alive = (pid: number) =>
				table.some((row) => row.pid === pid && !row.zombie);
			expect(alive(worker.pid!)).toBe(false);
			expect(alive(helperPid!)).toBe(false);
			expect(alive(bystander.pid!)).toBe(true);
			expect(reports).toEqual([]);
		} finally {
			worker.kill("SIGKILL");
			bystander.kill("SIGKILL");
		}
	},
	20_000,
);

describe("ownership of in-flight and admitted sessions (FLY-2886 §14.2)", () => {
	it("never sweeps a session this daemon is still admitting", async () => {
		const reg = registry();
		const claimed = reg.claim(SESSION);
		claimed.registerSpawned(host.spawn(701, DAEMON));
		await reg.sweep();
		expect(host.rows.has(701)).toBe(true);
		expect(host.signals).toEqual([]);
		// After the admission's own teardown hands it over, the sweep may act.
		claimed.detach();
		await reg.sweep();
		expect(host.rows.has(701)).toBe(false);
	});

	it("an admitted session releases its record: nothing left for the sweep, later spawns ignored", async () => {
		const reg = registry();
		const claimed = reg.claim(SESSION);
		claimed.registerSpawned(host.spawn(701, DAEMON));
		claimed.release();
		expect(existsSync(file())).toBe(false);
		claimed.registerSpawned(host.spawn(702, DAEMON));
		expect(existsSync(file())).toBe(false);
		await reg.sweep();
		expect(host.rows.has(701)).toBe(true);
		expect(host.rows.has(702)).toBe(true);
		expect(host.signals).toEqual([]);
	});
});

it("re-reads the exact identity right before each signal: a pid reused after the snapshot is never signalled (review R1#2)", async () => {
	const reg = registry();
	const residuals = reg.claim(SESSION);
	residuals.registerSpawned(host.spawn(701, DAEMON));
	// Between the reap snapshot and the first signal, 701 exits and the pid is reused.
	const original = host.snapshot.bind(host);
	let snapshots = 0;
	host.snapshot = () => {
		const rows = original();
		if (++snapshots === 1) {
			host.exit(701);
			host.spawn(701, DAEMON);
		}
		return rows;
	};
	await residuals.reap();
	expect(host.signals).toEqual([]);
	expect(host.rows.has(701)).toBe(true);
});

describe("review R2 durability", () => {
	it("a release whose unlink fails leaves no reapable identity and keeps the session held (R2#1)", async () => {
		const reg = registry();
		const claimed = reg.claim(SESSION);
		claimed.registerSpawned(host.spawn(701, DAEMON));
		host.failRemoveFile = true;
		claimed.release();
		host.failRemoveFile = false;
		await reg.sweep();
		await registry().sweep(); // e.g. after a restart: only the file remains
		expect(host.rows.has(701)).toBe(true);
		expect(host.signals).toEqual([]);
	});

	it("a failing identity read is not proof the process is gone (R2#2)", async () => {
		const reg = registry();
		const residuals = reg.claim(SESSION);
		residuals.registerSpawned(host.spawn(701, DAEMON));
		const identityOf = host.identityOf.bind(host);
		host.identityOf = () => {
			throw Object.assign(new Error("ps timed out"), { code: "ETIMEDOUT" });
		};
		expect(await residuals.reap()).toBe("pending");
		expect(host.signals).toEqual([]);
		host.identityOf = identityOf;
		residuals.detach();
		await reg.sweep();
		expect(host.rows.has(701)).toBe(false);
	});
});

it("host ps lookups: only exit 1 with no output means absent; other failures throw (R2#2)", async () => {
	const { interpretPsLookup } = await import("../codex/admission-residuals.js");
	expect(
		interpretPsLookup(() => {
			throw Object.assign(new Error("exit 1"), { status: 1, stdout: "" });
		}, 701),
	).toBeUndefined();
	expect(
		interpretPsLookup(() => "  701   500 Ss   Sat Sep 26 08:00:01 2026\n", 701),
	).toEqual({
		pid: 701,
		ppid: 500,
		start: "Sat Sep 26 08:00:01 2026",
		zombie: false,
	});
	for (const error of [
		Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
		Object.assign(new Error("spawn failed"), { code: "EAGAIN" }),
		Object.assign(new Error("odd"), { status: 1, stdout: "garbage" }),
	])
		expect(() =>
			interpretPsLookup(() => {
				throw error;
			}, 701),
		).toThrow();
});
