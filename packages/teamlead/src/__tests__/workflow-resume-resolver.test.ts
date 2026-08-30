import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSubmissionDigest } from "flywheel-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWorkflowResumeTarget } from "../bridge/workflow-resume-resolver.js";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";
import { legacyGenericManifest } from "./fixtures/legacy-workflow-manifests.js";
import { installWorkflowAgentFiles } from "./fixtures/workflow-agent-project.js";

const roots: string[] = [];
const at = "2026-08-15T00:00:00.000Z";
const anchor = "a".repeat(40);
const issueBody = "Pinned issue body";
const issueDigest = createHash("sha256").update(issueBody).digest("hex");

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

async function seedTarget(
	kind: "execution" | "gate",
	options: { receiptDigest?: string } = {},
) {
	const root = mkdtempSync(join(tmpdir(), "workflow-resume-resolver-"));
	roots.push(root);
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "generic.md"), "Execute safely.\n");
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: "tpl-resume", revision: 1 },
		canonicalRoot: root,
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "execute",
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
					from: "execute",
					to: "founder_gate",
					condition: "node_done",
				},
			],
			loops: [],
			terminal_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			ship_claims: ["founder_approved"],
		},
	});
	const store = await StateStore.create(":memory:");
	store.createWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1707",
		projectName: "flywheel",
		snapshotJson: JSON.stringify(snapshot),
		claimsReadEnrolled: true,
	});
	const db = (
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db;
	const targetNodeId = kind === "gate" ? "founder_gate" : "execute";
	const executionId = kind === "gate" ? null : "exec-1";
	db.run(
		"UPDATE workflow_run SET engine_owned = 1, current_node_id = ? WHERE run_id = 'run-1'",
		[targetNodeId],
	);
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: targetNodeId,
		attempt: 1,
		state: kind === "gate" ? "review" : "running",
		...(executionId ? { executionId } : {}),
	});
	store.appendWorkflowRunEvent({
		runId: "run-1",
		eventUid: "issue_input_baseline:run-1",
		kind: "issue_input_baseline",
		payload: {
			outcome: "authoritative",
			updatedAt: at,
			bodyDigest: issueDigest,
		},
	});
	const transitionUid = kind === "gate" ? "edge:gate" : "start:execute";
	const receipt =
		kind === "gate"
			? {
					edgeId: "done",
					targetNodeId,
					targetAttempt: 1,
					sourceAttempt: 1,
					outcome: "node_done",
					gateOpened: true,
				}
			: {
					targetNodeId,
					targetAttempt: 1,
					executionId,
					startReservationKey: "start-key",
					snapshotDigest: snapshot.snapshot_digest,
				};
	store.appendWorkflowRunEvent({
		runId: "run-1",
		eventUid: transitionUid,
		kind: kind === "gate" ? "edge_traversed" : "start_reservation",
		nodeId: kind === "gate" ? "execute" : targetNodeId,
		executionId: kind === "gate" ? "source-exec" : executionId!,
		payload: receipt,
	});
	const target = snapshot.resolved.nodes.find(
		(node) => node.id === targetNodeId,
	)!;
	const runtimeDigest =
		kind === "gate"
			? canonicalSubmissionDigest({
					type: target.type,
					capabilities: target.capabilities,
				})
			: canonicalSubmissionDigest({
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "low",
					resolvedFamily: "codex",
					capabilitiesDigest: canonicalSubmissionDigest(target.capabilities),
				});
	db.run(
		`INSERT INTO workflow_resume_attachment
		   (attachment_id, run_id, target_node_id, target_attempt, transition_uid,
		    receipt_kind, receipt_digest, carrier_kind, anchor_ref, anchor_commit,
		    repo_identity, snapshot_digest, resolved_node_digest,
		    runtime_semantics_digest, rework_authority_digest, envelope_json, created_at)
		 VALUES ('attachment-1', 'run-1', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
		         'none', ?, ?)`,
		[
			targetNodeId,
			transitionUid,
			kind === "gate" ? "edge_traversed" : "start_reservation",
			options.receiptDigest ?? canonicalSubmissionDigest(receipt),
			kind === "gate" ? "state_only_checkpoint" : "git_checkpoint",
			kind === "gate" ? null : "refs/flywheel/checkpoints/run-1/attachment-1",
			kind === "gate" ? null : anchor,
			kind === "gate" ? null : "flywheel",
			snapshot.snapshot_digest,
			canonicalSubmissionDigest(target),
			kind === "gate" ? runtimeDigest : null,
			JSON.stringify({
				schemaVersion: 1,
				issueBaselineUid: "issue_input_baseline:run-1",
			}),
			at,
		],
	);
	db.run(
		`INSERT INTO workflow_resume_attachment_state
		   (attachment_id, state, store_locator, envelope_stamped_json,
		    runtime_semantics_stamped, updated_at)
		 VALUES ('attachment-1', 'ready', ?, ?, ?, ?)`,
		[
			kind === "gate" ? null : "{}",
			JSON.stringify({
				schemaVersion: 1,
				issueBaseline: {
					uid: "issue_input_baseline:run-1",
					updatedAt: at,
					bodyDigest: issueDigest,
				},
			}),
			kind === "gate" ? null : runtimeDigest,
			at,
		],
	);
	if (kind === "gate") {
		db.run(
			`INSERT INTO workflow_gate_holder
			   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
			    question_id, state, materialization_stage, created_at, updated_at)
			 VALUES ('run-1', 'founder_gate', 1, ?, 'source-exec', 'question-1',
			         'awaiting_review', 'completed', ?, ?)`,
			[anchor, at, at],
		);
		store.appendWorkflowRunEvent({
			runId: "run-1",
			eventUid: "gate_holder:question-1",
			kind: "gate_holder_created",
			nodeId: "founder_gate",
			executionId: "source-exec",
			payload: { attempt: 1, questionId: "question-1", head: anchor },
		});
	} else {
		db.run(
			`INSERT INTO workflow_actor
			   (execution_id, project_name, issue_id, role, created_at)
			 VALUES ('exec-1', 'flywheel', 'FLY-1707', 'execute', ?)`,
			[at],
		);
		db.run(
			`INSERT INTO workflow_execution_runtime
			   (execution_id, run_id, node_id, attempt, vendor, model, effort,
			    resolved_family, capabilities_digest, created_at)
			 VALUES ('exec-1', 'run-1', 'execute', 1, 'codex', 'gpt-5.6-sol', 'low',
			         'codex', ?, ?)`,
			[canonicalSubmissionDigest(target.capabilities), at],
		);
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-1707",
			project_name: "flywheel",
			status: "failed",
		});
		store.appendWorkflowRunEvent({
			runId: "run-1",
			eventUid: "issue_delivery:exec-1:1:0",
			kind: "issue_delivery",
			nodeId: "execute",
			executionId: "exec-1",
			payload: {
				activationId: "activation-1",
				sourceKind: "authoritative",
				body: issueBody,
				bodyDigest: issueDigest,
				ownerGeneration: 1,
				deliveryAttempt: 0,
				preparedEventUid: "issue_delivery_prepared:exec-1:1:0",
			},
		});
	}
	return { db, store, targetNodeId, runtimeDigest };
}

