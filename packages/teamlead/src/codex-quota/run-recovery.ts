import type { CodexAccountPool } from "flywheel-claude-runner/bin/codex-account-core.mjs";
import type {
	CodexQuotaTargetFence,
	CodexQuotaTargetPatch,
	CodexQuotaTerminateExpectation,
} from "../bridge/codex-quota-store.js";
import { codexQuotaAdmissionRequest } from "./admission-replay.js";
import { codexQuotaIdentityReader } from "./probe.js";
export type CodexRunRecoveryState =
	| "waiting"
	| "terminating"
	| "terminated"
	| "starting"
	| "queued"
	| "recovered"
	| "abandoned";
export interface CodexRunRecoveryTarget {
	incidentId: string;
	runId: string;
	oldExecutionId: string;
	installedGeneration: number;
	state: CodexRunRecoveryState;
	/** Server-owned pinned recovery reference; never parsed from alert text. */
	startRequest: Record<string, unknown>;
	newRunId?: string;
	newExecutionId?: string;
	quotaRecovery?: CodexQuotaTerminateExpectation;
}
export interface CodexRunRecoveryPorts {
	readAuthority(target: CodexRunRecoveryTarget): Promise<{
		committed: boolean;
		generation: number;
		canonicalMatches: boolean;
		quotaProvenance: boolean;
		liveOldExecution: boolean;
		operatorStopped: boolean;
		healthySuccessor: boolean;
	}>;
	post(
		path: string,
		body: Record<string, unknown>,
	): Promise<{ status: number; body: Record<string, unknown> }>;
	persist(patch: Partial<CodexRunRecoveryTarget>): Promise<boolean>;
	verifyRunning(executionId: string, generation: number): Promise<boolean>;
}

/** Advance only persisted targets; the coordinator bounds concurrency and cadence. */
export async function advanceCodexQuotaRunRecovery(
	target: CodexRunRecoveryTarget,
	ports: CodexRunRecoveryPorts,
): Promise<CodexRunRecoveryState> {
	if (target.state === "recovered" || target.state === "abandoned")
		return target.state;
	const authority = await ports.readAuthority(target);
	if (
		!authority.committed ||
		!authority.canonicalMatches ||
		authority.generation !== target.installedGeneration
	)
		return "waiting";
	const persist = async (patch: Partial<CodexRunRecoveryTarget>) => {
		if (!(await ports.persist(patch))) return false;
		Object.assign(target, patch);
		return true;
	};
	if (
		authority.operatorStopped ||
		authority.healthySuccessor ||
		!authority.quotaProvenance
	) {
		if (!(await persist({ state: "abandoned" }))) return target.state;
		return "abandoned";
	}
	if (authority.liveOldExecution) return "waiting";
	if (target.state === "waiting" || target.state === "terminating") {
		if (!(await persist({ state: "terminating" }))) return target.state;
		const terminated = await ports.post(
			`/api/runs/${encodeURIComponent(target.runId)}/terminate`,
			{
				reason: `codex quota recovery ${target.incidentId}`,
				clientRequestId: `codex-quota:${target.incidentId}:${target.runId}:terminate`,
				...(target.quotaRecovery
					? {
							quotaRecovery: {
								...target.quotaRecovery,
								target: {
									...target.quotaRecovery.target,
									state: "terminating",
								},
							},
						}
					: {}),
			},
		);
		if (terminated.status !== 200 || terminated.body.success !== true)
			return target.state;
		if (!(await persist({ state: "terminated" }))) return target.state;
	}
	if (
		target.state === "terminated" ||
		target.state === "starting" ||
		target.state === "queued"
	) {
		const current = await ports.readAuthority(target);
		if (
			!current.committed ||
			!current.canonicalMatches ||
			current.generation !== target.installedGeneration ||
			current.liveOldExecution
		)
			return target.state;
		if (
			current.operatorStopped ||
			current.healthySuccessor ||
			!current.quotaProvenance
		) {
			if (!(await persist({ state: "abandoned" }))) return target.state;
			return "abandoned";
		}
		if (!(await persist({ state: "starting" }))) return target.state;
		const started = await ports.post("/api/runs/start", {
			...target.startRequest,
			idempotencyKey: `codex-quota:${target.incidentId}:${target.runId}:start`,
		});
		if (started.status === 202) {
			if (!(await persist({ state: "queued" }))) return target.state;
			return "queued";
		}
		// Generalized runs/start names its durable run workflowRunId. Older callers
		// used runId; keep that alias without allowing contradictory identities.
		const newRunId = started.body.workflowRunId ?? started.body.runId;
		if (
			started.status !== 200 ||
			typeof newRunId !== "string" ||
			!newRunId ||
			(started.body.workflowRunId !== undefined &&
				started.body.runId !== undefined &&
				started.body.workflowRunId !== started.body.runId) ||
			typeof started.body.executionId !== "string"
		)
			return target.state;
		if (
			!(await persist({
				newRunId,
				newExecutionId: started.body.executionId,
			}))
		)
			return target.state;
		if (
			await ports.verifyRunning(
				started.body.executionId,
				target.installedGeneration,
			)
		)
			await persist({ state: "recovered" });
	}
	return target.state;
}

