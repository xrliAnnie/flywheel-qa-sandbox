#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const KNOWN_REWORKS = new Map([
	[
		"rework:389336410732ec77c7b16fc53114f666d943e484d2aabbc8e0024621cb5ae8af",
		{
			expectedRunId: "d015ad38-85db-454a-b1aa-2bf3fd4e141e",
			expectedRouteRevision: 1,
			expectedTargetNodeId: "implement",
			expectedTargetAttempt: 2,
			expectedTargetExecutionId: "0555207c-e0c4-494c-95ef-b5361cca4724",
			operator: "fly1648-surgical-closeout",
		},
	],
	[
		"rework:e26a21d89749cb7c2626d64ba74569c03ef31fece9003859f896d94e6fb5ef67",
		{
			expectedRunId: "9c785ed9-a3a2-4182-b5d8-7c59758174e3",
			expectedRouteRevision: 1,
			expectedTargetNodeId: "implement",
			expectedTargetAttempt: 2,
			expectedTargetExecutionId: "695938e5-7284-4fcb-9a7c-b0e05580c94b",
			operator: "fly1648-surgical-closeout",
		},
	],
]);

const KNOWN_GATES = new Map([
	[
		"workflow-gate:821322f6a508d3602064a49131a0030c3ef22abae2cd4b8475512f70eb3b2b4c",
		{
			expectedRunId: "fee58f20-3e30-4a53-932b-a5dd0f001395",
			expectedSourceExecutionId: "37282acb-c3b2-4e23-84ca-047ce5873f4a",
			expectedHeadSha: "f95c4b4236c39d3289d9de3731ad8877a515f27d",
		},
	],
]);

function usage() {
	return `Usage:
  node scripts/fly-1648-hot-loop-closeout.mjs [--apply] [--db PATH]
    --retire-held-rework REQUEST_ID  (repeatable)
    --complete-gate QUESTION_ID      (repeatable)

Dry-run is the default and opens the database physically readonly. --apply is
an operator-only action: it preflights every target, creates an online backup,
then applies each idempotent closeout independently. This runner must never run
--apply against the production database; Lead/founder owns that step.`;
}

function parseArgs(argv) {
	const parsed = {
		apply: false,
		dbPath: join(homedir(), ".flywheel", "teamlead.db"),
		reworks: [],
		gates: [],
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--apply") {
			parsed.apply = true;
		} else if (arg === "--db") {
			parsed.dbPath = resolve(argv[++index] ?? "");
		} else if (arg === "--retire-held-rework") {
			parsed.reworks.push(argv[++index] ?? "");
		} else if (arg === "--complete-gate") {
			parsed.gates.push(argv[++index] ?? "");
		} else if (arg === "--help" || arg === "-h") {
			process.stdout.write(`${usage()}\n`);
			process.exit(0);
		} else {
			throw new Error(`unknown_argument:${arg}`);
		}
	}
	if (!parsed.dbPath) throw new Error("database_path_required");
	if (parsed.reworks.length + parsed.gates.length === 0) {
		throw new Error("at_least_one_closeout_target_required");
	}
	for (const requestId of parsed.reworks) {
		if (!KNOWN_REWORKS.has(requestId)) {
			throw new Error(`rework_not_in_fly1648_allowlist:${requestId}`);
		}
	}
	for (const questionId of parsed.gates) {
		if (!KNOWN_GATES.has(questionId)) {
			throw new Error(`gate_not_in_fly1648_allowlist:${questionId}`);
		}
	}
	if (
		new Set(parsed.reworks).size !== parsed.reworks.length ||
		new Set(parsed.gates).size !== parsed.gates.length
	) {
		throw new Error("duplicate_closeout_target");
	}
	return parsed;
}

function eventPayload(event) {
	return event?.payload && typeof event.payload === "object"
		? event.payload
		: {};
}

function matchingEventUids(store, runId, predicate) {
	if (!runId) return [];
	return store
		.listWorkflowRunEvents(runId)
		.filter(predicate)
		.map((event) => event.event_uid);
}