async function seedGateTargetFromWriter(writer: "legacy" | "carrier") {
	const root = mkdtempSync(join(tmpdir(), "workflow-resume-gate-writer-"));
	roots.push(root);
	installWorkflowAgentFiles(root);
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: "tpl-gate-writer", revision: 1 },
		canonicalRoot: root,
		manifest: legacyGenericManifest(),
	});
	const store = await StateStore.create(":memory:");
	store.createWorkflowRun({
		runId: "run-gate-writer",
		issueId: "FLY-1707",
		projectName: "flywheel",
		snapshotJson: JSON.stringify(snapshot),
		claimsReadEnrolled: true,
	});
	const db = (
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db;
	db.run(
		`UPDATE workflow_run
		    SET engine_owned = 1, current_node_id = 'execute', gate_carrier_epoch = ?
		  WHERE run_id = 'run-gate-writer'`,
		[writer === "carrier" ? 1 : 0],
	);
	store.upsertWorkflowRunNode({
		runId: "run-gate-writer",
		nodeId: "execute",
		attempt: 1,
		state: "running",
		executionId: "source-exec",
	});
	db.run(
		`INSERT INTO workflow_node_pr_binding
		   (run_id, node_id, attempt, pr_number, head_sha, target_repo_identity,
		    probe_repo_slug, target_repo_path, worktree_binding_generation,
		    receipt_id, bound_at)
		 VALUES ('run-gate-writer', 'execute', 1, 1707, ?, '__main__',
		         'xrliAnnie/flywheel', '/tmp/flywheel', 'generation-1',
		         'gate-writer-pr-binding', ?)`,
		[anchor, at],
	);
	store.appendWorkflowRunEvent({
		runId: "run-gate-writer",
		eventUid: "issue_input_baseline:run-gate-writer",
		kind: "issue_input_baseline",
		payload: {
			outcome: "authoritative",
			updatedAt: at,
			bodyDigest: issueDigest,
		},
	});
	const transition = store.commitWorkflowTransitionTx({
		runId: "run-gate-writer",
		nodeId: "execute",
		attempt: 1,
		executionId: "source-exec",
		outcome: "node_done",
		subjectDigest: anchor,
		now: at,
	});
	if (!transition.ok) throw new Error(transition.reason);
	expect(transition).toMatchObject({ ok: true, targetNodeId: "founder_gate" });
	const attachment = store
		.listWorkflowResumeAttachments({ runId: "run-gate-writer" })
		.at(-1)!;
	const holder = store.getCurrentWorkflowGateHolder(
		"run-gate-writer",
		"founder_gate",
	)!;
	db.run(
		`UPDATE workflow_resume_attachment_state
		    SET state = 'ready', envelope_stamped_json = ?,
		        runtime_semantics_stamped = ?, updated_at = ?
		  WHERE attachment_id = ?`,
		[
			JSON.stringify({
				schemaVersion: 1,
				issueBaseline: {
					uid: "issue_input_baseline:run-gate-writer",
					updatedAt: at,
					bodyDigest: issueDigest,
				},
			}),
			attachment.runtime_semantics_digest,
			at,
			attachment.attachment_id,
		],
	);
	db.run(
		`UPDATE workflow_gate_holder
		    SET state = 'awaiting_review', materialization_stage = 'completed'
		  WHERE question_id = ?`,
		[holder.question_id],
	);
	return { store, holder };
}

