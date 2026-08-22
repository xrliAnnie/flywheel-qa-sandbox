import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	reconcileWorkflowTurnLedgers,
	type WorkflowTurnExpectation,
} from "../workflow-turn-ledger-validator.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("reconcileWorkflowTurnLedgers", () => {
	it("re-reads both ledgers, opens one durable divergence, then closes it on recovery", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1614-ledger-validator-"));
		dirs.push(dir);
		const dbPath = join(dir, "comm.db");
		const db = new CommDB(dbPath);
		db.grantTurn("FLY-1614", "qa-old", "qa", 1_700_000_000_000);
		db.close();
		let expectation: WorkflowTurnExpectation = {
			expectationKey: "activation:run-1:implement:2:activation-2:1",
			runId: "run-1",
			nodeId: "implement",
			issueId: "FLY-1614",
			projectName: "flywheel",
			executionId: "implement-2",
			epoch: 1,
			activationId: "activation-2",
			requiredSince: "2026-08-11T00:00:00.000Z",
			source: "activation",
		};
		const observe = vi.fn(() => ({ opened: true, alerted: true }));
		const close = vi.fn(() => true);
		const store = {
			listWorkflowTurnExpectations: vi.fn(() => [expectation]),
			listOpenWorkflowTurnDivergences: vi.fn(() => []),
			observeWorkflowTurnDivergence: observe,
			closeWorkflowTurnDivergence: close,
		};
		await reconcileWorkflowTurnLedgers({
			store,
			alertEnabled: false,
			commDbPathForProject: () => dbPath,
			now: new Date("2026-08-11T00:06:00.000Z"),
			graceMs: 5 * 60_000,
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});
		expect(store.listWorkflowTurnExpectations).toHaveBeenCalledTimes(2);
		expect(observe).toHaveBeenCalledOnce();
		expect(observe.mock.calls[0]?.[0]).toMatchObject({
			alertEnabled: false,
			expectedExecutionId: "implement-2",
			expectedEpoch: 1,
			observedExecutionId: "qa-old",
			observedEpoch: 1,
		});

		const repaired = new CommDB(dbPath);
		repaired.grantTurn(
			"FLY-1614",
			"implement-2",
			"implement",
			1_700_000_000_001,
			{
				project: "flywheel",
				sourceEventId: "repair-activation-2",
				activation: {
					activationId: "activation-2",
					runId: "run-1",
					nodeId: "implement",
					attempt: 2,
					context: {},
				},
			},
		);
		repaired.close();
		expectation = { ...expectation, epoch: 2 };
		await reconcileWorkflowTurnLedgers({
			store,
			commDbPathForProject: () => dbPath,
			now: new Date("2026-08-11T00:07:00.000Z"),
			graceMs: 5 * 60_000,
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});
		expect(close).toHaveBeenCalledWith(
			expect.objectContaining({ expectationKey: expectation.expectationKey }),
		);
	});

	it("does not open an episode inside the durable grant grace", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1614-ledger-grace-"));
		dirs.push(dir);
		const dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
		const observe = vi.fn();
		const expectation: WorkflowTurnExpectation = {
			expectationKey: "carrier:q-1:1",
			runId: "run-1",
			nodeId: "founder_gate",
			issueId: "FLY-1614",
			projectName: "flywheel",
			executionId: "implement-1",
			epoch: 1,
			activationId: "carrier-1",
			requiredSince: "2026-08-11T00:00:00.000Z",
			source: "carrier",
		};
		await reconcileWorkflowTurnLedgers({
			store: {
				listWorkflowTurnExpectations: () => [expectation],
				listOpenWorkflowTurnDivergences: () => [],
				observeWorkflowTurnDivergence: observe,
				closeWorkflowTurnDivergence: vi.fn(),
			},
			commDbPathForProject: () => dbPath,
			now: new Date("2026-08-11T00:04:59.999Z"),
			graceMs: 5 * 60_000,
			resolveAlertIdentity: () => ({
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			}),
		});
		expect(observe).not.toHaveBeenCalled();
	});
});
