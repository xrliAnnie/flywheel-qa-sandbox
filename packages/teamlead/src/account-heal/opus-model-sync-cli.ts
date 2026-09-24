#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { storeOpusModelSyncDisabled } from "../bridge/flag-store-runtime.js";
import type { StateStore } from "../StateStore.js";
import {
	defaultAuthorityPath,
	defaultStatePath,
	type OpusAlert,
	observeAndAlert,
	type SyncOpusModelAuthorityOptions,
	type SyncOpusModelAuthorityResult,
	syncOpusModelAuthority,
} from "./opus-model-sync.js";

interface OpusModelSyncCliDeps {
	argv?: string[];
	env?: Record<string, string | undefined>;
	/** Test seam for the `opus_model_sync_disabled` store read. */
	readDisabled?: (dbPath: string | undefined) => boolean;
	sync?: (
		opts: SyncOpusModelAuthorityOptions,
	) => Promise<SyncOpusModelAuthorityResult>;
	deliver?: (alert: OpusAlert) => void;
	log?: (message: string) => void;
	warn?: (message: string) => void;
}

/** Reasons an operator should see; probe/cooldown outcomes are routine. */
const OPERATOR_WARNING_REASONS = new Set<
	SyncOpusModelAuthorityResult["reason"]
>([
	"cli_missing",
	"cli_auth_unavailable",
	"cli_pair_mismatch",
	"cli_rejected",
	"unsafe_authority",
	"invalid_authority",
	"write_failed",
	"verification_failed",
	"rollback_failed",
	"state_unwritable",
]);

function option(argv: string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	if (index < 0) return undefined;
	const value = argv[index + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`${name} requires a value`);
	return value;
}

/**
 * The `opus_model_sync_disabled` kill switch, read through the managed flag
 * store with a read-only teamlead.db handle (the lead_token_savings launch
 * reader pattern — no second switch channel). A MISSING row (a store Bridge
 * has not seeded yet) or an UNREADABLE store both fail closed: the sync is
 * treated as disabled — an emergency stop that cannot be read must not be
 * assumed off. Bridge seeds the row at startup, so a deploy restarts Bridge
 * before the first sync.
 */
export function readOpusModelSyncDisabled(
	dbPath = process.env.TEAMLEAD_DB_PATH ||
		join(homedir(), ".flywheel", "teamlead.db"),
	warn: (message: string) => void = console.warn,
): boolean {
	let db: Database.Database | undefined;
	try {
		db = new Database(dbPath, {
			readonly: true,
			fileMustExist: true,
			timeout: 1000,
		});
		const query = db.prepare(
			"SELECT has_override, raw_value FROM flag_values WHERE flag_name = ? AND scope = '*'",
		);
		const store = {
			getFlagValueRow(name: string) {
				const row = query.get(name) as
					| { has_override: number; raw_value: string | null }
					| undefined;
				return row
					? { hasOverride: row.has_override === 1, raw: row.raw_value }
					: undefined;
			},
		} as unknown as StateStore;
		return storeOpusModelSyncDisabled({ mode: "ready", store });
	} catch (error) {
		warn(
			`[opus-model-sync] kill switch unreadable; treating the sync as disabled: ${error instanceof Error ? error.message : String(error)}`,
		);
		return true;
	} finally {
		db?.close();
	}
}

/**
 * One exclusive lock for the whole CLI run (O_EXCL file holding the pid; a
 * dead holder is stale and reclaimed once). With it, two runs never observe
 * or write the state concurrently, so the state needs no compare-and-set.
 */
export function acquireRunLock(
	lockPath: string,
): "acquired" | "busy" | "unavailable" {
	try {
		mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
	} catch {
		return "unavailable"; // e.g. a path component is a file
	}
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			const fd = openSync(lockPath, "wx", 0o600);
			try {
				writeSync(fd, String(process.pid));
			} finally {
				closeSync(fd);
			}
			return "acquired";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				return "unavailable";
			}
		}
		if (!lockHolderIsDead(lockPath)) return "busy";
		try {
			unlinkSync(lockPath);
		} catch {
			// Another run reclaimed it first; the retry decides.
		}
	}
	return "busy";
}

function lockHolderIsDead(lockPath: string): boolean {
	let pid: number;
	try {
		pid = Number(readFileSync(lockPath, "utf8").trim());
	} catch {
		return false; // vanished or unreadable: let the retry decide
	}
	if (!Number.isInteger(pid) || pid <= 0) return true;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

export function releaseRunLock(lockPath: string): void {
	try {
		if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
			unlinkSync(lockPath);
		}
	} catch {
		// Already gone.
	}
}

