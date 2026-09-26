/**
 * FLY-142 (B + Option Y): `flywheel-comm respond` to a genuine `ask`
 * (checkpoint-less) question must wake the asking runner via mailbox, routed to
 * the runner's OWN transport backend.
 *
 * The runner used the non-blocking `ask`, finished its task and went idle
 * (stage=completed) — it is no longer polling `flywheel-comm check`, so in
 * mailbox mode (prod) nothing wakes it when the Lead `respond`s and the answer
 * is lost (the GEO-371 incident).
 *
 * Vendor-neutral routing (Option Y, mirroring the FLY-123 gate-marker): a Codex
 * runner's `ask` drops a question-bound ask-marker carrying its transport
 * vendor; `respond` reads it and routes the wake to the Codex mailbox. Claude
 * runners write no marker → the wake falls back to fromEnv = claude-code,
 * byte-compatibly. Gate questions (any checkpoint) are untouched: blocking gates
 * poll for their own answer, no-block gates wake via their own marker.
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
import { ask } from "../commands/ask.js";
import { respond, wakeAskedRunnerBestEffort } from "../commands/respond.js";
import { CommDB } from "../db.js";
import { readAskMarker, writeAskMarker } from "../gate-marker.js";
import type { WakeResult, WakeRunnerArgs } from "../wake.js";

const EXEC = "exec-fly142-ask";
const LEAD = "product-lead";

describe("respond → ask-originated wake unit (FLY-142 B/Y)", () => {
	let tmpDir: string;
	let dbPath: string;
	let markerDir: string;
	let env: NodeJS.ProcessEnv;
	let db: CommDB;
	let wakeCalls: WakeRunnerArgs[];
	const wakeImpl = async (args: WakeRunnerArgs): Promise<WakeResult> => {
		wakeCalls.push(args);
		return { ok: true };
	};

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly142-ask-wake-"));
		dbPath = join(tmpDir, "comm.db");
		markerDir = join(tmpDir, "gates");
		env = { FLYWHEEL_GATE_MARKER_DIR: markerDir } as NodeJS.ProcessEnv;
		db = new CommDB(dbPath);
		db.registerSession(EXEC, "sess:win", "proj", "FLY-142", LEAD);
		wakeCalls = [];
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("Claude ask (no marker) → wake fired, backend undefined (fromEnv → claude-code)", async () => {
		const questionId = db.insertQuestion(EXEC, LEAD, "Which API version?");
		db.insertResponse(questionId, LEAD, "v2");

		await wakeAskedRunnerBestEffort(
			db,
			{ questionId, fromAgent: LEAD },
			env,
			wakeImpl,
		);

		expect(wakeCalls).toHaveLength(1);
		// wake routes to the runner that ASKED (question.from_agent)
		expect(wakeCalls[0]?.execId).toBe(EXEC);
		expect(wakeCalls[0]?.metadata).toMatchObject({
			questionId,
			kind: "ask_answered",
		});
		expect(wakeCalls[0]?.content).toContain("check");
		expect(wakeCalls[0]?.content).toMatch(/NO authority/);
		// markerless ask → no explicit backend → wakeRunnerMailbox uses fromEnv
		expect(wakeCalls[0]?.backend).toBeUndefined();
	});

	it("Codex ask (ask-marker present) → wake routed with the marker vendor, marker removed", async () => {
		const questionId = db.insertQuestion(EXEC, LEAD, "Which color?");
		db.insertResponse(questionId, LEAD, "blue");
		// the Codex runner dropped a vendor-bearing ask-marker at ask time
		writeAskMarker(markerDir, {
			questionId,
			executionId: EXEC,
			vendor: "codex",
		});

		await wakeAskedRunnerBestEffort(
			db,
			{ questionId, fromAgent: LEAD },
			env,
			wakeImpl,
		);

		expect(wakeCalls).toHaveLength(1);
		expect(wakeCalls[0]?.execId).toBe(EXEC);
		// routed to the Codex mailbox backend, NOT the env default
		expect(wakeCalls[0]?.backend).toBe("codex");
		// one-shot: the marker is removed once the response is delivered
		expect(readAskMarker(markerDir, questionId)).toBeUndefined();
	});

	it("gate question (has checkpoint) → NO ask-wake (gates poll / marker handles)", async () => {
		const questionId = db.insertQuestion(EXEC, LEAD, "approve?", {
			checkpoint: "brainstorm",
		});
		db.insertResponse(questionId, LEAD, "ok");

		await wakeAskedRunnerBestEffort(
			db,
			{ questionId, fromAgent: LEAD },
			env,
			wakeImpl,
		);

		expect(wakeCalls).toEqual([]);
	});

	it("missing question → no wake, no throw", async () => {
		await expect(
			wakeAskedRunnerBestEffort(
				db,
				{ questionId: "does-not-exist", fromAgent: LEAD },
				env,
				wakeImpl,
			),
		).resolves.toBeUndefined();
		expect(wakeCalls).toEqual([]);
	});

	it("wake failure is best-effort — never throws (response already durable)", async () => {
		const questionId = db.insertQuestion(EXEC, LEAD, "q?");
		const failingWake = async (): Promise<WakeResult> => ({
			ok: false,
			error: "boom",
		});
		await expect(
			wakeAskedRunnerBestEffort(
				db,
				{ questionId, fromAgent: LEAD },
				env,
				failingWake,
			),
		).resolves.toBeUndefined();
	});
});

describe("ask writes a vendor-bearing ask-marker (FLY-142 Y)", () => {
	let tmpDir: string;
	let dbPath: string;
	let markerDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly142-ask-marker-"));
		dbPath = join(tmpDir, "comm.db");
		markerDir = join(tmpDir, "gates");
		const db = new CommDB(dbPath);
		db.registerSession(EXEC, "sess:win", "proj", "FLY-142", LEAD);
		db.close();
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("Codex env → ask writes ask-marker with vendor from FLYWHEEL_RUNNER_VENDOR_ID", () => {
		const qid = ask({
			lead: LEAD,
			execId: EXEC,
			question: "q",
			dbPath,
			env: {
				FLYWHEEL_GATE_MARKER_DIR: markerDir,
				FLYWHEEL_RUNNER_VENDOR_ID: "codex",
			} as NodeJS.ProcessEnv,
		});
		const m = readAskMarker(markerDir, qid);
		expect(m?.executionId).toBe(EXEC);
		expect(m?.vendor).toBe("codex");
	});

	it("vendor defaults to 'codex' when only FLYWHEEL_GATE_MARKER_DIR is set", () => {
		const qid = ask({
			lead: LEAD,
			execId: EXEC,
			question: "q",
			dbPath,
			env: { FLYWHEEL_GATE_MARKER_DIR: markerDir } as NodeJS.ProcessEnv,
		});
		expect(readAskMarker(markerDir, qid)?.vendor).toBe("codex");
	});

	it("Claude runner (no FLYWHEEL_GATE_MARKER_DIR) → NO ask-marker (byte-compat)", () => {
		const qid = ask({
			lead: LEAD,
			execId: EXEC,
			question: "q",
			dbPath,
			env: {} as NodeJS.ProcessEnv,
		});
		expect(readAskMarker(markerDir, qid)).toBeUndefined();
	});

	it("invalid FLYWHEEL_RUNNER_VENDOR_ID is coerced to 'codex' (no silent wake strand)", () => {
		// A mistaken executor id ("codex-tmux") is not a valid transport backend;
		// persisting it raw would make respond's wake no-op and strand the runner.
		const qid = ask({
			lead: LEAD,
			execId: EXEC,
			question: "q",
			dbPath,
			env: {
				FLYWHEEL_GATE_MARKER_DIR: markerDir,
				FLYWHEEL_RUNNER_VENDOR_ID: "codex-tmux",
			} as NodeJS.ProcessEnv,
		});
		expect(readAskMarker(markerDir, qid)?.vendor).toBe("codex");
	});
});

describe("respond → ask wake end-to-end (FLY-142 B/Y, real transport)", () => {
	let tmpDir: string;
	let dbPath: string;
	let markerDir: string;
	const origCfg = process.env.CLAUDE_CONFIG_DIR;
	const origCodexTeams = process.env.FLYWHEEL_CODEX_TEAMS_DIR;
	const origMarkerDir = process.env.FLYWHEEL_GATE_MARKER_DIR;
	const origRunnerVendor = process.env.FLYWHEEL_RUNNER_VENDOR_ID;
	const origBackend = process.env.FLYWHEEL_COMM_BACKEND;
	const origAgent = process.env.FLYWHEEL_AGENT_BACKEND;

	const claudeInbox = () => {
		const { agentName, teamName } = deriveRunnerMailboxIdentity(EXEC, LEAD);
		return new ClaudeCodeAdapter().getInboxPath(teamName, agentName);
	};
	const codexInbox = () => {
		const { agentName, teamName } = deriveRunnerMailboxIdentity(EXEC, LEAD);
		return new CodexAdapter().getInboxPath(teamName, agentName);
	};

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly142-ask-e2e-"));
		dbPath = join(tmpDir, "comm.db");
		markerDir = join(tmpDir, "gates");
		process.env.CLAUDE_CONFIG_DIR = join(tmpDir, "claude-config");
		process.env.FLYWHEEL_CODEX_TEAMS_DIR = join(tmpDir, "codex-teams");
		process.env.FLYWHEEL_GATE_MARKER_DIR = markerDir;
		delete process.env.FLYWHEEL_RUNNER_VENDOR_ID;
		delete process.env.FLYWHEEL_COMM_BACKEND; // default = mailbox
		delete process.env.FLYWHEEL_AGENT_BACKEND;
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		const restore = (k: string, v: string | undefined) => {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		};
		restore("CLAUDE_CONFIG_DIR", origCfg);
		restore("FLYWHEEL_CODEX_TEAMS_DIR", origCodexTeams);
		restore("FLYWHEEL_GATE_MARKER_DIR", origMarkerDir);
		restore("FLYWHEEL_RUNNER_VENDOR_ID", origRunnerVendor);
		restore("FLYWHEEL_COMM_BACKEND", origBackend);
		restore("FLYWHEEL_AGENT_BACKEND", origAgent);
		vi.restoreAllMocks();
	});

	it("Claude ask → idle → Lead respond wakes the CLAUDE mailbox (GEO-371)", async () => {
		// Claude runner: no FLYWHEEL_GATE_MARKER_DIR injected at its own ask time,
		// so no ask-marker. Simulate by asking WITHOUT the marker env.
		const db = new CommDB(dbPath);
		db.registerSession(EXEC, "sess:win", "proj", "FLY-142", LEAD);
		const qid = ask({
			lead: LEAD,
			execId: EXEC,
			question: "blocking on API choice",
			dbPath,
			env: {} as NodeJS.ProcessEnv, // Claude runner: no marker env
		});
		db.close();

		await respond({
			questionId: qid,
			fromAgent: LEAD,
			answer: "use v2",
			dbPath,
			env: {} as NodeJS.ProcessEnv,
		});

		// response durable
		const db2 = new CommDB(dbPath);
		expect(db2.getResponse(qid)?.content).toBe("use v2");
		db2.close();

		// wake landed in the CLAUDE inbox (fromEnv default), not Codex
		expect(existsSync(claudeInbox())).toBe(true);
		expect(existsSync(codexInbox())).toBe(false);
		const entries = JSON.parse(readFileSync(claudeInbox(), "utf-8")) as Array<{
			text: string;
		}>;
		expect(entries).toHaveLength(1);
		expect(entries[0]?.text).toContain("check");
		expect(entries[0]?.text).toMatch(/NO authority/);
	});

	it("Codex ask → idle → Lead respond wakes the CODEX mailbox, NOT Claude (vendor-neutral)", async () => {
		const db = new CommDB(dbPath);
		db.registerSession(EXEC, "sess:win", "proj", "FLY-142", LEAD);
		// Codex runner asks: its env carries FLYWHEEL_GATE_MARKER_DIR (+ vendor),
		// so ask() drops a vendor-bearing ask-marker.
		const qid = ask({
			lead: LEAD,
			execId: EXEC,
			question: "blocking on API choice",
			dbPath,
			env: {
				FLYWHEEL_GATE_MARKER_DIR: markerDir,
				FLYWHEEL_RUNNER_VENDOR_ID: "codex",
			} as NodeJS.ProcessEnv,
		});
		db.close();

		// Lead responds from a process whose env transport defaults to Claude —
		// the wake must still reach the Codex mailbox via the marker.
		await respond({
			questionId: qid,
			fromAgent: LEAD,
			answer: "use v2",
			dbPath,
			env: { FLYWHEEL_GATE_MARKER_DIR: markerDir } as NodeJS.ProcessEnv,
		});

		// routed to CODEX inbox, and the Claude inbox is untouched
		expect(existsSync(codexInbox())).toBe(true);
		expect(existsSync(claudeInbox())).toBe(false);
	});

	it("checkpoint'd question via full respond → NO ask-wake (regression)", async () => {
		const db = new CommDB(dbPath);
		db.registerSession(EXEC, "sess:win", "proj", "FLY-142", LEAD);
		const qid = db.insertQuestion(EXEC, LEAD, "what about X?", {
			checkpoint: "brainstorm",
		});
		db.close();

		await respond({
			questionId: qid,
			fromAgent: LEAD,
			answer: "proceed",
			dbPath,
			env: { FLYWHEEL_GATE_MARKER_DIR: markerDir } as NodeJS.ProcessEnv,
		});

		expect(existsSync(claudeInbox())).toBe(false);
		expect(existsSync(codexInbox())).toBe(false);
	});
});
