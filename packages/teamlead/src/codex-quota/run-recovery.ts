import { codexQuotaAdmissionRequest } from "./admission-replay.js";
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
	persist(patch: Partial<CodexRunRecoveryTarget>): Promise<void>;
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
		await ports.persist(patch);
		Object.assign(target, patch);
	};
	if (
		authority.operatorStopped ||
		authority.healthySuccessor ||
		!authority.quotaProvenance
	) {
		await persist({ state: "abandoned" });
		return "abandoned";
	}
	if (authority.liveOldExecution) return "waiting";
	if (target.state === "waiting" || target.state === "terminating") {
		await persist({ state: "terminating" });
		const terminated = await ports.post(
			`/api/runs/${encodeURIComponent(target.runId)}/terminate`,
			{
				reason: `codex quota recovery ${target.incidentId}`,
				clientRequestId: `codex-quota:${target.incidentId}:${target.runId}:terminate`,
			},
		);
		if (terminated.status !== 200 || terminated.body.success !== true)
			return target.state;
		await persist({ state: "terminated" });
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
			await persist({ state: "abandoned" });
			return "abandoned";
		}
		await persist({ state: "starting" });
		const started = await ports.post("/api/runs/start", {
			...target.startRequest,
			idempotencyKey: `codex-quota:${target.incidentId}:${target.runId}:start`,
		});
		if (started.status === 202) {
			await persist({ state: "queued" });
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
		await persist({
			newRunId,
			newExecutionId: started.body.executionId,
		});
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
	identify(auth: string): { accountKey: string; profile: string };
	bridgeUrl: string;
	apiToken: string;
	readiness?(): Promise<boolean>;
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
	const canRecover = async (incidentId: string): Promise<boolean> => {
		try {
			const incident = store.getCodexQuotaRecoveryPermit(incidentId);
			if (
				!incident ||
				!["committed", "recovering", "settled"].includes(
					String(incident.state),
				) ||
				incident.probe_result !== "ok"
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
			const id = options.identify(raw);
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
	) => {
		if (
			row.target_kind !== "runner" ||
			["recovered", "abandoned"].includes(String(row.state))
		)
			return;
		const recoveryId = `${incidentId}:runner:${String(row.target_id)}`;
		try {
			const context = store.getCodexQuotaRecoveryContext(recoveryId);
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
				state: String(row.state) as CodexRunRecoveryState,
				startRequest,
				...(typeof row.new_run_id === "string"
					? { newRunId: row.new_run_id }
					: {}),
				...(typeof row.new_execution_id === "string"
					? { newExecutionId: row.new_execution_id }
					: {}),
			};
			quota.updateTarget(incidentId, "runner", String(row.target_id), {
				start_request_json: JSON.stringify(target.startRequest),
				terminate_key: `codex-quota:${incidentId}:${target.runId}:terminate`,
				start_key: `codex-quota:${incidentId}:${target.runId}:start`,
			});

			await advanceCodexQuotaRunRecovery(target, {
				readAuthority: async () => {
					const current = store.getCodexQuotaRecoveryContext(recoveryId);
					const active = store.getActiveWorkflowRunForIssue(
						current.run.issue_id,
					);
					const healthySuccessor =
						!!active &&
						active.run_id !== target.runId &&
						active.run_id !== current.target.new_run_id;
					return {
						committed: !!store.getCodexQuotaRecoveryPermit(incidentId),
						generation:
							quota.getRoot(String(current.incident.root_key))?.generation ?? 0,
						canonicalMatches: await canRecover(incidentId),
						quotaProvenance: true,
						operatorStopped: current.operatorStopped,
						healthySuccessor,
						liveOldExecution:
							(await liveness(
								target.oldExecutionId,
								current.run.project_name,
							)) !== "dead",
					};
				},
				post,
				persist: async (patch) => {
					quota.updateTarget(incidentId, "runner", String(row.target_id), {
						...(patch.state ? { state: patch.state } : {}),
						...(patch.newRunId ? { new_run_id: patch.newRunId } : {}),
						...(patch.newExecutionId
							? { new_execution_id: patch.newExecutionId }
							: {}),
					});
				},
				verifyRunning: async (executionId, generation) => {
					if (!(await canRecover(incidentId))) return false;
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
			});
		} catch {
			quota.updateTarget(incidentId, "runner", String(row.target_id), {
				last_error: "quota_recovery_unavailable",
			});
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
				!(await canRecover(incidentId)) ||
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
				(await canRecover(incidentId)) &&
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
		if (!(await canRecover(incidentId)) || !(await options.readiness?.()))
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
					.map((waiter) => resumeAdmissionWaiter(incidentId, waiter)),
			);
		const rows = quota.listTargets(incidentId);
		// One transport failure cannot prevent the other dead runs from recovering.
		for (let i = 0; i < rows.length; i += 2)
			await Promise.all(
				rows.slice(i, i + 2).map((row) => recoverTarget(incidentId, row)),
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