function inspectRework(store, requestId) {
	const expected = KNOWN_REWORKS.get(requestId);
	const request = store.getWorkflowReworkRequest(requestId);
	const route = store.getLatestWorkflowReworkRoute(requestId);
	const delivery = store.getWorkflowReworkDelivery(requestId);
	const run = request ? store.getWorkflowRun(request.run_id) : undefined;
	const target =
		request && route
			? store.getWorkflowRunNode(
					request.run_id,
					route.target_node_id,
					route.target_attempt,
				)
			: undefined;
	const exhausted = request
		? store
				.listWorkflowRunEvents(request.run_id)
				.find(
					(event) =>
						event.kind === "rework_held_recovery_exhausted" &&
						eventPayload(event).requestId === requestId,
				)
		: undefined;
	const alert = store.getWorkflowAlertOutbox(
		`rework_held_recovery_exhausted:${requestId}`,
	);
	const summary = {
		requestId,
		runId: request?.run_id ?? null,
		issueId: run?.issue_id ?? null,
		runStatus: run?.status ?? null,
		deliveryState: delivery?.state ?? null,
		holdCount: delivery?.hold_count ?? null,
		lastError: delivery?.last_error ?? null,
		routeRevision: route?.revision ?? null,
		targetNodeId: route?.target_node_id ?? null,
		targetAttempt: route?.target_attempt ?? null,
		targetExecutionId: route?.preferred_actor_execution_id ?? null,
		targetState: target?.state ?? null,
		evidenceEventUids: matchingEventUids(
			store,
			request?.run_id,
			(event) =>
				event.kind === "rework_held_recovery_exhausted" &&
				eventPayload(event).requestId === requestId,
		),
		alertEvidence: alert
			? {
					escalationUid: alert.escalation_uid,
					state: alert.state,
					severity: alert.payload.severity,
				}
			: null,
	};
	if (!request || !route || !delivery || !run) {
		throw new Error(`rework_preflight_missing_context:${requestId}`);
	}
	const exact =
		request.run_id === expected.expectedRunId &&
		route.revision === expected.expectedRouteRevision &&
		route.target_node_id === expected.expectedTargetNodeId &&
		route.target_attempt === expected.expectedTargetAttempt &&
		route.preferred_actor_execution_id === expected.expectedTargetExecutionId;
	if (!exact) throw new Error(`rework_preflight_identity_drift:${requestId}`);
	if (
		delivery?.state === "needs_lead" &&
		exhausted &&
		alert?.payload.severity === "severe"
	) {
		return {
			kind: "rework",
			id: requestId,
			status: "already_applied",
			summary,
		};
	}
	if (
		delivery.state !== "held" ||
		delivery.last_error !== "persisted_target_missing" ||
		delivery.route_revision !== route.revision ||
		run.status !== "held" ||
		run.engine_owned !== 1
	) {
		throw new Error(`rework_preflight_state_drift:${requestId}`);
	}
	if (
		target &&
		(target.state === "pending" || target.state === "admitted") &&
		target.execution_id === expected.expectedTargetExecutionId
	) {
		throw new Error(`rework_preflight_target_recoverable:${requestId}`);
	}
	return {
		kind: "rework",
		id: requestId,
		status: "ready",
		summary,
		transition: "held -> needs_lead",
		expected,
	};
}

