import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type RespondArgs,
	respond as rawRespond,
} from "../commands/respond.js";
import { CommDB } from "../db.js";
import { createTestLeadIdentityEnvs } from "./helpers/lead-identity-env.js";

let dir: string;
let dbPath: string;
let leadEnv: NodeJS.ProcessEnv;

function respond(args: RespondArgs): Promise<void> {
	return rawRespond({ ...args, env: { ...leadEnv, ...args.env } });
}

function seed(checkpoint?: string): string {
	const db = new CommDB(dbPath, true);
	db.registerSession("exec-1", "runner", "Proj", "issue-1", "lead-x");
	const qid = db.insertQuestion("exec-1", "lead-x", "ship?", { checkpoint });
	db.close();
	return qid;
}

function hasResponse(qid: string): boolean {
	const db = new CommDB(dbPath, false);
	const r = db.getResponse(qid);
	db.close();
	return !!r;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "respond-"));
	dbPath = join(dir, "comm.db");
	leadEnv = createTestLeadIdentityEnvs(dir, ["lead-x"], "Proj")["lead-x"]!;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("respond() fail-closed gate (§11.2)", () => {
	it("non-gated checkpoint → legacy direct write", async () => {
		const qid = seed("brainstorm");
		await respond({
			questionId: qid,
			fromAgent: "lead-x",
			answer: "ok",
			dbPath,
			env: {},
		});
		expect(hasResponse(qid)).toBe(true);
	});

	it("approve_to_ship + no bridge fails closed even when the retired bypass env is set", async () => {
		const qid = seed("approve_to_ship");
		await expect(
			respond({
				questionId: qid,
				fromAgent: "lead-x",
				answer: "changes requested",
				dbPath,
				env: { FLYWHEEL_COMM_BYPASS_BRIDGE: "1" },
			}),
		).rejects.toThrow(/refusing to resolve approve_to_ship/);
		expect(hasResponse(qid)).toBe(false);
	});

	it.each([
		["approval text", "approved"],
		["revision feedback", "Please revise the second section."],
		["structured verdict", '{"passed":true}'],
	])(
		"founder_review + %s → Lead respond is always rejected",
		async (_shape, answer) => {
			const qid = seed("founder_review");
			const fetchImpl = vi.fn();
			await expect(
				respond({
					questionId: qid,
					fromAgent: "lead-x",
					answer,
					dbPath,
					bridgeUrl: "http://localhost:9999",
					sourceThread: "thread-1",
					env: { TEAMLEAD_API_TOKEN: "tok" },
					fetchImpl: fetchImpl as typeof fetch,
				}),
			).rejects.toThrow(/founder_review.*only the trusted founder writer/i);
			expect(fetchImpl).not.toHaveBeenCalled();
			expect(hasResponse(qid)).toBe(false);
		},
	);

	it("approve_to_ship + bridgeUrl but missing TEAMLEAD_API_TOKEN → throws", async () => {
		const qid = seed("approve_to_ship");
		await expect(
			respond({
				questionId: qid,
				fromAgent: "lead-x",
				answer: "changes requested",
				dbPath,
				bridgeUrl: "http://localhost:9999",
				env: {},
			}),
		).rejects.toThrow(/TEAMLEAD_API_TOKEN required/);
		expect(hasResponse(qid)).toBe(false);
	});

	it("approve_to_ship + bridge route: POSTs to wrapper, CLI does NOT write", async () => {
		const qid = seed("approve_to_ship");
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ success: true }),
		})) as unknown as typeof fetch;
		await respond({
			questionId: qid,
			fromAgent: "lead-x",
			answer: "changes requested",
			dbPath,
			projectName: "Proj",
			bridgeUrl: "http://localhost:9999",
			env: { TEAMLEAD_API_TOKEN: "tok" },
			fetchImpl,
		});
		expect(fetchImpl).toHaveBeenCalledOnce();
		const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(String(call?.[0])).toContain(
			"/api/founder-consent/runner-gate-response",
		);
		// CLI must NOT write — the wrapper owns the write on allow.
		expect(hasResponse(qid)).toBe(false);
	});

	it("source-thread routes an ordinary response through Bridge with typed scope guards", async () => {
		const qid = seed();
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ ok: true, responseId: "response-1" }),
		})) as unknown as typeof fetch;
		await respond({
			questionId: qid,
			fromAgent: "lead-x",
			answer: "routed answer",
			dbPath,
			sourceThread: "thread-1",
			bridgeUrl: "http://localhost:9999",
			env: { TEAMLEAD_API_TOKEN: "tok" },
			fetchImpl,
		});

		const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(String(url)).toContain("/api/founder-routing/runner-response");
		expect(JSON.parse(String(init?.body))).toMatchObject({
			questionId: qid,
			leadId: "lead-x",
			sourceThread: "thread-1",
			expectedOwner: "exec-1",
			expectedCheckpoint: null,
		});
		expect(hasResponse(qid)).toBe(false);
	});

	it("rejects Lead approval intent before contacting the Bridge", async () => {
		const qid = seed("approve_to_ship");
		const fetchImpl = vi.fn();
		await expect(
			respond({
				questionId: qid,
				fromAgent: "lead-x",
				answer: "APPROVE — looks good",
				dbPath,
				projectName: "Proj",
				bridgeUrl: "http://localhost:9999",
				env: { TEAMLEAD_API_TOKEN: "tok" },
				fetchImpl: fetchImpl as typeof fetch,
			}),
		).rejects.toThrow(/lead_ack_rejected/);
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(hasResponse(qid)).toBe(false);
	});

	it("FLY-208 6b: no warning in bridge response → nothing extra on stderr", async () => {
		const qid = seed("approve_to_ship");
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ success: true }),
		})) as unknown as typeof fetch;
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			await respond({
				questionId: qid,
				fromAgent: "lead-x",
				answer: "changes requested",
				dbPath,
				projectName: "Proj",
				bridgeUrl: "http://localhost:9999",
				env: { TEAMLEAD_API_TOKEN: "tok" },
				fetchImpl,
			});
			const writes = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
			expect(writes).not.toContain("WARNING:");
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it("approve_to_ship + bridge returns non-2xx → throws, no local write", async () => {
		const qid = seed("approve_to_ship");
		const fetchImpl = vi.fn(async () => ({
			ok: false,
			status: 403,
			json: async () => ({ code: "FOUNDER_CONSENT_REQUIRED" }),
		})) as unknown as typeof fetch;
		await expect(
			respond({
				questionId: qid,
				fromAgent: "lead-x",
				answer: "changes requested",
				dbPath,
				bridgeUrl: "http://localhost:9999",
				env: { TEAMLEAD_API_TOKEN: "tok" },
				fetchImpl,
			}),
		).rejects.toThrow(/Bridge refused/);
		expect(hasResponse(qid)).toBe(false);
	});

	it("rejects Lead approval intent even when the retired bypass env is set", async () => {
		const qid = seed("approve_to_ship");
		await expect(
			respond({
				questionId: qid,
				fromAgent: "lead-x",
				answer: "approved",
				dbPath,
				projectName: "Proj",
				env: {
					FLYWHEEL_COMM_BYPASS_BRIDGE: "1",
				},
			}),
		).rejects.toThrow(/lead_ack_rejected/);
		expect(hasResponse(qid)).toBe(false);
	});

	it("the retired bypass cannot write a superseded gate", async () => {
		const oldGate = seed("approve_to_ship");
		const db = new CommDB(dbPath, false);
		try {
			const replacement = db.insertQuestion("exec-2", "lead-x", "replacement", {
				checkpoint: "approve_to_ship",
			});
			expect(db.retireShipGate(oldGate, { supersededBy: replacement })).toBe(
				true,
			);
		} finally {
			db.close();
		}

		await expect(
			respond({
				questionId: oldGate,
				fromAgent: "lead-x",
				answer: "changes requested",
				dbPath,
				projectName: "Proj",
				env: {
					FLYWHEEL_COMM_BYPASS_BRIDGE: "1",
				},
			}),
		).rejects.toThrow(/refusing to resolve approve_to_ship/);
		expect(hasResponse(oldGate)).toBe(false);
	});

	it("throws when question not found", async () => {
		seed("brainstorm"); // create the DB so it exists; query a different id
		await expect(
			respond({
				questionId: "nonexistent-id",
				fromAgent: "lead-x",
				answer: "x",
				dbPath,
				env: {},
			}),
		).rejects.toThrow(/Question not found/);
	});
});
