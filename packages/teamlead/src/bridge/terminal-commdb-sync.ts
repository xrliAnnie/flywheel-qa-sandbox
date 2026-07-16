/**
 * FLY-1066 Layer 1: asynchronously mirror StateStore-authoritative
 * failed/blocked outcomes into the per-project CommDB registry.
 *
 * Production status writers call enqueue() synchronously. All filesystem and
 * SQLite work happens later in a per-project single-flight drain, preserving
 * applyTransition's microsecond-only hook contract. Layer 2 remains the fallback
 * for every dropped, degraded, or failed item.
 */

export type TerminalCommDbStatus = "failed" | "blocked";

interface TerminalCommDbWriter {
	markSessionTerminalStatus(
		executionId: string,
		status: TerminalCommDbStatus,
	): void;
	close(): void;
}

export interface TerminalCommDbSyncStats {
	enqueued: number;
	coalesced: number;
	dropped: number;
	marked: number;
	skippedStale: number;
	skippedMissingDb: number;
	skippedDegraded: number;
	failed: number;
	warmFailures: number;
	degradedProjects: string[];
}

export interface TerminalCommDbSync {
	warmProjects(projectNames: readonly string[]): Promise<void>;
	enqueue(
		executionId: string,
		targetStatus: string,
		projectName: string,
	): boolean;
	flush(): Promise<void>;
	close(timeoutMs?: number): Promise<boolean>;
	stats(): TerminalCommDbSyncStats;
}

export interface TerminalCommDbSyncDeps {
	enabled: boolean;
	getAuthoritativeStatus(executionId: string): string | undefined;
	resolveDbPath(projectName: string): string | undefined;
	openDb(dbPath: string): TerminalCommDbWriter;
	/** Explicit boot migration. Missing DBs are a successful no-op. */
	warmProject?(projectName: string): void | Promise<void>;
	maxPending?: number;
	retryDelayMs?: number;
	scheduleRetry?(callback: () => void, delayMs: number): unknown;
	cancelRetry?(handle: unknown): void;
	log?(message: string): void;
}

const TERMINAL_STATUSES = new Set<TerminalCommDbStatus>(["failed", "blocked"]);

function isTerminalStatus(status: string): status is TerminalCommDbStatus {
	return TERMINAL_STATUSES.has(status as TerminalCommDbStatus);
}

