import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
	canonicalDigest,
	filePageSchema,
	openPrPageSchema,
	type ProjectSnapshot,
	prIdentitySchema,
	projectSnapshotSchema,
	refreshConfigSchema,
} from "./contract.js";

export interface RefreshLease {
	status: "claimed";
	owner: string;
	generation: number;
}

export interface ProjectFetchApi {
	pr(repo: string, pr: number, signal: AbortSignal): Promise<unknown>;
	main(repo: string, signal: AbortSignal): Promise<unknown>;
	prs(repo: string, page: number, signal: AbortSignal): Promise<unknown>;
	files(
		repo: string,
		pr: number,
		page: number,
		signal: AbortSignal,
	): Promise<unknown>;
}
export type ProjectRefreshResult =
	| { status: "ready"; snapshot: ProjectSnapshot }
	| { status: "out_of_scope" | "unavailable"; reason: string };
export class ProjectFetchFailure extends Error {
	constructor(
		readonly code: string,
		readonly retryAfter?: number,
	) {
		super(code);
	}
}

export class SharedProjectRefresh {
	private stopped = false;
	private controller: AbortController | undefined;
	private running:
		| {
				digest: string;
				promise: Promise<ProjectRefreshResult>;
				metadata: Promise<ProjectSnapshot | undefined>;
		  }
		| undefined;
	constructor(
		private readonly store: ProjectRefreshStore,
		private readonly api: ProjectFetchApi,
		private readonly now: () => number = Date.now,
	) {}

	async stop(): Promise<void> {
		this.stopped = true;
		this.controller?.abort();
		await this.running?.promise;
	}

	refresh(value: unknown): Promise<ProjectRefreshResult> {
		if (this.stopped)
			return Promise.resolve({
				status: "unavailable",
				reason: "refresh_stopped",
			});
		const config = refreshConfigSchema.parse(value);
		if (config.projectName !== "flywheel")
			return Promise.resolve({
				status: "out_of_scope",
				reason: "project_not_enabled",
			});
		if (
			new Set(config.repositories.map((repo) => repo.repo_identity)).size !==
			config.repositories.length
		)
			throw new Error("duplicate_repository");
		config.repositories.sort((a, b) =>
			a.repo_identity < b.repo_identity
				? -1
				: a.repo_identity > b.repo_identity
					? 1
					: 0,
		);
		const digest = canonicalDigest(config.repositories);
		if (this.running)
			return this.running.digest === digest
				? this.running.promise
				: Promise.resolve({
						status: "unavailable",
						reason: "configuration_changed",
					});
		const cached = this.store.read(this.now());
		if (cached?.configurationDigest === digest)
			return Promise.resolve({ status: "ready", snapshot: cached });
		const lease = this.store.begin(randomUUID(), this.now());
		if (lease.status !== "claimed")
			return Promise.resolve({
				status: "unavailable",
				reason: `refresh_${lease.status}`,
			});
		let publish!: (snapshot: ProjectSnapshot | undefined) => void;
		const metadata = new Promise<ProjectSnapshot | undefined>((resolve) => {
			publish = resolve;
		});
		const promise = this.collect(
			config.repositories,
			digest,
			lease,
			publish,
		).finally(() => {
			this.running = undefined;
		});
		this.running = { digest, promise, metadata };
		return promise;
	}

	/** Metadata is not a complete conflict inventory. Consumers may prepare Git while files are collected. */
	metadata(value: unknown): Promise<ProjectSnapshot | undefined> {
		const config = refreshConfigSchema.parse(value);
		if (this.stopped || config.projectName !== "flywheel")
			return Promise.resolve(undefined);
		const result = this.refresh(config);
		config.repositories.sort((a, b) =>
			a.repo_identity < b.repo_identity
				? -1
				: a.repo_identity > b.repo_identity
					? 1
					: 0,
		);
		if (this.running?.digest === canonicalDigest(config.repositories))
			return this.running.metadata;
		return result.then((value) =>
			value.status === "ready" ? value.snapshot : undefined,
		);
	}

