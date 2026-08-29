/**
 * FLY-123 (Codex R3 #1 + R4 #1): ordinary (non-gated) no-block gate responses
 * must dual-write a mailbox wake routed by the TARGET runner's transport
 * backend, sourced from the question-bound unanswered-gate marker — never
 * the process-wide env. Markerless questions (Claude runners) keep the
 * legacy no-wake behavior byte-compatibly.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wakeNoBlockGateRunnerBestEffort } from "../commands/respond.js";
import { CommDB } from "../db.js";
import { readGateMarker, writeGateMarker } from "../gate-marker.js";
import type { WakeResult, WakeRunnerArgs } from "../wake.js";

const EXEC = "exec-fly123-codex";
const LEAD = "product-lead";

describe("respond → no-block gate wake routing (FLY-123)", () => {
	let tmpDir: string;
	let dbPath: string;
	let markerDir: string;
	let db: CommDB;
	let wakeCalls: WakeRunnerArgs[];
	const wakeImpl = async (args: WakeRunnerArgs): Promise<WakeResult> => {
		wakeCalls.push(args);
		return { ok: true };
	};

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly123-respond-wake-"));
		dbPath = join(tmpDir, "comm.db");
		markerDir = join(tmpDir, "codex-gates");
		db = new CommDB(dbPath);
		db.registerSession(EXEC, "sess:win", "proj", "FLY-123", LEAD);
		wakeCalls = [];
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function envWithMarkerDir(): NodeJS.ProcessEnv {
		return { FLYWHEEL_GATE_MARKER_DIR: markerDir } as NodeJS.ProcessEnv;
	}

	it("marker present → wake with backend from MARKER (not env), marker marked answered", async () => {
		const questionId = db.insertQuestion(EXEC, LEAD, "Which color?", {
			checkpoint: "question",
		});
		writeGateMarker(markerDir, {
			questionId,
			executionId: EXEC,
			backend: "codex-tmux",
			vendor: "codex",
			checkpoint: "question",
		});
		db.insertResponse(questionId, LEAD, "blue");

		await wakeNoBlockGateRunnerBestEffort(
			db,
			{ questionId, fromAgent: LEAD },
			envWithMarkerDir(),
			wakeImpl,
		);

		expect(wakeCalls).toHaveLength(1);
		expect(wakeCalls[0]?.backend).toBe("codex");
		expect(wakeCalls[0]?.execId).toBe(EXEC);
		expect(wakeCalls[0]?.metadata).toMatchObject({
			questionId,
			kind: "gate_answered",
		});
		// wake text carries no authority
		expect(wakeCalls[0]?.content).toMatch(/NO authority/);
		expect(readGateMarker(markerDir, questionId)?.answeredAt).toBeTruthy();
	});

	it("markerless question (Claude runner) → NO wake (byte-compat)", async () => {
		const questionId = db.insertQuestion(EXEC, LEAD, "plain question", {
			checkpoint: "question",
		});
		await wakeNoBlockGateRunnerBestEffort(
			db,
			{ questionId, fromAgent: LEAD },
			envWithMarkerDir(),
			wakeImpl,
		);
		expect(wakeCalls).toEqual([]);
	});

	it("already-answered marker → no duplicate wake", async () => {
		const questionId = db.insertQuestion(EXEC, LEAD, "q", {
			checkpoint: "question",
		});
		writeGateMarker(markerDir, {
			questionId,
			executionId: EXEC,
			backend: "codex-tmux",
			vendor: "codex",
			checkpoint: "question",
		});
		const env = envWithMarkerDir();
		await wakeNoBlockGateRunnerBestEffort(
			db,
			{ questionId, fromAgent: LEAD },
			env,
			wakeImpl,
		);
		await wakeNoBlockGateRunnerBestEffort(
			db,
			{ questionId, fromAgent: LEAD },
			env,
			wakeImpl,
		);
		expect(wakeCalls).toHaveLength(1);
	});

	it("execution mismatch between marker and question → skip wake, marker untouched (R5 #1)", async () => {
		const questionId = db.insertQuestion("exec-OTHER", LEAD, "q", {
			checkpoint: "question",
		});
		writeGateMarker(markerDir, {
			questionId,
			executionId: EXEC, // marker claims a different execution
			backend: "codex-tmux",
			vendor: "codex",
			checkpoint: "question",
		});
		await wakeNoBlockGateRunnerBestEffort(
			db,
			{ questionId, fromAgent: LEAD },
			envWithMarkerDir(),
			wakeImpl,
		);
		expect(wakeCalls).toEqual([]);
		expect(readGateMarker(markerDir, questionId)?.answeredAt).toBeUndefined();
	});

	it("wake failure is best-effort — never throws (response already durable)", async () => {
		const questionId = db.insertQuestion(EXEC, LEAD, "q", {
			checkpoint: "question",
		});
		writeGateMarker(markerDir, {
			questionId,
			executionId: EXEC,
			backend: "codex-tmux",
			vendor: "codex",
			checkpoint: "question",
		});
		const failingWake = async (): Promise<WakeResult> => ({
			ok: false,
			error: "boom",
		});
		await expect(
			wakeNoBlockGateRunnerBestEffort(
				db,
				{ questionId, fromAgent: LEAD },
				envWithMarkerDir(),
				failingWake,
			),
		).resolves.toBeUndefined();
	});
});
