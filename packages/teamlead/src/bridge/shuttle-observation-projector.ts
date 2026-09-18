import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
	RefreshReason,
	ShuttleDeploymentUnit,
} from "../epic-page/model.js";
import type { StateStore } from "../StateStore.js";

const execFileP = promisify(execFile);
const MAX_EXPORT_BYTES = 2 * 1024 * 1024;
const MAX_EXPORT_UNITS = 200;

interface ShuttleNotificationIntent {
	routeKey: string;
	episodeId: string;
	deliveryState: string;
}

export interface ShuttleObservationUnit {
	schemaVersion: 1;
	cycleId: string;
	cycleSeq: number;
	unitId: string;
	projectName: string;
	unitKind: string;
	ownerKey: string;
	displayName: string;
	wakeKind: string;
	outcome: "deployed" | "up_to_date" | "skipped" | "failed";
	reason: string;
	reasonDisplay: string;
	expected: boolean;
	evaluated: boolean;
	observedAt: string;
	evidenceRef: string;
	logRef: string;
	deployedSha: string | null;
	targetSha: string | null;
	behindCommits: number | null;
	driftBasis: string;
	episodeId: string | null;
	episodeOpenedAt: string | null;
	consecutiveScheduledBad: number;
	founderAware: boolean;
	closedAt: string | null;
	driftSince: string | null;
	notificationIntents: ShuttleNotificationIntent[];
}

export interface ShuttleObservationExport {
	schemaVersion: 1;
	sourceId: string;
	afterChangeSeq: number;
	nextCursor: number;
	hasMore: boolean;
	changes: Array<{
		changeSeq: number;
		unitId: string | null;
		cycleId: string | null;
		payload: unknown;
	}>;
	units: ShuttleObservationUnit[];
}

type ProjectionStore = Pick<
	StateStore,
	| "getShuttleProjectionCursor"
	| "applyShuttleProjection"
	| "markShuttleProjectionUnavailable"
>;

export interface ShuttleObservationProjector {
	tick(): Promise<void>;
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`invalid_${name}`);
	return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max = 240): string {
	const hasControl =
		typeof value === "string" &&
		[...value].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return (code < 32 && code !== 9) || code === 127;
		});
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > max ||
		hasControl
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

function nonNegativeInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0)
		throw new Error(`invalid_${name}`);
	return Number(value);
}

function validateIntent(value: unknown): ShuttleNotificationIntent {
	const raw = record(value, "notification_intent");
	return {
		routeKey: text(raw.routeKey, "notification_route", 40),
		episodeId: text(raw.episodeId, "notification_episode", 160),
		deliveryState: text(raw.deliveryState, "notification_delivery", 80),
	};
}

