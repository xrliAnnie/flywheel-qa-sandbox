import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	chownSync,
	closeSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { withSyncOpMarker } from "flywheel-claude-runner";
import { getModelConfigSnapshot } from "flywheel-config";
import type {
	ManagedValue,
	ModelSelection,
	WeeklySchedule,
} from "./management-console-contract.js";
import type { CronSourceTarget } from "./management-cron-source.js";

interface CronWriterStat {
	isFile(): boolean;
	isSymbolicLink(): boolean;
	uid: number;
	gid: number;
	mode: number;
	mtimeMs?: number;
}

export interface ManagementCronWriterIo {
	lstat(path: string): CronWriterStat;
	realpath(path: string): string;
	readFile(path: string): Buffer;
	open(path: string, flags: string, mode?: number): number;
	write(fd: number, data: Uint8Array | string): number;
	fsync(fd: number): void;
	close(fd: number): void;
	rename(from: string, to: string): void;
	unlink(path: string): void;
	chmod(path: string, mode: number): void;
	chown(path: string, uid: number, gid: number): void;
	execFile(file: string, args: readonly string[]): string;
	randomId(): string;
	processAlive(pid: number): boolean;
	now(): number;
}

const DEFAULT_IO: ManagementCronWriterIo = {
	lstat: (path) => lstatSync(path),
	realpath: (path) => realpathSync(path),
	readFile: (path) => readFileSync(path),
	open: (path, flags, mode) => openSync(path, flags, mode),
	write: (fd, data) =>
		typeof data === "string" ? writeSync(fd, data) : writeSync(fd, data),
	fsync: (fd) => fsyncSync(fd),
	close: (fd) => closeSync(fd),
	rename: (from, to) => renameSync(from, to),
	unlink: (path) => unlinkSync(path),
	chmod: (path, mode) => chmodSync(path, mode),
	chown: (path, uid, gid) => chownSync(path, uid, gid),
	execFile: (file, args) =>
		withSyncOpMarker("management-cron-writer:exec", () =>
			execFileSync(file, [...args], {
				encoding: "utf8",
				timeout: 10_000,
				killSignal: "SIGKILL",
			}),
		),
	randomId: () => randomUUID(),
	processAlive: (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	},
	now: () => Date.now(),
};

const STALE_LOCK_MS = 5 * 60_000;

export type CronChangeField = "schedule" | "enabled" | "model";

export interface CronStageRequest {
	targetId: string;
	desiredValue: unknown;
	observedRevision: string;
}

export interface StagedCronChange {
	targetId: string;
	field: CronChangeField;
	oldValue: unknown;
	newValue: unknown;
	observedRevision: string;
	fileSha: string;
	priorRuntime: { enabled: boolean; loaded: boolean | null };
	label: string;
	path: string;
	canonicalPath: string;
	oldBytes: Buffer;
	nextPlist: Record<string, unknown>;
	fileMode: number;
	fileUid: number;
	fileGid: number;
}

export type CronStageResult =
	| { status: "staged"; change: StagedCronChange }
	| { status: "no_op" }
	| { status: "rejected"; reason: string };

export type CronApplyResult =
	| { status: "applied" }
	| { status: "no_op" }
	| { status: "rejected"; reason: string }
	| { status: "rolled_back"; error: string }
	| { status: "partial"; error: string; rollbackError: string };

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

function labelForDays(days: readonly number[]): WeeklySchedule["label"] {
	const key = days.join(",");
	if (key === "1,2,3,4,5,6,7") return "每日";
	if (key === "1,2,3,4,5") return "工作日";
	if (key === "6,7") return "周末";
	return "自定义";
}

