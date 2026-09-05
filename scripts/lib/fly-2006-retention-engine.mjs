import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statfsSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveMailboxFamily } from "./fly-2006-mailbox-archive.mjs";
import { buildActiveSnapshot } from "./fly-2006-retention-cohort.mjs";
import {
	createSqliteSnapshotFromQuery,
	readSealedJson,
	verifySqliteSnapshot,
	writeSealedJson,
} from "./fly-2006-retention-evidence.mjs";
import {
	assertClassifiedSchema,
	RETENTION_MS,
} from "./fly-2006-retention-registry.mjs";
import {
	FLY2139_STANDING_POLICY,
	FLY2139_STANDING_POLICY_PATH,
	validateFly2139StandingPolicy,
} from "./fly-2139-standing-policy.mjs";

const enginePath = fileURLToPath(import.meta.url);
const registryPath = fileURLToPath(
	new URL("./fly-2006-retention-registry.mjs", import.meta.url),
);
const repoRoot = resolve(dirname(enginePath), "../..");
const packageRequire = createRequire(
	join(repoRoot, "packages/teamlead/package.json"),
);
const Database = packageRequire("better-sqlite3");

export const FLY2006_LIVE_SESSION_STATUSES = Object.freeze([
	"pending",
	"running",
	"ship_parked",
	"awaiting_review",
	"design_done",
	"approved_to_ship",
]);

const SESSION_EVENT_NARRATIVE_TYPES = Object.freeze([
	"issue_thread_infra_notify_skipped",
	"issue_thread_infra_notify_failed",
	"founder_ship_reply_wake_skipped",
	"runner_wake_failed",
	"stage_changed",
	"worktree_reconcile_skip",
	"lifecycle_sweep_worktree_skip",
	"founder_reply_read_failed",
	"issue_thread_infra_notified",
	"state_transition",
	"session_started",
	"session_completed",
	"runner_recovery_nudge",
	"lead_close_runner",
	"chat_thread_archived",
	"closeout_report",
	"closeout_issue_items_blocked",
	"detection_escalation_disposition",
	"lead_close_runner_finalized",
	"worktree_reconcile_gh_unavailable",
	"lifecycle_sweep_failed",
	"tmux_closed",
	"worktree_cleanup_done",
	"lifecycle_sweep_worktree_removed",
	"chat_thread_archive_failed",
	"lifecycle_sweep_gh_unavailable",
	"lead_close_runner_failed",
	"external_merge_suspect",
	"bridge_boot_stale_checkout",
	"detection_suspicious",
]);

const MAILBOX_NARRATIVE_TYPES = Object.freeze([
	"ack_batch",
	"bridge_abnormal_exit",
	"bridge_boot_stale_checkout",
	"dead_letter_notice",
	"discord_chat",
	"external_delivery",
	"external_merge_suspect",
	"inbox_loop_stalled",
	"patrol_tick",
	"runner_idle_detected",
	"runner_login_expired",
	"session_monitoring_lost",
	"session_monitoring_reestablished",
	"session_orphaned",
	"session_stale_completed",
	"session_started",
	"stage_changed",
	"swap_pressure_high",
	"tui_window_lost",
	"workflow_engine_escalation",
	"zombie_session_backlog",
]);

const LEAD_EVENT_NARRATIVE_TYPES = Object.freeze([
	"detection_escalation",
	"detection_page_undeliverable",
	"runner_idle_detected",
	"pane_hash_stuck",
	"session_started",
	"session_completed",
	"session_failed",
	"session_stuck",
	"session_monitoring_lost",
	"session_monitoring_reestablished",
	"session_stale_completed",
	"session_orphaned",
	"auto_qa_stuck",
	"rate_limit",
	"runner_park_notice",
	"zombie_session_backlog",
	"runner_stuck_escalation",
	"bridge_abnormal_exit",
	"external_merge_suspect",
	"checkpoint_park_nudge",
]);

function staticPolicy(key, database, table, primaryKey, predicate, params) {
	return Object.freeze({
		key,
		database,
		table,
		primaryKey,
		candidate: ({ cutoff14 }) => ({
			sql: predicate,
			params: params ? params(cutoff14) : [cutoff14],
		}),
	});
}

export const RETENTION_TARGET_POLICIES = Object.freeze([
	staticPolicy(
		"alertRepairAttempts",
		"teamlead",
		"alert_repair_attempts",
		"id",
		`julianday(t.created_at)<julianday(?) AND EXISTS (
			SELECT 1 FROM alert_threads parent
			WHERE parent.correlation_key=t.correlation_key
			  AND julianday(parent.resolved_at)<julianday(?)
		)`,
		(cutoff14) => [cutoff14, cutoff14],
	),
	staticPolicy(
		"alertThreads",
		"teamlead",
		"alert_threads",
		"correlation_key",
		"julianday(t.resolved_at)<julianday(?) AND (t.repair_status IS NULL OR t.repair_status!='pending')",
	),
	staticPolicy(
		"chatThreads",
		"teamlead",
		"chat_threads",
		"thread_id",
		"t.discord_missing_at IS NOT NULL AND julianday(t.archived_at)<julianday(?)",
	),
	staticPolicy(
		"deploymentEvents",
		"teamlead",
		"deployment_events",
		"id",
		"julianday(t.deployed_at)<julianday(?)",
	),
	staticPolicy(
		"detectionEscalations",
		"teamlead",
		"detection_escalations",
		"__rowid",
		"t.status='RESOLVED' AND julianday(t.created_at)<julianday(?)",
	),
	staticPolicy(
		"leadEventDeliveryAttempts",
		"teamlead",
		"lead_event_delivery_attempts",
		"attempt_id",
		`julianday(COALESCE(t.retired_at,t.finalized_at))<julianday(?)
		 AND t.outcome IN ('pushed','failed')
		 AND EXISTS (SELECT 1 FROM lead_events parent
			WHERE parent.seq=t.event_seq AND parent.delivered_at IS NOT NULL)`,
	),
	Object.freeze({
		key: "leadEvents",
		database: "teamlead",
		table: "lead_events",
		primaryKey: "seq",
		candidate: ({ cutoff14 }) => ({
			sql: `julianday(t.created_at)<julianday(?)
			 AND t.event_type IN (${LEAD_EVENT_NARRATIVE_TYPES.map(() => "?").join(",")})
			 AND t.delivered_at IS NOT NULL
			 AND (t.ack_required=0 OR t.acked_at IS NOT NULL OR t.ack_retired_at IS NOT NULL
			      OR (t.dead_lettered_at IS NOT NULL AND t.ingress_disposed_at IS NOT NULL))
			 AND NOT EXISTS (SELECT 1 FROM lead_event_delivery_attempts child
				WHERE child.event_seq=t.seq)
			 AND NOT EXISTS (SELECT 1 FROM legacy_cutover_quarantine child
				WHERE child.seq=t.seq)
			 AND NOT EXISTS (SELECT 1 FROM legacy_render_fallback child
				WHERE child.seq=t.seq)
			 AND NOT EXISTS (SELECT 1 FROM legacy_stock_suppressed child
				WHERE child.seq=t.seq)`,
			params: [cutoff14, ...LEAD_EVENT_NARRATIVE_TYPES],
		}),
	}),
	staticPolicy(
		"legacyCutoverQuarantine",
		"teamlead",
		"legacy_cutover_quarantine",
		"seq",
		"t.state IN ('accepted','replayed') AND julianday(COALESCE(t.replayed_at,t.accepted_at,t.created_at))<julianday(?)",
	),
	staticPolicy(
		"legacyRenderFallback",
		"teamlead",
		"legacy_render_fallback",
		"seq",
		"julianday(t.fell_back_at)<julianday(?)",
	),
	staticPolicy(
		"legacyStockSuppressed",
		"teamlead",
		"legacy_stock_suppressed",
		"seq",
		"julianday(t.suppressed_at)<julianday(?)",
	),
	staticPolicy(
		"phaseChatThreads",
		"teamlead",
		"phase_chat_threads",
		"thread_id",
		"t.discord_missing_at IS NOT NULL AND julianday(t.archived_at)<julianday(?)",
	),
	staticPolicy(
		"quietWakeNotified",
		"teamlead",
		"quiet_wake_notified",
		"__rowid",
		"julianday(t.notified_at)<julianday(?)",
	),
	staticPolicy(
		"roundtableTopicThreads",
		"teamlead",
		"roundtable_topic_threads",
		"thread_id",
		"t.discord_missing_at IS NOT NULL AND julianday(t.archived_at)<julianday(?)",
	),
	Object.freeze({
		key: "sessionEvents",
		database: "teamlead",
		table: "session_events",
		primaryKey: "id",
		special: true,
	}),
	staticPolicy(
		"tmuxHold",
		"teamlead",
		"tmux_hold",
		"incident_id",
		"julianday(t.resolved_at)<julianday(?)",
	),
	staticPolicy(
		"workflowCompletionDrainChallenge",
		"teamlead",
		"workflow_completion_drain_challenge",
		"challenge_id",
		`t.state IN ('consumed','superseded')
		 AND julianday(COALESCE(t.consumed_at,t.issued_at))<julianday(?)`,
	),
	staticPolicy(
		"workflowRunEvent",
		"teamlead",
		"workflow_run_event",
		"id",
		`julianday(t.at)<julianday(?)
		 AND t.kind IN ('rework_delivery_claimed','rework_delivery_released',
			'workflow_engine_alert_enqueued','workflow_engine_alert_posted')
		 AND EXISTS (SELECT 1 FROM workflow_run parent WHERE parent.run_id=t.run_id
			AND parent.status IN ('completed','terminated','canceled','cancelled'))`,
	),
	staticPolicy(
		"contentRefGcOutbox",
		"comm",
		"content_ref_gc_outbox",
		"intent_id",
		"t.state='done' AND julianday(t.finished_at)<julianday(?)",
	),
	Object.freeze({
		key: "mailbox",
		database: "comm",
		table: "mailbox",
		primaryKey: "seq",
		special: true,
	}),
	staticPolicy(
		"mailboxLog",
		"comm",
		"mailbox_log",
		"log_seq",
		`t.event='migrated_history' AND julianday(t.at)<julianday(?)
		 AND NOT EXISTS (SELECT 1 FROM mailbox live WHERE live.id=t.message_id)`,
	),
	staticPolicy(
		"receiptAlertOutbox",
		"comm",
		"receipt_alert_outbox",
		"id",
		"julianday(COALESCE(t.delivered_at,t.canceled_at))<julianday(?)",
	),
	staticPolicy(
		"runnerPhaseWakes",
		"comm",
		"runner_phase_wakes",
		"queue_seq",
		"t.state='finished' AND t.finished_at<?",
		(cutoff14) => [Date.parse(cutoff14)],
	),
	staticPolicy(
		"runnerShutdownControls",
		"comm",
		"runner_shutdown_controls",
		"execution_id",
		"t.state IN ('acked','failed') AND t.finished_at<?",
		(cutoff14) => [Date.parse(cutoff14)],
	),
	staticPolicy(
		"runnerWakeFailureEpisode",
		"comm",
		"runner_wake_failure_episode",
		"__rowid",
		"julianday(t.closed_at)<julianday(?)",
	),
]);

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
	return sha256(readFileSync(path));
}

