/**
 * FLY-1182 Task 7.7 — restart-safe Claude account-pool rebuild transaction.
 *
 * This module deliberately separates the reviewed state machine from launchd
 * and OAuth process plumbing. Production supplies those operations through
 * PoolRebuildRuntime; tests inject deterministic crash/failure points.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type AccountStore, readStore } from "./account-store.js";
import { resolveMachineAccount } from "./machine-account.js";
import { withMkdirLock } from "./mkdir-lock.js";
import {
	DEFAULT_QUOTA_MONITOR_CONFIG,
	type QuotaMonitorConfig,
} from "./quota-monitor-config.js";
import type { QuotaMonitorState } from "./quota-monitor-state.js";

export const CANONICAL_POOL_IDENTITIES = {
	business: "xrliannie.b@gmail.com",
	personal: "xrliannie@gmail.com",
	personal1: "xrliannie.1@gmail.com",
	school: "xiaorongli2011@u.northwestern.edu",
	shopping: "xrliannie.shopping@gmail.com",
} as const;

const SLOT_NAMES = Object.keys(CANONICAL_POOL_IDENTITIES) as Array<
	keyof typeof CANONICAL_POOL_IDENTITIES
>;

export const POOL_REBUILD_STAGES = [
	"frozen",
	"mapped",
	"slots_rebuilding",
	"slots_rebuilt",
	"display_synced",
	"store_committed",
	"state_aligned",
	"awaiting_1252",
	"promoting_enabled",
	"restored_enabled",
	"aborted_monitor_only",
	"recovery_required",
] as const;

export type PoolRebuildStage = (typeof POOL_REBUILD_STAGES)[number];
type DaemonMode = "monitor" | "enabled";

export interface PoolRebuildPaths {
	journal: string;
	journalLock: string;
	config: string;
	configPreimage: string;
	identityMap: string;
	poolDir: string;
	active: string;
	claudeJson: string;
	claudeJsonLock: string;
	store: string;
	state: string;
	accountsLock: string;
}

export interface PoolRebuildHealthPolicy {
	allowIdentityConflict?: boolean;
}

export interface PoolRebuildRuntime {
	now: () => number;
	processIdentity: () => { pid: number; startTime: string };
	isProcessIdentityAlive: (pid: number, startTime: string) => boolean;
	/** True only when no older rebuild process can still publish a torn claim. */
	canRecoverTornClaim: (claimPath: string) => boolean;
	/** Config is already monitor-only. Gracefully drain the old PID and await KeepAlive. */
	gracefulFreeze: (expectedConfigSha256: string) => Promise<void>;
	/** Remove the launchd job and prove old PID/run marker are gone. */
	bootout: () => Promise<void>;
	/** Independent last-resort stop used only when launchctl bootout cannot prove exit. */
	emergencyStop: () => Promise<void>;
	bootstrap: (mode: DaemonMode) => Promise<void>;
	assertHealthy: (
		mode: DaemonMode,
		expectedConfigSha256: string,
		expectedRuntimeSha256?: string,
		policy?: PoolRebuildHealthPolicy,
	) => Promise<void>;
	isDaemonRunning: () => Promise<boolean>;
	inspectDaemonMode: () => DaemonMode | "stopped" | "unknown";
	verifyProfile: (name: string, source: "pool" | "keychain") => Promise<void>;
	verifyFly1252: (reviewedSha: string, evidencePath: string) => Promise<string>;
	/** Test-only crash/failure seam; production uses a no-op. */
	checkpoint?: (name: string) => void;
}

interface IdentityMapArtifact {
	version: 1;
	artifactId: string;
	confirmedAt: string;
	labels: typeof CANONICAL_POOL_IDENTITIES;
}

interface PoolRebuildJournal {
	version: 1;
	stage: PoolRebuildStage;
	recoveryFrom: PoolRebuildStage | null;
	createdAt: string;
	updatedAt: string;
	freezeAckAt: string | null;
	owner: { pid: number; startTime: string };
	preGeneration: number;
	targetGeneration: number;
	finalActive: string;
	slotOrder: string[];
	slots: Record<
		string,
		{ status: "pending" | "verified"; verifiedAt: string | null }
	>;
	config: {
		preimagePath: string;
		preimageSha256: string;
		targetBytesBase64: string;
		targetSha256: string;
		enabledBytesBase64: string;
		enabledSha256: string;
		actualSha256: string | null;
	};
	identityMap: {
		artifactId: string;
		sha256: string;
		bytesBase64: string;
		evidencePath: string;
	};
	fly1252: {
		reviewedSha: string;
		evidencePath: string;
		runtimeTreeSha256: string;
	} | null;
}

export interface PoolRebuildStatus {
	stage: PoolRebuildStage;
	verifiedSlots: number;
	totalSlots: number;
	nextSlot: string | null;
	targetGeneration: number;
	finalActive: string;
	actualConfigSha256: string | null;
	consistent: boolean;
	errors: string[];
}

export class RebuildCrashError extends Error {
	constructor(point: string) {
		super(`simulated rebuild crash at ${point}`);
		this.name = "RebuildCrashError";
	}
}

function sha256(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function nowIso(runtime: PoolRebuildRuntime): string {
	return new Date(runtime.now()).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeUid(): number {
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("owner identity unavailable");
	return uid;
}

function assertSafeOwnedFile(path: string, modes = [0o600, 0o400]): void {
	const stat = lstatSync(path);
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.uid !== safeUid() ||
		!modes.includes(stat.mode & 0o777)
	) {
		throw new Error(`unsafe owner-only regular file: ${path}`);
	}
}

function assertSafeOwnedDirectory(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== safeUid()) {
		throw new Error(`unsafe same-owner directory: ${path}`);
	}
}

function readSafeBytes(path: string, modes = [0o600, 0o400]): Buffer {
	assertSafeOwnedFile(path, modes);
	return readFileSync(path);
}

