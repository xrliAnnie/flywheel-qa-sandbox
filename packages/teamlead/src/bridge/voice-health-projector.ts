import { type ChildProcess, execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	MAX_VOICE_HEALTH_ACTIVE_INCIDENTS,
	type VoiceHealthView,
} from "../epic-page/model.js";
import { acquireProcessLifetimeFileLock } from "../process-lock.js";
import type { StateStore, VoiceSessionRow } from "../StateStore.js";

const MAX_EXPORT_BYTES = 2 * 1024 * 1024;
const STARTUP_NOT_READY_MS = 60_000;
const LEASED_STARTUP_GRACE_MS = 60_000;
const MAX_PAGE_CHANGES = 200;
const MAX_PAGES = 32;
const SOURCE_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLOSED_SOURCE_ERRORS = new Set([
	"source_mismatch",
	"cursor_mismatch",
	"change_gap",
	"health_store_unavailable",
	"schema_invalid",
	"unsafe_path",
	"unsafe_permissions",
]);
const SAFE_ALERT_RECEIPT =
	/^(?:sent channel_id=[0-9]{17,20} binding_digest=[0-9a-f]{64} message_id=[0-9]{17,20}|(?:duplicate|queued_transient|delivery_unknown|dead_lettered|config_error) channel_id=[0-9]{17,20} binding_digest=[0-9a-f]{64}|config_error)$/;
const STARTUP_REASONS = [
	"startup_config_invalid",
	"startup_lock_unavailable",
	"startup_not_ready",
	"health_observation_unavailable",
] as const;

class VoiceHealthExportPageLimitError extends Error {
	constructor(
		readonly sourceId: string,
		readonly cursor: number,
	) {
		super("voice_health_export_page_limit");
	}
}

export interface VoiceHealthExport {
	schemaVersion: 1;
	sourceId: string;
	serviceId: string;
	serviceLabel: string;
	eventHighWater: number;
	changes: Array<{
		changeSeq: number;
		observationSeq: number;
		changedAt: string;
		projection: unknown;
	}>;
	hasMore: boolean;
	nextCursor: number;
	currentProjection?: unknown;
	openEpisodes?: unknown[];
	openEpisodesTruncated?: boolean;
	notifications?: unknown[];
	notificationsTruncated?: boolean;
}

export interface VoiceHealthStartupEvent {
	startupAttemptId: string;
	observedAt: string;
	reasonClass: (typeof STARTUP_REASONS)[number];
	operation: "startup";
}

const startupEventConsumers = new WeakMap<
	VoiceHealthStartupEvent,
	(process: () => Promise<boolean>) => Promise<void>
>();

async function consumeStartupEvent(
	event: VoiceHealthStartupEvent,
	process: () => Promise<boolean>,
): Promise<void> {
	const consume = startupEventConsumers.get(event);
	if (consume) await consume(process);
	else await process();
}

type ProjectionStore = Pick<
	StateStore,
	| "getVoiceHealthProjectionCursor"
	| "applyVoiceHealthProjection"
	| "markVoiceHealthProjectionUnavailable"
>;

interface ExecOptions {
	encoding: "utf8";
	maxBuffer: number;
	shell: false;
	timeout: number;
	windowsHide: true;
}

type ExecFile = (
	file: string,
	args: string[],
	options: ExecOptions,
	callback: (error: Error | null, stdout: string, stderr: string) => void,
) => ChildProcess;

function record(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`invalid_${name}`);
	return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max = 160): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > max ||
		[...value].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || code === 127;
		})
	)
		throw new Error(`invalid_${name}`);
	return value;
}

function timestamp(value: unknown, name: string): string {
	const result = text(value, name, 40);
	if (!result.endsWith("Z") || !Number.isFinite(Date.parse(result)))
		throw new Error(`invalid_${name}`);
	return result;
}

function nullableTimestamp(value: unknown, name: string): string | null {
	return value === null ? null : timestamp(value, name);
}

function integer(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0)
		throw new Error(`invalid_${name}`);
	return Number(value);
}

function oneOf<T extends string>(
	value: unknown,
	values: readonly T[],
	name: string,
): T {
	if (typeof value !== "string" || !values.includes(value as T))
		throw new Error(`invalid_${name}`);
	return value as T;
}

