import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";

describe("FLY-1392 receipt foundation schema", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1392-schema-"));
		dbPath = join(dir, "comm.db");
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("creates receipt, retry, family, wake, and alert-outbox storage", () => {
		new CommDB(dbPath).close();
		const raw = new Database(dbPath, { readonly: true });
		try {
			const columns = (table: string) =>
				(
					raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{
						name: string;
					}>
				).map(({ name }) => name);
			expect(columns("lead_inbox")).toEqual(
				expect.arrayContaining([
					"processed_at",
					"processed_evidence",
					"read_at",
					"escalated_at",
					"next_retry_at",
					"next_unprocessed_at",
					"resend_of",
					"resend_round",
					"candidates_json",
					"family_root_id",
					"routing_state",
				]),
			);
			expect(columns("runner_phase_wakes")).toEqual(
				expect.arrayContaining([
					"admission_state",
					"envelope_json",
					"push_attempts",
					"last_push_at",
					"last_push_result",
					"claim_token",
					"claim_expires_at",
					"t2_claimed_at",
					"t2_result",
					"escalation_outbox_id",
					"purpose",
				]),
			);
			expect(columns("receipt_alert_outbox")).toEqual([
				"id",
				"kind",
				"payload",
				"created_at",
				"delivered_at",
				"canceled_at",
				"cancel_reason",
			]);
			const indexes = (
				raw
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
					)
					.all() as Array<{ name: string }>
			).map(({ name }) => name);
			expect(indexes).toContain("idx_lead_inbox_resend");
		} finally {
			raw.close();
		}
	});

	it("migrates an existing pre-FLY-1392 database before creating dependent indexes", () => {
		new CommDB(dbPath).close();
		const raw = new Database(dbPath);
		try {
			raw.exec("DROP TRIGGER receipt_root_lineage_capture");
			raw.exec("DROP TRIGGER receipt_root_lineage_no_update");
			raw.exec("DROP TRIGGER receipt_root_lineage_no_delete");
			raw.exec("DROP TABLE receipt_root_lineage");
			raw.exec("DROP TRIGGER lead_inbox_receipt_terminal_insert");
			raw.exec("DROP TRIGGER lead_inbox_receipt_terminal_update");
			raw.exec("DROP INDEX idx_lead_inbox_resend");
			raw.exec("DROP TABLE receipt_alert_outbox");
			for (const table of [
				"receipt_resend_deliveries",
				"receipt_handle_requests",
				"receipt_exemption_audit",
				"receipt_activation_episodes",
			]) {
				raw.exec(`DROP TABLE ${table}`);
			}
			raw.exec("DROP INDEX IF EXISTS idx_lead_inbox_pending");
			for (const column of [
				"delivered_rounds",
				"receipt_episode_id",
				"receipt_exempt_reason",
				"disposed_evidence",
				"disposed_at",
				"carrier",
				"routing_state",
				"family_root_id",
				"candidates_json",
				"resend_round",
				"resend_of",
				"next_unprocessed_at",
				"next_retry_at",
				"escalated_at",
				"read_at",
				"processed_evidence",
				"processed_at",
			]) {
				raw.exec(`ALTER TABLE lead_inbox DROP COLUMN ${column}`);
			}
			for (const column of [
				"escalation_outbox_id",
				"t2_result",
				"t2_claimed_at",
				"claim_expires_at",
				"claim_token",
				"last_push_result",
				"last_push_at",
				"push_attempts",
				"envelope_json",
				"admission_state",
				"purpose",
			]) {
				raw.exec(`ALTER TABLE runner_phase_wakes DROP COLUMN ${column}`);
			}
		} finally {
			raw.close();
		}

		expect(() => new CommDB(dbPath).close()).not.toThrow();
		const migrated = new Database(dbPath);
		try {
			const leadColumns = (
				migrated.prepare("PRAGMA table_info(lead_inbox)").all() as Array<{
					name: string;
				}>
			).map(({ name }) => name);
			const wakeColumns = (
				migrated
					.prepare("PRAGMA table_info(runner_phase_wakes)")
					.all() as Array<{
					name: string;
				}>
			).map(({ name }) => name);
			expect(leadColumns).toContain("processed_evidence");
			expect(leadColumns).toContain("routing_state");
			expect(leadColumns).toContain("carrier");
			expect(leadColumns).toContain("delivered_rounds");
			expect(wakeColumns).toContain("push_attempts");
			expect(wakeColumns).toContain("escalation_outbox_id");
			expect(wakeColumns).toContain("purpose");
			expect(
				migrated
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'receipt_root_lineage'",
					)
					.get(),
			).toEqual({ name: "receipt_root_lineage" });
			expect(() =>
				migrated
					.prepare(
						`INSERT INTO runner_phase_wakes
						   (execution_id, message_id, content, state, queued_at, purpose)
						 VALUES ('exec-invalid', 'message-invalid', 'x', 'pending', 1, 'foreign')`,
					)
					.run(),
			).toThrow(/purpose check failed/i);
		} finally {
			migrated.close();
		}
	});

	it("creates the v2 category-agnostic receipt schema and enforces terminal pairing", () => {
		new CommDB(dbPath).close();
		const raw = new Database(dbPath);
		try {
			const leadColumns = new Set(
				(
					raw.prepare("PRAGMA table_info(lead_inbox)").all() as Array<{
						name: string;
					}>
				).map(({ name }) => name),
			);
			for (const name of [
				"carrier",
				"disposed_at",
				"disposed_evidence",
				"receipt_exempt_reason",
				"receipt_episode_id",
				"delivered_rounds",
			]) {
				expect(leadColumns).toContain(name);
			}

			for (const table of [
				"receipt_activation_episodes",
				"receipt_exemption_audit",
				"receipt_handle_requests",
				"receipt_resend_deliveries",
			]) {
				expect(
					raw
						.prepare(
							"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
						)
						.get(table),
				).toBeTruthy();
			}

			raw.exec(`
				INSERT INTO lead_inbox (
				  id, to_lead, source, type, msg_class, priority, content
				) VALUES ('pending', 'lead-a', 'test', 'new_kind', 'model', 2, 'x')
			`);
			expect(() =>
				raw
					.prepare(
						"UPDATE lead_inbox SET processed_at = ? WHERE id = 'pending'",
					)
					.run("2026-07-21T12:00:00.000Z"),
			).toThrow(/processed.*evidence/i);
			expect(() =>
				raw
					.prepare(
						"UPDATE lead_inbox SET disposed_evidence = ? WHERE id = 'pending'",
					)
					.run('{"kind":"closed"}'),
			).toThrow(/disposed.*evidence/i);

			raw
				.prepare(
					"UPDATE lead_inbox SET processed_at = ?, processed_evidence = ? WHERE id = 'pending'",
				)
				.run("2026-07-21T12:00:00.000Z", '{"kind":"handled"}');
			expect(() =>
				raw
					.prepare(
						"UPDATE lead_inbox SET disposed_at = ?, disposed_evidence = ? WHERE id = 'pending'",
					)
					.run("2026-07-21T12:01:00.000Z", '{"kind":"closed"}'),
			).toThrow(/terminal.*exclusive/i);
		} finally {
			raw.close();
		}
	});
});
