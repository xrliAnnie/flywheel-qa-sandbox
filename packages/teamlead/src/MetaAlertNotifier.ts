/**
 * FLY-182 Track B (B2) — self-monitoring meta-alert.
 *
 * "LeadAlert must never fail silently" (Annie). When the Discord alert path
 * itself is broken — an alert can't be sent / dead-letters, drainQueue is stuck
 * at sent=0, the queue overflows, a Lead stops consuming its mailbox, or a Lead
 * has no reachable alert channel configured — we must reach Annie through a
 * channel that does NOT depend on Discord (the suspect link).
 *
 * Channel 1 (default): macOS desktop notification via `osascript`. Reliable
 * ONLY when the Bridge runs as a user LaunchAgent in an Aqua GUI session (the
 * current production setup). A system LaunchDaemon has no Window Server access —
 * `probeDesktopCapability()` detects this at startup and the file channel
 * becomes primary.
 *
 * Channel 2 (always): a high-visibility local file under
 * `<stateDir>/meta-alert/<reason>.txt`, OVERWRITTEN per reason (not appended —
 * never becomes a new unbounded queue).
 *
 * Debounce: the same reason fires at most once per `debounceMs` window so
 * meta-alerts don't themselves spam. In-memory (per Bridge process); a restart
 * legitimately re-alerts.
 *
 * Never throws — meta-alert is best-effort and must not break the caller.
 */

import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { getStateDir } from "flywheel-agent-team-transport";

const execFileAsync = promisify(execFile);

export type MetaAlertReason =
	| "alert_dead_lettered"
	| "drain_stuck"
	| "queue_overflow"
	| "mailbox_overflow"
	| "alert_unreachable_config"
	// FLY-513: the global `codex` binary the review gate resolves via PATH has
	// drifted into a per-Lead CODEX_HOME (or CODEX_HOME env is bad). The codex
	// review gate will transiently fail config-load; meta-alert so it is caught
	// loudly instead of silently stalling every runner.
	| "codex_global_unhealthy";

export interface MetaAlertInput {
	reason: MetaAlertReason;
	title: string;
	body: string;
}

export interface MetaAlertResult {
	debounced: boolean;
	desktop: boolean;
	file: boolean;
}

export type ExecFileLike = (
	cmd: string,
	args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export interface MetaAlertNotifierConfig {
	/** Base state dir (default: getStateDir() → ~/.flywheel/state). */
	stateDir?: string;
	/** Debounce window per reason (default 10min). */
	debounceMs?: number;
	/** Injectable exec for osascript (tests). */
	execFileFn?: ExecFileLike;
	now?: () => number;
	logger?: (msg: string) => void;
}

const DEFAULT_DEBOUNCE_MS = 600_000; // 10 min

export class MetaAlertNotifier {
	private readonly dir: string;
	private readonly debounceMs: number;
	private readonly execFileFn: ExecFileLike;
	private readonly now: () => number;
	private readonly logger: (msg: string) => void;
	private readonly lastSent = new Map<MetaAlertReason, number>();

	constructor(config: MetaAlertNotifierConfig = {}) {
		this.dir = join(config.stateDir ?? getStateDir(), "meta-alert");
		this.debounceMs = config.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		this.execFileFn =
			config.execFileFn ??
			((cmd, args) => execFileAsync(cmd, args, { timeout: 10_000 }));
		this.now = config.now ?? (() => Date.now());
		this.logger =
			config.logger ?? ((msg) => console.warn(`[MetaAlertNotifier] ${msg}`));
	}

	/**
	 * Fire a meta-alert (best-effort, never throws). Debounced per reason.
	 */
	async notify(input: MetaAlertInput): Promise<MetaAlertResult> {
		const now = this.now();
		const last = this.lastSent.get(input.reason);
		if (last !== undefined && now - last < this.debounceMs) {
			return { debounced: true, desktop: false, file: false };
		}
		this.lastSent.set(input.reason, now);

		const desktop = await this.tryDesktop(input);
		const file = await this.tryFile(input, now);
		if (!desktop && !file) {
			this.logger(
				`meta-alert '${input.reason}' could not be delivered by ANY channel`,
			);
		}
		return { debounced: false, desktop, file };
	}

	/**
	 * Startup capability probe — can this process post a desktop notification?
	 * (A daemon outside an Aqua session cannot.) Best-effort; returns false on
	 * any failure so callers can warn + lean on the file channel.
	 */
	async probeDesktopCapability(): Promise<boolean> {
		try {
			// `osascript -e 'return 1'` is a no-UI script — succeeds only when
			// osascript is runnable in this context.
			await this.execFileFn("osascript", ["-e", "return 1"]);
			return true;
		} catch (err) {
			this.logger(
				`desktop notifications unavailable (file channel only): ${(err as Error).message}`,
			);
			return false;
		}
	}

	private async tryDesktop(input: MetaAlertInput): Promise<boolean> {
		try {
			// Pass title/body as `argv` items (NOT interpolated into the script)
			// so no AppleScript string-injection is possible.
			await this.execFileFn("osascript", [
				"-e",
				"on run argv",
				"-e",
				"display notification (item 1 of argv) with title (item 2 of argv)",
				"-e",
				"end run",
				input.body,
				`Flywheel: ${input.title}`,
			]);
			return true;
		} catch (err) {
			this.logger(`osascript notify failed: ${(err as Error).message}`);
			return false;
		}
	}

	private async tryFile(input: MetaAlertInput, now: number): Promise<boolean> {
		try {
			await mkdir(this.dir, { recursive: true });
			const path = join(this.dir, `${input.reason}.txt`);
			const content = `[${new Date(now).toISOString()}] ${input.title}\nreason=${input.reason}\n\n${input.body}\n`;
			const tmp = `${path}.tmp.${process.pid}.${now}`;
			await writeFile(tmp, content, "utf-8");
			await rename(tmp, path);
			return true;
		} catch (err) {
			this.logger(`meta-alert file write failed: ${(err as Error).message}`);
			return false;
		}
	}
}
