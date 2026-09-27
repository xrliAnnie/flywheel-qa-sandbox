import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../../workflow-run-snapshot.js";
import { resolveCodexPreSpawnSource } from "../codex-pre-spawn-source.js";

const roots: string[] = [];
const stores: StateStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

async function makeStore(
	suffix: string,
	options: { message?: string; terminalAt?: string; typed?: boolean } = {},
) {
	const root = mkdtempSync(join(tmpdir(), `fly2778-source-${suffix}-`));
	roots.push(root);
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "generic.md"), "Execute safely.\n");
	const store = await StateStore.create(":memory:");
	stores.push(store);
	const executionId = `exec-${suffix}`;
	const runId = `run-${suffix}`;
	const activationId = `activation-${suffix}`;
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: `tpl-${suffix}`, revision: 1 },
		canonicalRoot: root,
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "implement",
					type: "generic",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "low",
					agent_file: "agents/generic.md",
				},
				{ id: "founder_gate", type: "gate" },
			],
			edges: [
				{
					id: "done",
					from: "implement",
					to: "founder_gate",
					condition: "node_done",
				},
			],
			loops: [],
			terminal_gate: { node: "founder_gate", predicate: "founder_approved" },
			ship_claims: ["founder_approved"],
		},
	});
	store.createWorkflowRun({
		runId,
		issueId: "FLY-2778",
		projectName: "flywheel",
		snapshotJson: JSON.stringify(snapshot),
		claimsReadEnrolled: false,
	});
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId,
			nodeId: "implement",
			executionId,
			activationId,
			attempt: 1,
			now: "2026-09-18T20:00:00.000Z",
			expiresAt: "2026-09-18T21:00:00.000Z",
			absoluteDeadlineAt: "2026-09-19T20:00:00.000Z",
			env: {
				FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
				FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
				FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
				FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
			},
		}),
	).toMatchObject({ ok: true });
	store.upsertSession({
		execution_id: executionId,
		issue_id: "FLY-2778",
		project_name: "flywheel",
		status: "running",
		adapter_type: "codex-tmux",
		workflow_node_id: "implement",
	});
	store.insertLaunchClaim({
		executionId,
		rootUuid: "FLY-2778",
		project: "flywheel",
		role: "implement",
	});
	store.setLaunchClaimState(executionId, "closed");
	const terminalAt =
		options.terminalAt ?? new Date(Date.now() - 120_000).toISOString();
	const eventId = `terminal-${suffix}`;
	expect(
		store.recordEnrolledTerminalSignal({
			executionId,
			sourceEventId: eventId,
			signal: "failed",
			...(options.typed
				? {
						failureKind: "codex_auth_pre_spawn_failed",
						failureCode: "auth_preflight_failed",
						trustedPreSpawnFailure: {
							activationId,
							failureCode: "auth_preflight_failed" as const,
						},
					}
				: {}),
			lastError:
				options.message ??
				`Codex source auth is unavailable at /tmp/${suffix}/auth.json: ENOENT`,
			source: "direct-event-sink",
			now: terminalAt,
		}),
	).toMatchObject({ ok: true });
	const raw = (
		store as unknown as {
			db: {
				raw: { prepare(sql: string): { run(...args: unknown[]): unknown } };
			};
		}
	).db.raw;
	raw
		.prepare("UPDATE session_events SET ts = ? WHERE event_id = ?")
		.run(terminalAt.replace("T", " ").replace("Z", ""), eventId);
	return { store, executionId, runId, activationId, terminalAt };
}

describe("FLY-2778 trusted Codex pre-spawn source", () => {
	it("validates the live internal receipt without making a body verdict", async () => {
		const { store, executionId, runId } = await makeStore("live", {
			typed: true,
			message: "safe diagnostic",
		});

		expect(
			resolveCodexPreSpawnSource(store, executionId, "flywheel"),
		).toMatchObject({
			status: "valid",
			source: {
				executionId,
				executionRunId: runId,
				origin: "live_preflight",
				failureCode: "auth_preflight_failed",
			},
		});
	});

	it("keeps a legacy source read-only during dry-run, then materializes it by snapshot CAS", async () => {
		const { store, executionId } = await makeStore("legacy");

		expect(
			resolveCodexPreSpawnSource(store, executionId, "flywheel", {
				dryRun: true,
			}),
		).toMatchObject({
			status: "candidate",
			origin: "legacy_compat",
			failureCode: "source_auth_unavailable",
		});
		expect(store.getCodexPreSpawnFailureReceipt(executionId)).toBeUndefined();

		expect(
			resolveCodexPreSpawnSource(store, executionId, "flywheel"),
		).toMatchObject({
			status: "valid",
			source: { origin: "legacy_compat" },
		});
		expect(store.getCodexPreSpawnFailureReceipt(executionId)).toMatchObject({
			origin: "legacy_compat",
		});
	});

	it.each([
		["ordinary failure", { message: "Child stdio stream timed out" }],
		[
			"post-cutoff legacy failure",
			{ terminalAt: new Date(Date.now() + 60_000).toISOString() },
		],
	] as const)("rejects %s as a trusted source", async (suffix, options) => {
		const { store, executionId } = await makeStore(
			suffix.replaceAll(" ", "-"),
			options,
		);

		expect(resolveCodexPreSpawnSource(store, executionId, "flywheel")).toEqual({
			status: "ineligible",
			reason: "terminal_source_ineligible",
		});
		expect(store.getCodexPreSpawnFailureReceipt(executionId)).toBeUndefined();
	});

	it("rejects legacy receipt materialization after the source snapshot drifts", async () => {
		const { store, executionId, terminalAt } = await makeStore("drift");
		const snapshot = store.getCodexPreSpawnSourceSnapshot(executionId);
		store.upsertSession({
			execution_id: executionId,
			issue_id: "FLY-2778",
			project_name: "flywheel",
			status: "blocked",
			adapter_type: "codex-tmux",
			workflow_node_id: "implement",
		});

		expect(
			store.recordLegacyCodexPreSpawnFailureReceipt({
				executionId,
				expectedSnapshotDigest: snapshot.snapshotDigest,
				failureCode: "source_auth_unavailable",
				terminalAt,
				now: new Date().toISOString(),
			}),
		).toEqual({ ok: false, reason: "proof_snapshot_changed" });
		expect(store.getCodexPreSpawnFailureReceipt(executionId)).toBeUndefined();
	});
});
