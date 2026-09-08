import type Database from "better-sqlite3";
import {
	LANES,
	RAN_REASONS,
	RECORD_REASONS,
} from "flywheel-comm/strength-two-contract";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const HEAD = "a".repeat(40);
const NOW = "2026-09-07T03:00:00.000Z";
const EXPIRES = "2026-09-07T04:00:00.000Z";
const DEADLINE = "2026-09-07T05:00:00.000Z";

async function fixture() {
	const store = await StateStore.create(":memory:");
	store.createWorkflowRun({
		runId: "run-strength-two",
		issueId: "FLY-2397",
		projectName: "flywheel",
		claimsReadEnrolled: false,
	});
	const admission = store.admitWorkflowExecution({
		runId: "run-strength-two",
		nodeId: "qa",
		executionId: "qa-strength-two",
		attempt: 1,
		family: "qa_verdict",
		expiresAt: EXPIRES,
		absoluteDeadlineAt: DEADLINE,
		now: NOW,
	});
	if (!admission.ok) throw new Error(admission.reason);
	store.upsertSession({
		execution_id: "qa-strength-two",
		issue_id: "FLY-2397",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: "qa",
		session_role: "qa",
		chat_thread_role: "qa",
	});
	return { store, admission };
}

function recordInput(credential: string, recordId: string) {
	return {
		credential,
		recordId,
		callerFacts: {
			recorderExecutionId: "qa-strength-two",
			headSha: HEAD,
			siteSlot: 2,
			lane: "generalized_e2e_stub" as const,
			driverExitCode: 0,
			recordUrl: "https://fw-reports-test.vercel.app/r/abcdef12/",
			rerunSpec:
				'{"deploy":{},"driver":{"issue":"FLY-2397","timeoutMs":600000},"lane":"generalized_e2e_stub","schemaVersion":1}',
			localCopyPath: null,
		},
		authority: { headSha: HEAD, worktreePath: "/tmp/flywheel-FLY-2397" },
		siteBridgePort: 19_872,
		siteProbe: {
			ok: true as const,
			httpStatus: 200 as const,
			healthOk: true as const,
			shuttingDown: false as const,
			buildMode: "built" as const,
			buildSha: HEAD,
			artifactBuildSha: HEAD,
		},
		recordProbe: {
			kind: "hosted_report" as const,
			outcome: "ok" as const,
			evidence: {
				httpStatus: 200 as const,
				digest: "b".repeat(64),
				bytes: 128,
			},
		},
		rerun: {
			argv: [["bash", "scripts/test-deploy.sh", "2", "--generalized"]],
			command:
				"cd /tmp/flywheel-FLY-2397 && bash scripts/test-deploy.sh 2 --generalized",
		},
		probeDetail: '{"site":"ok","record":"ok"}',
		now: NOW,
	};
}

function evidenceRows(store: StateStore): unknown[] {
	return rawDb(store)
		.prepare("SELECT * FROM strength_two_evidence_record")
		.all();
}

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

function ddlEnum(sql: string, column: string): string[] {
	const match = sql.match(new RegExp(`${column} IN \\(([^)]*)\\)`));
	if (!match) throw new Error(`missing ${column} enum in DDL`);
	return [...match[1]!.matchAll(/'([^']+)'/g)].map((item) => item[1]!);
}

function driftRole(
	store: StateStore,
	roleColumn: "session_role" | "chat_thread_role",
): void {
	if (roleColumn === "session_role") {
		store.upsertSession({
			execution_id: "qa-strength-two",
			issue_id: "FLY-2397",
			project_name: "flywheel",
			status: "running",
			session_role: "main",
		});
		return;
	}
	store.patchSessionMetadata("qa-strength-two", { chat_thread_role: "main" });
}