function canonicalSchedule(value: unknown): WeeklySchedule {
	const raw = object(value);
	if (!raw || !Array.isArray(raw.days) || !Array.isArray(raw.times)) {
		throw new Error("weekly schedule must contain days and times arrays");
	}
	const days = [...new Set(raw.days)]
		.map((day) => {
			if (typeof day !== "number") {
				throw new Error("weekly schedule day must be a number");
			}
			return day;
		})
		.sort((a, b) => a - b);
	if (
		days.length === 0 ||
		days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
	) {
		throw new Error("weekly schedule days must be non-empty integers 1..7");
	}
	const timesByKey = new Map<string, { hour: number; minute: number }>();
	for (const rawTime of raw.times) {
		const time = object(rawTime);
		const hour = time?.hour;
		const minute = time?.minute;
		if (
			typeof hour !== "number" ||
			!Number.isInteger(hour) ||
			hour < 0 ||
			hour > 23 ||
			typeof minute !== "number" ||
			!Number.isInteger(minute) ||
			minute < 0 ||
			minute > 59
		) {
			throw new Error("weekly schedule time is outside the valid range");
		}
		timesByKey.set(`${hour}:${minute}`, { hour, minute });
	}
	const times = [...timesByKey.values()].sort(
		(a, b) => a.hour - b.hour || a.minute - b.minute,
	);
	if (times.length === 0)
		throw new Error("weekly schedule times must be non-empty");
	return { days, times, label: labelForDays(days) };
}

function calendarTable(
	schedule: WeeklySchedule,
): Array<Record<string, number>> {
	return schedule.days.flatMap((Weekday) =>
		schedule.times.map(({ hour: Hour, minute: Minute }) => ({
			Weekday,
			Hour,
			Minute,
		})),
	);
}

function disabledLabels(output: string): Set<string> {
	const result = new Set<string>();
	for (const line of output.split("\n")) {
		const match = /"([^"]+)"\s*=>\s*true/.exec(line);
		if (match) result.add(match[1]!);
	}
	return result;
}

