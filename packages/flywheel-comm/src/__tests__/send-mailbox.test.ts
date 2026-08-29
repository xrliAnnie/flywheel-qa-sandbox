import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ClaudeCodeAdapter,
	deriveRunnerMailboxIdentity,
} from "flywheel-agent-team-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { send } from "../commands/send.js";
import { CommDB } from "../db.js";

/**
 * FLY-168 — `flywheel-comm send` mailbox dual-write integration.
 *
 * Uses an isolated temp CLAUDE_CONFIG_DIR so the mailbox write lands in a
 * sandbox and the path invariant (Codex r1 #4) is assertable.
 */
describe("send mailbox dual-write (FLY-168)", () => {
	let tmpDir: string;
	let dbPath: string;
	let cfgDir: string;
	const EXEC = "6b1920df-fcad-4ebc-9677-40ac675cf229";
	const LEAD = "product-lead";

	const origCfg = process.env.CLAUDE_CONFIG_DIR;
	const origBackend = process.env.FLYWHEEL_COMM_BACKEND;
	const origAgent = process.env.FLYWHEEL_AGENT_BACKEND;

	const inboxPath = () => {
		const { agentName, teamName } = deriveRunnerMailboxIdentity(EXEC, LEAD);
		return new ClaudeCodeAdapter().getInboxPath(teamName, agentName);
	};
	const readInbox = () =>
		JSON.parse(readFileSync(inboxPath(), "utf-8")) as Array<{
			from: string;
			text: string;
			read: boolean;
		}>;
	const registerSession = () => {
		const db = new CommDB(dbPath);
		db.registerSession(EXEC, "sess:win", "proj", "GEO-378", LEAD);
		db.close();
	};

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly168-send-"));
		dbPath = join(tmpDir, "comm.db");
		cfgDir = join(tmpDir, "claude-config");
		process.env.CLAUDE_CONFIG_DIR = cfgDir;
		delete process.env.FLYWHEEL_COMM_BACKEND; // default = mailbox
		delete process.env.FLYWHEEL_AGENT_BACKEND; // default = claude-code
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
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

	it("writes BOTH the mailbox inbox and the CommDB instruction (mailbox mode)", async () => {
		registerSession();
		const id = await send({
			fromAgent: LEAD,
			toAgent: EXEC,
			content: "switch to GEO-999",
			dbPath,
		});

		// CommDB instruction present — content is the ORIGINAL (no transport
		// decoration in the audit record; FLY-208 B)
		const db = new CommDB(dbPath);
		const unread = db.getUnreadInstructions(EXEC);
		db.close();
		expect(unread).toHaveLength(1);
		expect(unread[0]!.id).toBe(id);
		expect(unread[0]!.content).toBe("switch to GEO-999");

		// Mailbox entry present at the EXACT derived inbox path (path invariant)
		expect(existsSync(inboxPath())).toBe(true);
		const entries = readInbox();
		expect(entries).toHaveLength(1);
		expect(entries[0]!.from).toBe(LEAD);
		// payload.content maps to claude-code's `text` field — guards the
		// {from,to,content} shape (NOT {from,text}) from writing undefined.
		// FLY-208 B: the Runner-visible text is prefixed with the CommDB id so
		// vendor-layer at-least-once re-delivery is trivially recognizable.
		expect(entries[0]!.text).toBe(
			`[lead-instruction ${id}]\nswitch to GEO-999`,
		);
		expect(entries[0]!.read).toBe(false);
	});

	it("marks delivered_at after a successful mailbox wake (FLY-208 B)", async () => {
		registerSession();
		const id = await send({
			fromAgent: LEAD,
			toAgent: EXEC,
			content: "revise per Annie feedback",
			dbPath,
		});

		const db = new CommDB(dbPath);
		const unread = db.getUnreadInstructions(EXEC);
		db.close();
		expect(unread).toHaveLength(1);
		expect(unread[0]!.id).toBe(id);
		// Semantics: "transport write returned ok" (raw write, NOT verified) —
		// distinguishes delivered-to-mailbox from never-delivered in the audit
		// trail. read_at stays NULL (no reliable Runner-side ack point).
		expect(unread[0]!.delivered_at).not.toBeNull();
		expect(unread[0]!.read_at ?? null).toBeNull();
	});

	it("leaves delivered_at NULL in rollback mode (commdb backend)", async () => {
		process.env.FLYWHEEL_COMM_BACKEND = "commdb";
		registerSession();
		await send({
			fromAgent: LEAD,
			toAgent: EXEC,
			content: "rollback no delivered_at",
			dbPath,
		});
		const db = new CommDB(dbPath);
		const unread = db.getUnreadInstructions(EXEC);
		db.close();
		expect(unread[0]!.delivered_at ?? null).toBeNull();
	});

	it("leaves delivered_at NULL when the mailbox write fails", async () => {
		registerSession();
		const badCfg = join(tmpDir, "not-a-dir-2");
		writeFileSync(badCfg, "x");
		process.env.CLAUDE_CONFIG_DIR = badCfg;

		await send({
			fromAgent: LEAD,
			toAgent: EXEC,
			content: "mailbox fails, no delivered_at",
			dbPath,
		});
		const db = new CommDB(dbPath);
		const unread = db.getUnreadInstructions(EXEC);
		db.close();
		expect(unread).toHaveLength(1);
		expect(unread[0]!.delivered_at ?? null).toBeNull();
	});

	it("does NOT write the mailbox in rollback mode (FLYWHEEL_COMM_BACKEND=commdb)", async () => {
		process.env.FLYWHEEL_COMM_BACKEND = "commdb";
		registerSession();
		const id = await send({
			fromAgent: LEAD,
			toAgent: EXEC,
			content: "rollback path",
			dbPath,
		});

		const db = new CommDB(dbPath);
		expect(db.getUnreadInstructions(EXEC)).toHaveLength(1);
		db.close();
		expect(id).toBeTruthy();
		expect(existsSync(inboxPath())).toBe(false);
	});

	it("degrades to CommDB-only (no throw) when the session has no lead_id", async () => {
		// No registerSession() → getSession returns undefined
		const id = await send({
			fromAgent: LEAD,
			toAgent: EXEC,
			content: "no session",
			dbPath,
		});
		const db = new CommDB(dbPath);
		expect(db.getUnreadInstructions(EXEC)).toHaveLength(1);
		db.close();
		expect(id).toBeTruthy();
		expect(existsSync(inboxPath())).toBe(false);
		expect(console.warn).toHaveBeenCalled();
	});

	it("keeps the CommDB write durable even when the mailbox write throws", async () => {
		registerSession();
		// Point CLAUDE_CONFIG_DIR at a FILE so the inbox mkdir fails (ENOTDIR).
		const badCfg = join(tmpDir, "not-a-dir");
		writeFileSync(badCfg, "x");
		process.env.CLAUDE_CONFIG_DIR = badCfg;

		const id = await send({
			fromAgent: LEAD,
			toAgent: EXEC,
			content: "mailbox will fail",
			dbPath,
		});

		// send did not throw; CommDB still has the instruction
		const db = new CommDB(dbPath);
		expect(db.getUnreadInstructions(EXEC)).toHaveLength(1);
		db.close();
		expect(id).toBeTruthy();
		expect(console.error).toHaveBeenCalled(); // loud stderr
	});
});
