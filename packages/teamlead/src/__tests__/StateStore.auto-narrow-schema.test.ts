import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const NOW = "2026-09-09T03:01:00.000Z";
const HEAD = "a".repeat(40);
const IDS = {
	control: "11111111-1111-4111-8111-111111111111",
	stop: "22222222-2222-4222-8222-222222222222",
	declaration: "33333333-3333-4333-8333-333333333333",
	strengthTwo: "44444444-4444-4444-8444-444444444444",
} as const;

function rawDb(store: StateStore): Database.Database {
	return (store as unknown as { db: { raw: Database.Database } }).db.raw;
}

function insertFlagChange(
	db: Database.Database,
	mode: "dry_run" | "auto",
): number {
	return Number(
		db
			.prepare(
				`INSERT INTO flag_value_changelog
				 (flag_name, scope, action, from_present, from_raw, to_present,
				  to_raw, from_effective, to_effective, changed_by, changed_at, reason)
				 VALUES ('auto_merge_narrow_gate', 'flywheel', 'set', 0, NULL, 1,
				         ?, 'dry_run', ?, 'flywheel-eng-lead', 1788922860000,
				         'founder 1517000000000000001')`,
			)
			.run(mode, mode).lastInsertRowid,
	);
}

function insertControl(
	db: Database.Database,
	input: {
		eventId: string;
		mode: "dry_run" | "auto";
		messageId: string;
		controlSeq: number;
		openingEventId: string | null;
	},
): void {
	const changeSeq = insertFlagChange(db, input.mode);
	db.prepare(
		`INSERT INTO auto_narrow_control_event
		 (event_id, project_name, control_seq, mode, flag_revision,
		  flag_change_seq, founder_message_id, founder_channel_id,
		  founder_author_id, message_created_at, applied_at, message_digest,
		  command_text, executed_by, opening_event_id, schema_version)
		 VALUES (?, 'flywheel', ?, ?, ?, ?, ?, '1516209714097291335',
		         '1138241636057481306', ?, ?, ?, ?, 'flywheel-eng-lead', ?, 1)`,
	).run(
		input.eventId,
		input.controlSeq,
		input.mode,
		input.controlSeq,
		changeSeq,
		input.messageId,
		NOW,
		NOW,
		"b".repeat(64),
		input.mode === "auto" ? "现在放开" : "现在停止",
		input.openingEventId,
	);
}

