/**
 * FLY-191 Phase 2 — `respond` emergency-bypass wake.
 *
 * When the (loud, audited) FLYWHEEL_COMM_BYPASS_BRIDGE=1 path writes an
 * approve_to_ship response directly, the runner may be idle (gate --no-block)
 * — the CLI must ALSO send a best-effort mailbox wake, mirroring the Bridge
 * write-sites. The wake text explicitly says it is NOT authorization.
 *
 * Harness mirrors send-mailbox.test.ts: isolated CLAUDE_CONFIG_DIR sandbox.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ClaudeCodeAdapter,
	deriveRunnerMailboxIdentity,
} from "flywheel-agent-team-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATED_CHECKPOINTS, respond } from "../commands/respond.js";
import { CommDB } from "../db.js";

const EXEC = "exec-fly191-bypass";
const LEAD = "product-lead";

describe("respond bypass wake (FLY-191 Phase 2)", () => {
	let tmpDir: string;
	let dbPath: string;
	let cfgDir: string;
	let auditPath: string;

	const origCfg = process.env.CLAUDE_CONFIG_DIR;
	const origBackend = process.env.FLYWHEEL_COMM_BACKEND;
	const origAgent = process.env.FLYWHEEL_AGENT_BACKEND;

	const inboxPath = () => {
		const { agentName, teamName } = deriveRunnerMailboxIdentity(EXEC, LEAD);
		return new ClaudeCodeAdapter().getInboxPath(teamName, agentName);
	};

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly191-respond-wake-"));
		dbPath = join(tmpDir, "comm.db");
		cfgDir = join(tmpDir, "claude-config");
		auditPath = join(tmpDir, "audit.db");
		process.env.CLAUDE_CONFIG_DIR = cfgDir;
		delete process.env.FLYWHEEL_COMM_BACKEND;
		delete process.env.FLYWHEEL_AGENT_BACKEND;
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		if (origCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = origCfg;
		if (origBackend === undefined) delete process.env.FLYWHEEL_COMM_BACKEND;
		else process.env.FLYWHEEL_COMM_BACKEND = origBackend;
		if (origAgent === undefined) delete process.env.FLYWHEEL_AGENT_BACKEND;
		else process.env.FLYWHEEL_AGENT_BACKEND = origAgent;
		vi.restoreAllMocks();
	});

	function setupGateQuestion(): string {
		const db = new CommDB(dbPath);
		try {
			db.registerSession(EXEC, "sess:win", "proj", "FLY-191", LEAD);
			return db.insertQuestion(EXEC, LEAD, "PR ready for review", {
				checkpoint: "approve_to_ship",
			});
		} finally {
			db.close();
		}
	}

	it("approve_to_ship is in GATED_CHECKPOINTS (contract anchor)", () => {
		expect(GATED_CHECKPOINTS.has("approve_to_ship")).toBe(true);
	});

	it("rejects Lead approval before the emergency bypass can write", async () => {
		const qid = setupGateQuestion();

		await expect(
			respond({
				questionId: qid,
				fromAgent: LEAD,
				answer: JSON.stringify({ approved: true }),
				dbPath,
				env: {
					FLYWHEEL_COMM_BYPASS_BRIDGE: "1",
					FLYWHEEL_FOUNDER_CONSENT_AUDIT_DB_PATH: auditPath,
				} as NodeJS.ProcessEnv,
			}),
		).rejects.toThrow("lead_ack_rejected");
		const db = new CommDB(dbPath);
		expect(db.getResponse(qid)).toBeUndefined();
		db.close();
		expect(existsSync(inboxPath())).toBe(false);
	});

	it("non-gated checkpoint respond does NOT send a wake (blocking gates poll for their answer)", async () => {
		const db = new CommDB(dbPath);
		db.registerSession(EXEC, "sess:win", "proj", "FLY-191", LEAD);
		const qid = db.insertQuestion(EXEC, LEAD, "what about X?", {
			checkpoint: "brainstorm",
		});
		db.close();

		await respond({
			questionId: qid,
			fromAgent: LEAD,
			answer: "looks right, proceed",
			dbPath,
			env: {} as NodeJS.ProcessEnv,
		});

		expect(existsSync(inboxPath())).toBe(false);
	});

	it("rejection happens before a sabotaged wake path is reached", async () => {
		const qid = setupGateQuestion();
		// Sabotage the mailbox dir: make the inbox path's parent a FILE so the
		// transport write fails.
		process.env.CLAUDE_CONFIG_DIR = join(tmpDir, "not-a-dir-parent");
		// (transport will fail to create dirs under a path it can't manage —
		// simulate by pointing config dir at a file)
		rmSync(join(tmpDir, "not-a-dir-parent"), { force: true });
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(tmpDir, "not-a-dir-parent"), "block");

		await expect(
			respond({
				questionId: qid,
				fromAgent: LEAD,
				answer: JSON.stringify({ approved: true }),
				dbPath,
				env: {
					FLYWHEEL_COMM_BYPASS_BRIDGE: "1",
					FLYWHEEL_FOUNDER_CONSENT_AUDIT_DB_PATH: auditPath,
				} as NodeJS.ProcessEnv,
			}),
		).rejects.toThrow("lead_ack_rejected");
		const db = new CommDB(dbPath);
		expect(db.getResponse(qid)).toBeUndefined();
		db.close();
	});
});
