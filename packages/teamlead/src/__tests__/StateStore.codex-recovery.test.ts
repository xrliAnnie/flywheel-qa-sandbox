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

	function rawDatabase(store: StateStore): {
		prepare(sql: string): {
			get(...params: unknown[]): Record<string, unknown> | undefined;
			all(...params: unknown[]): Record<string, unknown>[];
			run(...params: unknown[]): unknown;
		};
	} {
		return (
			store as unknown as {
				db: {
					raw: {
						prepare(sql: string): {
							get(...params: unknown[]): Record<string, unknown> | undefined;
							all(...params: unknown[]): Record<string, unknown>[];
							run(...params: unknown[]): unknown;
						};
					};
				};
			}
		).db.raw;
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

	function reenterOutputExecution(store: StateStore): string {
		store.upsertWorkflowRunNode({
			runId: "run-recovery",
			nodeId: "execute",
			attempt: 1,
			state: "done",
			executionId: "exec-reown",
			endedAt: "2026-08-31T20:01:00.000Z",
		});
		store.upsertWorkflowRunNode({
			runId: "run-recovery",
			nodeId: "execute",
			attempt: 2,
			state: "running",
			executionId: "exec-reown",
		});
		const wake = store.admitGeneralizedWorkflowExecution({
			runId: "run-recovery",
			nodeId: "execute",
			executionId: "exec-reown",
			attempt: 2,
			activationId: "activation:rework:test",
			activationMode: "wake",
			reworkRequestId: "rework:test",
			now: "2026-08-31T20:02:00.000Z",
			expiresAt: "2026-08-31T21:02:00.000Z",
			absoluteDeadlineAt: "2026-09-01T20:00:00.000Z",
		});
		if (!wake.ok || !wake.outputCredential) {
			throw new Error("rework output execution admission failed");
		}
		return wake.outputCredential;
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

	it("FLY-2505 migrates legacy recovery budgets additively and preserves them on reopen", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2505-migration-"));
		roots.push(root);
		const path = join(root, "state.db");
		let store = await StateStore.create(path);
		store.upsertSession({
			execution_id: "legacy",
			issue_id: "FLY-2505",
			project_name: "flywheel",
			status: "running",
			adapter_type: "codex-tmux",
		});
		const db = rawDatabase(store);
		db.prepare("DROP TABLE recovery_claim").run();
		db.prepare(`CREATE TABLE recovery_claim (
			execution_id TEXT PRIMARY KEY, claim_token TEXT, holder TEXT,
			acquired_at_ms INTEGER, expires_at_ms INTEGER, episode_id TEXT NOT NULL,
			episode_state TEXT NOT NULL, episode_attempts INTEGER NOT NULL DEFAULT 0,
			expected_lifecycle_revision INTEGER
		)`).run();
		db.prepare(
			"INSERT INTO recovery_claim VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run("legacy", "token", "owner", 100, 200, "episode", "open", 1, 0);
		store.close();
		store = await StateStore.create(path);
		stores.push(store);
		expect(
			rawDatabase(store)
				.prepare("SELECT * FROM recovery_claim WHERE execution_id = ?")
				.get("legacy"),
		).toMatchObject({
			claim_token: "token",
			episode_id: "episode",
			episode_attempts: 1,
			recovery_policy_version: 0,
			reservation_seq: 0,
			lease_purpose: null,
			pending_reservation_until_ms: null,
			episode_lifecycle_revision: null,
			readiness_failures: 0,
			first_readiness_at_ms: null,
			readiness_deadline_ms: null,
			next_retry_at_ms: null,
			last_failure_json: null,
			exhaustion_kind: null,
		});
		store.close();
		stores.pop();
		store = await StateStore.create(path);
		stores.push(store);
		expect(
			rawDatabase(store)
				.prepare(
					"SELECT episode_attempts, reservation_seq FROM recovery_claim WHERE execution_id = ?",
				)
				.get("legacy"),
		).toEqual({ episode_attempts: 1, reservation_seq: 0 });
		expect(
			store.claimCodexRecovery("legacy", 0, {
				holder: "new",
				nowMs: 1000,
				ttlMs: 60000,
			}),
		).toMatchObject({ ok: true, attempt: 2, reservationSeq: 2 });
	});

	it.each(["future acquisition", "invalid readiness deadline"])(
		"FLY-2505 charges an unknown failure instead of holding on %s",
		async (shape) => {
			const store = await fixture();
			const claim = store.claimCodexRecovery("exec-reown", 0, {
				holder: "bridge",
				nowMs: 0,
				ttlMs: 60000,
			});
			if (!claim.ok) throw new Error("claim failed");
			rawDatabase(store)
				.prepare(
					shape === "future acquisition"
						? "UPDATE recovery_claim SET acquired_at_ms = 80000 WHERE execution_id = ?"
						: "UPDATE recovery_claim SET first_readiness_at_ms = 1000, readiness_deadline_ms = 'invalid' WHERE execution_id = ?",
				)
				.run("exec-reown");
			expect(
				store.settleCodexRecoveryFailure(
					"exec-reown",
					claim.claimToken,
					0,
					claim.reservationSeq,
					{
						version: 1,
						code: "daemon_socket_not_ready",
						summary: "Daemon socket not ready",
						stage: "daemon_spawn",
						cleanup: "confirmed_absent",
					},
					70000,
				),
			).toMatchObject({
				ok: true,
				budgetDecision: "charged",
				chargedAttempts: 1,
				failure: { code: "owner_failed_unknown" },
				nextRetryAtMs: null,
			});
			expect(store.getCodexRecoveryDeferral("exec-reown", 70000)).toBe(false);
			expect(
				store.claimCodexRecovery("exec-reown", 0, {
					holder: "new",
					nowMs: 100000,
					ttlMs: 60000,
				}),
			).toMatchObject({ ok: true, attempt: 2 });
		},
	);

	it("FLY-2505 a corrupt cooldown is charged and cannot create an indefinite hold", async () => {
		const store = await fixture();
		const first = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge",
			nowMs: 0,
			ttlMs: 60000,
		});
		if (!first.ok) throw new Error("claim failed");
		store.settleCodexRecoveryFailure(
			"exec-reown",
			first.claimToken,
			0,
			first.reservationSeq,
			{
				version: 1,
				code: "daemon_socket_not_ready",
				summary: "Daemon socket not ready",
				stage: "daemon_spawn",
				cleanup: "confirmed_absent",
			},
			70000,
		);
		rawDatabase(store)
			.prepare(
				"UPDATE recovery_claim SET next_retry_at_ms = 9007199254740991 WHERE execution_id = ?",
			)
			.run("exec-reown");
		expect(
			store.claimCodexRecovery("exec-reown", 0, {
				holder: "bridge",
				nowMs: 100000,
				ttlMs: 60000,
			}),
		).toMatchObject({ ok: false, reason: "retry_not_due", retryAtMs: 100000 });
		expect(
			JSON.parse(
				rawDatabase(store)
					.prepare(
						"SELECT last_failure_json FROM recovery_claim WHERE execution_id = ?",
					)
					.get("exec-reown")!.last_failure_json as string,
			),
		).toMatchObject({
			budgetDecision: "charged",
			chargedAttempts: 1,
			failure: { code: "owner_failed_unknown" },
		});
		expect(
			store.claimCodexRecovery("exec-reown", 0, {
				holder: "bridge",
				nowMs: 130000,
				ttlMs: 60000,
			}),
		).toMatchObject({ ok: true, attempt: 2 });
	});
	it("FLY-2505 rejects overflowing authority deadlines before writing a reservation", async () => {
		const store = await fixture();
		expect(() =>
			store.claimCodexRecovery("exec-reown", 0, {
				holder: "bridge",
				nowMs: 1,
				ttlMs: Number.MAX_SAFE_INTEGER,
			}),
		).toThrow();
		expect(
			rawDatabase(store)
				.prepare(
					"SELECT execution_id FROM recovery_claim WHERE execution_id = ?",
				)
				.get("exec-reown"),
		).toBeUndefined();
	});

	it("settles confirmed readiness after 70 seconds without extending its 60 second authority", async () => {
		const store = await fixture();
		const claim = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge",
			nowMs: 0,
			ttlMs: 60_000,
		});
		if (!claim.ok) throw new Error("claim failed");
		expect(store.getCodexRecoveryDeferral("exec-reown", 69_999)).toMatchObject({
			untilMs: 300_000,
		});
		expect(store.getCodexRecoveryDeferral("exec-reown", 300_000)).toBe(false);
		const failure = {
			version: 1,
			code: "daemon_socket_not_ready",
			stage: "daemon_spawn",
			summary: "Socket not ready",
			cleanup: "confirmed_absent",
		} as const;
		const settled = store.settleCodexRecoveryFailure(
			"exec-reown",
			claim.claimToken,
			0,
			claim.reservationSeq,
			failure,
			70_000,
		);
		expect(settled).toMatchObject({
			ok: true,
			chargedAttempts: 0,
			readinessFailures: 1,
			budgetDecision: "refunded",
			nextRetryAtMs: 100_000,
		});
		expect(
			store.settleCodexRecoveryFailure(
				"exec-reown",
				claim.claimToken,
				0,
				claim.reservationSeq,
				failure,
				71_000,
			),
		).toEqual(settled);
		expect(
			store.claimCodexRecovery("exec-reown", 0, {
				holder: "next",
				nowMs: 99_999,
				ttlMs: 60_000,
			}),
		).toMatchObject({ ok: false, reason: "retry_not_due" });
		expect(
			store.claimCodexRecovery("exec-reown", 0, {
				holder: "next",
				nowMs: 100_000,
				ttlMs: 60_000,
			}),
		).toMatchObject({ ok: true, reservationSeq: 2, attempt: 1 });
	});

	it("FLY-2505 refunded reservations rotate capabilities independently of charged attempts", async () => {
		const store = await fixture();
		enrollOutputExecution(store);
		const first = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge",
			nowMs: 0,
			ttlMs: 60000,
		});
		if (!first.ok) throw new Error("claim failed");
		const prepared = store.prepareCodexRecoveryCapabilities(
			"exec-reown",
			first.claimToken,
			0,
			1,
		);
		expect(prepared.ok).toBe(true);
		store.settleCodexRecoveryFailure(
			"exec-reown",
			first.claimToken,
			0,
			first.reservationSeq,
			{
				version: 1,
				code: "daemon_socket_not_ready",
				stage: "daemon_spawn",
				summary: "not ready",
				cleanup: "confirmed_absent",
			},
			70000,
		);
		const next = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge",
			nowMs: 100000,
			ttlMs: 60000,
		});
		if (!next.ok) throw new Error("next claim failed");
		expect(next).toMatchObject({ attempt: 1, reservationSeq: 2 });
		const second = store.prepareCodexRecoveryCapabilities(
			"exec-reown",
			next.claimToken,
			0,
			100001,
		);
		expect(second.ok).toBe(true);
		if (prepared.ok && prepared.enrolled && second.ok && second.enrolled)
			expect(second.workflowOutputCredential).not.toBe(
				prepared.workflowOutputCredential,
			);
		const events = rawDatabase(store)
			.prepare(
				"SELECT payload FROM workflow_run_event WHERE kind = 'codex_recovery_capabilities_prepared' ORDER BY id",
			)
			.all();
		expect(events.map((e) => JSON.parse(String(e.payload)))).toMatchObject([
			{ attempt: 1, reservationSeq: 1, chargedAttempts: 1 },
			{ attempt: 1, reservationSeq: 2, chargedAttempts: 1 },
		]);
	});

	it("FLY-2505 failure insertion and refund roll back together", async () => {
		const store = await fixture();
		const claim = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge",
			nowMs: 0,
			ttlMs: 60000,
		});
		if (!claim.ok) throw new Error("claim failed");
		rawDatabase(store)
			.prepare(
				"CREATE TRIGGER reject_recovery_failure BEFORE INSERT ON session_events WHEN NEW.event_type = 'reown_revive_failed' BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
			)
			.run();
		expect(() =>
			store.settleCodexRecoveryFailure(
				"exec-reown",
				claim.claimToken,
				0,
				claim.reservationSeq,
				{
					version: 1,
					code: "daemon_socket_not_ready",
					stage: "daemon_spawn",
					summary: "not ready",
					cleanup: "confirmed_absent",
				},
				70000,
			),
		).toThrow("injected failure");
		expect(store.getCodexRecoveryEpisode("exec-reown")).toMatchObject({
			claimToken: claim.claimToken,
			episodeAttempts: 1,
		});
		expect(store.getEventsByExecution("exec-reown")).toHaveLength(0);
	});

	it("FLY-2505 three readiness failures refund charges but close the bounded readiness budget", async () => {
		const store = await fixture();
		for (let n = 0; n < 3; n++) {
			const claim = store.claimCodexRecovery("exec-reown", 0, {
				holder: "bridge",
				nowMs: n * 300000,
				ttlMs: 60000,
			});
			if (!claim.ok) throw new Error("claim failed");
			const result = store.settleCodexRecoveryFailure(
				"exec-reown",
				claim.claimToken,
				0,
				claim.reservationSeq,
				{
					version: 1,
					code: "daemon_socket_not_ready",
					stage: "daemon_spawn",
					summary: "not ready",
					cleanup: "confirmed_absent",
				},
				n * 300000 + 70000,
			);
			expect(result).toMatchObject({
				ok: true,
				chargedAttempts: 0,
				readinessFailures: n + 1,
				readinessDeadlineMs: 970000,
				exhaustionKind: n === 2 ? "readiness" : null,
			});
		}
		expect(
			store.claimCodexRecovery("exec-reown", 0, {
				holder: "bridge",
				nowMs: 900000,
				ttlMs: 60000,
			}),
		).toMatchObject({ ok: false, reason: "readiness_retry_exhausted" });
		expect(store.getCodexRecoveryDeferral("exec-reown", 900000)).toBe(false);
	});

	it("FLY-2505 commit clears readiness deferral but preserves monotonic reservation identity", async () => {
		const store = await fixture();
		const first = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge",
			nowMs: 0,
			ttlMs: 60000,
		});
		if (!first.ok) throw new Error("claim failed");
		store.settleCodexRecoveryFailure(
			"exec-reown",
			first.claimToken,
			0,
			first.reservationSeq,
			{
				version: 1,
				code: "daemon_socket_not_ready",
				stage: "daemon_spawn",
				summary: "not ready",
				cleanup: "confirmed_absent",
			},
			70000,
		);
		const next = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge",
			nowMs: 100000,
			ttlMs: 60000,
		});
		if (!next.ok) throw new Error("claim failed");
		expect(
			store.commitCodexRecovery("exec-reown", next.claimToken, 0, {
				nowMs: 100001,
				observedTurnHolder: "exec-reown",
			}),
		).toMatchObject({ ok: true });
		expect(store.getCodexRecoveryDeferral("exec-reown", 100002)).toBe(false);
		expect(
			rawDatabase(store)
				.prepare(
					"SELECT readiness_failures, readiness_deadline_ms, pending_reservation_until_ms, reservation_seq FROM recovery_claim WHERE execution_id = ?",
				)
				.get("exec-reown"),
		).toEqual({
			readiness_failures: 0,
			readiness_deadline_ms: null,
			pending_reservation_until_ms: null,
			reservation_seq: 2,
		});
		const fresh = store.claimCodexRecovery("exec-reown", 1, {
			holder: "bridge",
			nowMs: 100003,
			ttlMs: 60000,
		});
		expect(fresh).toMatchObject({ ok: true, attempt: 1, reservationSeq: 3 });
	});

	it("FLY-2505 takeover records missing receipt once and late old callbacks cannot refund", async () => {
		const store = await fixture();
		const first = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge",
			nowMs: 0,
			ttlMs: 60000,
		});
		if (!first.ok) throw new Error("claim failed");
		const next = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge2",
			nowMs: 60001,
			ttlMs: 60000,
		});
		expect(next).toMatchObject({ ok: true, attempt: 2, reservationSeq: 2 });
		const events = store.getEventsByExecution("exec-reown");
		expect(events).toHaveLength(1);
		expect(events[0].payload).toMatchObject({
			failure: { code: "owner_result_missing" },
			budgetDecision: "charged",
			reservationSeq: 1,
		});
		store.settleCodexRecoveryFailure(
			"exec-reown",
			first.claimToken,
			0,
			first.reservationSeq,
			{
				version: 1,
				code: "daemon_socket_not_ready",
				stage: "daemon_spawn",
				summary: "not ready",
				cleanup: "confirmed_absent",
			},
			70000,
		);
		expect(store.getCodexRecoveryEpisode("exec-reown")?.episodeAttempts).toBe(
			2,
		);
		expect(store.getEventsByExecution("exec-reown")).toHaveLength(1);
	});

	it("FLY-2505 mutation writer takes only the real lease and clears readiness on commit", async () => {
		const store = await fixture();
		const first = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge",
			nowMs: 0,
			ttlMs: 60000,
		});
		if (!first.ok) throw new Error("claim failed");
		expect(
			store.claimExecutionMutationLease("exec-reown", 0, {
				holder: "turn",
				nowMs: 100,
				ttlMs: 60000,
			}),
		).toMatchObject({ ok: false, reason: "lease_held" });
		store.settleCodexRecoveryFailure(
			"exec-reown",
			first.claimToken,
			0,
			first.reservationSeq,
			{
				version: 1,
				code: "daemon_socket_not_ready",
				stage: "daemon_spawn",
				summary: "not ready",
				cleanup: "confirmed_absent",
			},
			70000,
		);
		const writer = store.claimExecutionMutationLease("exec-reown", 0, {
			holder: "turn",
			nowMs: 70001,
			ttlMs: 60000,
		});
		if (!writer.ok)
			throw new Error("writer rejected during readiness cooldown");
		expect(
			rawDatabase(store)
				.prepare(
					"SELECT lease_purpose, reservation_seq FROM recovery_claim WHERE execution_id = ?",
				)
				.get("exec-reown"),
		).toEqual({ lease_purpose: "mutation", reservation_seq: 1 });
		expect(store.getCodexRecoveryDeferral("exec-reown", 70002)).toBe(false);
		expect(
			store.settleCodexRecoveryFailure(
				"exec-reown",
				writer.claimToken,
				0,
				first.reservationSeq,
				undefined,
				70003,
			),
		).toMatchObject({ ok: false });
		expect(
			store.commitExecutionMutationLease(
				"exec-reown",
				writer.claimToken,
				0,
				70004,
			),
		).toMatchObject({ ok: true });
		expect(
			rawDatabase(store)
				.prepare(
					"SELECT readiness_failures, readiness_deadline_ms, reservation_seq FROM recovery_claim WHERE execution_id = ?",
				)
				.get("exec-reown"),
		).toEqual({
			readiness_failures: 0,
			readiness_deadline_ms: null,
			reservation_seq: 1,
		});
	});

	it("FLY-2505 reopened readiness keeps the original deadline and retry receipt", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2505-restart-"));
		roots.push(root);
		const path = join(root, "state.db");
		let store = await StateStore.create(path);
		store.upsertSession({
			execution_id: "exec-reown",
			issue_id: "FLY-2505",
			project_name: "flywheel",
			status: "running",
			adapter_type: "codex-tmux",
		});
		const claim = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge",
			nowMs: 0,
			ttlMs: 60000,
		});
		if (!claim.ok) throw new Error("claim failed");
		const failure = {
			version: 1,
			code: "daemon_socket_not_ready",
			stage: "daemon_spawn",
			summary: "not ready",
			cleanup: "confirmed_absent",
		};
		const settled = store.settleCodexRecoveryFailure(
			"exec-reown",
			claim.claimToken,
			0,
			claim.reservationSeq,
			failure,
			70000,
		);
		store.close();
		store = await StateStore.create(path);
		stores.push(store);
		expect(
			store.settleCodexRecoveryFailure(
				"exec-reown",
				claim.claimToken,
				0,
				claim.reservationSeq,
				failure,
				80000,
			),
		).toEqual(settled);
		expect(
			store.claimCodexRecovery("exec-reown", 0, {
				holder: "new",
				nowMs: 80000,
				ttlMs: 60000,
			}),
		).toMatchObject({ ok: false, reason: "retry_not_due", retryAtMs: 100000 });
		expect(store.getCodexRecoveryDeferral("exec-reown", 969999)).toMatchObject({
			untilMs: 970000,
			reason: "readiness",
		});
		expect(
			store.claimCodexRecovery("exec-reown", 0, {
				holder: "new",
				nowMs: 970000,
				ttlMs: 60000,
			}),
		).toMatchObject({ ok: false, reason: "readiness_retry_exhausted" });
		expect(store.getCodexRecoveryDeferral("exec-reown", 970000)).toMatchObject({
			reason: "expired_readiness",
			untilMs: 970000,
			lastFailureEventId: expect.any(String),
			lastFailure: { code: "daemon_socket_not_ready" },
		});
	});

	it("FLY-2505 recovery and mutation commits reject the other lease purpose", async () => {
		const store = await fixture();
		const recovery = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge",
			nowMs: 0,
			ttlMs: 60000,
		});
		if (!recovery.ok) throw new Error("claim failed");
		expect(
			store.commitExecutionMutationLease(
				"exec-reown",
				recovery.claimToken,
				0,
				1,
			),
		).toMatchObject({ ok: false, reason: "claim_lost" });
		expect(store.getCodexRecoveryEpisode("exec-reown")?.claimToken).toBe(
			recovery.claimToken,
		);
		const writer = store.claimExecutionMutationLease("exec-reown", 0, {
			holder: "writer",
			nowMs: 60001,
			ttlMs: 60000,
		});
		if (!writer.ok) throw new Error("writer claim failed");
		expect(
			store.commitCodexRecovery("exec-reown", writer.claimToken, 0, {
				nowMs: 60002,
				observedTurnHolder: "exec-reown",
			}),
		).toMatchObject({ ok: false, reason: "claim_lost" });
		expect(store.getSession("exec-reown")?.lifecycle_revision).toBe(0);
		expect(store.getCodexRecoveryEpisode("exec-reown")?.claimToken).toBe(
			writer.claimToken,
		);
	});

	it("FLY-2505 persisted duplicate receipts reject malformed or unrelated data", async () => {
		const store = await fixture();
		const claim = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge",
			nowMs: 0,
			ttlMs: 60000,
		});
		if (!claim.ok) throw new Error("claim failed");
		const result = store.settleCodexRecoveryFailure(
			"exec-reown",
			claim.claimToken,
			0,
			claim.reservationSeq,
			undefined,
			1,
		);
		if (!result.ok) throw new Error("settlement failed");
		const db = rawDatabase(store);
		const original = JSON.parse(
			String(
				db
					.prepare("SELECT payload FROM session_events WHERE event_id = ?")
					.get(result.eventId)?.payload,
			),
		);
		for (const invalid of [
			"{",
			JSON.stringify({ ...original, chargedAttempts: -1 }),
			JSON.stringify({ ...original, diagnosticVersion: 2 }),
			JSON.stringify({ ...original, episodeId: "foreign" }),
			JSON.stringify({
				...original,
				failure: { ...original.failure, version: 2 },
			}),
		]) {
			db.prepare(
				"UPDATE session_events SET payload = ? WHERE event_id = ?",
			).run(invalid, result.eventId);
			expect(
				store.settleCodexRecoveryFailure(
					"exec-reown",
					claim.claimToken,
					0,
					claim.reservationSeq,
					undefined,
					2,
				),
			).toEqual({ ok: false, reason: "claim_lost" });
		}
		db.prepare("UPDATE session_events SET payload = ? WHERE event_id = ?").run(
			JSON.stringify({
				...original,
				reason: "password=private-value",
				secret: "private-value",
			}),
			result.eventId,
		);
		const replay = store.settleCodexRecoveryFailure(
			"exec-reown",
			claim.claimToken,
			0,
			claim.reservationSeq,
			undefined,
			3,
		);
		expect(replay).toEqual(result);
	});

	it("FLY-2505 exhaustion atomically freezes one durable Lead alert and reuses it on retry", async () => {
		const store = await fixture();
		enrollOutputExecution(store);
		const identity = {
			leadId: "lead-a",
			projectName: "flywheel",
			leadResolution: "resolved" as const,
		};
		let episodeId = "";
		for (let n = 0; n < 2; n++) {
			const claim = store.claimCodexRecovery("exec-reown", 0, {
				holder: "bridge",
				nowMs: n * 100000,
				ttlMs: 60000,
			});
			if (!claim.ok) throw new Error("claim failed");
			episodeId = claim.episodeId;
			store.settleCodexRecoveryFailure(
				"exec-reown",
				claim.claimToken,
				0,
				claim.reservationSeq,
				undefined,
				n * 100000 + 1,
				identity,
			);
		}
		const uid = `reown-exhausted:exec-reown:${episodeId}`;
		const initial = rawDatabase(store)
			.prepare(
				"SELECT payload_json FROM workflow_alert_outbox WHERE escalation_uid = ?",
			)
			.get(uid);
		expect(initial).toBeDefined();
		expect(JSON.parse(String(initial?.payload_json))).toMatchObject({
			leadId: "lead-a",
			metadata: {
				workflowEngine: {
					executionId: "exec-reown",
					recoveryExhaustion: {
						reason: "episode_exhausted",
						chargedAttempts: 2,
						lastFailure: { code: "owner_failed_unknown" },
					},
				},
			},
		});
		expect(
			store.finalizeCodexRecoveryExhaustion("exec-reown", 0, 200000, {
				...identity,
				leadId: "lead-b",
			}),
		).toMatchObject({ reason: "episode_exhausted", chargedAttempts: 2 });
		expect(
			rawDatabase(store)
				.prepare(
					"SELECT payload_json FROM workflow_alert_outbox WHERE escalation_uid = ?",
				)
				.get(uid),
		).toEqual(initial);
		expect(
			store
				.getEventsByExecution("exec-reown")
				.filter((e) => e.event_id.startsWith("reown_exhausted:v1:")),
		).toHaveLength(1);
	});

	it.each(["insert_failure", "uid_conflict"])(
		"FLY-2505 exhaustion %s rolls back the final refund and diagnosis",
		async (mode) => {
			const store = await fixture();
			enrollOutputExecution(store);
			const identity = {
				leadId: "lead-a",
				projectName: "flywheel",
				leadResolution: "resolved" as const,
			};
			const failure = {
				version: 1,
				code: "daemon_socket_not_ready",
				stage: "daemon_spawn",
				summary: "not ready",
				cleanup: "confirmed_absent",
			};
			for (let n = 0; n < 2; n++) {
				const claim = store.claimCodexRecovery("exec-reown", 0, {
					holder: "bridge",
					nowMs: n * 300000,
					ttlMs: 60000,
				});
				if (!claim.ok) throw new Error("claim failed");
				store.settleCodexRecoveryFailure(
					"exec-reown",
					claim.claimToken,
					0,
					claim.reservationSeq,
					failure,
					n * 300000 + 70000,
					identity,
				);
			}
			const last = store.claimCodexRecovery("exec-reown", 0, {
				holder: "bridge",
				nowMs: 600000,
				ttlMs: 60000,
			});
			if (!last.ok) throw new Error("claim failed");
			const db = rawDatabase(store);
			if (mode === "insert_failure")
				db.prepare(
					"CREATE TRIGGER fail_recovery_alert BEFORE INSERT ON workflow_alert_outbox BEGIN SELECT RAISE(ABORT, 'injected alert failure'); END",
				).run();
			else
				db.prepare(
					"INSERT INTO workflow_alert_outbox (escalation_uid,run_id,payload_json,state,attempt,generation,created_at,updated_at) VALUES (?,'run-recovery','{}','pending',0,0,'2026-09-10','2026-09-10')",
				).run(`reown-exhausted:exec-reown:${last.episodeId}`);
			expect(() =>
				store.settleCodexRecoveryFailure(
					"exec-reown",
					last.claimToken,
					0,
					last.reservationSeq,
					failure,
					670000,
					identity,
				),
			).toThrow(
				mode === "insert_failure"
					? /injected alert failure/
					: /workflow_alert_uid_conflict/,
			);
			expect(
				db
					.prepare(
						"SELECT claim_token,episode_attempts,readiness_failures,exhaustion_kind FROM recovery_claim WHERE execution_id = ?",
					)
					.get("exec-reown"),
			).toEqual({
				claim_token: last.claimToken,
				episode_attempts: 1,
				readiness_failures: 2,
				exhaustion_kind: null,
			});
			expect(store.getEventsByExecution("exec-reown")).toHaveLength(2);
		},
	);

	it("FLY-2505 a skipped maintenance tick exhausts by deadline with the actual readiness count", async () => {
		const store = await fixture();
		enrollOutputExecution(store);
		const identity = {
			leadId: "lead-a",
			projectName: "flywheel",
			leadResolution: "resolved" as const,
		};
		const claim = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge",
			nowMs: 0,
			ttlMs: 60000,
		});
		if (!claim.ok) throw new Error("claim failed");
		store.settleCodexRecoveryFailure(
			"exec-reown",
			claim.claimToken,
			0,
			claim.reservationSeq,
			{
				version: 1,
				code: "daemon_socket_not_ready",
				stage: "daemon_spawn",
				summary: "not ready",
				cleanup: "confirmed_absent",
			},
			70000,
			identity,
		);
		expect(
			store.claimCodexRecovery("exec-reown", 0, {
				holder: "bridge",
				nowMs: 1200000,
				ttlMs: 60000,
				alertIdentity: identity,
			}),
		).toMatchObject({
			ok: false,
			reason: "readiness_retry_exhausted",
			exhaustion: {
				exhaustionTrigger: "readiness_deadline",
				readinessFailures: 1,
				chargedAttempts: 0,
			},
		});
		expect(
			rawDatabase(store)
				.prepare("SELECT escalation_uid FROM workflow_alert_outbox")
				.all(),
		).toHaveLength(1);
	});

	it("reclaims an expired reservation across an eligible revision bump without refunding it", async () => {
		const store = await fixture();
		const first = store.claimCodexRecovery("exec-reown", 0, {
			holder: "old",
			nowMs: 0,
			ttlMs: 60000,
		});
		if (!first.ok) throw new Error("claim failed");
		store.upsertSession({
			execution_id: "exec-reown",
			issue_id: "FLY-2211",
			project_name: "flywheel",
			status: "ship_parked",
			adapter_type: "codex-tmux",
		});
		expect(store.getSession("exec-reown")?.lifecycle_revision).toBe(1);
		// An old callback cannot use its stale revision to settle or refund.
		expect(
			store.settleCodexRecoveryFailure(
				"exec-reown",
				first.claimToken,
				0,
				first.reservationSeq,
				undefined,
				70000,
			),
		).toEqual({ ok: false, reason: "claim_lost" });
		const next = store.claimCodexRecovery("exec-reown", 1, {
			holder: "new",
			nowMs: 200000,
			ttlMs: 60000,
		});
		expect(next).toMatchObject({
			ok: true,
			attempt: 2,
			reservationSeq: 2,
			episodeId: first.episodeId,
		});
		if (!next.ok) throw new Error("takeover failed");
		const receipt = rawDatabase(store)
			.prepare("SELECT payload FROM session_events WHERE event_id = ?")
			.get(`reown_revive_failed:v1:exec-reown:${first.episodeId}:1`);
		expect(JSON.parse(String(receipt?.payload))).toMatchObject({
			failure: { code: "owner_result_missing" },
			budgetDecision: "charged",
			chargedAttempts: 1,
			lifecycleRevision: 0,
		});
		expect(store.getCodexRecoveryEpisode("exec-reown")).toMatchObject({
			claimToken: next.claimToken,
			episodeAttempts: 2,
		});
		expect(
			store.claimCodexRecovery("exec-reown", 1, {
				holder: "third",
				nowMs: 400000,
				ttlMs: 60000,
			}),
		).toMatchObject({ ok: false, reason: "episode_exhausted" });
	});

	it("routes exhaustion to the active binding despite historical runs and a cleared node execution", async () => {
		const store = await fixture();
		enrollOutputExecution(store);
		const db = rawDatabase(store);
		const run = store.getWorkflowRun("run-recovery")!;
		db.prepare(
			"UPDATE workflow_run SET status = 'completed' WHERE run_id = ?",
		).run("run-recovery");
		store.createWorkflowRun({
			runId: "run-history",
			issueId: "FLY-2211",
			projectName: "flywheel",
			snapshotJson: run.snapshot_json,
			claimsReadEnrolled: false,
		});
		db.prepare(
			"UPDATE workflow_run SET status = 'completed' WHERE run_id = ?",
		).run("run-history");
		db.prepare(
			"UPDATE workflow_run SET status = 'active' WHERE run_id = ?",
		).run("run-recovery");
		const binding = db
			.prepare(
				"SELECT * FROM workflow_execution_binding WHERE execution_id = ?",
			)
			.get("exec-reown")!;
		const historical = {
			...binding,
			activation_id: "historical-activation",
			run_id: "run-history",
		};
		const columns = Object.keys(historical);
		db.prepare(
			`INSERT INTO workflow_execution_binding (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
		).run(...Object.values(historical));
		db.prepare(
			"UPDATE workflow_run_node SET execution_id = NULL WHERE run_id = ?",
		).run("run-recovery");
		const identity = {
			leadId: "flywheel-eng-lead",
			projectName: "flywheel",
			leadResolution: "resolved" as const,
		};
		for (let n = 0; n < 2; n++) {
			const claim = store.claimCodexRecovery("exec-reown", 0, {
				holder: "bridge",
				nowMs: n * 100000,
				ttlMs: 60000,
				alertIdentity: identity,
			});
			if (!claim.ok) throw new Error("claim failed");
			expect(
				store.settleCodexRecoveryFailure(
					"exec-reown",
					claim.claimToken,
					0,
					claim.reservationSeq,
					undefined,
					n * 100000 + 1,
					identity,
				).ok,
			).toBe(true);
		}
		expect(
			db.prepare("SELECT run_id FROM workflow_alert_outbox").all(),
		).toEqual([{ run_id: "run-recovery" }]);
		expect(store.getCodexRecoveryAlertBinding("exec-reown")).toEqual({
			run_id: "run-recovery",
			node_id: "execute",
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

		const raw = rawDatabase(store);
		const oldRow = raw
			.prepare(
				"SELECT revoked, revoked_reason FROM workflow_output_credential WHERE credential_hash = ?",
			)
			.get(hashCapabilityToken(oldOutputCredential));
		const newRow = raw
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

	it("FLY-2352 reissues capabilities to the current rework activation after re-entry", async () => {
		const store = await fixture();
		enrollOutputExecution(store);
		const wakeOutputCredential = reenterOutputExecution(store);
		expect(store.getWorkflowExecutionBinding("exec-reown")).toBeUndefined();
		expect(store.resolveCurrentWorkflowActivation("exec-reown")).toMatchObject({
			kind: "current",
			binding: {
				activation_id: "activation:rework:test",
				attempt: 2,
			},
		});

		const claim = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge-a",
			nowMs: Date.parse("2026-08-31T20:05:00.000Z"),
			ttlMs: 60_000,
		});
		if (!claim.ok) throw new Error("claim unexpectedly failed");
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
		const raw = rawDatabase(store);
		expect(
			raw
				.prepare(
					"SELECT activation_id, attempt, revoked FROM workflow_output_credential WHERE credential_hash = ?",
				)
				.get(hashCapabilityToken(prepared.workflowOutputCredential)),
		).toMatchObject({
			activation_id: "activation:rework:test",
			attempt: 2,
			revoked: 0,
		});
		expect(
			raw
				.prepare(
					"SELECT revoked, revoked_reason FROM workflow_output_credential WHERE credential_hash = ?",
				)
				.get(hashCapabilityToken(wakeOutputCredential)),
		).toMatchObject({
			revoked: 1,
			revoked_reason: "codex_recovery_rotation",
		});
		expect(
			store
				.listWorkflowRunEvents("run-recovery")
				.find((event) => event.kind === "codex_recovery_capabilities_prepared"),
		).toMatchObject({ payload: expect.objectContaining({ attempt: 2 }) });
	});

	it("FLY-2352 fails closed as activation_ambiguous when no binding is current", async () => {
		const store = await fixture();
		enrollOutputExecution(store);
		const wakeOutputCredential = reenterOutputExecution(store);
		const raw = rawDatabase(store);
		raw
			.prepare(
				"UPDATE workflow_run_node SET execution_id = 'exec-other' WHERE run_id = 'run-recovery' AND node_id = 'execute' AND attempt = 2",
			)
			.run();
		const beforeCount = raw
			.prepare(
				"SELECT COUNT(*) AS count FROM workflow_output_credential WHERE execution_id = 'exec-reown'",
			)
			.get()?.count;
		const claim = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge-a",
			nowMs: Date.parse("2026-08-31T20:05:00.000Z"),
			ttlMs: 60_000,
		});
		if (!claim.ok) throw new Error("claim unexpectedly failed");

		expect(
			store.prepareCodexRecoveryCapabilities(
				"exec-reown",
				claim.claimToken,
				0,
				Date.parse("2026-08-31T20:05:01.000Z"),
			),
		).toEqual({ ok: false, reason: "activation_ambiguous" });
		expect(
			raw
				.prepare(
					"SELECT COUNT(*) AS count FROM workflow_output_credential WHERE execution_id = 'exec-reown'",
				)
				.get()?.count,
		).toBe(beforeCount);
		expect(
			raw
				.prepare(
					"SELECT revoked, revoked_reason FROM workflow_output_credential WHERE credential_hash = ?",
				)
				.get(hashCapabilityToken(wakeOutputCredential)),
		).toMatchObject({ revoked: 0, revoked_reason: null });
		expect(
			store
				.listWorkflowRunEvents("run-recovery")
				.some((event) => event.kind === "codex_recovery_capabilities_prepared"),
		).toBe(false);
	});

	it("FLY-2352 fails closed as activation_invalid when the bound snapshot is corrupt", async () => {
		const store = await fixture();
		enrollOutputExecution(store);
		const raw = rawDatabase(store);
		raw
			.prepare(
				"UPDATE workflow_run SET snapshot = '{not json' WHERE run_id = ?",
			)
			.run("run-recovery");
		const claim = store.claimCodexRecovery("exec-reown", 0, {
			holder: "bridge-a",
			nowMs: Date.parse("2026-08-31T20:05:00.000Z"),
			ttlMs: 60_000,
		});
		if (!claim.ok) throw new Error("claim unexpectedly failed");

		expect(
			store.prepareCodexRecoveryCapabilities(
				"exec-reown",
				claim.claimToken,
				0,
				Date.parse("2026-08-31T20:05:01.000Z"),
			),
		).toEqual({ ok: false, reason: "activation_invalid" });
	});
});
