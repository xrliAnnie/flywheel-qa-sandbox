/**
 * FLY-245 F-a — gateway-main pure parts: config boundary validation, HTTP
 * dispatch-outcome classification, and §5.4 exactly-one target resolution from
 * a read-only StateStore snapshot. (The assembly glue — broker fetch, Discord
 * REST, MCP server — is validated by the Phase F real-machine threat-matrix.)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	mapHttpDispatchOutcome,
	parseGatewayConfig,
	resolveLifecycleTarget,
} from "../gateway-main.js";
import { AmbiguousTargetError } from "../resolve-target.js";

const FULL_ENV = {
	FLYWHEEL_LEAD_ID: "product-lead",
	FLYWHEEL_PROJECT_NAME: "geoforge3d",
	FLYWHEEL_FOUNDER_DISCORD_USER_ID: "annie-987",
	FLYWHEEL_GATEWAY_STATE_DIR: "/tmp/gw-state",
	FLYWHEEL_GATEWAY_BROKER_SOCKET: "/tmp/gw-state/broker.sock",
	FLYWHEEL_GATEWAY_CONFIRM_CHANNEL_ID: "chan-1",
	FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9876/",
	HOME: "/Users/x",
};

describe("parseGatewayConfig (F-a boundary)", () => {
	it("parses a full env; bridge url trailing slash trimmed; defaults applied", () => {
		const cfg = parseGatewayConfig(FULL_ENV);
		expect(cfg.bridgeUrl).toBe("http://127.0.0.1:9876");
		expect(cfg.commDbPath).toBe("/Users/x/.flywheel/comm/geoforge3d/comm.db");
		expect(cfg.stateDbPath).toBe("/Users/x/.flywheel/state/teamlead.db");
		expect(cfg.confirmTtlMs).toBe(30 * 60 * 1000);
		expect(cfg.pollIntervalMs).toBe(5000);
	});

	it("fail-loud: lists ALL missing required vars", () => {
		expect(() => parseGatewayConfig({})).toThrow(
			/FLYWHEEL_LEAD_ID.*FLYWHEEL_FOUNDER_DISCORD_USER_ID/s,
		);
	});

	it("FLY-676: roundtableAutoContinue only on for the runtime EFFECTIVE flag (not raw THREAD_AUTOCONTINUE)", () => {
		expect(parseGatewayConfig(FULL_ENV).roundtableAutoContinue).toBe(false);
		expect(
			parseGatewayConfig({
				...FULL_ENV,
				FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE: "1",
			}).roundtableAutoContinue,
		).toBe(false);
		expect(
			parseGatewayConfig({
				...FULL_ENV,
				FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE: "1",
			}).roundtableAutoContinue,
		).toBe(true);
	});

	it("rejects a path-traversal project name (boundary)", () => {
		expect(() =>
			parseGatewayConfig({
				...FULL_ENV,
				FLYWHEEL_PROJECT_NAME: "../geoforge3d",
			}),
		).toThrow(/invalid project/i);
	});

	// FLY-350 (Z) unit 3: discord_send channel coordinates. Optional (byte-compat
	// with the FLY-245 gateway that had no discord_send) — absent → empty, and the
	// alias resolver fails closed at call time. The SAME env var names as the
	// lead-actions MCP (one contract across both proactive-send paths).
	it("parses discord_send channel coordinates (chat + cross-dept + alias pins)", () => {
		const cfg = parseGatewayConfig({
			...FULL_ENV,
			FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "chat-123",
			FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: "rt-1, rt-2 ,",
			FLYWHEEL_LEAD_ACTIONS_CHANNEL_ALIASES: "roundtable:rt-2",
		});
		expect(cfg.chatChannelId).toBe("chat-123");
		expect(cfg.crossDeptChannelIds).toEqual(["rt-1", "rt-2"]);
		expect(cfg.explicitAliases).toEqual({ roundtable: "rt-2" });
	});

	it("channel coordinates default to empty when unset (byte-compat: no discord_send config)", () => {
		const cfg = parseGatewayConfig(FULL_ENV);
		expect(cfg.chatChannelId).toBe("");
		expect(cfg.crossDeptChannelIds).toEqual([]);
		expect(cfg.explicitAliases).toEqual({});
	});

	it("applies send-guard tuning defaults (loop-safety) and honors overrides", () => {
		expect(parseGatewayConfig(FULL_ENV).sendRateMaxPerWindow).toBe(5);
		const tuned = parseGatewayConfig({
			...FULL_ENV,
			FLYWHEEL_LEAD_ACTIONS_RATE_MAX: "2",
			FLYWHEEL_LEAD_ACTIONS_RATE_WINDOW_MS: "30000",
			FLYWHEEL_LEAD_ACTIONS_IDEMPOTENCY_TTL_MS: "45000",
		});
		expect(tuned.sendRateMaxPerWindow).toBe(2);
		expect(tuned.sendRateWindowMs).toBe(30000);
		expect(tuned.sendIdempotencyTtlMs).toBe(45000);
	});
});

describe("mapHttpDispatchOutcome (F-a)", () => {
	it("2xx + success → success", () => {
		expect(
			mapHttpDispatchOutcome({
				kind: "response",
				status: 200,
				successFlag: true,
			}),
		).toEqual({ kind: "success" });
	});

	it("2xx with success:false → not_dispatched (the Bridge refused)", () => {
		expect(
			mapHttpDispatchOutcome({
				kind: "response",
				status: 200,
				successFlag: false,
				body: "nope",
			}).kind,
		).toBe("not_dispatched");
	});

	// Codex code-review R1 MED-6: a 2xx WITHOUT an explicit success flag (non-JSON
	// / malformed body) must NOT be read as success — we can't confirm the Bridge
	// acted, so it's ambiguous.
	it("2xx with NO explicit success flag (malformed body) → unknown, not success", () => {
		expect(
			mapHttpDispatchOutcome({
				kind: "response",
				status: 200,
				body: "<html>not json</html>",
			}).kind,
		).toBe("unknown");
	});

	it("4xx → not_dispatched with detail (Bridge refused before acting)", () => {
		const out = mapHttpDispatchOutcome({
			kind: "response",
			status: 400,
			body: "bad",
		});
		expect(out).toEqual({ kind: "not_dispatched", detail: "http_400:bad" });
	});

	// MED-6: a 5xx may arrive AFTER the Bridge already started a Runner — it must
	// be ambiguous (postcondition reconciliation), never terminalized as
	// not_dispatched (which would let a non-idempotent retry start a second one).
	it("5xx → unknown (the Bridge may have already acted)", () => {
		const out = mapHttpDispatchOutcome({
			kind: "response",
			status: 502,
			body: "bad gateway",
		});
		expect(out.kind).toBe("unknown");
	});

	it("connection refused (no response) → not_dispatched", () => {
		expect(
			mapHttpDispatchOutcome({
				kind: "network_error",
				code: "ECONNREFUSED",
				message: "fetch failed",
			}).kind,
		).toBe("not_dispatched");
	});

	it("timeout / mid-flight reset → unknown (ambiguous, never retried blind)", () => {
		expect(
			mapHttpDispatchOutcome({
				kind: "network_error",
				message: "socket hang up",
			}).kind,
		).toBe("unknown");
	});
});

describe("resolveLifecycleTarget (§5.4 exactly-one)", () => {
	let dir: string;
	let dbPath: string;

	function seed(
		rows: Array<{
			exec: string;
			issue: string;
			status: string;
			role?: string;
			revision?: number;
			project?: string;
		}>,
	) {
		const db = new Database(dbPath);
		db.exec(`CREATE TABLE IF NOT EXISTS sessions (
			execution_id TEXT PRIMARY KEY, issue_id TEXT, issue_identifier TEXT,
			project_name TEXT, status TEXT, session_role TEXT,
			lifecycle_revision INTEGER DEFAULT 0, worktree_path TEXT,
			issue_labels TEXT)`);
		const ins = db.prepare(
			`INSERT INTO sessions (execution_id, issue_id, issue_identifier, project_name, status, session_role, lifecycle_revision)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const r of rows) {
			ins.run(
				r.exec,
				`uuid-${r.issue}`,
				r.issue,
				r.project ?? "geoforge3d",
				r.status,
				r.role ?? "main",
				r.revision ?? 0,
			);
		}
		db.close();
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly245-resolve-"));
		dbPath = join(dir, "teamlead.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("exactly one eligible candidate → resolved with revision snapshot", () => {
		seed([
			{ exec: "e1", issue: "FLY-9", status: "awaiting_review", revision: 5 },
			{ exec: "e2", issue: "FLY-9", status: "completed" }, // ineligible for reject
		]);
		const t = resolveLifecycleTarget({
			stateDbPath: dbPath,
			projectName: "geoforge3d",
			issue: "FLY-9",
			action: "reject",
		});
		expect(t.execId).toBe("e1");
		expect(t.revision).toBe(5);
		expect(t.status).toBe("awaiting_review");
	});

	it("zero eligible candidates → fail-closed throw", () => {
		seed([{ exec: "e1", issue: "FLY-9", status: "completed" }]);
		expect(() =>
			resolveLifecycleTarget({
				stateDbPath: dbPath,
				projectName: "geoforge3d",
				issue: "FLY-9",
				action: "reject",
			}),
		).toThrow(AmbiguousTargetError);
	});

	it("multiple eligible candidates → fail-closed with the candidate list (founder re-issues explicitly)", () => {
		seed([
			{ exec: "e1", issue: "FLY-9", status: "awaiting_review", role: "main" },
			{ exec: "e2", issue: "FLY-9", status: "awaiting_review", role: "qa" },
		]);
		try {
			resolveLifecycleTarget({
				stateDbPath: dbPath,
				projectName: "geoforge3d",
				issue: "FLY-9",
				action: "reject",
			});
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(AmbiguousTargetError);
			expect((e as AmbiguousTargetError).candidateDescriptions).toHaveLength(2);
		}
	});

	it("a different project's sessions are invisible (scope)", () => {
		seed([
			{
				exec: "e1",
				issue: "FLY-9",
				status: "awaiting_review",
				project: "other",
			},
		]);
		expect(() =>
			resolveLifecycleTarget({
				stateDbPath: dbPath,
				projectName: "geoforge3d",
				issue: "FLY-9",
				action: "reject",
			}),
		).toThrow(AmbiguousTargetError);
	});

	it("missing StateStore → fail-closed", () => {
		expect(() =>
			resolveLifecycleTarget({
				stateDbPath: join(dir, "nope.db"),
				projectName: "geoforge3d",
				issue: "FLY-9",
				action: "reject",
			}),
		).toThrow(/not found/i);
	});

	it("non-lifecycle action → refused", () => {
		seed([{ exec: "e1", issue: "FLY-9", status: "awaiting_review" }]);
		expect(() =>
			resolveLifecycleTarget({
				stateDbPath: dbPath,
				projectName: "geoforge3d",
				issue: "FLY-9",
				action: "approve",
			}),
		).toThrow(/not a lifecycle action/i);
	});

	// Codex code-review R1 MED-7: scope to THIS Lead BEFORE exactly-one selection.
	it("leadScope picks THIS Lead's runner when two Leads share the issue (no cross-Lead credential)", () => {
		seed([
			{ exec: "mine", issue: "FLY-9", status: "awaiting_review", revision: 3 },
			{ exec: "theirs", issue: "FLY-9", status: "awaiting_review" },
		]);
		const t = resolveLifecycleTarget({
			stateDbPath: dbPath,
			projectName: "geoforge3d",
			issue: "FLY-9",
			action: "reject",
			leadScope: {
				leadId: "product-lead",
				inScope: (s) => s.execution_id === "mine",
			},
		});
		expect(t.execId).toBe("mine");
		expect(t.revision).toBe(3);
	});

	it("leadScope fail-closed when the ONLY eligible candidate is another Lead's runner", () => {
		seed([{ exec: "theirs", issue: "FLY-9", status: "awaiting_review" }]);
		expect(() =>
			resolveLifecycleTarget({
				stateDbPath: dbPath,
				projectName: "geoforge3d",
				issue: "FLY-9",
				action: "reject",
				leadScope: {
					leadId: "product-lead",
					inScope: (s) => s.execution_id === "mine",
				},
			}),
		).toThrow(AmbiguousTargetError);
	});

	it("a throwing scope predicate (unresolvable routing) excludes the candidate (fail-closed)", () => {
		seed([{ exec: "e1", issue: "FLY-9", status: "awaiting_review" }]);
		expect(() =>
			resolveLifecycleTarget({
				stateDbPath: dbPath,
				projectName: "geoforge3d",
				issue: "FLY-9",
				action: "reject",
				leadScope: {
					leadId: "product-lead",
					inScope: () => {
						throw new Error("unknown project");
					},
				},
			}),
		).toThrow(AmbiguousTargetError);
	});
});