	private async collect(
		repositories: { repo_identity: string; repo_slug: string }[],
		digest: string,
		lease: RefreshLease,
		publish: (snapshot: ProjectSnapshot | undefined) => void,
	): Promise<ProjectRefreshResult> {
		const controller = new AbortController();
		this.controller = controller;
		const timer = setTimeout(() => controller.abort(), 60_000);
		const request = async (
			call: (signal: AbortSignal) => Promise<unknown>,
		): Promise<unknown> => {
			if (controller.signal.aborted)
				throw new ProjectFetchFailure("collection_timeout");
			if (!this.store.reserveApi(lease, this.now()))
				throw new ProjectFetchFailure("request_budget_or_lease");
			const signal = AbortSignal.any([
				controller.signal,
				AbortSignal.timeout(20_000),
			]);
			let abort: (() => void) | undefined;
			try {
				return await Promise.race([
					call(signal),
					new Promise<never>((_, reject) => {
						abort = () => reject(new ProjectFetchFailure("collection_timeout"));
						signal.addEventListener("abort", abort, { once: true });
						if (signal.aborted) abort();
					}),
				]);
			} finally {
				if (abort) signal.removeEventListener("abort", abort);
			}
		};
		const snapshot: ProjectSnapshot = {
			configurationDigest: digest,
			repositories: [],
			prs: [],
		};
		try {
			const prior = this.store.cacheForReuse();
			// Collect all identities first so target Git preparation does not depend on file pagination.
			for (const repo of repositories) {
				const main = z
					.string()
					.regex(/^[0-9a-f]{40}$/)
					.parse(
						await request((signal) => this.api.main(repo.repo_slug, signal)),
					);
				snapshot.repositories.push({ ...repo, main_sha: main });
				let page: number | null = 1;
				while (page !== null) {
					const current: number = page;
					const response = openPrPageSchema.parse(
						await request((signal) =>
							this.api.prs(repo.repo_slug, current, signal),
						),
					);
					if (response.nextPage !== null && response.nextPage !== current + 1)
						throw new ProjectFetchFailure("invalid_pagination");
					for (const pr of response.items.filter((pr) => !pr.draft)) {
						if (snapshot.prs.length >= 200)
							throw new ProjectFetchFailure("pr_budget_exceeded");
						snapshot.prs.push({
							repo_identity: repo.repo_identity,
							pr_number: pr.pr_number,
							head_sha: pr.head_sha,
							base_ref: pr.base_ref,
							base_sha: pr.base_sha,
							filesComplete: false,
							files: [],
							filesError: "files_pending",
						});
					}
					page = response.nextPage;
				}
			}
			publish(projectSnapshotSchema.parse(snapshot));
			for (let index = 0; index < snapshot.prs.length; index++) {
				const pr = snapshot.prs[index]!;
				const repo = snapshot.repositories.find(
					(repo) => repo.repo_identity === pr.repo_identity,
				)!;
				const cached =
					prior?.configurationDigest === digest
						? prior.prs.find(
								(old) =>
									old.repo_identity === repo.repo_identity &&
									old.pr_number === pr.pr_number &&
									old.filesComplete &&
									old.head_sha === pr.head_sha &&
									old.base_ref === pr.base_ref,
							)
						: undefined;
				if (cached) {
					snapshot.prs[index] = { ...cached, base_sha: pr.base_sha };
					continue;
				}
				try {
					const files: ProjectSnapshot["prs"][number]["files"] = [];
					let filePage: number | null = 1;
					while (filePage !== null) {
						const currentFilePage: number = filePage;
						const result = filePageSchema.parse(
							await request((signal) =>
								this.api.files(
									repo.repo_slug,
									pr.pr_number,
									currentFilePage,
									signal,
								),
							),
						);
						if (
							result.nextPage !== null &&
							result.nextPage !== currentFilePage + 1
						)
							throw new ProjectFetchFailure("invalid_pagination");
						files.push(...result.items);
						if (files.length > 1000)
							throw new ProjectFetchFailure("file_budget_exceeded");
						filePage = result.nextPage;
					}
					const identity = prIdentitySchema.parse(
						await request((signal) =>
							this.api.pr(repo.repo_slug, pr.pr_number, signal),
						),
					);
					if (
						identity.head_sha !== pr.head_sha ||
						identity.base_ref !== pr.base_ref ||
						identity.base_sha !== pr.base_sha ||
						identity.draft ||
						identity.state !== "open" ||
						identity.changed_files !== files.length ||
						new Set(files.map((file) => file.path)).size !== files.length
					)
						throw new ProjectFetchFailure("pr_changed_during_collection");
					snapshot.prs[index] = {
						repo_identity: repo.repo_identity,
						pr_number: pr.pr_number,
						head_sha: pr.head_sha,
						base_ref: pr.base_ref,
						base_sha: pr.base_sha,
						filesComplete: true,
						files,
					};
				} catch (error) {
					// Exhausted shared budgets, shutdown and rate limits remain project-wide.
					if (
						controller.signal.aborted ||
						(error instanceof ProjectFetchFailure &&
							["request_budget_or_lease", "github_rate_limit"].includes(
								error.code,
							))
					)
						throw error;
					snapshot.prs[index] = {
						repo_identity: repo.repo_identity,
						pr_number: pr.pr_number,
						head_sha: pr.head_sha,
						base_ref: pr.base_ref,
						base_sha: pr.base_sha,
						filesComplete: false,
						files: [],
						filesError:
							error instanceof ProjectFetchFailure
								? error.code
								: "pr_fetch_failed",
					};
				}
			}
			return this.store.finish(lease, snapshot, this.now())
				? { status: "ready", snapshot }
				: { status: "unavailable", reason: "refresh_lease_lost" };
		} catch (error) {
			const reason =
				error instanceof ProjectFetchFailure
					? error.code
					: "project_fetch_failed";
			this.store.fail(
				lease,
				reason,
				this.now(),
				error instanceof ProjectFetchFailure ? error.retryAfter : undefined,
				projectSnapshotSchema.safeParse(snapshot).success
					? snapshot
					: undefined,
			);
			return { status: "unavailable", reason };
		} finally {
			publish(undefined);
			clearTimeout(timer);
			controller.abort();
			if (this.controller === controller) this.controller = undefined;
		}
	}
}
interface ProjectRow {
	lease_owner: string | null;
	generation: number;
	expires_at: string | null;
	fetched_at: string | null;
	mechanical_digest: string | null;
	mechanical_cache_json: string | null;
	api_reserved_times: string;
}
const mergeProbeKeySchema = z
	.object({
		repoIdentity: z.string().min(1).max(200),
		mainSha: z.string().regex(/^[a-f0-9]{40}$/),
		headSha: z.string().regex(/^[a-f0-9]{40}$/),
		targetBaseSha: z.string().regex(/^[a-f0-9]{40}$/),
	})
	.strict();
