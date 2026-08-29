import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
	effectivePatrolIntervalMs,
	getGlobalPatrolConfigSnapshot,
	getProjectPatrolConfigSnapshot,
	type PatrolConfig,
} from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { PatrolOrphanWatch, StateStore } from "../StateStore.js";

const execFile = promisify(execFileCallback);
const ORPHAN_ALERT_COOLDOWN_MS = 30 * 60_000;
const PATROL_TMUX_TIMEOUT_MS = 5_000;
const PATROL_TMUX_MAX_BUFFER = 1024 * 1024;
const PATROL_SWEEP_DEADLINE_MS = 15_000;
const CANONICAL_WINDOW_NAME = /^[A-Z][A-Z0-9]*-[0-9]+($|[-_:])/;

type PatrolExecFile = (
	file: string,
	args: string[],
	options: {
		encoding: "utf8";
		env: NodeJS.ProcessEnv;
		timeout: number;
		maxBuffer: number;
		killSignal: "SIGKILL";
	},
) => Promise<{ stdout: string | Buffer }>;

export interface PatrolPaneIdentity {
	projectName: string;
	target: string;
	paneId: string;
	panePid: string;
	sessionCreated: string;
}

export interface PatrolOrphanSweepStore {
	getPatrolOrphanWatch(target: string): PatrolOrphanWatch | null;
	listPatrolOrphanWatches(): PatrolOrphanWatch[];
	upsertPatrolOrphanWatch(watch: PatrolOrphanWatch): void;
	deletePatrolOrphanWatch(target: string): void;
}

export interface PatrolOrphanFailure {
	kind: "orphan_pane";
	condition: "unclaimed" | "owner_index_incomplete";
	projectName: string;
	target: string | null;
	detail: string;
	episodeId: string;
}

export interface PatrolOrphanSweeperDeps {
	projects: Pick<ProjectEntry, "projectName" | "projectRoot">[];
	store: Pick<
		StateStore,
		| "getPatrolOrphanWatch"
		| "listPatrolOrphanWatches"
		| "upsertPatrolOrphanWatch"
		| "deletePatrolOrphanWatch"
	>;
	listPanes?: () => Promise<PatrolPaneIdentity[]>;
	readActiveTargets(projectName: string): Promise<readonly string[]>;
	getGlobalConfig?: () => Readonly<PatrolConfig>;
	getProjectConfig?: (projectRoot: string) => Readonly<PatrolConfig>;
	now?: () => number;
	alertFailure?: (failure: PatrolOrphanFailure) => Promise<void>;
	log?: (message: string) => void;
	deadlineMs?: number;
}

export function activePatrolTargets(
	sessions: readonly { tmux_window: string; lead_id: string | null }[],
): string[] {
	const boundSessions = sessions.filter(
		(session) => !session.tmux_window.endsWith(":pending"),
	);
	if (boundSessions.some((session) => !session.lead_id?.trim())) {
		throw new Error(
			"active owner index contains an incomplete session registration",
		);
	}
	return boundSessions.map((session) => session.tmux_window).filter(Boolean);
}

export function parsePatrolPaneList(stdout: string): PatrolPaneIdentity[] {
	const panes: PatrolPaneIdentity[] = [];
	for (const line of stdout.split("\n")) {
		if (!line) continue;
		const fields = line.split("\t");
		const [
			paneId = "",
			panePid = "",
			sessionCreated = "",
			sessionName = "",
			windowId = "",
			...windowNameFields
		] = fields;
		const windowName = windowNameFields.join("\t");
		if (
			fields.length < 6 ||
			!/^%\d+$/.test(paneId) ||
			!/^\d+$/.test(panePid) ||
			!/^\d+$/.test(sessionCreated) ||
			!sessionName ||
			!/^@\d+$/.test(windowId)
		) {
			throw new Error("tmux pane row is missing required identity fields");
		}
		if (
			!windowName ||
			windowName.includes("\t") ||
			!sessionName.startsWith("runner-") ||
			!CANONICAL_WINDOW_NAME.test(windowName)
		)
			continue;
		panes.push({
			projectName: sessionName.slice("runner-".length),
			target: `${sessionName}:${windowId}`,
			paneId,
			panePid,
			sessionCreated,
		});
	}
	return panes;
}