/** Deliver one alert through the shared Lead alert script. */
export function deliverViaLeadAlert(
	notification: OpusAlert,
	deps: { alertBin?: string; execFile?: typeof execFileSync } = {},
): void {
	const alertBin =
		deps.alertBin ??
		process.env.FLYWHEEL_LEAD_ALERT_BIN ??
		join(homedir(), ".flywheel", "bin", "lead-alert.sh");
	(deps.execFile ?? execFileSync)(
		alertBin,
		[
			"--project",
			"flywheel",
			"--lead",
			"updater",
			"--kind",
			notification.kind,
			"--severity",
			notification.severity,
			"--title",
			notification.title,
			"--body",
			notification.body,
			"--signature",
			notification.signature,
		],
		{ stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 },
	);
}

/**
 * Updater-safe entry: every outcome is advisory to the deploy shuttle (exit 0).
 * Alerts are derived from the authority on EVERY run — before the kill switch
 * and after the sync — so an alert that failed to deliver (or a change made
 * while the sync was disabled, or by another writer) is announced by the next
 * run, and a repeat is deduplicated by its signature.
 */
export async function runOpusModelSyncCli(
	deps: OpusModelSyncCliDeps = {},
): Promise<number> {
	const log = deps.log ?? console.log;
	const warn = deps.warn ?? console.warn;
	const env = deps.env ?? process.env;
	try {
		const argv = deps.argv ?? process.argv.slice(2);
		const authorityPath = option(argv, "--authority") ?? defaultAuthorityPath();
		const statePath = option(argv, "--state") ?? defaultStatePath();
		const alertBin = option(argv, "--alert-bin");
		const dbPath = option(argv, "--db");
		const deliver =
			deps.deliver ??
			((alert: OpusAlert) =>
				deliverViaLeadAlert(alert, alertBin ? { alertBin } : {}));
		const lockPath = `${statePath}.lock`;
		const lock = acquireRunLock(lockPath);
		if (lock === "busy") {
			log(JSON.stringify({ status: "retained", reason: "sync_in_progress" }));
			return 0;
		}
		try {
			return await runLocked(lock === "acquired");
		} finally {
			if (lock === "acquired") releaseRunLock(lockPath);
		}
		async function runLocked(locked: boolean): Promise<number> {
			const observe = (announce = true): boolean => {
				try {
					const { failed, stateWritable } = observeAndAlert({
						authorityPath,
						statePath,
						deliver,
						log: warn,
						announce,
					});
					for (const alert of failed) {
						warn(
							`[opus-model-sync] could not deliver ${alert.signature}; the next run derives it again`,
						);
					}
					return stateWritable;
				} catch (error) {
					warn(
						`[opus-model-sync] authority observation failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					return false;
				}
			};
			// A move this run could not record could never be announced: without
			// a writable state file (or the run lock) the authority is left alone.
			if (!observe() || !locked) {
				log(JSON.stringify({ status: "retained", reason: "state_unwritable" }));
				warn("[opus-model-sync] authority retained: state_unwritable");
				return 0;
			}
			const disabled = (
				deps.readDisabled ??
				((path: string | undefined) => readOpusModelSyncDisabled(path))
			)(dbPath);
			if (disabled) {
				log(JSON.stringify({ status: "retained", reason: "disabled" }));
				warn(
					"[opus-model-sync] disabled by the opus_model_sync_disabled flag; Opus authority left unchanged",
				);
				return 0;
			}
			const result = await (deps.sync ?? syncOpusModelAuthority)({
				authorityPath,
				statePath,
				...(env.FLYWHEEL_CLAUDE_BIN
					? { claudeBin: env.FLYWHEEL_CLAUDE_BIN }
					: {}),
			});
			log(JSON.stringify(result));
			if (result.alert) {
				try {
					deliver(result.alert);
				} catch {
					warn(
						`[opus-model-sync] could not deliver ${result.alert.signature}: ${result.alert.title}`,
					);
				}
			}
			if (
				result.status === "retained" &&
				result.reason !== undefined &&
				OPERATOR_WARNING_REASONS.has(result.reason)
			) {
				warn(`[opus-model-sync] authority retained: ${result.reason}`);
			}
			// An unrecorded rollback failure leaves an unverified authority that
			// no marker guards: announce nothing from it in this run.
			observe(result.alert === undefined);
			return 0;
		}
	} catch {
		warn("[opus-model-sync] probe failed; retained current authority");
	}
	return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	runOpusModelSyncCli().then((code) => process.exit(code));
}