export type MergeProbeKey = z.infer<typeof mergeProbeKeySchema>;
const mergeProbeResultSchema = z
	.object({
		verdict: z.enum(["pass", "fail", "undetermined"]),
		reason: z.string().min(1).max(64),
	})
	.strict();
const mergeProbeSchema = z
	.object({
		key: mergeProbeKeySchema,
		result: mergeProbeResultSchema,
		checkedAt: z.number().int().nonnegative().safe(),
	})
	.strict();
const envelopeSchema = z
	.object({
		mergeProbes: z.array(mergeProbeSchema).max(200).optional(),
		snapshot: projectSnapshotSchema.nullable(),
		fetchedAt: z.number().int().nonnegative().safe().nullable(),
		error: z.string().max(64).nullable().default(null),
	})
	.strict();
function iso(now: number): string {
	z.number().int().nonnegative().safe().parse(now);
	return new Date(now).toISOString();
}

export class ProjectRefreshStore {
	constructor(private readonly db: Database.Database) {}
	private row(): ProjectRow | undefined {
		return this.db
			.prepare(
				"SELECT * FROM ship_judgment_project_state WHERE project_name='flywheel'",
			)
			.get() as ProjectRow | undefined;
	}

	begin(
		owner: string,
		now: number,
	): RefreshLease | { status: "pending" | "cooldown" } {
		z.string().min(1).max(200).parse(owner);
		const at = iso(now);
		return this.db
			.transaction((): RefreshLease | { status: "pending" | "cooldown" } => {
				this.db
					.prepare(
						"INSERT OR IGNORE INTO ship_judgment_project_state(project_name) VALUES ('flywheel')",
					)
					.run();
				const row = this.row()!;
				if (row.expires_at && Date.parse(row.expires_at) > now)
					return { status: row.lease_owner ? "pending" : "cooldown" };
				if (row.fetched_at && Date.parse(row.fetched_at) + 60_000 > now)
					return { status: "cooldown" };
				const generation = row.generation + 1;
				// fetched_at records admission cadence; the cache envelope has the successful snapshot's own time.
				this.db
					.prepare(
						"UPDATE ship_judgment_project_state SET lease_owner=?,generation=?,expires_at=?,fetched_at=?,mechanical_digest=NULL WHERE project_name='flywheel'",
					)
					.run(owner, generation, iso(now + 60_000), at);
				return { status: "claimed", owner, generation };
			})
			.immediate();
	}

