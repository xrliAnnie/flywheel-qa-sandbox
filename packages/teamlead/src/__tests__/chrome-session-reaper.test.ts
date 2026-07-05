/**
 * FLY-766: unit tests for the agent-browser Chrome-for-Testing reaper.
 * The reaper's IO (two `ps` passes, marker read, stat, pid revalidation, kill)
 * is fully injected, so these tests are hermetic — no real processes touched.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type OwnerMarker,
	type ParsedChrome,
	parseChromeProc,
	type ReapChromeDeps,
	reapChromeSessions,
} from "../bridge/chrome-session-reaper.js";
import { StateStore } from "../StateStore.js";

const OWN_DB = "/Users/x/.flywheel/teamlead.db";
const FOREIGN_DB = "/tmp/flywheel-test-slot-1/teamlead.db";
const CFT_COMM =
	"/Users/x/.agent-browser/browsers/chrome-147/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

function udd(execId: string): string {
	return `/Users/x/.flywheel/runner-state/${execId}/browser-tmp/agent-browser-chrome-abc123`;
}
function sysUdd(): string {
	return `/var/folders/zz/T/agent-browser-chrome-def456`;
}

const tempDirs: string[] = [];
async function makeStore(): Promise<StateStore> {
	const dir = mkdtempSync(join(tmpdir(), "fly766-reaper-"));
	tempDirs.push(dir);
	return await StateStore.create(join(dir, "state.db"));
}
function seed(store: StateStore, execId: string, status: string) {
	store.upsertSession({
		execution_id: execId,
		issue_id: "FLY-766",
		project_name: "flywheel",
		status,
	});
}

/** Build reaper deps with sensible defaults; override per test. */
function makeDeps(
	store: StateStore,
	over: Partial<ReapChromeDeps> & {
		procs?: Array<{ pid: number; ppid: number; comm: string; command: string }>;
		markers?: Record<string, OwnerMarker | null>;
		mtimes?: Record<string, number | null>;
	},
): { deps: ReapChromeDeps; kills: number[] } {
	const kills: number[] = [];
	const procs = over.procs ?? [];
	const markers = over.markers ?? {};
	const mtimes = over.mtimes ?? {};
	const deps: ReapChromeDeps = {
		store,
		ownStateDbPath: over.ownStateDbPath ?? OWN_DB,
		mode: over.mode ?? "periodic",
		migrateUnattributed: over.migrateUnattributed ?? false,
		unattributedIdleGraceMinutes: over.unattributedIdleGraceMinutes ?? 30,
		nowMs: over.nowMs ?? 10_000_000,
		listCommByPid:
			over.listCommByPid ??
			(async () => new Map(procs.map((p) => [p.pid, p.comm]))),
		listCmdByPid:
			over.listCmdByPid ??
			(async () =>
				new Map(
					procs.map((p) => [p.pid, { ppid: p.ppid, command: p.command }]),
				)),
		readOwnerMarker:
			over.readOwnerMarker ?? (async (path) => markers[path] ?? null),
		statMtimeMs: over.statMtimeMs ?? (async (path) => mtimes[path] ?? null),
		revalidatePid:
			over.revalidatePid ??
			(async (pid) => {
				const p = procs.find((q) => q.pid === pid);
				return p ? parseChromeProc(p.pid, p.ppid, p.comm, p.command) : null;
			}),
		killProc: over.killProc ?? ((pid) => kills.push(pid)),
		log: over.log ?? (() => {}),
	};
	return { deps, kills };
}

function markerPath(execId: string): string {
	return `/Users/x/.flywheel/runner-state/${execId}/browser-tmp/.flywheel-owner.json`;
}

