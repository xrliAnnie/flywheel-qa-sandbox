import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { respond } from "../commands/respond.js";
import { CommDB } from "../db.js";
import { FounderConsentAuditStore } from "../founder-consent-audit.js";

let dir: string;
let dbPath: string;
let auditPath: string;

function seed(checkpoint?: string): string {
	const db = new CommDB(dbPath, true);
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
	auditPath = join(dir, "audit.db");
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

	it("approve_to_ship + no bridge + no bypass → FAIL-CLOSED (throws, no write)", async () => {
		const qid = seed("approve_to_ship");
		await expect(
			respond({
				questionId: qid,
				fromAgent: "lead-x",
				answer: "approved",
				dbPath,
				env: {},
			}),
		).rejects.toThrow(/refusing to resolve approve_to_ship/);
		expect(hasResponse(qid)).toBe(false);
	});

	it("approve_to_ship + bridgeUrl but missing TEAMLEAD_API_TOKEN → throws", async () => {
		const qid = seed("approve_to_ship");
		await expect(
			respond({
				questionId: qid,
				fromAgent: "lead-x",
				answer: "approved",
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
			answer: "approved",
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

	it("FLY-208 6b: bridge response warning is printed to stderr", async () => {
		const qid = seed("approve_to_ship");
		const warning =
			"Recorded as FEEDBACK, not approval — only the exact JSON ...";
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ success: true, passthrough: true, warning }),
		})) as unknown as typeof fetch;
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			await respond({
				questionId: qid,
				fromAgent: "lead-x",
				answer: "APPROVE — looks good",
				dbPath,
				projectName: "Proj",
				bridgeUrl: "http://localhost:9999",
				env: { TEAMLEAD_API_TOKEN: "tok" },
				fetchImpl,
			});
			const writes = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
			expect(writes).toContain("WARNING");
			expect(writes).toContain("Recorded as FEEDBACK");
		} finally {
			stderrSpy.mockRestore();
		}
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
				answer: '{"approved": true}',
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
				answer: "approved",
				dbPath,
				bridgeUrl: "http://localhost:9999",
				env: { TEAMLEAD_API_TOKEN: "tok" },
				fetchImpl,
			}),
		).rejects.toThrow(/Bridge refused/);
		expect(hasResponse(qid)).toBe(false);
	});

	it("approve_to_ship + FLYWHEEL_COMM_BYPASS_BRIDGE=1 → writes + loud audit row", async () => {
		const qid = seed("approve_to_ship");
		await respond({
			questionId: qid,
			fromAgent: "lead-x",
			answer: "approved",
			dbPath,
			projectName: "Proj",
			env: {
				FLYWHEEL_COMM_BYPASS_BRIDGE: "1",
				FLYWHEEL_FOUNDER_CONSENT_AUDIT_DB_PATH: auditPath,
			},
		});
		expect(hasResponse(qid)).toBe(true);
		const store = new FounderConsentAuditStore(auditPath);
		const rows = store.queryRecent(10);
		store.close();
		expect(rows).toHaveLength(1);
		expect((rows[0] as Record<string, unknown>).decision).toBe("bypass");
		expect((rows[0] as Record<string, unknown>).decision_source).toBe(
			"bypass_env_cli",
		);
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