function inside(root: string, candidate: string): boolean {
	const rest = relative(root, candidate);
	return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

function targetField(
	target: CronSourceTarget,
	targetId: string,
): { field: CronChangeField; managed: ManagedValue<unknown> } | null {
	if (target.view.schedule.targetId === targetId) {
		return { field: "schedule", managed: target.view.schedule };
	}
	if (target.view.enabled.targetId === targetId) {
		return { field: "enabled", managed: target.view.enabled };
	}
	if (target.view.model?.targetId === targetId) {
		return { field: "model", managed: target.view.model };
	}
	return null;
}

function safeUnlink(io: ManagementCronWriterIo, path: string): void {
	try {
		io.unlink(path);
	} catch {
		// Best effort for a temp/lock that may already have moved.
	}
}

function safeDiagnostic(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(
		/(^|[\s("'=])\/[^\s)"'=]+/g,
		(_match, prefix: string) => `${prefix}<path>`,
	);
}

export class ManagementCronWriter {
	private readonly io: ManagementCronWriterIo;
	private readonly launchAgentsDir: string;

	constructor(
		private readonly options: {
			launchAgentsDir: string;
			uid: number;
			targets(): readonly CronSourceTarget[];
			deps?: Partial<ManagementCronWriterIo>;
		},
	) {
		this.io = { ...DEFAULT_IO, ...options.deps };
		// The directory is optional on macOS. Resolve it lazily during an actual
		// target write so an absent LaunchAgents folder degrades only the cron source.
		this.launchAgentsDir = resolve(options.launchAgentsDir);
	}

	private managedRoot(): string {
		return this.io.realpath(this.launchAgentsDir);
	}

	stage(request: CronStageRequest): CronStageResult {
		const allowed = ["targetId", "desiredValue", "observedRevision"];
		if (Object.keys(request as object).some((key) => !allowed.includes(key))) {
			return { status: "rejected", reason: "unknown stage request key" };
		}
		const resolved = this.options
			.targets()
			.map((target) => ({
				target,
				match: targetField(target, request.targetId),
			}))
			.find((candidate) => candidate.match !== null);
		if (!resolved?.match) {
			return { status: "rejected", reason: "cron target not found" };
		}
		const { target, match } = resolved;
		if (!match.managed.writeCapability.writable) {
			return {
				status: "rejected",
				reason:
					match.managed.writeCapability.reason ?? "cron target is read-only",
			};
		}
		if (request.observedRevision !== match.managed.source.revision) {
			return { status: "rejected", reason: "observed revision is stale" };
		}

		let stat: CronWriterStat;
		let canonicalPath: string;
		let bytes: Buffer;
		let plist: Record<string, unknown>;
		try {
			stat = this.io.lstat(target.path);
			if (stat.isSymbolicLink() || !stat.isFile()) {
				throw new Error("cron plist must be a regular non-symlink file");
			}
			if (stat.uid !== this.options.uid) {
				throw new Error("cron plist uid does not match launchd domain uid");
			}
			canonicalPath = this.io.realpath(target.path);
			if (
				canonicalPath !== target.canonicalPath ||
				!inside(this.managedRoot(), canonicalPath)
			) {
				throw new Error(
					"cron plist escapes the managed LaunchAgents directory",
				);
			}
			bytes = this.io.readFile(target.path);
			if (sha256(bytes) !== target.fileSha) {
				throw new Error("cron plist SHA drifted since discovery");
			}
			const parsed = object(
				JSON.parse(
					this.io.execFile("plutil", [
						"-convert",
						"json",
						"-o",
						"-",
						target.path,
					]),
				),
			);
			if (!parsed) throw new Error("cron plist root is not a dictionary");
			if (
				parsed.Label !== target.label ||
				!/^[A-Za-z0-9._-]+$/.test(target.label)
			) {
				throw new Error("cron plist Label mismatch or unsafe Label");
			}
			plist = parsed;
		} catch (error) {
			return {
				status: "rejected",
				reason: safeDiagnostic(error),
			};
		}

		const nextPlist = structuredClone(plist);
		let oldValue: unknown;
		let newValue: unknown;
		try {
			if (match.field === "schedule") {
				oldValue = target.view.schedule.current;
				const schedule = canonicalSchedule(request.desiredValue);
				newValue = schedule;
				nextPlist.StartCalendarInterval = calendarTable(schedule);
			} else if (match.field === "enabled") {
				if (typeof request.desiredValue !== "boolean") {
					throw new Error("enabled value must be boolean");
				}
				oldValue = target.view.enabled.current;
				newValue = request.desiredValue;
			} else {
				oldValue = target.view.model?.current ?? null;
				const desired = request.desiredValue;
				if (!object(desired))
					throw new Error("model selection must be an object");
				const selection = desired as unknown as ModelSelection;
				// Capture one hot-config generation for lookup, support, and
				// canonicalization. The next stage request may see a replacement.
				const modelSnapshot = getModelConfigSnapshot();
				const registered = modelSnapshot.getModelRegistryEntry(selection.model);
				if (
					!registered ||
					registered.provider !== selection.provider ||
					!modelSnapshot.isModelSelectionSupported({
						surface: "cron",
						model: selection.model,
						effort: selection.effort ?? undefined,
					})
				) {
					throw new Error("cron model selection is not supported");
				}
				if (target.modelArgumentIndex === null) {
					throw new Error("cron has no typed writable model carrier");
				}
				const args = nextPlist.ProgramArguments;
				if (
					!Array.isArray(args) ||
					args[target.modelArgumentIndex] !== "--model"
				) {
					throw new Error("cron model carrier drifted");
				}
				args[target.modelArgumentIndex + 1] = registered.id;
				newValue = {
					provider: registered.provider,
					model: registered.id,
					effort: selection.effort ?? null,
				};
			}
		} catch (error) {
			return {
				status: "rejected",
				reason: safeDiagnostic(error),
			};
		}
		if (sameValue(oldValue, newValue)) return { status: "no_op" };
		return {
			status: "staged",
			change: {
				targetId: request.targetId,
				field: match.field,
				oldValue,
				newValue,
				observedRevision: request.observedRevision,
				fileSha: target.fileSha,
				priorRuntime: {
					enabled: target.view.enabled.current === true,
					loaded: target.view.loaded,
				},
				label: target.label,
				path: target.path,
				canonicalPath,
				oldBytes: bytes,
				nextPlist,
				fileMode: stat.mode & 0o777,
				fileUid: stat.uid,
				fileGid: stat.gid,
			},
		};
	}

	private launchctl(action: string, ...args: string[]): string {
		return this.io.execFile("launchctl", [action, ...args]);
	}

	private isDisabled(label: string): boolean {
		return disabledLabels(
			this.launchctl("print-disabled", `gui/${this.options.uid}`),
		).has(label);
	}

	private isLoaded(label: string): boolean {
		try {
			this.launchctl("print", `gui/${this.options.uid}/${label}`);
			return true;
		} catch {
			return false;
		}
	}

	private verifyRuntime(
		label: string,
		enabled: boolean,
		loaded: boolean,
	): void {
		if (this.isDisabled(label) === enabled) {
			throw new Error("launchctl disabled override verification failed");
		}
		if (this.isLoaded(label) !== loaded) {
			throw new Error("launchctl loaded-state verification failed");
		}
	}

	private setRuntime(
		change: StagedCronChange,
		desired: { enabled: boolean; loaded: boolean },
	): void {
		const service = `gui/${this.options.uid}/${change.label}`;
		if (this.isLoaded(change.label) && !desired.loaded) {
			this.launchctl("bootout", service);
		}
		if (desired.enabled) {
			this.launchctl("enable", service);
			if (desired.loaded && !this.isLoaded(change.label)) {
				this.launchctl("bootstrap", `gui/${this.options.uid}`, change.path);
			}
		} else {
			this.launchctl("disable", service);
		}
		this.verifyRuntime(change.label, desired.enabled, desired.loaded);
	}

	private writeTemp(
		change: StagedCronChange,
		bytes: Uint8Array | string,
		suffix: string,
	): string {
		const temp = join(
			dirname(change.path),
			`.${basename(change.path)}.${suffix}.${this.io.randomId()}`,
		);
		const fd = this.io.open(temp, "wx", change.fileMode || 0o600);
		try {
			this.io.write(fd, bytes);
			this.io.fsync(fd);
		} finally {
			this.io.close(fd);
		}
		this.io.chmod(temp, change.fileMode || 0o600);
		this.io.chown(temp, change.fileUid, change.fileGid);
		return temp;
	}

	private fsyncPath(path: string): void {
		const fd = this.io.open(path, "r");
		try {
			this.io.fsync(fd);
		} finally {
			this.io.close(fd);
		}
	}

	private restore(change: StagedCronChange): void {
		if (this.isLoaded(change.label)) {
			this.launchctl("bootout", `gui/${this.options.uid}/${change.label}`);
		}
		const restore = this.writeTemp(change, change.oldBytes, "restore");
		try {
			this.io.rename(restore, change.path);
		} finally {
			safeUnlink(this.io, restore);
		}
		this.setRuntime(change, {
			enabled: change.priorRuntime.enabled,
			loaded: change.priorRuntime.loaded === true,
		});
	}

	private openApplyLock(path: string): number {
		let fd: number;
		try {
			fd = this.io.open(path, "wx", 0o600);
		} catch (firstError) {
			let reclaim = false;
			try {
				const stat = this.io.lstat(path);
				const rawPid = Number.parseInt(
					this.io.readFile(path).toString("utf8"),
					10,
				);
				if (Number.isInteger(rawPid) && rawPid > 0) {
					reclaim = !this.io.processAlive(rawPid);
				} else if (typeof stat.mtimeMs === "number") {
					reclaim = this.io.now() - stat.mtimeMs >= STALE_LOCK_MS;
				}
			} catch {
				// Preserve the original exclusive-open failure when evidence is unclear.
			}
			if (!reclaim) throw firstError;
			this.io.unlink(path);
			fd = this.io.open(path, "wx", 0o600);
		}
		try {
			this.io.write(fd, `${process.pid}\n`);
			this.io.fsync(fd);
			return fd;
		} catch (error) {
			try {
				this.io.close(fd);
			} finally {
				safeUnlink(this.io, path);
			}
			throw error;
		}
	}

	apply(change: StagedCronChange): CronApplyResult {
		const current = this.options
			.targets()
			.find((target) => targetField(target, change.targetId) !== null);
		if (
			!current ||
			current.path !== change.path ||
			current.canonicalPath !== change.canonicalPath
		) {
			return { status: "rejected", reason: "cron target authority changed" };
		}
		const lock = `${change.path}.flywheel.lock`;
		let lockFd: number;
		try {
			lockFd = this.openApplyLock(lock);
		} catch (error) {
			return {
				status: "rejected",
				reason: `cron writer lock unavailable: ${safeDiagnostic(error)}`,
			};
		}
		let candidate: string | undefined;
		let renamed = false;
		let runtimeChanged = false;
		try {
			const stat = this.io.lstat(change.path);
			if (
				stat.isSymbolicLink() ||
				!stat.isFile() ||
				stat.uid !== this.options.uid ||
				this.io.realpath(change.path) !== change.canonicalPath ||
				!inside(this.managedRoot(), change.canonicalPath)
			) {
				return { status: "rejected", reason: "cron plist safety check failed" };
			}
			if (sha256(this.io.readFile(change.path)) !== change.fileSha) {
				return {
					status: "rejected",
					reason: "cron plist SHA drifted before apply",
				};
			}

			if (change.field !== "enabled") {
				candidate = this.writeTemp(
					change,
					`${JSON.stringify(change.nextPlist, null, 2)}\n`,
					"candidate",
				);
				try {
					this.io.execFile("plutil", ["-convert", "xml1", candidate]);
					this.io.execFile("plutil", ["-lint", candidate]);
					this.io.chmod(candidate, change.fileMode || 0o600);
					this.io.chown(candidate, change.fileUid, change.fileGid);
					this.fsyncPath(candidate);
				} catch (error) {
					return {
						status: "rejected",
						reason: `plist render/lint failed: ${safeDiagnostic(error)}`,
					};
				}
			}

			try {
				if (change.field === "enabled") {
					const enabled = change.newValue as boolean;
					if (!enabled && change.priorRuntime.loaded) {
						this.launchctl(
							"bootout",
							`gui/${this.options.uid}/${change.label}`,
						);
					}
					if (enabled) {
						this.launchctl("enable", `gui/${this.options.uid}/${change.label}`);
						if (!change.priorRuntime.loaded) {
							this.launchctl(
								"bootstrap",
								`gui/${this.options.uid}`,
								change.path,
							);
						}
					} else {
						this.launchctl(
							"disable",
							`gui/${this.options.uid}/${change.label}`,
						);
					}
					this.verifyRuntime(change.label, enabled, enabled);
				} else {
					if (change.priorRuntime.loaded) {
						this.launchctl(
							"bootout",
							`gui/${this.options.uid}/${change.label}`,
						);
						runtimeChanged = true;
					}
					this.io.rename(candidate!, change.path);
					renamed = true;
					candidate = undefined;
					if (change.priorRuntime.enabled) {
						this.launchctl("enable", `gui/${this.options.uid}/${change.label}`);
						this.launchctl("bootstrap", `gui/${this.options.uid}`, change.path);
						this.verifyRuntime(change.label, true, true);
					} else {
						this.launchctl(
							"disable",
							`gui/${this.options.uid}/${change.label}`,
						);
						this.verifyRuntime(change.label, false, false);
					}
				}
				return { status: "applied" };
			} catch (error) {
				const message = safeDiagnostic(error);
				if (!renamed && !runtimeChanged && change.field !== "enabled") {
					return { status: "rejected", reason: message };
				}
				try {
					this.restore(change);
					return { status: "rolled_back", error: message };
				} catch (rollbackError) {
					return {
						status: "partial",
						error: message,
						rollbackError: safeDiagnostic(rollbackError),
					};
				}
			}
		} finally {
			if (candidate) safeUnlink(this.io, candidate);
			try {
				this.io.close(lockFd);
			} catch {
				// The exclusive file is the authority; cleanup must not be skipped.
			} finally {
				safeUnlink(this.io, lock);
			}
		}
	}
}
