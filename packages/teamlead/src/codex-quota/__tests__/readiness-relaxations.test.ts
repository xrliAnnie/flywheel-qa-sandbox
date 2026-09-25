/**
 * FLY-2869 — each readiness relaxation proven on its own: a minimal baseline
 * shows the original blocker, adding exactly one approved fact turns it green
 * with a fixed info diagnostic, and breaking that fact brings the original
 * reason back. The combined seven-residue fixture at the end is only a
 * composition regression, not a substitute for the single rows.
 */
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { computeCodexHomeInventoryDigest } from "flywheel-claude-runner";
import { afterEach, describe, expect, it } from "vitest";
import { CodexQuotaAvailability } from "../availability.js";
import type { CodexProcessSnapshot } from "../host-process-snapshot.js";
import {
	type CodexQuotaHostCollectorOptions,
	createCodexQuotaHostCollector,
} from "../host-readiness.js";
import { checkCodexQuotaReadiness } from "../readiness.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

const LSTART = "Thu Sep 25 01:00:00 2026";
const DESKTOP = "/Applications/ChatGPT.app/Contents/Resources/codex";
const NOW = Date.parse("2026-09-25T06:00:00.000Z");
const OLD = "2026-09-16 03:13:42";

interface Row {
	pid: number;
	ucomm: string;
	args: string;
	env?: string;
}
function snapshot(rows: Row[]): CodexProcessSnapshot {
	const all = [{ pid: 1, ucomm: "launchd", args: "/sbin/launchd" }, ...rows];
	const args = all.map((row) => `${row.pid} ${LSTART} ${row.args}`).join("\n");
	return {
		argsBefore: args,
		authoritative: all
			.map(
				(row) =>
					`${row.pid} ${LSTART} Ss   ${row.ucomm.padEnd(16)} ${row.env ? `${row.args} ${row.env}` : row.args}`,
			)
			.join("\n"),
		argsAfter: args,
	};
}

function host() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fly2869-ready-")));
	roots.push(root);
	const homesRoot = join(root, "homes");
	const home = join(homesRoot, "agents", "flywheel", "implement");
	const canonicalHome = join(root, "canonical");
	const commRoot = join(root, "comm");
	const slotRoot = join(root, "slots");
	const hostHome = join(root, "host-home");
	for (const dir of [
		home,
		canonicalHome,
		join(commRoot, "flywheel"),
		slotRoot,
		hostHome,
	])
		mkdirSync(dir, { recursive: true });
	writeFileSync(join(canonicalHome, "auth.json"), "{}", { mode: 0o600 });
	const db = new Database(join(commRoot, "flywheel", "comm.db"));
	db.exec(
		"CREATE TABLE sessions(execution_id TEXT,vendor TEXT,status TEXT,ended_at TEXT,phase_keep_alive INTEGER,tmux_window TEXT,started_at TEXT)",
	);
	db.close();
	const approved = [{ home, ownership: "managed" as const }];
	const manifestPath = join(root, "receipt.json");
	const writeManifest = () =>
		writeFileSync(
			manifestPath,
			JSON.stringify({
				schemaVersion: 1,
				buildSha: "a".repeat(40),
				inventoryDigest: computeCodexHomeInventoryDigest(approved),
				homes: approved.map((entry) => ({
					...entry,
					credentialShared: true,
					checkedAt: new Date().toISOString(),
				})),
			}),
		);
	writeManifest();
	let rows: Row[] = [];
	let desktopVerified = false;
	let now = NOW;
	let mono = 0;
	const options: CodexQuotaHostCollectorOptions = {
		homesRoot,
		canonicalHome,
		commRoot,
		projectNames: ["flywheel"],
		approvedManifestPath: manifestPath,
		leadTargets: [],
		leadAuthorityScript: join(root, "authority"),
		processSnapshot: async () => snapshot(rows),
		verifyDesktopCodex: async (_pid, argv0) =>
			desktopVerified && argv0 === DESKTOP,
		testSlotRoot: slotRoot,
		now: () => now,
		monotonicNow: () => mono,
	};
	const session = (values: {
		id: string;
		vendor?: string | null;
		status?: string;
		keepAlive?: number;
		tmuxWindow?: string | null;
		startedAt?: string | null;
		project?: string;
	}) => {
		const target = new Database(
			join(commRoot, values.project ?? "flywheel", "comm.db"),
		);
		target
			.prepare(
				"INSERT INTO sessions(execution_id,vendor,status,phase_keep_alive,tmux_window,started_at) VALUES(?,?,?,?,?,?)",
			)
			.run(
				values.id,
				values.vendor === undefined ? "codex" : values.vendor,
				values.status ?? "running",
				values.keepAlive ?? 0,
				values.tmuxWindow ?? "runner-flywheel:@1",
				values.startedAt === undefined ? OLD : values.startedAt,
			);
		target.close();
	};
	const lease = (id: string, leaseHome = home) => {
		mkdirSync(join(leaseHome, ".flywheel-leases"), { recursive: true });
		writeFileSync(join(leaseHome, ".flywheel-leases", id), "a".repeat(32));
	};
	const approve = (extra: string) => {
		mkdirSync(extra, { recursive: true });
		approved.push({ home: extra, ownership: "managed" });
		writeManifest();
	};
	return {
		root,
		home,
		homesRoot,
		canonicalHome,
		commRoot,
		slotRoot,
		hostHome,
		options,
		collect: createCodexQuotaHostCollector(options),
		setRows: (next: Row[]) => {
			rows = next;
		},
		setDesktopVerified: (value: boolean) => {
			desktopVerified = value;
		},
		advance: (ms: number) => {
			now += ms;
			mono += ms;
		},
		/** Only the monotonic clock moves: a row's wall-clock age is frozen. */
		advanceMono: (ms: number) => {
			mono += ms;
		},
		session,
		lease,
		approve,
	};
}
type Host = ReturnType<typeof host>;
const reasons = (inventory: Awaited<ReturnType<Host["collect"]>>) =>
	inventory.diagnostics.map((d) => `${d.scope}:${d.reason}`);