function inspectGate(store, questionId, now) {
	const expected = KNOWN_GATES.get(questionId);
	const inspection = store.inspectRunnerShipGateCloseout(questionId, now);
	if (!inspection.ok) {
		throw new Error(`gate_preflight_${inspection.reason}:${questionId}`);
	}
	const completion = inspection.run
		? store
				.listWorkflowRunEvents(inspection.run.run_id)
				.find(
					(event) =>
						event.kind === "run_completed" &&
						eventPayload(event).questionId === questionId,
				)
		: undefined;
	const summary = {
		questionId,
		runId: inspection.holder.runId,
		issueId: inspection.run?.issue_id ?? null,
		runStatus: inspection.run?.status ?? null,
		holderState: inspection.holder.state,
		carrierBindingState: inspection.holder.carrierBindingState,
		headSha: inspection.holder.headSha,
		sourceExecutionId: inspection.holder.sourceExecutionId,
		carrierStatus: inspection.carrier?.status ?? null,
		carrierQuestionId: inspection.carrier?.review_question_id ?? null,
		carrierHeadSha: inspection.carrier?.pr_head_sha ?? null,
		authority: inspection.authority,
		observationProjection: inspection.observationProjection,
		claims: inspection.claims,
		completionContextDigest: inspection.completionContextDigest,
		evidenceEventUids: matchingEventUids(
			store,
			inspection.run?.run_id,
			(event) =>
				event.kind === "run_completed" &&
				eventPayload(event).questionId === questionId,
		),
	};
	const exact =
		inspection.holder.runId === expected.expectedRunId &&
		inspection.holder.sourceExecutionId ===
			expected.expectedSourceExecutionId &&
		inspection.holder.headSha === expected.expectedHeadSha;
	if (!exact) throw new Error(`gate_preflight_identity_drift:${questionId}`);
	if (
		inspection.run?.status === "completed" &&
		completion &&
		typeof eventPayload(completion).mergedHead === "string" &&
		eventPayload(completion).mergedHead.toLowerCase() ===
			expected.expectedHeadSha
	) {
		return { kind: "gate", id: questionId, status: "already_applied", summary };
	}
	const terminalStatuses = new Set([
		"completed",
		"failed",
		"terminated",
		"blocked",
		"rejected",
		"deferred",
		"shelved",
	]);
	if (
		inspection.run?.status !== "active" ||
		inspection.holder.state !== "approved" ||
		inspection.holder.carrierBindingState !== "bound" ||
		!inspection.carrier ||
		!terminalStatuses.has(inspection.carrier.status) ||
		inspection.carrier.review_question_id !== questionId ||
		inspection.carrier.pr_head_sha?.toLowerCase() !==
			expected.expectedHeadSha ||
		inspection.authority.status !== "resolved" ||
		inspection.observationProjection.status !== "valid" ||
		inspection.observationProjection.headSha !== expected.expectedHeadSha ||
		!inspection.claims.valid
	) {
		throw new Error(`gate_preflight_state_drift:${questionId}`);
	}
	return {
		kind: "gate",
		id: questionId,
		status: "ready",
		summary,
		transition:
			"active founder_gate run -> completed; terminal carrier unchanged",
	};
}

function isBusy(error) {
	const code = typeof error?.code === "string" ? error.code : "";
	return code.includes("SQLITE_BUSY") || code.includes("SQLITE_LOCKED");
}

function canonicalIntegrityRows(rows) {
	return rows
		.map((row) => {
			if (!row || typeof row !== "object" || Array.isArray(row)) {
				return JSON.stringify(row);
			}
			return JSON.stringify(
				Object.fromEntries(
					Object.entries(row).sort(([left], [right]) =>
						left.localeCompare(right),
					),
				),
			);
		})
		.sort();
}

function quickCheckOk(integrity) {
	return (
		integrity.quickCheck.length === 1 &&
		integrity.quickCheck[0]?.quick_check === "ok"
	);
}

function integrityBaselinePreserved(baseline, after) {
	return (
		quickCheckOk(after) &&
		JSON.stringify(canonicalIntegrityRows(after.foreignKeyViolations)) ===
			JSON.stringify(canonicalIntegrityRows(baseline.foreignKeyViolations))
	);
}

async function withBusyRetry(operation) {
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			return operation();
		} catch (error) {
			if (!isBusy(error) || attempt === 3) throw error;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
		}
	}
	throw new Error("unreachable_busy_retry");
}