function pathEntryExists(path) {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && error.code === "ENOENT")
			return false;
		throw error;
	}
}

function engineSourceDigest() {
	return sha256(
		[
			enginePath,
			"fly-2006-retention-registry.mjs",
			"fly-2006-retention-cohort.mjs",
			"fly-2006-retention-evidence.mjs",
			"fly-2006-mailbox-archive.mjs",
		]
			.map((name) =>
				name === enginePath
					? sha256File(enginePath)
					: sha256File(join(dirname(enginePath), name)),
			)
			.join("\n"),
	);
}

export function fly2139ActivationRequirements() {
	validateFly2139StandingPolicy(FLY2139_STANDING_POLICY);
	return {
		schemaVersion: 1,
		issue: FLY2139_STANDING_POLICY.issue,
		policySha256: sha256File(FLY2139_STANDING_POLICY_PATH),
		registrySha256: sha256File(registryPath),
		engineSha256: engineSourceDigest(),
		globalRowCap: FLY2139_STANDING_POLICY.globalRowCap,
		perTableRowCap: FLY2139_STANDING_POLICY.perTableRowCap,
	};
}

export function validateFly2139ActivationReceipt(input) {
	const expectedPath = resolve(
		input.homeDir ?? homedir(),
		".flywheel",
		"state",
		"log-janitor",
		"db-retention-activation.json",
	);
	if (resolve(input.activationReceiptPath) !== expectedPath) {
		throw new Error("activation_receipt_path_not_canonical");
	}
	let info;
	try {
		info = lstatSync(input.activationReceiptPath);
	} catch {
		throw new Error("activation_receipt_not_regular");
	}
	if (
		info.isSymbolicLink() ||
		!info.isFile() ||
		(info.mode & 0o777) !== 0o600
	) {
		throw new Error("activation_receipt_not_regular");
	}
	const bytes = readFileSync(input.activationReceiptPath);
	let receipt;
	try {
		receipt = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error("activation_receipt_invalid");
	}
	const requirements = fly2139ActivationRequirements();
	const expectedKeys = [
		"approvedAt",
		"approvedBy",
		"engineSha256",
		"globalRowCap",
		"issue",
		"perTableRowCap",
		"policySha256",
		"registrySha256",
		"schemaVersion",
	];
	const actualKeys =
		receipt && typeof receipt === "object" ? Object.keys(receipt).sort() : [];
	if (
		actualKeys.length !== expectedKeys.length ||
		!actualKeys.every((key, index) => key === expectedKeys[index]) ||
		Object.entries(requirements).some(
			([key, value]) => receipt[key] !== value,
		) ||
		typeof receipt.approvedBy !== "string" ||
		receipt.approvedBy.trim() === "" ||
		!Number.isFinite(Date.parse(receipt.approvedAt ?? ""))
	) {
		throw new Error("activation_receipt_invalid");
	}
	return Object.freeze({
		...requirements,
		approvedBy: receipt.approvedBy,
		approvedAt: receipt.approvedAt,
		activationReceiptPath: realpathSync(input.activationReceiptPath),
		activationReceiptSha256: sha256(bytes),
	});
}