	reserveApi(lease: RefreshLease, now: number): boolean {
		iso(now);
		return this.db
			.transaction(() => {
				const row = this.row();
				if (!this.owns(row, lease, now)) return false;
				const times = z
					.array(z.number().int().nonnegative().safe())
					.max(120)
					.parse(JSON.parse(row!.api_reserved_times))
					.filter((time) => time > now - 3_600_000);
				if (times.length >= 120) return false;
				times.push(now);
				this.db
					.prepare(
						"UPDATE ship_judgment_project_state SET api_reserved_times=? WHERE project_name='flywheel'",
					)
					.run(JSON.stringify(times));
				return true;
			})
			.immediate();
	}

	finish(lease: RefreshLease, value: unknown, now: number): boolean {
		iso(now);
		const snapshot = projectSnapshotSchema.parse(value);
		const json = JSON.stringify({ snapshot, fetchedAt: now });
		if (Buffer.byteLength(json) > 4_194_304)
			throw new Error("project_cache_budget_exceeded");
		return (
			this.db
				.prepare(`UPDATE ship_judgment_project_state SET mechanical_cache_json=?,mechanical_digest=?,lease_owner=NULL,expires_at=NULL
			WHERE project_name='flywheel' AND lease_owner=? AND generation=? AND expires_at>?`)
				.run(
					json,
					canonicalDigest(snapshot),
					lease.owner,
					lease.generation,
					iso(now),
				).changes === 1
		);
	}

	fail(
		lease: RefreshLease,
		errorCode: string,
		now: number,
		retryAfter = now,
		partial?: ProjectSnapshot,
	): boolean {
		z.string().min(1).max(64).parse(errorCode);
		return this.db
			.transaction(() => {
				const row = this.row();
				if (
					!row ||
					row.lease_owner !== lease.owner ||
					row.generation !== lease.generation
				)
					return false;
				const prior = row.mechanical_cache_json
					? envelopeSchema.parse(JSON.parse(row.mechanical_cache_json))
					: { snapshot: null, fetchedAt: null };
				let reusable = partial && projectSnapshotSchema.parse(partial);
				if (
					reusable &&
					prior.snapshot &&
					reusable.configurationDigest === prior.snapshot.configurationDigest
				) {
					// A failed pass is not an inventory: absent PRs may simply be unvisited.
					const repositories = new Map(
						prior.snapshot.repositories.map((repo) => [
							repo.repo_identity,
							repo,
						]),
					);
					for (const repo of reusable.repositories)
						repositories.set(repo.repo_identity, repo);
					const key = (pr: ProjectSnapshot["prs"][number]) =>
						canonicalDigest([pr.repo_identity, pr.pr_number]);
					const prs = new Map(prior.snapshot.prs.map((pr) => [key(pr), pr]));
					for (const pr of reusable.prs) {
						const old = prs.get(key(pr));
						prs.set(
							key(pr),
							!pr.filesComplete &&
								old?.filesComplete &&
								old.head_sha === pr.head_sha &&
								old.base_ref === pr.base_ref
								? { ...old, base_sha: pr.base_sha }
								: pr,
						);
					}
					const merged = projectSnapshotSchema.safeParse({
						...reusable,
						repositories: [...repositories.values()],
						prs: [...prs.values()],
					});
					// Keep the previous bounded cache if the union exceeds existing limits.
					reusable = merged.success ? merged.data : prior.snapshot;
				}
				let json = JSON.stringify({
					...prior,
					...(partial
						? {
								snapshot: reusable,
								fetchedAt: null,
								mergeProbes: [],
							}
						: {}),
					error: errorCode,
				});
				if (Buffer.byteLength(json) > 4_194_304)
					json = JSON.stringify({
						snapshot: prior.snapshot,
						fetchedAt: null,
						error: errorCode,
					});
				if (Buffer.byteLength(json) > 4_194_304)
					json = JSON.stringify({
						snapshot: null,
						fetchedAt: null,
						error: errorCode,
					});
				return (
					this.db
						.prepare(`UPDATE ship_judgment_project_state SET mechanical_cache_json=?,mechanical_digest=NULL,lease_owner=NULL,expires_at=?
				WHERE project_name='flywheel' AND lease_owner=? AND generation=?`)
						.run(
							json,
							iso(Math.max(now, retryAfter)),
							lease.owner,
							lease.generation,
						).changes === 1
				);
			})
			.immediate();
	}

