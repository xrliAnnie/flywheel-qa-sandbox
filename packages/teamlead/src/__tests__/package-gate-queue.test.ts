import { type ChildProcess, spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import {
	packageGateQueueRoot,
	readPackageGateQueueAtRoot,
} from "../package-gate-queue.js";

const roots: string[] = [];
const children = new Set<ChildProcess>();
const executionId = "44432ed1-8968-4cc8-a69d-fa35a468ff6f";
const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const nowMs = Date.parse("2026-09-18T02:10:00.000Z");

afterEach(async () => {
	for (const child of children) child.kill("SIGKILL");
	await Promise.allSettled(
		[...children].map(
			(child) =>
				new Promise((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null)
						resolve(null);
					else child.once("exit", resolve);
				}),
		),
	);
	children.clear();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

async function heldOwner(path: string) {
	const child = spawn(
		"/usr/bin/python3",
		[
			"-c",
			"import fcntl,json,os,sys; p=sys.argv[1]; fd=os.open(p,os.O_RDWR|os.O_CREAT,0o600); s=os.fstat(fd); fcntl.flock(fd,fcntl.LOCK_EX); print(json.dumps({'dev':s.st_dev,'ino':s.st_ino}),flush=True); sys.stdin.buffer.read()",
			path,
		],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	children.add(child);
	let stdout = "";
	return new Promise<{ child: ChildProcess; dev: number; ino: number }>(
		(resolve, reject) => {
			child.stdout?.on("data", (chunk) => {
				stdout += chunk;
				if (!stdout.includes("\n")) return;
				const value = JSON.parse(stdout.trim());
				resolve({ child, dev: value.dev, ino: value.ino });
			});
			child.once("error", reject);
		},
	);
}

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "package-gate-queue-reader-"));
	roots.push(root);
	const stateRoot = join(root, "state");
	const owners = join(stateRoot, "owners");
	const worktree = join(root, "worktree");
	mkdirSync(owners, { recursive: true });
	mkdirSync(worktree);
	writeFileSync(
		join(stateRoot, "control.json"),
		JSON.stringify({
			schemaVersion: 1,
			mode: "enabled",
			generation: requestId,
		}),
		{ mode: 0o600 },
	);
	const held = await heldOwner(join(owners, `${requestId}.lock`));
	const db = new Database(join(stateRoot, "queue.sqlite3"));
	const monitorPidColumn = ["watch", "dogPid"].join("");
	db.exec(`CREATE TABLE meta(singleton INTEGER PRIMARY KEY,schemaVersion INTEGER,uid INTEGER,generation TEXT,capacity INTEGER,calibrated INTEGER,revision INTEGER,nextSeq INTEGER);
CREATE TABLE requests(requestId TEXT PRIMARY KEY,seq INTEGER,previousSeq INTEGER,protocolVersion INTEGER,state TEXT,enqueuedAt TEXT,enqueuedAtMs INTEGER,supervisorPid INTEGER,ownerLockId TEXT,ownerLockDev INTEGER,ownerLockInode INTEGER,worktreeRealpath TEXT,head TEXT,executionIdClaim TEXT,heartbeatAt TEXT,heartbeatAtMs INTEGER,admittedAt TEXT,admittedAtMs INTEGER,workerPid INTEGER,${monitorPidColumn} INTEGER,pgid INTEGER,finishedAt TEXT,finishedAtMs INTEGER,exitCode INTEGER,outcome TEXT,receiptPath TEXT);`);
	db.prepare("INSERT INTO meta VALUES(1,1,?,?,?,?,?,2)").run(
		process.getuid?.() ?? 0,
		requestId,
		2,
		0,
		7,
	);
	const enqueuedAtMs = nowMs - 4_000;
	db.prepare(
		"INSERT INTO requests VALUES(?,1,NULL,1,'queued',?,?,?, ?,?,?,?,NULL,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)",
	).run(
		requestId,
		new Date(enqueuedAtMs).toISOString(),
		enqueuedAtMs,
		held.child.pid,
		requestId,
		held.dev,
		held.ino,
		realpathSync(worktree),
		executionId,
		new Date(nowMs - 1_000).toISOString(),
		nowMs - 1_000,
	);
	db.close();
	return { root, stateRoot, worktree, held };
}

function read(
	f: Awaited<ReturnType<typeof fixture>>,
	patch: Record<string, unknown> = {},
) {
	return readPackageGateQueueAtRoot(
		{
			executionId,
			worktreePath: f.worktree,
			activationBoundaryMs: nowMs - 5_000,
			nowMs,
			...patch,
		},
		{
			root: f.stateRoot,
			processProbe: () => true,
		},
	);
}

it("reads a live exact queued request through a read-only lock probe", async () => {
	const f = await fixture();
	expect(read(f)).toEqual({
		status: "queued-valid",
		evidence: {
			requestId,
			status: "queued",
			seq: 1,
			position: 1,
			enqueuedAt: new Date(nowMs - 4_000).toISOString(),
			observedAt: new Date(nowMs).toISOString(),
			revision: 7,
			waitMs: 4_000,
		},
	});
});

it("fails closed for stale, old-boundary, replaced-lock, and unverified-process rows", async () => {
	const f = await fixture();
	const db = new Database(join(f.stateRoot, "queue.sqlite3"));
	db.prepare("UPDATE requests SET heartbeatAtMs=?").run(nowMs - 10_001);
	db.close();
	expect(read(f)).toMatchObject({
		status: "unknown",
		reason: "queue_heartbeat_stale",
	});
	const second = await fixture();
	expect(read(second, { activationBoundaryMs: nowMs - 4_000 })).toMatchObject({
		status: "unknown",
		reason: "queue_activation_boundary_invalid",
	});
	const third = await fixture();
	rmSync(join(third.stateRoot, "owners", `${requestId}.lock`));
	writeFileSync(
		join(third.stateRoot, "owners", `${requestId}.lock`),
		"replacement",
	);
	expect(read(third)).toMatchObject({
		status: "unknown",
		reason: "queue_owner_identity_invalid",
	});
	const fourth = await fixture();
	expect(
		readPackageGateQueueAtRoot(
			{
				executionId,
				worktreePath: fourth.worktree,
				activationBoundaryMs: nowMs - 5_000,
				nowMs,
			},
			{ root: fourth.stateRoot, processProbe: () => false },
		),
	).toMatchObject({ status: "unknown", reason: "queue_process_unverified" });
});

it("returns unrelated for another execution and unknown for corrupt enabled state", async () => {
	const f = await fixture();
	expect(
		read(f, { executionId: "55555555-5555-4555-8555-555555555555" }),
	).toEqual({
		status: "unrelated",
	});
	f.held.child.stdin?.end();
	await new Promise((resolve) => f.held.child.once("exit", resolve));
	writeFileSync(join(f.stateRoot, "queue.sqlite3"), "corrupt", { mode: 0o600 });
	expect(read(f)).toMatchObject({ status: "unknown" });
});

it("derives the production root from the OS account rather than HOME", () => {
	const before = process.env.HOME;
	process.env.HOME = "/tmp/untrusted-scratch-home";
	try {
		expect(packageGateQueueRoot()).toBe(
			join(userInfo().homedir, ".flywheel", "state", "package-gate", "v1"),
		);
	} finally {
		if (before === undefined) delete process.env.HOME;
		else process.env.HOME = before;
	}
});
