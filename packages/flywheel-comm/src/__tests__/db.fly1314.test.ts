import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommDB } from "../db.js";

describe("FLY-1314 durable gate supersession", () => {
	let db: CommDB;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-fly1314-db-"));
		db = new CommDB(join(tmpDir, "comm.db"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("retire first atomically stamps the ship gate and rejects a late response", () => {
		const oldGate = db.insertQuestion("exec-old", "lead", "old ship gate", {
			checkpoint: "approve_to_ship",
		});
		const newGate = db.insertQuestion("exec-new", "lead", "new ship gate", {
			checkpoint: "approve_to_ship",
		});

		expect(db.retireShipGate(oldGate, { supersededBy: newGate })).toBe(true);
		expect(db.getMessageById(oldGate)).toMatchObject({
			superseded_by: newGate,
		});
		expect(db.getMessageById(oldGate)?.superseded_at).toBeTruthy();
		expect(
			db.insertResponse(oldGate, "bridge", JSON.stringify({ approved: true })),
		).toEqual({ written: false, reason: "gate_not_open" });
		expect(db.getResponse(oldGate)).toBeUndefined();
		expect(db.getPendingGatesByRunner("exec-old")).toEqual([]);
	});

	it("response first wins and the answered gate is never stamped superseded", () => {
		const oldGate = db.insertQuestion("exec-old", "lead", "old ship gate", {
			checkpoint: "approve_to_ship",
		});
		const newGate = db.insertQuestion("exec-new", "lead", "new ship gate", {
			checkpoint: "approve_to_ship",
		});

		expect(
			db.insertResponse(oldGate, "bridge", JSON.stringify({ approved: true })),
		).toEqual({ written: true });
		expect(db.retireShipGate(oldGate, { supersededBy: newGate })).toBe(false);
		expect(db.getMessageById(oldGate)).toMatchObject({
			superseded_at: null,
			superseded_by: null,
		});
		expect(db.getResponse(oldGate)?.content).toContain('"approved":true');
	});

	it("the guarded review-gate retire records the same durable disposition", () => {
		const oldGate = db.insertQuestion("exec-old", "lead", "old review", {
			checkpoint: "review_code",
		});
		const newGate = db.insertQuestion("exec-new", "lead", "new review", {
			checkpoint: "review_code",
		});

		expect(
			db.retireQuestionGuarded(oldGate, {
				expectedFromAgent: "exec-old",
				requireUnanswered: true,
				supersededBy: newGate,
			}),
		).toBe(true);
		expect(db.getMessageById(oldGate)).toMatchObject({
			superseded_by: newGate,
		});
		expect(db.getMessageById(oldGate)?.superseded_at).toBeTruthy();
	});

	it("includes founder review in the explicit supersede family", () => {
		const oldGate = db.insertQuestion(
			"exec-old",
			"lead",
			"old founder review",
			{
				checkpoint: "founder_review",
			},
		);
		const newGate = db.insertQuestion(
			"exec-new",
			"lead",
			"new founder review",
			{
				checkpoint: "founder_review",
			},
		);

		expect(db.getGatesForSupersede().map((gate) => gate.id)).toEqual([
			oldGate,
			newGate,
		]);
		expect(db.canSupersedeGate(oldGate, newGate)).toBe(true);
		expect(
			db.retireQuestionGuarded(oldGate, {
				expectedFromAgent: "exec-old",
				requireUnanswered: true,
				supersededBy: newGate,
			}),
		).toBe(true);
		expect(db.getSupersededGates().map((gate) => gate.id)).toContain(oldGate);
	});

	it("a superseded gate rejects the atomic founder-source writer without an outbox event", () => {
		const oldGate = db.insertQuestion("exec-old", "lead", "old ship gate", {
			checkpoint: "approve_to_ship",
		});
		const newGate = db.insertQuestion("exec-new", "lead", "new ship gate", {
			checkpoint: "approve_to_ship",
		});
		expect(db.retireShipGate(oldGate, { supersededBy: newGate })).toBe(true);

		expect(
			db.insertFounderApprovalResponseWithSource({
				project: "flywheel",
				sourceEventId: "founder-approval:old",
				questionId: oldGate,
				fromAgent: "bridge",
				content: JSON.stringify({ approved: true }),
				expectedOwner: "exec-old",
				payload: { approved: true },
			}),
		).toBe(false);
		expect(db.getResponse(oldGate)).toBeUndefined();
		expect(db.listWorkflowSourceEvents()).toEqual([]);
	});
});
