import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Test scope enforcement logic used by the MCP server.
 * We test the getSessionScoped behavior directly rather than spinning up
 * a full MCP server, since the scope guard is the critical security boundary.
 */

function getSessionScoped(
	db: CommDB,
	sessionId: string,
	leadId: string,
	opts?: { requireExactLead?: boolean },
) {
	const session = db.getSession(sessionId);
	if (!session) {
		throw new Error(`No session found: ${sessionId}`);
	}
	if (opts?.requireExactLead) {
		if (session.lead_id !== leadId) {
			throw new Error(
				`Session ${sessionId} is not in scope for lead ${leadId}`,
			);
		}
	} else {
		if (session.lead_id !== null && session.lead_id !== leadId) {
			throw new Error(
				`Session ${sessionId} is not in scope for lead ${leadId}`,
			);
		}
	}
	return session;
}

describe("MCP scope enforcement", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-mcp-scope-"));
		dbPath = join(tmpDir, "comm.db");

		const db = new CommDB(dbPath, true);
		db.registerSession(
			"exec-product-1",
			"GEO-1:@0",
			"testproject",
			"FLY-11",
			"product-lead",
		);
		db.registerSession(
			"exec-ops-1",
			"GEO-2:@1",
			"testproject",
			"FLY-12",
			"ops-lead",
		);
		db.registerSession("exec-legacy-1", "GEO-3:@2", "testproject", "FLY-13"); // null lead_id
		db.close();
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should allow access to own sessions", () => {
		const db = CommDB.openReadonly(dbPath);
		try {
			const session = getSessionScoped(db, "exec-product-1", "product-lead");
			expect(session.execution_id).toBe("exec-product-1");
		} finally {
			db.close();
		}
	});

	it("should reject access to other lead's sessions", () => {
		const db = CommDB.openReadonly(dbPath);
		try {
			expect(() => getSessionScoped(db, "exec-ops-1", "product-lead")).toThrow(
				"not in scope for lead product-lead",
			);
		} finally {
			db.close();
		}
	});

	it("should allow access to null lead_id sessions (unscoped legacy)", () => {
		const db = CommDB.openReadonly(dbPath);
		try {
			const session = getSessionScoped(db, "exec-legacy-1", "product-lead");
			expect(session.execution_id).toBe("exec-legacy-1");
			expect(session.lead_id).toBeNull();
		} finally {
			db.close();
		}
	});

	it("should throw on nonexistent session", () => {
		const db = CommDB.openReadonly(dbPath);
		try {
			expect(() => getSessionScoped(db, "nonexistent", "product-lead")).toThrow(
				"No session found: nonexistent",
			);
		} finally {
			db.close();
		}
	});

	it("should reject null lead_id sessions with requireExactLead (write operations)", () => {
		const db = CommDB.openReadonly(dbPath);
		try {
			expect(() =>
				getSessionScoped(db, "exec-legacy-1", "product-lead", {
					requireExactLead: true,
				}),
			).toThrow("not in scope for lead product-lead");
		} finally {
			db.close();
		}
	});

	it("should allow exact match with requireExactLead", () => {
		const db = CommDB.openReadonly(dbPath);
		try {
			const session = getSessionScoped(db, "exec-product-1", "product-lead", {
				requireExactLead: true,
			});
			expect(session.execution_id).toBe("exec-product-1");
		} finally {
			db.close();
		}
	});

	it("should filter list by lead scope", () => {
		const leadId = "product-lead";
		const db = CommDB.openReadonly(dbPath);
		try {
			const allSessions = db.listSessions("testproject");
			const scoped = allSessions.filter(
				(s) => s.lead_id === null || s.lead_id === leadId,
			);

			// product-lead sees own session + legacy null session
			expect(scoped).toHaveLength(2);
			const ids = scoped.map((s) => s.execution_id);
			expect(ids).toContain("exec-product-1");
			expect(ids).toContain("exec-legacy-1");
			expect(ids).not.toContain("exec-ops-1");
		} finally {
			db.close();
		}
	});
});