describe("⑦ process classification", () => {
	it.each([
		{
			name: "Claude runner",
			row: {
				pid: 20,
				ucomm: "2.1.282",
				args: "claude --agent-id runner",
				env: "XDG_CACHE_HOME=/Users/u/.cache/codex",
			},
		},
		{
			name: "zsh",
			row: {
				pid: 21,
				ucomm: "zsh",
				args: "/bin/zsh -lc run",
				env: "SCRUBCMD=x codex",
			},
		},
		{
			name: "node",
			row: { pid: 22, ucomm: "node", args: "node run.mjs codex" },
		},
	])(
		"a $name mentioning codex is not a reader; the same line as a real codex is",
		async ({ row }) => {
			const h = host();
			h.setRows([row]);
			const green = await h.collect();
			expect(green.complete).toBe(true);
			expect(reasons(green)).not.toContain("global:process_home_unknown");
			h.setRows([{ ...row, ucomm: "codex" }]);
			const red = await h.collect();
			expect(red.complete).toBe(false);
			expect(reasons(red)).toContain("global:process_home_unknown");
		},
	);

	it("a codex without CODEX_HOME counts as canonical only when HOME/.codex is canonical", async () => {
		const h = host();
		symlinkSync(h.canonicalHome, join(h.hostHome, ".codex"));
		h.setRows([
			{
				pid: 30,
				ucomm: "codex",
				args: "/bin/codex app-server",
				env: `HOME=${h.hostHome}`,
			},
		]);
		expect(await h.collect()).toMatchObject({
			complete: true,
			canonicalChainActive: true,
		});
		h.setRows([
			{
				pid: 30,
				ucomm: "codex",
				args: "/bin/codex app-server",
				env: `HOME=${h.root}`,
			},
		]);
		const red = await h.collect();
		expect(red.complete).toBe(false);
		expect(reasons(red)).toContain("global:process_home_unknown");
	});
});

describe("⑤ ChatGPT desktop codex", () => {
	it("is excluded only with a verified identity", async () => {
		const h = host();
		const desktop = { pid: 77, ucomm: "codex", args: `${DESKTOP} app-server` };
		h.setRows([desktop]);
		const red = await h.collect();
		expect(red.complete).toBe(false);
		expect(reasons(red)).toContain("global:process_home_unknown");
		h.setDesktopVerified(true);
		const green = await h.collect();
		expect(green.complete).toBe(true);
		expect(green.diagnostics).toContainEqual({
			reason: "desktop_codex_excluded",
			scope: "info",
			pid: 77,
		});
		h.setRows([{ ...desktop, args: "/tmp/ChatGPT.app/codex app-server" }]);
		expect((await h.collect()).complete).toBe(false);
	});
});

