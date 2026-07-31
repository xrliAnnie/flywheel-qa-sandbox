/**
 * FLY-1549: the read-only v2 kernel snapshot behind the display derivation.
 *
 * The Discord messenger derives the three display surfaces from REAL state —
 * lifecycle events only trigger a refresh (founder ruling on FLY-907). The
 * control plane (delivery/settlement) stays entirely on the v2 CLI; this
 * reader opens the kernel database READ-ONLY via better-sqlite3 (the same
 * discipline as the v1 CommDB park probe): it physically cannot write, cannot
 * take the write lock, and WAL readers never block the engine's writer. All
 * it observes is tasks/attempts/activations and the dag_issue / ship_gate /
 * issue_closure meta envelopes.
 *
 * Every failure path returns null — the refresher treats an unreadable
 * snapshot as `deferred` and the sweep retries; a display can be stale but
 * must never crash the messenger or invent state.
 */

import Database from "better-sqlite3";
import type {
	V2IssueDisplaySnapshot,
	V2ShipGateView,
	V2TaskDisplayView,
} from "./v2-issue-display.js";

interface TaskRow {
	id: string;
	kind: string;
	state: string;
	created_at: string;
}

interface DependencyRow {
	task_id: string;
	blocked_by_task_id: string;
}

interface AttemptRow {
	id: string;
	task_id: string;
	generation: number;
	vendor: string | null;
	model: string | null;
	desired_state: string;
	terminal_reason: string | null;
}

interface ActivationRow {
	attempt_id: string;
	session_ref: string;
	state: string;
	generation: number;
}

/**
 * Codex code R1 #2: mirror the authoritative envelope contract (v2-dag
 * meta.ts readEnvelope) — an envelope whose `v` is not 1 or whose
 * `cutover_epoch` differs from the database's current epoch belongs to a
 * fenced-off generation and must NOT be rendered. The display's non-throwing
 * analog of the DAG reader's FenceViolation is `"stale"`, which makes the
 * whole snapshot read refuse (null → deferred, sweep retries).
 */
function parseEnvelopeData(
	raw: string | undefined,
	expectedEpoch: number,
):
	| { status: "absent" }
	| { status: "stale" }
	| { status: "ok"; data: unknown } {
	if (raw === undefined) return { status: "absent" };
	try {
		const parsed = JSON.parse(raw) as {
			v?: unknown;
			cutover_epoch?: unknown;
			data?: unknown;
		};
		if (parsed?.v !== 1 || parsed.cutover_epoch !== expectedEpoch) {
			return { status: "stale" };
		}
		return { status: "ok", data: parsed.data };
	} catch {
		return { status: "stale" };
	}
}

/** Kahn topological order over the issue's tasks; ties broken by
 * (created_at, id) so the header row order is stable across refreshes. */
function topologicalOrder(tasks: TaskRow[], deps: DependencyRow[]): TaskRow[] {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const indegree = new Map<string, number>(tasks.map((task) => [task.id, 0]));
	const forward = new Map<string, string[]>();
	for (const dep of deps) {
		if (!byId.has(dep.task_id) || !byId.has(dep.blocked_by_task_id)) continue;
		indegree.set(dep.task_id, (indegree.get(dep.task_id) ?? 0) + 1);
		const list = forward.get(dep.blocked_by_task_id) ?? [];
		list.push(dep.task_id);
		forward.set(dep.blocked_by_task_id, list);
	}
	const byStable = (a: string, b: string): number => {
		const ta = byId.get(a);
		const tb = byId.get(b);
		const created = (ta?.created_at ?? "").localeCompare(tb?.created_at ?? "");
		return created !== 0 ? created : a.localeCompare(b);
	};
	const queue = tasks
		.filter((task) => (indegree.get(task.id) ?? 0) === 0)
		.map((task) => task.id)
		.sort(byStable);
	const ordered: TaskRow[] = [];
	while (queue.length > 0) {
		const id = queue.shift() as string;
		const task = byId.get(id);
		if (task) ordered.push(task);
		for (const next of forward.get(id) ?? []) {
			const remaining = (indegree.get(next) ?? 0) - 1;
			indegree.set(next, remaining);
			if (remaining === 0) {
				queue.push(next);
				queue.sort(byStable);
			}
		}
	}
	if (ordered.length !== tasks.length) {
		// Cycle or dangling reference — degrade to stable creation order
		// rather than dropping rows (display must stay honest and total).
		return [...tasks].sort(
			(a, b) =>
				a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
		);
	}
	return ordered;
}