async function seedUnlaunchedWriterReplacement() {
	const seeded = await seedTarget("execution");
	seeded.db.run(
		`INSERT INTO workflow_side_effect_ledger
		   (run_id, node_id, attempt, kind, launch_ordinal, execution_id, state)
		 VALUES ('run-1', 'execute', 1, 'dispatch', 1, 'exec-1', 'started')`,
	);
	expect(
		seeded.store.rollbackDeadWorkflowNodeExecution({
			runId: "run-1",
			nodeId: "execute",
			attempt: 1,
			deadExecutionId: "exec-1",
			newExecutionId: "exec-replacement",
			reason: "terminal_session_and_dead_probe",
			livenessEvidence: { liveness: "dead", observedAt: at },
			now: at,
		}),
	).toMatchObject({ ok: true, launchOrdinal: 2 });
	return seeded;
}

describe("resolveWorkflowResumeTarget", () => {
	it("proposes a ready executable target with exact delivery and terminal writer evidence", async () => {
		const { store } = await seedTarget("execution");
		const eventReads = vi.spyOn(store, "listWorkflowRunEvents");
		expect(
			resolveWorkflowResumeTarget(store, {
				runId: "run-1",
				envelopeObservation: { source: "issue_body", digest: issueDigest },
				verifyAnchor: () => true,
				env: {},
			}),
		).toMatchObject({
			ok: true,
			targetNodeId: "execute",
			targetAttempt: 1,
			attachmentId: "attachment-1",
			actionKind: "redispatch_execution",
			effectiveAnchor: anchor,
		});
		expect(eventReads).toHaveBeenCalledTimes(1);
		store.close();
	});

	it("proposes a ready gate only with its exact current holder receipt", async () => {
		const { store } = await seedTarget("gate");
		expect(
			resolveWorkflowResumeTarget(store, {
				runId: "run-1",
				envelopeObservation: { source: "issue_body", digest: issueDigest },
				verifyAnchor: () => true,
				env: {},
			}),
		).toMatchObject({
			ok: true,
			targetNodeId: "founder_gate",
			targetAttempt: 1,
			attachmentId: "attachment-1",
			actionKind: "reconcile_state_only",
		});
		store.close();
	});

	it.each(["legacy", "carrier"] as const)(
		"accepts the real %s gate-holder receipt writer",
		async (writer) => {
			const { store, holder } = await seedGateTargetFromWriter(writer);
			const receipt = store
				.listWorkflowRunEvents("run-gate-writer")
				.find(
					(event) => event.event_uid === `gate_holder:${holder.question_id}`,
				);
			expect(receipt?.payload).toMatchObject(
				writer === "legacy"
					? { head: anchor }
					: { subjectKind: "git_head", subjectDigest: anchor },
			);
			expect(
				resolveWorkflowResumeTarget(store, {
					runId: "run-gate-writer",
					envelopeObservation: {
						source: "issue_body",
						digest: issueDigest,
					},
					verifyAnchor: () => true,
					env: {},
				}),
			).toMatchObject({
				ok: true,
				targetNodeId: "founder_gate",
				actionKind: "reconcile_state_only",
			});
			store.close();
		},
	);

	it("resolves and admits an unlaunched writer replacement through migrated evidence", async () => {
		const { store, runtimeDigest } = await seedUnlaunchedWriterReplacement();
		const migratedEvents = store.listWorkflowRunEvents("run-1");
		expect(
			migratedEvents.find(
				(event) =>
					event.kind === "resume_writer_binding" &&
					event.execution_id === "exec-replacement",
			),
		).toBeDefined();
		expect(
			migratedEvents.find(
				(event) =>
					event.kind === "issue_delivery" &&
					event.execution_id === "exec-replacement",
			)?.payload,
		).toMatchObject({
			sourceKind: "writer_migration",
			bodyDigest: issueDigest,
		});

		const resolution = resolveWorkflowResumeTarget(store, {
			runId: "run-1",
			envelopeObservation: { source: "issue_body", digest: issueDigest },
			verifyAnchor: () => true,
			env: {},
		});
		expect(resolution).toMatchObject({
			ok: true,
			targetNodeId: "execute",
			targetAttempt: 1,
			actionKind: "redispatch_execution",
		});
		if (!resolution.ok) throw new Error(resolution.reason);
		expect(
			store.admitWorkflowResume({
				admissionKey: "resume-after-sweep",
				admissionDigest: "f".repeat(64),
				runId: "run-1",
				actionKind: "redispatch_execution",
				sourceAttachmentId: resolution.attachmentId,
				targetNodeId: "execute",
				targetAttempt: 1,
				observedBodyDigest: issueDigest,
				runtimeSemanticsDigest: runtimeDigest,
				effectiveAnchor: anchor,
				frozenBody: issueBody,
				newExecutionId: "exec-resumed",
				now: at,
			}),
		).toMatchObject({ ok: true, newAttempt: 2 });
		expect(
			store.getWorkflowLaunchCancellation("exec-replacement"),
		).toMatchObject({ reason: "workflow_resume_superseded" });
		store.close();
	});

	it.each([
		"delivery_digest",
		"binding_attempt",
		"dispatch_started",
		"session_created",
		"launch_owner_created",
		"execution_bound",
		"lifecycle_claimed",
	] as const)("rejects writer migration after %s", async (mutation) => {
		const { db, store } = await seedUnlaunchedWriterReplacement();
		const events = store.listWorkflowRunEvents("run-1");
		const migration = events.find(
			(event) =>
				event.kind === "issue_delivery" &&
				event.execution_id === "exec-replacement",
		)!;
		const binding = events.find(
			(event) => event.kind === "resume_writer_binding",
		)!;
		if (mutation === "delivery_digest" || mutation === "binding_attempt") {
			db.run("DROP TRIGGER workflow_run_event_no_update");
		}
		if (mutation === "delivery_digest") {
			db.run("UPDATE workflow_run_event SET payload = ? WHERE event_uid = ?", [
				JSON.stringify({
					...(migration.payload as Record<string, unknown>),
					sourceIssueDeliveryDigest: "0".repeat(64),
				}),
				migration.event_uid,
			]);
		} else if (mutation === "binding_attempt") {
			db.run("UPDATE workflow_run_event SET payload = ? WHERE event_uid = ?", [
				JSON.stringify({
					...(binding.payload as Record<string, unknown>),
					targetAttempt: 2,
				}),
				binding.event_uid,
			]);
		} else if (mutation === "dispatch_started") {
			db.run(
				"UPDATE workflow_side_effect_ledger SET state = 'started' WHERE execution_id = 'exec-replacement'",
			);
		} else if (mutation === "session_created") {
			store.upsertSession({
				execution_id: "exec-replacement",
				issue_id: "FLY-1707",
				project_name: "flywheel",
				status: "working",
			});
		} else {
			db.run(
				`INSERT INTO workflow_actor
				   (execution_id, project_name, issue_id, role, created_at)
				 VALUES ('exec-replacement', 'flywheel', 'FLY-1707', 'execute', ?)`,
				[at],
			);
			if (mutation === "launch_owner_created") {
				db.run(
					`INSERT INTO workflow_launch_owner
					   (execution_id, owner_generation, owner_id, acquired_at,
					    lease_expires_at, delivery_attempt, delivery_state)
					 VALUES ('exec-replacement', 1, 'owner-1', ?, ?, 0, 'pending')`,
					[at, "2026-08-12T01:00:00.000Z"],
				);
			} else if (mutation === "execution_bound") {
				db.run(
					`INSERT INTO workflow_execution_binding
					   (activation_id, execution_id, run_id, node_id, attempt, mode, bound_at)
					 VALUES ('activation-replacement', 'exec-replacement', 'run-1',
					         'execute', 1, 'replacement', ?)`,
					[at],
				);
			} else {
				db.run(
					`INSERT INTO lifecycle_launch_claims
					   (execution_id, root_uuid, project, role, state)
					 VALUES ('exec-replacement', 'root-1', 'flywheel', 'execute', 'starting')`,
				);
			}
		}
		expect(
			resolveWorkflowResumeTarget(store, {
				runId: "run-1",
				envelopeObservation: { source: "issue_body", digest: issueDigest },
				verifyAnchor: () => true,
				env: {},
			}),
		).toMatchObject({ ok: false, reason: "receipt_digest_mismatch" });
		store.close();
	});

	it("fails closed when the requested entry or immutable receipt diverges", async () => {
		const moved = await seedTarget("execution");
		expect(
			resolveWorkflowResumeTarget(moved.store, {
				runId: "run-1",
				requestedEntry: "design",
				envelopeObservation: { source: "issue_body", digest: issueDigest },
				verifyAnchor: () => true,
				env: {},
			}),
		).toMatchObject({ ok: false, reason: "target_moved" });
		moved.store.close();

		const changed = await seedTarget("execution", {
			receiptDigest: "0".repeat(64),
		});
		expect(
			resolveWorkflowResumeTarget(changed.store, {
				runId: "run-1",
				envelopeObservation: { source: "issue_body", digest: issueDigest },
				verifyAnchor: () => true,
				env: {},
			}),
		).toMatchObject({ ok: false, reason: "receipt_digest_mismatch" });
		changed.store.close();
	});

	it.each([
		[
			{ source: "issue_body", digest: "f".repeat(64) },
			"envelope_changed:issue_body",
		],
		[
			{ source: "issue_body", unavailable: true },
			"envelope_unavailable:issue_body",
		],
	] as const)(
		"fails closed on fresh envelope drift",
		async (observation, reason) => {
			const { store } = await seedTarget("execution");
			expect(
				resolveWorkflowResumeTarget(store, {
					runId: "run-1",
					envelopeObservation: observation,
					verifyAnchor: () => true,
					env: {},
				}),
			).toMatchObject({ ok: false, reason });
			store.close();
		},
	);

	it("returns durable checkpoint and anchor failures before proposing work", async () => {
		const pending = await seedTarget("execution");
		pending.db.run(
			"UPDATE workflow_resume_attachment_state SET state = 'intent' WHERE attachment_id = 'attachment-1'",
		);
		expect(
			resolveWorkflowResumeTarget(pending.store, {
				runId: "run-1",
				envelopeObservation: { source: "issue_body", digest: issueDigest },
				verifyAnchor: () => true,
				env: {},
			}),
		).toMatchObject({ ok: false, reason: "anchor_pending" });
		pending.store.close();

		const invalid = await seedTarget("execution");
		invalid.db.run(
			`UPDATE workflow_resume_attachment_state
			    SET state = 'invalid', invalid_reason = 'anchor_unreachable'
			  WHERE attachment_id = 'attachment-1'`,
		);
		expect(
			resolveWorkflowResumeTarget(invalid.store, {
				runId: "run-1",
				envelopeObservation: { source: "issue_body", digest: issueDigest },
				verifyAnchor: () => true,
				env: {},
			}),
		).toMatchObject({ ok: false, reason: "anchor_unreachable" });
		invalid.store.close();

		const unreachable = await seedTarget("execution");
		expect(
			resolveWorkflowResumeTarget(unreachable.store, {
				runId: "run-1",
				envelopeObservation: { source: "issue_body", digest: issueDigest },
				verifyAnchor: () => false,
				env: {},
			}),
		).toMatchObject({ ok: false, reason: "anchor_unreachable" });
		unreachable.store.close();
	});

	it("fails closed when the anchor probe is interrupted", async () => {
		const { store } = await seedTarget("execution");
		expect(
			resolveWorkflowResumeTarget(store, {
				runId: "run-1",
				envelopeObservation: { source: "issue_body", digest: issueDigest },
				verifyAnchor: () => {
					throw new Error("probe interrupted");
				},
				env: {},
			}),
		).toMatchObject({ ok: false, reason: "anchor_unreachable" });
		store.close();
	});

	it.each([
		["running", "writer_not_fenced"],
		[null, "writer_liveness_unknown"],
	] as const)(
		"holds an executable target with %s writer evidence",
		async (status, reason) => {
			const { db, store } = await seedTarget("execution");
			if (status) {
				db.run("UPDATE sessions SET status = ? WHERE execution_id = 'exec-1'", [
					status,
				]);
			} else {
				db.run("DELETE FROM sessions WHERE execution_id = 'exec-1'");
			}
			expect(
				resolveWorkflowResumeTarget(store, {
					runId: "run-1",
					envelopeObservation: { source: "issue_body", digest: issueDigest },
					verifyAnchor: () => true,
					env: {},
				}),
			).toMatchObject({ ok: false, reason });
			store.close();
		},
	);

	it("rejects runtime drift and a superseded gate authority", async () => {
		const runtime = await seedTarget("execution");
		runtime.db.run(
			"UPDATE workflow_resume_attachment_state SET runtime_semantics_stamped = 'changed' WHERE attachment_id = 'attachment-1'",
		);
		expect(
			resolveWorkflowResumeTarget(runtime.store, {
				runId: "run-1",
				envelopeObservation: { source: "issue_body", digest: issueDigest },
				verifyAnchor: () => true,
				env: {},
			}),
		).toMatchObject({ ok: false, reason: "runtime_mismatch" });
		runtime.store.close();

		const gate = await seedTarget("gate");
		gate.db.run(
			"UPDATE workflow_gate_holder SET state = 'superseded' WHERE question_id = 'question-1'",
		);
		expect(
			resolveWorkflowResumeTarget(gate.store, {
				runId: "run-1",
				envelopeObservation: { source: "issue_body", digest: issueDigest },
				verifyAnchor: () => true,
				env: {},
			}),
		).toMatchObject({ ok: false, reason: "authority_context_mismatch" });
		gate.store.close();
	});
});

