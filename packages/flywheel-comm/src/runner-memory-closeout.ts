import { isAbsolute } from "node:path";
import {
	measureRunnerMemoryIndex,
	parseRunnerMemoryCloseoutReceipt,
	parseRunnerMemorySnapshot,
	type RunnerMemoryCloseoutReceipt,
	type RunnerMemorySnapshot,
	resolveRunnerMemoryCloseoutState,
	sanitizeOneLine,
} from "flywheel-config";

function safeLog(
	log: ((line: string) => void) | undefined,
	line: string,
): void {
	try {
		(log ?? console.error)(line);
	} catch {
		// Visibility must never become a completion failure.
	}
}

function msgOnly(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function isReceiptSafeDir(value: string): boolean {
	return (
		value.trim().length > 0 &&
		value.length <= 1_024 &&
		isAbsolute(value) &&
		!hasControlCharacter(value)
	);
}

function canonicalIso(date: Date): string | undefined {
	try {
		const value = date.toISOString();
		return new Date(value).toISOString() === value ? value : undefined;
	} catch {
		return undefined;
	}
}

function safeIsoNow(now: (() => Date) | undefined): string | undefined {
	if (now) {
		try {
			const supplied = canonicalIso(now());
			if (supplied) return supplied;
		} catch {
			// Fall through to the platform clock.
		}
	}
	try {
		return canonicalIso(new Date());
	} catch {
		return undefined;
	}
}

/**
 * Measure the mounted role-memory index at terminal-command time. This is a
 * total, non-blocking boundary: malformed env, I/O, clocks, validation and
 * logging can reduce observability but can never prevent completion.
 */
export function collectRunnerMemoryCloseout(
	env: NodeJS.ProcessEnv,
	opts: {
		prefix: "[complete]" | "[qa-result]";
		now?: () => Date;
		log?: (line: string) => void;
	},
): RunnerMemoryCloseoutReceipt | undefined {
	const log = (line: string): void => safeLog(opts.log, line);
	try {
		const raw = env.FLYWHEEL_RUNNER_MEMORY_DIR;
		if (raw === undefined || raw === "") return undefined;
		if (!isReceiptSafeDir(raw)) {
			log(
				`${opts.prefix} runner-memory closeout skipped: invalid FLYWHEEL_RUNNER_MEMORY_DIR`,
			);
			return undefined;
		}
		const dir = raw;
		const measuredAt = safeIsoNow(opts.now);
		if (!measuredAt) {
			log(`${opts.prefix} runner-memory closeout skipped: clock unavailable`);
			return undefined;
		}

		let spawn: RunnerMemorySnapshot | undefined;
		try {
			spawn = parseRunnerMemorySnapshot(
				JSON.parse(env.FLYWHEEL_RUNNER_MEMORY_SNAPSHOT ?? "null"),
			);
		} catch {
			spawn = undefined;
		}

		let candidate: unknown;
		try {
			const measured = measureRunnerMemoryIndex(dir);
			const closeout = {
				...measured.snapshot,
				overBudget: measured.stats.overBudget,
				overHard: measured.stats.overHard,
				...(measured.stats.overHard
					? { firstDroppedLine: measured.stats.firstDroppedLine }
					: {}),
			};
			const resolution = resolveRunnerMemoryCloseoutState({ spawn, closeout });
			const canDelta =
				spawn !== undefined &&
				spawn.topicFiles >= 0 &&
				closeout.topicFiles >= 0 &&
				resolution.state !== "unmeasurable";
			const delta =
				canDelta && spawn
					? {
							indexChanged: spawn.sha16 !== closeout.sha16,
							lines: closeout.lines - spawn.lines,
							topicFiles: closeout.topicFiles - spawn.topicFiles,
						}
					: undefined;
			candidate = {
				v: 1,
				state: resolution.state,
				dir,
				measuredAt,
				...(spawn ? { spawn } : {}),
				closeout,
				...(delta ? { delta } : {}),
				...(resolution.error ? { error: resolution.error } : {}),
			};
		} catch (error) {
			candidate = {
				v: 1,
				state: "unmeasurable",
				dir,
				measuredAt,
				...(spawn ? { spawn } : {}),
				error: sanitizeOneLine(msgOnly(error), 200),
			};
		}

		const parsed = parseRunnerMemoryCloseoutReceipt(candidate);
		if (parsed) return parsed;
		const fallback = parseRunnerMemoryCloseoutReceipt({
			v: 1,
			state: "unmeasurable",
			dir,
			measuredAt,
			error: "self_check_failed",
		});
		if (fallback) return fallback;
		log(
			`${opts.prefix} runner-memory closeout skipped: receipt self-check failed`,
		);
		return undefined;
	} catch (error) {
		log(
			`${opts.prefix} runner-memory closeout skipped: ${sanitizeOneLine(msgOnly(error), 200)}`,
		);
		return undefined;
	}
}
