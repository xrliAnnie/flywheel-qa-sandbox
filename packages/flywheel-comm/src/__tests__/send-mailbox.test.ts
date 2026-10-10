import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
	ClaudeCodeAdapter,
	deriveRunnerMailboxIdentity,
} from "flywheel-agent-team-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { send, sendDetailed } from "../commands/send.js";
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

/**
 * FLY-3083 — `sendDetailed`: short-name resolution + the transport result the
 * runner-msg-guard hook and the Runner channel contract rely on. `send()` keeps
 * returning the bare id (every existing caller is untouched).
 */
describe("sendDetailed transport result + short-name --to (FLY-3083)", () => {
	let tmpDir: string;
	let dbPath: string;
	const EXEC = "42afa86c-1111-4222-8333-444455556666";
	const SHORT = "runner-42afa86c";
	const LEAD = "flywheel-eng-lead";

	const origCfg = process.env.CLAUDE_CONFIG_DIR;
	const origBackend = process.env.FLYWHEEL_COMM_BACKEND;
	const origAgent = process.env.FLYWHEEL_AGENT_BACKEND;

	const inboxPath = () => {
		const { agentName, teamName } = deriveRunnerMailboxIdentity(EXEC, LEAD);
		return new ClaudeCodeAdapter().getInboxPath(teamName, agentName);
	};
	const register = (vendor?: string) => {
		const db = new CommDB(dbPath);
		db.registerSession(EXEC, "sess:win", "proj", "FLY-3083", LEAD, vendor);
		db.close();
	};
	const messageRows = () => {
		const raw = new Database(dbPath, { readonly: true });
		try {
			return raw
				.prepare(
					"SELECT id, to_agent, content, delivered_at FROM messages ORDER BY rowid",
				)
				.all() as Array<{
				id: string;
				to_agent: string;
				content: string;
				delivered_at: string | null;
			}>;
		} finally {
			raw.close();
		}
	};

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly3083-send-"));
		dbPath = join(tmpDir, "comm.db");
		process.env.CLAUDE_CONFIG_DIR = join(tmpDir, "claude-config");
		delete process.env.FLYWHEEL_COMM_BACKEND;
		delete process.env.FLYWHEEL_AGENT_BACKEND;
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

	it("resolves a runner short name to the full exec id for CommDB and inbox", async () => {
		register();
		const result = await sendDetailed({
			fromAgent: LEAD,
			toAgent: SHORT,
			content: "hello via short name",
			dbPath,
		});
		expect(result.executionId).toBe(EXEC);
		expect(result.transportWrite).toBe("ok");
		expect(result.delivered).toBe(true);
		expect(result.skippedReason).toBeUndefined();
		expect(result.wakeError).toBeUndefined();

		const rows = messageRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.id).toBe(result.instructionId);
		expect(rows[0]!.to_agent).toBe(EXEC);
		expect(rows[0]!.delivered_at).not.toBeNull();

		const entries = JSON.parse(readFileSync(inboxPath(), "utf-8")) as Array<{
			text: string;
		}>;
		expect(entries).toHaveLength(1);
		expect(entries[0]!.text).toBe(
			`[lead-instruction ${result.instructionId}]\nhello via short name`,
		);
	});

	it("reports transportWrite=error with the wake error when the inbox is unwritable", async () => {
		register();
		const badCfg = join(tmpDir, "not-a-dir");
		writeFileSync(badCfg, "x");
		process.env.CLAUDE_CONFIG_DIR = badCfg;

		const result = await sendDetailed({
			fromAgent: LEAD,
			toAgent: SHORT,
			content: "inbox unwritable",
			dbPath,
		});
		expect(result.transportWrite).toBe("error");
		expect(result.delivered).toBe(false);
		expect(result.wakeError).toBeTruthy();
		const rows = messageRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.delivered_at).toBeNull();
		expect(console.error).toHaveBeenCalled();
	});

	it("reports skipped/backend_commdb in rollback mode", async () => {
		process.env.FLYWHEEL_COMM_BACKEND = "commdb";
		register();
		const result = await sendDetailed({
			fromAgent: LEAD,
			toAgent: EXEC,
			content: "rollback",
			dbPath,
		});
		expect(result.transportWrite).toBe("skipped");
		expect(result.skippedReason).toBe("backend_commdb");
		expect(result.delivered).toBe(false);
		expect(existsSync(inboxPath())).toBe(false);
	});

	it("reports skipped/no_transport for a vendor=none runner", async () => {
		register("none");
		const result = await sendDetailed({
			fromAgent: LEAD,
			toAgent: SHORT,
			content: "antigravity runner",
			dbPath,
		});
		expect(result.executionId).toBe(EXEC);
		expect(result.transportWrite).toBe("skipped");
		expect(result.skippedReason).toBe("no_transport");
		expect(messageRows()).toHaveLength(1);
		expect(existsSync(inboxPath())).toBe(false);
	});

	it("reports skipped/no_session_lead when the full-id target has no session", async () => {
		const result = await sendDetailed({
			fromAgent: LEAD,
			toAgent: EXEC,
			content: "unregistered",
			dbPath,
		});
		expect(result.transportWrite).toBe("skipped");
		expect(result.skippedReason).toBe("no_session_lead");
		expect(messageRows()).toHaveLength(1);
	});

	it("throws on an unresolvable short name and writes nothing", async () => {
		await expect(
			sendDetailed({
				fromAgent: LEAD,
				toAgent: "runner-deadbeef",
				content: "nobody home",
				dbPath,
			}),
		).rejects.toThrow(/no session for runner ref runner-deadbeef/);
		expect(messageRows()).toHaveLength(0);
	});

	it("scopes short-name resolution to the sending Lead", async () => {
		register();
		await expect(
			sendDetailed({
				fromAgent: "some-other-lead",
				toAgent: SHORT,
				content: "not my runner",
				dbPath,
			}),
		).rejects.toThrow(/no session for runner ref/);
		expect(messageRows()).toHaveLength(0);
	});

	it("send() still resolves to the bare instruction id", async () => {
		register();
		const id = await send({
			fromAgent: LEAD,
			toAgent: SHORT,
			content: "compat",
			dbPath,
		});
		expect(typeof id).toBe("string");
		expect(messageRows().map((r) => r.id)).toEqual([id]);
	});
});