function validateExport(
	value: unknown,
	afterCursor: number,
): VoiceHealthExport {
	const raw = record(value, "voice_health_export");
	if (raw.schemaVersion !== 1 || !SOURCE_ID.test(String(raw.sourceId)))
		throw new Error("invalid_voice_health_export");
	const highWater = integer(raw.eventHighWater, "voice_health_high_water");
	const nextCursor = integer(raw.nextCursor, "voice_health_next_cursor");
	if (
		nextCursor < afterCursor ||
		nextCursor > highWater ||
		typeof raw.hasMore !== "boolean" ||
		!Array.isArray(raw.changes) ||
		raw.changes.length > MAX_PAGE_CHANGES
	)
		throw new Error("invalid_voice_health_cursor");
	let expected = afterCursor + 1;
	for (const item of raw.changes) {
		const change = record(item, "voice_health_change");
		if (integer(change.changeSeq, "voice_health_change_seq") !== expected)
			throw new Error("invalid_voice_health_change_order");
		integer(change.observationSeq, "voice_health_observation_seq");
		timestamp(change.changedAt, "voice_health_changed_at");
		record(change.projection, "voice_health_change_projection");
		expected += 1;
	}
	if (
		(raw.changes.length === 0 && nextCursor !== afterCursor) ||
		(raw.changes.length > 0 && nextCursor !== expected - 1) ||
		(raw.hasMore && (raw.changes.length === 0 || nextCursor >= highWater)) ||
		(!raw.hasMore && nextCursor !== highWater) ||
		(raw.hasMore && raw.currentProjection !== undefined) ||
		(!raw.hasMore && raw.currentProjection === undefined)
	)
		throw new Error("invalid_voice_health_cursor");
	return raw as unknown as VoiceHealthExport;
}

const REASONS = [
	"bridge_connect_failed",
	"bridge_timeout_headers",
	"bridge_timeout_body",
	"bridge_auth_rejected",
	"bridge_http_error",
	"bridge_protocol_invalid",
	"startup_config_invalid",
	"startup_lock_unavailable",
	"startup_not_ready",
	"session_create_failed",
	"session_runtime_failed",
	"lease_lost",
	"heartbeat_stale",
	"health_observation_unavailable",
	"demand_source_unavailable",
	"unknown_failure",
] as const;
const THRESHOLDS = [
	"three_consecutive_failures",
	"first_failure_60s",
	"first_session_failure",
	"terminal_session_failure",
	"startup_failure",
] as const;
const DELIVERY_STATES = [
	"pending",
	"sent",
	"queued_transient",
	"delivery_unknown",
	"dead_lettered",
	"config_error",
	"cancelled_recovered",
] as const;
const PHASES = [
	"dormant",
	"idle",
	"failed_retrying",
	"active",
	"session_ended",
	"session_failed",
	"startup_failed",
	"stopped",
] as const;

