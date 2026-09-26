import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

export const THREAD_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ROTATION_PERIOD_MS = 7 * 86_400_000;
export const ROTATION_QUIET_MS = 1_800_000;
export const ROTATION_RETRY_BACKOFF_MS = 21_600_000;
export const ROTATION_CHECK_INTERVAL_MS = 60_000;
export const PENDING_TTL_MS = 3_600_000;
export const FENCE_IDLE_WAIT_MS = 60_000;
export const TURNS_LIST_TIMEOUT_MS = 10_000;
export const LEDGER_MAX_BYTES = 65_536;
export const THREAD_ID_FILE_MAX_BYTES = 256;
export const CLOCK_SKEW_MS = 300_000;
export const ROTATION_READY_TIMEOUT_MS = 120_000;

export function rotationDeveloperNote(
	at: number,
	previousThreadId: string,
): string {
	if (!THREAD_ID_RE.test(previousThreadId))
		throw new Error("invalid previous thread id");
	return `[系统换页 · ${new Date(at).toISOString()}] 这是一段新的对话页;上一页线程 ${previousThreadId} 已按周期封存,不会再有新内容。你的长期记忆摘要由系统另行注入;不要假设上一页的任何未完成事项仍然有效,founder 会在需要时重新告诉你。`;
}

const outcomeSchema = z.enum([
	"rotated",
	"reconciled:pending_attempted",
	"reconciled:pending_busy",
	"rotation_skipped:founder_turn_active",
	"rotation_skipped:router_busy",
	"rotation_skipped:pane_kill_unverified",
	"rotation_skipped:turns_list_busy",
	"rotation_skipped:pending_write_failed",
	"rotation_skipped:rebuild_refused",
	"rotation_failed:fence_error",
	"rotation_failed:attempt_mark_failed",
	"rotation_failed:thread_start_failed",
	"rotation_failed:thread_id_invalid",
	"rotation_failed:thread_id_write_failed",
]);
function ledgerSchema(now: number) {
	const id = z.string().regex(THREAD_ID_RE);
	const time = z.string().refine((value) => {
		const ms = Date.parse(value);
		return (
			Number.isFinite(ms) &&
			ms <= now + CLOCK_SKEW_MS &&
			new Date(ms).toISOString() === value
		);
	});
	return z
		.object({
			v: z.literal(1),
			currentThreadId: id,
			startedAt: time,
			previousThreadId: id.nullable(),
			lastAttemptAt: time.nullable(),
			lastAttemptOutcome: outcomeSchema.nullable(),
			pending: z
				.object({
					requestedAt: time,
					fromThreadId: id,
					reason: z.literal("period"),
					attemptStartedAt: time.nullable(),
				})
				.strict()
				.nullable(),
			readinessPending: z
				.object({ to: id, requestedAt: time, degradedAt: time.nullable() })
				.strict()
				.nullable(),
		})
		.strict();
}
export type RotationLedger = z.infer<ReturnType<typeof ledgerSchema>>;
export type RotationLedgerRead =
	| { kind: "ok"; ledger: RotationLedger }
	| { kind: "missing" | "unreadable" };
export type ThreadIdRead =
	| { kind: "ok"; id: string }
	| {
			kind:
				| "missing"
				| "unreadable"
				| "symlink_or_irregular"
				| "oversize"
				| "empty"
				| "unsafe";
	  };

