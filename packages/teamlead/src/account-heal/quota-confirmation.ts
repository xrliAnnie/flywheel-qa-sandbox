import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import {
	type AffectedPane,
	affectedPaneInstanceKey,
	type ConfirmationIntent,
	type DurableAlertIntent,
	type QuotaMonitorState,
} from "./quota-monitor-state.js";
import type { QuotaPaneSnapshot } from "./quota-revive-scan.js";

const MAX_CONFIRMATION_BODY_CHARS = 1_700;

export type ConfirmationStatus =
	| "recovered"
	| "still_capped_or_choice"
	| "unknown_in_flight"
	| "capture_failed"
	| "pane_disappeared";

export interface ConfirmationObservation {
	pane: AffectedPane;
	status: "clear" | "capped_or_choice" | "unknown_in_flight" | "capture_failed";
}

export interface ConfirmationPaneResult {
	instanceKey: string;
	pane: AffectedPane;
	status: ConfirmationStatus;
}

export interface ConfirmationResult {
	intent: ConfirmationIntent;
	recovered: number;
	total: number;
	panes: ConfirmationPaneResult[];
}

/**
 * Translate the tick's single fleet snapshot into confirmation inputs. A
 * missing pane is left absent for `pane_disappeared`; every known scan failure
 * is explicit and can never inflate the recovered numerator.
 */
export function confirmationObservationsFromSnapshot(
	intent: ConfirmationIntent,
	snapshot: QuotaPaneSnapshot,
): ConfirmationObservation[] {
	if (snapshot.listError !== undefined || snapshot.socket.length === 0) {
		return intent.affectedPanes.map((pane) => ({
			pane,
			status: "capture_failed",
		}));
	}
	const observations = new Map(
		snapshot.observations.map((observation) => [
			`${snapshot.socket}:${observation.pane.paneId}:${observation.pane.panePid}`,
			observation,
		]),
	);
	const omitted = new Set(
		snapshot.omittedPanes.map(
			(pane) => `${snapshot.socket}:${pane.paneId}:${pane.panePid}`,
		),
	);
	const result: ConfirmationObservation[] = [];
	for (const pane of intent.affectedPanes) {
		const key = affectedPaneInstanceKey(pane);
		if (pane.socket !== snapshot.socket || omitted.has(key)) {
			result.push({ pane, status: "capture_failed" });
			continue;
		}
		const observation = observations.get(key);
		if (observation === undefined) continue;
		if (
			observation.capture === null ||
			!observation.managed ||
			observation.quotaClass === "login_expired"
		) {
			result.push({ pane, status: "capture_failed" });
			continue;
		}
		if (observation.modelVerdict.state === "unknown") {
			result.push({ pane, status: "unknown_in_flight" });
			continue;
		}
		if (
			observation.modelVerdict.state === "capped" ||
			observation.quotaClass === "quota_stuck"
		) {
			result.push({ pane, status: "capped_or_choice" });
			continue;
		}
		result.push({ pane, status: "clear" });
	}
	return result;
}

export function classifyConfirmation(
	intent: ConfirmationIntent,
	observations: readonly ConfirmationObservation[],
): ConfirmationResult {
	const byInstance = new Map(
		observations.map((observation) => [
			affectedPaneInstanceKey(observation.pane),
			observation,
		]),
	);
	const panes = intent.affectedPanes.map((pane): ConfirmationPaneResult => {
		const instanceKey = affectedPaneInstanceKey(pane);
		const observation = byInstance.get(instanceKey);
		let status: ConfirmationStatus;
		switch (observation?.status) {
			case "clear":
				status = "recovered";
				break;
			case "capped_or_choice":
				status = "still_capped_or_choice";
				break;
			case "unknown_in_flight":
				status = "unknown_in_flight";
				break;
			case "capture_failed":
				status = "capture_failed";
				break;
			default:
				status = "pane_disappeared";
		}
		return { instanceKey, pane, status };
	});
	return {
		intent,
		recovered: panes.filter((pane) => pane.status === "recovered").length,
		total: panes.length,
		panes,
	};
}

export function writeConfirmationEvidence(
	result: ConfirmationResult,
	path: string,
): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp.${process.pid}`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, `${JSON.stringify(result, null, 2)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}

function confirmationBody(
	result: ConfirmationResult,
	evidencePath: string,
): string {
	const statusCopy: Record<ConfirmationStatus, string> = {
		recovered: "已确认恢复",
		still_capped_or_choice: "仍受额度限制或在等待账号选择",
		unknown_in_flight: "仍在运行，暂时无法确认",
		capture_failed: "检查失败，暂时无法确认",
		pane_disappeared: "会话已不存在，无法确认",
	};
	const header = `Claude 切号后的恢复检查已完成：**${result.intent.sourceAccount} → ${result.intent.targetAccount}**`;
	const summary = `受影响的 ${result.total} 个会话里，${result.recovered} 个已确认恢复。`;
	const details = result.panes.map(
		(entry) => `${entry.pane.windowName}：${statusCopy[entry.status]}`,
	);
	const full = [header, "", summary, ...details].join("\n");
	if (full.length <= MAX_CONFIRMATION_BODY_CHARS) return full;
	const suffix = `\n… truncated; full_evidence=${evidencePath}`;
	const available = Math.max(0, MAX_CONFIRMATION_BODY_CHARS - suffix.length);
	return `${full.slice(0, available)}${suffix}`.slice(
		0,
		MAX_CONFIRMATION_BODY_CHARS,
	);
}

export function buildConfirmationAlertIntent(
	result: ConfirmationResult,
	opts: { nowMs: number; evidencePath: string },
): DurableAlertIntent {
	return {
		eventId: result.intent.eventId,
		generation: result.intent.generation,
		createdAt: opts.nowMs,
		alert: {
			kind: "quota_switch_confirmation",
			severity: "info",
			title: "Claude quota switch recovery confirmation",
			body: confirmationBody(result, opts.evidencePath),
			signature: `quota-switch-confirmation-g${result.intent.generation}`,
		},
	};
}

export function finalizeConfirmationFromSnapshot(
	inputState: QuotaMonitorState,
	snapshot: QuotaPaneSnapshot,
	opts: { nowMs: number; evidencePath: string },
): QuotaMonitorState {
	const state = structuredClone(inputState);
	const intent = state.confirmation;
	if (intent === null) return state;
	if (intent.dueAt > opts.nowMs) {
		throw new Error("quota confirmation is not due yet");
	}
	if (intent.generation !== state.observedGeneration) {
		throw new Error("quota confirmation generation is stale");
	}
	const result = classifyConfirmation(
		intent,
		confirmationObservationsFromSnapshot(intent, snapshot),
	);
	writeConfirmationEvidence(result, opts.evidencePath);
	const alert = buildConfirmationAlertIntent(result, opts);
	if (!state.alertOutbox.some((item) => item.eventId === alert.eventId)) {
		if (state.alertOutbox.length >= 64) {
			throw new Error("quota monitor alert outbox is full");
		}
		state.alertOutbox.push(alert);
	}
	state.confirmation = null;
	state.confirmDueAt = null;
	return state;
}
