import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { isDoneButRunning as isDoneButRunningSession } from "./done-running-reconciler.js";
import type { QuietSignals } from "./quiet-classifier.js";

export interface CommSignals {
	hasPendingGate: boolean;
	hasRecentOutbound: boolean;
}

export function parseNonNegativeIntEnv(
	raw: string | undefined,
	fallback: number,
): number {
	if (raw === undefined || raw === "") return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const STUCK_COMM_ACTIVITY_MS = 1_800_000;

export function stuckCommActivityMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	return parseNonNegativeIntEnv(
		env.FLYWHEEL_STUCK_COMM_ACTIVITY_MS,
		STUCK_COMM_ACTIVITY_MS,
	);
}

function openCommDb(projectName: string): CommDB | undefined {
	if (/[/\\]|\.\./.test(projectName)) return undefined;
	const dbPath = join(homedir(), ".flywheel", "comm", projectName, "comm.db");
	return existsSync(dbPath) ? CommDB.openReadonly(dbPath) : undefined;
}

export function hasPendingGateFromCommDb(
	executionId: string,
	projectName: string,
): boolean {
	const db = openCommDb(projectName);
	try {
		return db?.hasPendingQuestionsFrom(executionId) ?? false;
	} finally {
		db?.close();
	}
}

export function hasPendingBlockingGateFromCommDb(
	executionId: string,
	projectName: string,
): boolean {
	const db = openCommDb(projectName);
	try {
		return db?.hasPendingBlockingGateFrom(executionId) ?? false;
	} finally {
		db?.close();
	}
}

export function probeCommSignalsFromCommDb(
	executionId: string,
	projectName: string,
	activityWindowMs: number,
): CommSignals {
	const db = openCommDb(projectName);
	if (!db) return { hasPendingGate: false, hasRecentOutbound: false };
	try {
		return {
			hasPendingGate: db.hasPendingQuestionsFrom(executionId),
			hasRecentOutbound:
				activityWindowMs > 0 &&
				db.hasRecentMessagesFrom(
					executionId,
					Math.ceil(activityWindowMs / 1000),
				),
		};
	} finally {
		db.close();
	}
}

export function probeDeclaredStateFromCommDb(
	executionId: string,
	projectName: string,
	nowMs: number,
): "parked" | "long_task" | null {
	const db = openCommDb(projectName);
	try {
		return db?.getEffectiveDeclaredState(executionId, nowMs)?.kind ?? null;
	} finally {
		db?.close();
	}
}

export function probeQuietSignals(
	session: {
		execution_id: string;
		project_name: string;
		status: string;
		session_stage?: string | null;
		decision_route?: string | null;
		pr_number?: number | null;
	},
	opts: { activityWindowMs: number; nowMs: number },
): QuietSignals {
	const comm = probeCommSignalsFromCommDb(
		session.execution_id,
		session.project_name,
		opts.activityWindowMs,
	);
	return {
		status: session.status,
		hasPendingGate: comm.hasPendingGate,
		hasRecentComm: comm.hasRecentOutbound,
		hasPendingReviewSignal: false,
		declaredKind: probeDeclaredStateFromCommDb(
			session.execution_id,
			session.project_name,
			opts.nowMs,
		),
		isDoneButRunning: isDoneButRunningSession({
			status: session.status,
			session_stage: session.session_stage,
			decision_route: session.decision_route,
			pr_number: session.pr_number,
		}),
	};
}
