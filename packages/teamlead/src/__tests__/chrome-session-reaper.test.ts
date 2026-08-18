/**
 * FLY-766: unit tests for the agent-browser Chrome-for-Testing reaper.
 * The reaper's IO (two `ps` passes, marker read, stat, pid revalidation, kill)
 * is fully injected, so these tests are hermetic — no real processes touched.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	HEADLESS_SHOT_MAX_AGE_MS,
	type HeadlessShotSnapshot,
	type OwnerMarker,
	type ParsedChrome,
	parseAgeAndStart,
	parseChromeProc,
	parseEtimeToMs,
	parseHeadlessShotProc,
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
): {
	deps: ReapChromeDeps;
	kills: number[];
	signals: Array<{ pid: number; signal: NodeJS.Signals }>;
} {
	const kills: number[] = [];
	const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
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
		listAgeByPid: over.listAgeByPid ?? (async () => new Map()),
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
		readHeadlessShotProc: over.readHeadlessShotProc,
		signalProc:
			over.signalProc ??
			((pid, signal) => {
				signals.push({ pid, signal });
			}),
		sleep: over.sleep ?? (async () => {}),
		log: over.log ?? (() => {}),
	};
	return { deps, kills, signals };
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

const SYSTEM_CHROME_COMM =
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function headlessCommand(
	pid: number,
	overrides: { comm?: string; command?: string; lstart?: string } = {},
): HeadlessShotSnapshot {
	const comm = overrides.comm ?? SYSTEM_CHROME_COMM;
	return {
		pid,
		comm,
		command:
			overrides.command ??
			`${comm} --headless=new --disable-gpu --screenshot=after.png --virtual-time-budget=3000 http://127.0.0.1:18781/flag-report.html`,
		ageMs: 10 * 60 * 60_000,
		lstart: overrides.lstart ?? "Sun Aug 16 23:00:00 2026",
	};
}

describe("parseHeadlessShotProc — narrow one-shot selector", () => {
	it("matches system Chrome only when both --headless and --screenshot are present", () => {
		expect(
			parseHeadlessShotProc(
				7752,
				SYSTEM_CHROME_COMM,
				`${SYSTEM_CHROME_COMM} --headless=new --screenshot=after.png http://127.0.0.1/x`,
			),
		).toEqual({ pid: 7752 });
		expect(
			parseHeadlessShotProc(
				7752,
				SYSTEM_CHROME_COMM,
				`${SYSTEM_CHROME_COMM} --headless=new http://127.0.0.1/x`,
			),
		).toBeNull();
		expect(
			parseHeadlessShotProc(
				7752,
				SYSTEM_CHROME_COMM,
				`${SYSTEM_CHROME_COMM} --screenshot=after.png http://127.0.0.1/x`,
			),
		).toBeNull();
	});

	it("rejects helper children and argv lookalikes owned by node/claude", () => {
		const argv = `${SYSTEM_CHROME_COMM} --headless=new --screenshot=after.png`;
		expect(
			parseHeadlessShotProc(1, SYSTEM_CHROME_COMM, `${argv} --type=renderer`),
		).toBeNull();
		expect(parseHeadlessShotProc(2, "/opt/homebrew/bin/node", argv)).toBeNull();
		expect(parseHeadlessShotProc(3, "claude", argv)).toBeNull();
	});

	it("recognizes Chrome for Testing and Chromium family identities", () => {
		for (const comm of [
			CFT_COMM,
			"/opt/homebrew/bin/Chromium",
			"headless_shell",
		]) {
			expect(
				parseHeadlessShotProc(
					1,
					comm,
					`${comm} --headless --screenshot shot.png`,
				),
			).toEqual({ pid: 1 });
		}
	});
});

describe("parseEtimeToMs", () => {
	it.each([
		["05", 5_000],
		["4:20", (4 * 60 + 20) * 1_000],
		["1:02:03", (60 * 60 + 2 * 60 + 3) * 1_000],
		["12-01:02:03", (12 * 24 * 60 * 60 + 60 * 60 + 2 * 60 + 3) * 1_000],
		["garbage", null],
		["1:99", null],
		["1-4:20", null],
	])("parses %s", (raw, expected) => {
		expect(parseEtimeToMs(raw)).toBe(expected);
	});

	it("preserves the full space-containing lstart identity", () => {
		expect(parseAgeAndStart("10:05:22 Sun Aug 16 23:00:00 2026")).toEqual({
			ageMs: (10 * 60 * 60 + 5 * 60 + 22) * 1_000,
			lstart: "Sun Aug 16 23:00:00 2026",
		});
	});
});

describe("reapChromeSessions — stale headless screenshot backstop", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await makeStore();
	});
	afterEach(() => {
		for (const d of tempDirs.splice(0))
			rmSync(d, { recursive: true, force: true });
	});

	it("reaps the two real leaked argv shapes after TERM confirms exit", async () => {
		const commands = new Map([
			[
				7752,
				`${SYSTEM_CHROME_COMM} --headless=new --disable-gpu --hide-scrollbars --window-size=980,700 --screenshot=after.png --virtual-time-budget=3000 --user-data-dir=./cp7 http://127.0.0.1:18781/flag-report.html?token=secret`,
			],
			[
				40575,
				`${SYSTEM_CHROME_COMM} --headless=new --disable-gpu --hide-scrollbars --window-size=1200,5900 --screenshot=p1.png --virtual-time-budget=4000 --user-data-dir=./cp8 http://127.0.0.1:18781/ship-report.html#private`,
			],
		]);
		const alive = new Set(commands.keys());
		const snapshots = new Map(
			[...commands].map(([pid, command]) => [
				pid,
				headlessCommand(pid, { command }),
			]),
		);
		const { deps, signals } = makeDeps(store, {
			procs: [...commands].map(([pid, command]) => ({
				pid,
				ppid: 1,
				comm: SYSTEM_CHROME_COMM,
				command,
			})),
			listAgeByPid: async () =>
				new Map(
					[...snapshots].map(([pid, shot]) => [
						pid,
						{ ageMs: shot.ageMs, lstart: shot.lstart },
					]),
				),
			readHeadlessShotProc: async (pid) =>
				alive.has(pid) ? (snapshots.get(pid) ?? null) : null,
			signalProc: (pid, signal) => {
				signals.push({ pid, signal });
				alive.delete(pid);
			},
		});

		const result = await reapChromeSessions(deps);
		expect(result.killedHeadlessShot).toBe(2);
		expect(signals).toHaveLength(2);
		expect(signals).toEqual(
			expect.arrayContaining([
				{ pid: 7752, signal: "SIGTERM" },
				{ pid: 40575, signal: "SIGTERM" },
			]),
		);
		for (const pid of commands.keys()) {
			const events = store.getEventsByExecution(`chrome-headless-shot:${pid}`);
			expect(events).toHaveLength(1);
			const payload = JSON.stringify(events[0].payload);
			expect(payload).not.toContain("secret");
			expect(payload).not.toContain("private");
			expect(payload).not.toContain("flag-report.html");
			expect(payload).toContain("urlPathHash");
		}
	});

	it("keeps a fresh one-shot and never signals it", async () => {
		const shot = headlessCommand(100);
		const { deps, signals } = makeDeps(store, {
			procs: [
				{ pid: shot.pid, ppid: 1, comm: shot.comm, command: shot.command },
			],
			listAgeByPid: async () =>
				new Map([
					[100, { ageMs: HEADLESS_SHOT_MAX_AGE_MS - 1, lstart: shot.lstart }],
				]),
		});
		const result = await reapChromeSessions(deps);
		expect(result.skippedHeadlessShotFresh).toBe(1);
		expect(signals).toEqual([]);
	});

	it("fails closed when the age sensor has no row for a matched pid", async () => {
		const shot = headlessCommand(100);
		const { deps, signals } = makeDeps(store, {
			procs: [
				{ pid: shot.pid, ppid: 1, comm: shot.comm, command: shot.command },
			],
			listAgeByPid: async () => new Map(),
		});
		const result = await reapChromeSessions(deps);
		expect(result.errors.join(" ")).toContain("age sensor missing row");
		expect(signals).toEqual([]);
	});

	it("escalates TERM to KILL, and counts only after disappearance is observed", async () => {
		const shot = headlessCommand(100);
		let alive = true;
		const { deps, signals } = makeDeps(store, {
			procs: [
				{ pid: shot.pid, ppid: 1, comm: shot.comm, command: shot.command },
			],
			listAgeByPid: async () =>
				new Map([[100, { ageMs: shot.ageMs, lstart: shot.lstart }]]),
			readHeadlessShotProc: async () => (alive ? shot : null),
			signalProc: (pid, signal) => {
				signals.push({ pid, signal });
				if (signal === "SIGKILL") alive = false;
			},
		});
		const result = await reapChromeSessions(deps);
		expect(signals).toEqual([
			{ pid: 100, signal: "SIGTERM" },
			{ pid: 100, signal: "SIGKILL" },
		]);
		expect(result.killedHeadlessShot).toBe(1);
	});

	it("does not claim a kill or audit event when the process survives SIGKILL", async () => {
		const shot = headlessCommand(100);
		const { deps } = makeDeps(store, {
			procs: [
				{ pid: shot.pid, ppid: 1, comm: shot.comm, command: shot.command },
			],
			listAgeByPid: async () =>
				new Map([[100, { ageMs: shot.ageMs, lstart: shot.lstart }]]),
			readHeadlessShotProc: async () => shot,
		});
		const result = await reapChromeSessions(deps);
		expect(result.killedHeadlessShot).toBe(0);
		expect(result.errors.join(" ")).toContain("survived SIGKILL");
		expect(store.getEventsByExecution("chrome-headless-shot:100")).toEqual([]);
	});

	it("fails closed on PID reuse (lstart changed) before sending a signal", async () => {
		const shot = headlessCommand(100);
		const reused = headlessCommand(100, { lstart: "Sun Aug 17 10:00:00 2026" });
		const { deps, signals } = makeDeps(store, {
			procs: [
				{ pid: shot.pid, ppid: 1, comm: shot.comm, command: shot.command },
			],
			listAgeByPid: async () =>
				new Map([[100, { ageMs: shot.ageMs, lstart: shot.lstart }]]),
			readHeadlessShotProc: async () => reused,
		});
		const result = await reapChromeSessions(deps);
		expect(result.racedSkipped).toBe(1);
		expect(signals).toEqual([]);
	});

	it("classifies one-shot before the active attributed browser branch", async () => {
		seed(store, "e1", "running");
		const command = `${CFT_COMM} --headless=new --screenshot=shot.png --user-data-dir=${udd("e1")}`;
		const shot = headlessCommand(100, { comm: CFT_COMM, command });
		let alive = true;
		const { deps } = makeDeps(store, {
			procs: [{ pid: 100, ppid: 1, comm: CFT_COMM, command }],
			listAgeByPid: async () =>
				new Map([[100, { ageMs: shot.ageMs, lstart: shot.lstart }]]),
			readHeadlessShotProc: async () => (alive ? shot : null),
			signalProc: () => {
				alive = false;
			},
		});
		const result = await reapChromeSessions(deps);
		expect(result.killedHeadlessShot).toBe(1);
		expect(result.skippedActive).toBe(0);
	});

	it("leaves agent-browser long-running CDP Chrome on the existing path", async () => {
		seed(store, "e1", "running");
		const command = `${CFT_COMM} --headless=new --user-data-dir=${udd("e1")} --remote-debugging-port=0`;
		const { deps } = makeDeps(store, {
			procs: [{ pid: 100, ppid: 1, comm: CFT_COMM, command }],
			markers: { [markerPath("e1")]: { execId: "e1", stateDbPath: OWN_DB } },
			listAgeByPid: async () =>
				new Map([
					[
						100,
						{ ageMs: 10 * 60 * 60_000, lstart: "Sun Aug 16 23:00:00 2026" },
					],
				]),
		});
		const result = await reapChromeSessions(deps);
		expect(result.killedHeadlessShot).toBe(0);
		expect(result.skippedActive).toBe(1);
	});

	it("isolates an age-sensor failure while still reaping an existing terminal category", async () => {
		seed(store, "e1", "completed");
		const command = `${CFT_COMM} --user-data-dir=${udd("e1")}`;
		const { deps, kills } = makeDeps(store, {
			procs: [{ pid: 100, ppid: 1, comm: CFT_COMM, command }],
			markers: { [markerPath("e1")]: { execId: "e1", stateDbPath: OWN_DB } },
			listAgeByPid: async () => {
				throw new Error("age ps unavailable");
			},
		});
		const result = await reapChromeSessions(deps);
		expect(kills).toEqual([100]);
		expect(result.killedAttributedTerminal).toBe(1);
		expect(result.errors.join(" ")).toContain("headless-shot age sensor");
	});

	it("fails closed when exact-process revalidation errors", async () => {
		const shot = headlessCommand(100);
		const { deps, signals } = makeDeps(store, {
			procs: [
				{ pid: shot.pid, ppid: 1, comm: shot.comm, command: shot.command },
			],
			listAgeByPid: async () =>
				new Map([[100, { ageMs: shot.ageMs, lstart: shot.lstart }]]),
			readHeadlessShotProc: async () => {
				throw new Error("ps comm failed");
			},
		});
		const result = await reapChromeSessions(deps);
		expect(signals).toEqual([]);
		expect(result.errors.join(" ")).toContain("ps comm failed");
	});

	it("reaps stale ownerless and foreign one-shots by deliberate host-wide policy", async () => {
		const raw = headlessCommand(100, {
			command: `${SYSTEM_CHROME_COMM} --headless=new --screenshot=raw.png --user-data-dir=./cp7`,
		});
		const foreign = headlessCommand(101, {
			command: `${SYSTEM_CHROME_COMM} --headless=new --screenshot=foreign.png --user-data-dir=${udd("qa1")}`,
		});
		const alive = new Set([raw.pid, foreign.pid]);
		const { deps, signals } = makeDeps(store, {
			procs: [raw, foreign].map((shot) => ({
				pid: shot.pid,
				ppid: 1,
				comm: shot.comm,
				command: shot.command,
			})),
			listAgeByPid: async () =>
				new Map(
					[raw, foreign].map((shot) => [
						shot.pid,
						{ ageMs: shot.ageMs, lstart: shot.lstart },
					]),
				),
			readHeadlessShotProc: async (pid) =>
				alive.has(pid) ? [raw, foreign].find((shot) => shot.pid === pid) : null,
			signalProc: (pid, signal) => {
				signals.push({ pid, signal });
				alive.delete(pid);
			},
		});

		const result = await reapChromeSessions(deps);
		expect(result.skippedForeign).toBe(0);
		expect(result.killedHeadlessShot).toBe(2);
		expect(signals).toEqual(
			expect.arrayContaining([
				{ pid: raw.pid, signal: "SIGTERM" },
				{ pid: foreign.pid, signal: "SIGTERM" },
			]),
		);
	});

	it("fails closed when an exact-process ps row is unparseable", async () => {
		const shot = headlessCommand(100);
		const { deps, signals } = makeDeps(store, {
			procs: [
				{ pid: shot.pid, ppid: 1, comm: shot.comm, command: shot.command },
			],
			listAgeByPid: async () =>
				new Map([[100, { ageMs: shot.ageMs, lstart: shot.lstart }]]),
			readHeadlessShotProc: async () => undefined,
		});

		const result = await reapChromeSessions(deps);
		expect(signals).toEqual([]);
		expect(result.killedHeadlessShot).toBe(0);
		expect(result.errors.join(" ")).toContain("unparseable");
	});

	it("bounds stale one-shot cleanup concurrency", async () => {
		const shots = Array.from({ length: 6 }, (_, index) =>
			headlessCommand(100 + index),
		);
		const alive = new Set(shots.map((shot) => shot.pid));
		let active = 0;
		let maxActive = 0;
		const { deps } = makeDeps(store, {
			procs: shots.map((shot) => ({
				pid: shot.pid,
				ppid: 1,
				comm: shot.comm,
				command: shot.command,
			})),
			listAgeByPid: async () =>
				new Map(
					shots.map((shot) => [
						shot.pid,
						{ ageMs: shot.ageMs, lstart: shot.lstart },
					]),
				),
			readHeadlessShotProc: async (pid) => {
				active++;
				maxActive = Math.max(maxActive, active);
				await new Promise<void>((resolve) => setImmediate(resolve));
				active--;
				return alive.has(pid)
					? (shots.find((shot) => shot.pid === pid) ?? null)
					: null;
			},
			signalProc: (pid) => {
				alive.delete(pid);
			},
		});

		const result = await reapChromeSessions(deps);
		expect(result.killedHeadlessShot).toBe(6);
		expect(maxActive).toBeGreaterThan(1);
		expect(maxActive).toBeLessThanOrEqual(4);
	});
});

describe("chrome reaper plugin wiring", () => {
	it("logs the headless-shot killed and fresh counters", () => {
		const pluginPath = fileURLToPath(
			new URL("../bridge/plugin.ts", import.meta.url),
		);
		const source = readFileSync(pluginPath, "utf8");
		expect(source).toContain("r.killedHeadlessShot > 0");
		expect(source).toContain("killHeadlessShot=$" + "{r.killedHeadlessShot}");
		expect(source).toContain(
			"skippedHeadlessShotFresh=$" + "{r.skippedHeadlessShotFresh}",
		);
	});
});
