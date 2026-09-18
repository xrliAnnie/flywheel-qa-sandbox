import { execFile } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HOUR_MS = 60 * 60 * 1000;

export function resolveCodexHomeReconcileStateRoot(
	env: NodeJS.ProcessEnv,
	homeDir: string,
): string {
	if (env.FLYWHEEL_CODEX_HOME_RECONCILE_SLOT === "1") {
		const stateRoot = env.FLYWHEEL_STATE_DIR?.trim();
		if (stateRoot) return stateRoot;
	}
	return join(homeDir, ".flywheel");
}

export function isCodexHomeReconcileHealthRiderEnabled(
	env: NodeJS.ProcessEnv,
): boolean {
	return env.FLYWHEEL_CODEX_HOME_RECONCILE_ENABLED === "1" && !env.VITEST;
}

export interface CodexHomeReconcileHealthRiderOptions {
	stateRoot: string;
	enabled?: boolean;
	now?: () => number;
	runCycle?: () => Promise<void>;
	cycleScript?: string;
	nodeBin?: string;
	env?: NodeJS.ProcessEnv;
}

function lastAttemptStartedAt(stateRoot: string): number | null {
	const path = join(
		stateRoot,
		"codex-quota",
		"home-migration",
		"schedule.json",
	);
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
			return null;
		const value = JSON.parse(readFileSync(path, "utf8")) as {
			schemaVersion?: unknown;
			lastAttemptStartedAt?: unknown;
		};
		if (
			value.schemaVersion !== 1 ||
			typeof value.lastAttemptStartedAt !== "string"
		)
			return null;
		const parsed = Date.parse(value.lastAttemptStartedAt);
		return Number.isFinite(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function defaultCycleScript(): string {
	return resolve(
		dirname(fileURLToPath(import.meta.url)),
		"../../../..",
		"scripts/codex-home-reconcile-cycle.mjs",
	);
}

export function createCodexHomeReconcileHealthRider(
	options: CodexHomeReconcileHealthRiderOptions,
): { tick: () => Promise<void> } {
	let inFlight = false;
	const enabled = options.enabled ?? true;
	const now = options.now ?? Date.now;
	const runCycle =
		options.runCycle ??
		(async () => {
			await execFileAsync(
				options.nodeBin ?? process.execPath,
				[options.cycleScript ?? defaultCycleScript(), "--source", "health"],
				{
					env: options.env ?? process.env,
					timeout: 180_000,
					maxBuffer: 4 * 1024 * 1024,
					encoding: "utf8",
				},
			);
		});
	return {
		async tick(): Promise<void> {
			if (!enabled || inFlight) return;
			const previous = lastAttemptStartedAt(options.stateRoot);
			if (previous !== null && now() < previous + HOUR_MS) return;
			inFlight = true;
			try {
				await runCycle();
			} finally {
				inFlight = false;
			}
		},
	};
}
