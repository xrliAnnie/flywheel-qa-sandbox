import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { parseFly2006Args } from "../../../../scripts/fly-1998-database-retention-sweep.mjs";
import { buildIsolatedRehearsalAudit } from "../../../../scripts/fly-2006-retention-rehearsal.mjs";
import {
	assertFrozenCohort,
	buildActiveSnapshot,
	freezeCohort,
	jsonContainsExactScalar,
	partitionRows,
} from "../../../../scripts/lib/fly-2006-retention-cohort.mjs";
import {
	buildApplyBatches,
	executeFly2006Apply,
	executeFly2006Inventory,
	executeFly2006Vacuum,
	FLY2006_LIVE_SESSION_STATUSES,
	RETENTION_TARGET_POLICIES,
} from "../../../../scripts/lib/fly-2006-retention-engine.mjs";
import {
	createSqliteSnapshot,
	createSqliteSnapshotFromQuery,
	LEGACY_V1_SCRIPT_SHA256,
	readLegacyClosedEvidence,
	verifySqliteSnapshot,
	writeSealedJson,
} from "../../../../scripts/lib/fly-2006-retention-evidence.mjs";
import {
	assertClassifiedSchema,
	assertNoUnclassifiedSchema,
	COMM_TABLE_CLASSIFICATION,
	classifyMailboxRow,
	classifyRetentionTime,
	RETENTION_MS,
	TEAMLEAD_TABLE_CLASSIFICATION,
} from "../../../../scripts/lib/fly-2006-retention-registry.mjs";
import { MailboxQueue } from "../../../flywheel-comm/src/mailbox-queue.js";
import { MAILBOX_SCHEMA } from "../../../flywheel-comm/src/mailbox-schema.js";
import { encodeSenderRef } from "../../../flywheel-comm/src/sender-ref.js";
import { CMUX_LIVE_SESSION_STATUSES } from "../operational-terminal-status.js";
import { StateStore } from "../StateStore.js";

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const FOUNDER_DISCORD_AUDIT = {
	source: "discord-message",
	channelId: "10000000000000001",
	messageId: "10000000000000002",
	authorId: "10000000000000003",
	respondedAt: "2026-08-23T00:00:00.000Z",
	responseDigest: "a".repeat(64),
} as const;

const TEAMLEAD_PRODUCTION_TABLES = JSON.parse(
	readFileSync(
		new URL(
			"../../../../scripts/__tests__/fixtures/fly-2006-teamlead-production-tables.json",
			import.meta.url,
		),
		"utf8",
	),
) as string[];