describe("⑥① 529 test slots", () => {
	it("a slot Codex home is excluded; lookalike and escaping paths are not", async () => {
		const h = host();
		const slotHome = join(h.slotRoot, "flywheel-test-slot-7", "cdxh", "lead");
		mkdirSync(slotHome, { recursive: true });
		h.setRows([
			{
				pid: 40,
				ucomm: "codex",
				args: "/bin/codex app-server",
				env: `CODEX_HOME=${slotHome}`,
			},
		]);
		const green = await h.collect();
		expect(green.complete).toBe(true);
		expect(green.diagnostics).toContainEqual({
			reason: "test_slot_home_excluded",
			scope: "info",
			home: slotHome,
		});
		const lookalike = join(h.slotRoot, "flywheel-test-slotX", "home");
		mkdirSync(lookalike, { recursive: true });
		h.setRows([
			{
				pid: 40,
				ucomm: "codex",
				args: "/bin/codex app-server",
				env: `CODEX_HOME=${lookalike}`,
			},
		]);
		expect(reasons(await h.collect())).toContain(
			"registered:unapproved_live_home",
		);
		const outside = join(h.root, "outside-home");
		mkdirSync(outside);
		const escapeLink = join(h.slotRoot, "flywheel-test-slot-8");
		symlinkSync(outside, escapeLink);
		h.setRows([
			{
				pid: 40,
				ucomm: "codex",
				args: "/bin/codex app-server",
				env: `CODEX_HOME=${escapeLink}`,
			},
		]);
		expect(reasons(await h.collect())).toContain(
			"registered:unapproved_live_home",
		);
	});

	it("a comm shard linked into a slot is skipped; any other link fails closed", async () => {
		const h = host();
		const shard = join(
			h.slotRoot,
			"flywheel-test-slot-4",
			"state",
			"comm",
			"test-slot-4",
		);
		mkdirSync(shard, { recursive: true });
		symlinkSync(shard, join(h.commRoot, "test-slot-4"));
		const green = await h.collect();
		expect(green.complete).toBe(true);
		expect(green.diagnostics).toContainEqual({
			reason: "test_slot_comm_shard_skipped",
			scope: "info",
		});
		rmSync(join(h.commRoot, "test-slot-4"));
		mkdirSync(join(h.root, "elsewhere"));
		symlinkSync(join(h.root, "elsewhere"), join(h.commRoot, "other"));
		const red = await h.collect();
		expect(red.complete).toBe(false);
		expect(reasons(red)).toContain("all:comm_shard_unsafe");
	});
});

describe("①′ dangling 529 slot links (slot being rebuilt)", () => {
	it("a link whose missing target lies inside a slot is skipped; a dangling link elsewhere fails", async () => {
		const h = host();
		mkdirSync(join(h.slotRoot, "flywheel-test-slot-5"));
		symlinkSync(
			join(h.slotRoot, "flywheel-test-slot-5", "state", "comm", "test-slot-5"),
			join(h.commRoot, "test-slot-5"),
		);
		// Even the slot directory itself may be gone mid-rebuild.
		symlinkSync(
			join(h.slotRoot, "flywheel-test-slot-6", "state", "comm", "test-slot-6"),
			join(h.commRoot, "test-slot-6"),
		);
		const green = await h.collect();
		expect(green.complete).toBe(true);
		expect(
			green.diagnostics.filter(
				(d) => d.reason === "test_slot_comm_shard_skipped",
			),
		).toHaveLength(2);
		symlinkSync(join(h.root, "gone", "shard"), join(h.commRoot, "other"));
		const red = await h.collect();
		expect(red.complete).toBe(false);
		expect(reasons(red)).toContain("all:comm_shard_unsafe");
	});
});

