import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { respond } from "../commands/respond.js";
import { send, sendDetailed } from "../commands/send.js";
import { CommDB } from "../db.js";
import { createTestLeadIdentityEnvs } from "./helpers/lead-identity-env.js";

const ID = "abcdef01-2345-6789-abcd-0123456789ab";
let dir: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fly1942-admit-"));
	dbPath = join(dir, "comm.db");
	env = createTestLeadIdentityEnvs(dir, ["flywheel-eng-lead"])[
		"flywheel-eng-lead"
	]!;
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dir, { recursive: true, force: true });
});

it("rejects malformed and unknown recipients without mailbox rows", async () => {
	for (const toAgent of ["abcdef0", ID]) {
		await expect(
			send({
				fromAgent: "flywheel-eng-lead",
				toAgent,
				content: "continue",
				dbPath,
				env,
			}),
		).rejects.toThrow(/recipient_(malformed|not_found)/);
		const db = new CommDB(dbPath);
		try {
			expect(db.getUnreadInstructions(toAgent)).toEqual([]);
		} finally {
			db.close();
		}
	}
});

it("expands unique prefixes before persisting and preserves send's string result", async () => {
	const db = new CommDB(dbPath);
	db.registerSession(
		ID,
		"s:w",
		"flywheel",
		"FLY-1942",
		"flywheel-eng-lead",
		"codex",
	);
	db.close();
	const stateStore = {
		readStatus: () => ({ readable: true as const, status: "awaiting_review" }),
	};
	const args = {
		fromAgent: "flywheel-eng-lead",
		toAgent: "ABCDEF01",
		content: "continue",
		dbPath,
		env,
		stateStore,
	};
	const result = await sendDetailed(args);
	expect(result).toMatchObject({ resolvedTo: ID, resolvedFromPrefix: true });
	expect(typeof (await send(args))).toBe("string");
	const verify = new CommDB(dbPath);
	try {
		expect(verify.getUnreadInstructions(ID)).toHaveLength(2);
		expect(verify.getUnreadInstructions("ABCDEF01")).toEqual([]);
	} finally {
		verify.close();
	}
});

it("rejects StateStore terminal and warns on unavailable StateStore", async () => {
	const db = new CommDB(dbPath);
	db.registerSession(
		ID,
		"s:w",
		"flywheel",
		"FLY-1942",
		"flywheel-eng-lead",
		"codex",
	);
	db.close();
	const args = {
		fromAgent: "flywheel-eng-lead",
		toAgent: ID,
		content: "continue",
		dbPath,
		env,
	};
	await expect(
		send({
			...args,
			stateStore: {
				readStatus: () => ({ readable: true, status: "completed" }),
			},
		}),
	).rejects.toThrow(/recipient_terminal/);
	const warn = vi.spyOn(console, "error").mockImplementation(() => {});
	await send({
		...args,
		stateStore: {
			readStatus: () => ({ readable: false, reason: "unavailable" }),
		},
	});
	expect(warn).toHaveBeenCalledWith("liveness_unverified: unavailable");
});

it("refuses an ordinary terminal response but keeps gate and engine obligations answerable", async () => {
	const db = new CommDB(dbPath);
	db.registerSession(
		ID,
		"s:w",
		"flywheel",
		"FLY-1942",
		"flywheel-eng-lead",
		"codex",
	);
	const ordinary = db.insertQuestion(ID, "flywheel-eng-lead", "ordinary");
	const gate = db.insertQuestion(ID, "flywheel-eng-lead", "gate", {
		checkpoint: "question",
	});
	const engine = db.insertQuestion(ID, "flywheel-eng-lead", "turn wait", {
		id: `turn-wait:${ID}:2`,
	});
	db.close();
	const args = {
		fromAgent: "flywheel-eng-lead",
		answer: "continue",
		dbPath,
		env,
		stateStore: {
			readStatus: () => ({ readable: true as const, status: "completed" }),
		},
	};
	await expect(respond({ ...args, questionId: ordinary })).rejects.toThrow(
		/recipient_terminal/,
	);
	await respond({ ...args, questionId: gate });
	await respond({ ...args, questionId: engine });
	const verify = new CommDB(dbPath);
	try {
		expect(verify.getResponse(ordinary)).toBeUndefined();
		expect(verify.getResponse(gate)).toBeDefined();
		expect(verify.getResponse(engine)).toBeDefined();
	} finally {
		verify.close();
	}
});
