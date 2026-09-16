export interface ReleaseWorkflowBinding {
	repository: string;
	repositoryId: number;
	workflowId: number;
	workflowPath: string;
	reviewedSha: string;
}
export interface ReleaseWorkflowRequest {
	dispatchId: string;
	createdAt: number;
	inputs: Record<string, string>;
}
export interface ReleaseWorkflowObservation {
	runId: number;
	state: "pending" | "succeeded" | "failed";
}
function valid(value: unknown): asserts value {
	if (!value) throw new Error("customer release workflow evidence unavailable");
}
function object(value: unknown): Record<string, unknown> {
	valid(value && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
}
const positive = (value: unknown) =>
	Number.isSafeInteger(value) && (value as number) > 0;
/** Fixed-origin GitHub transport. Durable dispatch ownership is held by the
 * cycle journal; this transport performs no automatic retries. */
export class CustomerReleaseGitHub {
	private readonly fetcher: typeof fetch;
	constructor(
		private readonly options: { token: string; fetch?: typeof fetch },
	) {
		valid(options.token && !/[\r\n]/.test(options.token));
		this.fetcher = options.fetch ?? fetch;
	}
	private prefix(binding: ReleaseWorkflowBinding) {
		valid(
			/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(
				binding.repository,
			) &&
				positive(binding.repositoryId) &&
				positive(binding.workflowId) &&
				/^[a-f0-9]{40}$/.test(binding.reviewedSha) &&
				[
					".github/workflows/payload-promote.yml",
					".github/workflows/payload-auto-release.yml",
				].includes(binding.workflowPath),
		);
		return `/repos/${binding.repository}`;
	}
	private async request(
		path: string,
		signal?: AbortSignal,
		body?: unknown,
	): Promise<unknown> {
		const response = await this.fetcher(`https://api.github.com${path}`, {
			method: body === undefined ? "GET" : "POST",
			redirect: "error",
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(15000)])
				: AbortSignal.timeout(15000),
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${this.options.token}`,
				"x-github-api-version": "2026-03-10",
				"content-type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (response.status === 204 && body !== undefined) return null;
		if (response.status !== 200 || response.redirected || !response.body) {
			await response.body?.cancel();
			throw new Error("customer release workflow request failed");
		}
		const reader = response.body.getReader(),
			chunks: Uint8Array[] = [];
		let size = 0;
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				size += chunk.value.byteLength;
				if (size > 2 * 1024 * 1024) {
					await reader.cancel();
					throw new Error("customer release workflow response too large");
				}
				chunks.push(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
		);
	}
	private async verify(binding: ReleaseWorkflowBinding, signal?: AbortSignal) {
		const prefix = this.prefix(binding);
		const results = await Promise.allSettled([
			this.request(prefix, signal),
			this.request(`${prefix}/actions/workflows/${binding.workflowId}`, signal),
		]);
		valid(results.every((result) => result.status === "fulfilled"));
		const [repo, workflow] = results.map((result) =>
			object((result as PromiseFulfilledResult<unknown>).value),
		);
		valid(
			repo!.id === binding.repositoryId &&
				repo!.full_name === binding.repository &&
				repo!.default_branch === "main" &&
				workflow!.id === binding.workflowId &&
				workflow!.path === binding.workflowPath &&
				workflow!.state === "active",
		);
	}
	private inputs(
		binding: ReleaseWorkflowBinding,
		request: ReleaseWorkflowRequest,
	) {
		valid(
			/^[a-f0-9]{64}$/.test(request.dispatchId) &&
				Number.isSafeInteger(request.createdAt) &&
				request.createdAt >= 0,
		);
		const i = request.inputs;
		valid(i && typeof i === "object" && !Array.isArray(i));
		valid(
			Object.values(i).every(
				(value) =>
					typeof value === "string" &&
					value.length <= 128 &&
					!/[\r\n]/.test(value),
			),
		);
		const releaseId = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
		valid(releaseId.test(i["release-id"] ?? ""));
		if (binding.workflowPath.endsWith("/payload-promote.yml")) {
			valid(
				Object.keys(i).every((key) =>
					[
						"mode",
						"release-id",
						"beta",
						"source-release-id",
						"source-binding-digest",
					].includes(key),
				),
			);
			valid(i.mode === "prepare" || i.mode === "rebind");
			if (i.mode === "prepare")
				valid(
					/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.[1-9]\d*$/.test(
						i.beta ?? "",
					) &&
						!i["source-release-id"] &&
						!i["source-binding-digest"],
				);
			else
				valid(
					releaseId.test(i["source-release-id"] ?? "") &&
						i["source-release-id"] !== i["release-id"] &&
						/^[a-f0-9]{64}$/.test(i["source-binding-digest"] ?? "") &&
						!i.beta,
				);
		} else {
			valid(
				Object.keys(i).every((key) =>
					[
						"operation",
						"cycle-id",
						"release-id",
						"binding-digest",
						"attempt-id",
					].includes(key),
				) &&
					["execute", "fence"].includes(i.operation ?? "") &&
					/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(i["cycle-id"] ?? "") &&
					/^[a-f0-9]{64}$/.test(i["binding-digest"] ?? ""),
			);
			valid(
				!i["attempt-id"] ||
					/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
						i["attempt-id"],
					),
			);
			valid(i.operation !== "fence" || !!i["attempt-id"]);
		}
	}
	async dispatch(
		binding: ReleaseWorkflowBinding,
		request: ReleaseWorkflowRequest,
		signal?: AbortSignal,
	): Promise<number | null> {
		this.inputs(binding, request);
		await this.verify(binding, signal);
		const prefix = this.prefix(binding);
		const head = object(await this.request(`${prefix}/commits/main`, signal));
		valid(head.sha === binding.reviewedSha);
		const result = await this.request(
			`${prefix}/actions/workflows/${binding.workflowId}/dispatches`,
			signal,
			{
				ref: "main",
				inputs: { ...request.inputs, "dispatch-id": request.dispatchId },
			},
		);
		if (result === null) return null;
		const body = object(result);
		valid(positive(body.workflow_run_id));
		const runId = body.workflow_run_id as number;
		valid(
			body.run_url ===
				`https://api.github.com${prefix}/actions/runs/${runId}` &&
				body.html_url ===
					`https://github.com/${binding.repository}/actions/runs/${runId}`,
		);
		return runId;
	}
	async observe(
		binding: ReleaseWorkflowBinding,
		request: ReleaseWorkflowRequest,
		signal?: AbortSignal,
	): Promise<ReleaseWorkflowObservation | null> {
		this.inputs(binding, request);
		await this.verify(binding, signal);
		const prefix = this.prefix(binding),
			title = `customer-release:${request.dispatchId}:${request.inputs.mode ?? request.inputs.operation}:${request.inputs["release-id"]}`;
		let matched: number | null = null,
			complete = false;
		const seen = new Set<number>();
		const since = new Date(
			Math.max(0, request.createdAt - 60000),
		).toISOString();
		for (let page = 1; page <= 10; page++) {
			const result = object(
				await this.request(
					`${prefix}/actions/workflows/${binding.workflowId}/runs?event=workflow_dispatch&created=${encodeURIComponent(`>=${since}`)}&per_page=100&page=${page}`,
					signal,
				),
			);
			valid(
				Array.isArray(result.workflow_runs) &&
					result.workflow_runs.length <= 100 &&
					Number.isSafeInteger(result.total_count) &&
					(result.total_count as number) >= 0 &&
					(result.total_count as number) <= 1000,
			);
			for (const value of result.workflow_runs) {
				const run = object(value);
				valid(positive(run.id) && !seen.has(run.id as number));
				seen.add(run.id as number);
				if (run.display_title === title) {
					valid(matched === null);
					matched = run.id as number;
				}
			}
			if (result.workflow_runs.length < 100) {
				valid(seen.size === result.total_count);
				complete = true;
				break;
			}
			if (page === 10 && seen.size === result.total_count) complete = true;
		}
		valid(complete);
		if (matched === null) return null;
		const run = object(
			await this.request(`${prefix}/actions/runs/${matched}`, signal),
		);
		valid(
			run.id === matched &&
				object(run.repository).id === binding.repositoryId &&
				run.workflow_id === binding.workflowId &&
				run.event === "workflow_dispatch" &&
				run.head_branch === "main" &&
				run.head_sha === binding.reviewedSha &&
				run.display_title === title &&
				run.run_attempt === 1 &&
				typeof run.created_at === "string" &&
				Date.parse(run.created_at) >= request.createdAt - 60000,
		);
		if (run.status === "completed") {
			valid(
				typeof run.conclusion === "string" &&
					[
						"success",
						"failure",
						"cancelled",
						"timed_out",
						"action_required",
						"neutral",
						"skipped",
						"stale",
						"startup_failure",
					].includes(run.conclusion),
			);
			return {
				runId: matched,
				state: run.conclusion === "success" ? "succeeded" : "failed",
			};
		}
		valid(
			["queued", "in_progress", "waiting", "pending", "requested"].includes(
				String(run.status),
			),
		);
		return { runId: matched, state: "pending" };
	}
}
