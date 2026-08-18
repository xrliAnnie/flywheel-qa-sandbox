/**
 * FLY-1185 §2.12 — lifecycle route contract tests (manifest v2):
 * fail-closed without apiToken, park via atomic parkFn, unpark supersede,
 * dry-run canonical hash + unowned-with-sha + includeUnowned-in-manifest,
 * apply byte-exact hash gate + git-object submission + issue-snapshot
 * drift rejection.
 */
import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import type { ClosureReport } from "../lifecycle-closeout.js";
import {
	computeIssueSnapshot,
	createLifecycleApplyRouter,
	createLifecycleRouter,
	type LifecycleRoutesDeps,
	sha256Hex,
} from "../lifecycle-routes.js";

const UUID = "0b6f9d2e-1111-4222-8333-444455556666";
const PROJECT = { projectName: "proj", projectRoot: "/tmp/proj" };

async function request(
	server: Server,
	path: string,
	body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("server not bound");
	const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return {
		status: res.status,
		body: (await res.json()) as Record<string, unknown>,
	};
}

describe("lifecycle routes (FLY-1185 §2.12, manifest v2)", () => {
	let store: StateStore;
	let server: Server;
	let parkCalls: unknown[];
	let closeoutCalls: unknown[];

	const okReport: ClosureReport = {
		outcome: "complete",
		nodes: [],
		operatorItems: [],
	} as unknown as ClosureReport;

	function makeDeps(
		over: Partial<LifecycleRoutesDeps> = {},
	): LifecycleRoutesDeps {
		return {
			store,
			projects: [PROJECT],
			worktreeManager: {} as LifecycleRoutesDeps["worktreeManager"],
			withRepoLock: async (_repo, fn) => fn(),
			parkFn: async (input) => {
				parkCalls.push(input);
				return okReport;
			},
			unparkFn: async (input) =>
				store.supersedeIssueDispositionIntent(
					input.issueUuid,
					input.supersededBy,
				),
			applySnapshotCloseoutFn: async (approved, approvedJson) => {
				closeoutCalls.push({ approved, approvedJson });
				return okReport;
			},
			apiTokenConfigured: true,
			...over,
		};
	}

	function serve(deps: LifecycleRoutesDeps): Server {
		const app = express();
		app.use(express.json({ limit: "5mb" }));
		app.use("/api/lifecycle", createLifecycleRouter(deps));
		app.use("/api/lifecycle-apply", createLifecycleApplyRouter(deps));
		server = createServer(app);
		server.listen(0);
		return server;
	}

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		parkCalls = [];
		closeoutCalls = [];
	});

	afterEach(() => {
		server?.close();
	});

	it("fail-closed: every endpoint 403s when apiToken is not configured", async () => {
		serve(makeDeps({ apiTokenConfigured: false }));
		for (const [path, body] of [
			["/api/lifecycle/land", { issueId: UUID, project: "proj" }],
			[
				"/api/lifecycle/land/land%3Aone/resume",
				{ actor: "operator", reason: "CI recovered" },
			],
			["/api/lifecycle/park", { issueUuid: UUID, project: "proj" }],
			["/api/lifecycle/unpark", { issueUuid: UUID, supersededBy: "x" }],
			["/api/lifecycle/dry-run", { project: "proj" }],
			["/api/lifecycle-apply", { manifestJson: "{}", approvedHash: "x" }],
		] as const) {
			const res = await request(server, path, body);
			expect(res.status, path).toBe(403);
		}
	});

	it("land: flag-off writes no intent; enabled path returns a stable 202 operation", async () => {
		const kick = vi.fn();
		const createIntent = vi.fn((input) =>
			store.ensureLandOperation({
				issueId: input.issueId,
				projectName: input.projectName,
				prNumber: 1375,
				approvedHead: "a".repeat(40),
				now: "2026-07-21T20:00:00.000Z",
			}),
		);
		serve(
			makeDeps({
				land: { enabled: () => false, createIntent, kick },
			}),
		);
		const disabled = await request(server, "/api/lifecycle/land", {
			issueId: UUID,
			project: "proj",
		});
		expect(disabled.status).toBe(503);
		expect(createIntent).not.toHaveBeenCalled();

		server.close();
		serve(
			makeDeps({
				land: { enabled: () => true, createIntent, kick },
			}),
		);
		const accepted = await request(server, "/api/lifecycle/land", {
			issueId: UUID,
			project: "proj",
			prNumber: 1375,
			approvedHead: "a".repeat(40),
		});
		expect(accepted.status).toBe(202);
		expect(accepted.body).toMatchObject({ state: "intent" });
		expect(kick).toHaveBeenCalledWith(accepted.body.operation_id);
	});

	it("land: an explicit kick bypasses a future retry delay without resetting its budget", async () => {
		const operation = store.ensureLandOperation({
			issueId: UUID,
			projectName: "proj",
			prNumber: 1375,
			approvedHead: "a".repeat(40),
			now: "2026-07-21T20:00:00.000Z",
		});
		const claim = store.claimLandOperation({
			operationId: operation.operation_id,
			ownerId: "land-route-test",
			now: "2026-07-21T20:00:01.000Z",
			leaseExpiresAt: "2026-07-21T20:01:01.000Z",
		});
		expect(claim).toBeDefined();
		store.releaseLandOperationWithRetryAccounting({
			operationId: operation.operation_id,
			ownerId: claim!.ownerId,
			generation: claim!.generation,
			class: "retryable",
			reason: "linear_lookup_failed_retryable",
			now: "2026-07-21T20:00:02.000Z",
		});
		expect(store.getLandOperation(operation.operation_id)).toMatchObject({
			retry_count: 1,
			next_attempt_at: "2026-07-21T20:01:02.000Z",
		});

		const kick = vi.fn();
		serve(
			makeDeps({
				land: {
					enabled: () => true,
					createIntent: () => store.getLandOperation(operation.operation_id)!,
					kick,
				},
			}),
		);
		const accepted = await request(server, "/api/lifecycle/land", {
			issueId: UUID,
			project: "proj",
		});

		expect(accepted.status).toBe(202);
		expect(store.getLandOperation(operation.operation_id)).toMatchObject({
			retry_count: 1,
			next_attempt_at: null,
		});
		expect(kick).toHaveBeenCalledWith(operation.operation_id);
	});

	it("land resume: requires audited authority fields and kicks only after an accepted resume", async () => {
		const kick = vi.fn();
		const resume = vi.fn(async () => ({
			ok: true as const,
			operation: {
				...store.ensureLandOperation({
					issueId: UUID,
					projectName: "proj",
					prNumber: 1375,
					approvedHead: "a".repeat(40),
					now: "2026-08-18T00:00:00.000Z",
				}),
				state: "partial" as const,
			},
		}));
		serve(
			makeDeps({
				land: {
					enabled: () => true,
					createIntent: vi.fn(),
					resume,
					kick,
				},
			}),
		);

		const invalid = await request(
			server,
			"/api/lifecycle/land/land%3Aone/resume",
			{ actor: "operator" },
		);
		expect(invalid.status).toBe(400);
		expect(resume).not.toHaveBeenCalled();

		const accepted = await request(
			server,
			"/api/lifecycle/land/land%3Aone/resume",
			{ actor: "operator", reason: "required CI is now green" },
		);
		expect(accepted.status).toBe(200);
		expect(accepted.body).toMatchObject({ state: "partial" });
		expect(resume).toHaveBeenCalledWith({
			operationId: "land:one",
			actor: "operator",
			reason: "required CI is now green",
		});
		expect(kick).toHaveBeenCalledWith("land:one");
	});

	it("land resume: returns a typed 409 and does not kick on refusal", async () => {
		const kick = vi.fn();
		serve(
			makeDeps({
				land: {
					enabled: () => true,
					createIntent: vi.fn(),
					resume: vi.fn(async () => ({
						ok: false as const,
						reason: "resume_refused:pr_head_mismatch",
					})),
					kick,
				},
			}),
		);
		const refused = await request(
			server,
			"/api/lifecycle/land/land%3Aone/resume",
			{ actor: "operator", reason: "retry" },
		);
		expect(refused).toEqual({
			status: 409,
			body: { error: "resume_refused:pr_head_mismatch" },
		});
		expect(kick).not.toHaveBeenCalled();
	});

	it("park: delegates to the ATOMIC parkFn (mutex-held tombstone + closeout)", async () => {
		serve(makeDeps());
		const res = await request(server, "/api/lifecycle/park", {
			issueUuid: UUID,
			project: "proj",
			founderDecisionId: "founder-msg-1",
		});
		expect(res.status).toBe(200);
		expect(res.body.parked).toBe(true);
		expect(parkCalls).toHaveLength(1);
		expect(parkCalls[0]).toMatchObject({
			issueUuid: UUID,
			projectName: "proj",
			founderDecisionId: "founder-msg-1",
		});
	});

	it("park: rejects non-UUID keys and missing fields (400, parkFn untouched)", async () => {
		serve(makeDeps());
		const bad = await request(server, "/api/lifecycle/park", {
			issueUuid: "FLY-1185",
			project: "proj",
			founderDecisionId: "d",
		});
		expect(bad.status).toBe(400);
		const missing = await request(server, "/api/lifecycle/park", {
			issueUuid: UUID,
			project: "proj",
		});
		expect(missing.status).toBe(400);
		expect(parkCalls).toHaveLength(0);
	});

	it("unpark: 404 with no active intent; supersedes an active one", async () => {
		serve(makeDeps());
		const none = await request(server, "/api/lifecycle/unpark", {
			issueUuid: UUID,
			supersededBy: "founder-msg-2",
		});
		expect(none.status).toBe(404);

		store.upsertIssueDispositionIntent({
			issueUuid: UUID,
			project: "proj",
			founderDecisionId: "founder-msg-1",
		});
		const ok = await request(server, "/api/lifecycle/unpark", {
			issueUuid: UUID,
			supersededBy: "founder-msg-2",
		});
		expect(ok.status).toBe(200);
		expect(store.getActiveIssueDispositionIntent(UUID)).toBeUndefined();
	});

	it("dry-run: canonical manifest v2 — includeUnowned INSIDE the hashed bytes, unowned entries keep their sha", async () => {
		const sweepFn = vi.fn(async () => ({
			entries: [
				{
					kind: "local_branch" as const,
					ref: "flywheel-FLY-1",
					action: "would_bundle" as const,
					expectedSha: "abc123",
				},
				{
					kind: "worktree" as const,
					ref: "/tmp/wt-unowned",
					action: "would_bundle" as const,
					reason: "unowned_requires_include_unowned",
					expectedSha: "def456",
					ownership: "unowned" as const,
				},
				{
					kind: "worktree" as const,
					ref: "/tmp/skip-no-sha",
					action: "skipped" as const,
					reason: "live_alive",
				},
			],
		}));
		serve(makeDeps({ sweepFn: sweepFn as LifecycleRoutesDeps["sweepFn"] }));
		const res = await request(server, "/api/lifecycle/dry-run", {
			project: "proj",
			includeUnowned: true,
		});
		expect(res.status).toBe(200);
		const manifestJson = res.body.manifestJson as string;
		expect(res.body.sha256).toBe(sha256Hex(manifestJson));
		const manifest = JSON.parse(manifestJson);
		expect(manifest.includeUnowned).toBe(true);
		expect(manifest.gitObjects).toHaveLength(2); // sha-bearing only
		expect(
			manifest.gitObjects.find(
				(g: { ref: string }) => g.ref === "/tmp/wt-unowned",
			),
		).toMatchObject({ expectedSha: "def456", ownership: "unowned" });
		expect(sweepFn).toHaveBeenCalledWith(
			expect.objectContaining({ dryRun: true }),
		);
		expect(sweepFn.mock.calls[0]?.[0]).not.toHaveProperty("apply");
	});

	it("apply: refuses on byte-exact hash mismatch (409) before any sweep", async () => {
		const sweepFn = vi.fn();
		serve(makeDeps({ sweepFn: sweepFn as LifecycleRoutesDeps["sweepFn"] }));
		const manifestJson = JSON.stringify({
			project: "proj",
			includeUnowned: false,
			gitObjects: [],
			issues: [],
		});
		const res = await request(server, "/api/lifecycle-apply", {
			manifestJson: `${manifestJson} `, // one trailing byte of drift
			approvedHash: sha256Hex(manifestJson),
		});
		expect(res.status).toBe(409);
		expect(res.body.error).toBe("approved_hash_mismatch");
		expect(sweepFn).not.toHaveBeenCalled();
	});

	it("apply: submits approved refs with the manifest-bound includeUnowned", async () => {
		const sweepFn = vi.fn(async () => ({
			entries: [
				{
					kind: "local_branch" as const,
					ref: "flywheel-FLY-1",
					action: "deleted" as const,
				},
			],
		}));
		serve(makeDeps({ sweepFn: sweepFn as LifecycleRoutesDeps["sweepFn"] }));
		const manifestJson = JSON.stringify({
			project: "proj",
			includeUnowned: true,
			gitObjects: [
				{ kind: "local_branch", ref: "flywheel-FLY-1", expectedSha: "abc123" },
			],
			issues: [],
		});
		const res = await request(server, "/api/lifecycle-apply", {
			manifestJson,
			approvedHash: sha256Hex(manifestJson),
		});
		expect(res.status).toBe(200);
		expect(res.body.applied).toBe(true);
		const arg = sweepFn.mock.calls[0]?.[0] as {
			apply?: { expectedByRef: Map<string, string>; includeUnowned: boolean };
		};
		expect(arg.apply?.includeUnowned).toBe(true);
		// Codex R2#7: approval identity is (kind, ref).
		expect(arg.apply?.expectedByRef.get("local_branch:flywheel-FLY-1")).toBe(
			"abc123",
		);
	});

	it("apply: issues are submitted to the LOCK-HELD snapshot executor; rejected/closed map through (Codex R2#6)", async () => {
		serve(makeDeps());
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: UUID,
			project_name: "proj",
			status: "running",
		});
		store.observeLinearStateAndClaimCloseout({
			project: "proj",
			issueUuid: UUID,
			stateType: "started",
			linearUpdatedAt: "2026-07-01T00:00:00.000Z",
		});
		store.observeLinearStateAndClaimCloseout({
			project: "proj",
			issueUuid: UUID,
			stateType: "canceled",
			linearUpdatedAt: "2026-07-02T00:00:00.000Z",
		});
		const snap = computeIssueSnapshot(store, {
			project: "proj",
			issueUuid: UUID,
		});
		expect(snap).toBeDefined();
		expect(snap?.disposition).toBe("canceled");
		expect(snap?.claims).toEqual([]); // R2#6: claims are part of the snapshot

		// (a) executor returns a report → mapped to "closed"
		const okManifest = JSON.stringify({
			project: "proj",
			includeUnowned: false,
			gitObjects: [],
			issues: [snap],
		});
		const ok = await request(server, "/api/lifecycle-apply", {
			manifestJson: okManifest,
			approvedHash: sha256Hex(okManifest),
		});
		expect(ok.status).toBe(200);
		expect(closeoutCalls).toHaveLength(1);
		expect(
			(closeoutCalls[0] as { approved: { issueUuid: string } }).approved
				.issueUuid,
		).toBe(UUID);
		expect((ok.body.issueResults as Array<{ result: string }>)[0]?.result).toBe(
			"closed",
		);

		// (b) executor rejects (lock-held drift) → mapped to "rejected"
		server.close();
		serve(
			makeDeps({
				applySnapshotCloseoutFn: async () => ({
					rejected: true,
					reason: "snapshot_drift",
				}),
			}),
		);
		const drift = await request(server, "/api/lifecycle-apply", {
			manifestJson: okManifest,
			approvedHash: sha256Hex(okManifest),
		});
		expect(drift.status).toBe(200);
		expect(
			(
				drift.body.issueResults as Array<{ result: string; reason?: string }>
			)[0],
		).toMatchObject({ result: "rejected", reason: "snapshot_drift" });
	});

	it("apply: empty manifest (no refs, no issues) is a 400", async () => {
		serve(makeDeps());
		const manifestJson = JSON.stringify({
			project: "proj",
			includeUnowned: false,
			gitObjects: [],
			issues: [],
		});
		const res = await request(server, "/api/lifecycle-apply", {
			manifestJson,
			approvedHash: sha256Hex(manifestJson),
		});
		expect(res.status).toBe(400);
		expect(res.body.error).toBe("manifest_has_no_approvable_entries");
	});

	it("apply: a sha-less git entry is a MALFORMED-entry 400 (R3#8 strict, whole batch refused)", async () => {
		serve(makeDeps());
		const manifestJson = JSON.stringify({
			project: "proj",
			includeUnowned: false,
			gitObjects: [{ kind: "worktree", ref: "/tmp/x" }], // no sha
			issues: [],
		});
		const res = await request(server, "/api/lifecycle-apply", {
			manifestJson,
			approvedHash: sha256Hex(manifestJson),
		});
		expect(res.status).toBe(400);
		expect(res.body.error).toBe("manifest_malformed_entry:worktree:/tmp/x");
	});

	it("apply: unknown project 404s; malformed manifest JSON 400s", async () => {
		serve(makeDeps());
		const other = JSON.stringify({
			project: "nope",
			includeUnowned: false,
			gitObjects: [{ kind: "local_branch", ref: "b", expectedSha: "s" }],
			issues: [],
		});
		const notFound = await request(server, "/api/lifecycle-apply", {
			manifestJson: other,
			approvedHash: sha256Hex(other),
		});
		expect(notFound.status).toBe(404);

		const notJson = "not json at all";
		const bad = await request(server, "/api/lifecycle-apply", {
			manifestJson: notJson,
			approvedHash: sha256Hex(notJson),
		});
		expect(bad.status).toBe(400);
		expect(bad.body.error).toBe("manifest_not_json");
	});
});
