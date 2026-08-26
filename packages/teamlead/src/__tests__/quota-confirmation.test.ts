import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildConfirmationAlertIntent,
	classifyConfirmation,
	confirmationObservationsFromSnapshot,
	finalizeConfirmationFromSnapshot,
	writeConfirmationEvidence,
} from "../account-heal/quota-confirmation.js";
import {
	type AffectedPane,
	affectedPaneInstanceKey,
	type ConfirmationIntent,
} from "../account-heal/quota-monitor-state.js";
import type { QuotaPaneSnapshot } from "../account-heal/quota-revive-scan.js";

const NOW = Date.parse("2026-07-14T20:00:00Z");
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function pane(index: number, suffix = ""): AffectedPane {
	return {
		socket: "flywheel",
		paneId: `%${index}`,
		panePid: 4_000 + index,
		sessionName: "flywheel",
		windowName: `FLY-${100 + index}-claude-runner${suffix}`,
	};
}

function intent(panes: AffectedPane[]): ConfirmationIntent {
	return {
		eventId: "model-cap-g7-deadbeef:confirm",
		generation: 8,
		dueAt: NOW,
		sourceAccount: "shopping",
		targetAccount: "school",
		models: ["Fable 5"],
		affectedPanes: panes,
	};
}

describe("quota switch confirmation", () => {
	it("derives the five-state input from the shared scan snapshot without treating partial failures as recovery", () => {
		const panes = [pane(1), pane(2), pane(3), pane(4), pane(5), pane(6)];
		const refs = panes.map((item) => ({
			paneId: item.paneId,
			panePid: item.panePid,
			sessionName: item.sessionName,
			windowName: item.windowName,
			currentCommand: "2.1.211",
			dead: false,
			qaInjection: false,
		}));
		const snapshot: QuotaPaneSnapshot = {
			socket: "flywheel",
			capturedAt: NOW,
			listedCount: 5,
			complete: false,
			observations: [
				{
					pane: refs[0],
					capture: "clear",
					managed: true,
					quotaClass: "other",
					modelVerdict: { state: "clear" },
				},
				{
					pane: refs[1],
					capture: "capped",
					managed: true,
					quotaClass: "other",
					modelVerdict: { state: "capped", model: "Fable 5" },
				},
				{
					pane: refs[2],
					capture: "spinner",
					managed: true,
					quotaClass: "other",
					modelVerdict: { state: "unknown", reason: "in flight" },
				},
				{
					pane: refs[3],
					capture: null,
					captureError: "timeout",
					managed: false,
					quotaClass: "other",
					modelVerdict: { state: "clear" },
				},
			],
			omittedPanes: [refs[4]],
		};

		const result = classifyConfirmation(
			intent(panes),
			confirmationObservationsFromSnapshot(intent(panes), snapshot),
		);

		expect(result.panes.map((entry) => entry.status)).toEqual([
			"recovered",
			"still_capped_or_choice",
			"unknown_in_flight",
			"capture_failed",
			"capture_failed",
			"pane_disappeared",
		]);
		expect(result.recovered).toBe(1);
	});

	it("marks every affected pane capture_failed when pane listing itself failed", () => {
		const panes = [pane(1), pane(2)];
		const snapshot: QuotaPaneSnapshot = {
			socket: "flywheel",
			capturedAt: NOW,
			listedCount: 0,
			complete: false,
			observations: [],
			omittedPanes: [],
			listError: "tmux unavailable",
		};

		expect(
			classifyConfirmation(
				intent(panes),
				confirmationObservationsFromSnapshot(intent(panes), snapshot),
			).panes.map((entry) => entry.status),
		).toEqual(["capture_failed", "capture_failed"]);
	});

	it("durably stages the confirmation alert and clears its independent deadline", () => {
		const panes = [pane(1)];
		const ref = {
			paneId: panes[0].paneId,
			panePid: panes[0].panePid,
			sessionName: panes[0].sessionName,
			windowName: panes[0].windowName,
			currentCommand: "2.1.211",
			dead: false,
			qaInjection: false,
		};
		const snapshot: QuotaPaneSnapshot = {
			socket: "flywheel",
			capturedAt: NOW,
			listedCount: 1,
			complete: true,
			observations: [
				{
					pane: ref,
					capture: "clear",
					managed: true,
					quotaClass: "other",
					modelVerdict: { state: "clear" },
				},
			],
			omittedPanes: [],
		};
		const dir = mkdtempSync(join(tmpdir(), "fly1182-confirm-finalize-"));
		dirs.push(dir);
		const evidencePath = join(dir, "confirmation.json");
		const state = {
			version: 2 as const,
			lastPollAt: null,
			lastSuccessfulUsageAt: null,
			errorStreak: 0,
			backoffUntilMs: 0,
			nextUsageDueAt: 0,
			nextPaneScanDueAt: 0,
			confirmDueAt: NOW,
			tier: "base" as const,
			lastCandidateSweepAt: null,
			lastSwitchAt: NOW - 60_000,
			observedGeneration: 8,
			reviveEpoch: null,
			pendingDetection: null,
			alertOutbox: [],
			confirmation: intent(panes),
			unknownPanes: {},
		};

		const finalized = finalizeConfirmationFromSnapshot(state, snapshot, {
			nowMs: NOW,
			evidencePath,
		});

		expect(finalized.confirmDueAt).toBeNull();
		expect(finalized.confirmation).toBeNull();
		expect(finalized.alertOutbox).toEqual([
			expect.objectContaining({
				eventId: "model-cap-g7-deadbeef:confirm",
				alert: expect.objectContaining({
					kind: "quota_switch_confirmation",
					body: expect.stringContaining(
						"受影响的 1 个会话里，1 个已确认恢复。",
					),
				}),
			}),
		]);
		expect(finalized.alertOutbox[0]?.alert.body).toContain(
			"Claude 切号后的恢复检查已完成：**shopping → school**",
		);
		expect(finalized.alertOutbox[0]?.alert.body).not.toMatch(
			/generation=|models=|recovered after/,
		);
		expect(statSync(evidencePath).mode & 0o777).toBe(0o600);
	});

	it("classifies all five recovery states and counts only recovered panes", () => {
		const panes = [pane(1), pane(2), pane(3), pane(4), pane(5)];
		const result = classifyConfirmation(intent(panes), [
			{ pane: panes[0], status: "clear" },
			{ pane: panes[1], status: "capped_or_choice" },
			{ pane: panes[2], status: "unknown_in_flight" },
			{ pane: panes[3], status: "capture_failed" },
		]);

		expect(result.recovered).toBe(1);
		expect(result.total).toBe(5);
		expect(result.panes.map((entry) => entry.status)).toEqual([
			"recovered",
			"still_capped_or_choice",
			"unknown_in_flight",
			"capture_failed",
			"pane_disappeared",
		]);
	});

	it("caps the Discord body at 2000 characters and writes the full 0600 evidence list atomically", () => {
		const panes = Array.from({ length: 40 }, (_, index) =>
			pane(index + 1, `-${"x".repeat(120)}`),
		);
		const result = classifyConfirmation(
			intent(panes),
			panes.map((item) => ({ pane: item, status: "clear" as const })),
		);
		const dir = mkdtempSync(join(tmpdir(), "fly1182-confirm-"));
		dirs.push(dir);
		const evidencePath = join(dir, "confirmation.json");
		writeConfirmationEvidence(result, evidencePath);
		const alert = buildConfirmationAlertIntent(result, {
			nowMs: NOW,
			evidencePath,
		});

		expect(alert.alert.body.length).toBeLessThanOrEqual(1_700);
		expect(alert.alert.body).toContain(
			"受影响的 40 个会话里，40 个已确认恢复。",
		);
		expect(alert.alert.body).toContain(`full_evidence=${evidencePath}`);
		expect(alert.alert.kind).toBe("quota_switch_confirmation");
		expect(alert.alert.signature).toBe("quota-switch-confirmation-g8");
		expect(statSync(evidencePath).mode & 0o777).toBe(0o600);
		const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
		expect(evidence.panes).toHaveLength(40);
		expect(evidence.panes[0].instanceKey).toBe(
			affectedPaneInstanceKey(panes[0]),
		);
	});
});