describe("②③ archives and pre-registrations", () => {
	it("an unregistered directory without comm.db is skipped; a registered one must have it", async () => {
		const h = host();
		mkdirSync(join(h.commRoot, "archive-junk-20260806"));
		const green = await h.collect();
		expect(green.complete).toBe(true);
		expect(green.diagnostics).toContainEqual(
			expect.objectContaining({
				reason: "unregistered_comm_dir_skipped",
				scope: "info",
			}),
		);
		const registered = createCodexQuotaHostCollector({
			...h.options,
			projectNames: ["flywheel", "archive-junk-20260806"],
		});
		const red = await registered();
		expect(red.complete).toBe(false);
		expect(reasons(red)).toContain("all:collector_failed");
	});

	it("a vendor-less pending pre-registration is skipped; any other vendor-less row fails", async () => {
		const h = host();
		h.session({
			id: "pre-1",
			vendor: null,
			tmuxWindow: "runner-flywheel:pending",
		});
		const green = await h.collect();
		expect(green.complete).toBe(true);
		expect(green.diagnostics).toContainEqual({
			reason: "pending_preregistration_skipped",
			scope: "info",
			executionId: "pre-1",
		});
		h.session({ id: "pre-2", vendor: null, tmuxWindow: "runner-flywheel:@9" });
		const red = await h.collect();
		expect(red.complete).toBe(false);
		expect(reasons(red)).toContain("all:comm_identity_unknown");
	});
});

describe("④ CommDB live executions", () => {
	it("a terminal keep-alive row with neither process nor lease is residue", async () => {
		const h = host();
		h.session({ id: "done-1", status: "failed", keepAlive: 1 });
		const green = await h.collect();
		expect(green.complete).toBe(true);
		expect(green.diagnostics).toContainEqual({
			reason: "terminal_session_residue",
			scope: "info",
			executionId: "done-1",
		});
	});

	it("a terminal row that still has only a lease stays a live execution (lease alone is never liveness)", async () => {
		const h = host();
		h.session({ id: "parked-1", status: "completed", keepAlive: 1 });
		h.lease("parked-1");
		const red = await h.collect();
		expect(red.complete).toBe(false);
		expect(reasons(red)).toContain("registered:lease_without_process");
		expect(reasons(red)).not.toContain("info:terminal_session_residue");
	});

	it("a terminal row that still has only a process enters the original reconciliation", async () => {
		const h = host();
		const perExecution = join(h.homesRoot, "parked-2");
		h.approve(perExecution);
		h.session({ id: "parked-2", status: "completed", keepAlive: 1 });
		h.setRows([
			{
				pid: 50,
				ucomm: "codex",
				args: "/bin/codex app-server",
				env: `CODEX_HOME=${perExecution} FLYWHEEL_EXEC_ID=parked-2`,
			},
		]);
		const inventory = await h.collect();
		expect(inventory.complete).toBe(true);
		expect(inventory.homes).toContainEqual({
			home: perExecution,
			ownership: "managed",
			activity: "active",
		});
		expect(reasons(inventory)).not.toContain("info:terminal_session_residue");
	});

	it("a running row without process or lease matures only after sustained absence", async () => {
		const h = host();
		h.session({ id: "stuck-1" });
		const first = await h.collect();
		expect(first.complete).toBe(false);
		expect(reasons(first)).toContain("registered:comm_orphan");
		h.advance(30_000);
		expect(reasons(await h.collect())).toContain("registered:comm_orphan");
		h.advance(31_000);
		const matured = await h.collect();
		expect(matured.complete).toBe(true);
		expect(matured.diagnostics).toContainEqual({
			reason: "comm_stale_running",
			scope: "info",
			executionId: "stuck-1",
			startedAt: OLD,
		});
	});

	it.each([
		{
			name: "a process appears between samples",
			interrupt: (h: Host) =>
				h.setRows([
					{
						pid: 60,
						ucomm: "codex",
						args: "/bin/codex app-server",
						env: `CODEX_HOME=${h.home} FLYWHEEL_EXEC_ID=stuck-1`,
					},
				]),
			restore: (h: Host) => h.setRows([]),
		},
		{
			name: "a lease appears between samples",
			interrupt: (h: Host) => h.lease("stuck-1"),
			restore: (h: Host) =>
				rmSync(join(h.home, ".flywheel-leases"), { recursive: true }),
		},
		{
			name: "an incomplete collection happens between samples",
			interrupt: (h: Host) => rmSync(h.options.approvedManifestPath),
			restore: (h: Host) => h.approve(join(h.homesRoot, "restore")),
		},
	])("resets the streak when $name", async ({ interrupt, restore }) => {
		const h = host();
		h.session({ id: "stuck-1" });
		await h.collect();
		h.advance(40_000);
		interrupt(h);
		await h.collect();
		restore(h);
		h.advance(40_000);
		const again = await h.collect();
		expect(reasons(again)).toContain("registered:comm_orphan");
		h.advance(61_000);
		expect((await h.collect()).complete).toBe(true);
	});

	it.each([
		{ name: "inside the 15-minute grace", startedAt: "2026-09-25 05:50:00" },
		{ name: "exactly 15 minutes old", startedAt: "2026-09-25 05:45:00" },
		{
			name: "on an impossible calendar date",
			startedAt: "2026-02-30 00:00:00",
		},
		{ name: "with a malformed timestamp", startedAt: "yesterday" },
		{ name: "with no timestamp", startedAt: null },
		{ name: "started in the future", startedAt: "2026-09-25 07:00:00" },
	])("never exempts a running row $name", async ({ startedAt }) => {
		const h = host();
		h.session({ id: "young-1", startedAt });
		await h.collect();
		h.advanceMono(120_000);
		await h.collect();
		h.advanceMono(120_000);
		const inventory = await h.collect();
		expect(reasons(inventory)).toContain("registered:comm_orphan");
		expect(inventory.complete).toBe(false);
	});

	it("a row 15 minutes and one second old may mature", async () => {
		const h = host();
		h.session({ id: "old-1", startedAt: "2026-09-25 05:44:59" });
		await h.collect();
		h.advanceMono(61_000);
		expect((await h.collect()).complete).toBe(true);
	});
});