function projectView(exported: VoiceHealthExport): {
	view: VoiceHealthView & { sourceStatus: "complete" | "truncated" };
	retryableIntentIds: string[];
} {
	const current = record(
		exported.currentProjection,
		"voice_health_current_projection",
	);
	const phase = oneOf(current.phase, PHASES, "voice_health_phase");
	const demandState = oneOf(
		current.demandState,
		["none", "required", "unknown"] as const,
		"voice_health_demand_state",
	);
	const demandSourceStatus = oneOf(
		current.sourceStatus,
		["available", "unverified", "unavailable"] as const,
		"voice_health_demand_source_status",
	);
	const lastIterationSuccessAt = nullableTimestamp(
		current.lastIterationSuccessAt,
		"voice_health_last_success",
	);
	const lastProgressAt = nullableTimestamp(
		current.lastProgressAt,
		"voice_health_last_progress",
	);
	const failureStreak = integer(
		current.failureStreak,
		"voice_health_failure_streak",
	);
	if (
		!Array.isArray(exported.openEpisodes) ||
		!Array.isArray(exported.notifications) ||
		typeof exported.openEpisodesTruncated !== "boolean" ||
		typeof exported.notificationsTruncated !== "boolean" ||
		exported.openEpisodes.length > MAX_PAGE_CHANGES ||
		exported.notifications.length > MAX_PAGE_CHANGES
	)
		throw new Error("invalid_voice_health_final_projection");
	const notifications = new Map<
		string,
		{ intentId: string; state: (typeof DELIVERY_STATES)[number] }
	>();
	for (const value of exported.notifications) {
		const notification = record(value, "voice_health_notification");
		const episodeId = text(
			notification.episodeId,
			"voice_health_notification_episode",
		);
		const intentId = text(
			notification.intentId,
			"voice_health_notification_intent",
		);
		if (!/^[0-9a-f]{64}$/.test(intentId))
			throw new Error("invalid_voice_health_notification_intent");
		notifications.set(episodeId, {
			intentId,
			state: oneOf(
				notification.state,
				DELIVERY_STATES,
				"voice_health_notification_state",
			),
		});
	}
	const activeIncidents = exported.openEpisodes
		.slice(0, MAX_VOICE_HEALTH_ACTIVE_INCIDENTS)
		.map((value) => {
			const episode = record(value, "voice_health_episode");
			const episodeId = text(episode.episodeId, "voice_health_episode_id");
			const notification = notifications.get(episodeId);
			return {
				scope: oneOf(
					episode.scope,
					["poll_dependency", "session_unavailable"] as const,
					"voice_health_episode_scope",
				),
				openedAt: timestamp(episode.openedAt, "voice_health_episode_opened_at"),
				reasonClass: oneOf(
					episode.reasonClass,
					REASONS,
					"voice_health_episode_reason",
				),
				threshold: oneOf(
					episode.threshold,
					THRESHOLDS,
					"voice_health_episode_threshold",
				),
				deliveryState: notification?.state ?? null,
			};
		});
	const observedAt =
		[
			current.demandObservedAt,
			lastIterationSuccessAt,
			lastProgressAt,
			current.lastFailureAt,
			current.bootAt,
			exported.changes.at(-1)?.changedAt,
		]
			.filter((value): value is string => typeof value === "string")
			.map((value) => timestamp(value, "voice_health_observed_at"))
			.sort()
			.at(-1) ?? null;
	const status: VoiceHealthView["status"] =
		activeIncidents.length > 0
			? "unhealthy"
			: demandSourceStatus !== "available" || demandState === "unknown"
				? "unknown"
				: demandState === "none"
					? "dormant"
					: phase === "failed_retrying" ||
							phase === "session_failed" ||
							phase === "startup_failed"
						? "unhealthy"
						: phase === "active" ||
								phase === "session_ended" ||
								(phase === "idle" && lastIterationSuccessAt !== null)
							? "healthy"
							: "starting";
	return {
		view: {
			schemaVersion: 1,
			sourceStatus:
				exported.openEpisodesTruncated ||
				exported.notificationsTruncated ||
				exported.openEpisodes.length > MAX_VOICE_HEALTH_ACTIVE_INCIDENTS
					? "truncated"
					: "complete",
			observedAt,
			status,
			demandState,
			phase,
			lastIterationSuccessAt,
			lastProgressAt,
			failureStreak,
			activeIncidents,
		},
		retryableIntentIds: [...notifications.values()]
			.filter((notification) =>
				new Set(["pending", "queued_transient", "config_error"]).has(
					notification.state,
				),
			)
			.map((notification) => notification.intentId),
	};
}

export function createVoiceHealthExportReader(input: {
	helperPath: string;
	stateRoot?: string;
	execFile?: ExecFile;
}): (cursor: number, sourceId?: string) => Promise<VoiceHealthExport> {
	const run = input.execFile ?? execFile;
	const stateRoot = input.stateRoot ?? join(homedir(), ".flywheel");
	return (cursor, sourceId) =>
		new Promise((resolve, reject) => {
			let child: ChildProcess;
			try {
				child = run(
					"python3",
					[input.helperPath, "--state-root", stateRoot, "export"],
					{
						encoding: "utf8",
						maxBuffer: MAX_EXPORT_BYTES,
						shell: false,
						timeout: 500,
						windowsHide: true,
					},
					(error, stdout, stderr) => {
						if (error) {
							const code = stderr
								.trim()
								.match(/^voice-health: ([a-z_]+)$/)?.[1];
							reject(
								new Error(
									code && CLOSED_SOURCE_ERRORS.has(code)
										? code
										: "health_store_unavailable",
								),
							);
							return;
						}
						try {
							resolve(validateExport(JSON.parse(stdout), cursor));
						} catch {
							reject(new Error("health_store_unavailable"));
						}
					},
				);
			} catch {
				reject(new Error("health_store_unavailable"));
				return;
			}
			if (!child.stdin) {
				reject(new Error("health_store_unavailable"));
				return;
			}
			child.stdin.once("error", () =>
				reject(new Error("health_store_unavailable")),
			);
			child.stdin.end(
				JSON.stringify({
					afterCursor: cursor,
					limit: MAX_PAGE_CHANGES,
					...(sourceId ? { sourceId } : {}),
				}),
				"utf8",
			);
		});
}

