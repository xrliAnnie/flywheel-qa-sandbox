import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import { hashCapabilityToken } from "../workflow-claims.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";

describe("FLY-2211 codex recovery authority", () => {
	const stores: StateStore[] = [];
	const roots: string[] = [];

	afterEach(() => {
		for (const store of stores.splice(0)) store.close();
		for (const root of roots.splice(0))
			rmSync(root, { recursive: true, force: true });
	});

	async function fixture(): Promise<StateStore> {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		store.upsertSession({
			execution_id: "exec-reown",
			issue_id: "FLY-2211",
			project_name: "flywheel",
			status: "running",
			adapter_type: "codex-tmux",
		});
		return store;
	}

	function enrollOutputExecution(store: StateStore): string {
		const root = mkdtempSync(join(tmpdir(), "fly2211-recovery-"));
		roots.push(root);
		mkdirSync(join(root, "agents"));
		writeFileSync(
			join(root, "agents", "generic.md"),
			"Produce output safely.\n",
		);
		const snapshot = buildWorkflowRunSnapshotV2({
			template: { id: "tpl-recovery", revision: 1 },
			canonicalRoot: root,
			manifest: {
				schema_version: 2,
				nodes: [
					{
						id: "execute",
						type: "generic",
						vendor: "codex",
						model: "gpt-5.6-sol",
						effort: "low",
						agent_file: "agents/generic.md",
						produces_output: true,
						output: { schema: "json_v1", max_bytes: 128 },
					},
					{ id: "founder_gate", type: "gate" },
				],
				edges: [
					{
						id: "done",
						from: "execute",
						to: "founder_gate",
						condition: "node_done",
					},
				],
				loops: [],
				terminal_gate: { node: "founder_gate", predicate: "founder_approved" },
				ship_claims: ["founder_approved"],
			},
		});
		store.createWorkflowRun({
			runId: "run-recovery",
			issueId: "FLY-2211",
			projectName: "flywheel",
			snapshotJson: JSON.stringify(snapshot),
			claimsReadEnrolled: false,
		});
		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: "run-recovery",
			nodeId: "execute",
			executionId: "exec-reown",
			attempt: 1,
			now: "2026-08-31T20:00:00.000Z",
			expiresAt: "2026-08-31T21:00:00.000Z",
			absoluteDeadlineAt: "2026-09-01T20:00:00.000Z",
		});
		if (!admitted.ok || !admitted.outputCredential) {
			throw new Error("output execution admission failed");
		}
		return admitted.outputCredential;
	}

	it("preclaims each attempt atomically and caps one open episode", async () => {
		const store = await fixture();
		const first = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge-a",
			nowMs: 1_000,
			ttlMs: 500,
			maxAttempts: 2,
		});
		expect(first).toMatchObject({ ok: true, attempt: 1 });

		expect(
			store.claimCodexRecovery("exec-reown", 0, {
				holder: "bridge-b",
				nowMs: 1_100,
				ttlMs: 500,
				maxAttempts: 2,
			}),
		).toMatchObject({ ok: false, reason: "lease_held" });
		if (!first.ok) throw new Error("claim unexpectedly failed");
		expect(store.abortCodexRecovery("exec-reown", "wrong-token")).toBe(false);
		expect(store.abortCodexRecovery("exec-reown", first.claimToken)).toBe(true);

		const second = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge-b",
			nowMs: 1_200,
			ttlMs: 500,
			maxAttempts: 2,
		});
		expect(second).toMatchObject({
			ok: true,
			attempt: 2,
			episodeId: first.episodeId,
		});
		if (!second.ok) throw new Error("claim unexpectedly failed");
		expect(store.abortCodexRecovery("exec-reown", second.claimToken)).toBe(
			true,
		);

		expect(
			store.claimCodexRecovery("exec-reown", 0, {
				holder: "bridge-c",
				nowMs: 1_300,
				ttlMs: 500,
				maxAttempts: 2,
			}),
		).toMatchObject({
			ok: false,
			reason: "episode_exhausted",
			attempts: 2,
		});
	});

	it("takes over an expired lease without resetting the open episode", async () => {
		const store = await fixture();
		const first = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge-a",
			nowMs: 1_000,
			ttlMs: 100,
		});
		if (!first.ok) throw new Error("claim unexpectedly failed");

		const takeover = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge-b",
			nowMs: 1_101,
			ttlMs: 100,
		});
		expect(takeover).toMatchObject({
			ok: true,
			attempt: 2,
			episodeId: first.episodeId,
		});
	});

	it("refunds an attempt when a clean fence abort releases the claim", async () => {
		const store = await fixture();
		const first = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge-a",
			nowMs: 1_000,
			ttlMs: 500,
			maxAttempts: 2,
		});
		if (!first.ok) throw new Error("claim unexpectedly failed");

		expect(
			store.abortCodexRecovery("exec-reown", first.claimToken, {
				releaseAttempt: true,
			}),
		).toBe(true);
		expect(store.getCodexRecoveryEpisode("exec-reown")).toMatchObject({
			episodeState: "open",
			episodeAttempts: 0,
			claimToken: null,
		});

		const retry = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge-b",
			nowMs: 1_100,
			ttlMs: 500,
			maxAttempts: 2,
		});
		expect(retry).toMatchObject({
			ok: true,
			attempt: 1,
			episodeId: first.episodeId,
		});
	});

	it("commits only the token-bound owner after TURN observation and advances revision", async () => {
		const store = await fixture();
		const claim = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge-a",
			nowMs: 1_000,
			ttlMs: 500,
		});
		if (!claim.ok) throw new Error("claim unexpectedly failed");

		expect(
			store.commitCodexRecovery("exec-reown", claim.claimToken, 0, {
				nowMs: 1_100,
				observedTurnHolder: "another-exec",
			}),
		).toEqual({ ok: false, reason: "turn_holder_changed" });
		expect(store.getSession("exec-reown")?.lifecycle_revision).toBe(0);

		expect(
			store.commitCodexRecovery("exec-reown", claim.claimToken, 0, {
				nowMs: 1_100,
				observedTurnHolder: "exec-reown",
			}),
		).toMatchObject({ ok: true, lifecycleRevision: 1 });
		expect(store.getSession("exec-reown")?.lifecycle_revision).toBe(1);
		expect(store.getCodexRecoveryEpisode("exec-reown")).toMatchObject({
			episodeState: "closed",
			episodeAttempts: 0,
			claimToken: null,
		});

		// A waiter that read revision 0 before commit must still lose after release.
		expect(
			store.claimCodexRecovery("exec-reown", 0, {
				holder: "stale-waiter",
				nowMs: 1_200,
				ttlMs: 500,
			}),
		).toEqual({ ok: false, reason: "stale_revision", currentRevision: 1 });
	});

	it("serializes a TURN writer without advancing unrelated lifecycle authority", async () => {
		const store = await fixture();
		const writer = store.claimExecutionMutationLease("exec-reown", 0, {
			holder: "turn-writer",
			nowMs: 1_000,
			ttlMs: 500,
		});
		expect(writer).toMatchObject({ ok: true });
		if (!writer.ok) throw new Error("writer lease unexpectedly failed");

		expect(
			store.claimCodexRecovery("exec-reown", 0, {
				holder: "bridge-recovery",
				nowMs: 1_100,
				ttlMs: 500,
			}),
		).toMatchObject({ ok: false, reason: "lease_held" });
		expect(
			store.commitExecutionMutationLease(
				"exec-reown",
				writer.claimToken,
				0,
				1_200,
			),
		).toEqual({ ok: true, lifecycleRevision: 0 });
		expect(store.getSession("exec-reown")?.lifecycle_revision).toBe(0);

		// Recovery may claim after the writer releases, but the re-owner must then
		// re-read CommDB TURN under that claim and abort before reap/spawn when the
		// belt moved. The writer itself does not own lifecycle CAS authority.
		expect(
			store.claimCodexRecovery("exec-reown", 0, {
				holder: "post-writer-recovery",
				nowMs: 1_300,
				ttlMs: 500,
			}),
		).toMatchObject({ ok: true, attempt: 1 });
	});

	it("makes a TURN writer lose without mutation while recovery owns the lease", async () => {
		const store = await fixture();
		const recovery = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge-recovery",
			nowMs: 1_000,
			ttlMs: 500,
		});
		expect(recovery).toMatchObject({ ok: true });

		expect(
			store.claimExecutionMutationLease("exec-reown", 0, {
				holder: "turn-writer",
				nowMs: 1_100,
				ttlMs: 500,
			}),
		).toMatchObject({ ok: false, reason: "lease_held" });
		expect(store.getSession("exec-reown")?.lifecycle_revision).toBe(0);
	});

	it("refuses recovery once a successor is bound", async () => {
		const store = await fixture();
		store.setRetrySuccessor("exec-reown", "exec-successor");

		expect(
			store.claimCodexRecovery("exec-reown", 0, {
				holder: "bridge-a",
				nowMs: 1_000,
				ttlMs: 500,
			}),
		).toEqual({ ok: false, reason: "superseded" });
	});

	it("reissues generalized workflow capabilities only to the live recovery claim", async () => {
		const store = await fixture();
		const oldOutputCredential = enrollOutputExecution(store);
		const claim = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge-a",
			nowMs: Date.parse("2026-08-31T20:05:00.000Z"),
			ttlMs: 60_000,
		});
		if (!claim.ok) throw new Error("claim unexpectedly failed");

		expect(
			store.prepareCodexRecoveryCapabilities(
				"exec-reown",
				"wrong-token",
				0,
				Date.parse("2026-08-31T20:05:01.000Z"),
			),
		).toEqual({ ok: false, reason: "claim_lost" });

		const prepared = store.prepareCodexRecoveryCapabilities(
			"exec-reown",
			claim.claimToken,
			0,
			Date.parse("2026-08-31T20:05:01.000Z"),
		);
		expect(prepared).toMatchObject({
			ok: true,
			enrolled: true,
			workflowSubmissionExpected: true,
			founderReviewRequired: false,
		});
		if (!prepared.ok || !prepared.workflowOutputCredential) {
			throw new Error("capability preparation failed");
		}
		expect(prepared.workflowOutputCredential).not.toBe(oldOutputCredential);

		const raw = store as unknown as {
			db: {
				raw: {
					prepare(sql: string): {
						get(...params: unknown[]): Record<string, unknown> | undefined;
					};
				};
			};
		};
		const oldRow = raw.db.raw
			.prepare(
				"SELECT revoked, revoked_reason FROM workflow_output_credential WHERE credential_hash = ?",
			)
			.get(hashCapabilityToken(oldOutputCredential));
		const newRow = raw.db.raw
			.prepare(
				"SELECT revoked FROM workflow_output_credential WHERE credential_hash = ?",
			)
			.get(hashCapabilityToken(prepared.workflowOutputCredential));
		expect(oldRow).toMatchObject({
			revoked: 1,
			revoked_reason: "codex_recovery_rotation",
		});
		expect(newRow).toMatchObject({ revoked: 0 });

		// Plaintext is deliberately one-shot; a replay must take a fresh attempt.
		expect(
			store.prepareCodexRecoveryCapabilities(
				"exec-reown",
				claim.claimToken,
				0,
				Date.parse("2026-08-31T20:05:02.000Z"),
			),
		).toEqual({ ok: false, reason: "capabilities_already_prepared" });
	});
});