describe("StateStore.admitWorkflowResume", () => {
	it("atomically supersedes a dead executable attempt and inherits its ready checkpoint", async () => {
		const { store } = await seedTarget("execution");
		const input = {
			admissionKey: "resume-key-1",
			admissionDigest: "d".repeat(64),
			runId: "run-1",
			actionKind: "redispatch_execution" as const,
			sourceAttachmentId: "attachment-1",
			targetNodeId: "execute",
			targetAttempt: 1,
			observedBodyDigest: issueDigest,
			runtimeSemanticsDigest: canonicalSubmissionDigest({
				vendor: "codex",
				model: "gpt-5.6-sol",
				effort: "low",
				resolvedFamily: "codex",
				capabilitiesDigest:
					store.getWorkflowExecutionRuntime("exec-1")!.capabilities_digest,
			}),
			effectiveAnchor: anchor,
			frozenBody: issueBody,
			newExecutionId: "exec-resumed",
			now: at,
		};

		const admitted = store.admitWorkflowResume(input);

		expect(admitted).toMatchObject({
			ok: true,
			idempotentReplay: false,
			actionKind: "redispatch_execution",
			newAttempt: 2,
			newExecutionId: "exec-resumed",
		});
		expect(store.getWorkflowRunNode("run-1", "execute", 1)?.state).toBe(
			"superseded",
		);
		expect(store.getWorkflowRunNode("run-1", "execute", 2)).toMatchObject({
			state: "pending",
			execution_id: "exec-resumed",
		});
		const row = store.getWorkflowResumeAdmission("resume-key-1");
		expect(row).toMatchObject({
			source_attachment_id: "attachment-1",
			target_attempt: 1,
			new_attempt: 2,
			frozen_s3_body: issueBody,
		});
		expect(row?.result_attachment_id).toBeTruthy();
		expect(
			store.getWorkflowResumeAttachmentState(row!.result_attachment_id!),
		).toMatchObject({ state: "ready" });
		expect(
			store.listWorkflowResumeAttachments({ runId: "run-1" }).at(-1)
				?.anchor_commit,
		).toBe(anchor);

		expect(store.admitWorkflowResume(input)).toMatchObject({
			ok: true,
			idempotentReplay: true,
			newAttempt: 2,
		});
		expect(
			store.recordWorkflowResumeResponse({
				admissionKey: input.admissionKey,
				response: { success: true },
				now: at,
			}),
		).toEqual({ ok: false, reason: "completion_evidence_missing" });
		store.appendWorkflowRunEvent({
			runId: "run-1",
			eventUid: "issue_delivery:exec-resumed:1:0",
			kind: "issue_delivery",
			nodeId: "execute",
			executionId: "exec-resumed",
			payload: {
				sourceKind: "frozen_replay",
				body: issueBody,
				admissionKey: input.admissionKey,
				sourceAttachmentId: input.sourceAttachmentId,
			},
		});
		expect(
			store.recordWorkflowResumeResponse({
				admissionKey: input.admissionKey,
				response: { success: true },
				now: at,
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(store.getWorkflowResumeResponse(input.admissionKey)).toEqual({
			success: true,
		});
		expect(
			store.admitWorkflowResume({
				...input,
				admissionDigest: "e".repeat(64),
			}),
		).toEqual({ ok: false, reason: "admission_conflict" });
		store.close();
	});

	it("records a state-only redrive without creating an execution or attempt", async () => {
		const { store, runtimeDigest } = await seedTarget("gate");

		const admitted = store.admitWorkflowResume({
			admissionKey: "resume-gate-1",
			admissionDigest: "a".repeat(64),
			runId: "run-1",
			actionKind: "reconcile_state_only",
			sourceAttachmentId: "attachment-1",
			targetNodeId: "founder_gate",
			targetAttempt: 1,
			observedBodyDigest: issueDigest,
			runtimeSemanticsDigest: runtimeDigest,
			now: at,
		});

		expect(admitted).toMatchObject({
			ok: true,
			idempotentReplay: false,
			actionKind: "reconcile_state_only",
			redriveGeneration: 1,
		});
		expect(store.listWorkflowRunNodes("run-1", "founder_gate")).toHaveLength(1);
		expect(store.getWorkflowResumeAdmission("resume-gate-1")).toMatchObject({
			new_execution_id: null,
			new_attempt: null,
			redrive_generation: 1,
		});
		expect(
			store
				.listWorkflowRunEvents("run-1")
				.find((event) => event.event_uid === "resume_redrive:resume-gate-1"),
		).toMatchObject({ kind: "resume_redrive_requested" });
		expect(store.listWorkflowResumeRedriveWork()).toHaveLength(1);
		expect(
			store.ackWorkflowResumeRedrive({
				admissionKey: "resume-gate-1",
				questionId: "question-1",
				now: at,
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		expect(store.listWorkflowResumeRedriveWork()).toHaveLength(0);
		expect(
			store.recordWorkflowResumeResponse({
				admissionKey: "resume-gate-1",
				response: { success: true },
				now: at,
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		store.close();
	});
});