export async function listPatrolPanes(
	runExec: PatrolExecFile = execFile as unknown as PatrolExecFile,
): Promise<PatrolPaneIdentity[]> {
	const result = await runExec(
		"tmux",
		[
			"list-panes",
			"-a",
			"-F",
			"#{pane_id}\t#{pane_pid}\t#{session_created}\t#{session_name}\t#{window_id}\t#{window_name}",
		],
		{
			encoding: "utf8",
			env: { ...process.env, TMUX: "" },
			timeout: PATROL_TMUX_TIMEOUT_MS,
			maxBuffer: PATROL_TMUX_MAX_BUFFER,
			killSignal: "SIGKILL",
		},
	);
	return parsePatrolPaneList(String(result.stdout));
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function slotStart(nowMs: number, intervalMs: number): number {
	return Math.floor(nowMs / intervalMs) * intervalMs;
}

function paneFingerprint(panes: PatrolPaneIdentity[]): string {
	return panes
		.map((pane) => `${pane.paneId}:${pane.panePid}:${pane.sessionCreated}`)
		.sort()
		.join(",");
}

async function emitFailure(
	deps: PatrolOrphanSweeperDeps,
	failure: PatrolOrphanFailure,
): Promise<boolean> {
	if (!deps.alertFailure) return false;
	try {
		await deps.alertFailure(failure);
		return true;
	} catch (error) {
		deps.log?.(
			`[patrol_orphan] alert failure episode=${failure.episodeId}: ${errorDetail(error)}`,
		);
		return false;
	}
}

async function runPatrolOrphanSweep(
	deps: PatrolOrphanSweeperDeps,
	isCurrent: () => boolean = () => true,
): Promise<void> {
	const nowMs = deps.now?.() ?? Date.now();
	const projectByName = new Map(
		deps.projects.map((project) => [project.projectName, project]),
	);
	let panes: PatrolPaneIdentity[];
	const activeTargets = new Set<string>();
	const intervals = new Map<string, number>();
	try {
		const globalConfig =
			deps.getGlobalConfig?.() ?? getGlobalPatrolConfigSnapshot().config;
		panes = await (deps.listPanes ?? listPatrolPanes)();
		if (!isCurrent()) return;
		for (const project of deps.projects) {
			const projectConfig =
				deps.getProjectConfig?.(project.projectRoot) ??
				getProjectPatrolConfigSnapshot(project.projectRoot).config;
			intervals.set(
				project.projectName,
				effectivePatrolIntervalMs(projectConfig, globalConfig),
			);
			const projectTargets = await deps.readActiveTargets(project.projectName);
			if (!isCurrent()) return;
			for (const target of projectTargets) {
				if (target) activeTargets.add(target);
			}
		}
	} catch (error) {
		if (!isCurrent()) return;
		const detail = errorDetail(error);
		deps.log?.(`[patrol_orphan] owner index incomplete: ${detail}`);
		await emitFailure(deps, {
			kind: "orphan_pane",
			condition: "owner_index_incomplete",
			projectName: "machine",
			target: null,
			detail,
			episodeId: `owner-index-incomplete:${Math.floor(nowMs / ORPHAN_ALERT_COOLDOWN_MS)}`,
		});
		return;
	}
	if (!isCurrent()) return;

	const panesByTarget = new Map<string, PatrolPaneIdentity[]>();
	for (const pane of panes) {
		if (!projectByName.has(pane.projectName)) continue;
		const group = panesByTarget.get(pane.target) ?? [];
		group.push(pane);
		panesByTarget.set(pane.target, group);
	}
	const unclaimedTargets = new Set<string>();
	for (const [target, targetPanes] of panesByTarget) {
		if (!isCurrent()) return;
		if (activeTargets.has(target)) continue;
		unclaimedTargets.add(target);
		const projectName = targetPanes[0]?.projectName;
		const intervalMs = projectName ? intervals.get(projectName) : undefined;
		if (!projectName || !intervalMs) continue;
		const currentSlotStart = slotStart(nowMs, intervalMs);
		const fingerprint = paneFingerprint(targetPanes);
		const previous = deps.store.getPatrolOrphanWatch(target);
		const continues =
			previous?.paneFingerprint === fingerprint &&
			previous.intervalMs === intervalMs &&
			currentSlotStart === previous.lastSlotStart + intervalMs;
		const sameSlot =
			previous?.paneFingerprint === fingerprint &&
			previous.intervalMs === intervalMs &&
			previous.lastSlotStart === currentSlotStart;
		if (sameSlot) continue;
		const next: PatrolOrphanWatch = {
			target,
			paneFingerprint: fingerprint,
			firstSeenAt: continues ? previous.firstSeenAt : nowMs,
			streak: continues ? previous.streak + 1 : 1,
			lastSlotStart: currentSlotStart,
			intervalMs,
			lastAlertAt: continues ? previous.lastAlertAt : null,
		};
		if (
			next.streak >= 2 &&
			(next.lastAlertAt === null ||
				nowMs - next.lastAlertAt >= ORPHAN_ALERT_COOLDOWN_MS)
		) {
			if (!isCurrent()) return;
			const alerted = await emitFailure(deps, {
				kind: "orphan_pane",
				condition: "unclaimed",
				projectName,
				target,
				detail: `${target} has no running/blocked owner for ${next.streak} consecutive patrol slots`,
				episodeId: `orphan:${target}:${Math.floor(nowMs / ORPHAN_ALERT_COOLDOWN_MS)}`,
			});
			if (!isCurrent()) return;
			if (alerted) next.lastAlertAt = nowMs;
		}
		if (!isCurrent()) return;
		deps.store.upsertPatrolOrphanWatch(next);
	}

	for (const watch of deps.store.listPatrolOrphanWatches()) {
		if (!isCurrent()) return;
		if (!unclaimedTargets.has(watch.target)) {
			deps.store.deletePatrolOrphanWatch(watch.target);
		}
	}
	const slots = [...intervals.entries()]
		.map(
			([projectName, intervalMs]) =>
				`${projectName}:${slotStart(nowMs, intervalMs)}`,
		)
		.sort()
		.join(",");
	if (!isCurrent()) return;
	deps.log?.(
		`[patrol_orphan] success slots=${slots} registry=complete commdb=complete canonical_panes=${panes.length} unclaimed=${unclaimedTargets.size}`,
	);
}

/** Independent single-flight rider on GatePoller's existing timer. */
export function createPatrolOrphanSweeperPass(
	deps: PatrolOrphanSweeperDeps,
): () => Promise<void> {
	let inFlight: Promise<void> | null = null;
	return () => {
		if (inFlight) return inFlight;
		let abandoned = false;
		const pass = Promise.resolve().then(() =>
			runPatrolOrphanSweep(deps, () => !abandoned),
		);
		const guarded = pass.finally(() => {
			clearTimeout(deadlineTimer);
			if (inFlight === guarded) inFlight = null;
		});
		const deadlineTimer = setTimeout(() => {
			if (inFlight !== guarded) return;
			abandoned = true;
			inFlight = null;
			const nowMs = deps.now?.() ?? Date.now();
			deps.log?.(
				"[patrol_orphan] deadline released single-flight latch after sweep timeout",
			);
			void emitFailure(deps, {
				kind: "orphan_pane",
				condition: "owner_index_incomplete",
				projectName: "machine",
				target: null,
				detail: "patrol orphan sweep exceeded its wall-clock deadline",
				episodeId: `sweep-timeout:${Math.floor(nowMs / ORPHAN_ALERT_COOLDOWN_MS)}`,
			});
		}, deps.deadlineMs ?? PATROL_SWEEP_DEADLINE_MS);
		inFlight = guarded;
		return guarded;
	};
}