export interface V2DisplayReader {
	/** null = kernel unavailable / issue unknown — caller defers to sweep. */
	read(issueId: string): V2IssueDisplaySnapshot | null;
	close(): void;
}

interface ReadTxLike {
	get<T>(sql: string, params?: unknown): T | undefined;
	all<T>(sql: string, params?: unknown): T[];
}

function readFacade(db: Database.Database): ReadTxLike {
	const invoke = (
		sql: string,
		method: "get" | "all",
		params: unknown,
	): unknown => {
		const statement = db.prepare(sql);
		if (params === undefined) return statement[method]();
		if (Array.isArray(params)) return statement[method](...params);
		return statement[method](params);
	};
	return {
		get: <T>(sql: string, params?: unknown) =>
			invoke(sql, "get", params) as T | undefined,
		all: <T>(sql: string, params?: unknown) =>
			invoke(sql, "all", params) as T[],
	};
}

export function openV2DisplayReader(
	dbPath: string,
	logger: Pick<Console, "warn"> = console,
): V2DisplayReader {
	let db: Database.Database | null = null;

	function ensureDb(): Database.Database | null {
		if (db) return db;
		try {
			db = new Database(dbPath, {
				readonly: true,
				fileMustExist: true,
				timeout: 5_000,
			});
			db.pragma("busy_timeout = 5000");
			return db;
		} catch (error) {
			logger.warn(
				`[v2-display] kernel db not readable at ${dbPath}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return null;
		}
	}

	return {
		read(issueId: string): V2IssueDisplaySnapshot | null {
			const opened = ensureDb();
			if (!opened) return null;
			try {
				const tx = readFacade(opened);
				// One deferred read transaction so the multi-query snapshot is
				// internally consistent against the engine's writer.
				const run = opened.transaction((): V2IssueDisplaySnapshot | null => {
					// Authority sanity (Codex design R1 #1): an initialized engine db
					// always carries a valid cutover_epoch — a random-but-valid
					// SQLite file must read as "unavailable", never as empty state.
					const epochRaw = tx.get<{ value: string }>(
						"SELECT value FROM meta WHERE key='cutover_epoch'",
					)?.value;
					const epoch = epochRaw === undefined ? Number.NaN : Number(epochRaw);
					if (!Number.isSafeInteger(epoch) || epoch <= 0) {
						logger.warn(
							`[v2-display] db at ${dbPath} has no valid cutover_epoch — refusing to derive`,
						);
						return null;
					}
					const issueEnvelope = parseEnvelopeData(
						tx.get<{ value: string }>("SELECT value FROM meta WHERE key=@key", {
							key: `dag_issue:${issueId}`,
						})?.value,
						epoch,
					);
					if (issueEnvelope.status === "stale") {
						logger.warn(
							`[v2-display] dag_issue envelope for ${issueId} is from another generation — refusing to derive`,
						);
						return null;
					}
					if (issueEnvelope.status === "absent") return null;
					const issueData = issueEnvelope.data as
						| { task_ids?: unknown }
						| undefined;
					if (!issueData || !Array.isArray(issueData.task_ids)) return null;
					const taskIds = issueData.task_ids.filter(
						(id): id is string => typeof id === "string" && id.length > 0,
					);
					if (taskIds.length === 0) {
						return { issueId, tasks: [] } satisfies V2IssueDisplaySnapshot;
					}
					const placeholders = taskIds.map(() => "?").join(",");
					const tasks = tx.all<TaskRow>(
						`SELECT id, kind, state, created_at FROM tasks WHERE id IN (${placeholders})`,
						taskIds,
					);
					const deps = tx.all<DependencyRow>(
						`SELECT task_id, blocked_by_task_id FROM task_dependencies WHERE task_id IN (${placeholders})`,
						taskIds,
					);
					const attempts = tx.all<AttemptRow>(
						`SELECT id, task_id, generation, vendor, model, desired_state, terminal_reason
						 FROM attempts WHERE task_id IN (${placeholders})
						 ORDER BY task_id, generation`,
						taskIds,
					);
					const attemptsByTask = new Map<string, AttemptRow[]>();
					for (const attempt of attempts) {
						const list = attemptsByTask.get(attempt.task_id) ?? [];
						list.push(attempt);
						attemptsByTask.set(attempt.task_id, list);
					}
					const chosenAttempts = new Map<string, AttemptRow>();
					for (const [taskId, list] of attemptsByTask) {
						const active = list.find(
							(attempt) => attempt.desired_state !== "terminal",
						);
						const chosen = active ?? list[list.length - 1];
						if (chosen) chosenAttempts.set(taskId, chosen);
					}
					const chosenIds = [...chosenAttempts.values()].map(
						(attempt) => attempt.id,
					);
					const sessionRefByAttempt = new Map<string, string>();
					if (chosenIds.length > 0) {
						const attemptPlaceholders = chosenIds.map(() => "?").join(",");
						const activations = tx.all<ActivationRow>(
							`SELECT attempt_id, session_ref, state, generation
							 FROM activations WHERE attempt_id IN (${attemptPlaceholders})
							 ORDER BY attempt_id, generation`,
							chosenIds,
						);
						for (const activation of activations) {
							// Later rows (higher generation) win; an active one wins outright.
							const existing = sessionRefByAttempt.get(activation.attempt_id);
							if (existing === undefined || activation.state === "active") {
								sessionRefByAttempt.set(
									activation.attempt_id,
									activation.session_ref,
								);
							}
						}
					}
					const views: V2TaskDisplayView[] = topologicalOrder(tasks, deps).map(
						(task) => {
							const list = attemptsByTask.get(task.id) ?? [];
							const chosen = chosenAttempts.get(task.id);
							return {
								taskId: task.id,
								kind: task.kind,
								state: task.state,
								attemptCount: list.length,
								...(chosen
									? {
											attempt: {
												attemptId: chosen.id,
												desiredState: chosen.desired_state,
												...(chosen.terminal_reason
													? { terminalReason: chosen.terminal_reason }
													: {}),
												...(chosen.vendor ? { vendor: chosen.vendor } : {}),
												...(chosen.model ? { model: chosen.model } : {}),
												...(chosen.desired_state !== "terminal" &&
												sessionRefByAttempt.has(chosen.id)
													? {
															sessionRef: sessionRefByAttempt.get(chosen.id),
														}
													: {}),
											},
										}
									: {}),
							};
						},
					);
					const gateEnvelope = parseEnvelopeData(
						tx.get<{ value: string }>("SELECT value FROM meta WHERE key=@key", {
							key: `ship_gate:${issueId}`,
						})?.value,
						epoch,
					);
					if (gateEnvelope.status === "stale") {
						logger.warn(
							`[v2-display] ship_gate envelope for ${issueId} is from another generation — refusing to derive`,
						);
						return null;
					}
					const gateData = (
						gateEnvelope.status === "ok" ? gateEnvelope.data : undefined
					) as
						| {
								state?: unknown;
								target?: { repo?: unknown; pr?: unknown; head?: unknown };
								settled?: unknown;
						  }
						| undefined;
					const gate: V2ShipGateView | undefined =
						gateData && typeof gateData.state === "string"
							? {
									state: gateData.state,
									...(typeof gateData.target?.repo === "string"
										? { repo: gateData.target.repo }
										: {}),
									...(typeof gateData.target?.pr === "number"
										? { pr: gateData.target.pr }
										: {}),
									...(typeof gateData.target?.head === "string"
										? { head: gateData.target.head }
										: {}),
									settled: Boolean(gateData.settled),
								}
							: undefined;
					const closureEnvelope = parseEnvelopeData(
						tx.get<{ value: string }>("SELECT value FROM meta WHERE key=@key", {
							key: `issue_closure:${issueId}`,
						})?.value,
						epoch,
					);
					if (closureEnvelope.status === "stale") {
						logger.warn(
							`[v2-display] issue_closure envelope for ${issueId} is from another generation — refusing to derive`,
						);
						return null;
					}
					const closureData = (
						closureEnvelope.status === "ok" ? closureEnvelope.data : undefined
					) as { state?: unknown } | undefined;
					const closure =
						closureData && typeof closureData.state === "string"
							? closureData.state
							: undefined;
					return {
						issueId,
						tasks: views,
						...(gate ? { gate } : {}),
						...(closure ? { closure } : {}),
					} satisfies V2IssueDisplaySnapshot;
				});
				return run();
			} catch (error) {
				logger.warn(
					`[v2-display] snapshot read failed for ${issueId}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				// A dead handle (e.g. the db file was replaced) should not wedge the
				// reader forever — drop it so the next read reopens.
				try {
					db?.close();
				} catch {
					// already closed
				}
				db = null;
				return null;
			}
		},
		close(): void {
			try {
				db?.close();
			} catch {
				// already closed
			}
			db = null;
		},
	};
}