export function createVoiceHealthIntentNotifier(input: {
	leadAlertPath: string;
	execFile?: ExecFile;
	log?: (message: string) => void;
}): (intentId: string) => void {
	const run = input.execFile ?? execFile;
	const active = new Set<string>();
	return (intentId) => {
		if (!/^[0-9a-f]{64}$/.test(intentId) || active.has(intentId)) return;
		active.add(intentId);
		try {
			run(
				"/bin/bash",
				[
					input.leadAlertPath,
					"--project",
					"flywheel",
					"--lead",
					"voice-health",
					"--kind",
					"voice_daemon_unhealthy",
					"--severity",
					"warning",
					"--voice-intent",
					intentId,
					"--strict-delivery",
				],
				{
					encoding: "utf8",
					maxBuffer: 4096,
					shell: false,
					timeout: 30_000,
					windowsHide: true,
				},
				(_error, stdout) => {
					active.delete(intentId);
					if (!SAFE_ALERT_RECEIPT.test(stdout.trim()))
						input.log?.("[voice-health-projector] alert receipt unavailable");
				},
			);
		} catch {
			active.delete(intentId);
			input.log?.("[voice-health-projector] alert dispatch unavailable");
		}
	};
}

function notificationIntentId(
	receipt: Record<string, unknown>,
): string | undefined {
	const notification = receipt.notification;
	if (
		!notification ||
		typeof notification !== "object" ||
		Array.isArray(notification)
	)
		return undefined;
	const intentId = (notification as Record<string, unknown>).intentId;
	return typeof intentId === "string" && /^[0-9a-f]{64}$/.test(intentId)
		? intentId
		: undefined;
}