function projectUnit(value: unknown): ShuttleDeploymentUnit {
	const raw = record(value, "shuttle_unit");
	if (raw.schemaVersion !== 1) throw new Error("invalid_shuttle_unit_schema");
	const outcome = text(raw.outcome, "shuttle_outcome", 20);
	if (!new Set(["deployed", "up_to_date", "skipped", "failed"]).has(outcome))
		throw new Error("invalid_shuttle_outcome");
	if (
		typeof raw.expected !== "boolean" ||
		typeof raw.founderAware !== "boolean"
	)
		throw new Error("invalid_shuttle_flags");
	const episodeId =
		raw.episodeId === null ? null : text(raw.episodeId, "shuttle_episode", 160);
	const consecutive = nonNegativeInteger(
		raw.consecutiveScheduledBad,
		"shuttle_consecutive",
	);
	if (raw.founderAware && (episodeId === null || consecutive < 2))
		throw new Error("invalid_shuttle_founder_awareness");
	const latestAbnormal =
		outcome === "failed" || (outcome === "skipped" && !raw.expected);
	if (latestAbnormal && episodeId === null)
		throw new Error("invalid_shuttle_episode_state");
	const behind =
		raw.behindCommits === null
			? null
			: nonNegativeInteger(raw.behindCommits, "shuttle_behind");
	if (!Array.isArray(raw.notificationIntents))
		throw new Error("invalid_shuttle_notifications");
	const intents = raw.notificationIntents.map(validateIntent);
	const deliveryState = episodeId
		? ([...intents]
				.reverse()
				.find(
					(intent) =>
						intent.routeKey === "primary" && intent.episodeId === episodeId,
				)?.deliveryState ?? null)
		: null;
	return {
		unitId: text(raw.unitId, "shuttle_unit_id", 160),
		projectName: text(raw.projectName, "shuttle_project", 80),
		displayName: text(raw.displayName, "shuttle_display", 160),
		outcome: outcome as ShuttleDeploymentUnit["outcome"],
		reason: text(raw.reason, "shuttle_reason", 80),
		reasonDisplay: text(raw.reasonDisplay, "shuttle_reason_display", 160),
		expected: raw.expected,
		observedAt: timestamp(raw.observedAt, "shuttle_observed"),
		episodeId,
		episodeOpenedAt: nullableTimestamp(
			raw.episodeOpenedAt,
			"shuttle_episode_opened",
		),
		consecutiveScheduledBad: consecutive,
		founderAware: raw.founderAware,
		behindCommits: behind,
		driftSince: nullableTimestamp(raw.driftSince, "shuttle_drift_since"),
		logRef: text(raw.logRef, "shuttle_log_ref", 240),
		deliveryState,
	};
}

function validateExport(value: unknown): ShuttleObservationExport {
	const raw = record(value, "shuttle_export");
	if (raw.schemaVersion !== 1) throw new Error("invalid_shuttle_export_schema");
	const afterChangeSeq = nonNegativeInteger(
		raw.afterChangeSeq,
		"shuttle_after_cursor",
	);
	const nextCursor = nonNegativeInteger(raw.nextCursor, "shuttle_next_cursor");
	if (nextCursor < afterChangeSeq) throw new Error("shuttle_cursor_regressed");
	if (typeof raw.hasMore !== "boolean" || !Array.isArray(raw.changes))
		throw new Error("invalid_shuttle_export_changes");
	if (raw.changes.length > MAX_EXPORT_UNITS)
		throw new Error("invalid_shuttle_export_change_count");
	if (!Array.isArray(raw.units) || raw.units.length > MAX_EXPORT_UNITS)
		throw new Error("invalid_shuttle_export_units");
	let previousChangeSeq = afterChangeSeq;
	for (const value of raw.changes) {
		const change = record(value, "shuttle_change");
		const changeSeq = nonNegativeInteger(
			change.changeSeq,
			"shuttle_change_seq",
		);
		if (changeSeq <= previousChangeSeq || changeSeq > nextCursor)
			throw new Error("invalid_shuttle_change_order");
		previousChangeSeq = changeSeq;
	}
	if (
		(raw.changes.length === 0 && nextCursor !== afterChangeSeq) ||
		(raw.changes.length > 0 && previousChangeSeq !== nextCursor) ||
		(raw.hasMore && raw.changes.length === 0)
	)
		throw new Error("invalid_shuttle_export_cursor");
	return {
		schemaVersion: 1,
		sourceId: text(raw.sourceId, "shuttle_source", 160),
		afterChangeSeq,
		nextCursor,
		hasMore: raw.hasMore,
		changes: raw.changes as ShuttleObservationExport["changes"],
		units: raw.units as ShuttleObservationUnit[],
	};
}

export function createShuttleObservationExportReader(input: {
	scriptPath: string;
	flywheelHome?: string;
}): (cursor: number) => Promise<ShuttleObservationExport> {
	const flywheelHome = input.flywheelHome ?? join(homedir(), ".flywheel");
	const stateRoot = join(flywheelHome, "state", "shuttle");
	return async (cursor) => {
		if (!existsSync(join(stateRoot, "observations.sqlite")))
			throw new Error("shuttle_observation_source_missing");
		const { stdout } = await execFileP(
			"python3",
			[
				input.scriptPath,
				"--state-root",
				stateRoot,
				"export",
				"--after-change-seq",
				String(cursor),
				"--limit",
				"200",
			],
			{
				timeout: 500,
				maxBuffer: MAX_EXPORT_BYTES,
				env: { ...process.env, FLYWHEEL_HOME: flywheelHome },
			},
		);
		return validateExport(JSON.parse(stdout));
	};
}

