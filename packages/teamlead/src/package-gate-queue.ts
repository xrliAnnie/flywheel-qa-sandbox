import { spawnSync } from "node:child_process";
import type { Stats } from "node:fs";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUIRED_REQUEST_COLUMNS = new Set([
	"requestId",
	"seq",
	"protocolVersion",
	"state",
	"enqueuedAt",
	"enqueuedAtMs",
	"supervisorPid",
	"ownerLockId",
	"ownerLockDev",
	"ownerLockInode",
	"worktreeRealpath",
	"executionIdClaim",
	"heartbeatAtMs",
]);
const FLOCK_PROBE = `import fcntl,json,os,sys
path,dev,ino,uid=sys.argv[1],int(sys.argv[2]),int(sys.argv[3]),int(sys.argv[4])
try:
 fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
 s=os.fstat(fd)
 if s.st_dev!=dev or s.st_ino!=ino or s.st_uid!=uid:
  print('identity'); sys.exit(0)
 try:
  fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:
  print('held'); sys.exit(0)
 print('free')
except Exception:
 print('unknown')
`;

export interface PackageGateQueueContext {
	executionId: string;
	worktreePath: string;
	activationBoundaryMs: number | null;
	nowMs: number;
}

export interface PackageGateQueueEvidence {
	requestId: string;
	status: "queued";
	seq: number;
	position: number;
	enqueuedAt: string;
	observedAt: string;
	revision: number;
	waitMs: number;
}

export type PackageGateQueueResult =
	| { status: "absent" | "unrelated" }
	| { status: "queued-valid"; evidence: PackageGateQueueEvidence }
	| { status: "unknown"; reason: string };

interface ReaderDependencies {
	root: string;
	processProbe?: (pid: number, executionId: string) => boolean;
}

type Row = Record<string, unknown>;

export function packageGateQueueRoot(): string {
	return join(userInfo().homedir, ".flywheel", "state", "package-gate", "v1");
}

function unknown(reason: string): PackageGateQueueResult {
	return { status: "unknown", reason };
}

function safeOwnedFile(path: string, uid: number): boolean {
	try {
		const info = lstatSync(path);
		return info.isFile() && !info.isSymbolicLink() && info.uid === uid;
	} catch {
		return false;
	}
}

