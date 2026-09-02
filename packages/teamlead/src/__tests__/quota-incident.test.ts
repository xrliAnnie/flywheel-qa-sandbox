import { describe, expect, it } from "vitest";
import type { AccountStore } from "../account-heal/account-store.js";
import {
	createModelDetectionIntent,
	finalizeModelSwitchIncident,
	recoverCommittedModelSwitchIncident,
} from "../account-heal/quota-incident.js";
import {
	emptyQuotaMonitorState,
	MAX_MODEL_PANE_SUPPRESSIONS,
} from "../account-heal/quota-monitor-state.js";

const NOW = Date.parse("2026-07-14T20:00:00Z");
const pane = (paneId: string, panePid: number) => ({
	paneId,
	panePid,
	sessionName: "flywheel",
	windowName: `FLY-${panePid}-claude-runner`,
	currentCommand: "2.1.211",
	dead: false,
	qaInjection: false,
});

describe("model-cap incident ledger", () => {
	it("creates a canonical stable detection id and deduplicated pane-instance list", () => {
		const first = createModelDetectionIntent({
			socket: "flywheel",
			observedGeneration: 7,
			observedAt: NOW,
			sourceAccount: "shopping",
			detections: [
				{ pane: pane("%2", 4_002), model: "Sonnet 5" },
				{ pane: pane("%1", 4_001), model: "Fable 5" },
				{ pane: pane("%1", 4_001), model: "Fable 5" },
			],
		});
		const reordered = createModelDetectionIntent({
			socket: "flywheel",
			observedGeneration: 7,
			observedAt: NOW + 999,
			sourceAccount: "shopping",
			detections: [
				{ pane: pane("%1", 4_001), model: "Fable 5" },
				{ pane: pane("%2", 4_002), model: "Sonnet 5" },
			],
		});

		expect(first.eventId).toBe(reordered.eventId);
		expect(first.models).toEqual(["Fable 5", "Sonnet 5"]);
		expect(first.affectedPanes.map((item) => item.paneId)).toEqual([
			"%1",
			"%2",
		]);
		expect(first.observedAt).toBe(NOW);
		expect(() =>
			createModelDetectionIntent({
				socket: "flywheel",
				observedGeneration: 7,
				observedAt: NOW,
				sourceAccount: "shopping",
				detections: Array.from({ length: 65 }, (_, index) => ({
					pane: pane(`%${index + 10}`, 5_000 + index),
					model: "Fable 5",
				})),
			}),
		).toThrow("pane limit");
	});

	it("finalizes only the matching next generation and leaves confirmation without a duplicate switch alert", () => {
		const detection = createModelDetectionIntent({
			socket: "flywheel",
			observedGeneration: 7,
			observedAt: NOW,
			sourceAccount: "shopping",
			detections: [{ pane: pane("%1", 4_001), model: "Fable 5" }],
		});
		const state = emptyQuotaMonitorState(7);
		state.pendingDetection = detection;
		const benchUntil = new Date(NOW + 30 * 60_000).toISOString();

		const finalized = finalizeModelSwitchIncident(state, {
			detectionEventId: detection.eventId,
			switched: {
				outcome: "switched",
				from: "shopping",
				to: "school",
				generation: 8,
				benchUntilByModel: { "Fable 5": benchUntil },
			},
			finalizedAt: NOW + 1_000,
			confirmDelayMs: 7 * 60_000,
		});

		expect(finalized).toMatchObject({
			version: 2,
			observedGeneration: 8,
			lastSwitchAt: NOW + 1_000,
			pendingDetection: null,
			confirmDueAt: NOW + 7 * 60_000 + 1_000,
			confirmation: {
				generation: 8,
				sourceAccount: "shopping",
				targetAccount: "school",
				models: ["Fable 5"],
			},
			reviveEpoch: {
				generation: 8,
				trigger: { kind: "model", models: ["Fable 5"] },
			},
		});
		expect(finalized.alertOutbox).toEqual([]);
		expect(finalized.reviveEpoch?.expiresAt).toBe(
			Date.parse(benchUntil) + 30 * 60_000,
		);
		expect(finalized.modelPaneSuppressions).toEqual({
			"flywheel:%1:4001": {
				models: ["Fable 5"],
				lastSeenAt: NOW + 1_000,
			},
		});

		expect(() =>
			finalizeModelSwitchIncident(state, {
				detectionEventId: detection.eventId,
				switched: {
					outcome: "switched",
					from: "shopping",
					to: "school",
					generation: 9,
					benchUntilByModel: { "Fable 5": benchUntil },
				},
				finalizedAt: NOW,
				confirmDelayMs: 7 * 60_000,
			}),
		).toThrow("generation");
	});

	it("bounds suppressions on write by evicting the least recently seen pane", () => {
		const detection = createModelDetectionIntent({
			socket: "flywheel",
			observedGeneration: 7,
			observedAt: NOW,
			sourceAccount: "shopping",
			detections: [{ pane: pane("%1", 4_001), model: "Fable 5" }],
		});
		const state = emptyQuotaMonitorState(7);
		state.pendingDetection = detection;
		for (let index = 0; index < MAX_MODEL_PANE_SUPPRESSIONS; index++) {
			state.modelPaneSuppressions[`legacy:${index}`] = {
				models: ["Fable 5"],
				lastSeenAt: NOW - MAX_MODEL_PANE_SUPPRESSIONS + index,
			};
		}
		const benchUntil = new Date(NOW + 30 * 60_000).toISOString();

		const finalized = finalizeModelSwitchIncident(state, {
			detectionEventId: detection.eventId,
			switched: {
				outcome: "switched",
				from: "shopping",
				to: "school",
				generation: 8,
				benchUntilByModel: { "Fable 5": benchUntil },
			},
			finalizedAt: NOW + 1,
			confirmDelayMs: 7 * 60_000,
		});

		expect(Object.keys(finalized.modelPaneSuppressions)).toHaveLength(
			MAX_MODEL_PANE_SUPPRESSIONS,
		);
		expect(finalized.modelPaneSuppressions["flywheel:%1:4001"]).toBeDefined();
		expect(finalized.modelPaneSuppressions["legacy:0"]).toBeUndefined();
	});

	it("recovers the switch-committed/state-not-finalized crash point from store generation and model benches", () => {
		const detection = createModelDetectionIntent({
			socket: "flywheel",
			observedGeneration: 7,
			observedAt: NOW,
			sourceAccount: "shopping",
			detections: [{ pane: pane("%1", 4_001), model: "Fable 5" }],
		});
		const state = emptyQuotaMonitorState(8);
		state.pendingDetection = detection;
		const benchUntil = new Date(NOW + 30 * 60_000).toISOString();
		const store: AccountStore = {
			generation: 8,
			activeAccount: "school",
			accounts: [
				{
					name: "shopping",
					modelCaps: {
						"Fable 5": { until: benchUntil, backoffMs: 30 * 60_000 },
					},
				},
				{ name: "school" },
			],
		};

		const recovered = recoverCommittedModelSwitchIncident(state, store, {
			nowMs: NOW + 5_000,
			confirmDelayMs: 7 * 60_000,
		});

		expect(recovered.recovered).toBe(true);
		expect(recovered.state.pendingDetection).toBeNull();
		expect(recovered.state.alertOutbox).toEqual([]);
		expect(recovered.state.confirmation?.targetAccount).toBe("school");
	});
});