describe("parseChromeProc — selector safety (Codex R1 HIGH-2)", () => {
	it("matches a Chrome-for-Testing MAIN process by comm identity", () => {
		const r = parseChromeProc(
			100,
			1,
			CFT_COMM,
			`${CFT_COMM} --user-data-dir=${udd("e1")} --remote-debugging-port=0 --headless=new`,
		);
		expect(r).not.toBeNull();
		expect(r?.execId).toBe("e1");
		expect(r?.userDataDir).toBe(udd("e1"));
	});

	it("does NOT match a claude/node runner whose ARGV contains the Chrome strings + a fake user-data-dir", () => {
		// The exact footgun: a runner reviewing THIS issue has all the strings.
		const argv = `/opt/homebrew/bin/node claude --name FLY-766 "Google Chrome for Testing .agent-browser/browsers/ --user-data-dir=${udd("evil")}"`;
		expect(parseChromeProc(200, 1, "/opt/homebrew/bin/node", argv)).toBeNull();
		expect(parseChromeProc(201, 1, "claude", argv)).toBeNull();
	});

	it("does NOT match Annie's real /Applications/Google Chrome.app (default profile)", () => {
		const comm = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
		const cmd = `${comm} --user-data-dir=/Users/x/Library/Application Support/Google/Chrome`;
		expect(parseChromeProc(300, 1, comm, cmd)).toBeNull();
	});

	it("filters out renderer/gpu children (--type=)", () => {
		const cmd = `${CFT_COMM} --type=renderer --user-data-dir=${udd("e1")}`;
		expect(parseChromeProc(400, 100, CFT_COMM, cmd)).toBeNull();
	});

	it("does NOT match without --user-data-dir or without agent-browser-chrome-", () => {
		expect(parseChromeProc(500, 1, CFT_COMM, CFT_COMM)).toBeNull();
		expect(
			parseChromeProc(
				501,
				1,
				CFT_COMM,
				`${CFT_COMM} --user-data-dir=/var/folders/zz/T/some-other-profile`,
			),
		).toBeNull();
	});

	it("classifies a system-$TMPDIR profile as unattributed (execId null)", () => {
		const r = parseChromeProc(
			600,
			1,
			CFT_COMM,
			`${CFT_COMM} --user-data-dir=${sysUdd()}`,
		);
		expect(r).not.toBeNull();
		expect(r?.execId).toBeNull();
	});
});