export function createVoiceHealthStartupSpoolReader(
	input: { homeDir?: string } = {},
): () => Promise<VoiceHealthStartupEvent[]> {
	const spool = join(
		input.homeDir ?? homedir(),
		".flywheel",
		"voice-startup-spool",
	);
	return async () => {
		let directory: Stats;
		try {
			directory = await lstat(spool);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw new Error("startup_spool_unavailable");
		}
		const expectedOwner = process.geteuid?.();
		if (
			!directory.isDirectory() ||
			directory.isSymbolicLink() ||
			(directory.mode & 0o777) !== 0o700 ||
			(expectedOwner !== undefined && directory.uid !== expectedOwner)
		)
			throw new Error("startup_spool_unavailable");
		let names: string[];
		try {
			names = (await readdir(spool))
				.filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
				.sort();
		} catch {
			throw new Error("startup_spool_unavailable");
		}
		if (names.length > 128) throw new Error("startup_spool_overflow");
		let totalBytes = 0;
		const events: VoiceHealthStartupEvent[] = [];
		for (const name of names) {
			const path = join(spool, name);
			let details: Stats;
			try {
				details = await lstat(path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw new Error("startup_spool_unavailable");
			}
			if (
				!details.isFile() ||
				details.isSymbolicLink() ||
				(details.mode & 0o777) !== 0o600 ||
				(expectedOwner !== undefined && details.uid !== expectedOwner) ||
				details.size > 32 * 1024
			)
				throw new Error("startup_spool_unavailable");
			totalBytes += details.size;
			if (totalBytes > 1024 * 1024) throw new Error("startup_spool_overflow");
			let encoded: string;
			let raw: Record<string, unknown>;
			try {
				encoded = await readFile(path, "utf8");
				raw = record(JSON.parse(encoded), "startup_spool_event");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw new Error("startup_spool_unavailable");
			}
			if (
				raw.schemaVersion !== 1 ||
				Object.keys(raw).sort().join(",") !==
					"observedAt,operation,reasonClass,schemaVersion,startupAttemptId" ||
				raw.operation !== "startup"
			)
				throw new Error("startup_spool_unavailable");
			const startupAttemptId = text(raw.startupAttemptId, "startup_attempt_id");
			if (!SOURCE_ID.test(startupAttemptId))
				throw new Error("startup_spool_unavailable");
			const event: VoiceHealthStartupEvent = {
				startupAttemptId,
				observedAt: timestamp(raw.observedAt, "startup_observed_at"),
				reasonClass: oneOf(
					raw.reasonClass,
					STARTUP_REASONS,
					"startup_reason_class",
				),
				operation: "startup",
			};
			startupEventConsumers.set(event, async (processEvent) => {
				// flock is released by the OS even if a Bridge dies; the document
				// stays in place until the helper's durable receipt is acknowledged.
				const lockPath = join(spool, ".consumer.lock");
				const descriptor = await open(
					lockPath,
					constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
					0o600,
				);
				try {
					const lock = await descriptor.stat();
					if (
						!lock.isFile() ||
						(lock.mode & 0o777) !== 0o600 ||
						(expectedOwner !== undefined && lock.uid !== expectedOwner)
					)
						throw new Error("startup_spool_unavailable");
				} finally {
					await descriptor.close();
				}
				const claim = await acquireProcessLifetimeFileLock(lockPath, {
					readyTimeoutMs: 500,
				});
				if (claim.status === "conflict") return;
				if (claim.status !== "acquired")
					throw new Error("startup_spool_unavailable");
				try {
					let current: Stats;
					try {
						current = await lstat(path);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
						throw new Error("startup_spool_unavailable");
					}
					if (
						!current.isFile() ||
						current.isSymbolicLink() ||
						(current.mode & 0o777) !== 0o600 ||
						(expectedOwner !== undefined && current.uid !== expectedOwner) ||
						current.dev !== details.dev ||
						current.ino !== details.ino ||
						current.size !== details.size ||
						current.mtimeMs !== details.mtimeMs ||
						(await readFile(path, "utf8")) !== encoded
					)
						throw new Error("startup_spool_unavailable");
					const archive = join(spool, "consumed");
					await mkdir(archive, { mode: 0o700 }).catch(
						(error: NodeJS.ErrnoException) => {
							if (error.code !== "EEXIST") throw error;
						},
					);
					const archiveDetails = await lstat(archive);
					if (
						!archiveDetails.isDirectory() ||
						archiveDetails.isSymbolicLink() ||
						(archiveDetails.mode & 0o777) !== 0o700 ||
						(expectedOwner !== undefined &&
							archiveDetails.uid !== expectedOwner)
					)
						throw new Error("startup_spool_unavailable");
					// Never replace existing evidence, even for a repeated filename.
					try {
						await lstat(join(archive, name));
						throw new Error("startup_spool_unavailable");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
					if (await processEvent()) await rename(path, join(archive, name));
				} finally {
					await claim.handle.close();
				}
			});
			events.push(event);
		}
		return events;
	};
}

export function createVoiceHealthBridgeGuard(input: {
	store: Pick<StateStore, "listVoiceSessions">;
	helperPath: string;
	stateRoot?: string;
	execFile?: ExecFile;
	now?: () => Date;
	readStartupEvents?: () => Promise<VoiceHealthStartupEvent[]>;
}): (exported: VoiceHealthExport) => Promise<string[]> {
	const run = input.execFile ?? execFile;
	const stateRoot = input.stateRoot ?? join(homedir(), ".flywheel");
	const invoke = (
		command: "evaluate" | "record-startup",
		payload: Record<string, unknown>,
	): Promise<Record<string, unknown>> =>
		new Promise((resolve, reject) => {
			let child: ChildProcess;
			try {
				child = run(
					"python3",
					[input.helperPath, "--state-root", stateRoot, command],
					{
						encoding: "utf8",
						maxBuffer: 65_536,
						shell: false,
						timeout: 500,
						windowsHide: true,
					},
					(error, stdout) => {
						if (error) {
							reject(new Error("health_store_unavailable"));
							return;
						}
						try {
							resolve(record(JSON.parse(stdout), "voice_health_receipt"));
						} catch {
							reject(new Error("health_store_unavailable"));
						}
					},
				);
			} catch {
				reject(new Error("health_store_unavailable"));
				return;
			}
			if (!child.stdin) {
				reject(new Error("health_store_unavailable"));
				return;
			}
			child.stdin.once("error", () =>
				reject(new Error("health_store_unavailable")),
			);
			child.stdin.end(JSON.stringify(payload), "utf8");
		});
	return async (exported) => {
		const now = (input.now ?? (() => new Date()))();
		const intentIds: string[] = [];
		const evaluated = await invoke("evaluate", {
			observedAt: now.toISOString(),
		});
		const evaluatedIntent = notificationIntentId(evaluated);
		if (evaluatedIntent) intentIds.push(evaluatedIntent);
		const current = record(
			exported.currentProjection,
			"voice_health_guard_projection",
		);
		const identities = Array.isArray(current.demandIdentities)
			? current.demandIdentities
			: [];
		if (
			current.demandState === "required" &&
			current.sourceStatus === "available" &&
			identities.length === 1
		) {
			const identity = record(identities[0], "voice_health_demand_identity");
			const demandId = text(identity.demandId, "voice_health_demand_id");
			const attemptId = text(
				identity.attemptId,
				"voice_health_demand_attempt_id",
			);
			const requiredSession = input.store
				.listVoiceSessions([
					"provisioning",
					"desired",
					"claimed",
					"warming",
					"live",
					"ending",
				])
				.find((session) => session.sessionId === attemptId);
			const requiredAt = requiredSession
				? Date.parse(requiredSession.createdAt)
				: Number.NaN;
			for (const event of (await input.readStartupEvents?.()) ?? []) {
				await consumeStartupEvent(event, async () => {
					// A duplicate launch can observe the healthy owner's lock. The 60-second
					// demand guard below is the authoritative alert if no owner reaches live.
					if (event.reasonClass === "startup_lock_unavailable") {
						return true;
					}
					if (
						!Number.isFinite(requiredAt) ||
						Date.parse(event.observedAt) < requiredAt
					) {
						return Number.isFinite(requiredAt);
					}
					const receipt = await invoke("record-startup", {
						startupAttemptId: event.startupAttemptId,
						observedAt: event.observedAt,
						reasonClass: event.reasonClass,
						operation: event.operation,
						demandId,
					});
					const intentId = notificationIntentId(receipt);
					if (intentId) intentIds.push(intentId);
					return new Set(["recorded", "duplicate"]).has(String(receipt.status));
				});
			}
		}
		const waiting = input.store
			.listVoiceSessions(["provisioning", "desired", "claimed", "warming"])
			.filter((session: VoiceSessionRow) => {
				const createdAt = Date.parse(session.createdAt);
				if (
					!Number.isFinite(createdAt) ||
					now.getTime() - createdAt < STARTUP_NOT_READY_MS
				)
					return false;
				// FLY-2701: a booked meeting is deliberately in the room early and
				// stays warming until its own time, so its readiness target is
				// "ready", not "live". A session that has reported ready is doing
				// exactly what was asked of it until the founder's own deadline.
				if (session.readyAt && session.presenceDeadlineAt) {
					const presenceDeadlineAt = Date.parse(session.presenceDeadlineAt);
					if (
						Number.isFinite(presenceDeadlineAt) &&
						now.getTime() <= presenceDeadlineAt
					)
						return false;
				}
				if (session.state === "claimed" || session.state === "warming") {
					// FLY-2693 review R5, plan section 3: a claim or lease renewal
					// cannot extend the startup boundary. A live lease excuses the
					// session only inside the 60s boundary plus one presence grace;
					// past that, leased-but-not-live is exactly startup_not_ready.
					const leaseExpiresAt = Date.parse(session.leaseExpiresAt ?? "");
					if (
						Number.isFinite(leaseExpiresAt) &&
						leaseExpiresAt > now.getTime() &&
						now.getTime() - createdAt <
							STARTUP_NOT_READY_MS + LEASED_STARTUP_GRACE_MS
					)
						return false;
				}
				return true;
			})
			.sort(
				(left: VoiceSessionRow, right: VoiceSessionRow) =>
					left.createdAt.localeCompare(right.createdAt) ||
					left.sessionId.localeCompare(right.sessionId),
			)
			.slice(0, 8);
		for (const session of waiting) {
			const thresholdAt = new Date(
				Date.parse(session.createdAt) + STARTUP_NOT_READY_MS,
			).toISOString();
			const receipt = await invoke("record-startup", {
				startupAttemptId: session.sessionId,
				demandId: session.meetingId ?? session.sessionId,
				observedAt: thresholdAt,
				reasonClass: "startup_not_ready",
				operation: "startup",
			});
			const intentId = notificationIntentId(receipt);
			if (intentId) intentIds.push(intentId);
		}
		return [...new Set(intentIds)];
	};
}

export function createVoiceHealthProjector(input: {
	store: ProjectionStore;
	readExport: (cursor: number, sourceId?: string) => Promise<VoiceHealthExport>;
	requestRefresh: (projectName: string, reason: "voice_health_changed") => void;
	notifyIntent?: (intentId: string) => void;
	beforeRead?: (exported: VoiceHealthExport) => Promise<string[]>;
	now?: () => Date;
	everyNTicks?: number;
	log?: (message: string) => void;
}): { tick(): Promise<void> } {
	const everyNTicks = Math.max(1, input.everyNTicks ?? 1);
	let ticks = 0;
	let active: Promise<void> | undefined;
	const run = async () => {
		const current = input.store.getVoiceHealthProjectionCursor();
		try {
			const drain = async (startCursor: number, sourceId?: string) => {
				let cursor = startCursor;
				let expectedSource = sourceId;
				for (let page = 0; page < MAX_PAGES; page += 1) {
					let exported: VoiceHealthExport;
					try {
						exported = validateExport(
							await input.readExport(cursor, expectedSource),
							cursor,
						);
					} catch (error) {
						if (
							expectedSource &&
							error instanceof Error &&
							new Set(["source_mismatch", "cursor_mismatch"]).has(error.message)
						) {
							cursor = 0;
							expectedSource = undefined;
							continue;
						}
						throw error;
					}
					if (expectedSource && exported.sourceId !== expectedSource) {
						cursor = 0;
						expectedSource = undefined;
						exported = validateExport(await input.readExport(0), 0);
					}
					expectedSource = exported.sourceId;
					cursor = exported.nextCursor;
					if (!exported.hasMore) return exported;
				}
				if (!expectedSource) throw new Error("voice_health_export_page_limit");
				throw new VoiceHealthExportPageLimitError(expectedSource, cursor);
			};
			let final = await drain(current.cursor, current.sourceId ?? undefined);
			if (input.beforeRead) {
				for (const intentId of await input.beforeRead(final))
					input.notifyIntent?.(intentId);
				final = await drain(final.nextCursor, final.sourceId);
			}
			const projected = projectView(final);
			const result = input.store.applyVoiceHealthProjection({
				sourceId: final.sourceId,
				cursor: final.nextCursor,
				status: projected.view.sourceStatus,
				view: projected.view,
				now: (input.now ?? (() => new Date()))().toISOString(),
			});
			for (const intentId of projected.retryableIntentIds)
				input.notifyIntent?.(intentId);
			if (result.changed)
				input.requestRefresh("flywheel", "voice_health_changed");
		} catch (error) {
			const reason =
				error instanceof Error && /^[a-z_]+$/.test(error.message)
					? error.message
					: "health_store_unavailable";
			const changed = input.store.markVoiceHealthProjectionUnavailable({
				error: reason,
				now: (input.now ?? (() => new Date()))().toISOString(),
				...(error instanceof VoiceHealthExportPageLimitError
					? { sourceId: error.sourceId, cursor: error.cursor }
					: {}),
			});
			if (changed) input.requestRefresh("flywheel", "voice_health_changed");
			input.log?.(`[voice-health-projector] source unavailable: ${reason}`);
		}
	};
	return {
		async tick() {
			ticks += 1;
			if ((ticks - 1) % everyNTicks !== 0) return;
			if (active) return active;
			active = run().finally(() => {
				active = undefined;
			});
			return active;
		},
	};
}