describe("FLY-2006 retention registry", () => {
	it("classifies the current production schemas created for both live database families", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2006-live-schema-"));
		const teamleadPath = join(root, "teamlead.db");
		const commPath = join(root, "comm.db");
		try {
			const store = await StateStore.create(teamleadPath);
			store.close();
			const queue = new MailboxQueue(commPath);
			queue.close();

			for (const [database, path] of [
				["teamlead", teamleadPath],
				["comm", commPath],
			] as const) {
				const sqlite = new Database(path, { readonly: true });
				try {
					const tables = sqlite
						.prepare(
							"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
						)
						.all()
						.map((row) => String((row as { name: string }).name));
					expect(() =>
						assertNoUnclassifiedSchema(database, tables),
					).not.toThrow();
				} finally {
					sqlite.close();
				}
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("labels copy-only rehearsal authority without impersonating a Discord message", () => {
		expect(buildIsolatedRehearsalAudit()).toEqual({
			source: "isolated-rehearsal",
			purposeDigest: createHash("sha256")
				.update("FLY-2006 isolated rehearsal; not production authority")
				.digest("hex"),
		});
		return expect(
			executeFly2006Apply({
				manifestPath: "/fixture/missing-manifest.json",
				founderGateAudit: buildIsolatedRehearsalAudit(),
			}),
		).rejects.toThrow("founder_gate_audit_required");
	});

	it("parses only the bounded v2 inventory/apply/policy/vacuum operator contracts", () => {
		expect(
			parseFly2006Args([
				"policy-apply",
				"--manifest",
				"/evidence/manifest.json",
				"--activation-receipt",
				"/authority/activation.json",
			]),
		).toEqual({
			command: "policy-apply",
			"--manifest": "/evidence/manifest.json",
			"--activation-receipt": "/authority/activation.json",
		});
		expect(() =>
			parseFly2006Args([
				"policy-apply",
				"--manifest",
				"/evidence/manifest.json",
			]),
		).toThrow("missing_argument:--activation-receipt");
		expect(
			parseFly2006Args([
				"apply",
				"--manifest",
				"/evidence/manifest.json",
				"--founder-source",
				"discord-message",
				"--founder-channel-id",
				FOUNDER_DISCORD_AUDIT.channelId,
				"--founder-message-id",
				FOUNDER_DISCORD_AUDIT.messageId,
				"--founder-author-id",
				FOUNDER_DISCORD_AUDIT.authorId,
				"--founder-responded-at",
				FOUNDER_DISCORD_AUDIT.respondedAt,
				"--founder-response-digest",
				FOUNDER_DISCORD_AUDIT.responseDigest,
			]),
		).toMatchObject({
			command: "apply",
			"--founder-source": "discord-message",
			"--founder-message-id": FOUNDER_DISCORD_AUDIT.messageId,
		});
		expect(
			parseFly2006Args([
				"maintenance-vacuum",
				"--database",
				"teamlead",
				"--database-path",
				"/db/teamlead.db",
				"--evidence-dir",
				"/evidence/run",
				"--max-duration-ms",
				"30000",
			]),
		).toEqual({
			command: "maintenance-vacuum",
			"--database": "teamlead",
			"--database-path": "/db/teamlead.db",
			"--evidence-dir": "/evidence/run",
			"--max-duration-ms": "30000",
		});
		expect(
			parseFly2006Args([
				"vacuum",
				"--manifest",
				"/evidence/manifest.json",
				"--database",
				"teamlead",
				"--quiescence-ack",
				"/evidence/ack.json",
				"--rehearsal-summary",
				"/evidence/rehearsal.json",
				"--max-duration-ms",
				"30000",
			]),
		).toMatchObject({
			command: "vacuum",
			"--database": "teamlead",
			"--max-duration-ms": "30000",
		});
		expect(() =>
			parseFly2006Args(["apply", "--manifest", "/evidence/manifest.json"]),
		).toThrow("missing_argument:--founder-source");
		expect(() =>
			parseFly2006Args([
				"inventory",
				"--teamlead-db",
				"/db/teamlead.db",
				"--comm-db",
				"/db/comm.db",
				"--evidence-dir",
				"/evidence/run",
			]),
		).toThrow("missing_argument:--health-url");
		expect(() =>
			parseFly2006Args([
				"inventory",
				"--teamlead-db",
				"/db/teamlead.db",
				"--comm-db",
				"/db/comm.db",
				"--evidence-dir",
				"/evidence/run",
				"--health-url",
				"http://127.0.0.1:18789/health",
				"--now",
				"2030-01-01T00:00:00.000Z",
			]),
		).toThrow("invalid_argument:--now");
		expect(
			parseFly2006Args([
				"rotate-log",
				"--manifest",
				"/evidence/manifest.json",
				"--bridge-log",
				"/private/tmp/flywheel-bridge.log",
			]),
		).toMatchObject({
			command: "rotate-log",
			"--bridge-log": "/private/tmp/flywheel-bridge.log",
		});
	});

	it("classifies the production schema and its optional-retired subset", () => {
		const retiredNames = [
			"founder_page_ledger",
			"runbook_issues",
			"ticket_escalations",
		];

		expect(TEAMLEAD_TABLE_CLASSIFICATION.deleteTarget).toHaveLength(16);
		expect(TEAMLEAD_TABLE_CLASSIFICATION.protectedAuthority).toHaveLength(36);
		expect(
			TEAMLEAD_TABLE_CLASSIFICATION.protectedCurrentOrReference,
		).toHaveLength(110);
		expect(TEAMLEAD_TABLE_CLASSIFICATION.protectedCurrentOrReference).toContain(
			"flag_scan_scope_state",
		);
		expect(TEAMLEAD_TABLE_CLASSIFICATION.protectedCurrentOrReference).toContain(
			"node_dwell_review",
		);
		expect(TEAMLEAD_TABLE_CLASSIFICATION.protectedCurrentOrReference).toContain(
			"recovery_claim",
		);
		expect(
			(TEAMLEAD_TABLE_CLASSIFICATION as Record<string, readonly string[]>)
				.retiredOptional,
		).toEqual(retiredNames);
		expect(COMM_TABLE_CLASSIFICATION.deleteTarget).toHaveLength(7);
		expect(COMM_TABLE_CLASSIFICATION.protectedCurrentOrAuthority).toHaveLength(
			20,
		);
		expect(COMM_TABLE_CLASSIFICATION.protectedCurrentOrAuthority).toEqual(
			expect.arrayContaining(["mailbox_archive", "runner_stop_declarations"]),
		);

		const teamleadNames = Object.values(TEAMLEAD_TABLE_CLASSIFICATION).flat();
		const commNames = Object.values(COMM_TABLE_CLASSIFICATION).flat();
		expect(new Set(teamleadNames).size).toBe(165);
		expect(TEAMLEAD_PRODUCTION_TABLES).toEqual([...teamleadNames].sort());
		expect(new Set(commNames).size).toBe(27);
		expect(
			assertClassifiedSchema("teamlead", TEAMLEAD_PRODUCTION_TABLES),
		).toMatchObject({
			total: 165,
		});
		expect(
			assertClassifiedSchema(
				"teamlead",
				TEAMLEAD_PRODUCTION_TABLES.filter(
					(name) => !retiredNames.includes(name),
				),
			),
		).toMatchObject({ total: 162 });
		expect(assertClassifiedSchema("comm", commNames)).toMatchObject({
			total: 27,
		});
		expect(() =>
			assertClassifiedSchema("teamlead", [...teamleadNames, "future_table"]),
		).toThrow("schema_unclassified:teamlead:future_table");
		expect(() =>
			assertClassifiedSchema(
				"comm",
				commNames.filter((name) => name !== "mailbox_identity"),
			),
		).toThrow("schema_missing:comm:mailbox_identity");
	});

	it("uses a strict 14-day boundary for text and epoch timestamps", () => {
		expect(RETENTION_MS).toBe(14 * 24 * 60 * 60 * 1_000);
		expect(new Set(FLY2006_LIVE_SESSION_STATUSES)).toEqual(
			CMUX_LIVE_SESSION_STATUSES,
		);
		const cutoff = "2026-08-09T13:40:20.000Z";
		expect(classifyRetentionTime("2026-08-09T13:40:19.999Z", cutoff)).toBe(
			"old",
		);
		expect(classifyRetentionTime(cutoff, cutoff)).toBe("recent");
		expect(classifyRetentionTime("2026-08-09 13:40:20", cutoff)).toBe("recent");
		expect(classifyRetentionTime(Date.parse(cutoff) - 1, cutoff)).toBe("old");
		expect(
			classifyRetentionTime(Math.floor(Date.parse(cutoff) / 1_000), cutoff),
		).toBe("recent");
		expect(classifyRetentionTime(null, cutoff)).toBe("invalidTime");
		expect(classifyRetentionTime("not-a-time", cutoff)).toBe("invalidTime");
	});

	it("admits only the exact Lead-directed mailbox exception regardless of age", () => {
		const cutoff14 = "2026-08-09T13:40:20.000Z";
		const base = {
			from_agent: "voice-honeylemon-fly1911",
			relay_state: "terminal_disposed",
			type: "question",
			kind: "report",
			checkpoint: null,
			state: "ACKED",
			acked_at: "2026-08-23T07:03:57.749Z",
			dead_at: null,
		};
		expect(classifyMailboxRow(base, cutoff14)).toBe(
			"leadExactExceptionCandidate",
		);
		expect(classifyMailboxRow({ ...base, relay_state: "open" }, cutoff14)).toBe(
			"recent",
		);
		expect(classifyMailboxRow({ ...base, from_agent: "other" }, cutoff14)).toBe(
			"recent",
		);
		expect(
			classifyMailboxRow(
				{ ...base, from_agent: "voice-honeylemon-fly1911-copy" },
				cutoff14,
			),
		).toBe("recent");
	});

	it("protects authority and unknown mailbox values outside the exception", () => {
		const cutoff14 = "2026-08-09T13:40:20.000Z";
		const old = {
			from_agent: "runner",
			relay_state: "terminal_disposed",
			type: "question",
			kind: null,
			checkpoint: null,
			state: "ACKED",
			acked_at: "2026-07-01T00:00:00.000Z",
			dead_at: null,
		};
		expect(classifyMailboxRow(old, cutoff14)).toBe("oldProtectedAuthority");
		expect(
			classifyMailboxRow(
				{ ...old, type: "future_unknown", kind: null },
				cutoff14,
			),
		).toBe("oldProtectedUnknown");
		expect(
			classifyMailboxRow(
				{ ...old, type: "patrol_tick", checkpoint: "review_code" },
				cutoff14,
			),
		).toBe("oldProtectedAuthority");
	});
});

describe("FLY-2006 bounded active-aware cohorts", () => {
	it("includes every execution of active/held runs plus live cross-DB sessions", () => {
		const snapshot = buildActiveSnapshot({
			liveSessions: [{ executionId: "live-direct", issueId: "FLY-1" }],
			runs: [
				{ runId: "active-run", status: "active", issueId: "FLY-2" },
				{ runId: "held-run", status: "held", issueId: "FLY-3" },
				{ runId: "done-run", status: "completed", issueId: "FLY-4" },
			],
			nodes: [
				{ runId: "active-run", executionId: "done-node" },
				{ runId: "held-run", executionId: "held-node" },
				{ runId: "done-run", executionId: "old-node" },
			],
			commSessions: [
				{ executionId: "comm-running", status: "running", issueId: "FLY-5" },
				{ executionId: "comm-done", status: "completed", issueId: "FLY-6" },
			],
		});
		expect(snapshot.runIds).toEqual(["active-run", "held-run"]);
		expect(snapshot.executionIds).toEqual([
			"comm-running",
			"done-node",
			"held-node",
			"live-direct",
		]);
		expect(snapshot.issueIds).toEqual(["FLY-1", "FLY-2", "FLY-3", "FLY-5"]);
		expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("matches JSON lineage only by exact scalar value", () => {
		expect(
			jsonContainsExactScalar(
				JSON.stringify({ nested: ["exec-1", { issue: "FLY-2" }] }),
				new Set(["exec-1"]),
			),
		).toBe(true);
		expect(
			jsonContainsExactScalar(
				JSON.stringify({ execution: "prefix-exec-1-suffix" }),
				new Set(["exec-1"]),
			),
		).toBe(false);
		expect(jsonContainsExactScalar("not-json", new Set(["exec-1"]))).toBe(
			false,
		);
	});

	it("uses exact keys through 20k and bounded digest shards above it", () => {
		const textExact = freezeCohort(
			[
				{ id: "a", value: 1 },
				{ id: "b", value: 2 },
			],
			{ primaryKey: "id", casFields: ["id", "value"] },
		);
		expect(textExact).toMatchObject({
			mode: "exact-keys",
			primaryKeys: ["a", "b"],
		});
		const exactRows = Array.from({ length: 20_000 }, (_, index) => ({
			id: index + 1,
			value: `v-${index + 1}`,
		}));
		const exact = freezeCohort(exactRows, {
			primaryKey: "id",
			casFields: ["id", "value"],
		});
		expect(exact.mode).toBe("exact-keys");
		expect(exact.primaryKeys).toHaveLength(20_000);

		const largeRows = Array.from({ length: 50_005 }, (_, index) => ({
			id: index + 1,
			value: `v-${index + 1}`,
		}));
		const ranged = freezeCohort(largeRows, {
			primaryKey: "id",
			casFields: ["id", "value"],
		});
		expect(ranged.mode).toBe("range-digest");
		expect(ranged).not.toHaveProperty("primaryKeys");
		expect(ranged.shards).toHaveLength(2);
		expect(ranged.shards.every((shard) => shard.rowCount <= 50_000)).toBe(true);
		expect(ranged.shards.reduce((sum, shard) => sum + shard.rowCount, 0)).toBe(
			50_005,
		);
		expect(() =>
			assertFrozenCohort(
				largeRows.map((row) =>
					row.id === 50_001 ? { ...row, value: "drift" } : row,
				),
				ranged,
				{ primaryKey: "id", casFields: ["id", "value"] },
			),
		).toThrow("cohort_cas_digest_mismatch");
	});

	it("forces range-digest mailbox cohorts into receipt-per-row batches", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2006-mailbox-batches-"));
		const snapshotPath = join(root, "mailbox.sqlite");
		try {
			const snapshot = new Database(snapshotPath);
			snapshot.exec(
				"CREATE TABLE mailbox(seq INTEGER PRIMARY KEY,id TEXT NOT NULL); INSERT INTO mailbox VALUES(1,'a'),(2,'b')",
			);
			snapshot.close();
			expect(
				buildApplyBatches("mailbox", {
					candidateCount: 2,
					table: "mailbox",
					primaryKey: "seq",
					snapshotPath,
					frozen: {
						mode: "range-digest",
						shards: [
							{
								minPrimaryKey: 1,
								maxPrimaryKey: 2,
								rowCount: 2,
								digest: "fixture",
							},
						],
					},
				}),
			).toEqual([
				{ kind: "exact", index: 0, primaryKeys: [1] },
				{ kind: "exact", index: 1, primaryKeys: [2] },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("emits a five-way partition whose counts exactly cover the universe", () => {
		const rows = [
			"candidate",
			"recent",
			"invalidTime",
			"activeProtected",
			"oldProtected",
		].flatMap((classification, index) =>
			Array.from({ length: index + 1 }, (_, child) => ({
				id: `${classification}-${child}`,
				classification,
			})),
		);
		const result = partitionRows(rows, (row) => row.classification);
		expect(result.counts).toEqual({
			candidate: 1,
			recent: 2,
			invalidTime: 3,
			activeProtected: 4,
			oldProtected: 5,
		});
		expect(
			Object.values(result.counts).reduce((sum, count) => sum + count, 0),
		).toBe(rows.length);
	});
});

describe("FLY-2006 SQLite evidence and legacy reader", () => {
	it("creates a 0600 SQLite snapshot and backup-restores exact candidate rows", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2006-snapshot-"));
		const sourcePath = join(root, "source.db");
		const snapshotPath = join(root, "snapshot.db");
		const source = new Database(sourcePath);
		try {
			source.exec(
				"CREATE TABLE events(id INTEGER PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL)",
			);
			const insert = source.prepare("INSERT INTO events VALUES(?,?,?)");
			insert.run(1, "one", "2026-07-01T00:00:00.000Z");
			insert.run(2, "protected", "2026-08-22T00:00:00.000Z");
			insert.run(3, "three", "2026-07-02T00:00:00.000Z");
			const frozen = freezeCohort(
				[
					{ id: 1, value: "one", at: "2026-07-01T00:00:00.000Z" },
					{ id: 3, value: "three", at: "2026-07-02T00:00:00.000Z" },
				],
				{ primaryKey: "id", casFields: ["id", "value", "at"] },
			);
			const snapshot = await createSqliteSnapshot({
				sourceDb: source,
				table: "events",
				primaryKey: "id",
				primaryKeys: [1, 3],
				casFields: ["id", "value", "at"],
				frozen,
				snapshotPath,
			});
			expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);
			expect(readFileSync(snapshotPath).subarray(0, 16).toString("utf8")).toBe(
				"SQLite format 3\0",
			);
			expect(readFileSync(snapshotPath, "utf8")).not.toContain("INSERT INTO");
			expect(snapshot.restoreVerified).toBe(true);
			await expect(
				verifySqliteSnapshot({
					snapshotPath,
					expectedSha256: snapshot.snapshotSha256,
					table: "events",
					primaryKey: "id",
					casFields: ["id", "value", "at"],
					frozen,
					tableSqlSha256: snapshot.tableSqlSha256,
				}),
			).resolves.toMatchObject({ rowCount: 2, restoreVerified: true });
		} finally {
			source.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("snapshots a child cohort without copying its protected FK parent", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2006-fk-snapshot-"));
		const sourcePath = join(root, "source.db");
		const snapshotPath = join(root, "snapshot.db");
		const source = new Database(sourcePath);
		try {
			source.exec(`
				CREATE TABLE protected_parent(id INTEGER PRIMARY KEY);
				CREATE TABLE history_child(
					id INTEGER PRIMARY KEY,
					parent_id INTEGER NOT NULL REFERENCES protected_parent(id)
				);
				INSERT INTO protected_parent VALUES(1);
				INSERT INTO history_child VALUES(10,1);
			`);
			const snapshot = await createSqliteSnapshotFromQuery({
				sourceDb: source,
				table: "history_child",
				primaryKey: "id",
				casFields: ["id", "parent_id"],
				query: "SELECT * FROM history_child ORDER BY id",
				params: [],
				snapshotPath,
			});
			expect(snapshot).toMatchObject({ rowCount: 1, restoreVerified: true });
		} finally {
			source.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a symlinked snapshot", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2006-snapshot-link-"));
		try {
			const target = join(root, "target.db");
			const db = new Database(target);
			db.exec("CREATE TABLE events(id INTEGER PRIMARY KEY)");
			db.close();
			const link = join(root, "link.db");
			symlinkSync(target, link);
			await expect(
				verifySqliteSnapshot({
					snapshotPath: link,
					expectedSha256: sha256File(target),
					table: "events",
					primaryKey: "id",
					casFields: ["id"],
					frozen: freezeCohort([], {
						primaryKey: "id",
						casFields: ["id"],
					}),
					tableSqlSha256: "unused",
				}),
			).rejects.toThrow("snapshot_not_regular_file");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("streams a high-cardinality query into range-digest SQLite evidence", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2006-stream-snapshot-"));
		const source = new Database(join(root, "source.db"));
		try {
			source.exec(
				"CREATE TABLE events(id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
			);
			const insert = source.prepare("INSERT INTO events VALUES(?,?)");
			const fill = source.transaction(() => {
				for (let id = 1; id <= 20_005; id += 1) insert.run(id, `v-${id}`);
			});
			fill();
			const result = await createSqliteSnapshotFromQuery({
				sourceDb: source,
				table: "events",
				primaryKey: "id",
				casFields: ["id", "value"],
				query: "SELECT * FROM events ORDER BY id",
				params: [],
				snapshotPath: join(root, "stream.db"),
			});
			expect(result.frozen.mode).toBe("range-digest");
			expect(result.frozen).not.toHaveProperty("primaryKeys");
			expect(result.frozen.shards).toHaveLength(1);
			expect(result.frozen.shards[0].rowCount).toBe(20_005);
			expect(result.rowCount).toBe(20_005);
			expect(result.restoreVerified).toBe(true);
		} finally {
			source.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads closed v1 evidence without rechecking its released live baseline", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2006-v1-evidence-"));
		try {
			const manifestPath = join(root, "manifest.json");
			const applyReceiptPath = join(root, "apply-receipt.json");
			writeSealedJson(manifestPath, {
				issue: "FLY-1998",
				schemaVersion: 1,
				scriptSha256: LEGACY_V1_SCRIPT_SHA256,
				exclusions: {
					fly1995: { mailbox: { baselineIds: ["released-1"] } },
				},
			});
			writeSealedJson(applyReceiptPath, {
				issue: "FLY-1998",
				status: "complete",
				manifestSha256: sha256File(manifestPath),
			});
			expect(
				readLegacyClosedEvidence({ manifestPath, applyReceiptPath }),
			).toMatchObject({
				issue: "FLY-1998",
				status: "complete",
				legacyBaselineRechecked: false,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("FLY-2006 multi-target inventory", () => {
	it("has one explicit policy for every delete-target table", () => {
		for (const [database, expected] of [
			["teamlead", TEAMLEAD_TABLE_CLASSIFICATION.deleteTarget],
			["comm", COMM_TABLE_CLASSIFICATION.deleteTarget],
		] as const) {
			expect(
				RETENTION_TARGET_POLICIES.filter(
					(policy) => policy.database === database,
				)
					.map((policy) => policy.table)
					.sort(),
			).toEqual([...expected].sort());
		}
	});

	it("retains canonical Discord thread anchors until Discord confirms them missing", () => {
		const db = new Database(":memory:");
		try {
			for (const table of [
				"chat_threads",
				"phase_chat_threads",
				"roundtable_topic_threads",
			]) {
				db.exec(`CREATE TABLE ${table}(
					thread_id TEXT PRIMARY KEY,
					archived_at TEXT,
					discord_missing_at TEXT
				)`);
				const insert = db.prepare(
					`INSERT INTO ${table}(thread_id,archived_at,discord_missing_at)
					 VALUES(?,?,?)`,
				);
				insert.run("canonical", "2000-01-01T00:00:00.000Z", null);
				insert.run(
					"confirmed-missing",
					"2000-01-01T00:00:00.000Z",
					"2000-01-02T00:00:00.000Z",
				);
			}
			for (const key of [
				"chatThreads",
				"phaseChatThreads",
				"roundtableTopicThreads",
			]) {
				const policy = RETENTION_TARGET_POLICIES.find(
					(candidate) => candidate.key === key,
				);
				const candidate = policy?.candidate({
					cutoff14: "2026-08-01T00:00:00.000Z",
				});
				expect(
					db
						.prepare(
							`SELECT t.thread_id FROM ${policy?.table} t WHERE ${candidate?.sql}
							 ORDER BY t.thread_id`,
						)
						.all(...(candidate?.params ?? [])),
				).toEqual([{ thread_id: "confirmed-missing" }]);
			}
		} finally {
			db.close();
		}
	});

	it("inventories resolved alert threads with NULL repair status", () => {
		const db = new Database(":memory:");
		try {
			db.exec(`CREATE TABLE alert_threads(
				correlation_key TEXT PRIMARY KEY,
				resolved_at TEXT,
				repair_status TEXT
			)`);
			const insert = db.prepare(
				"INSERT INTO alert_threads VALUES (?, '2000-01-01T00:00:00.000Z', ?)",
			);
			insert.run("null-status", null);
			insert.run("attempted", "attempted");
			insert.run("pending", "pending");
			const policy = RETENTION_TARGET_POLICIES.find(
				(candidate) => candidate.key === "alertThreads",
			);
			const candidate = policy?.candidate({
				cutoff14: "2026-08-01T00:00:00.000Z",
			});

			expect(
				db
					.prepare(
						`SELECT t.correlation_key FROM alert_threads t WHERE ${candidate?.sql}
						 ORDER BY t.correlation_key`,
					)
					.all(...(candidate?.params ?? [])),
			).toEqual([
				{ correlation_key: "attempted" },
				{ correlation_key: "null-status" },
			]);
		} finally {
			db.close();
		}
	});

	it("never inventories a lead event while any foreign-key child survives", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2006-lead-event-fk-"));
		const teamleadPath = join(root, "teamlead.db");
		const commPath = join(root, "comm.db");
		const evidenceDir = join(root, "evidence");
		try {
			const teamlead = new Database(teamleadPath);
			teamlead.exec(`
				PRAGMA foreign_keys=ON;
				CREATE TABLE lead_events(
					seq INTEGER PRIMARY KEY,
					created_at TEXT NOT NULL,
					event_type TEXT NOT NULL,
					delivered_at TEXT,
					ack_required INTEGER NOT NULL,
					acked_at TEXT,
					ack_retired_at TEXT,
					dead_lettered_at TEXT,
					ingress_disposed_at TEXT
				);
				CREATE TABLE lead_event_delivery_attempts(
					attempt_id TEXT PRIMARY KEY,
					event_seq INTEGER NOT NULL REFERENCES lead_events(seq),
					outcome TEXT,
					retired_at TEXT,
					finalized_at TEXT
				);
				CREATE TABLE legacy_cutover_quarantine(
					seq INTEGER PRIMARY KEY REFERENCES lead_events(seq),
					state TEXT NOT NULL,
					created_at TEXT NOT NULL,
					accepted_at TEXT,
					replayed_at TEXT
				);
				CREATE TABLE legacy_render_fallback(
					seq INTEGER PRIMARY KEY REFERENCES lead_events(seq),
					fell_back_at TEXT NOT NULL
				);
				CREATE TABLE legacy_stock_suppressed(
					seq INTEGER PRIMARY KEY REFERENCES lead_events(seq),
					suppressed_at TEXT NOT NULL
				);
				WITH RECURSIVE counter(seq) AS (
					SELECT 1 UNION ALL SELECT seq+1 FROM counter WHERE seq<20003
				)
				INSERT INTO lead_events
				SELECT seq,'2000-01-01T00:00:00.000Z','session_completed',
					'2000-01-01T00:01:00.000Z',0,NULL,NULL,NULL,NULL
				FROM counter;
				INSERT INTO lead_event_delivery_attempts VALUES(
					'old-attempt',10000,'pushed',NULL,'2000-01-01T00:02:00.000Z'
				);
				INSERT INTO legacy_render_fallback VALUES(
					1,'2000-01-01T00:02:00.000Z'
				);
			`);
			teamlead.close();
			new Database(commPath).close();

			const inventory = await executeFly2006Inventory({
				teamleadDbPath: teamleadPath,
				commDbPath: commPath,
				evidenceDir,
				now: new Date().toISOString(),
				allowFixturePaths: true,
				allowFixtureSchema: true,
			});
			expect(inventory.manifest.targets.leadEvents.candidateCount).toBe(20001);
			expect(inventory.manifest.targets.leadEvents.frozen.mode).toBe(
				"range-digest",
			);
			expect(
				inventory.manifest.targets.leadEventDeliveryAttempts.candidateCount,
			).toBe(1);
			expect(
				inventory.manifest.targets.legacyRenderFallback.candidateCount,
			).toBe(1);

			const originalManifest = inventory.manifest;
			unlinkSync(inventory.manifestPath);
			unlinkSync(`${inventory.manifestPath}.sha256`);
			writeSealedJson(inventory.manifestPath, {
				...originalManifest,
				startedAt: "2100-01-15T00:00:00.000Z",
				cutoff14: "2100-01-01T00:00:00.000Z",
			});
			await expect(
				executeFly2006Apply({
					manifestPath: inventory.manifestPath,
					allowFixturePaths: true,
					founderGateAudit: FOUNDER_DISCORD_AUDIT,
				}),
			).rejects.toThrow("manifest_retention_window_invalid");
			unlinkSync(inventory.manifestPath);
			unlinkSync(`${inventory.manifestPath}.sha256`);
			writeSealedJson(inventory.manifestPath, originalManifest);

			const applied = await executeFly2006Apply({
				manifestPath: inventory.manifestPath,
				allowFixturePaths: true,
				founderGateAudit: FOUNDER_DISCORD_AUDIT,
			});
			expect(applied.founderGateAudit).toEqual(FOUNDER_DISCORD_AUDIT);
			expect(applied.deleted.leadEvents).toBe(20001);
			expect(applied.deleted.leadEventDeliveryAttempts).toBe(1);
			expect(applied.deleted.legacyRenderFallback).toBe(1);
			const verified = new Database(teamleadPath, { readonly: true });
			expect(
				verified.prepare("SELECT seq FROM lead_events ORDER BY seq").all(),
			).toEqual([{ seq: 1 }, { seq: 10000 }]);
			expect(
				verified.prepare("SELECT seq FROM legacy_render_fallback").all(),
			).toEqual([]);
			verified.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("freezes active-aware session history and the exact recent HL orphan", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2006-inventory-"));
		const teamleadPath = join(root, "teamlead.db");
		const commPath = join(root, "comm.db");
		const evidenceDir = join(root, "evidence");
		const teamlead = new Database(teamleadPath);
		const comm = new Database(commPath);
		try {
			teamlead.pragma("foreign_keys=OFF");
			teamlead.exec(`
				CREATE TABLE sessions(
					execution_id TEXT PRIMARY KEY, issue_id TEXT, status TEXT NOT NULL
				);
				CREATE TABLE workflow_run(
					run_id TEXT PRIMARY KEY, issue_id TEXT, status TEXT NOT NULL
				);
				CREATE TABLE workflow_run_node(
					run_id TEXT, node_id TEXT, attempt INTEGER, execution_id TEXT,
					PRIMARY KEY(run_id,node_id,attempt)
				);
				CREATE TABLE session_events(
					id INTEGER PRIMARY KEY, event_id TEXT, ts TEXT, execution_id TEXT,
					issue_id TEXT, project_name TEXT, event_type TEXT, severity TEXT,
					payload JSON, source TEXT
				);
				CREATE TABLE fk_parent(id INTEGER PRIMARY KEY);
				CREATE TABLE fk_child(
					id INTEGER PRIMARY KEY,
					parent_id INTEGER REFERENCES fk_parent(id)
				);
				INSERT INTO fk_child VALUES(1,999);
				CREATE TABLE vacuum_bloat(payload BLOB);
				WITH RECURSIVE counter(value) AS (
					SELECT 1 UNION ALL SELECT value+1 FROM counter WHERE value<1024
				)
				INSERT INTO vacuum_bloat SELECT randomblob(4096) FROM counter;
				DELETE FROM vacuum_bloat;
			`);
			teamlead.pragma("foreign_keys=ON");
			teamlead
				.prepare(
					"INSERT INTO sessions VALUES('live-exec','FLY-LIVE','running')",
				)
				.run();
			teamlead
				.prepare(
					"INSERT INTO workflow_run VALUES('active-run','FLY-RUN','active')",
				)
				.run();
			teamlead
				.prepare(
					"INSERT INTO workflow_run_node VALUES('active-run','implement',1,'done-node')",
				)
				.run();
			const insertEvent = teamlead.prepare(
				"INSERT INTO session_events VALUES(?,?,?,?,?,?,?,?,?,?)",
			);
			insertEvent.run(
				1,
				"candidate",
				"2026-08-02T00:00:00.000Z",
				null,
				null,
				"flywheel",
				"issue_thread_infra_notify_skipped",
				"info",
				"{}",
				"bridge.founder-thread-notifier",
			);
			insertEvent.run(
				2,
				"authority",
				"2026-07-01T00:00:00.000Z",
				null,
				null,
				"flywheel",
				"founder_thread_notified",
				"info",
				"{}",
				"bridge.founder-thread-notifier",
			);
			insertEvent.run(
				3,
				"active",
				"2026-08-02T00:00:00.000Z",
				"done-node",
				"FLY-RUN",
				"flywheel",
				"issue_thread_infra_notify_skipped",
				"info",
				"{}",
				"bridge.founder-thread-notifier",
			);
			insertEvent.run(
				4,
				"recent",
				"2026-08-22T00:00:00.000Z",
				null,
				null,
				"flywheel",
				"issue_thread_infra_notify_skipped",
				"info",
				"{}",
				"bridge.founder-thread-notifier",
			);

			comm.exec(MAILBOX_SCHEMA);
			comm.exec(`CREATE TABLE IF NOT EXISTS sessions(
				execution_id TEXT PRIMARY KEY, issue_id TEXT, status TEXT NOT NULL
			)`);
			const queue = new MailboxQueue(comm);
			for (const [id, fromAgent] of [
				["hl-exact", "voice-honeylemon-fly1911"],
				["near-miss", "another-agent"],
			] as const) {
				queue.enqueue({
					id,
					fromAgent,
					toAgent: "flywheel-product-lead",
					recipientKind: "lead",
					type: "question",
					kind: "report",
					content: id,
					createdAt: "2026-08-22T00:00:00.000Z",
					relayState: "terminal_disposed",
					senderRef: encodeSenderRef(),
				});
				queue.ack(id, "2026-08-23T07:03:57.749Z");
			}
			comm
				.prepare(
					`INSERT INTO content_ref_gc_outbox
				 (intent_id,message_id,path,content_hash,state,created_at,finished_at)
				 VALUES(?,?,?,?,?,?,?)`,
				)
				.run(
					"gc:finished",
					"already-archived",
					"/private/tmp/finished-ref.txt",
					"a".repeat(64),
					"done",
					"2026-07-01T00:00:00.000Z",
					"2026-07-02T00:00:00.000Z",
				);
			const result = await executeFly2006Inventory({
				teamleadDbPath: teamleadPath,
				commDbPath: commPath,
				evidenceDir,
				now: "2026-08-23T14:40:00.000Z",
				allowFixturePaths: true,
				allowFixtureSchema: true,
			});
			expect(result.manifest.issue).toBe("FLY-2006");
			expect(result.manifest.schemaVersion).toBe(2);
			expect(result.manifest.targets.sessionEvents.candidateCount).toBe(1);
			expect(result.manifest.targets.mailbox.candidateCount).toBe(1);
			expect(result.manifest.targets.mailbox.exceptionCount).toBe(1);
			expect(result.manifest.targets.contentRefGcOutbox.candidateCount).toBe(1);
			expect(result.manifest.databases.teamlead.foreignKeyViolations).toBe(1);
			expect(result.manifest.activeSnapshot.executionIds).toContain(
				"done-node",
			);
			expect(
				existsSync(result.manifest.targets.sessionEvents.snapshotPath),
			).toBe(true);
			expect(existsSync(result.manifest.targets.mailbox.snapshotPath)).toBe(
				true,
			);
			expect(readFileSync(result.manifestPath, "utf8")).not.toContain(
				"issue_thread_infra_notify_skipped",
			);
			await expect(
				executeFly2006Vacuum({
					manifestPath: result.manifestPath,
					database: "teamlead",
					quiescenceAckPath: join(evidenceDir, "missing-ack.json"),
					rehearsalSummaryPath: join(evidenceDir, "missing-summary.json"),
					maxDurationMs: 1,
					allowFixturePaths: true,
				}),
			).rejects.toThrow("complete_apply_receipt_required");
			await expect(
				executeFly2006Apply({
					manifestPath: result.manifestPath,
					allowFixturePaths: true,
					founderGateAudit: {
						questionId: "fixture-founder-gate",
						responseDigest: "a".repeat(64),
					},
				}),
			).rejects.toThrow("founder_gate_audit_required");
			await expect(
				executeFly2006Apply({
					manifestPath: result.manifestPath,
					allowFixturePaths: true,
					founderGateAudit: {
						...FOUNDER_DISCORD_AUDIT,
						responseDigest: "not-a-digest",
					},
				}),
			).rejects.toThrow("founder_gate_audit_required");
			teamlead.exec(
				"CREATE TABLE post_inventory_drift(id INTEGER PRIMARY KEY)",
			);
			await expect(
				executeFly2006Apply({
					manifestPath: result.manifestPath,
					allowFixturePaths: true,
					founderGateAudit: FOUNDER_DISCORD_AUDIT,
				}),
			).rejects.toThrow("database_state_drift:teamlead");
			teamlead.exec("DROP TABLE post_inventory_drift");
			teamlead
				.prepare("UPDATE session_events SET severity='warning' WHERE id=1")
				.run();
			await expect(
				executeFly2006Apply({
					manifestPath: result.manifestPath,
					allowFixturePaths: true,
					founderGateAudit: FOUNDER_DISCORD_AUDIT,
				}),
			).rejects.toThrow("candidate_cas_mismatch:session_events");
			teamlead
				.prepare("UPDATE session_events SET severity='info' WHERE id=1")
				.run();

			await expect(
				executeFly2006Apply({
					manifestPath: result.manifestPath,
					allowFixturePaths: true,
					founderGateAudit: FOUNDER_DISCORD_AUDIT,
					testHooks: {
						afterTarget: (key) => {
							if (key === "sessionEvents")
								throw new Error("injected_comm_failure");
						},
					},
				}),
			).rejects.toThrow("injected_comm_failure");
			expect(
				teamlead.prepare("SELECT id FROM session_events ORDER BY id").all(),
			).toEqual([{ id: 2 }, { id: 3 }, { id: 4 }]);
			expect(comm.prepare("SELECT id FROM mailbox ORDER BY id").all()).toEqual([
				{ id: "hl-exact" },
				{ id: "near-miss" },
			]);
			insertEvent.run(
				1,
				"candidate",
				"2026-08-02T00:00:00.000Z",
				null,
				null,
				"flywheel",
				"issue_thread_infra_notify_skipped",
				"info",
				"{}",
				"bridge.founder-thread-notifier",
			);
			await expect(
				executeFly2006Apply({
					manifestPath: result.manifestPath,
					allowFixturePaths: true,
					founderGateAudit: FOUNDER_DISCORD_AUDIT,
				}),
			).rejects.toThrow("batch_receipt_row_still_present");
			teamlead.prepare("DELETE FROM session_events WHERE id=1").run();
			comm
				.prepare("UPDATE mailbox SET content='drifted' WHERE id='hl-exact'")
				.run();
			await expect(
				executeFly2006Apply({
					manifestPath: result.manifestPath,
					allowFixturePaths: true,
					founderGateAudit: FOUNDER_DISCORD_AUDIT,
				}),
			).rejects.toThrow("candidate_cas_mismatch:mailbox");
			comm
				.prepare("UPDATE mailbox SET content='hl-exact' WHERE id='hl-exact'")
				.run();

			let injectedArchiveCrash = false;
			await expect(
				executeFly2006Apply({
					manifestPath: result.manifestPath,
					allowFixturePaths: true,
					founderGateAudit: FOUNDER_DISCORD_AUDIT,
					testHooks: {
						afterMailboxArchive: () => {
							if (!injectedArchiveCrash) {
								injectedArchiveCrash = true;
								throw new Error("injected_after_mailbox_archive");
							}
						},
					},
				}),
			).rejects.toThrow("injected_after_mailbox_archive");
			expect(
				comm.prepare("SELECT id FROM mailbox WHERE id='hl-exact'").get(),
			).toBeUndefined();

			const applied = await executeFly2006Apply({
				manifestPath: result.manifestPath,
				allowFixturePaths: true,
				founderGateAudit: FOUNDER_DISCORD_AUDIT,
			});
			expect(applied.status).toBe("complete");
			expect(applied.durationMs).toBeGreaterThan(0);
			expect(applied.deleted.sessionEvents).toBe(1);
			expect(applied.deleted.mailbox).toBe(1);
			expect(applied.deleted.contentRefGcOutbox).toBe(1);
			expect(applied.founderGateAudit).toEqual(FOUNDER_DISCORD_AUDIT);
			expect(applied.integrity.teamlead.foreignKeySha256).toBe(
				result.manifest.databases.teamlead.foreignKeySha256,
			);
			expect(comm.prepare("SELECT id FROM mailbox ORDER BY id").all()).toEqual([
				{ id: "near-miss" },
			]);
			expect(
				comm.prepare("SELECT intent_id FROM content_ref_gc_outbox").all(),
			).toEqual([]);
			expect(
				comm
					.prepare(
						"SELECT archived_at FROM mailbox_identity WHERE id='hl-exact'",
					)
					.get(),
			).toEqual({ archived_at: expect.any(String) });
			expect(
				comm
					.prepare(
						"SELECT event_id,subject_id FROM mailbox_log WHERE message_id='hl-exact'",
					)
					.get(),
			).toEqual({
				event_id: "archived:hl-exact",
				subject_id: "hl-exact",
			});
			await expect(
				executeFly2006Apply({
					manifestPath: result.manifestPath,
					allowFixturePaths: true,
					founderGateAudit: {
						...FOUNDER_DISCORD_AUDIT,
						authorId: "1138241636057481307",
					},
				}),
			).rejects.toThrow("apply_receipt_identity_mismatch");
			expect(
				await executeFly2006Apply({
					manifestPath: result.manifestPath,
					allowFixturePaths: true,
					founderGateAudit: FOUNDER_DISCORD_AUDIT,
				}),
			).toMatchObject({ status: "complete", deleted: applied.deleted });

			const rehearsalSummaryPath = join(evidenceDir, "rehearsal-summary.json");
			writeSealedJson(rehearsalSummaryPath, {
				issue: "FLY-2006",
				status: "complete",
				vacuumDurationsMs: { teamlead: 1, comm: 1 },
			});
			const quiescenceAckPath = join(evidenceDir, "teamlead-quiescence.json");
			writeSealedJson(quiescenceAckPath, {
				issue: "FLY-2006",
				database: "teamlead",
				manifestSha256: sha256File(result.manifestPath),
				rehearsalSummarySha256: sha256File(rehearsalSummaryPath),
				maxDurationMs: 30_000,
				token: "fixture-quiescence-token",
				acknowledgedAt: "2026-08-23T15:00:00.000Z",
			});
			const emptyAckPath = join(evidenceDir, "empty-quiescence.json");
			writeSealedJson(emptyAckPath, {
				issue: "FLY-2006",
				database: "teamlead",
				manifestSha256: sha256File(result.manifestPath),
				rehearsalSummarySha256: sha256File(rehearsalSummaryPath),
				maxDurationMs: 30_000,
				token: "",
				acknowledgedAt: "2026-08-23T15:00:00.000Z",
			});
			await expect(
				executeFly2006Vacuum({
					manifestPath: result.manifestPath,
					database: "teamlead",
					quiescenceAckPath: emptyAckPath,
					rehearsalSummaryPath,
					maxDurationMs: 30_000,
					allowFixturePaths: true,
				}),
			).rejects.toThrow("quiescence_ack_binding_invalid");
			const slowSummaryPath = join(evidenceDir, "slow-rehearsal-summary.json");
			writeSealedJson(slowSummaryPath, {
				issue: "FLY-2006",
				status: "complete",
				vacuumDurationsMs: { teamlead: 10, comm: 1 },
			});
			const shortAckPath = join(evidenceDir, "short-quiescence.json");
			writeSealedJson(shortAckPath, {
				issue: "FLY-2006",
				database: "teamlead",
				manifestSha256: sha256File(result.manifestPath),
				rehearsalSummarySha256: sha256File(slowSummaryPath),
				maxDurationMs: 5,
				token: "fixture-short-budget-token",
				acknowledgedAt: "2026-08-23T15:00:00.000Z",
			});
			await expect(
				executeFly2006Vacuum({
					manifestPath: result.manifestPath,
					database: "teamlead",
					quiescenceAckPath: shortAckPath,
					rehearsalSummaryPath: slowSummaryPath,
					maxDurationMs: 5,
					allowFixturePaths: true,
				}),
			).rejects.toThrow("vacuum_max_duration_below_rehearsal");
			writeSealedJson(join(evidenceDir, "vacuum-comm-started.json"), {
				issue: "FLY-2006",
				status: "started",
			});
			const commAckPath = join(evidenceDir, "comm-quiescence.json");
			writeSealedJson(commAckPath, {
				issue: "FLY-2006",
				database: "comm",
				manifestSha256: sha256File(result.manifestPath),
				rehearsalSummarySha256: sha256File(rehearsalSummaryPath),
				maxDurationMs: 30_000,
				token: "fixture-comm-quiescence-token",
				acknowledgedAt: "2026-08-23T15:00:00.000Z",
			});
			await expect(
				executeFly2006Vacuum({
					manifestPath: result.manifestPath,
					database: "comm",
					quiescenceAckPath: commAckPath,
					rehearsalSummaryPath,
					maxDurationMs: 30_000,
					allowFixturePaths: true,
				}),
			).rejects.toThrow("vacuum_started_identity_mismatch");
			await expect(
				executeFly2006Vacuum({
					manifestPath: result.manifestPath,
					database: "teamlead",
					quiescenceAckPath,
					rehearsalSummaryPath,
					maxDurationMs: 30_000,
					allowFixturePaths: true,
					testHooks: { availableBytes: 0 },
				}),
			).rejects.toThrow("vacuum_disk_space_insufficient");
			teamlead.exec("CREATE TABLE pre_vacuum_drift(id INTEGER PRIMARY KEY)");
			await expect(
				executeFly2006Vacuum({
					manifestPath: result.manifestPath,
					database: "teamlead",
					quiescenceAckPath,
					rehearsalSummaryPath,
					maxDurationMs: 30_000,
					allowFixturePaths: true,
				}),
			).rejects.toThrow("database_state_drift:teamlead");
			teamlead.exec("DROP TABLE pre_vacuum_drift");
			const competingWriter = new Database(teamleadPath);
			try {
				competingWriter.exec("BEGIN IMMEDIATE");
				await expect(
					executeFly2006Vacuum({
						manifestPath: result.manifestPath,
						database: "teamlead",
						quiescenceAckPath,
						rehearsalSummaryPath,
						maxDurationMs: 30_000,
						allowFixturePaths: true,
					}),
				).rejects.toThrow("vacuum_writer_busy");
			} finally {
				competingWriter.exec("ROLLBACK");
				competingWriter.close();
			}
			const beforeVacuumBytes = statSync(teamleadPath).size;
			let injectedAfterStarted = false;
			await expect(
				executeFly2006Vacuum({
					manifestPath: result.manifestPath,
					database: "teamlead",
					quiescenceAckPath,
					rehearsalSummaryPath,
					maxDurationMs: 30_000,
					allowFixturePaths: true,
					testHooks: {
						afterStarted: () => {
							injectedAfterStarted = true;
							throw new Error("injected_after_vacuum_started");
						},
					},
				}),
			).rejects.toThrow("injected_after_vacuum_started");
			expect(injectedAfterStarted).toBe(true);
			const vacuumed = await executeFly2006Vacuum({
				manifestPath: result.manifestPath,
				database: "teamlead",
				quiescenceAckPath,
				rehearsalSummaryPath,
				maxDurationMs: 30_000,
				allowFixturePaths: true,
			});
			expect(vacuumed.status).toBe("complete");
			expect(vacuumed.recoveredFromStartedMarker).toBe(true);
			expect(vacuumed.before.mainBytes).toBe(beforeVacuumBytes);
			expect(vacuumed.after.mainBytes).toBeLessThan(beforeVacuumBytes);
			expect(vacuumed.integrity).toMatchObject({
				quickCheck: "ok",
				integrityCheck: "ok",
				foreignKeySha256: result.manifest.databases.teamlead.foreignKeySha256,
			});
			expect(vacuumed).not.toHaveProperty("quiescenceToken");
			await expect(
				executeFly2006Vacuum({
					manifestPath: result.manifestPath,
					database: "teamlead",
					quiescenceAckPath,
					rehearsalSummaryPath,
					maxDurationMs: 30_000,
					allowFixturePaths: true,
				}),
			).rejects.toThrow("quiescence_ack_already_used");
		} finally {
			teamlead.close();
			comm.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
