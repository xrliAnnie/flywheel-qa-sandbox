import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepIssueGatesForProject } from "../issue-gate-supersede.js";

describe("FLY-1314 issue gate supersede patrol", () => {
	let db: CommDB;
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-fly1314-sweep-"));
		db = new CommDB(join(tmpDir, "comm.db"));
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("replays the FLY-1309 shape and converges to one founder-answerable gate", () => {
		const oldApprove = db.insertQuestion("impl-exec", "lead", "old ship", {
			checkpoint: "approve_to_ship",
		});
		const newApprove = db.insertQuestion("qa-exec", "lead", "new ship", {
			checkpoint: "approve_to_ship",
		});
		const oldReview = db.insertQuestion("review-old", "lead", "old review", {
			checkpoint: "review_code",
		});
		const newReview = db.insertQuestion("review-new", "lead", "new review", {
			checkpoint: "review_code",
		});
		db.insertResponse(newReview, "bridge-review", "APPROVED");

		const events: Array<{
			event_type: string;
			payload?: Record<string, unknown>;
		}> = [];
		const issueByExec = new Map([
			["impl-exec", "FLY-1309"],
			["qa-exec", "FLY-1309"],
			["review-old", "FLY-1309"],
			["review-new", "FLY-1309"],
		]);

		const result = sweepIssueGatesForProject({
			projectName: "flywheel",
			db,
			store: {
				getSession: (executionId: string) => {
					const issue_id = issueByExec.get(executionId);
					return issue_id ? { issue_id } : undefined;
				},
				getCodexReviewJobByQuestionId: () => null,
				insertEvent: (event) => {
					events.push(event);
					return true;
				},
			},
			env: {},
		});

		expect(result).toMatchObject({ candidates: 2, retired: 2, unmapped: 0 });
		expect(db.getPendingQuestions("lead").map((q) => q.id)).toEqual([
			newApprove,
		]);
		expect(db.getPendingGatesByRunner("impl-exec")).toEqual([]);
		expect(db.getMessageById(oldApprove)).toMatchObject({
			superseded_by: newApprove,
		});
		expect(db.getMessageById(oldReview)).toMatchObject({
			superseded_by: newReview,
		});
		expect(events.map((event) => event.event_type).sort()).toEqual([
			"review_gate_superseded",
			"ship_gate_superseded",
		]);
	});

	it("heals an audit-write crash without rewriting the original supersededBy cause", () => {
		const q1 = db.insertQuestion("exec-1", "lead", "review 1", {
			checkpoint: "review_code",
		});
		const q2 = db.insertQuestion("exec-2", "lead", "review 2", {
			checkpoint: "review_code",
		});
		const issueByExec = new Map([
			["exec-1", "FLY-1314"],
			["exec-2", "FLY-1314"],
			["exec-3", "FLY-1314"],
		]);
		const events = new Map<
			string,
			{ event_type: string; payload?: Record<string, unknown> }
		>();
		let failFirstOutcome = true;
		const store = {
			getSession: (executionId: string) => {
				const issue_id = issueByExec.get(executionId);
				return issue_id ? { issue_id } : undefined;
			},
			getCodexReviewJobByQuestionId: () => null,
			insertEvent: (event: {
				event_id: string;
				event_type: string;
				payload?: Record<string, unknown>;
			}) => {
				if (event.event_type === "review_gate_superseded" && failFirstOutcome) {
					failFirstOutcome = false;
					throw new Error("simulated StateStore crash");
				}
				if (events.has(event.event_id)) return false;
				events.set(event.event_id, event);
				return true;
			},
		};

		expect(() =>
			sweepIssueGatesForProject({
				projectName: "flywheel",
				db,
				store,
				env: {},
			}),
		).not.toThrow();
		expect(db.getMessageById(q1)).toMatchObject({ superseded_by: q2 });

		const q3 = db.insertQuestion("exec-3", "lead", "review 3", {
			checkpoint: "review_code",
		});
		sweepIssueGatesForProject({
			projectName: "flywheel",
			db,
			store,
			env: {},
		});

		expect(events.get(`review-gate-superseded-${q1}`)?.payload).toMatchObject({
			supersededBy: q2,
		});
		expect(db.getMessageById(q2)).toMatchObject({ superseded_by: q3 });
	});

	it("observe mode records a distinct candidate and enforce later records the outcome", () => {
		const oldGate = db.insertQuestion("exec-1", "lead", "ship 1", {
			checkpoint: "approve_to_ship",
		});
		const newGate = db.insertQuestion("exec-2", "lead", "ship 2", {
			checkpoint: "approve_to_ship",
		});
		const events = new Map<string, string>();
		const store = {
			getSession: () => ({ issue_id: "FLY-1314" }),
			getCodexReviewJobByQuestionId: () => null,
			insertEvent: (event: { event_id: string; event_type: string }) => {
				if (events.has(event.event_id)) return false;
				events.set(event.event_id, event.event_type);
				return true;
			},
		};

		const observed = sweepIssueGatesForProject({
			projectName: "flywheel",
			db,
			store,
			env: { FLYWHEEL_ISSUE_GATE_SUPERSEDE: "observe" },
		});
		expect(observed).toMatchObject({ candidates: 1, retired: 0 });
		expect(db.getMessageById(oldGate)?.superseded_at).toBeNull();
		expect(events.get(`gate-supersede-candidate-${oldGate}`)).toBe(
			"gate_supersede_candidate",
		);

		const enforced = sweepIssueGatesForProject({
			projectName: "flywheel",
			db,
			store,
			env: {},
		});
		expect(enforced).toMatchObject({ candidates: 1, retired: 1 });
		expect(db.getMessageById(oldGate)).toMatchObject({
			superseded_by: newGate,
		});
		expect(events.get(`ship-gate-superseded-${oldGate}`)).toBe(
			"ship_gate_superseded",
		);
	});

	it("bounds mutations per tick and converges across later ticks", () => {
		for (let i = 0; i < 5; i++) {
			db.insertQuestion(`exec-${i}`, "lead", `ship ${i}`, {
				checkpoint: "approve_to_ship",
			});
		}
		const store = {
			getSession: () => ({ issue_id: "FLY-1314" }),
			getCodexReviewJobByQuestionId: () => null,
			insertEvent: () => true,
		};

		expect(
			sweepIssueGatesForProject({
				projectName: "flywheel",
				db,
				store,
				env: { FLYWHEEL_ISSUE_GATE_SUPERSEDE_MAX_MUTATIONS: "2" },
			}),
		).toMatchObject({ candidates: 4, retired: 2 });
		expect(db.getPendingQuestions("lead")).toHaveLength(3);

		expect(
			sweepIssueGatesForProject({
				projectName: "flywheel",
				db,
				store,
				env: { FLYWHEEL_ISSUE_GATE_SUPERSEDE_MAX_MUTATIONS: "2" },
			}),
		).toMatchObject({ candidates: 2, retired: 2 });
		expect(db.getPendingQuestions("lead")).toHaveLength(1);
	});

	it("rechecks the target immediately before retire so a concurrent answer wins", () => {
		const oldGate = db.insertQuestion("exec-1", "lead", "ship 1", {
			checkpoint: "approve_to_ship",
		});
		db.insertQuestion("exec-2", "lead", "ship 2", {
			checkpoint: "approve_to_ship",
		});
		const realCheck = db.canSupersedeGate.bind(db);
		db.canSupersedeGate = (questionId, supersessorId) => {
			db.insertResponse(
				questionId,
				"bridge",
				JSON.stringify({ approved: true }),
			);
			return realCheck(questionId, supersessorId);
		};

		const result = sweepIssueGatesForProject({
			projectName: "flywheel",
			db,
			store: {
				getSession: () => ({ issue_id: "FLY-1314" }),
				getCodexReviewJobByQuestionId: () => null,
				insertEvent: () => true,
			},
			env: {},
		});

		expect(result).toMatchObject({ candidates: 1, retired: 0 });
		expect(db.getMessageById(oldGate)).toMatchObject({
			superseded_at: null,
			superseded_by: null,
		});
		expect(db.getResponse(oldGate)).toBeDefined();
	});

	it("leaves unmapped gates untouched and honors the patrol mode", () => {
		const oldApprove = db.insertQuestion("unknown-a", "lead", "ship 1", {
			checkpoint: "approve_to_ship",
		});
		const newApprove = db.insertQuestion("unknown-b", "lead", "ship 2", {
			checkpoint: "approve_to_ship",
		});
		const unmappedEvents: string[] = [];
		const unmapped = sweepIssueGatesForProject({
			projectName: "flywheel",
			db,
			store: {
				getSession: () => undefined,
				getCodexReviewJobByQuestionId: () => null,
				insertEvent: (event) => {
					unmappedEvents.push(event.event_type);
					return true;
				},
			},
			env: {},
		});
		expect(unmapped).toMatchObject({ retired: 0, unmapped: 2 });
		expect(db.getMessageById(oldApprove)?.superseded_at).toBeNull();
		expect(unmappedEvents).toEqual([
			"gate_supersede_unmapped",
			"gate_supersede_unmapped",
		]);

		const mappedStore = {
			getSession: () => ({ issue_id: "FLY-1314" }),
			getCodexReviewJobByQuestionId: () => null,
			insertEvent: () => true,
		};
		const oldReview = db.insertQuestion("review-a", "lead", "review 1", {
			checkpoint: "review_code",
		});
		const newReview = db.insertQuestion("review-b", "lead", "review 2", {
			checkpoint: "review_code",
		});
		expect(
			sweepIssueGatesForProject({
				projectName: "flywheel",
				db,
				store: mappedStore,
				env: { FLYWHEEL_ISSUE_GATE_SUPERSEDE: "0" },
			}),
		).toEqual({ scanned: 0, candidates: 0, retired: 0, unmapped: 0 });
		expect(
			sweepIssueGatesForProject({
				projectName: "flywheel",
				db,
				store: mappedStore,
				env: {},
			}),
		).toMatchObject({ retired: 2 });
		expect(db.getMessageById(oldApprove)).toMatchObject({
			superseded_by: newApprove,
		});
		expect(db.getMessageById(oldReview)).toMatchObject({
			superseded_by: newReview,
		});
	});
});