export interface CodexQuotaRunRecoveryOptions {
	store: import("../StateStore.js").StateStore;
	canonicalHome: string;
	pool(): CodexAccountPool;
	bridgeUrl: string;
	apiToken: string;
	readiness?(): Promise<boolean>;
	/** Internal same-service delegation; never an HTTP authority upgrade. */
	recoverHeldWorkflowNode?(
		input: CodexQuotaTerminateExpectation,
	): Promise<void>;
	verifyLiveness?(
		executionId: string,
		projectName: string,
	): Promise<"alive" | "dead" | "unknown">;
}
/** Recovery uses the authenticated public run routes; credentials never enter argv or reports. */
export function createCodexQuotaRunRecovery(
	options: CodexQuotaRunRecoveryOptions,
) {
	const base = new URL(options.bridgeUrl);
	if (
		!["http:", "https:"].includes(base.protocol) ||
		!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
		base.username ||
		base.password ||
		base.search ||
		base.hash ||
		base.pathname !== "/" ||
		!options.apiToken
	)
		throw new Error("quota_recovery_local_bridge_required");
	const store = options.store,
		quota = store.codexQuota;
	const canRecoverWithPool = async (
		incidentId: string,
		pool: CodexAccountPool,
	): Promise<boolean> => {
		try {
			const incident = store.getCodexQuotaRecoveryPermit(incidentId);
			if (
				!incident ||
				!["committed", "recovering", "settled"].includes(
					String(incident.state),
				) ||
				(incident.probe_result !== "ok" &&
					incident.recovery_proof_kind !== "resume_output")
			)
				return false;
			const { readFile, realpath } = await import("node:fs/promises");
			const { join } = await import("node:path");
			const { createHash } = await import("node:crypto");
			const home = await realpath(options.canonicalHome);
			if (createHash("sha256").update(home).digest("hex") !== incident.root_key)
				return false;
			const root = quota.getRoot(String(incident.root_key));
			const raw = await readFile(join(home, "auth.json"), "utf8");
			const id = codexQuotaIdentityReader(pool)(raw);
			if (
				!root ||
				root.generation !== incident.installed_generation ||
				root.accountKey !== id.accountKey ||
				root.profile !== id.profile
			)
				return false;
			const authDigest = createHash("sha256").update(raw).digest("hex");
			if (authDigest !== incident.installed_auth_digest) {
				// Registry-verified identity continuity, not a new provider authentication proof.
				// Shared native refresh must not strand the remaining targets of a committed switch.
				store.observeCodexQuotaCanonicalCredential({
					incidentId: String(incident.incident_id),
					generation: root.generation,
					accountKey: root.accountKey,
					profile: root.profile,
					authDigest,
				});
			}
			return true;
		} catch {
			return false;
		}
	};
	const canRecover = async (incidentId: string): Promise<boolean> => {
		try {
			return await canRecoverWithPool(incidentId, options.pool());
		} catch {
			return false;
		}
	};
	const liveness = async (executionId: string, projectName: string) => {
		if (options.verifyLiveness)
			return options.verifyLiveness(executionId, projectName);
		const { probeRunExecutionLiveness } = await import(
			"../bridge/run-quiescence.js"
		);
		return probeRunExecutionLiveness(
			store.getSession(executionId),
			executionId,
			projectName,
		);
	};
	const post: CodexRunRecoveryPorts["post"] = async (path, body) => {
		const response = await fetch(new URL(path, base), {
			method: "POST",
			redirect: "error",
			headers: {
				Authorization: `Bearer ${options.apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(100_000),
		});
		const text = await response.text();
		if (text.length > 65536)
			throw new Error("quota_recovery_response_too_large");
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error("quota_recovery_response_invalid");
		return { status: response.status, body: parsed as Record<string, unknown> };
	};
	const recoverTarget = async (
		incidentId: string,
		row: Record<string, unknown>,
		pool: CodexAccountPool,
	) => {
		if (row.target_kind !== "runner") return;
		let expected = quota.getTargetFence(
			incidentId,
			"runner",
			String(row.target_id),
		);
		if (!expected || ["recovered", "abandoned"].includes(expected.state))
			return;
		const fenceCurrent = () => {
			const current = quota.getTargetFence(
				incidentId,
				"runner",
				String(row.target_id),
			);
			return (
				!!current &&
				!!expected &&
				Object.entries(expected).every(
					([key, value]) =>
						current[key as keyof CodexQuotaTargetFence] === value,
				)
			);
		};
		const persistTarget = (patch: CodexQuotaTargetPatch): boolean => {
			if (!expected || !quota.compareAndSwapTarget(expected, patch))
				return false;
			expected = {
				...expected,
				...(patch.state ? { state: patch.state } : {}),
			};
			return true;
		};
		// FLY-2900 §4.2: a quota standby carrier recovers this execution in
		// place (same exec, same thread); never terminate the run or start a
		// new one for it. A settled carrier implies the target's settlement.
		const standby = quota.standbyTargetDisposition?.(
			incidentId,
			String(row.old_execution_id),
		);
		if (standby === "carrier") return;
		if (standby) {
			persistTarget({
				state: standby,
				last_error: `standby_${standby}`,
			});
			return;
		}
		const recoveryId = `${incidentId}:runner:${String(row.target_id)}`;
		try {
			row =
				quota
					.listTargets(incidentId)
					.find(
						(candidate) =>
							candidate.target_kind === "runner" &&
							candidate.target_id === expected!.targetId,
					) ?? row;
			if (!fenceCurrent()) return;
			const context = store.getCodexQuotaRecoveryContext(recoveryId);
			if (!fenceCurrent()) return;
			const source = store.getSession(String(row.old_execution_id));
			const startRequest: Record<string, unknown> =
				typeof row.start_request_json === "string"
					? JSON.parse(row.start_request_json)
					: {
							issueId: context.run.issue_id,
							projectName: context.run.project_name,
							quotaRecoveryId: recoveryId,
							...(source?.worktree_path
								? { originalWorktreePath: source.worktree_path }
								: {}),
							...(source?.branch ? { originalBranch: source.branch } : {}),
						};
			if (
				startRequest.issueId !== context.run.issue_id ||
				startRequest.projectName !== context.run.project_name ||
				startRequest.quotaRecoveryId !== recoveryId
			)
				throw new Error("quota_recovery_request_conflict");
			const target: CodexRunRecoveryTarget = {
				incidentId,
				runId: context.run.run_id,
				oldExecutionId: String(row.old_execution_id),
				installedGeneration: Number(
					store.getCodexQuotaRecoveryPermit(incidentId)?.installed_generation,
				),
				state: expected.state as CodexRunRecoveryState,
				startRequest,
				...(typeof row.new_run_id === "string"
					? { newRunId: row.new_run_id }
					: {}),
				...(typeof row.new_execution_id === "string"
					? { newExecutionId: row.new_execution_id }
					: {}),
			};
			const nodeId = expected.nodeId ?? context.node?.id;
			const dispatch = store
				.listWorkflowSideEffects(target.runId)
				.filter(
					(effect) =>
						effect.kind === "dispatch" &&
						effect.node_id === nodeId &&
						effect.execution_id === target.oldExecutionId &&
						(expected!.attempt === null ||
							effect.attempt === expected!.attempt),
				)
				.sort((a, b) => b.launch_ordinal - a.launch_ordinal)[0];
			const node =
				nodeId && dispatch
					? store.getWorkflowRunNode(target.runId, nodeId, dispatch.attempt)
					: undefined;
			if (
				!nodeId ||
				!dispatch ||
				!node ||
				node.execution_id !== target.oldExecutionId
			)
				throw new Error("quota_recovery_source_advanced");
			const expectation = (): CodexQuotaTerminateExpectation => {
				const permit = store.getCodexQuotaRecoveryPermit(incidentId);
				if (
					!permit ||
					Number(permit.installed_generation) !== target.installedGeneration
				)
					throw new Error("quota_recovery_permit_changed");
				return {
					target: { ...expected! },
					nodeId,
					attempt: dispatch.attempt,
					launchOrdinal: dispatch.launch_ordinal,
					permitIncidentId: String(permit.incident_id),
					installedGeneration: target.installedGeneration,
				};
			};
			target.quotaRecovery = expectation();
			const engineWaiting =
				context.run.engine_owned === 1 && target.state === "waiting";
			if (
				!engineWaiting &&
				!persistTarget({
					start_request_json: JSON.stringify(target.startRequest),
					terminate_key: `codex-quota:${incidentId}:${target.runId}:terminate`,
					start_key: `codex-quota:${incidentId}:${target.runId}:start`,
				})
			)
				return;
			const ports: CodexRunRecoveryPorts = {
				readAuthority: async () => {
					if (!fenceCurrent()) throw new Error("quota_recovery_target_changed");
					const current = store.getCodexQuotaRecoveryContext(recoveryId);
					const canonicalMatches = await canRecoverWithPool(incidentId, pool);
					if (!fenceCurrent()) throw new Error("quota_recovery_target_changed");
					const liveOldExecution =
						(await liveness(
							target.oldExecutionId,
							current.run.project_name,
						)) !== "dead";
					if (!fenceCurrent()) throw new Error("quota_recovery_target_changed");
					const refreshed = store.getCodexQuotaRecoveryContext(recoveryId);
					const active = store.getActiveWorkflowRunForIssue(
						refreshed.run.issue_id,
					);
					const healthySuccessor =
						!!active &&
						active.run_id !== target.runId &&
						active.run_id !== refreshed.target.new_run_id;
					return {
						committed: !!store.getCodexQuotaRecoveryPermit(incidentId),
						generation:
							quota.getRoot(String(current.incident.root_key))?.generation ?? 0,
						canonicalMatches,
						quotaProvenance: true,
						operatorStopped: refreshed.operatorStopped,
						healthySuccessor,
						liveOldExecution,
					};
				},
				post: async (path, body) => {
					if (!fenceCurrent()) throw new Error("quota_recovery_target_changed");
					return post(path, body);
				},
				persist: async (patch) => {
					return persistTarget({
						...(patch.state ? { state: patch.state } : {}),
						...(patch.newRunId ? { new_run_id: patch.newRunId } : {}),
						...(patch.newExecutionId
							? { new_execution_id: patch.newExecutionId }
							: {}),
					});
				},
				verifyRunning: async (executionId, generation) => {
					if (!(await canRecoverWithPool(incidentId, pool)) || !fenceCurrent())
						return false;
					const root = quota.getRoot(String(context.incident.root_key));
					const bindings = quota.getRunnerBindings(executionId);
					const currentSession = store.getSession(executionId);
					if (
						(typeof startRequest.originalWorktreePath === "string" &&
							currentSession?.worktree_path !==
								startRequest.originalWorktreePath) ||
						(typeof startRequest.originalBranch === "string" &&
							currentSession?.branch !== startRequest.originalBranch)
					) {
						quota.enqueueOutbox({
							eventId: `${incidentId}:continuity:${String(row.target_id)}`,
							incidentId,
							kind: "lead_diagnostic",
							destination: "lead",
							payload: {
								vendor: "codex",
								incidentId,
								runId: target.runId,
								reason: "recovery_continuity_mismatch",
							},
						});
						return false;
					}

					return (
						store.getSession(executionId)?.status === "running" &&
						bindings.some(
							(b) =>
								b.generation === generation &&
								b.credentialRootKey === context.incident.root_key &&
								b.accountKey === root?.accountKey &&
								b.profile === root?.profile,
						) &&
						(await liveness(executionId, context.run.project_name)) === "alive"
					);
				},
			};
			if (engineWaiting) {
				if (context.run.status !== "held" || !options.recoverHeldWorkflowNode)
					return;
				if (!(await options.readiness?.()) || !fenceCurrent()) return;
				const authority = await ports.readAuthority(target);
				if (
					!authority.committed ||
					!authority.canonicalMatches ||
					authority.generation !== target.installedGeneration ||
					authority.liveOldExecution ||
					authority.operatorStopped ||
					authority.healthySuccessor ||
					!authority.quotaProvenance
				)
					return;
				if (
					!fenceCurrent() ||
					store.getCodexQuotaRecoveryContext(recoveryId).run.status !== "held"
				)
					return;
				await options.recoverHeldWorkflowNode(expectation());
				return;
			}
			await advanceCodexQuotaRunRecovery(target, ports);
		} catch {
			if (!persistTarget({ last_error: "quota_recovery_unavailable" })) return;
			quota.enqueueOutbox({
				eventId: `${incidentId}:recovery:${String(row.target_id)}`,
				incidentId,
				kind: "lead_diagnostic",
				destination: "lead",
				payload: {
					vendor: "codex",
					incidentId,
					runId: row.run_id,
					reason: "recovery_unavailable",
				},
			});
		}
	};
	const resumeAdmissionWaiter = async (
		incidentId: string,
		waiter: Record<string, unknown>,
		pool: CodexAccountPool,
	) => {
		const startKey = String(waiter.start_key);
		try {
			const current = store.getCodexQuotaAdmissionWaitContext(startKey);
			if (current.stopped || current.waiter.state === "abandoned") {
				quota.setAdmissionWaitState(startKey, "abandoned");
				return;
			}
			const permit = store.getCodexQuotaRecoveryPermit(incidentId);
			if (
				!permit ||
				current.waiter.root_key !== permit.root_key ||
				Number(current.waiter.generation) >=
					Number(permit.installed_generation) ||
				!(await canRecoverWithPool(incidentId, pool)) ||
				!(await options.readiness?.())
			)
				return;
			const saved = current.request;
			const request = codexQuotaAdmissionRequest(current);
			quota.setAdmissionWaitState(startKey, "resuming");
			const response = await post("/api/runs/start", request);
			if (response.status === 202) return;
			if (
				response.status !== 200 ||
				response.body.success !== true ||
				response.body.executionId !== current.waiter.execution_id
			)
				return;
			if (
				typeof current.waiter.run_id === "string" &&
				(response.body.workflowRunId ?? response.body.runId) !==
					current.waiter.run_id
			)
				return;
			const executionId = String(current.waiter.execution_id),
				root = quota.getRoot(String(permit.root_key));
			if (
				(await canRecoverWithPool(incidentId, pool)) &&
				store.getSession(executionId)?.status === "running" &&
				quota
					.getRunnerBindings(executionId)
					.some(
						(b) =>
							b.generation === root?.generation &&
							b.credentialRootKey === permit.root_key &&
							b.accountKey === root?.accountKey &&
							b.profile === root?.profile,
					) &&
				(await liveness(executionId, String(saved.projectName))) === "alive"
			)
				quota.setAdmissionWaitState(startKey, "released");
		} catch {
			quota.enqueueOutbox({
				eventId: `${incidentId}:waiter:${startKey}`,
				incidentId,
				kind: "lead_diagnostic",
				destination: "lead",
				payload: {
					vendor: "codex",
					incidentId,
					startKey,
					reason: "admission_resume_unavailable",
				},
			});
		}
	};
	const recover = async (incident: Record<string, unknown>) => {
		const incidentId = String(incident.incident_id);
		let pool: CodexAccountPool;
		try {
			pool = options.pool();
		} catch {
			return;
		}
		if (
			!(await canRecoverWithPool(incidentId, pool)) ||
			!(await options.readiness?.())
		)
			return;
		const permit = store.getCodexQuotaRecoveryPermit(incidentId)!;
		const waiters = quota
			.listAdmissionWaits()
			.filter(
				(waiter) =>
					waiter.root_key === permit.root_key &&
					Number(waiter.generation) < Number(permit.installed_generation),
			);
		for (let i = 0; i < waiters.length; i += 2)
			await Promise.all(
				waiters
					.slice(i, i + 2)
					.map((waiter) => resumeAdmissionWaiter(incidentId, waiter, pool)),
			);
		const rows = quota.listTargets(incidentId);
		// One transport failure cannot prevent the other dead runs from recovering.
		for (let i = 0; i < rows.length; i += 2)
			await Promise.all(
				rows.slice(i, i + 2).map((row) => recoverTarget(incidentId, row, pool)),
			);
		const targets = quota
			.listTargets(incidentId)
			.filter((row) => row.target_kind === "runner");
		if (
			targets.length &&
			targets.every((row) =>
				["recovered", "abandoned"].includes(String(row.state)),
			)
		) {
			quota.enqueueOutbox({
				eventId: `${incidentId}:runs-recovered:${(await import("node:crypto"))
					.createHash("sha256")
					.update(
						JSON.stringify(
							targets
								.map((row) => [
									row.target_id,
									row.new_run_id,
									row.new_execution_id,
									row.state,
								])
								.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
						),
					)
					.digest("hex")}`,
				incidentId,
				kind: "lead_summary",
				destination: "lead",
				payload: {
					vendor: "codex",
					incidentId,
					targets: targets.map((row) => ({
						oldRunId: row.run_id,
						newRunId: row.new_run_id,
						state: row.state,
					})),
				},
			});
		}
	};
	return { canRecover, recover };
}