export function createTerminalCommDbSync(
	deps: TerminalCommDbSyncDeps,
): TerminalCommDbSync {
	const maxPending = Math.max(1, deps.maxPending ?? 1_024);
	const retryDelayMs = Math.max(1, deps.retryDelayMs ?? 30_000);
	const log = deps.log ?? ((message: string) => console.warn(message));
	const scheduleRetry =
		deps.scheduleRetry ??
		((callback: () => void, delayMs: number) => {
			const timer = setTimeout(callback, delayMs);
			timer.unref?.();
			return timer;
		});
	const cancelRetry =
		deps.cancelRetry ??
		((handle: unknown) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>));

	const pending = new Map<string, Map<string, TerminalCommDbStatus>>();
	const readyProjects = new Set<string>();
	const degradedProjects = new Set<string>();
	const retryHandles = new Map<string, unknown>();
	const warming = new Map<string, Promise<void>>();
	const scheduled = new Set<string>();
	const inFlight = new Map<string, Promise<void>>();
	let closing = false;
	const counters = {
		enqueued: 0,
		coalesced: 0,
		dropped: 0,
		marked: 0,
		skippedStale: 0,
		skippedMissingDb: 0,
		skippedDegraded: 0,
		failed: 0,
		warmFailures: 0,
	};

	const pendingCount = (): number => {
		let count = 0;
		for (const byExecution of pending.values()) count += byExecution.size;
		return count;
	};

	const scheduleDrain = (projectName: string): void => {
		if (
			closing ||
			scheduled.has(projectName) ||
			inFlight.has(projectName) ||
			!pending.get(projectName)?.size
		) {
			return;
		}
		scheduled.add(projectName);
		queueMicrotask(() => {
			scheduled.delete(projectName);
			void startDrain(projectName);
		});
	};

	const recordFailure = (
		projectName: string,
		executionId: string,
		phase: "status-read" | "open" | "mark" | "close",
		error: unknown,
	): void => {
		counters.failed++;
		log(
			`[terminal-commdb-sync] ${phase} failed for ${projectName}/${executionId} (Layer 2 will converge): ${error instanceof Error ? error.message : String(error)}`,
		);
	};

	const drainProject = async (projectName: string): Promise<void> => {
		const byExecution = pending.get(projectName);
		if (!byExecution) return;
		while (byExecution.size > 0) {
			const next = byExecution.entries().next().value as
				| [string, TerminalCommDbStatus]
				| undefined;
			if (!next) break;
			const [executionId, targetStatus] = next;
			byExecution.delete(executionId);

			let authoritative: string | undefined;
			try {
				authoritative = deps.getAuthoritativeStatus(executionId);
			} catch (error) {
				recordFailure(projectName, executionId, "status-read", error);
				continue;
			}
			if (authoritative !== targetStatus) {
				counters.skippedStale++;
				continue;
			}

			const dbPath = deps.resolveDbPath(projectName);
			if (!dbPath) {
				counters.skippedMissingDb++;
				continue;
			}

			let db: TerminalCommDbWriter;
			try {
				db = deps.openDb(dbPath);
			} catch (error) {
				recordFailure(projectName, executionId, "open", error);
				continue;
			}
			try {
				db.markSessionTerminalStatus(executionId, targetStatus);
				counters.marked++;
			} catch (error) {
				recordFailure(projectName, executionId, "mark", error);
			} finally {
				try {
					db.close();
				} catch (error) {
					recordFailure(projectName, executionId, "close", error);
				}
			}
		}
		if (byExecution.size === 0) pending.delete(projectName);
	};

	function startDrain(projectName: string): Promise<void> {
		const existing = inFlight.get(projectName);
		if (existing) return existing;
		const promise = drainProject(projectName).finally(() => {
			inFlight.delete(projectName);
			if (!closing) scheduleDrain(projectName);
		});
		inFlight.set(projectName, promise);
		return promise;
	}

	const scheduleWarmRetry = (projectName: string): void => {
		if (closing || retryHandles.has(projectName)) return;
		const handle = scheduleRetry(() => {
			retryHandles.delete(projectName);
			void startWarm(projectName);
		}, retryDelayMs);
		retryHandles.set(projectName, handle);
	};

	function startWarm(projectName: string): Promise<void> {
		const existing = warming.get(projectName);
		if (existing) return existing;
		const promise = Promise.resolve()
			.then(() => deps.warmProject?.(projectName))
			.then(() => {
				readyProjects.add(projectName);
				degradedProjects.delete(projectName);
				const handle = retryHandles.get(projectName);
				if (handle !== undefined) {
					cancelRetry(handle);
					retryHandles.delete(projectName);
				}
				if (!closing) scheduleDrain(projectName);
			})
			.catch((error) => {
				readyProjects.delete(projectName);
				degradedProjects.add(projectName);
				counters.warmFailures++;
				log(
					`[terminal-commdb-sync] warm migration failed for ${projectName}; Layer 1 disabled for this project until retry (degraded=${degradedProjects.size}): ${error instanceof Error ? error.message : String(error)}`,
				);
				scheduleWarmRetry(projectName);
			})
			.finally(() => {
				warming.delete(projectName);
			});
		warming.set(projectName, promise);
		return promise;
	}

	const flush = async (): Promise<void> => {
		while (true) {
			if (warming.size > 0) await Promise.all([...warming.values()]);
			for (const [projectName, byExecution] of pending) {
				if (byExecution.size === 0) continue;
				scheduled.delete(projectName);
				if (!readyProjects.has(projectName)) {
					counters.skippedDegraded += byExecution.size;
					pending.delete(projectName);
					continue;
				}
				void startDrain(projectName);
			}
			if (inFlight.size > 0) await Promise.all([...inFlight.values()]);
			if (pendingCount() === 0 && inFlight.size === 0 && warming.size === 0) {
				return;
			}
		}
	};

	return {
		async warmProjects(projectNames) {
			if (!deps.enabled) return;
			await Promise.all(
				[...new Set(projectNames)].map((name) => startWarm(name)),
			);
		},

		enqueue(executionId, targetStatus, projectName) {
			if (
				!deps.enabled ||
				closing ||
				!isTerminalStatus(targetStatus) ||
				!readyProjects.has(projectName)
			) {
				if (
					deps.enabled &&
					isTerminalStatus(targetStatus) &&
					!readyProjects.has(projectName)
				) {
					counters.skippedDegraded++;
				}
				return false;
			}
			let byExecution = pending.get(projectName);
			if (!byExecution) {
				byExecution = new Map();
				pending.set(projectName, byExecution);
			}
			if (byExecution.has(executionId)) {
				byExecution.set(executionId, targetStatus);
				counters.coalesced++;
				scheduleDrain(projectName);
				return true;
			}
			if (pendingCount() >= maxPending) {
				counters.dropped++;
				log(
					`[terminal-commdb-sync] queue overflow (${maxPending}); dropped ${projectName}/${executionId} (Layer 2 will converge)`,
				);
				return false;
			}
			byExecution.set(executionId, targetStatus);
			counters.enqueued++;
			scheduleDrain(projectName);
			return true;
		},

		flush,

		async close(timeoutMs = 1_000) {
			closing = true;
			for (const handle of retryHandles.values()) cancelRetry(handle);
			retryHandles.clear();
			const drained = flush().then(() => true);
			const timed = new Promise<false>((resolve) => {
				const timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
				timer.unref?.();
			});
			const completed = await Promise.race([drained, timed]);
			if (!completed) {
				pending.clear();
				log(
					`[terminal-commdb-sync] shutdown drain exceeded ${timeoutMs}ms; remaining items abandoned to Layer 2`,
				);
			}
			return completed;
		},

		stats() {
			return {
				...counters,
				degradedProjects: [...degradedProjects].sort(),
			};
		},
	};
}