function atomicWrite(
	path: string,
	bytes: Buffer | string,
	mode = 0o600,
	allowedExistingModes = [0o600, 0o400],
): void {
	if (existsSync(path)) assertSafeOwnedFile(path, allowedExistingModes);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	assertSafeOwnedDirectory(dirname(path));
	const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
	let fd: number | undefined;
	try {
		fd = openSync(
			tmp,
			constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
			mode,
		);
		const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
		if (writeSync(fd, data) !== data.length)
			throw new Error(`short write: ${path}`);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		chmodSync(tmp, mode);
		renameSync(tmp, path);
		const dirFd = openSync(dirname(path), constants.O_RDONLY);
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(tmp);
		} catch {
			// Best effort: never mask the original write/fsync/rename failure.
		}
	}
}

function configBytes(config: Record<string, unknown>): Buffer {
	return Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function parseQuotaConfig(
	bytes: Buffer,
): QuotaMonitorConfig & Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error("quota config is not JSON");
	}
	if (!isRecord(value) || !Array.isArray(value.order)) {
		throw new Error("quota config has invalid schema");
	}
	const order = value.order;
	const normalized: Record<string, unknown> = {
		...value,
		order,
		paneScanSeconds:
			value.paneScanSeconds ?? DEFAULT_QUOTA_MONITOR_CONFIG.paneScanSeconds,
		confirmDelayMinutes:
			value.confirmDelayMinutes ??
			DEFAULT_QUOTA_MONITOR_CONFIG.confirmDelayMinutes,
	};
	const numbers = [
		"trigger5hPct",
		"basePollMinutes",
		"acceleratePct",
		"acceleratedPollMinutes",
		"candidateSweepMinutes",
		"minSwitchIntervalMinutes",
		"paneScanSeconds",
		"confirmDelayMinutes",
	] as const;
	for (const key of numbers) {
		if (
			typeof normalized[key] !== "number" ||
			!Number.isFinite(normalized[key])
		) {
			throw new Error(`quota config has invalid ${key}`);
		}
	}
	if (
		typeof normalized.writeStatuslineCache !== "boolean" ||
		!order.every((name) => typeof name === "string") ||
		new Set(order).size !== order.length
	) {
		throw new Error("quota config has invalid order/statusline fields");
	}
	return normalized as QuotaMonitorConfig & Record<string, unknown>;
}

function parseIdentityMap(bytes: Buffer): IdentityMapArtifact {
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error("identity map is not JSON");
	}
	if (!isRecord(value)) throw new Error("identity map must be an object");
	const rootKeys = Object.keys(value).sort();
	if (rootKeys.join(",") !== "artifactId,confirmedAt,labels,version") {
		throw new Error("identity map root schema mismatch");
	}
	if (
		value.version !== 1 ||
		typeof value.artifactId !== "string" ||
		value.artifactId.length === 0 ||
		typeof value.confirmedAt !== "string" ||
		value.confirmedAt.length === 0 ||
		!isRecord(value.labels)
	) {
		throw new Error("identity map metadata is invalid");
	}
	if (
		Object.keys(value.labels).sort().join(",") !== SLOT_NAMES.sort().join(",")
	) {
		throw new Error(
			"identity map must contain exactly the five canonical labels",
		);
	}
	for (const [name, email] of Object.entries(CANONICAL_POOL_IDENTITIES)) {
		if (value.labels[name] !== email) {
			throw new Error(
				`identity map differs from canonical mapping for ${name}`,
			);
		}
	}
	return value as unknown as IdentityMapArtifact;
}

function parseJournal(bytes: Buffer): PoolRebuildJournal {
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error("rebuild journal is corrupt");
	}
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.stage !== "string" ||
		!POOL_REBUILD_STAGES.includes(value.stage as PoolRebuildStage) ||
		!isRecord(value.config) ||
		!isRecord(value.identityMap) ||
		!isRecord(value.slots) ||
		!Array.isArray(value.slotOrder) ||
		typeof value.targetGeneration !== "number" ||
		typeof value.finalActive !== "string"
	) {
		throw new Error("rebuild journal schema is invalid");
	}
	const journal = value as unknown as PoolRebuildJournal;
	if (
		!Number.isInteger(journal.preGeneration) ||
		journal.preGeneration < 0 ||
		journal.targetGeneration !== journal.preGeneration + 1 ||
		!sameSlots(journal.slotOrder) ||
		journal.slotOrder.at(-1) !== journal.finalActive ||
		Object.keys(journal.slots).length !== SLOT_NAMES.length ||
		!journal.slotOrder.every((name) => {
			const slot = journal.slots[name];
			return (
				slot !== undefined &&
				(slot.status === "pending" || slot.status === "verified") &&
				(slot.verifiedAt === null || typeof slot.verifiedAt === "string")
			);
		}) ||
		!(
			journal.recoveryFrom === null ||
			(typeof journal.recoveryFrom === "string" &&
				POOL_REBUILD_STAGES.includes(journal.recoveryFrom))
		) ||
		!(
			journal.freezeAckAt === null || typeof journal.freezeAckAt === "string"
		) ||
		!journal.config.preimagePath.startsWith("/") ||
		!journal.identityMap.evidencePath.startsWith("/") ||
		(journal.fly1252 !== null &&
			(typeof journal.fly1252.reviewedSha !== "string" ||
				typeof journal.fly1252.evidencePath !== "string" ||
				!/^([a-f0-9]{64})$/.test(journal.fly1252.runtimeTreeSha256)))
	) {
		throw new Error("rebuild journal invariants are invalid");
	}
	const decode = (encoded: string, label: string): Buffer => {
		if (typeof encoded !== "string") throw new Error(`${label} is missing`);
		const decoded = Buffer.from(encoded, "base64");
		if (decoded.toString("base64") !== encoded) {
			throw new Error(`${label} is not canonical base64`);
		}
		return decoded;
	};
	const targetBytes = decode(journal.config.targetBytesBase64, "target config");
	const enabledBytes = decode(
		journal.config.enabledBytesBase64,
		"enabled config",
	);
	const mapBytes = decode(journal.identityMap.bytesBase64, "identity map");
	const target = parseQuotaConfig(targetBytes);
	const enabled = parseQuotaConfig(enabledBytes);
	const map = parseIdentityMap(mapBytes);
	if (
		sha256(targetBytes) !== journal.config.targetSha256 ||
		sha256(enabledBytes) !== journal.config.enabledSha256 ||
		sha256(mapBytes) !== journal.identityMap.sha256 ||
		target.order.length !== 0 ||
		target.trigger5hPct !== 100 ||
		!sameSlots(enabled.order) ||
		enabled.trigger5hPct !== 90 ||
		map.artifactId !== journal.identityMap.artifactId
	) {
		throw new Error("rebuild journal embedded artifact mismatch");
	}
	return journal;
}

