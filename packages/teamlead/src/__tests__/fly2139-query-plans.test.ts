import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GatePoller } from "../bridge/gate-poller.js";
import { LeadInboxRuntime } from "../bridge/lead-inbox-runtime.js";
import { createLeadPatrolTickPass } from "../bridge/patrol-tick.js";
import { RunnerMailboxLane } from "../bridge/runner-mailbox-lane.js";
import { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

type WindowName =
	| "gate-poller"
	| "lead-inbox-admit"
	| "runner-mailbox"
	| "patrol-tick"
	| "workflow-transition"
	| "outbox-dead-letter";

interface PlanRow {
	detail: string;
}

interface QueryCapture {
	window: WindowName;
	sql: string;
	params: readonly unknown[];
	plan: readonly string[];
}

interface PreparedStatement {
	all(...params: unknown[]): unknown;
	get(...params: unknown[]): unknown;
	iterate(...params: unknown[]): unknown;
	run(...params: unknown[]): unknown;
	[property: string]: unknown;
}

interface DatabasePrototype {
	prepare(this: Database.Database, sql: string): PreparedStatement;
}

const EXPECTED_FAMILY: Record<WindowName, RegExp> = {
	"gate-poller": /\b(?:sessions|founder_action_ledger)\b/i,
	"lead-inbox-admit": /(?:mailbox|dead_letter_alerts|lead_events)/i,
	"runner-mailbox": /mailbox/i,
	"patrol-tick": /\b(?:sessions|lead_events|workflow_run)\b/i,
	"workflow-transition":
		/\bworkflow_rework_(?:request|route_revision|delivery)\b/i,
	"outbox-dead-letter": /\b(?:workflow_alert_outbox|dead_letter_alerts)\b/i,
};

const LARGE_TABLES = [
	"sessions",
	"lead_events",
	"dead_letter_alerts",
	"workflow_alert_outbox",
	"workflow_run",
	"workflow_run_event",
	"workflow_run_node",
	"workflow_rework_request",
	"workflow_rework_route_revision",
	"workflow_rework_delivery",
	"mailbox",
	"mailbox_batch",
	"mailbox_identity",
	"mailbox_archive",
] as const;

const captures: QueryCapture[] = [];
let activeWindow: WindowName | undefined;
let originalPrepare: DatabasePrototype["prepare"];

function normalizeSql(sql: string): string {
	return sql.replace(/\s+/g, " ").trim();
}

function serializeParam(value: unknown): unknown {
	if (typeof value === "bigint") return `${value}n`;
	if (Buffer.isBuffer(value)) return `<buffer:${value.byteLength}>`;
	return value;
}

function installQueryPlanCapture(): void {
	const prototype = Database.prototype as unknown as DatabasePrototype;
	originalPrepare = prototype.prepare;
	prototype.prepare = function tracedPrepare(
		this: Database.Database,
		sql: string,
	): PreparedStatement {
		const statement = originalPrepare.call(this, sql);
		const db = this;
		return new Proxy(statement, {
			get(target, property, receiver) {
				const value = Reflect.get(target, property, target);
				if (typeof value !== "function") return value;
				return (...params: unknown[]) => {
					if (
						activeWindow &&
						(property === "all" ||
							property === "get" ||
							property === "iterate") &&
						/^\s*(?:SELECT|WITH)\b/i.test(sql)
					) {
						const plan = originalPrepare
							.call(db, `EXPLAIN QUERY PLAN ${sql}`)
							.all(...params) as PlanRow[];
						captures.push({
							window: activeWindow,
							sql: normalizeSql(sql),
							params: params.map(serializeParam),
							plan: plan.map(({ detail }) => detail),
						});
					}
					const result = value.apply(target, params) as unknown;
					return result === target ? receiver : result;
				};
			},
		}) as PreparedStatement;
	};
}

function restoreQueryPlanCapture(): void {
	(Database.prototype as unknown as DatabasePrototype).prepare =
		originalPrepare;
}

async function traceWindow(
	window: WindowName,
	operation: () => void | Promise<void>,
): Promise<void> {
	expect(activeWindow).toBeUndefined();
	activeWindow = window;
	try {
		await operation();
	} finally {
		activeWindow = undefined;
	}
}

function planFindings(rows: readonly QueryCapture[]): string[] {
	const findings: string[] = [];
	for (const row of rows) {
		const touchedLargeTables = LARGE_TABLES.filter((table) =>
			new RegExp(`\\b${table}\\b`, "i").test(row.sql),
		);
		if (touchedLargeTables.length === 0) continue;
		const hasIndexedAccess = row.plan.some((detail) =>
			/USING (?:(?:COVERING|AUTOMATIC PARTIAL COVERING) )?INDEX|USING INTEGER PRIMARY KEY/i.test(
				detail,
			),
		);
		if (!hasIndexedAccess) {
			findings.push(`${row.window}: no named index access; sql=${row.sql}`);
		}
		for (const detail of row.plan) {
			// SQLite must sometimes materialize a bounded aggregate/order result (for
			// example COUNT(DISTINCT) or ORDER BY MIN(seq)). That is safe only after
			// the same plan has selected the retained large-table rows via a named
			// index. A temp tree with no indexed access remains a hard finding.
			if (!hasIndexedAccess && /USE TEMP B-TREE/i.test(detail)) {
				findings.push(
					`${row.window}: temporary b-tree: ${detail}; sql=${row.sql}`,
				);
			}
			for (const table of touchedLargeTables) {
				if (new RegExp(`^SCAN (?:[\\w.]+\\.)?${table}$`, "i").test(detail)) {
					findings.push(
						`${row.window}: bare scan on ${table}: ${detail}; sql=${row.sql}`,
					);
				}
			}
		}
	}
	return findings;
}

function renderAuditEvidence(rows: readonly QueryCapture[]): string {
	const canonical = rows
		.map(({ window, sql, plan }) => ({ window, sql, plan: [...plan] }))
		.sort((left, right) =>
			`${left.window}\u0000${left.sql}\u0000${left.plan.join("\u0000")}`.localeCompare(
				`${right.window}\u0000${right.sql}\u0000${right.plan.join("\u0000")}`,
			),
		);
	const digest = createHash("sha256")
		.update(JSON.stringify(canonical))
		.digest("hex");
	const lines = [
		"<!-- FLY-2139 GENERATED QUERY-AUDIT EVIDENCE: BEGIN -->",
		"| tracing window | captures | unique SQL | named indexes | temp B-trees after indexed access |",
		"|---|---:|---:|---|---:|",
	];
	for (const window of Object.keys(EXPECTED_FAMILY) as WindowName[]) {
		const windowRows = rows.filter((row) => row.window === window);
		const uniqueSql = new Set(windowRows.map(({ sql }) => sql)).size;
		const indexes = new Set<string>();
		let tempTrees = 0;
		for (const row of windowRows) {
			for (const detail of row.plan) {
				if (/USE TEMP B-TREE/i.test(detail)) tempTrees += 1;
				const match = detail.match(
					/USING (?:(?:COVERING|AUTOMATIC PARTIAL COVERING) )?INDEX ([^ (]+)/i,
				);
				if (match?.[1]) indexes.add(match[1]);
			}
		}
		lines.push(
			`| ${window} | ${windowRows.length} | ${uniqueSql} | ${[...indexes].sort().join(", ") || "(integer primary key)"} | ${tempTrees} |`,
		);
	}
	lines.push(
		`capture-set-sha256: \`${digest}\``,
		"<!-- FLY-2139 GENERATED QUERY-AUDIT EVIDENCE: END -->",
	);
	return lines.join("\n");
}

async function withStore(
	operation: (store: StateStore) => void | Promise<void>,
): Promise<void> {
	const store = await StateStore.create(":memory:");
	try {
		await operation(store);
	} finally {
		store.close();
	}
}

const PROJECTS: ProjectEntry[] = [
	{
		projectName: "fly2139",
		projectRoot: "/tmp/fly2139",
		leads: [
			{
				agentId: "eng-lead",
				summaryRole: "producer",
				chatChannel: "eng",
				match: { labels: ["Engineering"] },
			},
		],
	},
];

describe("FLY-2139 Bridge hot-query audit", () => {
	const tempRoots: string[] = [];

	beforeAll(() => installQueryPlanCapture());
	afterAll(() => {
		restoreQueryPlanCapture();
		for (const root of tempRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("captures six production paths with exact bindings and bounded plans", async () => {
		await withStore(async (store) => {
			const poller = new GatePoller({
				pollIntervalMs: 60_000,
				projects: [],
				store,
				runtimeRegistry: new RuntimeRegistry(),
			});
			await traceWindow("gate-poller", () =>
				(poller as unknown as { poll(): Promise<void> }).poll(),
			);
		});

		await withStore(async (store) => {
			const root = mkdtempSync(join(tmpdir(), "fly2139-inbox-plan-"));
			tempRoots.push(root);
			const runtime = new LeadInboxRuntime({
				projects: PROJECTS,
				store,
				registry: new RuntimeRegistry(),
				commDbPathForProject: () => join(root, "comm.db"),
				ownerEpoch: "fly2139-owner",
				runLegacyCutover: () => {},
				adapterForLead: () => ({ deliverBatch: vi.fn() }),
				runnerAdapterForProject: () => ({
					deliver: vi.fn(),
					resolveQuestion: () => undefined,
					close: vi.fn(),
				}),
				leadLeaseReader: { getLease: () => undefined, close: vi.fn() },
				processLeadTupleState: () => "alive",
			});
			try {
				const loops = (
					runtime as unknown as {
						loops: Map<string, { tick(): Promise<unknown> }>;
					}
				).loops;
				const loop = loops.values().next().value;
				expect(loop).toBeDefined();
				await traceWindow("lead-inbox-admit", async () => {
					await loop?.tick();
				});
			} finally {
				runtime.close();
			}
		});

		{
			const root = mkdtempSync(join(tmpdir(), "fly2139-runner-plan-"));
			tempRoots.push(root);
			const queue = new MailboxQueue(join(root, "comm.db"));
			try {
				queue.enqueue({
					id: "fly2139-runner-message",
					fromAgent: "eng-lead",
					toAgent: "fly2139-execution",
					recipientKind: "runner",
					type: "instruction",
					content: "continue",
					createdAt: "2026-08-29T12:00:00.000Z",
					senderRef: encodeSenderRef(),
				});
				queue.acquireOrRenewOwner({
					ownerEpoch: "fly2139-runner-owner",
					now: "2026-08-29T12:00:00.000Z",
					leaseTtlMs: 60_000,
				});
				const lane = new RunnerMailboxLane({
					queue,
					ownerEpoch: "fly2139-runner-owner",
					deliver: vi.fn(async () => ({ status: "no_transport" as const })),
					now: () => new Date("2026-08-29T12:00:00.000Z"),
				});
				await traceWindow("runner-mailbox", async () => {
					await lane.tick();
				});
			} finally {
				queue.close();
			}
		}

		await withStore(async (store) => {
			store.upsertSession({
				execution_id: "fly2139-execution",
				issue_id: "issue-2139",
				issue_identifier: "FLY-2139",
				project_name: "fly2139",
				status: "running",
				session_role: "implement",
				issue_labels: '["Engineering"]',
			});
			const pass = createLeadPatrolTickPass({
				projects: PROJECTS,
				store,
				inspectDeliveryState: () => ({ kind: "absent_identity" }),
				enqueueLeadEvent: () => ({
					queued: true,
					deliveryId: "fly2139-delivery",
					seq: 1,
				}),
				getGlobalConfig: () => ({ interval_minutes: 60 }),
				getProjectConfig: () => ({ interval_minutes: 60 }),
				now: () => Date.parse("2026-08-29T12:00:00.000Z"),
			});
			await traceWindow("patrol-tick", pass);
		});

		await withStore(async (store) => {
			await traceWindow("workflow-transition", () => {
				store.transitionWorkflowReworkPause({
					requestId: "missing-request",
					generation: 0,
					state: "paused",
					alertIdentity: {
						leadId: "eng-lead",
						projectName: "fly2139",
						leadResolution: "resolved",
					},
					now: "2026-08-29T12:00:00.000Z",
				});
			});
		});

		await withStore(async (store) => {
			await traceWindow("outbox-dead-letter", () => {
				store.listDueDeadLetterAlerts("2026-08-29T12:00:00.000Z", 100);
				store.claimNextWorkflowAlert({
					ownerId: "fly2139-owner",
					now: "2026-08-29T12:00:00.000Z",
					leaseExpiresAt: "2026-08-29T12:05:00.000Z",
				});
			});
		});

		for (const [window, family] of Object.entries(EXPECTED_FAMILY) as [
			WindowName,
			RegExp,
		][]) {
			const rows = captures.filter((capture) => capture.window === window);
			expect(rows.length, `${window} must execute SELECTs`).toBeGreaterThan(0);
			expect(
				rows.some((capture) => family.test(capture.sql)),
				`${window} must execute ${family}; captured=${rows
					.map(({ sql }) => sql)
					.join(" || ")}`,
			).toBe(true);
			for (const capture of rows) {
				expect(capture.plan.length, capture.sql).toBeGreaterThan(0);
			}
		}
		expect(planFindings(captures)).toEqual([]);
		const evidence = renderAuditEvidence(captures);
		const auditDoc = readFileSync(
			join(
				process.cwd(),
				"../../engineering/doc/FLY-2139-periodic-cleanup-index-audit/index-audit.md",
			),
			"utf8",
		);
		if (!auditDoc.includes(evidence)) {
			throw new Error(`index-audit.md evidence is stale:\n${evidence}`);
		}
	});

	it("proves the checker catches a dropped hot-path index", () => {
		const db = new Database(":memory:");
		try {
			db.exec(`
				CREATE TABLE sessions (
					execution_id TEXT PRIMARY KEY,
					status TEXT NOT NULL,
					lifecycle_revision INTEGER NOT NULL
				);
				CREATE INDEX idx_sessions_status_revision
					ON sessions(status, lifecycle_revision);
			`);
			const sql =
				"SELECT execution_id FROM sessions WHERE status = ? ORDER BY lifecycle_revision";
			const capture = (): QueryCapture => ({
				window: "gate-poller",
				sql,
				params: ["running"],
				plan: (
					db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("running") as PlanRow[]
				).map(({ detail }) => detail),
			});
			expect(planFindings([capture()])).toEqual([]);
			db.exec("DROP INDEX idx_sessions_status_revision");
			expect(planFindings([capture()])).toEqual([
				`gate-poller: no named index access; sql=${sql}`,
				`gate-poller: bare scan on sessions: SCAN sessions; sql=${sql}`,
				`gate-poller: temporary b-tree: USE TEMP B-TREE FOR ORDER BY; sql=${sql}`,
			]);
		} finally {
			db.close();
		}
	});
});