	read(now: number): ProjectSnapshot | undefined {
		iso(now);
		const row = this.row();
		if (!row?.mechanical_digest || !row.mechanical_cache_json) return undefined;
		const envelope = envelopeSchema.safeParse(
			JSON.parse(row.mechanical_cache_json),
		);
		if (
			!envelope.success ||
			!envelope.data.snapshot ||
			envelope.data.fetchedAt === null ||
			envelope.data.error !== null ||
			now < envelope.data.fetchedAt ||
			now - envelope.data.fetchedAt > 60_000 ||
			canonicalDigest(envelope.data.snapshot) !== row.mechanical_digest
		)
			return undefined;
		return envelope.data.snapshot;
	}

	readMergeProbe(
		input: MergeProbeKey,
		now: number,
	): z.infer<typeof mergeProbeResultSchema> | undefined {
		const key = mergeProbeKeySchema.parse(input);
		if (!this.read(now)) return undefined;
		const envelope = envelopeSchema.parse(
			JSON.parse(this.row()!.mechanical_cache_json!),
		);
		return envelope.mergeProbes?.find(
			(probe) =>
				canonicalDigest(probe.key) === canonicalDigest(key) &&
				probe.checkedAt <= now &&
				now - probe.checkedAt <= 60000,
		)?.result;
	}
	saveMergeProbe(input: MergeProbeKey, value: unknown, now: number): boolean {
		const key = mergeProbeKeySchema.parse(input),
			result = mergeProbeResultSchema.parse(value);
		return this.db
			.transaction(() => {
				if (!this.read(now)) return false;
				const envelope = envelopeSchema.parse(
					JSON.parse(this.row()!.mechanical_cache_json!),
				);
				const signature = canonicalDigest(key);
				const probes = (envelope.mergeProbes ?? []).filter(
					(probe) =>
						probe.checkedAt <= now &&
						now - probe.checkedAt <= 60000 &&
						canonicalDigest(probe.key) !== signature,
				);
				if (probes.length >= 200) return false;
				probes.push({ key, result, checkedAt: now });
				const json = JSON.stringify({ ...envelope, mergeProbes: probes });
				if (Buffer.byteLength(json) > 4194304) return false;
				this.db
					.prepare(
						"UPDATE ship_judgment_project_state SET mechanical_cache_json=? WHERE project_name='flywheel'",
					)
					.run(json);
				return true;
			})
			.immediate();
	}

	/** Reusable immutable-head file data, never evidence of current freshness or successful pagination. */
	cacheForReuse(): ProjectSnapshot | undefined {
		const json = this.row()?.mechanical_cache_json;
		if (!json) return undefined;
		const envelope = envelopeSchema.safeParse(JSON.parse(json));
		return envelope.success ? (envelope.data.snapshot ?? undefined) : undefined;
	}

	failureReason(): string | undefined {
		const json = this.row()?.mechanical_cache_json;
		if (!json) return undefined;
		return envelopeSchema.parse(JSON.parse(json)).error ?? undefined;
	}

	private owns(
		row: ProjectRow | undefined,
		lease: RefreshLease,
		now: number,
	): boolean {
		return (
			!!row &&
			row.lease_owner === lease.owner &&
			row.generation === lease.generation &&
			!!row.expires_at &&
			Date.parse(row.expires_at) > now
		);
	}
}