function readJournal(path: string): PoolRebuildJournal {
	return parseJournal(readSafeBytes(path, [0o600]));
}

function writeJournal(
	path: string,
	journal: PoolRebuildJournal,
	runtime: PoolRebuildRuntime,
): void {
	journal.updatedAt = nowIso(runtime);
	journal.owner = runtime.processIdentity();
	atomicWrite(path, `${JSON.stringify(journal, null, 2)}\n`);
}

function sameSlots(values: readonly string[]): boolean {
	return (
		values.length === SLOT_NAMES.length &&
		new Set(values).size === SLOT_NAMES.length &&
		SLOT_NAMES.every((name) => values.includes(name))
	);
}

function currentSha(path: string, modes = [0o600, 0o400]): string | null {
	try {
		return sha256(readSafeBytes(path, modes));
	} catch {
		return null;
	}
}

export class ClaudePoolRebuild {
	constructor(
		private readonly paths: PoolRebuildPaths,
		private readonly runtime: PoolRebuildRuntime,
	) {}

	private checkpoint(name: string): void {
		this.runtime.checkpoint?.(name);
	}

	private async withClaim<T>(fn: () => Promise<T>): Promise<T> {
		const identity = this.runtime.processIdentity();
		mkdirSync(dirname(this.paths.journalLock), {
			recursive: true,
			mode: 0o700,
		});
		assertSafeOwnedDirectory(dirname(this.paths.journalLock));
		try {
			mkdirSync(this.paths.journalLock, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		assertSafeOwnedDirectory(this.paths.journalLock);
		if ((lstatSync(this.paths.journalLock).mode & 0o777) !== 0o700) {
			throw new Error("unsafe rebuild lock directory mode");
		}

		type Owner = {
			version: 1;
			generation: number;
			token: string;
			pid: number;
			startTime: string;
			released: boolean;
		};
		const ownerPath = join(this.paths.journalLock, "owner.json");
		const readOwner = (): Owner | null => {
			if (!existsSync(ownerPath)) return null;
			assertSafeOwnedFile(ownerPath, [0o600]);
			const value = JSON.parse(readFileSync(ownerPath, "utf8")) as Owner;
			if (
				value.version !== 1 ||
				!Number.isInteger(value.generation) ||
				value.generation < 1 ||
				typeof value.token !== "string" ||
				!value.token ||
				!Number.isInteger(value.pid) ||
				value.pid < 1 ||
				typeof value.startTime !== "string" ||
				!value.startTime ||
				typeof value.released !== "boolean"
			) {
				throw new Error("unsafe rebuild owner record");
			}
			return value;
		};
		const initial = readOwner();
		if (
			initial !== null &&
			!initial.released &&
			this.runtime.isProcessIdentityAlive(initial.pid, initial.startTime)
		) {
			throw new Error(`rebuild already owned by pid ${initial.pid}`);
		}

		let generation = (initial?.generation ?? 0) + 1;
		let claimPath = "";
		const token = randomUUID();
		for (;;) {
			claimPath = join(this.paths.journalLock, `claim-${generation}.json`);
			const claimTmp = join(
				this.paths.journalLock,
				`.claim-${generation}.${token}.tmp`,
			);
			let fd: number | undefined;
			try {
				fd = openSync(
					claimTmp,
					constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
					0o600,
				);
				const claim = `${JSON.stringify({ version: 1, generation, token, ...identity, released: false })}\n`;
				if (writeSync(fd, claim) !== Buffer.byteLength(claim)) {
					throw new Error("short rebuild claim write");
				}
				fsyncSync(fd);
				closeSync(fd);
				fd = undefined;
				// Publish a fully-fsynced immutable claim in one namespace operation.
				// A crash can leave only the private temp, never a torn claim-N file.
				linkSync(claimTmp, claimPath);
				const dirFd = openSync(this.paths.journalLock, constants.O_RDONLY);
				try {
					fsyncSync(dirFd);
				} finally {
					closeSync(dirFd);
				}
				unlinkSync(claimTmp);
				break;
			} catch (error) {
				if (fd !== undefined) closeSync(fd);
				try {
					unlinkSync(claimTmp);
				} catch {
					// Missing temp is expected after successful publication cleanup.
				}
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				assertSafeOwnedFile(claimPath, [0o600]);
				let contender: {
					version?: number;
					generation?: number;
					token?: string;
					pid?: number;
					startTime?: string;
					released?: boolean;
				};
				try {
					contender = JSON.parse(readFileSync(claimPath, "utf8"));
				} catch {
					// Legacy versions could crash between O_EXCL and writing the
					// payload. Do not skip until production proves no old publisher
					// remains alive; otherwise mixed versions could both enter fn().
					if (!this.runtime.canRecoverTornClaim(claimPath)) {
						throw new Error(
							"legacy claim publisher may still be alive; recovery refused",
						);
					}
					generation++;
					continue;
				}
				if (
					contender.version !== 1 ||
					contender.generation !== generation ||
					typeof contender.token !== "string" ||
					!contender.token ||
					typeof contender.pid !== "number" ||
					typeof contender.startTime !== "string" ||
					typeof contender.released !== "boolean"
				) {
					if (!this.runtime.canRecoverTornClaim(claimPath)) {
						throw new Error(
							"legacy claim publisher may still be alive; recovery refused",
						);
					}
					generation++;
					continue;
				}
				if (
					!contender.released &&
					this.runtime.isProcessIdentityAlive(
						contender.pid,
						contender.startTime,
					)
				) {
					throw new Error("rebuild takeover already in progress");
				}
				generation++;
			}
		}
		const abandonClaim = (): void => {
			try {
				atomicWrite(
					claimPath,
					`${JSON.stringify({ version: 1, generation, token, ...identity, released: true })}\n`,
				);
			} catch {
				// The claim remains a fail-closed live-process fence if abandonment fails.
			}
		};

		const beforeCommit = readOwner();
		if (
			(initial === null && beforeCommit !== null) ||
			(initial !== null &&
				(beforeCommit === null ||
					beforeCommit.generation !== initial.generation ||
					beforeCommit.token !== initial.token ||
					(!beforeCommit.released &&
						this.runtime.isProcessIdentityAlive(
							beforeCommit.pid,
							beforeCommit.startTime,
						))))
		) {
			abandonClaim();
			throw new Error("rebuild ownership changed while claiming");
		}
		const held: Owner = {
			version: 1,
			generation,
			token,
			...identity,
			released: false,
		};
		try {
			atomicWrite(ownerPath, `${JSON.stringify(held)}\n`);
		} catch (error) {
			abandonClaim();
			throw error;
		}
		const committed = readOwner();
		if (committed?.token !== token || committed.generation !== generation) {
			abandonClaim();
			throw new Error("unable to commit rebuild ownership");
		}
		try {
			return await fn();
		} finally {
			try {
				const current = readOwner();
				if (current?.token === token && current.generation === generation) {
					atomicWrite(
						ownerPath,
						`${JSON.stringify({ ...current, released: true })}\n`,
					);
				}
			} catch {
				// Never overwrite a lock whose ownership changed or became ambiguous.
			}
		}
	}

	private writeStage(
		journal: PoolRebuildJournal,
		stage: PoolRebuildStage,
		recoveryFrom: PoolRebuildStage | null = null,
	): void {
		journal.stage = stage;
		journal.recoveryFrom = recoveryFrom;
		journal.config.actualSha256 = currentSha(
			this.paths.config,
			[0o600, 0o400, 0o644],
		);
		writeJournal(this.paths.journal, journal, this.runtime);
	}

	private assertConfigCas(expected: string): Buffer {
		const bytes = readSafeBytes(this.paths.config, [0o600, 0o400, 0o644]);
		const actual = sha256(bytes);
		if (actual !== expected) {
			throw new Error(
				`config CAS drift: expected ${expected}, observed ${actual}`,
			);
		}
		return bytes;
	}

	private writeConfigCas(expected: string, bytes: Buffer): void {
		this.assertConfigCas(expected);
		atomicWrite(this.paths.config, bytes, 0o600, [0o600, 0o400, 0o644]);
	}

	private async ensureFrozen(journal: PoolRebuildJournal): Promise<void> {
		const actual = currentSha(this.paths.config, [0o600, 0o400, 0o644]);
		if (actual === journal.config.preimageSha256) {
			this.writeConfigCas(
				journal.config.preimageSha256,
				Buffer.from(journal.config.targetBytesBase64, "base64"),
			);
		} else if (actual !== journal.config.targetSha256) {
			throw new Error("freeze recovery refused config drift");
		}
		if (journal.freezeAckAt === null) {
			await this.runtime.gracefulFreeze(journal.config.targetSha256);
			journal.freezeAckAt = nowIso(this.runtime);
			this.writeStage(journal, journal.stage);
			return;
		}
		if (!(await this.runtime.isDaemonRunning())) {
			await this.runtime.bootstrap("monitor");
		}
		await this.runtime.assertHealthy("monitor", journal.config.targetSha256);
	}

	async prepare(input: {
		finalActive: string;
		identityMapEvidence: string;
		enabledPreimage?: string;
	}): Promise<void> {
		await this.withClaim(async () => {
			if (existsSync(this.paths.journal)) {
				throw new Error("rebuild journal already exists; use status/resume");
			}
			if (
				!SLOT_NAMES.includes(
					input.finalActive as keyof typeof CANONICAL_POOL_IDENTITIES,
				)
			) {
				throw new Error("finalActive must be one of the five canonical slots");
			}
			if (!input.identityMapEvidence.startsWith("/")) {
				throw new Error("identity-map evidence path must be absolute");
			}
			if (input.enabledPreimage && !input.enabledPreimage.startsWith("/")) {
				throw new Error("enabled preimage path must be absolute");
			}
			const mapBytes = readSafeBytes(input.identityMapEvidence);
			const map = parseIdentityMap(mapBytes);
			const enabledSource = input.enabledPreimage ?? this.paths.config;
			const preimageBytes = readSafeBytes(enabledSource);
			const preimage = parseQuotaConfig(preimageBytes);
			if (!sameSlots(preimage.order)) {
				throw new Error(
					"enabled preimage must contain exactly the five canonical slots",
				);
			}
			const target = { ...preimage, trigger5hPct: 100, order: [] };
			const enabled = {
				...preimage,
				trigger5hPct: 90,
				order: [...preimage.order],
			};
			const targetBytes = configBytes(target);
			const enabledBytes = configBytes(enabled);
			const liveBytes = readSafeBytes(this.paths.config, [0o600, 0o400, 0o644]);
			const liveSha = sha256(liveBytes);
			const preimageSha = sha256(preimageBytes);
			const targetSha = sha256(targetBytes);
			const liveConfig = parseQuotaConfig(liveBytes);
			const liveIsTarget = stableJson(liveConfig) === stableJson(target);
			if (liveSha !== preimageSha && !liveIsTarget) {
				throw new Error(
					"live config is neither enabled preimage nor monitor-only target",
				);
			}
			readSafeBytes(this.paths.store);
			const store = readStore(this.paths.store);
			if (!Number.isInteger(store.generation) || store.generation < 0) {
				throw new Error("account store generation is invalid");
			}
			const identity = this.runtime.processIdentity();
			const slotOrder = [
				...SLOT_NAMES.filter((name) => name !== input.finalActive),
				input.finalActive,
			];
			const journal: PoolRebuildJournal = {
				version: 1,
				stage: "frozen",
				recoveryFrom: null,
				createdAt: nowIso(this.runtime),
				updatedAt: nowIso(this.runtime),
				freezeAckAt: null,
				owner: identity,
				preGeneration: store.generation,
				targetGeneration: store.generation + 1,
				finalActive: input.finalActive,
				slotOrder,
				slots: Object.fromEntries(
					slotOrder.map((name) => [
						name,
						{ status: "pending", verifiedAt: null },
					]),
				),
				config: {
					preimagePath: this.paths.configPreimage,
					preimageSha256: preimageSha,
					targetBytesBase64: targetBytes.toString("base64"),
					targetSha256: targetSha,
					enabledBytesBase64: enabledBytes.toString("base64"),
					enabledSha256: sha256(enabledBytes),
					actualSha256: liveSha,
				},
				identityMap: {
					artifactId: map.artifactId,
					sha256: sha256(mapBytes),
					bytesBase64: mapBytes.toString("base64"),
					evidencePath: input.identityMapEvidence,
				},
				fly1252: null,
			};
			atomicWrite(this.paths.configPreimage, preimageBytes);
			writeJournal(this.paths.journal, journal, this.runtime);
			if (liveSha !== targetSha) {
				this.writeConfigCas(liveSha, targetBytes);
			}
			this.checkpoint("config-frozen");
			await this.runtime.gracefulFreeze(targetSha);
			journal.freezeAckAt = nowIso(this.runtime);
			this.writeStage(journal, "frozen");
		});
	}

	async installIdentityMap(): Promise<void> {
		await this.withClaim(async () => {
			const journal = readJournal(this.paths.journal);
			if (journal.stage !== "frozen")
				throw new Error("identity map install requires frozen stage");
			if (journal.freezeAckAt === null)
				throw new Error("identity map install requires freeze acknowledgement");
			const bytes = Buffer.from(journal.identityMap.bytesBase64, "base64");
			parseIdentityMap(bytes);
			if (sha256(bytes) !== journal.identityMap.sha256) {
				throw new Error("identity map journal hash mismatch");
			}
			atomicWrite(this.paths.identityMap, bytes);
			this.writeStage(journal, "mapped");
			this.checkpoint("identity-map-installed");
		});
	}

	async beginSlots(): Promise<void> {
		await this.withClaim(async () => {
			const journal = readJournal(this.paths.journal);
			if (journal.stage !== "mapped")
				throw new Error("slot rebuild requires mapped stage");
			if (journal.freezeAckAt === null) {
				throw new Error("slot rebuild requires freeze acknowledgement");
			}
			this.assertConfigCas(journal.config.targetSha256);
			await this.runtime.assertHealthy(
				"monitor",
				journal.config.targetSha256,
				undefined,
				{ allowIdentityConflict: true },
			);
			this.assertConfigCas(journal.config.targetSha256);
			this.writeStage(journal, "slots_rebuilding");
			this.checkpoint("latch-written");
		});
	}

	async markSlotVerified(name: string): Promise<void> {
		await this.withClaim(async () => {
			const journal = readJournal(this.paths.journal);
			if (journal.stage !== "slots_rebuilding") {
				throw new Error("slot verification requires slots_rebuilding stage");
			}
			if (!(name in journal.slots))
				throw new Error(`unknown rebuild slot: ${name}`);
			const next = journal.slotOrder.find(
				(slotName) => journal.slots[slotName]?.status === "pending",
			);
			if (next !== name)
				throw new Error(`next rebuild slot must be ${next ?? "none"}`);
			await this.runtime.verifyProfile(name, "pool");
			this.assertSlotDisplay(name);
			journal.slots[name] = {
				status: "verified",
				verifiedAt: nowIso(this.runtime),
			};
			writeJournal(this.paths.journal, journal, this.runtime);
			this.checkpoint("slot-captured");
			if (
				Object.values(journal.slots).every((slot) => slot.status === "verified")
			) {
				this.writeStage(journal, "slots_rebuilt");
			}
		});
	}

	private async verifyAllSlots(journal: PoolRebuildJournal): Promise<void> {
		for (const name of SLOT_NAMES) {
			if (journal.slots[name]?.status !== "verified") {
				throw new Error(`slot ${name} is not journal-verified`);
			}
			await this.runtime.verifyProfile(name, "pool");
			this.assertSlotDisplay(name);
		}
	}

	private assertSlotDisplay(name: string): Record<string, string> {
		assertSafeOwnedDirectory(join(this.paths.poolDir, name));
		const identity = JSON.parse(
			readSafeBytes(
				join(this.paths.poolDir, name, "oauthAccount.json"),
			).toString("utf8"),
		);
		for (const key of [
			"accountUuid",
			"emailAddress",
			"organizationUuid",
			"organizationName",
		]) {
			if (typeof identity?.[key] !== "string" || identity[key].length === 0) {
				throw new Error(`invalid ${name} display identity field ${key}`);
			}
		}
		if (
			identity.emailAddress !==
			CANONICAL_POOL_IDENTITIES[name as keyof typeof CANONICAL_POOL_IDENTITIES]
		) {
			throw new Error(
				`${name} display identity differs from canonical mapping`,
			);
		}
		const anchor = JSON.parse(
			readSafeBytes(
				join(this.paths.poolDir, name, "identity-anchor.json"),
			).toString("utf8"),
		);
		if (
			typeof anchor?.accountUuid !== "string" ||
			typeof anchor?.email !== "string" ||
			anchor.accountUuid !== identity.accountUuid ||
			anchor.email !== identity.emailAddress
		) {
			throw new Error(`${name} display identity differs from its anchor`);
		}
		return identity as Record<string, string>;
	}

	private assertMachineDisplay(finalActive: string): void {
		const expected = this.assertSlotDisplay(finalActive);
		const claude = JSON.parse(
			readSafeBytes(this.paths.claudeJson).toString("utf8"),
		);
		const actual = claude?.oauthAccount;
		for (const key of [
			"accountUuid",
			"emailAddress",
			"organizationUuid",
			"organizationName",
		]) {
			if (actual?.[key] !== expected[key]) {
				throw new Error(
					`machine display identity field ${key} differs from finalActive slot`,
				);
			}
		}
	}

	private syncDisplay(finalActive: string): void {
		const identityBytes = readSafeBytes(
			join(this.paths.poolDir, finalActive, "oauthAccount.json"),
		);
		const identity = JSON.parse(identityBytes.toString("utf8"));
		for (const key of [
			"accountUuid",
			"emailAddress",
			"organizationUuid",
			"organizationName",
		]) {
			if (typeof identity?.[key] !== "string" || identity[key].length === 0) {
				throw new Error(`invalid display identity field ${key}`);
			}
		}
		const claudeBytes = readSafeBytes(this.paths.claudeJson);
		const claude = JSON.parse(claudeBytes.toString("utf8"));
		if (!isRecord(claude)) throw new Error("~/.claude.json is not an object");
		claude.oauthAccount = identity;
		atomicWrite(this.paths.claudeJson, JSON.stringify(claude));
	}

	private reconcileStore(journal: PoolRebuildJournal): AccountStore {
		readSafeBytes(this.paths.store);
		const store = readStore(this.paths.store);
		if (
			store.generation !== journal.preGeneration &&
			store.generation !== journal.targetGeneration
		) {
			throw new Error("account store generation drift");
		}
		if (!sameSlots(store.accounts.map((account) => account.name))) {
			throw new Error("account store does not contain exactly the five slots");
		}
		const now = this.runtime.now();
		return {
			...store,
			generation: journal.targetGeneration,
			activeAccount: journal.finalActive,
			identityStale: false,
			accounts: store.accounts.map((account) => {
				const until = account.quotaExhaustedUntil;
				const parsed = until === null ? Number.NaN : Date.parse(until);
				return {
					...account,
					quotaExhaustedUntil:
						until !== null && Number.isFinite(parsed) && parsed <= now
							? null
							: until,
					authExpired: false,
					refreshTokenInvalid: false,
					profileVerifyFailed: false,
				};
			}),
		};
	}

	private reconcileState(journal: PoolRebuildJournal): QuotaMonitorState {
		const state = JSON.parse(readSafeBytes(this.paths.state).toString("utf8"));
		if (
			!isRecord(state) ||
			state.version !== 2 ||
			!Array.isArray(state.alertOutbox)
		) {
			throw new Error("quota monitor state is invalid");
		}
		return {
			...(state as unknown as QuotaMonitorState),
			observedGeneration: journal.targetGeneration,
			reviveEpoch: null,
			pendingDetection: null,
			confirmation: null,
			confirmDueAt: null,
		};
	}

	private async finalVerify(journal: PoolRebuildJournal): Promise<void> {
		await this.verifyAllSlots(journal);
		await this.runtime.verifyProfile(journal.finalActive, "keychain");
		if (
			readSafeBytes(this.paths.active).toString("utf8") !== journal.finalActive
		) {
			throw new Error("active marker does not match finalActive");
		}
		this.assertMachineDisplay(journal.finalActive);
		const store = readStore(this.paths.store);
		if (
			store.generation !== journal.targetGeneration ||
			store.activeAccount !== journal.finalActive
		) {
			throw new Error("account store final verifier failed");
		}
		const state = JSON.parse(readSafeBytes(this.paths.state).toString("utf8"));
		if (state.observedGeneration !== journal.targetGeneration) {
			throw new Error("quota state generation verifier failed");
		}
		const resolution = resolveMachineAccount({
			poolDir: this.paths.poolDir,
			claudeJsonPath: this.paths.claudeJson,
			store,
		});
		if (
			resolution.kind !== "resolved" ||
			resolution.name !== journal.finalActive
		) {
			throw new Error("resolveMachineAccount final verifier failed");
		}
	}

	private async commitCore(journal: PoolRebuildJournal): Promise<void> {
		this.assertConfigCas(journal.config.targetSha256);
		await this.ensureDaemonStopped();
		this.checkpoint("commit-bootout");
		await this.verifyAllSlots(journal);
		await this.runtime.verifyProfile(journal.finalActive, "keychain");
		await withMkdirLock(this.paths.accountsLock, async () => {
			atomicWrite(
				this.paths.active,
				journal.finalActive,
				0o600,
				[0o600, 0o400, 0o644],
			);
			this.checkpoint("active-written");
			await withMkdirLock(
				this.paths.claudeJsonLock,
				async () => {
					this.syncDisplay(journal.finalActive);
				},
				// scripts/inject-linear-issue.sh and test-teardown.sh share this
				// mutex and use bare mkdir/rmdir. A holder child would make their
				// stale-lock rmdir fail forever.
				{ bare: true, staleMs: 60_000 },
			);
			this.writeStage(journal, "display_synced");
			this.checkpoint("display-written");
			atomicWrite(
				this.paths.store,
				`${JSON.stringify(this.reconcileStore(journal), null, 2)}\n`,
			);
			this.writeStage(journal, "store_committed");
			this.checkpoint("store-written");
			atomicWrite(
				this.paths.state,
				`${JSON.stringify(this.reconcileState(journal), null, 2)}\n`,
			);
			this.writeStage(journal, "state_aligned");
			this.checkpoint("state-written");
		});
		await this.finalVerify(journal);
		this.assertConfigCas(journal.config.targetSha256);
		this.checkpoint("monitor-config-restored");
		await this.runtime.bootstrap("monitor");
		await this.runtime.assertHealthy("monitor", journal.config.targetSha256);
		this.writeStage(journal, "awaiting_1252");
	}

	private async ensureDaemonStopped(): Promise<void> {
		let bootoutError: unknown = null;
		try {
			await this.runtime.bootout();
		} catch (error) {
			bootoutError = error;
		}
		if (bootoutError !== null || (await this.runtime.isDaemonRunning())) {
			await this.runtime.emergencyStop();
		}
		if (await this.runtime.isDaemonRunning()) {
			throw new Error("quota daemon could not be proven stopped");
		}
	}

	async commit(): Promise<void> {
		await this.withClaim(async () => {
			const journal = readJournal(this.paths.journal);
			if (journal.stage !== "slots_rebuilt") {
				throw new Error("commit requires slots_rebuilt stage");
			}
			try {
				await this.commitCore(journal);
			} catch (error) {
				if (error instanceof RebuildCrashError) throw error;
				const failedFrom = journal.stage;
				this.writeStage(journal, "recovery_required", failedFrom);
				throw error;
			}
		});
	}

	private async restoreMonitorOnly(journal: PoolRebuildJournal): Promise<void> {
		await this.ensureDaemonStopped();
		const actual = currentSha(this.paths.config, [0o600, 0o400, 0o644]);
		if (actual === journal.config.enabledSha256) {
			this.writeConfigCas(
				journal.config.enabledSha256,
				Buffer.from(journal.config.targetBytesBase64, "base64"),
			);
		} else if (actual !== journal.config.targetSha256) {
			journal.config.actualSha256 = actual;
			this.writeStage(journal, "recovery_required", "promoting_enabled");
			throw new Error("promotion recovery refused unknown config hash");
		}
		await this.runtime.bootstrap("monitor");
		await this.runtime.assertHealthy("monitor", journal.config.targetSha256);
		this.writeStage(journal, "awaiting_1252");
	}

	private async recoverPromotion(journal: PoolRebuildJournal): Promise<void> {
		try {
			await this.restoreMonitorOnly(journal);
		} catch (error) {
			if (error instanceof RebuildCrashError) throw error;
			let stopError: unknown = null;
			try {
				await this.ensureDaemonStopped();
			} catch (failedStop) {
				stopError = failedStop;
			}
			journal.config.actualSha256 = currentSha(
				this.paths.config,
				[0o600, 0o400, 0o644],
			);
			this.writeStage(journal, "recovery_required", "promoting_enabled");
			if (stopError !== null) {
				throw new AggregateError(
					[error, stopError],
					"promotion recovery failed and daemon stop could not be proved",
				);
			}
			throw error;
		}
	}

	async promoteEnabled(input: {
		fly1252ReviewedSha: string;
		fly1252Evidence: string;
	}): Promise<void> {
		await this.withClaim(async () => {
			const journal = readJournal(this.paths.journal);
			if (journal.stage !== "awaiting_1252") {
				throw new Error("promote-enabled requires awaiting_1252 stage");
			}
			this.assertConfigCas(journal.config.targetSha256);
			await this.finalVerify(journal);
			const runtimeTreeSha256 = await this.runtime.verifyFly1252(
				input.fly1252ReviewedSha,
				input.fly1252Evidence,
			);
			journal.fly1252 = {
				reviewedSha: input.fly1252ReviewedSha,
				evidencePath: input.fly1252Evidence,
				runtimeTreeSha256,
			};
			writeJournal(this.paths.journal, journal, this.runtime);

			let bootoutStarted = false;
			try {
				bootoutStarted = true;
				await this.ensureDaemonStopped();
				this.assertConfigCas(journal.config.targetSha256);
				this.writeStage(journal, "promoting_enabled");
				this.checkpoint("promotion-wal-written");
				this.writeConfigCas(
					journal.config.targetSha256,
					Buffer.from(journal.config.enabledBytesBase64, "base64"),
				);
				this.checkpoint("enabled-config-written");
				await this.runtime.bootstrap("enabled");
				this.checkpoint("enabled-bootstrapped");
				await this.runtime.assertHealthy(
					"enabled",
					journal.config.enabledSha256,
					runtimeTreeSha256,
				);
				this.writeStage(journal, "restored_enabled");
			} catch (error) {
				if (error instanceof RebuildCrashError) throw error;
				if (!bootoutStarted) {
					this.writeStage(journal, "awaiting_1252");
					throw error;
				}
				await this.recoverPromotion(journal);
				throw error;
			}
		});
	}

	async abortRestore(): Promise<void> {
		await this.withClaim(async () => {
			const journal = readJournal(this.paths.journal);
			if (journal.stage !== "frozen" && journal.stage !== "mapped") {
				const from = journal.stage;
				this.writeStage(journal, "recovery_required", from);
				throw new Error(
					"abort-restore is forbidden after slots_rebuilding latch",
				);
			}
			const actual = currentSha(this.paths.config, [0o600, 0o400, 0o644]);
			if (actual === journal.config.preimageSha256) {
				const preimage = parseQuotaConfig(
					readSafeBytes(journal.config.preimagePath),
				);
				if (preimage.order.length !== 0) {
					this.writeConfigCas(
						journal.config.preimageSha256,
						Buffer.from(journal.config.targetBytesBase64, "base64"),
					);
				}
			} else if (actual !== journal.config.targetSha256) {
				throw new Error("abort-restore refused config drift");
			}
			await this.ensureFrozen(journal);
			this.writeStage(journal, "aborted_monitor_only");
		});
	}

	async resume(): Promise<void> {
		await this.withClaim(async () => {
			const journal = readJournal(this.paths.journal);
			switch (journal.stage) {
				case "frozen":
				case "mapped":
					await this.ensureFrozen(journal);
					return;
				case "slots_rebuilding":
					return; // human/browser authority is required for the next pending slot
				case "slots_rebuilt":
				case "display_synced":
				case "store_committed":
				case "state_aligned":
					await this.commitCore(journal);
					return;
				case "awaiting_1252":
					this.assertConfigCas(journal.config.targetSha256);
					if (!(await this.runtime.isDaemonRunning())) {
						await this.runtime.bootstrap("monitor");
					}
					await this.runtime.assertHealthy(
						"monitor",
						journal.config.targetSha256,
					);
					return;
				case "promoting_enabled":
					await this.recoverPromotion(journal);
					return;
				case "recovery_required":
					if (journal.recoveryFrom === "promoting_enabled") {
						await this.recoverPromotion(journal);
						return;
					}
					if (
						journal.recoveryFrom === "slots_rebuilding" &&
						Object.values(journal.slots).some(
							(slot) => slot.status === "pending",
						)
					) {
						await this.ensureFrozen(journal);
						this.writeStage(journal, "slots_rebuilding");
						return;
					}
					await this.commitCore(journal);
					return;
				case "restored_enabled":
				case "aborted_monitor_only":
					return;
			}
		});
	}

	status(): PoolRebuildStatus {
		const journal = readJournal(this.paths.journal);
		const verifiedSlots = Object.values(journal.slots).filter(
			(slot) => slot.status === "verified",
		).length;
		const nextSlot =
			journal.slotOrder.find(
				(name) => journal.slots[name]?.status === "pending",
			) ?? null;
		const actual = currentSha(this.paths.config, [0o600, 0o400, 0o644]);
		const errors: string[] = [];
		if (
			[
				"frozen",
				"mapped",
				"slots_rebuilding",
				"slots_rebuilt",
				"display_synced",
				"store_committed",
				"state_aligned",
				"awaiting_1252",
				"aborted_monitor_only",
			].includes(journal.stage) &&
			actual !== journal.config.targetSha256
		) {
			errors.push("config is not the journaled monitor-only target");
		}
		if (
			journal.stage === "restored_enabled" &&
			actual !== journal.config.enabledSha256
		) {
			errors.push("config is not the journaled enabled target");
		}
		if (journal.stage === "frozen" && journal.freezeAckAt === null) {
			errors.push("freeze quiescence has not been acknowledged");
		}
		if (
			currentSha(journal.config.preimagePath) !== journal.config.preimageSha256
		) {
			errors.push("config preimage snapshot hash mismatch");
		}
		if (["frozen"].includes(journal.stage)) {
			// Mapping is intentionally not installed yet.
		} else if (!existsSync(this.paths.identityMap)) {
			errors.push("installed identity map is missing");
		} else if (
			currentSha(this.paths.identityMap) !== journal.identityMap.sha256
		) {
			errors.push("installed identity map hash mismatch");
		}
		for (const [name, slot] of Object.entries(journal.slots)) {
			if (slot.status !== "verified") continue;
			try {
				this.assertSlotDisplay(name);
			} catch (error) {
				errors.push(
					`verified slot ${name} is inconsistent: ${error instanceof Error ? error.message : "unknown"}`,
				);
			}
		}
		const displayStages: PoolRebuildStage[] = [
			"display_synced",
			"store_committed",
			"state_aligned",
			"awaiting_1252",
			"promoting_enabled",
			"restored_enabled",
		];
		if (displayStages.includes(journal.stage)) {
			try {
				if (
					readSafeBytes(this.paths.active).toString("utf8") !==
					journal.finalActive
				) {
					throw new Error("active marker mismatch");
				}
				this.assertMachineDisplay(journal.finalActive);
			} catch (error) {
				errors.push(
					`active/display state is inconsistent: ${error instanceof Error ? error.message : "unknown"}`,
				);
			}
		}
		const storeStages: PoolRebuildStage[] = [
			"store_committed",
			"state_aligned",
			"awaiting_1252",
			"promoting_enabled",
			"restored_enabled",
		];
		if (storeStages.includes(journal.stage)) {
			try {
				const store = readStore(this.paths.store);
				if (
					store.generation !== journal.targetGeneration ||
					store.activeAccount !== journal.finalActive
				) {
					throw new Error("store generation/active mismatch");
				}
			} catch (error) {
				errors.push(
					`account store is inconsistent: ${error instanceof Error ? error.message : "unknown"}`,
				);
			}
		}
		const stateStages: PoolRebuildStage[] = [
			"state_aligned",
			"awaiting_1252",
			"promoting_enabled",
			"restored_enabled",
		];
		if (stateStages.includes(journal.stage)) {
			try {
				const state = JSON.parse(
					readSafeBytes(this.paths.state).toString("utf8"),
				);
				if (state.observedGeneration !== journal.targetGeneration) {
					throw new Error("state generation mismatch");
				}
			} catch (error) {
				errors.push(
					`quota state is inconsistent: ${error instanceof Error ? error.message : "unknown"}`,
				);
			}
		}
		const daemonMode = this.runtime.inspectDaemonMode();
		const monitorStages: PoolRebuildStage[] = [
			"frozen",
			"mapped",
			"slots_rebuilding",
			"slots_rebuilt",
			"awaiting_1252",
			"aborted_monitor_only",
		];
		const stoppedStages: PoolRebuildStage[] = [
			"display_synced",
			"store_committed",
			"state_aligned",
		];
		if (monitorStages.includes(journal.stage) && daemonMode !== "monitor") {
			errors.push(`daemon mode is ${daemonMode}, expected monitor`);
		}
		if (stoppedStages.includes(journal.stage) && daemonMode !== "stopped") {
			errors.push(`daemon mode is ${daemonMode}, expected stopped`);
		}
		if (journal.stage === "restored_enabled" && daemonMode !== "enabled") {
			errors.push(`daemon mode is ${daemonMode}, expected enabled`);
		}
		if (journal.stage === "promoting_enabled") {
			errors.push("promotion is incomplete and requires resume");
		}
		if (journal.stage === "recovery_required") {
			errors.push("recovery is required before resources are consistent");
		}
		return {
			stage: journal.stage,
			verifiedSlots,
			totalSlots: Object.keys(journal.slots).length,
			nextSlot,
			targetGeneration: journal.targetGeneration,
			finalActive: journal.finalActive,
			actualConfigSha256: actual,
			consistent: errors.length === 0,
			errors,
		};
	}
}