export function readThreadIdStrict(
	path: string,
	io: typeof fs = fs,
): ThreadIdRead {
	let fd: number | undefined;
	try {
		if (!io.lstatSync(path).isFile()) return { kind: "symlink_or_irregular" };
		fd = io.openSync(
			path,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
		const stat = io.fstatSync(fd);
		if (!stat.isFile()) return { kind: "symlink_or_irregular" };
		if (stat.size > THREAD_ID_FILE_MAX_BYTES) return { kind: "oversize" };
		const text = io.readFileSync(fd, "utf8");
		if (Buffer.byteLength(text) > THREAD_ID_FILE_MAX_BYTES)
			return { kind: "oversize" };
		const id = text.trim();
		return !id
			? { kind: "empty" }
			: THREAD_ID_RE.test(id)
				? { kind: "ok", id }
				: { kind: "unsafe" };
	} catch (error) {
		return {
			kind:
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? "missing"
					: "unreadable",
		};
	} finally {
		if (fd !== undefined) io.closeSync(fd);
	}
}

export function readRotationLedger(
	path: string,
	now: number,
	io: typeof fs = fs,
): RotationLedgerRead {
	let fd: number | undefined;
	try {
		fd = io.openSync(
			path,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
		const stat = io.fstatSync(fd);
		if (!stat.isFile() || stat.size > LEDGER_MAX_BYTES)
			return { kind: "unreadable" };
		const text = io.readFileSync(fd, "utf8");
		if (Buffer.byteLength(text) > LEDGER_MAX_BYTES)
			return { kind: "unreadable" };
		return { kind: "ok", ledger: ledgerSchema(now).parse(JSON.parse(text)) };
	} catch (error) {
		return {
			kind:
				(error as NodeJS.ErrnoException).code === "ENOENT"
					? "missing"
					: "unreadable",
		};
	} finally {
		if (fd !== undefined) io.closeSync(fd);
	}
}

/** Same-directory rename is the commit point; callers own reconciliation. */
export function writeAtomicFile(
	path: string,
	text: string,
	io: typeof fs = fs,
): void {
	const temporary = join(dirname(path), `.thread-rotation-${randomUUID()}.tmp`);
	try {
		io.writeFileSync(temporary, text, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		io.renameSync(temporary, path);
	} finally {
		io.rmSync(temporary, { force: true });
	}
}

export function writeRotationLedger(
	path: string,
	ledger: RotationLedger,
	now: number,
	io: typeof fs = fs,
): void {
	ledgerSchema(now).parse(ledger);
	writeAtomicFile(path, `${JSON.stringify(ledger)}\n`, io);
	const readback = readRotationLedger(path, now, io);
	if (readback.kind !== "ok" || !isDeepStrictEqual(readback.ledger, ledger))
		throw new Error("rotation ledger readback mismatch");
}

export type ReconcileReason =
	| "pristine"
	| "ledger_missing"
	| "ledger_unreadable"
	| "thread_id_ahead_of_ledger"
	| "pending_stale"
	| "pending_attempted"
	| "pending_expired"
	| "thread_changed_turnless";
export function reconcileRotationLedger(
	saved: string,
	read: RotationLedgerRead,
	now: number,
	seedAt: number,
	pristine = false,
): { ledger: RotationLedger; reason: ReconcileReason | null } {
	if (pristine || read.kind !== "ok")
		return {
			ledger: {
				v: 1,
				currentThreadId: saved,
				startedAt: new Date(pristine ? now : seedAt).toISOString(),
				previousThreadId: null,
				lastAttemptAt: null,
				lastAttemptOutcome: null,
				pending: null,
				readinessPending: null,
			},
			reason: pristine
				? "pristine"
				: read.kind === "missing"
					? "ledger_missing"
					: "ledger_unreadable",
		};
	const ledger = read.ledger;
	if (ledger.currentThreadId !== saved)
		return {
			ledger: {
				...ledger,
				currentThreadId: saved,
				previousThreadId: ledger.currentThreadId,
				startedAt: new Date(now).toISOString(),
				pending: null,
				readinessPending:
					ledger.readinessPending?.to === saved
						? ledger.readinessPending
						: null,
			},
			reason: "thread_id_ahead_of_ledger",
		};
	const pending = ledger.pending;
	if (pending?.fromThreadId && pending.fromThreadId !== saved)
		return { ledger: { ...ledger, pending: null }, reason: "pending_stale" };
	if (pending?.attemptStartedAt)
		return {
			ledger: {
				...ledger,
				pending: null,
				lastAttemptAt: pending.attemptStartedAt,
				lastAttemptOutcome: "reconciled:pending_attempted",
			},
			reason: "pending_attempted",
		};
	if (pending && now - Date.parse(pending.requestedAt) > PENDING_TTL_MS)
		return { ledger: { ...ledger, pending: null }, reason: "pending_expired" };
	return { ledger, reason: null };
}

export function isRotationDue(input: {
	ledger: RotationLedger;
	now: number;
	enabled: boolean;
	stopped: boolean;
	disabled: boolean;
	attemptInFlight: boolean;
	completedSinceStart: number;
	routerIdle: boolean;
	founderTurnActive: boolean | "unknown";
	lastActivityAt: number;
}): boolean {
	const { ledger, now } = input;
	return (
		input.enabled &&
		!input.stopped &&
		!input.disabled &&
		!input.attemptInFlight &&
		ledger.pending === null &&
		now - Date.parse(ledger.startedAt) >= ROTATION_PERIOD_MS &&
		(ledger.lastAttemptAt === null ||
			now - Date.parse(ledger.lastAttemptAt) >= ROTATION_RETRY_BACKOFF_MS) &&
		input.completedSinceStart >= 1 &&
		input.routerIdle &&
		input.founderTurnActive !== true &&
		now - input.lastActivityAt >= ROTATION_QUIET_MS
	);
}

/** Only an explicit terminal latest turn can authorize consuming pending. */
export async function boundedTurnsList(
	request: (
		method: string,
		params: Record<string, unknown>,
	) => Promise<unknown>,
	threadId: string,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const response = await Promise.race([
			request("thread/turns/list", {
				threadId,
				limit: 1,
				sortDirection: "desc",
				itemsView: "notLoaded",
			}),
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), TURNS_LIST_TIMEOUT_MS);
			}),
		]);
		const parsed = z
			.object({
				result: z.object({
					data: z
						.array(
							z.object({
								status: z.enum(["completed", "interrupted", "failed"]),
							}),
						)
						.length(1),
				}),
			})
			.safeParse(response);
		return parsed.success;
	} catch {
		return false;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export interface LatestTurn {
	id: string;
	status: "inProgress" | "completed" | "interrupted" | "failed";
	/** Server unix seconds; always present for an in-progress turn. */
	startedAt: number | null;
}

const latestTurnResponse = z.object({
	result: z.object({
		data: z
			.array(
				z.object({
					id: z.string().min(1).max(128),
					status: z.enum(["inProgress", "completed", "interrupted", "failed"]),
					startedAt: z.number().int().positive().nullable(),
				}),
			)
			.max(1),
	}),
});

/**
 * FLY-2882: the newest turn of `threadId`, or null when the thread has none.
 * Only `id/status/startedAt` leave this function (items/error bodies are never
 * copied). Anything else — malformed rows, an in-progress turn without a start
 * time, request failure or timeout — throws, so a caller can never mistake a
 * failed read for "idle".
 */
export async function readLatestTurn(
	request: (
		method: string,
		params: Record<string, unknown>,
	) => Promise<unknown>,
	threadId: string,
): Promise<LatestTurn | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const response = await Promise.race([
			request("thread/turns/list", {
				threadId,
				limit: 1,
				sortDirection: "desc",
				itemsView: "notLoaded",
			}),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("turns_list_timeout")),
					TURNS_LIST_TIMEOUT_MS,
				);
			}),
		]);
		// A JSON-RPC error — even beside a result — is never an empty thread.
		if (
			typeof response === "object" &&
			response !== null &&
			Object.hasOwn(response, "error")
		)
			throw new Error("turns_list_error");
		const parsed = latestTurnResponse.safeParse(response);
		if (!parsed.success) throw new Error("turns_list_invalid");
		const row = parsed.data.result.data[0];
		if (!row) return null;
		if (row.status === "inProgress" && row.startedAt === null)
			throw new Error("turns_list_invalid");
		return { id: row.id, status: row.status, startedAt: row.startedAt };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export function rolloutTimestampFor(
	codexHome: string,
	threadId: string,
	now: number,
): number {
	if (!THREAD_ID_RE.test(threadId)) return now;
	const matches: number[] = [];
	const pattern = new RegExp(
		`^rollout-(\\d{4}-\\d{2}-\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})-${threadId}\\.jsonl$`,
	);
	const visit = (path: string): void => {
		for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
			if (entry.isDirectory()) visit(join(path, entry.name));
			else if (entry.isFile()) {
				const match = pattern.exec(entry.name);
				if (match) {
					const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.000Z`;
					const ms = Date.parse(iso);
					matches.push(
						Number.isFinite(ms) &&
							new Date(ms).toISOString() === iso &&
							ms <= now + CLOCK_SKEW_MS
							? ms
							: now,
					);
				}
			}
		}
	};
	try {
		visit(join(codexHome, "sessions"));
	} catch {
		return now;
	}
	return matches.length === 1 ? matches[0]! : now;
}

export function appendRotationReceipt(
	path: string,
	event: Record<string, unknown>,
	warn: (message: string) => void,
): void {
	try {
		fs.appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
	} catch {
		warn("[codex-lead-thread-rotation] receipt append failed");
	}
}