describe("⑨ shared agent homes: a daemon and its client are one execution", () => {
	const daemon = (h: Host, id: string, pid: number): Row => ({
		pid,
		ucomm: "codex",
		args: "codex app-server --listen unix://x",
		env: `CODEX_HOME=${h.home} FLYWHEEL_EXEC_ID=${id}`,
	});
	const client = (h: Host, id: string, pid: number): Row => ({
		pid,
		ucomm: "codex",
		args: "/Users/u/.local/bin/codex resume --remote unix://x",
		env: `CODEX_HOME=${h.home} FLYWHEEL_EXEC_ID=${id}`,
	});

	it.each([
		{
			name: "one execution with daemon + client and its lease",
			setup: (h: Host) => {
				h.session({ id: "run-a", startedAt: "2026-09-25 05:55:00" });
				h.lease("run-a");
				h.setRows([daemon(h, "run-a", 70), client(h, "run-a", 71)]);
			},
			complete: true,
			activity: "active",
			blocking: [] as string[],
		},
		{
			name: "two executions, two processes each, two leases",
			setup: (h: Host) => {
				for (const id of ["run-a", "run-b"]) {
					h.session({ id, startedAt: "2026-09-25 05:55:00" });
					h.lease(id);
				}
				h.setRows([
					daemon(h, "run-a", 70),
					client(h, "run-a", 71),
					daemon(h, "run-b", 72),
					client(h, "run-b", 73),
				]);
			},
			complete: true,
			activity: "active",
			blocking: [],
		},
		{
			name: "a process without an execution id",
			setup: (h: Host) => {
				h.session({ id: "run-a", startedAt: "2026-09-25 05:55:00" });
				h.lease("run-a");
				h.setRows([
					daemon(h, "run-a", 70),
					{ ...client(h, "run-a", 71), env: `CODEX_HOME=${h.home}` },
				]);
			},
			complete: false,
			activity: "unknown",
			blocking: ["registered:comm_orphan"],
		},
		{
			name: "a live execution whose lease was released early (FLY-2877)",
			setup: (h: Host) => {
				for (const id of ["run-a", "run-b"])
					h.session({ id, startedAt: "2026-09-25 05:55:00" });
				h.lease("run-b");
				h.setRows([
					daemon(h, "run-a", 70),
					client(h, "run-a", 71),
					daemon(h, "run-b", 72),
					client(h, "run-b", 73),
				]);
			},
			complete: false,
			activity: "unknown",
			blocking: ["registered:comm_orphan"],
		},
		{
			name: "a lease with no process behind it",
			setup: (h: Host) => {
				for (const id of ["run-a", "run-b"]) {
					h.session({ id, startedAt: "2026-09-25 05:55:00" });
					h.lease(id);
				}
				h.setRows([daemon(h, "run-a", 70), client(h, "run-a", 71)]);
			},
			complete: false,
			activity: "unknown",
			blocking: ["registered:comm_orphan"],
		},
		{
			name: "a lease that CommDB does not know",
			setup: (h: Host) => {
				h.lease("run-a");
				h.setRows([daemon(h, "run-a", 70), client(h, "run-a", 71)]);
			},
			complete: false,
			activity: "unknown",
			blocking: [],
		},
	])("$name", async ({ setup, complete, activity, blocking }) => {
		const h = host();
		setup(h);
		const inventory = await h.collect();
		expect(inventory.complete).toBe(complete);
		expect(inventory.homes.find((home) => home.home === h.home)?.activity).toBe(
			activity,
		);
		for (const reason of blocking) expect(reasons(inventory)).toContain(reason);
	});

	it("a per-execution home with daemon + client of that execution is matched", async () => {
		const h = host();
		const perExecution = join(h.homesRoot, "run-p");
		h.approve(perExecution);
		h.session({ id: "run-p", startedAt: "2026-09-25 05:55:00" });
		h.setRows([
			{
				pid: 80,
				ucomm: "codex",
				args: "codex app-server",
				env: `CODEX_HOME=${perExecution} FLYWHEEL_EXEC_ID=run-p`,
			},
			{
				pid: 81,
				ucomm: "codex",
				args: "/Users/u/.local/bin/codex resume",
				env: `CODEX_HOME=${perExecution} FLYWHEEL_EXEC_ID=run-p`,
			},
		]);
		const inventory = await h.collect();
		expect(inventory.complete).toBe(true);
		expect(inventory.homes).toContainEqual({
			home: perExecution,
			ownership: "managed",
			activity: "active",
		});
	});
});

