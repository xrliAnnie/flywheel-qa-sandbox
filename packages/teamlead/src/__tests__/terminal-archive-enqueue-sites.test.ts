/**
 * FLY-1282 Part C (M9): terminal-archive enqueue sites — both sinks.
 *
 * Contract: a completion that durably lands `completed` enqueues its issue
 * for the archive-only targeted check EXACTLY once; FSM-rejected / duplicate
 * terminals, non-terminal completions (needs_review → awaiting_review) and
 * FLY-208 evidence-gap completions enqueue ZERO times. Absent enqueue hook =
 * byte-compat (switch OFF ⇒ the composition root injects nothing).
 *
 * The post-ship (merged) exclusion is set inside the same
 * isPostApproveShipComplete-gated block that fires runPostShipFinalization
 * (covered by the FLY-102 suites) — its enqueue-exclusion flag lives on the
 * exact branch those tests pin, so it is not re-driven end-to-end here.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import type { EventEnvelope } from "flywheel-edge-worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import * as headAuthority from "../bridge/head-authority.js";
import * as shipGate from "../bridge/merge-ship-gate.js";
import { createBridgeApp } from "../bridge/plugin.js";
import * as finalization from "../bridge/post-ship-finalization.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectEventSink } from "../DirectEventSink.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import {
	insertHistoricalAutoQaRecord,
	setHistoricalQaRequiredSnapshot,
} from "./helpers/historical-qa.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geoforge3d",
		projectRepo: "xrliAnnie/GeoForge3D",
		leads: [
			{
				agentId: "product-lead",
				chatChannel: "test-chat",
				match: { labels: ["Product"] },
			},
		],
	},
] as unknown as ProjectEntry[];

describe("FLY-2377 post-ship immediate archive wiring", () => {
	it("removes quiet retry wiring from all finalization entries but keeps the non-ship buffer", () => {
		const source = (path: string) =>
			readFileSync(new URL(path, import.meta.url), "utf8");
		const count = (text: string, needle: string) =>
			text.split(needle).length - 1;

		expect(
			count(
				source("../DirectEventSink.ts"),
				"enqueueTerminalArchive: this.terminalArchiveEnqueue",
			),
		).toBe(0);
		expect(
			count(
				source("../bridge/event-route.ts"),
				"enqueueTerminalArchive: terminalArchiveEnqueue",
			),
		).toBe(0);
		expect(
			count(
				source("../bridge/merge-ship-gate.ts"),
				"enqueueTerminalArchive: terminalArchiveEnqueue",
			),
		).toBe(0);
		expect(
			count(
				source("../bridge/external-merge-reconcile.ts"),
				"enqueueTerminalArchive: deps.terminalArchiveEnqueue",
			),
		).toBe(0);
		expect(
			count(
				source("../bridge/plugin.ts"),
				"enqueueTerminalArchive: terminalArchiveEnqueue",
			),
		).toBe(0);
		expect(source("../bridge/actions.ts")).not.toContain(
			"terminalArchiveEnqueue",
		);
		expect(source("../bridge/founder-consent/wiring.ts")).not.toContain(
			"terminalArchiveEnqueue",
		);
		expect(source("../bridge/plugin.ts")).toContain(
			"terminalArchiveBuffer.enqueue(issueId)",
		);
	});
});

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		...overrides,
	};
}

describe("DirectEventSink enqueue site", () => {
	let store: StateStore;
	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});
	afterEach(() => {
		store.close();
	});

	function makeEnvelope(over: Partial<EventEnvelope> = {}): EventEnvelope {
		return {
			executionId: "exec-1",
			issueId: "issue-1",
			projectName: "geoforge3d",
			issueIdentifier: "GEO-100",
			issueTitle: "Test issue",
			...over,
		};
	}

	function makeResult(over: Record<string, unknown> = {}) {
		return {
			success: true,
			decision: { route: "no_code", reasoning: "test" },
			evidence: {
				commitCount: 0,
				filesChangedCount: 0,
				commitMessages: [],
				changedFilePaths: [],
				linesAdded: 0,
				linesRemoved: 0,
				diffSummary: "",
				headSha: null,
				partial: false,
				durationMs: 10,
			},
			...over,
		} as any;
	}

	it("a completion that lands completed enqueues the issue exactly once", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
		});
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		const enqueue = vi.fn();
		sink.terminalArchiveEnqueue = enqueue;
		await sink.emitCompleted(makeEnvelope(), makeResult());
		expect(store.getSession("exec-1")?.status).toBe("completed");
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenCalledWith("issue-1");
	});

	it("non-terminal completion (needs_review → awaiting_review) enqueues nothing", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
		});
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		const enqueue = vi.fn();
		sink.terminalArchiveEnqueue = enqueue;
		await sink.emitCompleted(
			makeEnvelope(),
			makeResult({ decision: { route: "needs_review", reasoning: "t" } }),
		);
		expect(store.getSession("exec-1")?.status).toBe("awaiting_review");
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("FLY-208 evidence-gap completion (approved_to_ship + unmerged landing) enqueues nothing", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "approved_to_ship",
		});
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		const enqueue = vi.fn();
		sink.terminalArchiveEnqueue = enqueue;
		await sink.emitCompleted(
			makeEnvelope(),
			makeResult({
				decision: { route: "auto_approve", reasoning: "t" },
				evidence: {
					landingStatus: { status: "ready_to_merge" },
				},
			}),
		);
		const session = store.getSession("exec-1");
		expect(session?.status).toBe("completed");
		expect(session?.session_params ?? "").toContain("fly208_evidence_gap");
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("absent enqueue hook = byte-compat (no throw, nothing extra)", async () => {
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "running",
		});
		const sink = new DirectEventSink(store, makeConfig(), testProjects);
		await expect(
			sink.emitCompleted(makeEnvelope(), makeResult()),
		).resolves.toBeUndefined();
	});
});

describe("event-route enqueue site (HTTP /events)", () => {
	let store: StateStore;
	let tempRoot: string;
	let server: http.Server;
	let baseUrl: string;
	let enqueue: ReturnType<typeof vi.fn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	const ingestHeaders = {
		"Content-Type": "application/json",
		Authorization: "Bearer ingest-secret",
	};

	beforeEach(async () => {
		tempRoot = mkdtempSync(join(tmpdir(), "fly1956-terminal-"));
		vi.stubEnv("FLYWHEEL_COMM_DIR", join(tempRoot, "comm"));
		store = await StateStore.create(join(tempRoot, "teamlead.db"));
		const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		const executor = new DirectiveExecutor(store);
		const transitionOpts: ApplyTransitionOpts = { store, fsm, executor };
		enqueue = vi.fn();
		const app = createBridgeApp(
			store,
			testProjects,
			makeConfig(),
			undefined,
			transitionOpts,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ terminalArchiveEnqueue: enqueue },
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
		vi.unstubAllEnvs();
		rmSync(tempRoot, { recursive: true, force: true });
		warnSpy.mockRestore();
		errorSpy.mockRestore();
	});

	async function post(body: Record<string, unknown>) {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: ingestHeaders,
			body: JSON.stringify(body),
		});
		expect(res.status).toBe(200);
		return res;
	}

	async function startRunning(executionId: string, issueId: string) {
		await post({
			event_id: `evt-start-${executionId}`,
			execution_id: executionId,
			issue_id: issueId,
			project_name: "geoforge3d",
			event_type: "session_started",
			payload: { issueIdentifier: "GEO-100", issueTitle: "t" },
		});
	}

	it("acknowledges an out-of-order completed stage as superseded without finalizing", async () => {
		await startRunning("exec-1", "issue-1");
		store.persistTransition("exec-1", "failed", {
			issue_id: "issue-1",
			project_name: "geoforge3d",
			decision_route: "needs_review",
			pr_head_sha: "a".repeat(40),
		});
		const eligibility = vi
			.spyOn(shipGate, "computeAuthoritativeShipDecision")
			.mockResolvedValue({ eligible: true } as Awaited<
				ReturnType<typeof shipGate.computeAuthoritativeShipDecision>
			>);
		const resume = vi
			.spyOn(finalization, "runResumablePostShipFinalization")
			.mockResolvedValue({ complete: true, outcome: "completed", details: {} });
		try {
			const event = {
				event_id: "obsolete-completed",
				execution_id: "exec-1",
				issue_id: "issue-1",
				project_name: "geoforge3d",
				event_type: "stage_changed",
				payload: {
					stage: "completed",
					landing_status: { status: "merged", prNumber: 42 },
				},
			};
			for (let attempt = 0; attempt < 2; attempt++) {
				expect(await (await post(event)).json()).toMatchObject({
					ok: true,
					superseded: true,
					applied: true,
				});
				expect(store.getSession("exec-1")?.status).toBe("failed");
			}
			expect(resume).not.toHaveBeenCalled();
			expect(enqueue).not.toHaveBeenCalled();
		} finally {
			eligibility.mockRestore();
			resume.mockRestore();
		}
	});

	it.each(["valid", "unbound", "head-drift"] as const)(
		"revalidates real approval for partial post-ship replay: %s",
		async (binding) => {
			await startRunning("exec-1", "issue-1");
			store.upsertSession({
				execution_id: "exec-1",
				issue_id: "issue-1",
				project_name: "geoforge3d",
				status: "approved_to_ship",
				decision_route: "needs_review",
				pr_head_sha: "a".repeat(40),
			});
			mkdirSync(join(tempRoot, "comm", "geoforge3d"), { recursive: true });
			const comm = new CommDB(join(tempRoot, "comm", "geoforge3d", "comm.db"));
			const questionId = comm.insertQuestion("exec-1", "product-lead", "Ship", {
				checkpoint: "approve_to_ship",
			});
			comm.insertResponse(
				questionId,
				"bridge",
				JSON.stringify({ approved: true }),
			);
			comm.close();
			store.setReviewBinding("exec-1", {
				questionId,
				prHeadSha: "a".repeat(40),
			});
			store.upsertSession({
				execution_id: "exec-1",
				issue_id: "issue-1",
				project_name: "geoforge3d",
				status: "approved_to_ship",
				pr_number: 42,
			});
			setHistoricalQaRequiredSnapshot(store, {
				executionId: "exec-1",
				required: 1,
				reason: "test",
			});
			insertHistoricalAutoQaRecord(store, {
				parentExecutionId: "exec-1",
				targetPrHeadSha: "a".repeat(40),
				issueId: "issue-1",
				projectName: "geoforge3d",
				status: "passed",
			});
			store.recordCodexReviewApproved({
				executionId: "exec-1",
				targetPrHeadSha: "a".repeat(40),
				issueId: "issue-1",
				projectName: "geoforge3d",
			});
			const authority = vi
				.spyOn(headAuthority, "resolveWorkflowHeadAuthority")
				.mockResolvedValue({ prHeadSha: "a".repeat(40) } as Awaited<
					ReturnType<typeof headAuthority.resolveWorkflowHeadAuthority>
				>);
			const legacy = vi
				.spyOn(finalization, "runPostShipFinalization")
				.mockResolvedValue(undefined);
			const resume = vi
				.spyOn(finalization, "runResumablePostShipFinalization")
				.mockResolvedValueOnce({
					complete: false,
					outcome: "partial",
					details: {},
				})
				.mockResolvedValue({
					complete: true,
					outcome: "completed",
					details: {},
				});
			try {
				const event = {
					event_id: "merged-stage-retry",
					execution_id: "exec-1",
					issue_id: "issue-1",
					project_name: "geoforge3d",
					event_type: "stage_changed",
					payload: {
						stage: "completed",
						landing_status: { status: "merged", prNumber: 42 },
					},
				};
				expect(await (await post(event)).json()).toMatchObject({
					ok: true,
					applied: false,
					pending: ["completed_w2"],
				});
				expect(store.getSession("exec-1")?.status).toBe("completed");
				if (binding !== "valid") {
					store.setReviewBinding("exec-1", {
						questionId: binding === "unbound" ? null : questionId,
						prHeadSha:
							binding === "head-drift" ? "b".repeat(40) : "a".repeat(40),
					});
					expect(await (await post(event)).json()).toMatchObject({
						ok: true,
						duplicate: true,
						applied: false,
						pending: ["completed_w2"],
					});
					expect(resume).toHaveBeenCalledTimes(1);
					return;
				}
				expect(await (await post(event)).json()).toMatchObject({
					ok: true,
					duplicate: true,
					applied: true,
				});
				expect(resume).toHaveBeenCalledTimes(2);
				expect(legacy).not.toHaveBeenCalled();
				expect(enqueue).not.toHaveBeenCalled();
			} finally {
				authority.mockRestore();
				legacy.mockRestore();
				resume.mockRestore();
			}
		},
	);

	it("retries stage completion archive admission after the terminal transition already committed", async () => {
		await startRunning("exec-1", "issue-1");
		const event = {
			event_id: "stage-completion-retry",
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			event_type: "stage_changed",
			payload: { stage: "completed" },
		};
		enqueue
			.mockImplementationOnce(() => {
				throw new Error("archive unavailable");
			})
			.mockReturnValue("deduped");
		expect(await (await post(event)).json()).toMatchObject({
			ok: true,
			applied: false,
			pending: ["terminal_archive"],
		});
		expect(store.getSession("exec-1")?.status).toBe("completed");
		expect(await (await post(event)).json()).toMatchObject({
			ok: true,
			duplicate: true,
			applied: true,
		});
		expect(enqueue).toHaveBeenCalledTimes(2);
	});

	it("session_completed main transition → exactly one enqueue; a duplicate terminal adds zero", async () => {
		await startRunning("exec-1", "issue-1");
		await post({
			event_id: "evt-done-1",
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			event_type: "session_completed",
			// no_code is the running-only terminal that maps straight to
			// completed (auto_approve maps to awaiting_review since GEO-155).
			payload: { decision: { route: "no_code", reasoning: "t" } },
		});
		expect(store.getSession("exec-1")?.status).toBe("completed");
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenCalledWith("issue-1");
		// Duplicate terminal: a no_code re-emission for a non-running session
		// skips the status write entirely → zero new enqueue.
		await post({
			event_id: "evt-done-2",
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "no_code", reasoning: "t" } },
		});
		expect(enqueue).toHaveBeenCalledTimes(1);
	});

	it("needs_review completion (awaiting_review) enqueues nothing", async () => {
		await startRunning("exec-2", "issue-2");
		await post({
			event_id: "evt-done-3",
			execution_id: "exec-2",
			issue_id: "issue-2",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "needs_review", reasoning: "t" } },
		});
		expect(store.getSession("exec-2")?.status).toBe("awaiting_review");
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("invalid route (skipped write) enqueues nothing", async () => {
		await startRunning("exec-3", "issue-3");
		await post({
			event_id: "evt-done-4",
			execution_id: "exec-3",
			issue_id: "issue-3",
			project_name: "geoforge3d",
			event_type: "session_completed",
			payload: { decision: { route: "garbage", reasoning: "t" } },
		});
		expect(store.getSession("exec-3")?.status).toBe("running");
		expect(enqueue).not.toHaveBeenCalled();
	});
});