function seedAuditParents(store: StateStore): void {
	store.createWorkflowRun({
		runId: "run-2453",
		issueId: "FLY-2453",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	const db = rawDb(store);
	db.prepare(
		`INSERT INTO workflow_gate_holder
		 (run_id, gate_node_id, attempt, head_sha, source_execution_id,
		  question_id, authority_mode, subject_kind, carrier_binding_state,
		  card_message_id, state, materialization_stage, created_at, updated_at)
		 VALUES ('run-2453', 'founder_gate', 1, ?, 'implement-2453',
		         'question-2453', 'land', 'git_head', 'bound',
		         '1517000000000000100', 'awaiting_review', 'completed', ?, ?)`,
	).run(HEAD, NOW, NOW);
	db.prepare(
		`INSERT INTO auto_merge_shadow_declaration
		 (declaration_id, question_id, run_id, declared_class, declared_by,
		  discord_channel_id, discord_message_id, discord_author_user_id,
		  message_ts, declaration_seq, declared_at)
		 VALUES (?, 'question-2453', 'run-2453', 'pure_docs',
		         'flywheel-eng-lead', '1516209714097291335',
		         '1517000000000000200', '1516209714097291300', ?, 1, ?)`,
	).run(IDS.declaration, NOW, NOW);
	db.prepare(
		`INSERT INTO workflow_claims
		 (id, server_seq, issue_id, workflow_run_id, node_id, decision_kind,
		  attempt, predicate, issuer_kind, subject_kind, subject_digest,
		  permanent, authority_id)
		 VALUES (2453, 2453, 'FLY-2453', 'run-2453', NULL,
		         'founder_decision', NULL, 'founder_approved',
		         'founder_challenge', 'git_head', ?, 1, 'question-2453')`,
	).run(HEAD);
	db.prepare(
		`INSERT INTO workflow_founder_gate_verdict
		 (verdict_id, source_event_id, run_id, gate_node_id, attempt, verdict,
		  question_id, repo_identity, repo_slug, pr_number, head_sha,
		  rework_request_id, claim_id, founder_authored, author_evidence_json,
		  row_digest, recorded_at)
		 VALUES ('fgv:auto-2453', 'auto-narrow:question-2453', 'run-2453',
		         'founder_gate', 1, 'approved', 'question-2453', '__main__',
		         'xrliAnnie/flywheel', 1140, ?, NULL, 2453, 0,
		         '{"kind":"auto_narrow_gate"}', ?, ?)`,
	).run(HEAD, "c".repeat(64), NOW);
}

describe("StateStore auto narrow schema", () => {
	it("installs four tables, append-only triggers, and one migration receipt", async () => {
		const store = await StateStore.create(":memory:");
		const db = rawDb(store);
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'auto_narrow_%' ORDER BY name",
				)
				.all(),
		).toEqual([
			{ name: "auto_narrow_control_event" },
			{ name: "auto_narrow_decision_audit" },
			{ name: "auto_narrow_opinion_delivery" },
			{ name: "auto_narrow_opinion_snapshot" },
		]);
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'auto_narrow_%_no_%' ORDER BY name",
				)
				.all(),
		).toHaveLength(6);
		expect(
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM state_store_migration WHERE migration_id='fly-2453-auto-narrow-v1'",
				)
				.get(),
		).toEqual({ count: 1 });
		expect(
			db.prepare("PRAGMA table_info(auto_narrow_opinion_snapshot)").all(),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "sample_start_at" }),
				expect.objectContaining({ name: "sample_end_at" }),
				expect.objectContaining({ name: "last_eligible_human_at" }),
			]),
		);
		store.close();
	});

	it("reopens without changing schema or duplicating the receipt", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2453-schema-"));
		const path = join(root, "teamlead.db");
		try {
			const first = await StateStore.create(path);
			const before = rawDb(first)
				.prepare(
					"SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'auto_narrow_%' ORDER BY type,name",
				)
				.all();
			first.close();
			const reopened = await StateStore.create(path);
			expect(
				rawDb(reopened)
					.prepare(
						"SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'auto_narrow_%' ORDER BY type,name",
					)
					.all(),
			).toEqual(before);
			expect(
				rawDb(reopened)
					.prepare(
						"SELECT COUNT(*) AS count FROM state_store_migration WHERE migration_id='fly-2453-auto-narrow-v1'",
					)
					.get(),
			).toEqual({ count: 1 });
			reopened.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("stores control, opinion, and approval audit rows with exact bindings", async () => {
		const store = await StateStore.create(":memory:");
		const db = rawDb(store);
		seedAuditParents(store);
		insertControl(db, {
			eventId: IDS.control,
			mode: "auto",
			messageId: "1517000000000000001",
			controlSeq: 1,
			openingEventId: IDS.control,
		});
		db.prepare(
			`INSERT INTO auto_narrow_opinion_snapshot
			 (opinion_id, question_id, run_id, project_name, head_sha,
			  card_message_id, ordinal, captured_at, gate1, gate2, gate3, eligible,
			  declaration_id, machine_reason, s2_basis_record_id, reason_code,
			  policy_version, sample_n, agree_n, precision_a, precision_b,
			  confidence_lower, sample_start_at, sample_end_at,
			  last_eligible_human_at)
			 VALUES ('question-2453:1', 'question-2453', 'run-2453', 'flywheel', ?,
			         '1517000000000000100', 1, ?, 1, 1, 1, 1, ?, NULL, ?,
			         'eligible', 1, 5, 5, 5, 5, 0.5655, ?, ?, ?)`,
		).run(HEAD, NOW, IDS.declaration, IDS.strengthTwo, NOW, NOW, NOW);
		db.prepare(
			`INSERT INTO auto_narrow_decision_audit
			 (source_event_id, question_id, verdict_id, decision_source,
			  project_name, run_id, gate_node_id, attempt, source_execution_id,
			  repo_identity, pr_number, head_sha, control_event_id,
			  opening_event_id, flag_revision, declaration_id, declaration_seq,
			  s2_basis_record_id, observation_digest, source_payload_digest,
			  decision_at, policy_version)
			 VALUES ('auto-narrow:question-2453', 'question-2453',
			         'fgv:auto-2453', 'auto_narrow_gate', 'flywheel', 'run-2453',
			         'founder_gate', 1, 'implement-2453', '__main__', 1140, ?, ?, ?,
			         1, ?, 1, ?, ?, ?, ?, 1)`,
		).run(
			HEAD,
			IDS.control,
			IDS.control,
			IDS.declaration,
			IDS.strengthTwo,
			"d".repeat(64),
			"e".repeat(64),
			NOW,
		);
		expect(
			db
				.prepare(
					"SELECT mode,command_text,opening_event_id FROM auto_narrow_control_event",
				)
				.get(),
		).toEqual({
			mode: "auto",
			command_text: "现在放开",
			opening_event_id: IDS.control,
		});
		expect(
			db
				.prepare(
					"SELECT eligible,sample_n,precision_b FROM auto_narrow_opinion_snapshot",
				)
				.get(),
		).toEqual({ eligible: 1, sample_n: 5, precision_b: 5 });
		expect(
			db
				.prepare(
					"SELECT decision_source,declaration_id,s2_basis_record_id FROM auto_narrow_decision_audit",
				)
				.get(),
		).toEqual({
			decision_source: "auto_narrow_gate",
			declaration_id: IDS.declaration,
			s2_basis_record_id: IDS.strengthTwo,
		});
		store.close();
	});

	it("rejects invalid control modes, command mismatch, gate mismatch, and sample confidence", async () => {
		const store = await StateStore.create(":memory:");
		const db = rawDb(store);
		const invalidControl = (mode: string, command: string) => {
			const changeSeq = insertFlagChange(db, "auto");
			return db
				.prepare(
					`INSERT INTO auto_narrow_control_event
					 (event_id, project_name, control_seq, mode, flag_revision,
					  flag_change_seq, founder_message_id, founder_channel_id,
					  founder_author_id, message_created_at, applied_at, message_digest,
					  command_text, executed_by, opening_event_id, schema_version)
					 VALUES (?, 'flywheel', 1, ?, 1, ?, '1517000000000000009',
					         '1516209714097291335', '1138241636057481306', ?, ?, ?, ?,
					         'flywheel-eng-lead', ?, 1)`,
				)
				.run(
					IDS.control,
					mode,
					changeSeq,
					NOW,
					NOW,
					"b".repeat(64),
					command,
					IDS.control,
				);
		};
		expect(() => invalidControl("off", "现在放开")).toThrow();
		expect(() => invalidControl("auto", "现在停止")).toThrow();

		const opinion = db.prepare(
			`INSERT INTO auto_narrow_opinion_snapshot
			 (opinion_id, question_id, run_id, project_name, head_sha,
			  card_message_id, ordinal, captured_at, gate1, gate2, gate3, eligible,
			  machine_reason, reason_code, policy_version, sample_n, agree_n,
			  precision_a, precision_b, confidence_lower, sample_start_at,
			  sample_end_at, last_eligible_human_at)
			 VALUES (?, 'q', 'r', 'flywheel', ?, '1517000000000000100', 1, ?,
			         1, 0, 1, ?, NULL, 'gate2_failed', 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		expect(() =>
			opinion.run(
				"bad-gates",
				HEAD,
				NOW,
				1,
				0,
				0,
				0,
				0,
				null,
				null,
				null,
				null,
			),
		).toThrow();
		expect(() =>
			opinion.run(
				"bad-confidence",
				HEAD,
				NOW,
				0,
				4,
				4,
				4,
				4,
				0.5,
				NOW,
				NOW,
				NOW,
			),
		).toThrow();
		store.close();
	});

	it("keeps authority and snapshots append-only while delivery stays mutable", async () => {
		const store = await StateStore.create(":memory:");
		const db = rawDb(store);
		insertControl(db, {
			eventId: IDS.stop,
			mode: "dry_run",
			messageId: "1517000000000000002",
			controlSeq: 1,
			openingEventId: null,
		});
		db.prepare(
			`INSERT INTO auto_narrow_opinion_snapshot
			 (opinion_id, question_id, run_id, project_name, head_sha,
			  card_message_id, ordinal, captured_at, gate1, gate2, gate3, eligible,
			  machine_reason, reason_code, policy_version, sample_n, agree_n,
			  precision_a, precision_b, confidence_lower, sample_start_at,
			  sample_end_at, last_eligible_human_at)
			 VALUES ('q:1','q','r','flywheel',?,'1517000000000000100',1,?,
			         0,0,0,0,'missing facts','gate1_failed',1,0,0,0,0,NULL,NULL,NULL,NULL)`,
		).run(HEAD, NOW);
		db.prepare(
			`INSERT INTO auto_narrow_opinion_delivery
			 (question_id, issue_thread_id, card_message_id, desired_opinion_id,
			  generation, attempt, state, correlation_marker, reaction_applied,
			  automatic_label_pending)
			 VALUES ('q','1516209714097291335','1517000000000000100','q:1',
			         1,0,'pending','<!-- auto-narrow:q -->','none',0)`,
		).run();
		for (const table of [
			"auto_narrow_control_event",
			"auto_narrow_opinion_snapshot",
		]) {
			expect(() => db.prepare(`UPDATE ${table} SET rowid=rowid`).run()).toThrow(
				/immutable/,
			);
			expect(() => db.prepare(`DELETE FROM ${table}`).run()).toThrow(
				/immutable/,
			);
		}
		expect(
			db
				.prepare(
					"UPDATE auto_narrow_opinion_delivery SET state='posting', attempt=1 WHERE question_id='q'",
				)
				.run().changes,
		).toBe(1);
		store.close();
	});
});