describe("StateStore strength-two evidence — durable QA authority", () => {
	it("locks the shared lane and reason vocabularies to the SQLite checks", async () => {
		const { store } = await fixture();
		const row = rawDb(store)
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'strength_two_evidence_record'",
			)
			.get() as { sql: string };
		expect(ddlEnum(row.sql, "lane")).toEqual([...LANES]);
		expect(ddlEnum(row.sql, "ran_reason")).toEqual([...RAN_REASONS]);
		expect(ddlEnum(row.sql, "record_reason")).toEqual([...RECORD_REASONS]);
		expect(
			RAN_REASONS.filter((reason) => RECORD_REASONS.includes(reason)),
		).toEqual(["ok"]);
		store.close();
	});

	it.each(["session_role", "chat_thread_role"] as const)(
		"rejects a new row when %s drifts after probes but before the transaction",
		async (roleColumn) => {
			const { store, admission } = await fixture();
			driftRole(store, roleColumn);

			const result = store.recordStrengthTwoEvidenceByCredential(
				recordInput(
					admission.credential,
					"11111111-1111-4111-8111-111111111111",
				),
			);

			expect(result).toEqual({
				ok: false,
				reason: "credential_not_durable_qa",
			});
			expect(evidenceRows(store)).toHaveLength(0);
			store.close();
		},
	);

	it.each(["session_role", "chat_thread_role"] as const)(
		"answers an exact replay before rechecking drifted %s",
		async (roleColumn) => {
			const { store, admission } = await fixture();
			const input = recordInput(
				admission.credential,
				"22222222-2222-4222-8222-222222222222",
			);
			const first = store.recordStrengthTwoEvidenceByCredential(input);
			expect(first).toMatchObject({ ok: true, status: "inserted" });

			driftRole(store, roleColumn);
			const replay = store.recordStrengthTwoEvidenceByCredential({
				...input,
				now: DEADLINE,
			});

			expect(replay).toMatchObject({ ok: true, status: "replayed" });
			expect(evidenceRows(store)).toHaveLength(1);
			store.close();
		},
	);
});