describe("reapChromeSessions — attributed ownership + kill rules", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await makeStore();
	});
	afterEach(() => {
		for (const d of tempDirs.splice(0))
			rmSync(d, { recursive: true, force: true });
	});

	it("kills an attributed Chrome whose session is terminal (owner marker matches)", async () => {
		seed(store, "e1", "completed");
		const { deps, kills } = makeDeps(store, {
			procs: [
				{
					pid: 100,
					ppid: 1,
					comm: CFT_COMM,
					command: `${CFT_COMM} --user-data-dir=${udd("e1")}`,
				},
			],
			markers: { [markerPath("e1")]: { execId: "e1", stateDbPath: OWN_DB } },
		});
		const r = await reapChromeSessions(deps);
		expect(r.killedAttributedTerminal).toBe(1);
		expect(kills).toEqual([100]);
		const events = store.getEventsByExecution("e1");
		expect(events.some((e) => e.event_type === "chrome_session_reaped")).toBe(
			true,
		);
	});

	it("does NOT kill an attributed Chrome whose session is running", async () => {
		seed(store, "e1", "running");
		const { deps, kills } = makeDeps(store, {
			procs: [
				{
					pid: 100,
					ppid: 1,
					comm: CFT_COMM,
					command: `${CFT_COMM} --user-data-dir=${udd("e1")}`,
				},
			],
			markers: { [markerPath("e1")]: { execId: "e1", stateDbPath: OWN_DB } },
		});
		const r = await reapChromeSessions(deps);
		expect(r.skippedActive).toBe(1);
		expect(kills).toEqual([]);
	});

	it("does NOT kill approved_to_ship (Runner still ships)", async () => {
		seed(store, "e1", "approved_to_ship");
		const { deps, kills } = makeDeps(store, {
			procs: [
				{
					pid: 100,
					ppid: 1,
					comm: CFT_COMM,
					command: `${CFT_COMM} --user-data-dir=${udd("e1")}`,
				},
			],
			markers: { [markerPath("e1")]: { execId: "e1", stateDbPath: OWN_DB } },
		});
		await reapChromeSessions(deps);
		expect(kills).toEqual([]);
	});

	it("skips a foreign QA-slot Chrome (marker stateDbPath mismatch)", async () => {
		// No row in THIS store; marker points at the slot db → not ours.
		const { deps, kills } = makeDeps(store, {
			procs: [
				{
					pid: 100,
					ppid: 1,
					comm: CFT_COMM,
					command: `${CFT_COMM} --user-data-dir=${udd("qa1")}`,
				},
			],
			markers: {
				[markerPath("qa1")]: { execId: "qa1", stateDbPath: FOREIGN_DB },
			},
		});
		const r = await reapChromeSessions(deps);
		expect(r.skippedForeign).toBe(1);
		expect(kills).toEqual([]);
	});

	it("skips an attributed Chrome with a missing marker", async () => {
		seed(store, "e1", "completed");
		const { deps, kills } = makeDeps(store, {
			procs: [
				{
					pid: 100,
					ppid: 1,
					comm: CFT_COMM,
					command: `${CFT_COMM} --user-data-dir=${udd("e1")}`,
				},
			],
			markers: {}, // no marker
		});
		const r = await reapChromeSessions(deps);
		expect(r.skippedForeign).toBe(1);
		expect(kills).toEqual([]);
	});

	it("boot: kills an attributed no-row orphan (ppid==1 + idle >= grace)", async () => {
		const { deps, kills } = makeDeps(store, {
			mode: "boot",
			nowMs: 10_000_000,
			procs: [
				{
					pid: 100,
					ppid: 1,
					comm: CFT_COMM,
					command: `${CFT_COMM} --user-data-dir=${udd("gone")}`,
				},
			],
			markers: {
				[markerPath("gone")]: { execId: "gone", stateDbPath: OWN_DB },
			},
			mtimes: { [udd("gone")]: 10_000_000 - 31 * 60_000 },
		});
		const r = await reapChromeSessions(deps);
		expect(r.killedAttributedOrphan).toBe(1);
		expect(kills).toEqual([100]);
	});

	it("periodic: never kills an attributed no-row orphan", async () => {
		const { deps, kills } = makeDeps(store, {
			mode: "periodic",
			procs: [
				{
					pid: 100,
					ppid: 1,
					comm: CFT_COMM,
					command: `${CFT_COMM} --user-data-dir=${udd("gone")}`,
				},
			],
			markers: {
				[markerPath("gone")]: { execId: "gone", stateDbPath: OWN_DB },
			},
			mtimes: { [udd("gone")]: 0 },
		});
		const r = await reapChromeSessions(deps);
		expect(r.killedAttributedOrphan).toBe(0);
		expect(kills).toEqual([]);
	});

	it("boot: does NOT kill a fresh no-row orphan (idle < grace = just-spawned, row not yet registered)", async () => {
		const { deps, kills } = makeDeps(store, {
			mode: "boot",
			nowMs: 10_000_000,
			procs: [
				{
					pid: 100,
					ppid: 1,
					comm: CFT_COMM,
					command: `${CFT_COMM} --user-data-dir=${udd("new")}`,
				},
			],
			markers: { [markerPath("new")]: { execId: "new", stateDbPath: OWN_DB } },
			mtimes: { [udd("new")]: 10_000_000 - 60_000 }, // 1min idle < 30min
		});
		const r = await reapChromeSessions(deps);
		expect(r.killedAttributedOrphan).toBe(0);
		expect(kills).toEqual([]);
	});
});

