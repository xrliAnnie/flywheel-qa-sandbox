import { createHash } from "node:crypto";
import { parseBetaReceiptZip } from "./beta-release-artifact.js";
import type { BetaProjectConfig } from "./beta-release-config-source.js";
import {
	type BetaBinding,
	type BetaOccurrence,
	betaOccurrenceId,
} from "./beta-release-contract.js";
import {
	type BetaReceipt,
	validateBetaReceipt,
} from "./beta-release-receipt.js";
import type { BetaObservedRun, BetaOwner } from "./beta-release-scheduler.js";

export class BetaGitHubError extends Error {
	constructor(
		readonly code: string,
		readonly retryAtMs: number | null = null,
	) {
		super(code);
	}
}
type Json = Record<string, unknown>;
const object = (v: unknown): Json => {
	if (!v || typeof v !== "object" || Array.isArray(v))
		throw new BetaGitHubError("beta_github_schema");
	return v as Json;
};
const numeric = (v: unknown): number => {
	if (!Number.isSafeInteger(v) || Number(v) <= 0)
		throw new BetaGitHubError("beta_github_schema");
	return Number(v);
};
const repoValid = (repo: string) =>
	/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repo) &&
	![".", ".."].includes(repo.split("/")[1]!);

/** All authenticated requests are fixed-origin, bounded, and use a single explicit project credential. */
export class BetaReleaseGitHub {
	private readonly fetcher: (
		url: string,
		init?: RequestInit,
	) => Promise<Response>;
	constructor(
		private readonly options: {
			env: Readonly<Record<string, string | undefined>>;
			fetch?: (url: string, init?: RequestInit) => Promise<Response>;
			now?: () => number;
		},
	) {
		this.fetcher = options.fetch ?? fetch;
	}
	private token(name: string | undefined): string {
		if (
			!name ||
			!/^[A-Z][A-Z0-9_]{0,127}$/.test(name) ||
			!this.options.env[name]?.trim()
		)
			throw new BetaGitHubError("beta_credential_missing");
		return this.options.env[name]!;
	}
	private path(binding: Pick<BetaBinding, "canonicalRepo">): string {
		if (!repoValid(binding.canonicalRepo))
			throw new BetaGitHubError("beta_binding_invalid");
		return `/repos/${binding.canonicalRepo}`;
	}
	private async request(
		path: string,
		tokenEnv: string | undefined,
		signal: AbortSignal,
		init: RequestInit = {},
	): Promise<{ status: number; body: unknown }> {
		if (!path.startsWith("/repos/") || path.includes("#"))
			throw new BetaGitHubError("beta_binding_invalid");
		const timer = new AbortController();
		const timeout = setTimeout(() => timer.abort(), 10000);
		const combined = AbortSignal.any([signal, timer.signal]);
		try {
			const response = await this.fetcher(`https://api.github.com${path}`, {
				...init,
				redirect: "error",
				signal: combined,
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${this.token(tokenEnv)}`,
					"X-GitHub-Api-Version": "2026-03-10",
					...(init.body ? { "Content-Type": "application/json" } : {}),
				},
			});
			if (!response.ok) {
				const raw = response.headers.get("Retry-After");
				const now = this.options.now?.() ?? Date.now();
				const retryAt = raw
					? /^\d+$/.test(raw)
						? now + Number(raw) * 1000
						: Date.parse(raw)
					: NaN;
				await response.body?.cancel();
				throw new BetaGitHubError(
					`beta_github_http_${response.status}`,
					Number.isFinite(retryAt) ? retryAt : null,
				);
			}
			if (response.status === 204) return { status: 204, body: null };
			const reader = response.body?.getReader();
			if (!reader) throw new BetaGitHubError("beta_github_schema");
			let size = 0;
			const chunks: Uint8Array[] = [];
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.length;
					if (size > 2 * 1024 * 1024)
						throw new BetaGitHubError("beta_github_response_size");
					chunks.push(value);
				}
			} finally {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
			let body: unknown;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				throw new BetaGitHubError("beta_github_schema");
			}
			return { status: response.status, body };
		} catch (error) {
			if (error instanceof BetaGitHubError) throw error;
			throw new BetaGitHubError(
				combined.aborted ? "beta_github_timeout" : "beta_github_network",
			);
		} finally {
			clearTimeout(timeout);
		}
	}
	async resolve(
		project: BetaProjectConfig,
		signal: AbortSignal,
	): Promise<BetaBinding> {
		const config = project.config;
		if (
			project.reason ||
			!config?.workflow_file ||
			!config.token_env ||
			!project.projectRepo ||
			!repoValid(project.projectRepo) ||
			!/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.ya?ml$/.test(config.workflow_file) ||
			config.workflow_file.includes("..")
		)
			throw new BetaGitHubError("beta_binding_invalid");
		const prefix = this.path({ canonicalRepo: project.projectRepo });
		const repo = object(
			(await this.request(prefix, config.token_env, signal)).body,
		);
		const repositoryId = numeric(repo.id);
		if (
			typeof repo.full_name !== "string" ||
			repo.full_name.toLowerCase() !== project.projectRepo.toLowerCase() ||
			typeof repo.default_branch !== "string" ||
			!repo.default_branch ||
			repo.default_branch.length > 255
		)
			throw new BetaGitHubError("beta_binding_invalid");
		const workflow = object(
			(
				await this.request(
					`${prefix}/actions/workflows/${encodeURIComponent(config.workflow_file)}`,
					config.token_env,
					signal,
				)
			).body,
		);
		const workflowId = numeric(workflow.id);
		if (
			workflow.path !== `.github/workflows/${config.workflow_file}` ||
			workflow.state !== "active"
		)
			throw new BetaGitHubError("beta_workflow_inactive");
		return {
			projectName: project.projectName,
			repositoryId,
			canonicalRepo: repo.full_name,
			workflowId,
			defaultBranch: repo.default_branch,
			tokenEnv: config.token_env,
			bindingRevision: createHash("sha256")
				.update(
					JSON.stringify([
						project.projectName,
						repositoryId,
						workflowId,
						repo.default_branch,
						config.token_env,
					]),
				)
				.digest("hex"),
		};
	}
	private async list(
		path: string,
		key: string,
		tokenEnv: string | undefined,
		signal: AbortSignal,
	): Promise<Json[]> {
		const rows: Json[] = [];
		for (let page = 1; page <= 100; page++) {
			const data = object(
				(
					await this.request(
						`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
						tokenEnv,
						signal,
					)
				).body,
			);
			const total = data.total_count;
			if (
				!Number.isSafeInteger(total) ||
				Number(total) < 0 ||
				!Array.isArray(data[key])
			)
				throw new BetaGitHubError("beta_github_schema");
			const batch = (data[key] as unknown[]).map(object);
			rows.push(...batch);
			if (rows.length === total) return rows;
			if (batch.length === 0 || rows.length > Number(total))
				throw new BetaGitHubError("beta_github_pagination_incomplete");
		}
		throw new BetaGitHubError("beta_github_pagination_incomplete");
	}
	async owner(binding: BetaBinding, signal: AbortSignal): Promise<BetaOwner> {
		const rows = await this.list(
			`${this.path(binding)}/actions/variables`,
			"variables",
			binding.tokenEnv,
			signal,
		);
		if (
			rows.some(
				(row) => typeof row.name !== "string" || typeof row.value !== "string",
			)
		)
			throw new BetaGitHubError("beta_github_schema");
		const matches = rows.filter(
			(row) => row.name === "FW_BETA_SCHEDULER_OWNER",
		);
		if (matches.length === 0) return "legacy";
		if (
			matches.length !== 1 ||
			!["legacy", "paused", "bridge"].includes(String(matches[0]!.value))
		)
			throw new BetaGitHubError("beta_owner_invalid");
		return matches[0]!.value as BetaOwner;
	}
	async head(binding: BetaBinding, signal: AbortSignal): Promise<string> {
		const commit = object(
			(
				await this.request(
					`${this.path(binding)}/commits/${encodeURIComponent(binding.defaultBranch)}`,
					binding.tokenEnv,
					signal,
				)
			).body,
		);
		if (typeof commit.sha !== "string" || !/^[a-f0-9]{40}$/.test(commit.sha))
			throw new BetaGitHubError("beta_github_schema");
		return commit.sha;
	}
	async dispatch(
		binding: BetaBinding,
		occurrence: BetaOccurrence,
		signal: AbortSignal,
	): Promise<number | null> {
		if (
			binding.projectName !== occurrence.projectName ||
			binding.bindingRevision !== occurrence.bindingRevision ||
			occurrence.occurrenceId !==
				betaOccurrenceId(
					binding.projectName,
					binding.bindingRevision,
					occurrence.scheduledAtMs,
				) ||
			!/^[a-f0-9]{40}$/.test(occurrence.sourceCommit)
		)
			throw new BetaGitHubError("beta_binding_invalid");
		const response = await this.request(
			`${this.path(binding)}/actions/workflows/${numeric(binding.workflowId)}/dispatches`,
			binding.tokenEnv,
			signal,
			{
				method: "POST",
				body: JSON.stringify({
					ref: binding.defaultBranch,
					inputs: {
						"schedule-key": occurrence.occurrenceId,
						"source-commit": occurrence.sourceCommit,
						"project-key": binding.projectName,
					},
				}),
			},
		);
		if (response.status !== 200) return null;
		try {
			const body = object(response.body);
			const id = numeric(body.workflow_run_id);
			if (
				body.run_url !==
					`https://api.github.com${this.path(binding)}/actions/runs/${id}` ||
				body.html_url !==
					`https://github.com/${binding.canonicalRepo}/actions/runs/${id}`
			)
				return null;
			return id;
		} catch {
			return null;
		}
	}
	async observe(
		binding: BetaBinding,
		occurrence: BetaOccurrence,
		signal: AbortSignal,
	): Promise<{ runs: BetaObservedRun[] }> {
		const prefix = this.path(binding);
		const repo = object(
			(await this.request(prefix, binding.tokenEnv, signal)).body,
		);
		if (
			repo.id !== binding.repositoryId ||
			repo.default_branch !== binding.defaultBranch
		)
			throw new BetaGitHubError("beta_binding_invalid");
		const since = new Date(
			Math.max(0, occurrence.createdAtMs - 60000),
		).toISOString();
		const listed = await this.list(
			`${prefix}/actions/workflows/${numeric(binding.workflowId)}/runs?event=workflow_dispatch&created=${encodeURIComponent(`>=${since}`)}`,
			"workflow_runs",
			binding.tokenEnv,
			signal,
		);
		const title = `beta-schedule:${occurrence.occurrenceId}`;
		const ids = [
			...new Set([
				...occurrence.runIds,
				...listed
					.filter((r) => r.display_title === title)
					.map((r) => numeric(r.id)),
			]),
		].sort((a, b) => a - b);
		const runs: BetaObservedRun[] = [];
		for (const id of ids) {
			const run = object(
				(
					await this.request(
						`${prefix}/actions/runs/${numeric(id)}`,
						binding.tokenEnv,
						signal,
					)
				).body,
			);
			if (
				run.id !== id ||
				object(run.repository).id !== binding.repositoryId ||
				run.workflow_id !== binding.workflowId ||
				run.event !== "workflow_dispatch" ||
				run.head_branch !== binding.defaultBranch ||
				run.display_title !== title
			)
				throw new BetaGitHubError("beta_run_binding_invalid");
			let status: BetaObservedRun["status"];
			if (run.status === "completed") status = "completed";
			else if (run.status === "in_progress") status = "in_progress";
			else if (
				["queued", "waiting", "pending", "requested"].includes(
					String(run.status),
				)
			)
				status = "queued";
			else throw new BetaGitHubError("beta_github_schema");
			if (
				status === "completed" &&
				![
					"success",
					"failure",
					"cancelled",
					"timed_out",
					"action_required",
					"neutral",
					"skipped",
					"stale",
					"startup_failure",
				].includes(String(run.conclusion))
			)
				throw new BetaGitHubError("beta_github_schema");
			if (status !== "completed" && run.conclusion !== null)
				throw new BetaGitHubError("beta_github_schema");
			const receipt =
				status === "completed" && run.conclusion === "success"
					? await this.receipt(binding, occurrence, id, signal)
					: undefined;
			runs.push({
				id,
				status,
				conclusion: run.conclusion as string | null,
				...(receipt ? { receipt } : {}),
			});
		}
		return { runs };
	}

	private async receipt(
		binding: BetaBinding,
		occurrence: BetaOccurrence,
		runId: number,
		signal: AbortSignal,
	): Promise<BetaReceipt> {
		const artifacts = await this.list(
			`${this.path(binding)}/actions/runs/${runId}/artifacts`,
			"artifacts",
			binding.tokenEnv,
			signal,
		);
		const matches = artifacts.filter((a) => a.name === "beta-schedule-receipt");
		if (matches.length !== 1) throw new BetaGitHubError("beta_receipt_missing");
		const artifact = matches[0]!;
		if (
			artifact.expired !== false ||
			!Number.isSafeInteger(artifact.size_in_bytes) ||
			Number(artifact.size_in_bytes) > 65536 ||
			Number(artifact.size_in_bytes) <= 0
		)
			throw new BetaGitHubError("beta_artifact_invalid");
		const buffer = await this.download(binding, numeric(artifact.id), signal);
		const receipt = validateBetaReceipt(
			await parseBetaReceiptZip(buffer, signal),
			{
				projectName: binding.projectName,
				repositoryId: binding.repositoryId,
				workflowId: binding.workflowId,
				runId,
				scheduleKey: occurrence.occurrenceId,
				sourceCommit: occurrence.sourceCommit,
			},
		);
		if (receipt.outcome === "covered_by_newer") {
			const comparison = object(
				(
					await this.request(
						`${this.path(binding)}/compare/${occurrence.sourceCommit}...${receipt.publishedSourceCommit}`,
						binding.tokenEnv,
						signal,
					)
				).body,
			);
			if (
				comparison.status !== "ahead" ||
				comparison.behind_by !== 0 ||
				object(comparison.merge_base_commit).sha !== occurrence.sourceCommit
			)
				throw new BetaGitHubError("beta_receipt_ancestry");
		}
		return receipt;
	}
	private async download(
		binding: BetaBinding,
		artifactId: number,
		signal: AbortSignal,
	): Promise<Buffer> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 10000);
		const combined = AbortSignal.any([signal, controller.signal]);
		try {
			const initial = await this.fetcher(
				`https://api.github.com${this.path(binding)}/actions/artifacts/${artifactId}/zip`,
				{
					redirect: "manual",
					signal: combined,
					headers: {
						Accept: "application/vnd.github+json",
						Authorization: `Bearer ${this.token(binding.tokenEnv)}`,
						"X-GitHub-Api-Version": "2026-03-10",
					},
				},
			);
			await initial.body?.cancel();
			if (initial.status !== 302)
				throw new BetaGitHubError("beta_artifact_download");
			let location: URL;
			try {
				location = new URL(initial.headers.get("Location") ?? "");
			} catch {
				throw new BetaGitHubError("beta_artifact_redirect");
			}
			if (
				location.protocol !== "https:" ||
				location.username ||
				location.password ||
				location.port ||
				![".blob.core.windows.net", ".actions.githubusercontent.com"].some(
					(suffix) =>
						location.hostname.endsWith(suffix) &&
						location.hostname.length > suffix.length,
				)
			)
				throw new BetaGitHubError("beta_artifact_redirect");
			const response = await this.fetcher(location.href, {
				redirect: "error",
				credentials: "omit",
				signal: combined,
			});
			if (
				!response.ok ||
				Number(response.headers.get("Content-Length") ?? 0) > 65536
			) {
				await response.body?.cancel();
				throw new BetaGitHubError("beta_artifact_download");
			}
			const reader = response.body?.getReader();
			if (!reader) throw new BetaGitHubError("beta_artifact_invalid");
			let size = 0;
			const chunks: Uint8Array[] = [];
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.length;
					if (size > 65536) throw new BetaGitHubError("beta_artifact_invalid");
					chunks.push(value);
				}
			} finally {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
			return Buffer.concat(chunks);
		} catch (error) {
			if (error instanceof BetaGitHubError) throw error;
			throw new BetaGitHubError(
				combined.aborted ? "beta_github_timeout" : "beta_artifact_download",
			);
		} finally {
			clearTimeout(timer);
		}
	}
}
