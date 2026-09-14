import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexSessionStateDir } from "../../packages/claude-runner/dist/index.js";
import { StateStore } from "../../packages/teamlead/dist/StateStore.js";
import { backfillReceipts } from "../fly-2490-backfill-receipts.mjs";

const Database = createRequire(
	new URL("../../packages/teamlead/package.json", import.meta.url),
)("better-sqlite3");

test("dry-run is physically read-only; apply is explicit, audited, and idempotent", async () => {
	const root = mkdtempSync(join(tmpdir(), "fly2490-ops-"));
	const statePath = join(root, "state.db");
	const commPath = join(root, "comm.db");
	const comm = new Database(commPath);
	comm.exec("CREATE TABLE sessions (execution_id TEXT PRIMARY KEY)");
	comm.close();
	let store = await StateStore.create(statePath);
	const executionId = "c070fce7-2b7e-44cb-9073-26b4e3200ede";
	const sourceEventId = "historical-failure";
	store.upsertSession({
		execution_id: executionId,
		issue_id: "issue-2351",
		issue_identifier: "FLY-2351",
		project_name: "flywheel",
		status: "failed",
		adapter_type: "codex-tmux",
	});
	store.insertLaunchClaim({
		executionId,
		rootUuid: "issue-2351",
		project: "flywheel",
	});
	store.casLaunchClaimState(executionId, "starting", "closed");
	store.insertEvent({
		event_id: sourceEventId,
		execution_id: executionId,
		issue_id: "issue-2351",
		project_name: "flywheel",
		event_type: "session_failed",
		source: "direct-event-sink",
		ts: "2026-09-09 07:24:19",
		payload: { failureKind: "worktree_takeover_failed" },
	});
	store.close();
	const fixtureDb = new Database(statePath);
	fixtureDb
		.prepare("UPDATE session_events SET ts = ? WHERE event_id = ?")
		.run("2026-09-09 07:24:19", sourceEventId);
	fixtureDb.close();
	const options = {
		statePath,
		commPath,
		sessionRoot: join(root, "s"),
		socketRoot: join(root, "d"),
		manifest: [{ executionId, sourceEventId, issueIdentifier: "FLY-2351" }],
	};
	const hash = () =>
		createHash("sha256").update(readFileSync(statePath)).digest("hex");
	try {
		const before = hash();
		assert.deepEqual((await backfillReceipts(options)).nodes[0], {
			...options.manifest[0],
			action: "would_insert",
		});
		assert.equal(hash(), before);
		for (const [sql, reason, restore] of [
			[
				"UPDATE sessions SET status = 'running'",
				"not_failed_empty_node",
				"UPDATE sessions SET status = 'failed'",
			],
			[
				"UPDATE sessions SET tmux_session = 'window'",
				"not_failed_empty_node",
				"UPDATE sessions SET tmux_session = NULL",
			],
			[
				"UPDATE lifecycle_launch_claims SET state = 'cancelled'",
				"claim_not_closed",
				"UPDATE lifecycle_launch_claims SET state = 'closed'",
			],
			[
				"UPDATE session_events SET source = 'http-events'",
				"historical_evidence_missing",
				"UPDATE session_events SET source = 'direct-event-sink'",
			],
		]) {
			const db = new Database(statePath);
			db.exec(sql);
			db.close();
			assert.equal((await backfillReceipts(options)).nodes[0].reason, reason);
			await assert.rejects(
				backfillReceipts({ ...options, apply: true, confirmQuiesced: true }),
				/backfill_batch_refused/,
			);
			const undo = new Database(statePath);
			undo.exec(restore);
			undo.close();
		}

		for (const payload of [
			{ failure: { failureKind: "worktree_takeover_failed" } },
			{ failureKind: "adapter_failed" },
			{},
			null,
		]) {
			const db = new Database(statePath);
			db.prepare(
				"UPDATE session_events SET payload = ? WHERE event_id = ?",
			).run(JSON.stringify(payload), sourceEventId);
			db.close();
			assert.equal(
				(await backfillReceipts(options)).nodes[0].reason,
				"historical_evidence_missing",
			);
			await assert.rejects(
				backfillReceipts({ ...options, apply: true, confirmQuiesced: true }),
				/backfill_batch_refused/,
			);
		}
		const restorePayload = new Database(statePath);
		restorePayload
			.prepare("UPDATE session_events SET payload = ? WHERE event_id = ?")
			.run(
				JSON.stringify({ failureKind: "worktree_takeover_failed" }),
				sourceEventId,
			);
		restorePayload.close();

		const daemonDir = codexSessionStateDir(executionId, {
			FLYWHEEL_CODEX_SESSION_DIR: options.sessionRoot,
		});
		mkdirSync(daemonDir, { recursive: true });
		writeFileSync(join(daemonDir, "session.json"), "{}");
		assert.equal(
			(await backfillReceipts(options)).nodes[0].reason,
			"daemon_evidence_present",
		);
		rmSync(daemonDir, { recursive: true });

		await assert.rejects(
			backfillReceipts({ ...options, apply: true }),
			/confirm_quiesced_required/,
		);
		assert.equal(
			(
				await backfillReceipts({
					...options,
					apply: true,
					confirmQuiesced: true,
				})
			).nodes[0].action,
			"inserted",
		);
		assert.equal(
			(
				await backfillReceipts({
					...options,
					apply: true,
					confirmQuiesced: true,
				})
			).nodes[0].action,
			"already_recorded",
		);
		store = await StateStore.create(statePath);
		assert.equal(
			store.getPreAdapterFailureReceipt(executionId).sourceEventId,
			sourceEventId,
		);
		assert.equal(
			store
				.getEventsByExecution(executionId)
				.filter(
					(e) => e.event_type === "pre_adapter_receipt_backfill_authorized",
				).length,
			1,
		);
		store.close();
		const db = new Database(commPath);
		db.prepare("INSERT INTO sessions VALUES (?)").run(executionId);
		db.close();
		assert.equal(
			(await backfillReceipts(options)).nodes[0].reason,
			"commdb_row_present",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