describe("code review R1 — no fail-open on ambiguous CommDB authority", () => {
	it.each([
		{ order: "old row read first", oldIn: "flywheel", freshIn: "growth" },
		{ order: "old row read last", oldIn: "growth", freshIn: "flywheel" },
	])(
		"a newer row with the same execution id keeps blocking ($order)",
		async ({ oldIn, freshIn }) => {
			const h = host();
			mkdirSync(join(h.commRoot, "growth"));
			const other = new Database(join(h.commRoot, "growth", "comm.db"));
			other.exec(
				"CREATE TABLE sessions(execution_id TEXT,vendor TEXT,status TEXT,ended_at TEXT,phase_keep_alive INTEGER,tmux_window TEXT,started_at TEXT)",
			);
			other.close();
			// Same id: an old row (would mature) and a fresh one (must keep blocking).
			h.session({ id: "dup-1", startedAt: OLD, project: oldIn });
			h.session({
				id: "dup-1",
				startedAt: "2026-09-25 05:58:00",
				project: freshIn,
			});
			await h.collect();
			h.advanceMono(61_000);
			const inventory = await h.collect();
			expect(inventory.complete).toBe(false);
			expect(inventory.diagnostics).toContainEqual({
				reason: "comm_orphan",
				scope: "registered",
				executionId: "dup-1",
			});
		},
	);

	it.each(["completed", "timeout", "blocked", "failed"])(
		"a %s keep-alive row with no process or lease is residue",
		async (status) => {
			const h = host();
			h.session({ id: "t-1", status, keepAlive: 1 });
			const inventory = await h.collect();
			expect(inventory.complete).toBe(true);
			expect(reasons(inventory)).toContain("info:terminal_session_residue");
		},
	);

	it.each([
		{ name: "NULL", status: null },
		{ name: "an unknown status", status: "parked" },
	])(
		"a keep-alive row with $name status is never residue",
		async ({ status }) => {
			const h = host();
			const db = new Database(join(h.commRoot, "flywheel", "comm.db"));
			db.prepare(
				"INSERT INTO sessions(execution_id,vendor,status,phase_keep_alive,tmux_window,started_at) VALUES(?,?,?,?,?,?)",
			).run("odd-1", "codex", status, 1, "runner-flywheel:@1", OLD);
			db.close();
			await h.collect();
			h.advanceMono(61_000);
			const inventory = await h.collect();
			expect(inventory.complete).toBe(false);
			expect(reasons(inventory)).not.toContain("info:terminal_session_residue");
			expect(reasons(inventory)).not.toContain("info:comm_stale_running");
			expect(reasons(inventory)).toContain("registered:comm_orphan");
		},
	);
});

