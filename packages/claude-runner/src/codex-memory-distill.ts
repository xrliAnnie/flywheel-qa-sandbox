/** FLY-2460: observe native memory without modifying Codex tables.
 * Read-only WAL connections may create SQLite -shm coordination files.
 */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { isAgentHomeSubtreePath } from "./codex-home.js";

export interface DistillHint {
	threadId: string;
	updatedAt: string;
	rolloutBytes: number;
	rolloutBytesAvailability?: "exact" | "unavailable";
}
interface CandidateRow {
	id: string;
	updated_at_ms: number;
	rollout_path: string;
}
export interface DistillReadDeps {
	openDb?: (path: string, timeoutMs: number) => Database.Database;
	stat?: typeof statSync;
	remaining?: () => number;
}
function refreshReadBudget(
	db: Database.Database | undefined,
	deps: DistillReadDeps,
): void {
	if (!deps.remaining) return;
	const ms = deps.remaining();
	// The integer comes only from the local deadline, never external SQL input.
	if (!Number.isFinite(ms) || ms <= 0) throw new DistillStop("timeout");
	db?.pragma(`busy_timeout = ${Math.min(5000, Math.floor(ms))}`);
}

function openReadOnly(path: string, timeoutMs: number): Database.Database {
	return new Database(path, {
		readonly: true,
		fileMustExist: true,
		timeout: Math.min(5000, Math.max(0, Math.floor(timeoutMs))),
	});
}
function exists(path: string): boolean {
	try {
		statSync(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
export function readDistillCandidates(
	home: string,
	now: number,
	timeoutMs: number,
	deps: DistillReadDeps = {},
): { hints: DistillHint[]; stage1OutputsBefore: number } {
	const open = deps.openDb ?? openReadOnly;
	if (!exists(join(home, "state_5.sqlite")))
		return { hints: [], stage1OutputsBefore: 0 };
	const state = open(join(home, "state_5.sqlite"), timeoutMs);
	let memories: Database.Database | undefined;
	try {
		if (exists(join(home, "memories_1.sqlite")))
			memories = open(join(home, "memories_1.sqlite"), timeoutMs);
		refreshReadBudget(state, deps);
		const rows = state
			.prepare(`SELECT id, updated_at_ms, rollout_path FROM threads
   WHERE archived = 0 AND preview <> '' AND source IN ('cli','vscode','atlas','chatgpt')
   AND memory_mode = 'enabled' AND updated_at_ms <= ? AND updated_at_ms >= ?
   ORDER BY updated_at_ms DESC, id DESC`)
			.all(now - 3_600_000, now - 864_000_000) as CandidateRow[];
		const output = memories?.prepare(
			"SELECT source_updated_at FROM stage1_outputs WHERE thread_id = ?",
		);
		const job = memories?.prepare(
			"SELECT last_success_watermark FROM jobs WHERE kind = 'memory_stage1' AND job_key = ?",
		);
		const hints: DistillHint[] = [];
		for (const row of rows) {
			refreshReadBudget(memories, deps);
			const o = output?.get(row.id) as
				| { source_updated_at: number }
				| undefined;
			refreshReadBudget(memories, deps);
			const j = job?.get(row.id) as
				| { last_success_watermark: number | null }
				| undefined;
			if (
				(o?.source_updated_at ?? -1) >= Math.floor(row.updated_at_ms / 1000) ||
				(j?.last_success_watermark ?? -1) >=
					Math.floor(row.updated_at_ms / 1000)
			)
				continue;
			let rolloutBytes = 0;
			let rolloutBytesAvailability: "exact" | "unavailable" = "exact";
			try {
				rolloutBytes = (deps.stat ?? statSync)(row.rollout_path).size;
			} catch {
				// File size is optional cost evidence, not database health or eligibility.
				rolloutBytesAvailability = "unavailable";
			}
			hints.push({
				threadId: row.id,
				updatedAt: new Date(row.updated_at_ms).toISOString(),
				rolloutBytes,
				rolloutBytesAvailability,
			});
			if (hints.length === 2) break;
		}
		refreshReadBudget(memories, deps);
		const count = memories
			?.prepare("SELECT COUNT(*) AS count FROM stage1_outputs")
			.get() as { count: number } | undefined;
		return { hints, stage1OutputsBefore: count?.count ?? 0 };
	} finally {
		memories?.close();
		state.close();
	}
}

export interface DistillClaim {
	threadId: string;
	before: string;
	after: "done_with_output" | "done_no_output" | "error" | "pending";
	lastError: string | null;
	output: {
		present: boolean;
		sourceUpdatedAt: number | null;
		inputWatermark: number | null;
		selectedForPhase2: boolean;
		selectedForPhase2SourceUpdatedAt: number | null;
	};
}
interface JobRow {
	kind: string;
	job_key: string;
	status: string;
	input_watermark: number | null;
	last_error: string | null;
}
interface OutputRow {
	source_updated_at: number;
	has_content: number;
	selected_for_phase2: number;
	selected_for_phase2_source_updated_at: number | null;
}
export interface DistillObservation {
	status: "partial" | "stage1_done" | "readable_ready";
	claimed: DistillClaim[];
	expectedButUnclaimed: string[];
	claimedUnexpected: string[];
	phase2: {
		observed: "claimed" | "not_observed_within_15s";
		status: string | null;
	};
	stage1OutputsAfter: number;
	anyClaim: boolean;
	stage1Running: boolean;
}
export function readDistillObservation(
	home: string,
	worker: string,
	hints: DistillHint[],
	timeoutMs: number,
	deps: DistillReadDeps = {},
	prior: Record<string, string> = {},
): DistillObservation {
	const result: DistillObservation = {
		status: "partial",
		claimed: [],
		expectedButUnclaimed: hints.map((h) => h.threadId),
		claimedUnexpected: [],
		phase2: { observed: "not_observed_within_15s", status: null },
		stage1OutputsAfter: 0,
		anyClaim: false,
		stage1Running: false,
	};
	if (!exists(join(home, "memories_1.sqlite"))) return result;
	const db = (deps.openDb ?? openReadOnly)(
		join(home, "memories_1.sqlite"),
		timeoutMs,
	);
	try {
		// A single read transaction keeps jobs and selected output watermarks coherent.
		return db.transaction(() => {
			refreshReadBudget(db, deps);
			const jobs = db
				.prepare(
					"SELECT kind, job_key, status, input_watermark, last_error FROM jobs WHERE worker_id = ? AND kind IN ('memory_stage1','memory_consolidate_global')",
				)
				.all(worker) as JobRow[];
			result.anyClaim = jobs.length > 0;
			const stage1 = jobs.filter((j) => j.kind === "memory_stage1");
			result.stage1Running = stage1.some((j) => j.status === "running");
			const output = db.prepare(`SELECT source_updated_at,
    (length(trim(raw_memory)) > 0 AND length(trim(rollout_summary)) > 0) AS has_content,
    selected_for_phase2, selected_for_phase2_source_updated_at FROM stage1_outputs WHERE thread_id = ?`);
			result.claimed = stage1.map((job) => {
				refreshReadBudget(db, deps);
				const row = output.get(job.job_key) as OutputRow | undefined;
				const valid =
					!!row &&
					row.has_content === 1 &&
					job.input_watermark !== null &&
					row.source_updated_at >= job.input_watermark;
				return {
					threadId: job.job_key,
					before: prior[job.job_key] ?? "absent",
					after:
						job.status === "done"
							? valid
								? "done_with_output"
								: "done_no_output"
							: job.status === "error"
								? "error"
								: "pending",
					lastError: job.last_error,
					output: {
						present: !!row,
						sourceUpdatedAt: row?.source_updated_at ?? null,
						inputWatermark: job.input_watermark,
						selectedForPhase2: row?.selected_for_phase2 === 1,
						selectedForPhase2SourceUpdatedAt:
							row?.selected_for_phase2_source_updated_at ?? null,
					},
				};
			});
			const claimedIds = new Set(stage1.map((j) => j.job_key));
			const hintIds = new Set(hints.map((h) => h.threadId));
			result.expectedButUnclaimed = hints
				.filter((h) => !claimedIds.has(h.threadId))
				.map((h) => h.threadId);
			result.claimedUnexpected = stage1
				.filter((j) => !hintIds.has(j.job_key))
				.map((j) => j.job_key);
			const phase2 = jobs.find((j) => j.kind === "memory_consolidate_global");
			if (phase2)
				result.phase2 = { observed: "claimed", status: phase2.status };
			refreshReadBudget(db, deps);
			result.stage1OutputsAfter = (
				db.prepare("SELECT COUNT(*) AS count FROM stage1_outputs").get() as {
					count: number;
				}
			).count;
			const targets = result.claimed.filter((c) => hintIds.has(c.threadId));
			if (
				hints.length &&
				!result.expectedButUnclaimed.length &&
				targets.every((c) => c.after === "done_with_output") &&
				phase2?.status !== "error"
			) {
				result.status =
					phase2?.status === "done" &&
					targets.every(
						(c) =>
							c.output.selectedForPhase2 &&
							c.output.selectedForPhase2SourceUpdatedAt ===
								c.output.sourceUpdatedAt,
					)
						? "readable_ready"
						: "stage1_done";
			}
			return result;
		})();
	} finally {
		db.close();
	}
}

/** No memory text is accepted by callers; the private receipt is outside the seed whitelist. */
export function writeDistillReceipt<
	T extends {
		version: number;
		executionId: string;
		home: string;
		status: string;
	},
>(receipt: T): T & { attempt: number; receiptPriorInvalid: boolean } {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(receipt.executionId))
		throw new Error("invalid distillation execution id");
	const dir = join(receipt.home, ".flywheel-memory-distill");
	try {
		mkdirSync(dir, { mode: 0o700 });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
	}
	if (!lstatSync(dir).isDirectory())
		throw new Error("distillation receipt directory must be a real directory");
	const path = join(dir, `${receipt.executionId}.json`);
	let attempt = 1;
	let receiptPriorInvalid = false;
	let fd: number | undefined;
	try {
		// O_NONBLOCK prevents a malicious FIFO from stalling before fstat can reject it.
		fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 65536)
			throw new Error("invalid previous receipt file");
		const prior = JSON.parse(readFileSync(fd, "utf8"));
		if (
			prior?.version !== 1 ||
			prior.executionId !== receipt.executionId ||
			prior.home !== receipt.home ||
			!Number.isSafeInteger(prior.attempt) ||
			prior.attempt < 1 ||
			prior.attempt >= Number.MAX_SAFE_INTEGER
		)
			throw new Error("invalid previous receipt identity");
		attempt = prior.attempt + 1;
	} catch (e) {
		receiptPriorInvalid = (e as NodeJS.ErrnoException).code !== "ENOENT";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	const result = { ...receipt, attempt, receiptPriorInvalid };
	const temp = join(dir, `.${receipt.executionId}.${randomUUID()}.tmp`);
	let created = false;
	try {
		const out = openSync(
			temp,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			0o600,
		);
		created = true;
		try {
			writeFileSync(out, `${JSON.stringify(result)}\n`);
		} finally {
			closeSync(out);
		}
		renameSync(temp, path);
		created = false;
	} finally {
		if (created) unlinkSync(temp);
	}
	return result;
}

export interface MemoryDistillInput {
	executionId: string;
	codexHome: string;
	cwd: string;
	signal: AbortSignal;
	client: Pick<
		import("./codex-daemon-client.js").CodexDaemonClient,
		"startThread" | "startTurn" | "setEvents" | "isClosed"
	>;
	waitBudgetMs?: number;
	pollMs?: number;
	log?: (message: string) => void;
}
export interface MemoryDistillDeps extends DistillReadDeps {
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}
class DistillStop extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}
export async function runMemoryDistillation(
	input: MemoryDistillInput,
	deps: MemoryDistillDeps = {},
) {
	const now = deps.now ?? Date.now;
	const started = now();
	const deadline =
		started + Math.min(300000, Math.max(0, input.waitBudgetMs ?? 300000));
	const pollMs = Math.max(1, input.pollMs ?? 5000);
	const remaining = () => {
		if (input.signal.aborted || input.client.isClosed())
			throw new DistillStop("runtime_stopped");
		const ms = deadline - now();
		if (ms <= 0) throw new DistillStop("timeout");
		return ms;
	};
	// RPCs and sleeps share the same absolute deadline and abort listener. No race
	// promise is left unhandled; timers/listeners are removed on every exit.
	const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
		const ms = remaining();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort = () => {};
		try {
			return await Promise.race([
				operation(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new DistillStop("timeout")), ms);
					abort = () => reject(new DistillStop("runtime_stopped"));
					input.signal.addEventListener("abort", abort, { once: true });
					if (input.signal.aborted) abort();
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
			input.signal.removeEventListener("abort", abort);
		}
	};
	const pause = async (until = deadline) => {
		const ms = Math.min(pollMs, remaining(), Math.max(0, until - now()));
		if (!ms) return;
		if (deps.sleep) await bounded(() => deps.sleep!(ms));
		else
			await new Promise<void>((resolve, reject) => {
				const abort = () => {
					clearTimeout(timer);
					input.signal.removeEventListener("abort", abort);
					reject(new DistillStop("runtime_stopped"));
				};
				const timer = setTimeout(() => {
					input.signal.removeEventListener("abort", abort);
					resolve();
				}, ms);
				input.signal.addEventListener("abort", abort, { once: true });
				if (input.signal.aborted) abort();
			});
	};
	const readDeps = {
		...deps,
		remaining,
		openDb: (path: string, _ms: number) =>
			(deps.openDb ?? openReadOnly)(path, Math.min(5000, remaining())),
	};
	let hints: DistillHint[] = [];
	let before = 0;
	let worker: string | null = null;
	let status = "partial";
	let observation: DistillObservation = {
		status: "partial",
		claimed: [],
		expectedButUnclaimed: [],
		claimedUnexpected: [],
		phase2: { observed: "not_observed_within_15s", status: null },
		stage1OutputsAfter: 0,
		anyClaim: false,
		stage1Running: false,
	};
	let tokens: number | null = null;
	const prior: Record<string, string> = {};
	let ownsEvents = false;
	let turnCompleted = false;
	try {
		remaining();
		const candidates = readDistillCandidates(
			input.codexHome,
			started,
			remaining(),
			readDeps,
		);
		hints = candidates.hints;
		before = candidates.stage1OutputsBefore;
		observation.stage1OutputsAfter = before;
		observation.expectedButUnclaimed = hints.map((h) => h.threadId);
		remaining();
		if (!hints.length) throw new DistillStop("no_candidates");
		if (exists(join(input.codexHome, "memories_1.sqlite"))) {
			const db = readDeps.openDb(
				join(input.codexHome, "memories_1.sqlite"),
				remaining(),
			);
			try {
				const rows = db
					.prepare(
						"SELECT job_key, status FROM jobs WHERE kind='memory_stage1'",
					)
					.all() as { job_key: string; status: string }[];
				for (const row of rows) prior[row.job_key] = row.status;
			} finally {
				db.close();
			}
		}
		try {
			worker = await bounded(() =>
				input.client.startThread({
					cwd: input.cwd,
					sandbox: "read-only",
					approvalPolicy: "never",
					config: {
						"memories.min_rollout_idle_hours": 1,
						"memories.max_rollout_age_days": 10,
						"memories.max_rollouts_per_startup": Math.min(2, hints.length),
						"memories.generate_memories": false,
					},
					timeoutMs: remaining(),
				}),
			);
		} catch (e) {
			if (e instanceof DistillStop) throw e;
			remaining();
			throw new DistillStop("thread_start_failed");
		}
		input.client.setEvents({
			onNotification: (method, params) => {
				if (
					method !== "turn/completed" ||
					!params ||
					typeof params !== "object"
				)
					return;
				const p = params as { threadId?: string };
				if (p.threadId === worker) turnCompleted = true;
			},
		});
		ownsEvents = true;
		try {
			await bounded(() => input.client.startTurn(worker!, "ok", remaining()));
		} catch (e) {
			if (e instanceof DistillStop) throw e;
			remaining();
			throw new DistillStop("turn_start_failed");
		}
		while (!turnCompleted) {
			await pause();
			remaining();
		}
		const observe = () => {
			remaining();
			observation = readDistillObservation(
				input.codexHome,
				worker!,
				hints,
				remaining(),
				readDeps,
				prior,
			);
			remaining();
		};
		const claimUntil = Math.min(deadline, now() + 45000);
		observe();
		while (!observation.anyClaim && now() < claimUntil) {
			await pause(claimUntil);
			observe();
		}
		if (!observation.anyClaim)
			throw new DistillStop("no_claim_observed_within_45s");
		while (observation.stage1Running) {
			await pause();
			observe();
		}
		const phase2Until = Math.min(deadline, now() + 15000);
		while (observation.phase2.observed !== "claimed" && now() < phase2Until) {
			await pause(phase2Until);
			observe();
		}
		while (observation.phase2.status === "running") {
			await pause();
			observe();
		}
		status = observation.status;
	} catch (error) {
		status = `skipped:${error instanceof DistillStop ? error.reason : "db_unreadable"}`;
	} finally {
		if (ownsEvents) input.client.setEvents({});
	}
	if (
		worker &&
		turnCompleted &&
		now() < deadline &&
		!input.signal.aborted &&
		!input.client.isClosed()
	) {
		try {
			// Missing token rows can lag turn/completed. Bound this final observation to
			// five seconds and never infer tokens from rollout bytes or phase2 metrics.
			const tokenUntil = Math.min(deadline, now() + 5000);
			do {
				const db = readDeps.openDb(
					join(input.codexHome, "state_5.sqlite"),
					remaining(),
				);
				try {
					const row = db
						.prepare("SELECT tokens_used FROM threads WHERE id = ?")
						.get(worker) as { tokens_used: number } | undefined;
					if (
						row &&
						Number.isSafeInteger(row.tokens_used) &&
						row.tokens_used >= 0
					)
						tokens = row.tokens_used;
				} finally {
					db.close();
				}
				if (tokens !== null || now() >= tokenUntil) break;
				await pause(tokenUntil);
			} while (tokens === null);
		} catch (error) {
			if (error instanceof DistillStop && status.startsWith("skipped:"))
				status = `skipped:${error.reason}`;
			// Token availability cannot turn valid output evidence into a DB failure.
		}
	}
	const finished = now();
	const receipt = writeDistillReceipt({
		version: 1,
		executionId: input.executionId,
		home: input.codexHome,
		homeKind: isAgentHomeSubtreePath(input.codexHome, process.env)
			? "keyed"
			: "legacy",
		status,
		triggerThreadId: worker,
		hints,
		claimed: observation.claimed,
		expectedButUnclaimed: observation.expectedButUnclaimed,
		claimedUnexpected: observation.claimedUnexpected,
		phase2: observation.phase2,
		stage1OutputsBefore: before,
		stage1OutputsAfter: observation.stage1OutputsAfter,
		cost: {
			wallMs: finished - started,
			triggerThreadTotalTokens: {
				value: tokens,
				availability: tokens === null ? "unavailable" : "exact",
				source: "threads.tokens_used read after turn/completed",
			},
			hintRolloutBytesTotal: {
				value: hints.reduce((total, h) => total + h.rolloutBytes, 0),
				availability: hints.some(
					(h) => h.rolloutBytesAvailability === "unavailable",
				)
					? "unavailable"
					: "exact",
				note: "raw rollout file bytes, volume proxy only",
			},
			phase2Tokens: {
				value: null,
				availability: "unavailable",
				note: "Codex only records metrics, not database tokens",
			},
		},
		startedAt: new Date(started).toISOString(),
		finishedAt: new Date(finished).toISOString(),
	});
	try {
		input.log?.(
			`[codex-memory-distill] ${JSON.stringify({ executionId: input.executionId, status, wallMs: receipt.cost.wallMs, triggerThreadTotalTokens: receipt.cost.triggerThreadTotalTokens })}`,
		);
	} catch {
		/* Logging never changes admission. */
	}
	return receipt;
}