export function createFly2139ActivationReceipt(input) {
	const homeDir = input.homeDir ?? homedir();
	const expectedPath = resolve(
		homeDir,
		".flywheel",
		"state",
		"log-janitor",
		"db-retention-activation.json",
	);
	if (resolve(input.activationReceiptPath) !== expectedPath)
		throw new Error("activation_receipt_path_not_canonical");
	const approvedBy = String(input.approvedBy ?? "").trim();
	const approvedAt = String(input.approvedAt ?? "").trim();
	if (!approvedBy || !Number.isFinite(Date.parse(approvedAt)))
		throw new Error("activation_approval_invalid");
	const parent = dirname(expectedPath);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	const parentInfo = lstatSync(parent);
	if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory())
		throw new Error("activation_receipt_parent_unsafe");
	chmodSync(parent, 0o700);
	if (pathEntryExists(expectedPath))
		throw new Error("activation_receipt_exists");
	const receipt = {
		...fly2139ActivationRequirements(),
		approvedBy,
		approvedAt,
	};
	try {
		writeFileSync(expectedPath, `${JSON.stringify(receipt, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		chmodSync(expectedPath, 0o600);
	} catch (error) {
		if (error && typeof error === "object" && error.code === "EEXIST")
			throw new Error("activation_receipt_exists");
		throw error;
	}
	const audit = validateFly2139ActivationReceipt({
		activationReceiptPath: expectedPath,
		homeDir,
	});
	return Object.freeze({
		status: "complete",
		activationReceiptPath: audit.activationReceiptPath,
		activationReceiptSha256: audit.activationReceiptSha256,
	});
}

export function assertFly2139PolicyCaps(manifest) {
	const targets = manifest?.targets;
	if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
		throw new Error("policy_manifest_targets_invalid");
	}
	const allowed = Object.fromEntries(
		Object.entries(FLY2139_STANDING_POLICY.deleteTargets).map(
			([database, tables]) => [database, new Set(tables)],
		),
	);
	const perTableRows = {};
	let totalRows = 0;
	for (const target of Object.values(targets)) {
		const database = target?.database;
		const table = target?.table;
		const candidateCount = target?.candidateCount;
		if (
			typeof database !== "string" ||
			typeof table !== "string" ||
			!Number.isSafeInteger(candidateCount) ||
			candidateCount < 0
		) {
			throw new Error("policy_manifest_target_invalid");
		}
		if (!allowed[database]?.has(table)) {
			throw new Error(`policy_target_not_allowed:${database}.${table}`);
		}
		const key = `${database}.${table}`;
		perTableRows[key] = (perTableRows[key] ?? 0) + candidateCount;
		if (perTableRows[key] > FLY2139_STANDING_POLICY.perTableRowCap) {
			throw new Error(`policy_cap_exceeded:${key}`);
		}
		totalRows += candidateCount;
		if (totalRows > FLY2139_STANDING_POLICY.globalRowCap) {
			throw new Error("policy_cap_exceeded:global");
		}
	}
	return {
		totalRows,
		perTableRows: Object.fromEntries(
			Object.entries(perTableRows).sort(([left], [right]) =>
				left.localeCompare(right),
			),
		),
	};
}

function databaseStateFingerprint(db) {
	const schema = db
		.prepare(
			"SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name",
		)
		.all();
	const foreignKeys = db
		.pragma("foreign_key_check")
		.sort((left, right) =>
			JSON.stringify(left).localeCompare(JSON.stringify(right)),
		);
	return {
		schemaSha256: sha256(JSON.stringify(schema)),
		triggerSha256: sha256(
			JSON.stringify(schema.filter((row) => row.type === "trigger")),
		),
		foreignKeySha256: sha256(JSON.stringify(foreignKeys)),
		foreignKeyViolations: foreignKeys.length,
	};
}

function tableExists(db, table) {
	return Boolean(
		db
			.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?")
			.get(table),
	);
}

function columns(db, table) {
	return db
		.prepare(`PRAGMA table_info("${table}")`)
		.all()
		.map((row) => String(row.name));
}

function tableNames(db) {
	return db
		.prepare(
			"SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all()
		.map((row) => String(row.name));
}

function openReadonly(path) {
	const db = new Database(path, { readonly: true, fileMustExist: true });
	db.pragma("query_only=ON");
	if (Number(db.pragma("query_only", { simple: true })) !== 1)
		throw new Error("query_only_not_enabled");
	return db;
}

function databaseIdentity(path) {
	const info = lstatSync(path);
	if (info.isSymbolicLink() || !info.isFile())
		throw new Error("database_not_regular_file");
	return {
		path: resolve(path),
		realpath: realpathSync(path),
		dev: info.dev,
		ino: info.ino,
	};
}

export function validateFly2006InventoryPaths(input) {
	if (input.allowFixturePaths === true) return;
	const homeDir = input.homeDir ?? homedir();
	const teamlead = realpathSync(join(homeDir, ".flywheel", "teamlead.db"));
	const comm = realpathSync(
		join(homeDir, ".flywheel", "comm", "flywheel", "comm.db"),
	);
	if (realpathSync(input.teamleadDbPath) !== teamlead)
		throw new Error("teamlead_db_path_not_canonical");
	if (realpathSync(input.commDbPath) !== comm)
		throw new Error("comm_db_path_not_canonical");
	const evidenceIssues = input.evidenceIssues ?? ["fly-2006"];
	const evidenceRoots = evidenceIssues.map((issue) =>
		realpathSync(join(homeDir, ".flywheel", "maintenance", issue)),
	);
	if (!evidenceRoots.includes(realpathSync(dirname(input.evidenceDir))))
		throw new Error("evidence_dir_not_canonical_child");
}

function validateHealthUrl(value) {
	const url = new URL(value);
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.pathname !== "/health" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!url.port
	)
		throw new Error("health_url_not_canonical_loopback");
	return url.toString();
}

async function sampleHealth(url, count = 3, timeoutMs = 5_000) {
	const samples = [];
	for (let index = 0; index < count; index += 1) {
		const started = performance.now();
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(url, {
				signal: controller.signal,
				redirect: "error",
			});
			await response.body?.cancel();
			samples.push({
				status: response.status,
				success: response.ok,
				durationMs: Math.round(performance.now() - started),
			});
		} catch (error) {
			samples.push({
				status: null,
				success: false,
				durationMs: Math.round(performance.now() - started),
				error: error instanceof Error ? error.name : "request_failed",
			});
		} finally {
			clearTimeout(timeout);
		}
	}
	return {
		sampleCount: samples.length,
		successCount: samples.filter((sample) => sample.success).length,
		samples,
	};
}

function selectColumn(db, table, preferred) {
	const available = new Set(columns(db, table));
	return preferred.find((name) => available.has(name)) ?? null;
}

function activeSnapshot(teamlead, comm) {
	const liveSessions = tableExists(teamlead, "sessions")
		? teamlead
				.prepare(
					`SELECT execution_id AS executionId,
					 ${selectColumn(teamlead, "sessions", ["issue_identifier", "issue_id"])} AS issueId
					 FROM sessions WHERE status IN (${FLY2006_LIVE_SESSION_STATUSES.map(() => "?").join(",")})`,
				)
				.all(...FLY2006_LIVE_SESSION_STATUSES)
		: [];
	const runs = tableExists(teamlead, "workflow_run")
		? teamlead
				.prepare(
					"SELECT run_id AS runId,status,issue_id AS issueId FROM workflow_run WHERE status IN ('active','held')",
				)
				.all()
		: [];
	const nodes = tableExists(teamlead, "workflow_run_node")
		? teamlead
				.prepare(
					"SELECT run_id AS runId,execution_id AS executionId FROM workflow_run_node WHERE execution_id IS NOT NULL",
				)
				.all()
		: [];
	const commSessions = tableExists(comm, "sessions")
		? comm
				.prepare(
					"SELECT execution_id AS executionId,status,issue_id AS issueId FROM sessions",
				)
				.all()
		: [];
	return buildActiveSnapshot({ liveSessions, runs, nodes, commSessions });
}

function notActiveSql(active, alias, params) {
	const clauses = [];
	for (const [column, values] of [
		["execution_id", active.executionIds],
		["issue_id", active.issueIds],
	]) {
		if (values.length === 0) continue;
		clauses.push(
			`(${alias}.${column} IS NULL OR ${alias}.${column} NOT IN (${values.map(() => "?").join(",")}))`,
		);
		params.push(...values);
	}
	const scalars = [
		...active.executionIds,
		...active.issueIds,
		...active.runIds,
	];
	if (scalars.length > 0) {
		clauses.push(
			`((${alias}.payload IS NULL) OR (json_valid(${alias}.payload) AND NOT EXISTS (
				SELECT 1 FROM json_tree(${alias}.payload) active_value
				WHERE active_value.atom IN (${scalars.map(() => "?").join(",")})
			)))`,
		);
		params.push(...scalars);
	} else {
		clauses.push(`(${alias}.payload IS NULL OR json_valid(${alias}.payload))`);
	}
	return clauses.join(" AND ");
}

function sessionCandidateSpec(db, cutoff14, active) {
	const params = [cutoff14, ...SESSION_EVENT_NARRATIVE_TYPES];
	const activeSql = notActiveSql(active, "e", params);
	const query = `SELECT e.* FROM session_events e
		WHERE julianday(e.ts) IS NOT NULL
		  AND julianday(e.ts) < julianday(?)
		  AND e.event_type IN (${SESSION_EVENT_NARRATIVE_TYPES.map(() => "?").join(",")})
		  AND ${activeSql}
		ORDER BY e.id`;
	return {
		query,
		params,
		primaryKey: "id",
		casFields: columns(db, "session_events"),
	};
}

async function inventorySessionEvents({ db, evidenceDir, cutoff14, active }) {
	if (!tableExists(db, "session_events")) return null;
	const spec = sessionCandidateSpec(db, cutoff14, active);
	const snapshot = await createSqliteSnapshotFromQuery({
		sourceDb: db,
		table: "session_events",
		primaryKey: spec.primaryKey,
		casFields: spec.casFields,
		query: spec.query,
		params: spec.params,
		snapshotPath: join(evidenceDir, "teamlead-session_events.db"),
	});
	const total = Number(
		db.prepare("SELECT count(*) AS n FROM session_events").get().n,
	);
	const recent = Number(
		db
			.prepare(
				"SELECT count(*) AS n FROM session_events WHERE julianday(ts) >= julianday(?)",
			)
			.get(cutoff14).n,
	);
	const invalidTime = Number(
		db
			.prepare(
				"SELECT count(*) AS n FROM session_events WHERE julianday(ts) IS NULL",
			)
			.get().n,
	);
	return {
		database: "teamlead",
		table: "session_events",
		primaryKey: "id",
		candidateCount: snapshot.rowCount,
		recentCount: recent,
		invalidTimeCount: invalidTime,
		protectedCount: total - recent - invalidTime - snapshot.rowCount,
		...snapshot,
	};
}

function mailboxActiveGuard(active, params) {
	const scalars = [
		...active.executionIds,
		...active.issueIds,
		...active.runIds,
	];
	if (scalars.length === 0) return "1=1";
	params.push(...scalars, ...scalars);
	const placeholders = scalars.map(() => "?").join(",");
	return `(m.source_ref IS NULL OR m.source_ref NOT IN (${placeholders}))
		AND (m.sender_ref IS NULL OR (json_valid(m.sender_ref) AND NOT EXISTS (
			SELECT 1 FROM json_tree(m.sender_ref) sender_value
			WHERE sender_value.atom IN (${placeholders})
		)))`;
}

function mailboxCandidateSpec(db, cutoff14, active) {
	const params = [
		"voice-honeylemon-fly1911",
		"terminal_disposed",
		cutoff14,
		...MAILBOX_NARRATIVE_TYPES,
	];
	const activeGuard = mailboxActiveGuard(active, params);
	const predicate = `(
		(m.from_agent=? AND m.relay_state=?)
		OR (
			julianday(CASE WHEN m.state='ACKED' THEN m.acked_at ELSE m.dead_at END) < julianday(?)
			AND m.type IN (${MAILBOX_NARRATIVE_TYPES.map(() => "?").join(",")})
			AND m.kind IS NULL
		)
	)
	AND m.state IN ('ACKED','DEAD')
	AND m.relay_state='terminal_disposed'
	AND m.checkpoint IS NULL
	AND m.ref_id IS NULL
	AND ${activeGuard}
	AND EXISTS (
		SELECT 1 FROM mailbox_identity identity_row
		WHERE identity_row.id=m.id AND identity_row.delivery_id=m.delivery_id
		  AND identity_row.archived_at IS NULL
	)
	AND NOT EXISTS (SELECT 1 FROM mailbox child WHERE child.ref_id=m.id)
	AND NOT EXISTS (SELECT 1 FROM mailbox child WHERE child.superseded_by=m.id)`;
	const query = `SELECT m.* FROM mailbox m WHERE ${predicate} ORDER BY m.seq`;
	return {
		query,
		params,
		primaryKey: "seq",
		casFields: columns(db, "mailbox"),
	};
}

async function inventoryMailbox({ db, evidenceDir, cutoff14, active }) {
	if (!tableExists(db, "mailbox")) return null;
	const spec = mailboxCandidateSpec(db, cutoff14, active);
	const snapshot = await createSqliteSnapshotFromQuery({
		sourceDb: db,
		table: "mailbox",
		primaryKey: spec.primaryKey,
		casFields: spec.casFields,
		query: spec.query,
		params: spec.params,
		snapshotPath: join(evidenceDir, "comm-mailbox.db"),
	});
	const exceptionCount = Number(
		db
			.prepare(
				`SELECT count(*) AS n FROM (${spec.query}) frozen
				 WHERE from_agent='voice-honeylemon-fly1911'
				   AND relay_state='terminal_disposed'`,
			)
			.get(...spec.params).n,
	);
	const total = Number(db.prepare("SELECT count(*) AS n FROM mailbox").get().n);
	return {
		database: "comm",
		table: "mailbox",
		primaryKey: "seq",
		candidateCount: snapshot.rowCount,
		exceptionCount,
		protectedCount: total - snapshot.rowCount,
		...snapshot,
	};
}

function genericActiveGuard(db, table, active, params) {
	const available = new Set(columns(db, table));
	const clauses = [];
	for (const [column, values] of [
		["execution_id", active.executionIds],
		["issue_id", active.issueIds],
		["issue_identifier", active.issueIds],
		["run_id", active.runIds],
	]) {
		if (!available.has(column) || values.length === 0) continue;
		clauses.push(
			`(t."${column}" IS NULL OR t."${column}" NOT IN (${values.map(() => "?").join(",")}))`,
		);
		params.push(...values);
	}
	const activeScalars = [
		...active.executionIds,
		...active.issueIds,
		...active.runIds,
	];
	if (activeScalars.length > 0) {
		for (const jsonColumn of [
			"payload",
			"metadata_json",
			"affected_execution_ids_json",
			"envelope_json",
		]) {
			if (!available.has(jsonColumn)) continue;
			clauses.push(
				`(t."${jsonColumn}" IS NULL OR (json_valid(t."${jsonColumn}") AND NOT EXISTS (
					SELECT 1 FROM json_tree(t."${jsonColumn}") active_value
					WHERE active_value.atom IN (${activeScalars.map(() => "?").join(",")})
				)))`,
			);
			params.push(...activeScalars);
		}
	}
	return clauses.length > 0 ? clauses.join(" AND ") : "1=1";
}

async function inventoryGenericTarget({
	policy,
	db,
	evidenceDir,
	cutoff14,
	active,
}) {
	if (!tableExists(db, policy.table)) return null;
	const spec = genericCandidateSpec(policy, db, cutoff14, active);
	const snapshot = await createSqliteSnapshotFromQuery({
		sourceDb: db,
		table: policy.table,
		primaryKey: policy.primaryKey,
		casFields: spec.casFields,
		query: spec.query,
		params: spec.params,
		snapshotPath: join(evidenceDir, `${policy.database}-${policy.table}.db`),
	});
	const total = Number(
		db.prepare(`SELECT count(*) AS n FROM "${policy.table}"`).get().n,
	);
	return {
		database: policy.database,
		table: policy.table,
		primaryKey: policy.primaryKey,
		candidateCount: snapshot.rowCount,
		protectedCount: total - snapshot.rowCount,
		policySha256: spec.policySha256,
		...snapshot,
	};
}

function genericCandidateSpec(policy, db, cutoff14, active) {
	const candidate = policy.candidate({ cutoff14, active });
	const params = [...candidate.params];
	const activeGuard = genericActiveGuard(db, policy.table, active, params);
	const projection =
		policy.primaryKey === "__rowid" ? "t.rowid AS __rowid,t.*" : "t.*";
	const orderBy =
		policy.primaryKey === "__rowid" ? "t.rowid" : `t."${policy.primaryKey}"`;
	const query = `SELECT ${projection} FROM "${policy.table}" t
		WHERE (${candidate.sql}) AND ${activeGuard}
		ORDER BY ${orderBy}`;
	const casFields = [
		...(policy.primaryKey === "__rowid" ? ["__rowid"] : []),
		...columns(db, policy.table),
	];
	return {
		query,
		params,
		casFields,
		policySha256: sha256(`${candidate.sql}\n${activeGuard}`),
	};
}

export async function executeFly2006Inventory(input) {
	if (!input.allowFixturePaths && !input.healthUrl)
		throw new Error("health_url_required");
	const healthUrl = input.healthUrl ? validateHealthUrl(input.healthUrl) : null;
	validateFly2006InventoryPaths({
		...input,
		evidenceIssues: input.evidenceIssues ?? ["fly-2006"],
	});
	mkdirSync(input.evidenceDir, { mode: 0o700 });
	chmodSync(input.evidenceDir, 0o700);
	mkdirSync(join(input.evidenceDir, "receipts"), { mode: 0o700 });
	const teamlead = openReadonly(input.teamleadDbPath);
	const comm = openReadonly(input.commDbPath);
	try {
		const teamleadTables = tableNames(teamlead);
		const commTables = tableNames(comm);
		const classification = input.allowFixtureSchema
			? {
					teamlead: { total: teamleadTables.length, fixtureSubset: true },
					comm: { total: commTables.length, fixtureSubset: true },
				}
			: {
					teamlead: assertClassifiedSchema("teamlead", teamleadTables),
					comm: assertClassifiedSchema("comm", commTables),
				};
		const startedAt = input.now ?? new Date().toISOString();
		if (!Number.isFinite(Date.parse(startedAt)))
			throw new Error("inventory_now_invalid");
		const cutoff14 = new Date(
			Date.parse(startedAt) - RETENTION_MS,
		).toISOString();
		const healthBefore = healthUrl
			? await sampleHealth(
					healthUrl,
					input.healthSampleCount,
					input.healthTimeoutMs,
				)
			: null;
		const active = activeSnapshot(teamlead, comm);
		const targets = {};
		for (const policy of RETENTION_TARGET_POLICIES.filter(
			(item) => !item.special,
		)) {
			const target = await inventoryGenericTarget({
				policy,
				db: policy.database === "teamlead" ? teamlead : comm,
				evidenceDir: input.evidenceDir,
				cutoff14,
				active,
			});
			if (target) targets[policy.key] = target;
		}
		const sessionEvents = await inventorySessionEvents({
			db: teamlead,
			evidenceDir: input.evidenceDir,
			cutoff14,
			active,
		});
		if (sessionEvents) targets.sessionEvents = sessionEvents;
		const mailbox = await inventoryMailbox({
			db: comm,
			evidenceDir: input.evidenceDir,
			cutoff14,
			active,
		});
		if (mailbox) targets.mailbox = mailbox;
		const manifest = {
			schemaVersion: 2,
			issue: "FLY-2006",
			startedAt,
			completedAt: new Date().toISOString(),
			cutoff14,
			enginePath,
			engineSha256: engineSourceDigest(),
			databases: {
				teamlead: {
					...databaseIdentity(input.teamleadDbPath),
					...databaseStateFingerprint(teamlead),
				},
				comm: {
					...databaseIdentity(input.commDbPath),
					...databaseStateFingerprint(comm),
				},
			},
			classification,
			activeSnapshot: active,
			health: {
				url: healthUrl,
				before: healthBefore,
				after: healthUrl
					? await sampleHealth(
							healthUrl,
							input.healthSampleCount,
							input.healthTimeoutMs,
						)
					: null,
			},
			targets,
			integrity: {
				teamleadQuickCheck: teamlead.pragma("quick_check", { simple: true }),
				commQuickCheck: comm.pragma("quick_check", { simple: true }),
			},
		};
		const manifestPath = join(input.evidenceDir, "manifest.json");
		writeSealedJson(manifestPath, manifest);
		return { status: "inventory_complete", manifestPath, manifest };
	} finally {
		teamlead.close();
		comm.close();
	}
}

function assertDatabaseIdentity(expected) {
	const current = databaseIdentity(expected.path);
	if (
		current.realpath !== expected.realpath ||
		Number(current.dev) !== Number(expected.dev) ||
		Number(current.ino) !== Number(expected.ino)
	)
		throw new Error("database_identity_mismatch");
}

function validateFounderGateAudit(audit, allowFixturePaths) {
	const actualKeys =
		audit && typeof audit === "object" ? Object.keys(audit).sort() : [];
	if (
		allowFixturePaths === true &&
		actualKeys.length === 2 &&
		actualKeys[0] === "purposeDigest" &&
		actualKeys[1] === "source" &&
		audit.source === "isolated-rehearsal" &&
		/^[a-f0-9]{64}$/.test(audit.purposeDigest ?? "")
	) {
		return;
	}
	const exactKeys = [
		"authorId",
		"channelId",
		"messageId",
		"respondedAt",
		"responseDigest",
		"source",
	];
	const snowflake = /^[0-9]{17,20}$/;
	if (
		actualKeys.length !== exactKeys.length ||
		!actualKeys.every((key, index) => key === exactKeys[index]) ||
		audit.source !== "discord-message" ||
		!snowflake.test(audit.channelId ?? "") ||
		!snowflake.test(audit.messageId ?? "") ||
		!snowflake.test(audit.authorId ?? "") ||
		!Number.isFinite(Date.parse(audit.respondedAt ?? "")) ||
		!/^[a-f0-9]{64}$/.test(audit.responseDigest ?? "")
	)
		throw new Error("founder_gate_audit_required");
}

function sameFounderGateAudit(left, right) {
	if (!left || !right || typeof left !== "object" || typeof right !== "object")
		return false;
	const leftEntries = Object.keys(left)
		.sort()
		.map((key) => [key, left[key]]);
	const rightEntries = Object.keys(right)
		.sort()
		.map((key) => [key, right[key]]);
	return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function validateManifestRetentionWindow(manifest, wallClockMs = Date.now()) {
	const startedAtMs = Date.parse(manifest.startedAt ?? "");
	const cutoffMs = Date.parse(manifest.cutoff14 ?? "");
	if (
		!Number.isFinite(startedAtMs) ||
		!Number.isFinite(cutoffMs) ||
		!Number.isFinite(wallClockMs) ||
		startedAtMs - cutoffMs !== RETENTION_MS ||
		startedAtMs > wallClockMs ||
		cutoffMs > wallClockMs - RETENTION_MS
	)
		throw new Error("manifest_retention_window_invalid");
}

function applyCandidateSpec(key, db, cutoff14, active) {
	if (key === "sessionEvents")
		return sessionCandidateSpec(db, cutoff14, active);
	if (key === "mailbox") return mailboxCandidateSpec(db, cutoff14, active);
	const policy = RETENTION_TARGET_POLICIES.find((item) => item.key === key);
	if (!policy || policy.special)
		throw new Error(`target_policy_missing:${key}`);
	return genericCandidateSpec(policy, db, cutoff14, active);
}

export function buildApplyBatches(key, target) {
	if (target.candidateCount === 0) return [];
	if (key === "mailbox" && target.frozen.mode === "range-digest") {
		const snapshot = new Database(target.snapshotPath, {
			readonly: true,
			fileMustExist: true,
		});
		try {
			const primaryKey = String(target.primaryKey).replaceAll('"', '""');
			return [
				...snapshot
					.prepare(
						`SELECT "${primaryKey}" AS value FROM "mailbox" ORDER BY "${primaryKey}"`,
					)
					.iterate(),
			].map((row, index) => ({
				kind: "exact",
				index,
				primaryKeys: [row.value],
			}));
		} finally {
			snapshot.close();
		}
	}
	if (target.frozen.mode === "range-digest") {
		return target.frozen.shards.map((shard, index) => ({
			kind: "range",
			index,
			minPrimaryKey: shard.minPrimaryKey,
			maxPrimaryKey: shard.maxPrimaryKey,
			rowCount: shard.rowCount,
			digest: shard.digest,
		}));
	}
	const size = key === "mailbox" ? 1 : 200;
	const result = [];
	for (
		let offset = 0;
		offset < target.frozen.primaryKeys.length;
		offset += size
	) {
		result.push({
			kind: "exact",
			index: result.length,
			primaryKeys: target.frozen.primaryKeys.slice(offset, offset + size),
		});
	}
	return result;
}

function primaryKeySql(target, alias = "") {
	const prefix = alias ? `${alias}.` : "";
	return target.primaryKey === "__rowid"
		? `${prefix}__rowid`
		: `${prefix}"${target.primaryKey}"`;
}

function batchFilter(target, batch, params) {
	const primaryKey = primaryKeySql(target, "candidate");
	if (batch.kind === "range") {
		params.push(batch.minPrimaryKey, batch.maxPrimaryKey);
		return `${primaryKey} BETWEEN ? AND ?`;
	}
	params.push(...batch.primaryKeys);
	return `${primaryKey} IN (${batch.primaryKeys.map(() => "?").join(",")})`;
}

function snapshotRows(target, batch) {
	const snapshot = new Database(target.snapshotPath, {
		readonly: true,
		fileMustExist: true,
	});
	try {
		const projection =
			target.primaryKey === "__rowid" ? "rowid AS __rowid,*" : "*";
		const params = [];
		const filter = batchFilter(target, batch, params).replaceAll(
			"candidate.",
			"",
		);
		const orderBy =
			target.primaryKey === "__rowid" ? "rowid" : `"${target.primaryKey}"`;
		return snapshot
			.prepare(
				`SELECT ${projection} FROM "${target.table}" WHERE ${filter} ORDER BY ${orderBy}`,
			)
			.all(...params);
	} finally {
		snapshot.close();
	}
}

function currentCandidateRows(db, target, spec, batch, expected) {
	if (batch.kind === "exact") {
		const params = [...spec.params, ...batch.primaryKeys];
		const primaryKey = primaryKeySql(target, "candidate");
		return db
			.prepare(
				`SELECT candidate.* FROM (${spec.query}) candidate
				 WHERE ${primaryKey} IN (${batch.primaryKeys.map(() => "?").join(",")})
				 ORDER BY ${primaryKey}`,
			)
			.all(...params);
	}
	db.exec("DROP TABLE IF EXISTS temp.fly2006_candidate_keys");
	db.exec("CREATE TEMP TABLE fly2006_candidate_keys(key PRIMARY KEY)");
	try {
		const insert = db.prepare(
			"INSERT INTO fly2006_candidate_keys(key) VALUES(?)",
		);
		const insertAll = db.transaction((rows) => {
			for (const row of rows) insert.run(row[target.primaryKey]);
		});
		insertAll.immediate(expected);
		const primaryKey = primaryKeySql(target, "candidate");
		return db
			.prepare(
				`SELECT candidate.* FROM (${spec.query}) candidate
				 INNER JOIN fly2006_candidate_keys frozen_key ON frozen_key.key=${primaryKey}
				 ORDER BY ${primaryKey}`,
			)
			.all(...spec.params);
	} finally {
		db.exec("DROP TABLE IF EXISTS temp.fly2006_candidate_keys");
	}
}

function rowsDigest(rows) {
	return sha256(rows.map((row) => JSON.stringify(row)).join("\n"));
}

function assertRowsMatch(expected, current, table) {
	if (
		expected.length !== current.length ||
		rowsDigest(expected) !== rowsDigest(current)
	)
		throw new Error(`candidate_cas_mismatch:${table}`);
}

function baseRowsByKeys(db, target, expected) {
	if (expected.length === 0) return [];
	const keys = expected.map((row) => row[target.primaryKey]);
	const expression =
		target.primaryKey === "__rowid" ? "rowid" : `"${target.primaryKey}"`;
	const result = [];
	for (let offset = 0; offset < keys.length; offset += 500) {
		const group = keys.slice(offset, offset + 500);
		result.push(
			...db
				.prepare(
					`SELECT 1 FROM "${target.table}" WHERE ${expression} IN (${group.map(() => "?").join(",")})`,
				)
				.all(...group),
		);
	}
	return result;
}

function batchReceiptPath(manifestPath, key, batch) {
	return join(
		dirname(manifestPath),
		"receipts",
		`${key}-${String(batch.index + 1).padStart(4, "0")}.json`,
	);
}

function readBatchReceipt(path, manifestSha256, key, batch, expected) {
	const receipt = readSealedJson(path, "batch_receipt");
	if (
		receipt.issue !== "FLY-2006" ||
		receipt.status !== "committed" ||
		receipt.manifestSha256 !== manifestSha256 ||
		receipt.target !== key ||
		receipt.batch !== batch.index + 1 ||
		receipt.rowCount !== expected.length
	)
		throw new Error("batch_receipt_identity_mismatch");
	return receipt;
}

function deleteRowsInTransaction(db, target, current) {
	const triggerNames = {
		workflow_run_event: "workflow_run_event_no_delete",
		mailbox_log: "mailbox_log_no_delete",
	};
	const triggerName = triggerNames[target.table];
	const triggerSql = triggerName
		? db
				.prepare(
					"SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?",
				)
				.get(triggerName)?.sql
		: null;
	const keys = current.map((row) => row[target.primaryKey]);
	db.exec("BEGIN IMMEDIATE");
	try {
		db.exec("DROP TABLE IF EXISTS temp.fly2006_delete_keys");
		db.exec("CREATE TEMP TABLE fly2006_delete_keys(key PRIMARY KEY)");
		const insert = db.prepare("INSERT INTO fly2006_delete_keys(key) VALUES(?)");
		for (const key of keys) insert.run(key);
		if (triggerName) {
			if (!triggerSql)
				throw new Error(`required_trigger_missing:${triggerName}`);
			db.exec(`DROP TRIGGER "${triggerName}"`);
		}
		const expression =
			target.primaryKey === "__rowid" ? "rowid" : `"${target.primaryKey}"`;
		const changes = db
			.prepare(
				`DELETE FROM "${target.table}" WHERE ${expression} IN (SELECT key FROM fly2006_delete_keys)`,
			)
			.run().changes;
		if (changes !== current.length)
			throw new Error(`delete_changes_mismatch:${target.table}`);
		if (triggerSql) db.exec(triggerSql);
		db.exec("DROP TABLE temp.fly2006_delete_keys");
		db.exec("COMMIT");
	} catch (error) {
		if (db.inTransaction) db.exec("ROLLBACK");
		try {
			db.exec("DROP TABLE IF EXISTS temp.fly2006_delete_keys");
		} catch {}
		throw error;
	}
}

async function applyTarget({
	key,
	target,
	db,
	spec,
	manifestPath,
	manifestSha256,
	archiveNow,
	testHooks,
}) {
	if (target.candidateCount === 0) return 0;
	await verifySqliteSnapshot({
		snapshotPath: target.snapshotPath,
		expectedSha256: target.snapshotSha256,
		table: target.table,
		primaryKey: target.primaryKey,
		casFields: target.frozen.casFields,
		frozen: target.frozen,
		tableSqlSha256: target.tableSqlSha256,
	});
	let deleted = 0;
	for (const batch of buildApplyBatches(key, target)) {
		const expected = snapshotRows(target, batch);
		const receiptPath = batchReceiptPath(manifestPath, key, batch);
		if (existsSync(receiptPath)) {
			readBatchReceipt(receiptPath, manifestSha256, key, batch, expected);
			if (baseRowsByKeys(db, target, expected).length > 0)
				throw new Error("batch_receipt_row_still_present");
			deleted += expected.length;
			continue;
		}
		const current = currentCandidateRows(db, target, spec, batch, expected);
		if (key === "mailbox") {
			if (expected.length !== 1)
				throw new Error("mailbox_batch_must_be_single_row");
			if (current.length === 0) {
				if (baseRowsByKeys(db, target, expected).length > 0)
					throw new Error(`candidate_cas_mismatch:${target.table}`);
				const outcome = archiveMailboxFamily({
					db,
					id: expected[0].id,
					now: archiveNow,
					retentionMs:
						expected[0].from_agent === "voice-honeylemon-fly1911" &&
						expected[0].relay_state === "terminal_disposed"
							? 0
							: RETENTION_MS,
				});
				if (outcome !== "idempotent")
					throw new Error(
						`mailbox_archive_failed:${expected[0].id}:${outcome}`,
					);
			} else {
				assertRowsMatch(expected, current, target.table);
				for (const row of current) {
					const retentionMs =
						row.from_agent === "voice-honeylemon-fly1911" &&
						row.relay_state === "terminal_disposed"
							? 0
							: RETENTION_MS;
					const outcome = archiveMailboxFamily({
						db,
						id: row.id,
						now: archiveNow,
						retentionMs,
					});
					if (outcome !== "archived")
						throw new Error(`mailbox_archive_failed:${row.id}:${outcome}`);
					testHooks?.afterMailboxArchive?.(row.id);
				}
			}
		} else {
			assertRowsMatch(expected, current, target.table);
			deleteRowsInTransaction(db, target, current);
		}
		writeSealedJson(receiptPath, {
			issue: "FLY-2006",
			status: "committed",
			manifestSha256,
			target: key,
			batch: batch.index + 1,
			kind: batch.kind,
			rowCount: expected.length,
			...(batch.kind === "range"
				? {
						minPrimaryKey: batch.minPrimaryKey,
						maxPrimaryKey: batch.maxPrimaryKey,
						digest: batch.digest,
					}
				: { primaryKeys: batch.primaryKeys }),
		});
		deleted += expected.length;
	}
	if (deleted !== target.candidateCount)
		throw new Error(`deleted_count_mismatch:${target.table}`);
	return deleted;
}

async function executeFrozenApply(input, authority) {
	const authorityField = authority.field;
	const authorityAudit = authority.audit;
	const manifest = readSealedJson(input.manifestPath, "manifest");
	if (manifest.issue !== "FLY-2006" || manifest.schemaVersion !== 2)
		throw new Error("manifest_identity_mismatch");
	validateManifestRetentionWindow(manifest);
	const manifestSha256 = sha256File(input.manifestPath);
	const applyReceiptPath = join(
		dirname(input.manifestPath),
		"apply-receipt.json",
	);
	if (existsSync(applyReceiptPath)) {
		const receipt = readSealedJson(applyReceiptPath, "apply_receipt");
		if (
			receipt.issue !== authority.issue ||
			receipt.status !== "complete" ||
			receipt.manifestSha256 !== manifestSha256 ||
			!sameFounderGateAudit(receipt[authorityField], authorityAudit)
		)
			throw new Error("apply_receipt_identity_mismatch");
		return { ...receipt, applyReceiptPath };
	}
	if (manifest.engineSha256 !== engineSourceDigest())
		throw new Error("engine_digest_mismatch");
	const applyStarted = performance.now();
	assertDatabaseIdentity(manifest.databases.teamlead);
	assertDatabaseIdentity(manifest.databases.comm);
	if (!input.allowFixturePaths) {
		validateFly2006InventoryPaths({
			teamleadDbPath: manifest.databases.teamlead.path,
			commDbPath: manifest.databases.comm.path,
			evidenceDir: dirname(input.manifestPath),
			evidenceIssues: [authority.evidenceIssue],
		});
	}
	const teamlead = new Database(manifest.databases.teamlead.path, {
		fileMustExist: true,
	});
	const comm = new Database(manifest.databases.comm.path, {
		fileMustExist: true,
	});
	let committedTargets = 0;
	try {
		teamlead.pragma("busy_timeout=5000");
		comm.pragma("busy_timeout=5000");
		for (const [name, db] of [
			["teamlead", teamlead],
			["comm", comm],
		]) {
			const state = databaseStateFingerprint(db);
			const expected = manifest.databases[name];
			if (
				state.schemaSha256 !== expected.schemaSha256 ||
				state.triggerSha256 !== expected.triggerSha256 ||
				state.foreignKeySha256 !== expected.foreignKeySha256
			)
				throw new Error(`database_state_drift:${name}`);
		}
		const active = activeSnapshot(teamlead, comm);
		const deleted = {};
		for (const [key, target] of Object.entries(manifest.targets)) {
			const db = target.database === "teamlead" ? teamlead : comm;
			const spec = applyCandidateSpec(key, db, manifest.cutoff14, active);
			deleted[key] = await applyTarget({
				key,
				target,
				db,
				spec,
				manifestPath: input.manifestPath,
				manifestSha256,
				archiveNow: new Date().toISOString(),
				testHooks: input.testHooks,
			});
			committedTargets += 1;
			input.testHooks?.afterTarget?.(key);
		}
		const integrity = {};
		for (const [name, db] of [
			["teamlead", teamlead],
			["comm", comm],
		]) {
			const state = databaseStateFingerprint(db);
			const expected = manifest.databases[name];
			if (
				state.schemaSha256 !== expected.schemaSha256 ||
				state.triggerSha256 !== expected.triggerSha256 ||
				state.foreignKeySha256 !== expected.foreignKeySha256
			)
				throw new Error(`database_state_changed:${name}`);
			const quickCheck = db.pragma("quick_check", { simple: true });
			const integrityCheck = db.pragma("integrity_check", { simple: true });
			if (quickCheck !== "ok" || integrityCheck !== "ok")
				throw new Error(`database_integrity_failed:${name}`);
			integrity[name] = {
				quickCheck,
				integrityCheck,
				foreignKeySha256: state.foreignKeySha256,
			};
		}
		const receipt = {
			issue: authority.issue,
			status: "complete",
			manifestPath: realpathSync(input.manifestPath),
			manifestSha256,
			[authorityField]: authorityAudit,
			deleted,
			integrity,
			durationMs: Math.max(1, Math.ceil(performance.now() - applyStarted)),
			completedAt: new Date().toISOString(),
		};
		writeSealedJson(applyReceiptPath, receipt);
		return { ...receipt, applyReceiptPath };
	} catch (error) {
		if (committedTargets > 0) {
			const partialPath = join(
				dirname(input.manifestPath),
				"apply-partial.json",
			);
			if (!existsSync(partialPath)) {
				writeSealedJson(partialPath, {
					issue: authority.issue,
					status: "partial",
					manifestSha256,
					committedTargets,
					error: error instanceof Error ? error.message : String(error),
					recordedAt: new Date().toISOString(),
				});
			}
		}
		throw error;
	} finally {
		teamlead.close();
		comm.close();
	}
}

export async function executeFly2006Apply(input) {
	validateFounderGateAudit(input.founderGateAudit, input.allowFixturePaths);
	return executeFrozenApply(input, {
		issue: "FLY-2006",
		field: "founderGateAudit",
		audit: input.founderGateAudit,
		evidenceIssue: "fly-2006",
	});
}

function writeFly2139PolicyFailure(manifestPath, activationAudit, error) {
	const failurePath = join(dirname(manifestPath), "policy-apply-failure.json");
	if (!existsSync(failurePath)) {
		writeSealedJson(failurePath, {
			issue: "FLY-2139",
			status: "failed",
			manifestPath: realpathSync(manifestPath),
			manifestSha256: sha256File(manifestPath),
			activationReceiptSha256: activationAudit.activationReceiptSha256,
			error: error instanceof Error ? error.message : String(error),
			recordedAt: new Date().toISOString(),
		});
	}
	return failurePath;
}

export async function executeFly2139PolicyApply(input) {
	const activationAudit = validateFly2139ActivationReceipt({
		activationReceiptPath: input.activationReceiptPath,
		homeDir: input.homeDir,
	});
	const manifest = readSealedJson(input.manifestPath, "manifest");
	if (manifest.issue !== "FLY-2006" || manifest.schemaVersion !== 2)
		throw new Error("manifest_identity_mismatch");
	validateManifestRetentionWindow(manifest);
	if (!input.allowFixturePaths) {
		validateFly2006InventoryPaths({
			teamleadDbPath: manifest.databases.teamlead.path,
			commDbPath: manifest.databases.comm.path,
			evidenceDir: dirname(input.manifestPath),
			evidenceIssues: ["fly-2139"],
		});
	}
	let actualRows;
	try {
		actualRows = assertFly2139PolicyCaps(manifest);
	} catch (error) {
		writeFly2139PolicyFailure(input.manifestPath, activationAudit, error);
		throw error;
	}
	const policyAudit = Object.freeze({
		...activationAudit,
		actualRows,
	});
	return executeFrozenApply(input, {
		issue: "FLY-2139",
		field: "policyAudit",
		audit: policyAudit,
		evidenceIssue: "fly-2139",
	});
}

function existingFileBytes(path) {
	return existsSync(path) ? statSync(path).size : 0;
}

function vacuumDatabaseState(db, path) {
	return {
		identity: databaseIdentity(path),
		mainBytes: existingFileBytes(path),
		walBytes: existingFileBytes(`${path}-wal`),
		pageCount: Number(db.pragma("page_count", { simple: true })),
		freelistCount: Number(db.pragma("freelist_count", { simple: true })),
	};
}

function validateVacuumBinding({
	ack,
	database,
	manifestSha256,
	rehearsalSummarySha256,
	maxDurationMs,
	rehearsalSummary,
}) {
	if (
		ack.issue !== "FLY-2006" ||
		ack.database !== database ||
		ack.manifestSha256 !== manifestSha256 ||
		ack.rehearsalSummarySha256 !== rehearsalSummarySha256 ||
		ack.maxDurationMs !== maxDurationMs ||
		typeof ack.token !== "string" ||
		ack.token.trim().length < 16 ||
		!Number.isFinite(Date.parse(ack.acknowledgedAt ?? ""))
	)
		throw new Error("quiescence_ack_binding_invalid");
	if (
		rehearsalSummary.issue !== "FLY-2006" ||
		rehearsalSummary.status !== "complete"
	)
		throw new Error("rehearsal_summary_invalid");
	const rehearsalDuration = rehearsalSummary.vacuumDurationsMs?.[database];
	if (!Number.isFinite(rehearsalDuration) || rehearsalDuration < 0)
		throw new Error("rehearsal_vacuum_duration_missing");
	if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs <= 0)
		throw new Error("vacuum_max_duration_invalid");
	if (maxDurationMs < rehearsalDuration)
		throw new Error("vacuum_max_duration_below_rehearsal");
}

export async function executeFly2006Vacuum(input) {
	if (!new Set(["teamlead", "comm"]).has(input.database))
		throw new Error("vacuum_database_invalid");
	const manifest = readSealedJson(input.manifestPath, "manifest");
	if (manifest.issue !== "FLY-2006" || manifest.schemaVersion !== 2)
		throw new Error("manifest_identity_mismatch");
	const manifestSha256 = sha256File(input.manifestPath);
	const evidenceDir = dirname(input.manifestPath);
	const applyReceiptPath = join(evidenceDir, "apply-receipt.json");
	if (!existsSync(applyReceiptPath))
		throw new Error("complete_apply_receipt_required");
	const applyReceipt = readSealedJson(applyReceiptPath, "apply_receipt");
	if (
		applyReceipt.issue !== "FLY-2006" ||
		applyReceipt.status !== "complete" ||
		applyReceipt.manifestSha256 !== manifestSha256
	)
		throw new Error("complete_apply_receipt_required");
	const startedPath = join(
		evidenceDir,
		`vacuum-${input.database}-started.json`,
	);
	const receiptPath = join(
		evidenceDir,
		`vacuum-${input.database}-receipt.json`,
	);
	if (existsSync(receiptPath)) throw new Error("quiescence_ack_already_used");
	const startedMarker = existsSync(startedPath)
		? readSealedJson(startedPath, "vacuum_started")
		: null;
	const rehearsalSummary = readSealedJson(
		input.rehearsalSummaryPath,
		"rehearsal_summary",
	);
	const rehearsalSummarySha256 = sha256File(input.rehearsalSummaryPath);
	const ack = readSealedJson(input.quiescenceAckPath, "quiescence_ack");
	validateVacuumBinding({
		ack,
		database: input.database,
		manifestSha256,
		rehearsalSummarySha256,
		maxDurationMs: input.maxDurationMs,
		rehearsalSummary,
	});
	const quiescenceAckSha256 = sha256File(input.quiescenceAckPath);
	const applyReceiptSha256 = sha256File(applyReceiptPath);
	if (
		startedMarker &&
		(startedMarker.issue !== "FLY-2006" ||
			startedMarker.status !== "started" ||
			startedMarker.database !== input.database ||
			startedMarker.manifestSha256 !== manifestSha256 ||
			startedMarker.applyReceiptSha256 !== applyReceiptSha256 ||
			startedMarker.quiescenceAckSha256 !== quiescenceAckSha256 ||
			startedMarker.rehearsalSummarySha256 !== rehearsalSummarySha256 ||
			startedMarker.maxDurationMs !== input.maxDurationMs)
	)
		throw new Error("vacuum_started_identity_mismatch");
	const expectedDatabase = manifest.databases[input.database];
	assertDatabaseIdentity(expectedDatabase);
	if (!input.allowFixturePaths) {
		validateFly2006InventoryPaths({
			teamleadDbPath: manifest.databases.teamlead.path,
			commDbPath: manifest.databases.comm.path,
			evidenceDir,
		});
	}
	const db = new Database(expectedDatabase.path, { fileMustExist: true });
	try {
		db.pragma("busy_timeout=0");
		const stateBefore = databaseStateFingerprint(db);
		if (
			stateBefore.schemaSha256 !== expectedDatabase.schemaSha256 ||
			stateBefore.triggerSha256 !== expectedDatabase.triggerSha256 ||
			stateBefore.foreignKeySha256 !== expectedDatabase.foreignKeySha256
		)
			throw new Error(`database_state_drift:${input.database}`);
		const currentBefore = vacuumDatabaseState(db, expectedDatabase.path);
		const before = startedMarker?.before ?? currentBefore;
		const requiredBytes =
			2 * (currentBefore.mainBytes + currentBefore.walBytes) +
			1024 * 1024 * 1024;
		const disk = statfsSync(dirname(expectedDatabase.path));
		const availableBytes =
			input.testHooks?.availableBytes ??
			Number(disk.bavail) * Number(disk.bsize);
		if (availableBytes < requiredBytes)
			throw new Error("vacuum_disk_space_insufficient");
		try {
			db.exec("BEGIN EXCLUSIVE; ROLLBACK");
		} catch (error) {
			if (error?.code === "SQLITE_BUSY") throw new Error("vacuum_writer_busy");
			throw error;
		}
		if (!startedMarker) {
			writeSealedJson(startedPath, {
				issue: "FLY-2006",
				status: "started",
				database: input.database,
				manifestSha256,
				applyReceiptSha256,
				quiescenceAckSha256,
				rehearsalSummarySha256,
				maxDurationMs: input.maxDurationMs,
				requiredBytes,
				availableBytes,
				before,
				startedAt: new Date().toISOString(),
			});
		}
		input.testHooks?.afterStarted?.();
		const started = performance.now();
		try {
			db.exec("VACUUM");
			if (db.pragma("journal_mode", { simple: true }) === "wal")
				db.pragma("wal_checkpoint(TRUNCATE)");
		} catch (error) {
			if (error?.code === "SQLITE_BUSY") throw new Error("vacuum_sqlite_busy");
			throw error;
		}
		const durationMs = Math.ceil(performance.now() - started);
		const stateAfter = databaseStateFingerprint(db);
		if (
			stateAfter.schemaSha256 !== expectedDatabase.schemaSha256 ||
			stateAfter.triggerSha256 !== expectedDatabase.triggerSha256 ||
			stateAfter.foreignKeySha256 !== expectedDatabase.foreignKeySha256
		)
			throw new Error(`database_state_changed:${input.database}`);
		const quickCheck = db.pragma("quick_check", { simple: true });
		const integrityCheck = db.pragma("integrity_check", { simple: true });
		if (quickCheck !== "ok" || integrityCheck !== "ok")
			throw new Error(`database_integrity_failed:${input.database}`);
		const after = vacuumDatabaseState(db, expectedDatabase.path);
		const status = durationMs > input.maxDurationMs ? "degraded" : "complete";
		const receipt = {
			issue: "FLY-2006",
			status,
			recoveredFromStartedMarker: startedMarker !== null,
			database: input.database,
			manifestSha256,
			applyReceiptSha256,
			quiescenceAckSha256,
			rehearsalSummarySha256,
			maxDurationMs: input.maxDurationMs,
			durationMs,
			before,
			after,
			integrity: {
				quickCheck,
				integrityCheck,
				foreignKeySha256: stateAfter.foreignKeySha256,
			},
			completedAt: new Date().toISOString(),
		};
		writeSealedJson(receiptPath, receipt);
		return { ...receipt, startedPath, receiptPath };
	} finally {
		db.close();
	}
}

function maintenancePathSpec(input) {
	const flywheelRoot = resolve(homedir(), ".flywheel");
	const databasePath = resolve(input.databasePath);
	if (input.database === "teamlead") {
		if (databasePath !== join(flywheelRoot, "teamlead.db")) {
			throw new Error("maintenance_database_path_not_canonical");
		}
		return { flywheelRoot, project: null };
	}
	const project = basename(dirname(databasePath));
	if (
		!/^[A-Za-z0-9._-]+$/.test(project) ||
		project === "." ||
		project === ".." ||
		databasePath !== join(flywheelRoot, "comm", project, "comm.db")
	) {
		throw new Error("maintenance_database_path_not_canonical");
	}
	return { flywheelRoot, project };
}

function validateMaintenancePaths(input) {
	if (input.allowFixturePaths === true) return;
	const { flywheelRoot, project } = maintenancePathSpec(input);
	const actualDatabase = realpathSync(input.databasePath);
	if (input.database === "teamlead") {
		if (actualDatabase !== realpathSync(join(flywheelRoot, "teamlead.db"))) {
			throw new Error("maintenance_database_path_not_canonical");
		}
	} else if (
		actualDatabase !==
		join(realpathSync(join(flywheelRoot, "comm")), project, "comm.db")
	) {
		throw new Error("maintenance_database_path_not_canonical");
	}
	const evidenceRoot = realpathSync(
		join(flywheelRoot, "maintenance", "fly-2139", "db-maintenance"),
	);
	if (realpathSync(dirname(input.evidenceDir)) !== evidenceRoot) {
		throw new Error("maintenance_evidence_dir_not_canonical");
	}
}

function normalizeCheckpointResult(value) {
	const row = Array.isArray(value) ? value[0] : value;
	const checkpoint = {
		busy: Number(row?.busy),
		log: Number(row?.log),
		checkpointed: Number(row?.checkpointed),
	};
	if (
		!Object.values(checkpoint).every(
			(item) => Number.isSafeInteger(item) && item >= 0,
		)
	) {
		throw new Error("maintenance_checkpoint_result_invalid");
	}
	return checkpoint;
}

function runMaintenanceCheckpoint(db, phase, testHooks) {
	try {
		const injected = testHooks?.checkpointResult?.(phase);
		return normalizeCheckpointResult(
			injected ?? db.pragma("wal_checkpoint(TRUNCATE)"),
		);
	} catch (error) {
		if (error?.code === "SQLITE_BUSY") {
			throw new Error(`maintenance_checkpoint_busy:${phase}`);
		}
		throw error;
	}
}

function checkpointHasUnflushedPages(checkpoint) {
	return checkpoint.busy !== 0 && checkpoint.log !== checkpoint.checkpointed;
}

function writeMaintenanceFailure(path, input, reason, checkpoint) {
	if (!existsSync(path)) {
		writeSealedJson(path, {
			issue: "FLY-2139",
			status: "failed",
			database: input.database,
			databasePath: realpathSync(input.databasePath),
			reason,
			...(checkpoint ? { checkpoint } : {}),
			recordedAt: new Date().toISOString(),
		});
	}
}

export async function executeFly2139MaintenanceVacuum(input) {
	if (!new Set(["teamlead", "comm"]).has(input.database)) {
		throw new Error("maintenance_database_invalid");
	}
	if (!Number.isSafeInteger(input.maxDurationMs) || input.maxDurationMs <= 0) {
		throw new Error("maintenance_max_duration_invalid");
	}
	if (input.allowFixturePaths !== true) maintenancePathSpec(input);
	const databaseInfo = lstatSync(input.databasePath);
	if (databaseInfo.isSymbolicLink() || !databaseInfo.isFile()) {
		throw new Error("maintenance_database_not_regular");
	}
	validateMaintenancePaths(input);
	if (existsSync(input.evidenceDir)) {
		const evidenceInfo = lstatSync(input.evidenceDir);
		if (evidenceInfo.isSymbolicLink() || !evidenceInfo.isDirectory()) {
			throw new Error("maintenance_evidence_dir_unsafe");
		}
	} else {
		mkdirSync(input.evidenceDir, { mode: 0o700 });
	}
	chmodSync(input.evidenceDir, 0o700);
	const startedPath = join(
		input.evidenceDir,
		`maintenance-${input.database}-started.json`,
	);
	const receiptPath = join(
		input.evidenceDir,
		`maintenance-${input.database}-receipt.json`,
	);
	const failurePath = join(
		input.evidenceDir,
		`maintenance-${input.database}-failure.json`,
	);
	if (existsSync(receiptPath)) {
		const receipt = readSealedJson(receiptPath, "maintenance_receipt");
		if (
			receipt.issue !== "FLY-2139" ||
			receipt.status !== "complete" ||
			receipt.database !== input.database ||
			receipt.databasePath !== realpathSync(input.databasePath)
		) {
			throw new Error("maintenance_receipt_identity_mismatch");
		}
		return { ...receipt, receiptPath };
	}
	const startedMarker = existsSync(startedPath)
		? readSealedJson(startedPath, "maintenance_started")
		: null;
	if (
		startedMarker &&
		(startedMarker.issue !== "FLY-2139" ||
			startedMarker.status !== "started" ||
			startedMarker.database !== input.database ||
			startedMarker.databasePath !== realpathSync(input.databasePath))
	) {
		throw new Error("maintenance_started_identity_mismatch");
	}
	const db = new Database(input.databasePath, { fileMustExist: true });
	let checkpoint;
	try {
		db.pragma("busy_timeout=0");
		const schemaBefore = databaseStateFingerprint(db);
		const currentBefore = vacuumDatabaseState(db, input.databasePath);
		const before = startedMarker?.before ?? currentBefore;
		const requiredBytes =
			2 * (currentBefore.mainBytes + currentBefore.walBytes) +
			1024 * 1024 * 1024;
		const disk = statfsSync(dirname(input.databasePath));
		const availableBytes =
			input.testHooks?.availableBytes ??
			Number(disk.bavail) * Number(disk.bsize);
		if (availableBytes < requiredBytes) {
			throw new Error("maintenance_disk_space_insufficient");
		}
		try {
			db.exec("BEGIN EXCLUSIVE; ROLLBACK");
		} catch (error) {
			if (error?.code === "SQLITE_BUSY") {
				throw new Error("maintenance_writer_busy");
			}
			throw error;
		}
		if (!startedMarker) {
			writeSealedJson(startedPath, {
				issue: "FLY-2139",
				status: "started",
				database: input.database,
				databasePath: realpathSync(input.databasePath),
				requiredBytes,
				availableBytes,
				before,
				startedAt: new Date().toISOString(),
			});
		}
		input.testHooks?.afterStarted?.();
		checkpoint = runMaintenanceCheckpoint(db, "before", input.testHooks);
		if (checkpointHasUnflushedPages(checkpoint)) {
			throw new Error("maintenance_checkpoint_busy:before");
		}
		const vacuumStarted = performance.now();
		try {
			db.exec("VACUUM");
		} catch (error) {
			if (error?.code === "SQLITE_BUSY") {
				throw new Error("maintenance_vacuum_busy");
			}
			throw error;
		}
		const measuredDurationMs = Math.ceil(performance.now() - vacuumStarted);
		const durationMs = input.testHooks?.durationMs ?? measuredDurationMs;
		if (!Number.isFinite(durationMs) || durationMs < 0) {
			throw new Error("maintenance_duration_invalid");
		}
		const checkpointAfter = runMaintenanceCheckpoint(
			db,
			"after",
			input.testHooks,
		);
		if (checkpointHasUnflushedPages(checkpointAfter)) {
			checkpoint = checkpointAfter;
			throw new Error("maintenance_checkpoint_busy:after");
		}
		let quickCheck;
		let integrityCheck;
		try {
			quickCheck = db.pragma("quick_check", { simple: true });
			integrityCheck = db.pragma("integrity_check", { simple: true });
		} catch (error) {
			if (error?.code === "SQLITE_BUSY") {
				throw new Error("maintenance_integrity_busy");
			}
			throw error;
		}
		if (quickCheck !== "ok" || integrityCheck !== "ok") {
			throw new Error("maintenance_integrity_failed");
		}
		const schemaAfter = databaseStateFingerprint(db);
		if (
			schemaAfter.schemaSha256 !== schemaBefore.schemaSha256 ||
			schemaAfter.triggerSha256 !== schemaBefore.triggerSha256 ||
			schemaAfter.foreignKeySha256 !== schemaBefore.foreignKeySha256
		) {
			throw new Error("maintenance_database_state_changed");
		}
		const after = vacuumDatabaseState(db, input.databasePath);
		const durationExceeded = durationMs > input.maxDurationMs;
		const receipt = {
			issue: "FLY-2139",
			status: "complete",
			slaStatus: durationExceeded ? "degraded" : "within_budget",
			durationExceeded,
			recoveredFromStartedMarker: startedMarker !== null,
			database: input.database,
			databasePath: realpathSync(input.databasePath),
			before,
			after,
			checkpoint: { before: checkpoint, after: checkpointAfter },
			integrity: { quickCheck, integrityCheck },
			durationMs,
			maxDurationMs: input.maxDurationMs,
			completedAt: new Date().toISOString(),
		};
		writeSealedJson(receiptPath, receipt);
		return { ...receipt, receiptPath };
	} catch (error) {
		writeMaintenanceFailure(
			failurePath,
			input,
			error instanceof Error ? error.message : String(error),
			checkpoint,
		);
		throw error;
	} finally {
		db.close();
	}
}
