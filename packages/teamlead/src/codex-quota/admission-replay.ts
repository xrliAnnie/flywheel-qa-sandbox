import type { StateStore } from "../StateStore.js";

export interface DisabledAdmissionReplayOptions {
	store: StateStore;
	enabled(): boolean;
	report?(code: string, cause: string): void | Promise<void>;
	post(
		path: string,
		body: Record<string, unknown>,
	): Promise<{ status: number; body: Record<string, unknown> }>;
	liveness(
		executionId: string,
		projectName: string,
	): Promise<"alive" | "dead" | "unknown">;
}

/** Translate the immutable reservation back to the public start request shape. */
export function codexQuotaAdmissionRequest(
	current: ReturnType<StateStore["getCodexQuotaAdmissionWaitContext"]>,
): Record<string, unknown> {
	const saved = current.request;
	const request: Record<string, unknown> = {
		...saved,
		idempotencyKey: current.waiter.start_key,
	};
	if (typeof current.waiter.run_id !== "string") {
		delete request.role;
		delete request.dispatchModel;
		delete request.freshStart;
		if (typeof saved.role === "string") request.sessionRole = saved.role;
		if (typeof saved.dispatchModel === "string")
			request.model = saved.dispatchModel;
		if (
			saved.freshStart &&
			typeof saved.freshStart === "object" &&
			typeof (saved.freshStart as { reason?: unknown }).reason === "string"
		) {
			request.freshStart = true;
			request.freshStartReason = (
				saved.freshStart as { reason: string }
			).reason;
		}
	}
	return request;
}

/** Resume existing user admission requests only; OFF confers no dead-run recovery authority. */
export function createCodexQuotaDisabledAdmissionReplay(
	options: DisabledAdmissionReplayOptions,
): () => Promise<void> {
	let inFlight = false;
	return async () => {
		if (inFlight || options.enabled()) return;
		inFlight = true;
		try {
			for (const waiter of options.store.codexQuota.listAdmissionWaits()) {
				if (options.enabled()) return;
				const startKey = String(waiter.start_key);
				try {
					const current =
						options.store.getCodexQuotaAdmissionWaitContext(startKey);
					if (current.stopped || current.waiter.state === "abandoned") {
						options.store.codexQuota.setAdmissionWaitState(
							startKey,
							"abandoned",
						);
						continue;
					}
					const executionId = String(current.waiter.execution_id);
					const existingSession = options.store.getSession(executionId);
					const owner = options.store.getWorkflowLaunchOwner(executionId);
					const launchClaim = options.store.getLaunchClaim(executionId);
					// Quota admission precedes session creation. A session (even starting)
					// or launch ownership is not proof that it is safe to spawn again.
					// Reconstructing the Bridge must reconcile a lost response, not restart
					// the execution that already crossed the launch boundary.
					if (existingSession || owner || launchClaim?.state === "running") {
						const alive = await options.liveness(
							executionId,
							String(current.request.projectName),
						);
						if (options.enabled()) return;
						const latest =
							options.store.getCodexQuotaAdmissionWaitContext(startKey);
						if (latest.stopped)
							options.store.codexQuota.setAdmissionWaitState(
								startKey,
								"abandoned",
							);
						else if (
							alive === "alive" &&
							options.store.getSession(executionId)?.status === "running"
						)
							options.store.codexQuota.setAdmissionWaitState(
								startKey,
								"released",
							);
						continue;
					}
					options.store.codexQuota.setAdmissionWaitState(startKey, "resuming");
					const response = await options.post(
						"/api/runs/start",
						codexQuotaAdmissionRequest(current),
					);
					if (options.enabled()) return;
					if (
						response.status !== 200 ||
						response.body.success !== true ||
						response.body.executionId !== current.waiter.execution_id
					)
						continue;
					if (
						typeof current.waiter.run_id === "string" &&
						(response.body.workflowRunId ?? response.body.runId) !==
							current.waiter.run_id
					)
						continue;
					if (options.store.getSession(executionId)?.status !== "running")
						continue;
					const alive = await options.liveness(
						executionId,
						String(current.request.projectName),
					);
					if (options.enabled()) return;
					const latest =
						options.store.getCodexQuotaAdmissionWaitContext(startKey);
					if (latest.stopped)
						options.store.codexQuota.setAdmissionWaitState(
							startKey,
							"abandoned",
						);
					else if (
						alive === "alive" &&
						options.store.getSession(executionId)?.status === "running"
					)
						options.store.codexQuota.setAdmissionWaitState(
							startKey,
							"released",
						);
				} catch (error) {
					const code = "quota_admission_replay_unavailable";
					const cause = error instanceof Error ? error.message : String(error);
					try {
						await options.report?.(code, cause);
					} catch {
						console.warn(JSON.stringify({ code, cause }));
					}
					// Preserve the durable cursor for the next dispatcher pass; one failed
					// request must not strand unrelated queued user admissions.
				}
			}
		} finally {
			inFlight = false;
		}
	};
}