function timestampForPath() {
	return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function inspectAfter(kind, store, id, now) {
	try {
		return kind === "rework"
			? inspectRework(store, id)
			: inspectGate(store, id, now);
	} catch (error) {
		return {
			kind,
			id,
			status: "inspection_failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const stateStoreUrl = pathToFileURL(
		join(repoRoot, "packages", "teamlead", "dist", "StateStore.js"),
	).href;
	let StateStore;
	try {
		({ StateStore } = await import(stateStoreUrl));
	} catch (error) {
		throw new Error(
			`teamlead_dist_unavailable: run pnpm --filter flywheel-teamlead build first (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	const gitHead = execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: repoRoot,
		encoding: "utf8",
	}).trim();
	const store = await StateStore.openForMaintenance(args.dbPath, {
		readonly: !args.apply,
	});
	try {
		const connection = store.maintenanceDiagnostics();
		if (
			connection.journalMode !== "wal" ||
			connection.foreignKeys !== 1 ||
			connection.busyTimeoutMs !== 5000
		) {
			throw new Error("maintenance_connection_safety_mismatch");
		}
		const integrityBaseline = store.maintenanceIntegrityCheck();
		if (!quickCheckOk(integrityBaseline)) {
			throw new Error("maintenance_integrity_baseline_failed");
		}
		const inspectedAt = new Date().toISOString();
		const preflight = [
			...args.reworks.map((requestId) => inspectRework(store, requestId)),
			...args.gates.map((questionId) =>
				inspectGate(store, questionId, inspectedAt),
			),
		];
		const header = {
			issue: "FLY-1648",
			mode: args.apply ? "apply" : "dry-run",
			dbPath: args.dbPath,
			gitHead,
			connection,
			preflight,
			integrityBaseline,
		};
		if (!args.apply) {
			process.stdout.write(`${JSON.stringify(header, null, 2)}\n`);
			return;
		}

		const backupPath = join(
			dirname(args.dbPath),
			"backups",
			`teamlead-pre-fly1648-${timestampForPath()}.db`,
		);
		await store.backupTo(backupPath);
		const results = [];
		for (const target of preflight) {
			if (target.status === "already_applied") {
				results.push({ ...target, result: "skipped" });
				continue;
			}
			try {
				if (target.kind === "rework") {
					const outcome = await withBusyRetry(() =>
						store.settleHeldReworkRecoveryFailure({
							requestId: target.id,
							reason: "rework_replacement_target_changed",
							forceTerminal: target.expected,
							alertIdentity: {
								leadId: "flywheel-eng-lead",
								projectName: "flywheel",
								leadResolution: "resolved",
							},
							now: new Date().toISOString(),
						}),
					);
					results.push({
						...target,
						result:
							outcome.ok && outcome.state === "needs_lead"
								? "applied"
								: "failed",
						outcome,
					});
				} else {
					const outcome = await withBusyRetry(() =>
						store.completeRunnerShipGateFromPersistedObservation({
							questionId: target.id,
							alertIdentity: {
								leadId: "flywheel-eng-lead",
								projectName: "flywheel",
								leadResolution: "resolved",
							},
							now: new Date().toISOString(),
						}),
					);
					results.push({
						...target,
						result: outcome.ok ? "applied" : "failed",
						outcome,
					});
				}
			} catch (error) {
				results.push({
					...target,
					result: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const afterAt = new Date().toISOString();
		const after = [
			...args.reworks.map((requestId) =>
				inspectAfter("rework", store, requestId, afterAt),
			),
			...args.gates.map((questionId) =>
				inspectAfter("gate", store, questionId, afterAt),
			),
		];
		const integrity = store.maintenanceIntegrityCheck();
		const integrityUnchanged = integrityBaselinePreserved(
			integrityBaseline,
			integrity,
		);
		process.stdout.write(
			`${JSON.stringify(
				{
					...header,
					backupPath,
					results,
					after,
					integrity,
					integrityUnchanged,
				},
				null,
				2,
			)}\n`,
		);
		if (
			results.some((result) => result.result === "failed") ||
			after.some((result) => result.status !== "already_applied") ||
			!integrityUnchanged
		) {
			process.exitCode = 1;
		}
	} finally {
		store.close();
	}
}

main().catch((error) => {
	process.stderr.write(
		`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
	);
	process.exitCode = 1;
});