describe("legacy root comm.db schema", () => {
	it("reads a pre-keep-alive database without failing, and still counts its running rows", async () => {
		const h = host();
		const legacy = new Database(join(h.root, "comm.db"));
		legacy.exec(
			"CREATE TABLE sessions(execution_id TEXT,tmux_window TEXT,project_name TEXT,issue_id TEXT,lead_id TEXT,started_at TEXT,ended_at TEXT,status TEXT,vendor TEXT)",
		);
		legacy.close();
		expect((await h.collect()).complete).toBe(true);
		const writer = new Database(join(h.root, "comm.db"));
		writer
			.prepare(
				"INSERT INTO sessions(execution_id,started_at,status,vendor) VALUES(?,?,?,?)",
			)
			.run("legacy-1", OLD, "running", "codex");
		writer.close();
		const red = await h.collect();
		expect(red.complete).toBe(false);
		expect(red.diagnostics).toContainEqual({
			reason: "comm_orphan",
			scope: "registered",
			executionId: "legacy-1",
		});
	});

	it("still fails closed when a database lacks an identity column", async () => {
		const h = host();
		const broken = new Database(join(h.root, "comm.db"));
		broken.exec("CREATE TABLE sessions(execution_id TEXT,status TEXT)");
		broken.close();
		const red = await h.collect();
		expect(red.complete).toBe(false);
		expect(reasons(red)).toContain("all:comm_identity_unknown");
	});
});

describe("composition — the seven production residue classes together", () => {
	it("turns automatic with every residue present, and a single running-row sample still blocks", async () => {
		const h = host();
		// ① slot comm shard link, ② archive dir, ③ pending pre-registration,
		// ④ terminal keep-alive residue, ⑤ desktop codex, ⑥ slot Codex home,
		// ⑦ Claude runner / zsh / node lines that mention codex.
		const shard = join(
			h.slotRoot,
			"flywheel-test-slot-1",
			"state",
			"comm",
			"test-slot-1",
		);
		mkdirSync(shard, { recursive: true });
		symlinkSync(shard, join(h.commRoot, "test-slot-1"));
		mkdirSync(join(h.commRoot, "intent-archive-r2-20260806"));
		h.session({
			id: "pre-1",
			vendor: null,
			tmuxWindow: "runner-flywheel:pending",
		});
		h.session({ id: "done-1", status: "failed", keepAlive: 1 });
		const slotHome = join(h.slotRoot, "flywheel-test-slot-2", "cdxh", "lead");
		mkdirSync(slotHome, { recursive: true });
		h.setDesktopVerified(true);
		h.setRows([
			{ pid: 77, ucomm: "codex", args: `${DESKTOP} app-server` },
			{
				pid: 40,
				ucomm: "codex",
				args: "/bin/codex app-server",
				env: `CODEX_HOME=${slotHome}`,
			},
			{
				pid: 20,
				ucomm: "2.1.282",
				args: "claude --agent-id r",
				env: "XDG_CACHE_HOME=/c/codex",
			},
			{ pid: 21, ucomm: "zsh", args: "/bin/zsh -lc x", env: "QA_SLOT=codex" },
			{ pid: 22, ucomm: "node", args: "node x.mjs codex" },
		]);
		const inventory = await h.collect();
		expect(inventory.complete).toBe(true);
		expect(
			await checkCodexQuotaReadiness({
				canonicalAuthPath: join(h.canonicalHome, "auth.json"),
				collectHomes: async () => inventory,
			}),
		).toEqual({ ready: true, failures: [] });
		const availability = new CodexQuotaAvailability({
			enabled: () => true,
			runtimeAvailable: () => true,
			check: () =>
				checkCodexQuotaReadiness({
					canonicalAuthPath: join(h.canonicalHome, "auth.json"),
					collectHomes: h.collect,
				}),
		});
		expect((await availability.refresh()).mode).toBe("automatic");

		// Hard red: a running row with no reader, seen once, still blocks.
		h.session({ id: "stuck-1" });
		expect((await availability.refresh()).mode).toBe("manual");
	});
});