describe("StateStore strength-two evidence — append-only transaction", () => {
	it("stores both evidence halves as independent columns bound to exact run/repo/head", async () => {
		const { store, admission } = await fixture();
		const credentialBefore = store.getWorkflowSubmissionCredentialByToken(
			admission.credential,
		);

		const result = store.recordStrengthTwoEvidenceByCredential(
			recordInput(admission.credential, "44444444-4444-4444-8444-444444444444"),
		);

		expect(result).toMatchObject({
			ok: true,
			status: "inserted",
			row: {
				run_id: "run-strength-two",
				target_repo_identity: "__main__",
				head_sha: HEAD,
				site_kind: "slot_529",
				site_slot: 2,
				lane: "generalized_e2e_stub",
				ran_status: "satisfied",
				ran_reason: "ok",
				record_url: "https://fw-reports-test.vercel.app/r/abcdef12/",
				record_status: "satisfied",
				record_reason: "ok",
				verdict: "satisfied",
			},
		});
		expect(
			store.listStrengthTwoRecordsForHead("run-strength-two", "__main__", HEAD),
		).toHaveLength(1);
		expect(
			store.listStrengthTwoRecordsForHead(
				"run-strength-two",
				"owner/nested",
				HEAD,
			),
		).toEqual([]);
		expect(
			store.getWorkflowSubmissionCredentialByToken(admission.credential),
		).toEqual(credentialBefore);
		store.close();
	});

	it("replays without probes after consumption and conflicts on any changed caller fact", async () => {
		const { store, admission } = await fixture();
		const input = recordInput(
			admission.credential,
			"55555555-5555-4555-8555-555555555555",
		);
		expect(store.recordStrengthTwoEvidenceByCredential(input)).toMatchObject({
			ok: true,
			status: "inserted",
		});
		rawDb(store)
			.prepare(
				"UPDATE workflow_submission_credential SET consumed_at = ? WHERE id = ?",
			)
			.run(EXPIRES, admission.credentialId);

		expect(
			store.recordStrengthTwoEvidenceByCredential({
				...input,
				siteProbe: {
					ok: false,
					reason: "unreachable",
					raw: {},
					detail: "must be ignored on replay",
				},
				recordProbe: {
					kind: "hosted_report",
					outcome: "unreachable",
					detail: "must be ignored on replay",
				},
				now: DEADLINE,
			}),
		).toMatchObject({ ok: true, status: "replayed" });
		expect(
			store.recordStrengthTwoEvidenceByCredential({
				...input,
				callerFacts: {
					...input.callerFacts,
					recordUrl: "https://fw-reports-test.vercel.app/r/different/",
				},
			}),
		).toEqual({ ok: false, reason: "record_conflict" });
		expect(evidenceRows(store)).toHaveLength(1);
		store.close();
	});

	it("allows multiple append-only attempts for one exact head", async () => {
		const { store, admission } = await fixture();
		for (const recordId of [
			"66666666-6666-4666-8666-666666666666",
			"77777777-7777-4777-8777-777777777777",
		]) {
			expect(
				store.recordStrengthTwoEvidenceByCredential(
					recordInput(admission.credential, recordId),
				),
			).toMatchObject({ ok: true, status: "inserted" });
		}
		expect(
			store.listStrengthTwoRecordsForHead("run-strength-two", "__main__", HEAD),
		).toHaveLength(2);
		store.close();
	});

	it.each([
		[
			"credential_consumed",
			(store: StateStore, credentialId: number) =>
				rawDb(store)
					.prepare(
						"UPDATE workflow_submission_credential SET consumed_at = ? WHERE id = ?",
					)
					.run(EXPIRES, credentialId),
			NOW,
		],
		[
			"credential_revoked",
			(store: StateStore, credentialId: number) =>
				rawDb(store)
					.prepare(
						"UPDATE workflow_submission_credential SET revoked = 1 WHERE id = ?",
					)
					.run(credentialId),
			NOW,
		],
		["credential_expired", () => undefined, DEADLINE],
		[
			"not_current_writer:writer_binding_stale",
			(store: StateStore) =>
				rawDb(store)
					.prepare(
						"UPDATE workflow_run_node SET state = 'superseded' WHERE run_id = 'run-strength-two' AND node_id = 'qa' AND attempt = 1",
					)
					.run(),
			NOW,
		],
	] as const)(
		"rejects %s immediately before insert with zero rows",
		async (reason, mutate, now) => {
			const { store, admission } = await fixture();
			mutate(store, admission.credentialId);
			const input = recordInput(
				admission.credential,
				"88888888-8888-4888-8888-888888888888",
			);
			expect(
				store.recordStrengthTwoEvidenceByCredential({ ...input, now }),
			).toEqual({ ok: false, reason });
			expect(evidenceRows(store)).toHaveLength(0);
			store.close();
		},
	);

	it("rejects wrong credential family, execution identity, and head authority", async () => {
		const { store, admission } = await fixture();
		const input = recordInput(
			admission.credential,
			"99999999-9999-4999-8999-999999999999",
		);
		expect(
			store.recordStrengthTwoEvidenceByCredential({
				...input,
				callerFacts: {
					...input.callerFacts,
					recorderExecutionId: "someone-else",
				},
			}),
		).toEqual({ ok: false, reason: "credential_execution_mismatch" });
		expect(
			store.recordStrengthTwoEvidenceByCredential({
				...input,
				authority: {
					...input.authority,
					headSha: "c".repeat(40),
				},
			}),
		).toEqual({ ok: false, reason: "authority_head_mismatch" });

		const otherRun = await StateStore.create(":memory:");
		otherRun.createWorkflowRun({
			runId: "run-review",
			issueId: "FLY-2397",
			projectName: "flywheel",
			claimsReadEnrolled: false,
		});
		const review = otherRun.admitWorkflowExecution({
			runId: "run-review",
			nodeId: "review",
			executionId: "qa-strength-two",
			attempt: 1,
			family: "review_verdict",
			expiresAt: EXPIRES,
			absoluteDeadlineAt: DEADLINE,
			now: NOW,
		});
		if (!review.ok) throw new Error(review.reason);
		expect(
			otherRun.recordStrengthTwoEvidenceByCredential(
				recordInput(review.credential, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
			),
		).toEqual({ ok: false, reason: "credential_family_mismatch" });
		expect(evidenceRows(store)).toHaveLength(0);
		store.close();
		otherRun.close();
	});
});

describe("StateStore strength-two evidence — schema invariants", () => {
	it("accepts a complete direct insert but rejects immutable mutation and cross-field forgeries", async () => {
		const { store, admission } = await fixture();
		expect(
			store.recordStrengthTwoEvidenceByCredential(
				recordInput(
					admission.credential,
					"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				),
			),
		).toMatchObject({ ok: true });
		const db = rawDb(store);
		const source = db
			.prepare("SELECT * FROM strength_two_evidence_record WHERE record_id = ?")
			.get("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb") as Record<string, unknown>;
		let sequence = 0;
		const insertClone = (overrides: Record<string, unknown> = {}) => {
			sequence += 1;
			const row = {
				...source,
				record_id: `cccccccc-cccc-4ccc-8ccc-${String(sequence).padStart(12, "0")}`,
				...overrides,
			};
			const columns = Object.keys(row);
			return () =>
				db
					.prepare(
						`INSERT INTO strength_two_evidence_record (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
					)
					.run(...columns.map((column) => row[column]));
		};

		expect(insertClone()).not.toThrow();
		for (const invalid of [
			{
				verdict: "satisfied",
				record_status: "unsatisfied",
				record_reason: "url_http_error",
			},
			{ ran_status: "satisfied", ran_reason: "ok", site_http_status: 500 },
			{ ran_status: "satisfied", ran_reason: "ok", site_health_ok: 0 },
			{ ran_status: "satisfied", ran_reason: "ok", site_build_mode: "source" },
			{ ran_status: "satisfied", ran_reason: "ok", site_build_sha: null },
			{
				ran_status: "satisfied",
				ran_reason: "ok",
				site_build_sha: "c".repeat(40),
			},
			{ ran_status: "satisfied", ran_reason: "ok", driver_exit_code: 1 },
			{
				record_status: "satisfied",
				record_reason: "ok",
				record_http_status: 204,
			},
			{ record_status: "satisfied", record_reason: "ok", record_digest: null },
			{ record_status: "satisfied", record_reason: "ok", record_bytes: 0 },
			{ head_sha: "A".repeat(40) },
			{ record_digest: "B".repeat(64) },
			{ record_id: "not-a-uuid" },
			{ rerun_spec: "not-json" },
			{ rerun_argv: "not-json" },
			{ probe_detail: "not-json" },
			{ probe_detail: '{"detail":"line\\nbreak"}\n' },
			{ probe_detail: JSON.stringify({ detail: "x".repeat(4_100) }) },
			{ rerun_worktree_path: "/tmp/line\nbreak" },
			{ rerun_worktree_path: "/tmp/nul\0break" },
			{ local_copy_path: "/tmp/line\nbreak" },
			{ local_copy_path: "/tmp/nul\0break" },
			{ target_repo_identity: "/owner" },
			{ target_repo_identity: "owner/" },
			{ target_repo_identity: "owner//repo" },
			{ target_repo_identity: "owner/repo/extra" },
			{ lane: "manual_test_deploy", driver_exit_code: 0 },
		]) {
			expect(insertClone(invalid), JSON.stringify(invalid)).toThrow();
		}
		expect(() =>
			db
				.prepare(
					"UPDATE strength_two_evidence_record SET record_url = 'https://example.invalid' WHERE record_id = ?",
				)
				.run(source.record_id),
		).toThrow(/immutable/);
		expect(() =>
			db
				.prepare("DELETE FROM strength_two_evidence_record WHERE record_id = ?")
				.run(source.record_id),
		).toThrow(/immutable/);
		store.close();
	});
});
