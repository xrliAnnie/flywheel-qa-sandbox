import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { grantPrelaunchWorkflowTurn } from "../workflow-turn-bundle.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("grantPrelaunchWorkflowTurn", () => {
	it("atomically grants the activation bundle and projects the persisted epoch", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1614-spawn-turn-"));
		dirs.push(dir);
		const db = new CommDB(join(dir, "comm.db"));
		const projectTurn = vi.fn(() => ({
			ok: true as const,
			idempotentReplay: false,
		}));
		try {
			grantPrelaunchWorkflowTurn({
				db,
				issueId: "FLY-1614",
				projectName: "flywheel",
				executionId: "qa-1",
				phase: "qa",
				grantedAtMs: Date.parse("2026-08-11T08:00:00.000Z"),
				generalizedExecution: {
					engineOwned: true,
					executionId: "qa-1",
					activationId: "activation:qa-1",
					runId: "run-1",
					nodeId: "qa",
					attempt: 2,
					snapshotDigest: "snapshot-1",
					gateCarrierEpoch: 1,
					dispatch: { vendor: "codex", model: "gpt-5" },
					capabilities: {},
					agentContent: "",
					outputCredential: "output-1",
					submissionCredential: "submit-1",
					idempotencyKey: "engine:run-1:qa:2",
					projectTurn,
				},
			});
			const turn = db.getTurn("FLY-1614");
			expect(turn).toMatchObject({
				holder_exec_id: "qa-1",
				phase: "qa",
				target_run_id: "run-1",
				target_node_id: "qa",
				target_attempt: 2,
				activation_id: "activation:qa-1",
			});
			expect(db.getRunnerWorkflowActivation("qa-1", 1)).toMatchObject({
				activation_id: "activation:qa-1",
				output_credential: "output-1",
				submission_credential: "submit-1",
			});
			expect(projectTurn).toHaveBeenCalledWith({
				activationId: "activation:qa-1",
				issueId: "FLY-1614",
				executionId: "qa-1",
				epoch: 1,
				sourceEventId: "turn:spawn:qa-1",
				grantedAt: "2026-08-11T08:00:00.000Z",
			});
		} finally {
			db.close();
		}
	});

	it("fails closed before launch when the activation or projection is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1614-spawn-turn-fail-"));
		dirs.push(dir);
		const db = new CommDB(join(dir, "comm.db"));
		try {
			expect(() =>
				grantPrelaunchWorkflowTurn({
					db,
					issueId: "FLY-1614",
					projectName: "flywheel",
					executionId: "qa-1",
					phase: "qa",
					grantedAtMs: Date.now(),
					generalizedExecution: {
						engineOwned: true,
						executionId: "qa-1",
						runId: "run-1",
						nodeId: "qa",
						attempt: 2,
						snapshotDigest: "snapshot-1",
						gateCarrierEpoch: 1,
						dispatch: { vendor: "codex", model: "gpt-5" },
						capabilities: {},
						agentContent: "",
						idempotencyKey: "engine:run-1:qa:2",
					},
				}),
			).toThrow("engine workflow TURN bundle missing activation or projection");
		} finally {
			db.close();
		}
	});

	it("keeps the workflow node identity when a custom node id has an implement role", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1614-custom-node-turn-"));
		dirs.push(dir);
		const db = new CommDB(join(dir, "comm.db"));
		try {
			grantPrelaunchWorkflowTurn({
				db,
				issueId: "FLY-1614",
				projectName: "flywheel",
				executionId: "build-1",
				phase: "implement",
				grantedAtMs: Date.parse("2026-08-11T08:00:00.000Z"),
				generalizedExecution: {
					engineOwned: true,
					executionId: "build-1",
					activationId: "activation:build-1",
					runId: "run-1",
					nodeId: "build",
					attempt: 1,
					snapshotDigest: "snapshot-1",
					gateCarrierEpoch: 1,
					dispatch: { vendor: "codex", model: "gpt-5" },
					capabilities: {},
					agentContent: "",
					idempotencyKey: "engine:run-1:build:1",
					projectTurn: () => ({ ok: true, idempotentReplay: false }),
				},
			});
			expect(db.getTurn("FLY-1614")).toMatchObject({
				phase: "implement",
				target_node_id: "build",
			});
			expect(db.getRunnerWorkflowActivation("build-1", 1)).toMatchObject({
				node_id: "build",
			});
		} finally {
			db.close();
		}
	});
});