export function createShuttleDeliveryRecorder(input: {
	scriptPath: string;
	flywheelHome?: string;
}): (receipt: {
	batchId: string;
	state: "sent" | "dead_lettered" | "delivery_unknown";
	channelId?: string;
	messageId?: string;
	bindingDigest?: string;
}) => void {
	const flywheelHome = input.flywheelHome ?? join(homedir(), ".flywheel");
	const stateRoot = join(flywheelHome, "state", "shuttle");
	return (receipt) => {
		if (!existsSync(join(stateRoot, "observations.sqlite")))
			throw new Error("shuttle_observation_source_missing");
		const args = [
			input.scriptPath,
			"--state-root",
			stateRoot,
			"delivery",
			"--intent-id",
			receipt.batchId,
			"--state",
			receipt.state,
		];
		if (receipt.messageId) args.push("--message-id", receipt.messageId);
		if (receipt.channelId) args.push("--channel-id", receipt.channelId);
		if (receipt.bindingDigest)
			args.push("--binding-digest", receipt.bindingDigest);
		execFileSync("python3", args, {
			timeout: 500,
			maxBuffer: MAX_EXPORT_BYTES,
			env: { ...process.env, FLYWHEEL_HOME: flywheelHome },
			stdio: "ignore",
		});
	};
}

export function createShuttleObservationProjector(input: {
	store: ProjectionStore;
	projects: string[];
	readExport: (cursor: number) => Promise<ShuttleObservationExport>;
	requestRefresh: (
		projectName: string,
		reason: Extract<RefreshReason, "deployment_changed">,
	) => void;
	now?: () => Date;
	everyNTicks?: number;
	log?: (message: string) => void;
}): ShuttleObservationProjector {
	const projects = new Set(input.projects);
	const everyNTicks =
		Number.isSafeInteger(input.everyNTicks) && Number(input.everyNTicks) > 0
			? Number(input.everyNTicks)
			: 1;
	let ticks = 0;
	let active: Promise<void> | undefined;
	const refresh = (affected: Iterable<string>) => {
		const names = new Set(["flywheel", ...affected]);
		for (const projectName of [...names].sort()) {
			if (projects.has(projectName))
				input.requestRefresh(projectName, "deployment_changed");
		}
	};
	const run = async () => {
		const current = input.store.getShuttleProjectionCursor();
		try {
			const readAt = async (cursor: number) => {
				const exported = validateExport(await input.readExport(cursor));
				if (exported.afterChangeSeq !== cursor)
					throw new Error("shuttle_export_cursor_mismatch");
				return exported;
			};
			let exported = await readAt(current.cursor);
			if (
				current.sourceId !== null &&
				current.sourceId !== exported.sourceId &&
				current.cursor !== 0
			) {
				exported = await readAt(0);
			}
			const units = exported.units.map(projectUnit);
			if (units.length === 0)
				throw new Error("shuttle_observation_has_no_unit_results");
			const result = input.store.applyShuttleProjection({
				sourceId: exported.sourceId,
				cursor: exported.nextCursor,
				status: exported.hasMore ? "truncated" : "complete",
				units,
				now: (input.now ?? (() => new Date()))().toISOString(),
			});
			if (result.changed) refresh(result.changedProjects);
		} catch (error) {
			const name = error instanceof Error ? error.message : "unknown_error";
			const changed = input.store.markShuttleProjectionUnavailable({
				error: name,
				now: (input.now ?? (() => new Date()))().toISOString(),
			});
			if (changed) refresh(projects);
			input.log?.(`[shuttle-projector] source unavailable: ${name}`);
		}
	};
	return {
		async tick(): Promise<void> {
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
