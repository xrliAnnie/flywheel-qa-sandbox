import { createHash } from "node:crypto";
import type { AccountStore } from "./account-store.js";
import {
	type AffectedPane,
	affectedPaneInstanceKey,
	computeModelReviveExpiresAt,
	MAX_MODEL_PANE_SUPPRESSIONS,
	type ModelDetectionIntent,
	type QuotaMonitorState,
} from "./quota-monitor-state.js";
import type { QuotaPaneRef } from "./quota-revive-scan.js";
import { canonicalizeModels } from "./quota-trigger.js";
import type { SwitchResult } from "./switch-executor.js";

type SwitchedResult = Extract<SwitchResult, { outcome: "switched" }>;

export interface ModelPaneDetection {
	pane: QuotaPaneRef;
	model: string;
}

export function createModelDetectionIntent(input: {
	socket: string;
	observedGeneration: number;
	observedAt: number;
	sourceAccount: string;
	detections: readonly ModelPaneDetection[];
}): ModelDetectionIntent {
	const models = canonicalizeModels(input.detections.map((item) => item.model));
	if (models === null) throw new Error("model detection must not be empty");
	const byIdentity = new Map<string, AffectedPane>();
	for (const { pane } of input.detections) {
		const affected: AffectedPane = {
			socket: input.socket,
			paneId: pane.paneId,
			panePid: pane.panePid,
			sessionName: pane.sessionName,
			windowName: pane.windowName,
		};
		byIdentity.set(affectedPaneInstanceKey(affected), affected);
	}
	const affectedPanes = [...byIdentity.values()].sort((a, b) => {
		const aKey = affectedPaneInstanceKey(a);
		const bKey = affectedPaneInstanceKey(b);
		return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
	});
	if (affectedPanes.length === 0) {
		throw new Error("model detection must include an affected pane");
	}
	if (affectedPanes.length > 64) {
		throw new Error("model detection exceeds the 64-pane limit");
	}
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify({
				generation: input.observedGeneration,
				sourceAccount: input.sourceAccount,
				models,
				panes: affectedPanes.map(affectedPaneInstanceKey),
			}),
		)
		.digest("hex")
		.slice(0, 16);
	return {
		eventId: `model-cap-g${input.observedGeneration}-${fingerprint}`,
		observedGeneration: input.observedGeneration,
		observedAt: input.observedAt,
		sourceAccount: input.sourceAccount,
		models,
		affectedPanes,
	};
}

function assertMatchingSwitch(
	detection: ModelDetectionIntent,
	switched: SwitchedResult,
): Record<string, string> {
	if (
		switched.from !== detection.sourceAccount ||
		switched.generation !== detection.observedGeneration + 1
	) {
		throw new Error("model switch generation/source does not match detection");
	}
	if (switched.benchUntilByModel === undefined) {
		throw new Error("model switch result is missing per-model bench deadlines");
	}
	const benchModels = canonicalizeModels(
		Object.keys(switched.benchUntilByModel),
	);
	if (
		benchModels === null ||
		JSON.stringify(benchModels) !== JSON.stringify(detection.models)
	) {
		throw new Error("model switch result bench set does not match detection");
	}
	return switched.benchUntilByModel;
}

export function finalizeModelSwitchIncident(
	inputState: QuotaMonitorState,
	input: {
		detectionEventId: string;
		switched: SwitchedResult;
		finalizedAt: number;
		confirmDelayMs: number;
	},
): QuotaMonitorState {
	const state = structuredClone(inputState);
	const detection = state.pendingDetection;
	if (detection === null || detection.eventId !== input.detectionEventId) {
		throw new Error("model switch detection intent is missing or stale");
	}
	const benchUntilByModel = assertMatchingSwitch(detection, input.switched);
	const expiresAt = computeModelReviveExpiresAt(
		benchUntilByModel,
		input.finalizedAt,
	);
	if (expiresAt === null) {
		throw new Error("model switch result has no bounded revive deadline");
	}
	if (!Number.isFinite(input.confirmDelayMs) || input.confirmDelayMs < 0) {
		throw new Error("confirmation delay must be non-negative");
	}
	const confirmDueAt = input.finalizedAt + input.confirmDelayMs;
	state.observedGeneration = input.switched.generation;
	state.lastSwitchAt = input.finalizedAt;
	state.pendingDetection = null;
	state.confirmDueAt = confirmDueAt;
	state.confirmation = {
		eventId: `${detection.eventId}:confirm`,
		generation: input.switched.generation,
		dueAt: confirmDueAt,
		sourceAccount: input.switched.from,
		targetAccount: input.switched.to,
		models: detection.models,
		affectedPanes: detection.affectedPanes,
	};
	state.reviveEpoch = {
		open: true,
		sourceAccount: input.switched.from,
		generation: input.switched.generation,
		openedAt: input.finalizedAt,
		expiresAt,
		trigger: { kind: "model", models: detection.models },
		panes: {},
	};
	for (const pane of detection.affectedPanes) {
		const key = affectedPaneInstanceKey(pane);
		const models = canonicalizeModels([
			...(state.modelPaneSuppressions[key]?.models ?? []),
			...detection.models,
		]);
		if (models === null) {
			throw new Error("model pane suppression must not be empty");
		}
		state.modelPaneSuppressions[key] = {
			models,
			lastSeenAt: input.finalizedAt,
		};
	}
	const suppressions = Object.entries(state.modelPaneSuppressions).sort(
		([aKey, a], [bKey, b]) =>
			a.lastSeenAt - b.lastSeenAt || (aKey < bKey ? -1 : aKey > bKey ? 1 : 0),
	);
	for (const [key] of suppressions.slice(
		0,
		Math.max(0, suppressions.length - MAX_MODEL_PANE_SUPPRESSIONS),
	)) {
		delete state.modelPaneSuppressions[key];
	}
	return state;
}

export function recoverCommittedModelSwitchIncident(
	state: QuotaMonitorState,
	store: AccountStore,
	opts: { nowMs: number; confirmDelayMs: number },
): { state: QuotaMonitorState; recovered: boolean; reason?: string } {
	const detection = state.pendingDetection;
	if (detection === null) return { state, recovered: false };
	if (store.generation !== detection.observedGeneration + 1) {
		return { state, recovered: false, reason: "generation_mismatch" };
	}
	if (
		store.activeAccount === null ||
		store.activeAccount === detection.sourceAccount
	) {
		return { state, recovered: false, reason: "active_account_not_switched" };
	}
	const source = store.accounts.find(
		(account) => account.name === detection.sourceAccount,
	);
	const benchUntilByModel: Record<string, string> = {};
	for (const model of detection.models) {
		const until = source?.modelCaps?.[model]?.until;
		if (until === undefined || !Number.isFinite(Date.parse(until))) {
			return { state, recovered: false, reason: "model_bench_missing" };
		}
		benchUntilByModel[model] = until;
	}
	return {
		recovered: true,
		state: finalizeModelSwitchIncident(state, {
			detectionEventId: detection.eventId,
			switched: {
				outcome: "switched",
				from: detection.sourceAccount,
				to: store.activeAccount,
				generation: store.generation,
				benchUntilByModel,
			},
			finalizedAt: opts.nowMs,
			confirmDelayMs: opts.confirmDelayMs,
		}),
	};
}
