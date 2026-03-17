import { randomUUID } from "node:crypto";
import initSqlJs, { type Database } from "sql.js";
import {
	readFileSync,
	writeFileSync,
	existsSync,
	renameSync,
	mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import { classifyOutcome, maturityLevel } from "./statistics.js";
import type {
	SnapshotParams,
	OutcomeParams,
	CipherPrinciple,
	CipherNotifyFn,
} from "./types.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS decision_snapshots (
  execution_id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  issue_identifier TEXT NOT NULL,
  issue_title TEXT NOT NULL,
  project_id TEXT NOT NULL,
  issue_labels TEXT NOT NULL,
  size_bucket TEXT NOT NULL,
  area_touched TEXT NOT NULL,
  system_route TEXT NOT NULL,
  system_confidence REAL NOT NULL,
  decision_source TEXT NOT NULL,
  decision_reasoning TEXT,
  commit_count INTEGER NOT NULL,
  files_changed INTEGER NOT NULL,
  lines_added INTEGER NOT NULL,
  lines_removed INTEGER NOT NULL,
  diff_summary TEXT,
  commit_messages TEXT,
  changed_file_paths TEXT,
  exit_reason TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  pattern_keys TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decision_reviews (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL UNIQUE,
  ceo_action TEXT NOT NULL,
  ceo_outcome TEXT NOT NULL,
  friction_score TEXT NOT NULL DEFAULT 'low',
  ceo_action_timestamp TEXT NOT NULL,
  notification_timestamp TEXT,
  time_to_decision_seconds INTEGER,
  thread_ts TEXT,
  thread_message_count INTEGER,
  ceo_message_count INTEGER,
  source_status TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (execution_id) REFERENCES decision_snapshots(execution_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_outcome ON decision_reviews(ceo_outcome);
CREATE INDEX IF NOT EXISTS idx_reviews_created ON decision_reviews(created_at);

CREATE TABLE IF NOT EXISTS decision_patterns (
  pattern_key TEXT PRIMARY KEY,
  approve_count INTEGER NOT NULL DEFAULT 0,
  reject_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  maturity_level TEXT NOT NULL DEFAULT 'exploratory',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_90d_approve INTEGER DEFAULT 0,
  last_90d_total INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS review_pattern_keys (
  review_id TEXT NOT NULL,
  pattern_key TEXT NOT NULL,
  is_approve INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (review_id, pattern_key),
  FOREIGN KEY (review_id) REFERENCES decision_reviews(id)
);
CREATE INDEX IF NOT EXISTS idx_rpk_pattern ON review_pattern_keys(pattern_key);
CREATE INDEX IF NOT EXISTS idx_rpk_created ON review_pattern_keys(created_at);

CREATE TABLE IF NOT EXISTS pattern_summary_cache (
  id TEXT PRIMARY KEY DEFAULT 'global',
  global_approve_count INTEGER DEFAULT 0,
  global_reject_count INTEGER DEFAULT 0,
  global_approve_rate REAL DEFAULT 0.5,
  prior_strength INTEGER DEFAULT 10,
  last_computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cipher_skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  source_pattern_key TEXT,
  trigger_conditions TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  confidence REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  derived_from_reviews TEXT,
  derived_by TEXT NOT NULL DEFAULT 'statistical',
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cipher_principles (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  rule_definition TEXT NOT NULL,
  confidence REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  source_pattern TEXT NOT NULL DEFAULT '',
  graduation_criteria TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  activated_at TEXT,
  retired_at TEXT,
  retired_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (skill_id) REFERENCES cipher_skills(id)
);

CREATE TABLE IF NOT EXISTS cipher_questions (
  id TEXT PRIMARY KEY,
  question_type TEXT NOT NULL,
  description TEXT NOT NULL,
  related_pattern_key TEXT,
  evidence TEXT NOT NULL,
  asked_at TEXT,
  resolved_at TEXT,
  resolution TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function sqlNow(): string {
	return new Date()
		.toISOString()
		.replace("T", " ")
		.replace(/\.\d+Z$/, "");
}

export class CipherWriter {
	private db!: Database;
	private notifyFn?: CipherNotifyFn;
	private syncAfterDreamingFn?: (db: Database) => Promise<void>;
	private outcomeCount = 0;
	private lastRefreshAt = Date.now();

	private constructor(private dbPath: string) {}

	static async create(dbPath: string): Promise<CipherWriter> {
		const writer = new CipherWriter(dbPath);
		await writer.init();
		return writer;
	}

	private async init(): Promise<void> {
		mkdirSync(dirname(this.dbPath), { recursive: true });
		const SQL = await initSqlJs();
		if (existsSync(this.dbPath)) {
			const buffer = readFileSync(this.dbPath);
			this.db = new SQL.Database(buffer);
		} else {
			this.db = new SQL.Database();
		}
		this.db.run(SCHEMA_SQL);
		this.db.run(
			`INSERT OR IGNORE INTO pattern_summary_cache (id) VALUES ('global')`,
		);

		// Restore dreaming counters from persisted data so a process restart
		// does not lose track of when the next dreaming cycle should fire.
		const countResult = this.db.exec(
			`SELECT COUNT(*) FROM decision_reviews`,
		);
		if (countResult.length > 0 && countResult[0]!.values.length > 0) {
			this.outcomeCount = Number(countResult[0]!.values[0]![0]) || 0;
		}
		const lastSkillResult = this.db.exec(
			`SELECT MAX(updated_at) FROM cipher_skills`,
		);
		if (
			lastSkillResult.length > 0 &&
			lastSkillResult[0]!.values.length > 0 &&
			lastSkillResult[0]!.values[0]![0]
		) {
			const ts = new Date(lastSkillResult[0]!.values[0]![0] as string).getTime();
			if (!isNaN(ts)) this.lastRefreshAt = ts;
		}

		this.save();
	}

	private save(): void {
		const data = this.db.export();
		const tmpPath = this.dbPath + ".tmp";
		writeFileSync(tmpPath, Buffer.from(data));
		renameSync(tmpPath, this.dbPath);
	}

	private runInTransaction<T>(fn: () => T): T {
		this.db.run("BEGIN TRANSACTION");
		try {
			const result = fn();
			this.db.run("COMMIT");
			this.save();
			return result;
		} catch (err) {
			this.db.run("ROLLBACK");
			throw err;
		}
	}

	/** Injected by TeamLead composition root */
	setNotifyFn(fn: CipherNotifyFn): void {
		this.notifyFn = fn;
	}

	/** Injected by TeamLead composition root for Supabase sync after dreaming */
	setSyncAfterDreaming(fn: (db: Database) => Promise<void>): void {
		this.syncAfterDreamingFn = fn;
	}

	/** Expose the sql.js Database for CipherSyncService */
	getDatabase(): Database {
		return this.db;
	}

	// --- Phase A: saveSnapshot ---

	async saveSnapshot(params: SnapshotParams): Promise<void> {
		this.db.run(
			`INSERT OR IGNORE INTO decision_snapshots (
        execution_id, issue_id, issue_identifier, issue_title, project_id,
        issue_labels, size_bucket, area_touched,
        system_route, system_confidence, decision_source, decision_reasoning,
        commit_count, files_changed, lines_added, lines_removed,
        diff_summary, commit_messages, changed_file_paths,
        exit_reason, duration_ms, consecutive_failures, pattern_keys
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				params.executionId,
				params.issueId,
				params.issueIdentifier,
				params.issueTitle,
				params.projectId,
				JSON.stringify(params.issueLabels),
				params.dimensions.sizeBucket,
				params.dimensions.areaTouched,
				params.systemRoute,
				params.systemConfidence,
				params.decisionSource,
				params.decisionReasoning ?? null,
				params.commitCount,
				params.filesChanged,
				params.linesAdded,
				params.linesRemoved,
				params.diffSummary ?? null,
				JSON.stringify(params.commitMessages),
				JSON.stringify(params.changedFilePaths),
				params.exitReason,
				params.durationMs,
				params.consecutiveFailures,
				JSON.stringify(params.patternKeys),
			],
		);
		this.save();
	}

	// --- Phase B: recordOutcome ---

	async recordOutcome(params: OutcomeParams): Promise<void> {
		const snapRows = this.db.exec(
			`SELECT created_at, pattern_keys FROM decision_snapshots WHERE execution_id = ?`,
			[params.executionId],
		);
		if (snapRows.length === 0 || snapRows[0]!.values.length === 0) return;

		const [notificationTs, patternKeysJson] = snapRows[0]!.values[0]! as [
			string,
			string,
		];
		const patternKeys: string[] = JSON.parse(patternKeysJson);
		// sqlNow() strips 'Z' — append it so Date parses as UTC (not local)
		const notificationTime = new Date(notificationTs + "Z").getTime();
		const actionTime = new Date(params.ceoActionTimestamp).getTime();
		const timeToDecision = Math.round(
			(actionTime - notificationTime) / 1000,
		);

		const outcome = classifyOutcome(params.ceoAction, timeToDecision);
		const isApprove = params.ceoAction === "approve" ? 1 : 0;
		const reviewId = randomUUID();
		const now = sqlNow();

		this.runInTransaction(() => {
			// 1. Insert review
			this.db.run(
				`INSERT INTO decision_reviews (
          id, execution_id, ceo_action, ceo_outcome, ceo_action_timestamp,
          notification_timestamp, time_to_decision_seconds, source_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					reviewId,
					params.executionId,
					params.ceoAction,
					outcome,
					params.ceoActionTimestamp,
					notificationTs,
					timeToDecision,
					params.sourceStatus ?? null,
					now,
				],
			);

			// 2. Update patterns + insert junction rows
			for (const key of patternKeys) {
				this.db.run(
					`INSERT INTO decision_patterns (pattern_key, approve_count, reject_count, total_count, first_seen_at, last_seen_at, last_90d_approve, last_90d_total)
           VALUES (?, ?, ?, 1, ?, ?, ?, 1)
           ON CONFLICT(pattern_key) DO UPDATE SET
             approve_count = approve_count + ?,
             reject_count = reject_count + ?,
             total_count = total_count + 1,
             last_seen_at = ?,
             last_90d_approve = last_90d_approve + ?,
             last_90d_total = last_90d_total + 1`,
					[
						key,
						isApprove,
						1 - isApprove,
						now,
						now,
						isApprove,
						isApprove,
						1 - isApprove,
						now,
						isApprove,
					],
				);

				// Recalculate maturity
				const rows = this.db.exec(
					`SELECT total_count FROM decision_patterns WHERE pattern_key = ?`,
					[key],
				);
				if (rows.length > 0 && rows[0]!.values.length > 0) {
					const total = rows[0]!.values[0]![0] as number;
					this.db.run(
						`UPDATE decision_patterns SET maturity_level = ? WHERE pattern_key = ?`,
						[maturityLevel(total), key],
					);
				}

				// Junction row
				this.db.run(
					`INSERT INTO review_pattern_keys (review_id, pattern_key, is_approve, created_at)
           VALUES (?, ?, ?, ?)`,
					[reviewId, key, isApprove, now],
				);
			}

			// 3. Update global summary
			this.db.run(
				`UPDATE pattern_summary_cache SET
          global_approve_count = global_approve_count + ?,
          global_reject_count = global_reject_count + ?,
          global_approve_rate = CAST(global_approve_count + ? AS REAL) / MAX(global_approve_count + global_reject_count + 1, 1),
          last_computed_at = ?
         WHERE id = 'global'`,
				[isApprove, 1 - isApprove, isApprove, now],
			);
		});

		this.outcomeCount++;

		// Auto-trigger dreaming periodically
		const hoursSinceRefresh =
			(Date.now() - this.lastRefreshAt) / (1000 * 60 * 60);
		if (this.outcomeCount % 50 === 0 || hoursSinceRefresh >= 24) {
			try {
				await this.runDreaming();
			} catch (err) {
				console.error("[CIPHER] Dreaming failed:", err);
			}
		}
	}

	// --- Temporal windows ---

	async refreshTemporalWindows(): Promise<void> {
		const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
			.toISOString()
			.replace("T", " ")
			.replace(/\.\d+Z$/, "");
		const decayThreshold = new Date(
			Date.now() - 60 * 24 * 60 * 60 * 1000,
		)
			.toISOString()
			.replace("T", " ")
			.replace(/\.\d+Z$/, "");

		this.runInTransaction(() => {
			this.db.run(
				`UPDATE decision_patterns SET last_90d_approve = 0, last_90d_total = 0`,
			);
			this.db.run(
				`UPDATE decision_patterns SET
          last_90d_approve = (SELECT COALESCE(SUM(rpk.is_approve), 0) FROM review_pattern_keys rpk WHERE rpk.pattern_key = decision_patterns.pattern_key AND rpk.created_at >= ?),
          last_90d_total = (SELECT COUNT(*) FROM review_pattern_keys rpk WHERE rpk.pattern_key = decision_patterns.pattern_key AND rpk.created_at >= ?)`,
				[cutoff, cutoff],
			);

			this.db.run(
				`UPDATE decision_patterns SET maturity_level = CASE
           WHEN maturity_level = 'trusted' THEN 'established'
           WHEN maturity_level = 'established' THEN 'tentative'
           ELSE maturity_level END
         WHERE last_seen_at < ? AND maturity_level IN ('trusted', 'established')`,
				[decayThreshold],
			);
		});
	}

	// --- Wave 2: Questions ---

	async detectQuestions(): Promise<void> {
		const now = sqlNow();
		const patterns = this.db.exec(
			`SELECT pattern_key, approve_count, reject_count, total_count, maturity_level
       FROM decision_patterns WHERE total_count >= 5`,
		);
		if (patterns.length === 0 || patterns[0]!.values.length === 0) return;

		for (const row of patterns[0]!.values) {
			const [key, ac, rc, tc, _ml] = row as [
				string,
				number,
				number,
				number,
				string,
			];
			const approveRate = ac / tc;

			// Pattern conflict: 40-60% approve rate with sufficient samples
			if (approveRate >= 0.4 && approveRate <= 0.6 && tc >= 10) {
				const exists = this.db.exec(
					`SELECT 1 FROM cipher_questions WHERE related_pattern_key = ? AND status IN ('open', 'asked')`,
					[key],
				);
				if (exists.length === 0 || exists[0]!.values.length === 0) {
					this.db.run(
						`INSERT INTO cipher_questions (id, question_type, description, related_pattern_key, evidence, created_at)
             VALUES (?, 'pattern_conflict', ?, ?, ?, ?)`,
						[
							randomUUID(),
							`Pattern "${key}" has near-50/50 approve/reject split (${(approveRate * 100).toFixed(0)}% approve). What should the policy be?`,
							key,
							JSON.stringify({
								approve: ac,
								reject: rc,
								total: tc,
								rate: approveRate,
							}),
							now,
						],
					);
				}
			}

			// Drift detection: check if recent 90d rate differs from all-time by 20%+
			const recentRows = this.db.exec(
				`SELECT last_90d_approve, last_90d_total FROM decision_patterns WHERE pattern_key = ?`,
				[key],
			);
			if (
				recentRows.length > 0 &&
				recentRows[0]!.values.length > 0 &&
				tc >= 20
			) {
				const [r90Approve, r90Total] = recentRows[0]!.values[0]! as [
					number,
					number,
				];
				if (r90Total >= 5) {
					const recentRate = r90Approve / r90Total;
					if (Math.abs(recentRate - approveRate) > 0.2) {
						const exists = this.db.exec(
							`SELECT 1 FROM cipher_questions WHERE related_pattern_key = ? AND question_type = 'drift_detected' AND status IN ('open', 'asked')`,
							[key],
						);
						if (
							exists.length === 0 ||
							exists[0]!.values.length === 0
						) {
							this.db.run(
								`INSERT INTO cipher_questions (id, question_type, description, related_pattern_key, evidence, created_at)
                 VALUES (?, 'drift_detected', ?, ?, ?, ?)`,
								[
									randomUUID(),
									`Pattern "${key}" shows drift: all-time ${(approveRate * 100).toFixed(0)}% vs recent ${(recentRate * 100).toFixed(0)}% approve rate.`,
									key,
									JSON.stringify({
										allTime: approveRate,
										recent: recentRate,
										total: tc,
										recent90d: r90Total,
									}),
									now,
								],
							);
						}
					}
				}
			}
		}

		// New territory: first-time patterns
		const newPatterns = this.db.exec(
			`SELECT pattern_key FROM decision_patterns WHERE total_count = 1`,
		);
		if (newPatterns.length > 0) {
			for (const row of newPatterns[0]!.values) {
				const key = row[0] as string;
				// Only flag singles (not pairs/triples) for new territory
				const dimPart = key.split(":")[0]!;
				if (dimPart.includes("+")) continue;

				const exists = this.db.exec(
					`SELECT 1 FROM cipher_questions WHERE related_pattern_key = ? AND question_type = 'new_territory' AND status IN ('open', 'asked')`,
					[key],
				);
				if (exists.length === 0 || exists[0]!.values.length === 0) {
					this.db.run(
						`INSERT INTO cipher_questions (id, question_type, description, related_pattern_key, evidence, created_at)
             VALUES (?, 'new_territory', ?, ?, ?, ?)`,
						[
							randomUUID(),
							`New pattern "${key}" — first occurrence. No historical data for comparison.`,
							key,
							JSON.stringify({ total: 1 }),
							now,
						],
					);
				}
			}
		}

		this.save();
	}

	// --- Wave 2: Skills ---

	async extractSkills(): Promise<void> {
		const now = sqlNow();
		const patterns = this.db.exec(
			`SELECT pattern_key, approve_count, reject_count, total_count, maturity_level
       FROM decision_patterns
       WHERE maturity_level IN ('established', 'trusted') AND total_count >= 20`,
		);
		if (patterns.length === 0 || patterns[0]!.values.length === 0) return;

		for (const row of patterns[0]!.values) {
			const [key, ac, _rc, tc, ml] = row as [
				string,
				number,
				number,
				number,
				string,
			];
			const approveRate = ac / tc;

			// Skip ambiguous patterns
			if (approveRate > 0.3 && approveRate < 0.7) continue;

			const action =
				approveRate >= 0.7 ? "likely_approve" : "likely_reject";
			const confidence =
				approveRate >= 0.7 ? approveRate : 1 - approveRate;
			const name = `Auto-${action}: ${key}`;
			const description = `Pattern "${key}" shows ${(approveRate * 100).toFixed(0)}% approve rate over ${tc} samples (${ml}).`;

			// Update existing skill if pattern already tracked, otherwise insert new
			const exists = this.db.exec(
				`SELECT id FROM cipher_skills WHERE source_pattern_key = ?`,
				[key],
			);
			if (exists.length > 0 && exists[0]!.values.length > 0) {
				this.db.run(
					`UPDATE cipher_skills SET confidence = ?, sample_count = ?, recommended_action = ?, name = ?, description = ?, updated_at = ? WHERE source_pattern_key = ?`,
					[confidence, tc, action, name, description, now, key],
				);
			} else {
				this.db.run(
					`INSERT INTO cipher_skills (id, name, description, source_pattern_key, trigger_conditions, recommended_action, confidence, sample_count, derived_by, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'statistical', 'active', ?, ?)`,
					[
						randomUUID(),
						name,
						description,
						key,
						JSON.stringify({ pattern_key: key }),
						action,
						confidence,
						tc,
						now,
						now,
					],
				);
			}
		}
		this.save();
	}

	// --- Wave 2: Dreaming ---

	async runDreaming(): Promise<void> {
		this.lastRefreshAt = Date.now();
		// Refresh temporal windows first so detect/extract operate on current 90-day data
		await this.refreshTemporalWindows();
		await this.detectQuestions();
		await this.extractSkills();
		await this.graduateSkillsToPrinciples();

		// Sync to Supabase mirror after dreaming completes (advisory — errors don't fail dreaming)
		if (this.syncAfterDreamingFn) {
			try {
				await this.syncAfterDreamingFn(this.db);
			} catch (err) {
				console.error("[CIPHER] Supabase sync failed:", (err as Error).message);
			}
		}
	}

	// --- Wave 2: Prediction-feedback ---

	async checkPredictionFeedback(
		executionId: string,
		predictedRoute: string,
		actualAction: string,
	): Promise<void> {
		const predicted =
			predictedRoute === "auto_approve" ? "approve" : "reject";
		if (predicted !== actualAction) {
			const now = sqlNow();
			this.db.run(
				`INSERT INTO cipher_questions (id, question_type, description, related_pattern_key, evidence, created_at)
         VALUES (?, 'drift_detected', ?, ?, ?, ?)`,
				[
					randomUUID(),
					`Prediction mismatch for execution ${executionId}: system predicted "${predictedRoute}" but CEO chose "${actualAction}".`,
					null,
					JSON.stringify({
						executionId,
						predicted: predictedRoute,
						actual: actualAction,
					}),
					now,
				],
			);
			this.save();
		}
	}

	// --- Wave 3: Principle graduation ---

	async graduateSkillsToPrinciples(): Promise<void> {
		const now = sqlNow();
		const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
			.toISOString()
			.replace("T", " ")
			.replace(/\.\d+Z$/, "");

		const skills = this.db.exec(
			`SELECT id, name, source_pattern_key, recommended_action, confidence, sample_count
       FROM cipher_skills
       WHERE status = 'active' AND confidence >= 0.90 AND sample_count >= 50`,
		);
		if (skills.length === 0 || skills[0]!.values.length === 0) return;

		for (const row of skills[0]!.values) {
			const [
				skillId,
				_name,
				patternKey,
				action,
				confidence,
				sampleCount,
			] = row as [string, string, string, string, number, number];

			// Check for existing principle
			const exists = this.db.exec(
				`SELECT 1 FROM cipher_principles WHERE skill_id = ? AND status IN ('proposed', 'active')`,
				[skillId],
			);
			if (exists.length > 0 && exists[0]!.values.length > 0) continue;

			// Check for contradictions in last 30 days
			if (patternKey) {
				const recent = this.db.exec(
					`SELECT approve_count, reject_count FROM (
             SELECT SUM(rpk.is_approve) as approve_count, COUNT(*) - SUM(rpk.is_approve) as reject_count
             FROM review_pattern_keys rpk
             WHERE rpk.pattern_key = ? AND rpk.created_at >= ?
           )`,
					[patternKey, thirtyDaysAgo],
				);
				if (recent.length > 0 && recent[0]!.values.length > 0) {
					const [recentApprove, recentReject] = recent[0]!
						.values[0]! as [number, number];
					const recentTotal =
						(recentApprove ?? 0) + (recentReject ?? 0);
					if (recentTotal > 0) {
						const recentRate =
							action === "likely_approve"
								? (recentApprove ?? 0) / recentTotal
								: (recentReject ?? 0) / recentTotal;
						if (recentRate < 0.8) continue; // Too many contradictions
					}
				}
			}

			const ruleType =
				action === "likely_reject" ? "block" : "escalate";
			// HardRule actions are "escalate" | "block" — no "auto_approve".
			// likely_approve → escalate (force review for known-good patterns until trust grows)
			// likely_reject → block (prevent known-bad patterns)
			const ruleDefinition =
				action === "likely_approve"
					? `Escalate for review (high approve-rate pattern): ${patternKey ?? "unknown"}`
					: `Block for review (high reject-rate pattern): ${patternKey ?? "unknown"}`;
			const sourcePattern = patternKey ?? "";

			const principleId = randomUUID();
			this.db.run(
				`INSERT INTO cipher_principles (id, skill_id, rule_type, rule_definition, confidence, sample_count, source_pattern, graduation_criteria, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
				[
					principleId,
					skillId,
					ruleType,
					ruleDefinition,
					confidence,
					sampleCount,
					sourcePattern,
					`confidence >= 0.90, samples >= 50, no 30-day contradictions`,
					now,
				],
			);

			// Notify about new proposal
			const principle: CipherPrinciple = {
				id: principleId,
				skill_id: skillId,
				rule_type: ruleType as "block" | "escalate",
				rule_definition: ruleDefinition,
				confidence,
				sample_count: sampleCount,
				source_pattern: sourcePattern,
				graduation_criteria: `confidence >= 0.90, samples >= 50, no 30-day contradictions`,
				status: "proposed",
				created_at: now,
			};
			await this.notifyProposal(principle);
		}
		this.save();
	}

	// --- Wave 3: Principle lifecycle ---

	getProposedPrinciples(): CipherPrinciple[] {
		const rows = this.db.exec(
			`SELECT id, skill_id, rule_type, rule_definition, confidence, sample_count, source_pattern, graduation_criteria, status, activated_at, retired_at, retired_reason, created_at
       FROM cipher_principles WHERE status = 'proposed'`,
		);
		if (rows.length === 0 || rows[0]!.values.length === 0) return [];
		return rows[0]!.values.map(
			(r) =>
				({
					id: r[0],
					skill_id: r[1],
					rule_type: r[2],
					rule_definition: r[3],
					confidence: r[4],
					sample_count: r[5],
					source_pattern: r[6],
					graduation_criteria: r[7],
					status: r[8],
					activated_at: r[9] ?? undefined,
					retired_at: r[10] ?? undefined,
					retired_reason: r[11] ?? undefined,
					created_at: r[12],
				}) as CipherPrinciple,
		);
	}

	async activatePrinciple(principleId: string): Promise<boolean> {
		const now = sqlNow();
		this.db.run(
			`UPDATE cipher_principles SET status = 'active', activated_at = ? WHERE id = ? AND status = 'proposed'`,
			[now, principleId],
		);
		const changes = this.db.getRowsModified();
		this.save();
		return changes > 0;
	}

	async retirePrinciple(
		principleId: string,
		reason: string,
	): Promise<boolean> {
		const now = sqlNow();
		this.db.run(
			`UPDATE cipher_principles SET status = 'retired', retired_at = ?, retired_reason = ? WHERE id = ? AND status IN ('proposed', 'active')`,
			[now, reason, principleId],
		);
		const changes = this.db.getRowsModified();
		this.save();
		return changes > 0;
	}

	private async notifyProposal(principle: CipherPrinciple): Promise<void> {
		if (!this.notifyFn) return;
		try {
			await this.notifyFn({
				event_type: "cipher_principle_proposed",
				cipher_principle_id: principle.id,
				cipher_skill_id: principle.skill_id,
				cipher_proposal_rule: principle.rule_definition,
				cipher_proposal_rule_type: principle.rule_type,
				cipher_proposal_confidence: principle.confidence,
				cipher_proposal_samples: principle.sample_count,
				cipher_source_pattern: principle.source_pattern,
			});
		} catch {
			console.error(
				`[CIPHER] Failed to notify proposal ${principle.id}`,
			);
		}
	}

	close(): void {
		this.db.close();
	}
}