describe("reapChromeSessions — unattributed (Codex R2 MED-1: default log-only)", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await makeStore();
	});
	afterEach(() => {
		for (const d of tempDirs.splice(0))
			rmSync(d, { recursive: true, force: true });
	});

	it("default: log-only, NEVER kills an unattributed idle ppid==1 Chrome", async () => {
		const { deps, kills } = makeDeps(store, {
			mode: "boot",
			migrateUnattributed: false,
			nowMs: 10_000_000,
			procs: [
				{
					pid: 100,
					ppid: 1,
					comm: CFT_COMM,
					command: `${CFT_COMM} --user-data-dir=${sysUdd()}`,
				},
			],
			mtimes: { [sysUdd()]: 0 },
		});
		const r = await reapChromeSessions(deps);
		expect(r.wouldKillUnattributed).toBe(1);
		expect(r.killedUnattributedIdle).toBe(0);
		expect(kills).toEqual([]);
	});

	it("migrate on + boot + ppid==1 + idle: kills, with synthetic audit identity", async () => {
		const { deps, kills } = makeDeps(store, {
			mode: "boot",
			migrateUnattributed: true,
			nowMs: 10_000_000,
			procs: [
				{
					pid: 100,
					ppid: 1,
					comm: CFT_COMM,
					command: `${CFT_COMM} --user-data-dir=${sysUdd()}`,
				},
			],
			mtimes: { [sysUdd()]: 0 },
		});
		const r = await reapChromeSessions(deps);
		expect(r.killedUnattributedIdle).toBe(1);
		expect(kills).toEqual([100]);
		const events = store.getEventsByExecution("chrome-unattributed:100");
		expect(events.length).toBe(1);
		expect(events[0].issue_id).toBe("unknown");
	});

	it("periodic: never touches unattributed even with migrate on", async () => {
		const { deps, kills } = makeDeps(store, {
			mode: "periodic",
			migrateUnattributed: true,
			procs: [
				{
					pid: 100,
					ppid: 1,
					comm: CFT_COMM,
					command: `${CFT_COMM} --user-data-dir=${sysUdd()}`,
				},
			],
			mtimes: { [sysUdd()]: 0 },
		});
		const r = await reapChromeSessions(deps);
		expect(r.killedUnattributedIdle).toBe(0);
		expect(r.skippedUnattributedFresh).toBe(1);
		expect(kills).toEqual([]);
	});
});

describe("reapChromeSessions — races + best-effort", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await makeStore();
	});
	afterEach(() => {
		for (const d of tempDirs.splice(0))
			rmSync(d, { recursive: true, force: true });
	});

	it("PID-reuse: revalidatePid returns a different userDataDir → racedSkipped, no kill", async () => {
		seed(store, "e1", "completed");
		const { deps, kills } = makeDeps(store, {
			procs: [
				{
					pid: 100,
					ppid: 1,
					comm: CFT_COMM,
					command: `${CFT_COMM} --user-data-dir=${udd("e1")}`,
				},
			],
			markers: { [markerPath("e1")]: { execId: "e1", stateDbPath: OWN_DB } },
			revalidatePid: async (pid): Promise<ParsedChrome | null> => ({
				pid,
				ppid: 1,
				userDataDir: udd("someone-else"), // PID reused by a different chrome
				execId: "someone-else",
			}),
		});
		const r = await reapChromeSessions(deps);
		expect(r.racedSkipped).toBe(1);
		expect(kills).toEqual([]);
	});

	it("killProc throwing lands in errors, never throws", async () => {
		seed(store, "e1", "completed");
		const { deps } = makeDeps(store, {
			procs: [
				{
					pid: 100,
					ppid: 1,
					comm: CFT_COMM,
					command: `${CFT_COMM} --user-data-dir=${udd("e1")}`,
				},
			],
			markers: { [markerPath("e1")]: { execId: "e1", stateDbPath: OWN_DB } },
			killProc: () => {
				throw new Error("EPERM");
			},
		});
		const r = await reapChromeSessions(deps);
		expect(r.errors.length).toBe(1);
		expect(r.killedAttributedTerminal).toBe(0);
	});

	it("ps failure is benign (empty result)", async () => {
		const { deps } = makeDeps(store, {
			listCommByPid: async () => {
				throw new Error("ps not found");
			},
			procs: [],
		});
		const r = await reapChromeSessions(deps);
		expect(r.scanned).toBe(0);
		expect(r.errors).toEqual([]);
	});
});
