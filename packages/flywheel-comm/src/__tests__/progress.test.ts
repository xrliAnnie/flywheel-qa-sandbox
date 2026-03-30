import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leadInbox } from "../commands/lead-inbox.js";
import { progress } from "../commands/progress.js";
import { CommDB } from "../db.js";
import { PIPELINE_STAGES, PROGRESS_STATUSES } from "../types.js";

describe("progress system (GEO-292)", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-comm-progress-"));
		dbPath = join(tmpDir, "comm.db");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// ── CommDB methods ──

	describe("CommDB.insertProgress", () => {
		it("should insert a progress message with type='progress'", () => {
			const db = new CommDB(dbPath);
			const id = db.insertProgress("exec-1", "product-lead", '{"stage":"brainstorm","status":"started"}');
			expect(id).toBeTruthy();
			db.close();
		});

		it("should store correct from_agent and to_agent", () => {
			const db = new CommDB(dbPath);
			db.insertProgress("exec-1", "product-lead", '{"stage":"brainstorm"}');
			const msgs = db.getUnreadProgress("product-lead");
			expect(msgs).toHaveLength(1);
			expect(msgs[0]!.from_agent).toBe("exec-1");
			expect(msgs[0]!.to_agent).toBe("product-lead");
			expect(msgs[0]!.type).toBe("progress");
			db.close();
		});
	});

	describe("CommDB.getUnreadProgress", () => {
		it("should return only progress messages for the given lead", () => {
			const db = new CommDB(dbPath);
			db.insertProgress("exec-1", "product-lead", "progress1");
			db.insertProgress("exec-2", "ops-lead", "progress2");
			db.insertInstruction("product-lead", "exec-1", "do this");

			const msgs = db.getUnreadProgress("product-lead");
			expect(msgs).toHaveLength(1);
			expect(msgs[0]!.content).toBe("progress1");
			db.close();
		});

		it("should not return read messages", () => {
			const db = new CommDB(dbPath);
			const id = db.insertProgress("exec-1", "product-lead", "progress1");
			db.markInstructionRead(id);

			const msgs = db.getUnreadProgress("product-lead");
			expect(msgs).toHaveLength(0);
			db.close();
		});

		it("should return messages ordered by created_at ASC", () => {
			const db = new CommDB(dbPath);
			db.insertProgress("exec-1", "product-lead", "first");
			db.insertProgress("exec-2", "product-lead", "second");

			const msgs = db.getUnreadProgress("product-lead");
			expect(msgs).toHaveLength(2);
			expect(msgs[0]!.content).toBe("first");
			expect(msgs[1]!.content).toBe("second");
			db.close();
		});
	});

	// ── progress command ──

	describe("progress command", () => {
		it("should insert progress when session exists with lead_id", () => {
			const db = new CommDB(dbPath);
			db.registerSession("exec-1", "flywheel:@1", "geoforge3d", "GEO-292", "product-lead");
			db.close();

			const messageId = progress({
				execId: "exec-1",
				stage: "brainstorm",
				status: "started",
				dbPath,
			});

			expect(messageId).toBeTruthy();

			// Verify the message was inserted correctly
			const db2 = new CommDB(dbPath, false);
			const msgs = db2.getUnreadProgress("product-lead");
			expect(msgs).toHaveLength(1);
			const payload = JSON.parse(msgs[0]!.content);
			expect(payload.stage).toBe("brainstorm");
			expect(payload.status).toBe("started");
			expect(payload.executionId).toBe("exec-1");
			expect(payload.issueId).toBe("GEO-292");
			expect(payload.timestamp).toBeTruthy();
			db2.close();
		});

		it("should include artifact in payload when provided", () => {
			const db = new CommDB(dbPath);
			db.registerSession("exec-1", "flywheel:@1", "geoforge3d", "GEO-292", "product-lead");
			db.close();

			progress({
				execId: "exec-1",
				stage: "brainstorm",
				status: "completed",
				dbPath,
				artifact: "doc/exploration/new/GEO-292.md",
			});

			const db2 = new CommDB(dbPath, false);
			const msgs = db2.getUnreadProgress("product-lead");
			const payload = JSON.parse(msgs[0]!.content);
			expect(payload.artifact).toBe("doc/exploration/new/GEO-292.md");
			db2.close();
		});

		it("should return null when DB does not exist (best-effort)", () => {
			const result = progress({
				execId: "exec-1",
				stage: "brainstorm",
				status: "started",
				dbPath: join(tmpDir, "nonexistent", "comm.db"),
			});

			expect(result).toBeNull();
		});

		it("should return null when no session found", () => {
			// Create DB but no session
			const db = new CommDB(dbPath);
			db.close();

			const result = progress({
				execId: "nonexistent",
				stage: "brainstorm",
				status: "started",
				dbPath,
			});

			expect(result).toBeNull();
		});

		it("should return null when session has no lead_id", () => {
			const db = new CommDB(dbPath);
			db.registerSession("exec-1", "flywheel:@1", "geoforge3d", "GEO-292");
			db.close();

			const result = progress({
				execId: "exec-1",
				stage: "brainstorm",
				status: "started",
				dbPath,
			});

			expect(result).toBeNull();
		});

		it("should throw on invalid stage", () => {
			expect(() =>
				progress({
					execId: "exec-1",
					stage: "invalid_stage",
					status: "started",
					dbPath,
				}),
			).toThrow("Invalid stage: invalid_stage");
		});

		it("should throw on invalid status", () => {
			expect(() =>
				progress({
					execId: "exec-1",
					stage: "brainstorm",
					status: "invalid_status",
					dbPath,
				}),
			).toThrow("Invalid status: invalid_status");
		});

		it("should validate all canonical stages", () => {
			for (const stage of PIPELINE_STAGES) {
				// Should not throw
				const db = new CommDB(dbPath);
				db.registerSession(`exec-${stage}`, "flywheel:@1", "geoforge3d", "GEO-1", "lead-1");
				db.close();

				expect(() =>
					progress({
						execId: `exec-${stage}`,
						stage,
						status: "started",
						dbPath,
					}),
				).not.toThrow();
			}
		});

		it("should validate all progress statuses", () => {
			for (const status of PROGRESS_STATUSES) {
				const db = new CommDB(dbPath);
				db.registerSession(`exec-${status}`, "flywheel:@1", "geoforge3d", "GEO-1", "lead-1");
				db.close();

				expect(() =>
					progress({
						execId: `exec-${status}`,
						stage: "brainstorm",
						status,
						dbPath,
					}),
				).not.toThrow();
			}
		});
	});

	// ── lead-inbox command ──

	describe("lead-inbox command", () => {
		it("should return progress messages and mark them read", () => {
			const db = new CommDB(dbPath);
			db.insertProgress("exec-1", "product-lead", '{"stage":"brainstorm","status":"completed"}');
			db.close();

			const result = leadInbox({ leadId: "product-lead", dbPath });
			expect(result.messages).toHaveLength(1);
			expect(result.messages[0]!.type).toBe("progress");

			// Second call should return empty (marked read)
			const result2 = leadInbox({ leadId: "product-lead", dbPath });
			expect(result2.messages).toHaveLength(0);
		});

		it("should return empty when DB does not exist", () => {
			const result = leadInbox({
				leadId: "product-lead",
				dbPath: join(tmpDir, "nonexistent.db"),
			});
			expect(result.messages).toHaveLength(0);
		});

		it("should not return messages for other leads", () => {
			const db = new CommDB(dbPath);
			db.insertProgress("exec-1", "ops-lead", "progress for ops");
			db.close();

			const result = leadInbox({ leadId: "product-lead", dbPath });
			expect(result.messages).toHaveLength(0);
		});
	});

	// ── Integration: progress → lead-inbox round-trip ──

	describe("progress → lead-inbox round-trip", () => {
		it("should complete full Runner → Lead progress cycle", () => {
			// Setup: register session
			const db = new CommDB(dbPath);
			db.registerSession("exec-1", "flywheel:@1", "geoforge3d", "GEO-292", "product-lead");
			db.close();

			// Runner sends progress
			const msgId = progress({
				execId: "exec-1",
				stage: "research",
				status: "completed",
				dbPath,
				artifact: "doc/research/new/GEO-292.md",
			});
			expect(msgId).toBeTruthy();

			// Lead reads progress
			const result = leadInbox({ leadId: "product-lead", dbPath });
			expect(result.messages).toHaveLength(1);
			const payload = JSON.parse(result.messages[0]!.content);
			expect(payload.stage).toBe("research");
			expect(payload.status).toBe("completed");
			expect(payload.artifact).toBe("doc/research/new/GEO-292.md");
			expect(payload.issueId).toBe("GEO-292");
		});

		it("should resolve lead_id from sessions table correctly", () => {
			const db = new CommDB(dbPath);
			// Two runners, different leads
			db.registerSession("exec-1", "flywheel:@1", "geoforge3d", "GEO-100", "product-lead");
			db.registerSession("exec-2", "flywheel:@2", "geoforge3d", "GEO-200", "ops-lead");
			db.close();

			progress({ execId: "exec-1", stage: "brainstorm", status: "started", dbPath });
			progress({ execId: "exec-2", stage: "implement", status: "started", dbPath });

			const productMsgs = leadInbox({ leadId: "product-lead", dbPath });
			expect(productMsgs.messages).toHaveLength(1);
			expect(JSON.parse(productMsgs.messages[0]!.content).issueId).toBe("GEO-100");

			const opsMsgs = leadInbox({ leadId: "ops-lead", dbPath });
			expect(opsMsgs.messages).toHaveLength(1);
			expect(JSON.parse(opsMsgs.messages[0]!.content).issueId).toBe("GEO-200");
		});
	});

	// ── Regression: existing send/inbox unaffected ──

	describe("regression: send/inbox unchanged", () => {
		it("send/inbox should still work for instructions", () => {
			const db = new CommDB(dbPath);
			const id = db.insertInstruction("product-lead", "exec-1", "do this task");
			const instructions = db.getUnreadInstructions("exec-1");
			expect(instructions).toHaveLength(1);
			expect(instructions[0]!.id).toBe(id);
			expect(instructions[0]!.type).toBe("instruction");
			db.close();
		});

		it("progress messages should not appear in getUnreadInstructions", () => {
			const db = new CommDB(dbPath);
			db.insertProgress("exec-1", "product-lead", "progress data");
			const instructions = db.getUnreadInstructions("product-lead");
			expect(instructions).toHaveLength(0);
			db.close();
		});

		it("instructions should not appear in getUnreadProgress", () => {
			const db = new CommDB(dbPath);
			db.insertInstruction("product-lead", "exec-1", "instruction data");
			const progress = db.getUnreadProgress("exec-1");
			expect(progress).toHaveLength(0);
			db.close();
		});
	});
});