function defaultProcessProbe(pid: number, executionId: string): boolean {
	const result = spawnSync(
		"/bin/ps",
		["eww", "-p", String(pid), "-o", "command="],
		{
			encoding: "utf8",
			timeout: 1_000,
			maxBuffer: 1_048_576,
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	if (result.status !== 0 || result.error) return false;
	const command = result.stdout;
	return (
		command.includes("package-gate-host.py") &&
		command.split(/\s+/).includes(`FLYWHEEL_EXEC_ID=${executionId}`)
	);
}

function probeOwnerLock(
	path: string,
	row: Row,
	uid: number,
): "held" | "free" | "identity" | "unknown" {
	const result = spawnSync(
		"/usr/bin/python3",
		[
			"-c",
			FLOCK_PROBE,
			path,
			String(row.ownerLockDev),
			String(row.ownerLockInode),
			String(uid),
		],
		{
			encoding: "utf8",
			timeout: 1_000,
			maxBuffer: 1_024,
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	if (result.status !== 0 || result.error) return "unknown";
	const value = result.stdout.trim();
	return ["held", "free", "identity", "unknown"].includes(value)
		? (value as "held" | "free" | "identity" | "unknown")
		: "unknown";
}

function exactInteger(value: unknown, minimum = 0): value is number {
	return Number.isSafeInteger(value) && Number(value) >= minimum;
}

/** Test seam for an isolated root. Production callers use readPackageGateQueue. */
export function readPackageGateQueueAtRoot(
	context: PackageGateQueueContext,
	dependencies: ReaderDependencies,
): PackageGateQueueResult {
	if (
		!UUID.test(context.executionId) ||
		!Number.isSafeInteger(context.nowMs) ||
		context.nowMs <= 0
	)
		return unknown("queue_context_invalid");
	const uid = process.getuid?.();
	if (!Number.isSafeInteger(uid) || uid === undefined)
		return unknown("queue_platform_unsupported");
	let rootInfo: Stats;
	try {
		rootInfo = lstatSync(dependencies.root);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? { status: "absent" }
			: unknown("queue_root_unreadable");
	}
	if (
		!rootInfo.isDirectory() ||
		rootInfo.isSymbolicLink() ||
		rootInfo.uid !== uid
	)
		return unknown("queue_root_identity_invalid");
	const controlPath = join(dependencies.root, "control.json");
	if (!safeOwnedFile(controlPath, uid)) {
		try {
			lstatSync(controlPath);
			return unknown("queue_control_identity_invalid");
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT"
				? { status: "absent" }
				: unknown("queue_control_unreadable");
		}
	}
	let control: Row;
	try {
		control = JSON.parse(readFileSync(controlPath, "utf8"));
	} catch {
		return unknown("queue_control_unreadable");
	}
	if (
		control.schemaVersion !== 1 ||
		!UUID.test(String(control.generation ?? "")) ||
		!(["enabled", "disabled"] as unknown[]).includes(control.mode)
	)
		return unknown("queue_control_invalid");
	if (control.mode === "disabled") return { status: "absent" };
	const databasePath = join(dependencies.root, "queue.sqlite3");
	if (!safeOwnedFile(databasePath, uid))
		return unknown("queue_database_identity_invalid");
	let database: Database.Database | undefined;
	try {
		database = new Database(databasePath, {
			readonly: true,
			fileMustExist: true,
		});
		const columns = new Set(
			(database.prepare("PRAGMA table_info(requests)").all() as Row[]).map(
				(row) => row.name,
			),
		);
		if ([...REQUIRED_REQUEST_COLUMNS].some((name) => !columns.has(name)))
			return unknown("queue_schema_invalid");
		const metas = database.prepare("SELECT * FROM meta").all() as Row[];
		if (metas.length !== 1) return unknown("queue_meta_invalid");
		const meta = metas[0]!;
		if (
			meta.schemaVersion !== 1 ||
			meta.uid !== uid ||
			!UUID.test(String(meta.generation ?? "")) ||
			!exactInteger(meta.revision) ||
			!exactInteger(meta.capacity, 1)
		)
			return unknown("queue_meta_invalid");
		const claimed = database
			.prepare(
				"SELECT * FROM requests WHERE executionIdClaim=? AND state='queued' ORDER BY seq",
			)
			.all(context.executionId) as Row[];
		if (!claimed.length) return { status: "unrelated" };
		let worktree: string;
		try {
			worktree = realpathSync(context.worktreePath);
		} catch {
			return unknown("queue_worktree_unavailable");
		}
		const matched = claimed.filter((row) => row.worktreeRealpath === worktree);
		if (matched.length !== 1)
			return unknown(
				matched.length ? "queue_request_ambiguous" : "queue_worktree_mismatch",
			);
		const row = matched[0]!;
		if (
			!UUID.test(String(row.requestId ?? "")) ||
			row.ownerLockId !== row.requestId ||
			row.protocolVersion !== 1 ||
			!exactInteger(row.seq, 1) ||
			!exactInteger(row.supervisorPid, 1) ||
			!exactInteger(row.ownerLockDev) ||
			!exactInteger(row.ownerLockInode, 1) ||
			!exactInteger(row.enqueuedAtMs, 1) ||
			!exactInteger(row.heartbeatAtMs, 1) ||
			new Date(Number(row.enqueuedAtMs)).toISOString() !== row.enqueuedAt
		)
			return unknown("queue_request_invalid");
		if (
			context.activationBoundaryMs === null ||
			!Number.isSafeInteger(context.activationBoundaryMs) ||
			Number(row.enqueuedAtMs) <= context.activationBoundaryMs ||
			Number(row.enqueuedAtMs) > context.nowMs
		)
			return unknown("queue_activation_boundary_invalid");
		const heartbeatAge = context.nowMs - Number(row.heartbeatAtMs);
		if (heartbeatAge < 0) return unknown("queue_clock_invalid");
		if (heartbeatAge > 10_000) return unknown("queue_heartbeat_stale");
		const lockPath = join(
			dependencies.root,
			"owners",
			`${String(row.ownerLockId)}.lock`,
		);
		if (!safeOwnedFile(lockPath, uid))
			return unknown("queue_owner_identity_invalid");
		if (probeOwnerLock(lockPath, row, uid) !== "held")
			return unknown("queue_owner_identity_invalid");
		if (
			!(dependencies.processProbe ?? defaultProcessProbe)(
				Number(row.supervisorPid),
				context.executionId,
			)
		)
			return unknown("queue_process_unverified");
		const position = Number(
			(
				database
					.prepare(
						"SELECT COUNT(*) AS count FROM requests WHERE state='queued' AND seq<=?",
					)
					.get(row.seq) as Row
			).count,
		);
		if (!exactInteger(position, 1)) return unknown("queue_position_invalid");
		return {
			status: "queued-valid",
			evidence: {
				requestId: String(row.requestId),
				status: "queued",
				seq: Number(row.seq),
				position,
				enqueuedAt: String(row.enqueuedAt),
				observedAt: new Date(context.nowMs).toISOString(),
				revision: Number(meta.revision),
				waitMs: context.nowMs - Number(row.enqueuedAtMs),
			},
		};
	} catch {
		return unknown("queue_database_unreadable");
	} finally {
		database?.close();
	}
}

export function readPackageGateQueue(
	context: PackageGateQueueContext,
): PackageGateQueueResult {
	return readPackageGateQueueAtRoot(context, { root: packageGateQueueRoot() });
}
