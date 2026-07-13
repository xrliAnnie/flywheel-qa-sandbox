/**
 * FLY-1188 (scope 2, L2 "send 修箱") — `flywheel-comm send` must route the
 * mailbox wake by the TARGET runner's registered transport vendor, not the
 * process-wide env default. Before this fix, a Lead's `send` to a codex-tmux
 * runner always landed in the claude-code mailbox (CLAUDE_CONFIG_DIR teams
 * subtree) while the runner's CodexMailboxWatcher reads
 * ~/.flywheel/codex-teams — the instruction was never seen (the /eleven
 * incident: "Lead 经 flywheel-comm send 的指令没能唤它跑 turn-1").
 *
 * The vendor comes from the CommDB session row (written at adapter spawn):
 *  - "codex"        → codex mailbox (FLYWHEEL_CODEX_TEAMS_DIR subtree)
 *  - "claude-code"  → claude mailbox (unchanged)
 *  - NULL (legacy)  → process-wide env transport (byte-compat fallback)
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ClaudeCodeAdapter,
	CodexAdapter,
	deriveRunnerMailboxIdentity,
} from "flywheel-agent-team-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { send } from "../commands/send.js";
import { CommDB } from "../db.js";

const EXEC = "9f1920df-fcad-4ebc-9677-40ac675cf229";
const LEAD = "flywheel-eng-lead";

describe("send backend routing by session vendor (FLY-1188)", () => {
	let tmpDir: string;
	let dbPath: string;
	let claudeCfgDir: string;
	let codexTeamsDir: string;

	const origCfg = process.env.CLAUDE_CONFIG_DIR;
	const origCodexTeams = process.env.FLYWHEEL_CODEX_TEAMS_DIR;
	const origBackend = process.env.FLYWHEEL_COMM_BACKEND;
	const origAgent = process.env.FLYWHEEL_AGENT_BACKEND;

	const claudeInboxPath = () => {
		const { agentName, teamName } = deriveRunnerMailboxIdentity(EXEC, LEAD);
		return new ClaudeCodeAdapter().getInboxPath(teamName, agentName);
	};
	const codexInboxPath = () => {
		const { agentName, teamName } = deriveRunnerMailboxIdentity(EXEC, LEAD);
		return new CodexAdapter().getInboxPath(teamName, agentName);
	};

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly1188-send-routing-"));
		dbPath = join(tmpDir, "comm.db");
		claudeCfgDir = join(tmpDir, "claude-config");
		codexTeamsDir = join(tmpDir, "codex-teams");
		process.env.CLAUDE_CONFIG_DIR = claudeCfgDir;
		process.env.FLYWHEEL_CODEX_TEAMS_DIR = codexTeamsDir;
		delete process.env.FLYWHEEL_COMM_BACKEND; // default = mailbox
		delete process.env.FLYWHEEL_AGENT_BACKEND; // default (env) = claude-code
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		if (origCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = origCfg;
		if (origCodexTeams === undefined)
			delete process.env.FLYWHEEL_CODEX_TEAMS_DIR;
		else process.env.FLYWHEEL_CODEX_TEAMS_DIR = origCodexTeams;
		if (origBackend === undefined) delete process.env.FLYWHEEL_COMM_BACKEND;
		else process.env.FLYWHEEL_COMM_BACKEND = origBackend;
		if (origAgent === undefined) delete process.env.FLYWHEEL_AGENT_BACKEND;
		else process.env.FLYWHEEL_AGENT_BACKEND = origAgent;
		vi.restoreAllMocks();
	});

	const registerSession = (vendor?: string) => {
		const db = new CommDB(dbPath);
		db.registerSession(EXEC, "sess:win", "proj", "FLY-1188", LEAD, vendor);
		db.close();
	};

	it("sessions.vendor column: persists on register, NULL when omitted, migration idempotent", () => {
		// Two sequential openers both run applyMigrations on the same file —
		// the ADD COLUMN must be idempotent (race-tolerant pattern).
		registerSession("codex");
		const db = new CommDB(dbPath);
		expect(db.getSession(EXEC)?.vendor).toBe("codex");
		db.registerSession("other-exec", "sess:w2", "proj", "FLY-1", LEAD);
		expect(db.getSession("other-exec")?.vendor).toBeNull();
		db.close();
	});

	it('vendor="codex" → wake lands in the CODEX mailbox, not the claude one', async () => {
		registerSession("codex");
		const id = await send({
			fromAgent: LEAD,
			toAgent: EXEC,
			content: "continue with turn-1",
			dbPath,
		});

		expect(existsSync(codexInboxPath())).toBe(true);
		expect(existsSync(claudeInboxPath())).toBe(false);
		// Codex inbox schema: { messages: [{ content, ... }] } (CodexAdapter)
		const inbox = JSON.parse(readFileSync(codexInboxPath(), "utf-8")) as {
			messages: Array<{ content: string; read: boolean }>;
		};
		expect(inbox.messages).toHaveLength(1);
		expect(inbox.messages[0]?.content).toBe(
			`[lead-instruction ${id}]\ncontinue with turn-1`,
		);
		expect(inbox.messages[0]?.read).toBe(false);

		// delivered_at recorded — codex-routed sends get the same audit closure
		const db = new CommDB(dbPath);
		expect(db.getUnreadInstructions(EXEC)[0]?.delivered_at).not.toBeNull();
		db.close();
	});

	it('vendor="claude-code" → claude mailbox (explicit, same as legacy)', async () => {
		registerSession("claude-code");
		await send({
			fromAgent: LEAD,
			toAgent: EXEC,
			content: "hello claude runner",
			dbPath,
		});
		expect(existsSync(claudeInboxPath())).toBe(true);
		expect(existsSync(codexInboxPath())).toBe(false);
	});

	it("vendor NULL (legacy row) → env-default transport (claude mailbox, byte-compat)", async () => {
		registerSession(undefined);
		await send({
			fromAgent: LEAD,
			toAgent: EXEC,
			content: "legacy path",
			dbPath,
		});
		expect(existsSync(claudeInboxPath())).toBe(true);
		expect(existsSync(codexInboxPath())).toBe(false);
	});

	it('vendor="none" (no-transport backend) → loud skip, NO mailbox write, NO delivered_at', async () => {
		registerSession("none");
		const id = await send({
			fromAgent: LEAD,
			toAgent: EXEC,
			content: "instruction for an agy runner",
			dbPath,
		});
		// neither mailbox written — writing the claude inbox would FAKE delivery
		expect(existsSync(claudeInboxPath())).toBe(false);
		expect(existsSync(codexInboxPath())).toBe(false);
		const db = new CommDB(dbPath);
		const unread = db.getUnreadInstructions(EXEC);
		expect(unread[0]?.id).toBe(id);
		expect(unread[0]?.delivered_at).toBeNull();
		db.close();
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("no-transport backend"),
		);
	});

	it('vendor="" (empty string) → flows to the wake layer as an UNKNOWN backend (loud), never a silent env fallback', async () => {
		registerSession("");
		await send({
			fromAgent: LEAD,
			toAgent: EXEC,
			content: "misregistered empty vendor",
			dbPath,
		});
		expect(existsSync(claudeInboxPath())).toBe(false);
		expect(existsSync(codexInboxPath())).toBe(false);
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("unsupported wake transport backend"),
		);
	});

	it("unsupported vendor string → loud stderr error, CommDB row still written (fail-safe)", async () => {
		registerSession("gemini-something");
		const id = await send({
			fromAgent: LEAD,
			toAgent: EXEC,
			content: "misconfigured",
			dbPath,
		});
		// no mailbox reached...
		expect(existsSync(claudeInboxPath())).toBe(false);
		expect(existsSync(codexInboxPath())).toBe(false);
		// ...but the durable CommDB record exists and the failure is loud
		const db = new CommDB(dbPath);
		const unread = db.getUnreadInstructions(EXEC);
		expect(unread[0]?.id).toBe(id);
		expect(unread[0]?.delivered_at).toBeNull();
		db.close();
		expect(console.error).toHaveBeenCalledWith(
			expect.stringContaining("unsupported wake transport backend"),
		);
	});
});
