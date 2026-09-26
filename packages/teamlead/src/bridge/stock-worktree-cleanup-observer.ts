import { execFile } from "node:child_process";
import { lstat, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { type CwdRow, listSystemCwds } from "flywheel-edge-worker";
import type { ProjectEntry } from "../ProjectConfig.js";
import {
	buildStockCleanupPreview,
	type StockCleanupBodyObservation,
	type StockCleanupObservedTarget,
	type StockCleanupPrState,
} from "./stock-worktree-cleanup.js";

const SHA = /^[0-9a-f]{40}$/i;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_WORKTREES = 10_000;
const MAX_NESTED_ENTRIES = 500_000;
const MAX_NESTED_DEPTH = 80;

export interface RegisteredWorktreeObservation {
	path: string;
	head: string;
	branch?: string;
	detached: boolean;
	locked: boolean;
}

export type StockCleanupGitExec = (
	args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

interface StockCleanupStore {
	listWorktreeBindings(projectName: string): Array<{
		execution_id: string;
		status: string;
		path: string;
		branch: string;
		generation: string;
	}>;
	getSession(executionId: string):
		| {
				execution_id: string;
				issue_id: string;
				issue_identifier?: string;
				project_name: string;
				status: string;
				pr_number?: number;
				pr_head_sha?: string;
		  }
		| undefined;
	getWorkflowExecutionBinding(
		executionId: string,
	): { activation_id: string } | undefined;
}

export interface StockCleanupPullObservation {
	number: number;
	state: StockCleanupPrState;
	headRef?: string;
	headSha?: string;
	baseRef?: string;
	mergeCommitSha?: string;
	mergedAt?: string;
}

export interface StockCleanupTerminalAuthority {
	state: "valid" | "missing" | "changed";
	identity?: string;
	reason?: string;
	operationId?: string;
}

export interface StockCleanupPreviewerDeps {
	projects: Array<
		Pick<ProjectEntry, "projectName" | "projectRoot" | "projectRepo">
	>;
	store: StockCleanupStore;
	readGeneration(path: string): Promise<string | null | undefined>;
	inspectPullRequest(input: {
		repoSlug: string;
		prNumber: number;
	}): Promise<StockCleanupPullObservation>;
	compareCommits(input: {
		repoSlug: string;
		base: string;
		head: string;
	}): Promise<"ahead" | "behind" | "diverged" | "identical" | "unknown">;
	observeBody?: (input: {
		executionId: string;
		activationId: string;
	}) => Promise<StockCleanupBodyObservation>;
	resolveTerminalAuthority(input: {
		projectName: string;
		canonicalPath: string;
		branch?: string;
		generation?: string;
		head?: string;
		issueId?: string;
		pr?: StockCleanupPullObservation;
		executionIds: string[];
	}): StockCleanupTerminalAuthority;
	gitExec?: StockCleanupGitExec;
	listCwds?: () => Promise<CwdRow[]>;
	now?: () => Date;
}

function normalizeRepoIdentity(value: string): string | undefined {
	const trimmed = value.trim().replace(/\.git$/i, "");
	if (REPO.test(trimmed)) return trimmed.toLowerCase();
	const scp = trimmed.match(/^git@github\.com:([^/]+\/[^/]+)$/i)?.[1];
	if (scp && REPO.test(scp)) return scp.toLowerCase();
	try {
		const parsed = new URL(trimmed);
		if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
		const slug = parsed.pathname.replace(/^\/+/, "");
		return REPO.test(slug) ? slug.toLowerCase() : undefined;
	} catch {
		return undefined;
	}
}

function defaultGitExec(args: string[]): Promise<{
	code: number;
	stdout: string;
	stderr: string;
}> {
	return new Promise((resolveResult) => {
		execFile(
			"git",
			args,
			{
				encoding: "utf8",
				timeout: 60_000,
				maxBuffer: 64 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				resolveResult({
					code:
						error && typeof (error as { code?: unknown }).code === "number"
							? ((error as { code: number }).code ?? 1)
							: error
								? 1
								: 0,
					stdout: stdout ?? "",
					stderr: stderr ?? "",
				});
			},
		);
	});
}

export function parseRegisteredWorktrees(
	output: string,
): RegisteredWorktreeObservation[] {
	if (Buffer.byteLength(output, "utf8") > 64 * 1024 * 1024)
		throw new Error("worktree_inventory_too_large");
	const records: RegisteredWorktreeObservation[] = [];
	let current: Partial<RegisteredWorktreeObservation> | undefined;
	const finish = () => {
		if (!current) return;
		if (
			typeof current.path !== "string" ||
			!isAbsolute(current.path) ||
			typeof current.head !== "string" ||
			!SHA.test(current.head) ||
			records.length >= MAX_WORKTREES
		) {
			throw new Error("worktree_inventory_invalid");
		}
		records.push({
			path: resolve(current.path),
			head: current.head.toLowerCase(),
			...(current.branch ? { branch: current.branch } : {}),
			detached: current.detached === true,
			locked: current.locked === true,
		});
		current = undefined;
	};
	for (const field of output.split("\0")) {
		if (!field) {
			finish();
			continue;
		}
		const space = field.indexOf(" ");
		const key = space < 0 ? field : field.slice(0, space);
		const value = space < 0 ? "" : field.slice(space + 1);
		if (key === "worktree") {
			finish();
			current = { path: value, detached: false, locked: false };
			continue;
		}
		if (!current) throw new Error("worktree_inventory_invalid");
		if (key === "HEAD") current.head = value;
		else if (key === "branch") {
			if (!value.startsWith("refs/heads/"))
				throw new Error("worktree_inventory_invalid_branch");
			current.branch = value.slice("refs/heads/".length);
		} else if (key === "detached") current.detached = true;
		else if (key === "locked") current.locked = true;
		else if (key !== "prunable" && key !== "bare")
			throw new Error("worktree_inventory_unknown_field");
	}
	finish();
	const unique = new Set(records.map((record) => record.path));
	if (unique.size !== records.length)
		throw new Error("worktree_inventory_duplicate_path");
	return records;
}

function isDescendant(root: string, candidate: string): boolean {
	const suffix = relative(root, candidate);
	return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}

export async function scanNestedRepositories(
	root: string,
	registeredPaths: string[],
): Promise<"clear" | "present" | "unknown"> {
	const canonicalRoot = resolve(root);
	if (
		registeredPaths.some(
			(candidate) =>
				resolve(candidate) !== canonicalRoot &&
				isDescendant(canonicalRoot, resolve(candidate)),
		)
	) {
		return "present";
	}
	let seen = 0;
	const pending: Array<{ path: string; depth: number }> = [
		{ path: canonicalRoot, depth: 0 },
	];
	try {
		while (pending.length > 0) {
			const current = pending.pop()!;
			if (current.depth > MAX_NESTED_DEPTH) return "unknown";
			const directory = await opendir(current.path);
			for await (const entry of directory) {
				seen += 1;
				if (seen > MAX_NESTED_ENTRIES) return "unknown";
				if (entry.name === ".git") {
					if (current.depth === 0) continue;
					return "present";
				}
				if (entry.isSymbolicLink()) continue;
				if (entry.isDirectory()) {
					pending.push({
						path: resolve(current.path, entry.name),
						depth: current.depth + 1,
					});
				}
			}
		}
		return "clear";
	} catch {
		return "unknown";
	}
}

function cwdState(
	path: string,
	rows: CwdRow[] | null,
): StockCleanupObservedTarget["processCensus"] {
	if (!rows) return { state: "unknown", reason: "cwd_census_failed" };
	const pids = rows
		.filter(
			(row) =>
				row.logicalCwd === path ||
				(row.logicalCwd !== null && isDescendant(path, row.logicalCwd)),
		)
		.map((row) => row.pid)
		.filter((pid, index, values) => values.indexOf(pid) === index)
		.sort((a, b) => a - b);
	return pids.length > 0
		? { state: "present", observedAt: new Date().toISOString(), pids }
		: { state: "clear", observedAt: new Date().toISOString() };
}

function unknownBody(
	executionId: string,
	activationId: string,
	reason: string,
): StockCleanupBodyObservation {
	return {
		executionId,
		activationId,
		state: "unknown",
		source: "execution-body-liveness/unavailable",
		reason,
	};
}

export function createStockCleanupPreviewer(deps: StockCleanupPreviewerDeps): {
	preview(input: {
		projectName: string;
		actor: string;
		authorityCheck: () => void | Promise<void>;
	}): Promise<ReturnType<typeof buildStockCleanupPreview>>;
} {
	const gitExec = deps.gitExec ?? defaultGitExec;
	const listCwds = deps.listCwds ?? listSystemCwds;
	const now = deps.now ?? (() => new Date());
	return {
		async preview(input) {
			await input.authorityCheck();
			const project = deps.projects.find(
				(candidate) => candidate.projectName === input.projectName,
			);
			if (!project?.projectRepo || !normalizeRepoIdentity(project.projectRepo))
				throw new Error("stock_cleanup_project_unconfigured");
			const inventoryResult = await gitExec([
				"-C",
				project.projectRoot,
				"worktree",
				"list",
				"--porcelain",
				"-z",
			]);
			if (inventoryResult.code !== 0)
				throw new Error("worktree_inventory_unavailable");
			const inventory = parseRegisteredWorktrees(inventoryResult.stdout);
			const canonicalProjectRoot = await realpath(project.projectRoot);
			let cwdRows: CwdRow[] | null = null;
			try {
				cwdRows = await listCwds();
			} catch {
				cwdRows = null;
			}
			const bindings = await Promise.all(
				deps.store
					.listWorktreeBindings(input.projectName)
					.map(async (binding) => {
						try {
							return {
								...binding,
								canonicalPath: await realpath(binding.path),
							};
						} catch {
							return { ...binding, canonicalPath: resolve(binding.path) };
						}
					}),
			);
			const observedAt = now().toISOString();
			const targets: StockCleanupObservedTarget[] = [];
			for (const registered of inventory) {
				await input.authorityCheck();
				let canonicalPath = registered.path;
				let parentIdentity: { dev: string; ino: string } | undefined;
				let leafIdentity: { dev: string; ino: string } | undefined;
				try {
					const [canonical, parent, leaf] = await Promise.all([
						realpath(registered.path),
						lstat(dirname(registered.path), { bigint: true }),
						lstat(registered.path, { bigint: true }),
					]);
					canonicalPath = canonical;
					if (!leaf.isSymbolicLink() && leaf.isDirectory()) {
						parentIdentity = {
							dev: String(parent.dev),
							ino: String(parent.ino),
						};
						leafIdentity = { dev: String(leaf.dev), ino: String(leaf.ino) };
					}
				} catch {
					// The pure classifier treats absent identities as an identity conflict.
				}
				if (canonicalPath === canonicalProjectRoot) continue;

				const targetBindings = bindings.filter(
					(binding) => binding.canonicalPath === canonicalPath,
				);
				const sessions = targetBindings
					.map((binding) => deps.store.getSession(binding.execution_id))
					.filter((session): session is NonNullable<typeof session> =>
						Boolean(session),
					);
				const issueIds = [
					...new Set(sessions.map((session) => session.issue_id)),
				];
				const issueIdentifiers = [
					...new Set(
						sessions
							.map((session) => session.issue_identifier)
							.filter((value): value is string => Boolean(value)),
					),
				];
				const prNumbers = [
					...new Set(
						sessions
							.map((session) => session.pr_number)
							.filter((value): value is number => Number.isSafeInteger(value)),
					),
				];
				let pr: StockCleanupPullObservation | undefined;
				if (prNumbers.length === 1) {
					try {
						pr = await deps.inspectPullRequest({
							repoSlug: project.projectRepo,
							prNumber: prNumbers[0]!,
						});
					} catch {
						pr = { number: prNumbers[0]!, state: "UNKNOWN" };
					}
				}

				let generation: string | undefined;
				try {
					generation = (await deps.readGeneration(canonicalPath)) ?? undefined;
				} catch {
					generation = undefined;
				}
				const bodyObservations: StockCleanupBodyObservation[] = [];
				const boundTargets: StockCleanupObservedTarget["bindings"] = [];
				for (const binding of targetBindings) {
					const activationId =
						deps.store.getWorkflowExecutionBinding(binding.execution_id)
							?.activation_id ?? "";
					boundTargets.push({
						executionId: binding.execution_id,
						activationId,
						path: binding.canonicalPath,
						branch: binding.branch,
						generation: binding.generation,
					});
					if (!deps.observeBody || !activationId) {
						bodyObservations.push(
							unknownBody(
								binding.execution_id,
								activationId,
								deps.observeBody
									? "activation_identity_ambiguous"
									: "provider_unavailable",
							),
						);
						continue;
					}
					try {
						bodyObservations.push(
							await deps.observeBody({
								executionId: binding.execution_id,
								activationId,
							}),
						);
					} catch {
						bodyObservations.push(
							unknownBody(binding.execution_id, activationId, "provider_error"),
						);
					}
				}

				let clean: boolean | undefined;
				const status = await gitExec([
					"-C",
					canonicalPath,
					"status",
					"--porcelain=v1",
					"--untracked-files=all",
					"--ignore-submodules=none",
					"--",
				]);
				if (status.code === 0) clean = status.stdout.length === 0;
				const nestedRepository = await scanNestedRepositories(
					canonicalPath,
					inventory.map((candidate) => candidate.path),
				);

				let remoteProof: StockCleanupObservedTarget["remoteProof"] = {
					state: "unknown",
					reason: "remote_proof_unavailable",
				};
				const remote = await gitExec([
					"-C",
					project.projectRoot,
					"remote",
					"get-url",
					"origin",
				]);
				if (
					remote.code === 0 &&
					normalizeRepoIdentity(remote.stdout) ===
						normalizeRepoIdentity(project.projectRepo)
				) {
					if (
						pr?.state === "MERGED" &&
						pr.headSha?.toLowerCase() === registered.head &&
						Boolean(
							pr.mergedAt && pr.baseRef && SHA.test(pr.mergeCommitSha ?? ""),
						)
					) {
						remoteProof = {
							state: "preserved",
							kind: "merged_exact_head",
							observedHead: registered.head,
							observedAt,
						};
					} else if (pr?.state === "CLOSED" && pr.headRef) {
						const advertised = await gitExec([
							"-C",
							project.projectRoot,
							"ls-remote",
							"--heads",
							"origin",
							`refs/heads/${pr.headRef}`,
						]);
						const tip = advertised.stdout.split(/\s+/)[0]?.toLowerCase() ?? "";
						if (advertised.code === 0 && SHA.test(tip)) {
							const comparison =
								tip === registered.head
									? "identical"
									: await deps.compareCommits({
											repoSlug: project.projectRepo,
											base: registered.head,
											head: tip,
										});
							if (comparison === "identical" || comparison === "ahead") {
								remoteProof = {
									state: "preserved",
									kind: "remote_ref_contains_head",
									observedHead: tip,
									observedAt,
								};
							} else {
								remoteProof = {
									state: "missing",
									reason: "remote_ref_does_not_contain_head",
								};
							}
						}
					}
				}

				const authority = deps.resolveTerminalAuthority({
					projectName: input.projectName,
					canonicalPath,
					branch: registered.branch,
					generation,
					head: registered.head,
					issueId: issueIds.length === 1 ? issueIds[0] : undefined,
					pr,
					executionIds: targetBindings.map((binding) => binding.execution_id),
				});
				targets.push({
					projectName: input.projectName,
					repoSlug: project.projectRepo,
					canonicalPath,
					parentIdentity,
					leafIdentity,
					generation,
					branch: registered.branch,
					head: registered.head,
					locked: registered.locked,
					detached: registered.detached,
					issueId: issueIds.length === 1 ? issueIds[0] : undefined,
					issueIdentifier:
						issueIdentifiers.length === 1 ? issueIdentifiers[0] : undefined,
					operationId: authority.operationId,
					pr,
					bindings: boundTargets,
					bodyObservations,
					clean,
					nestedRepository,
					remoteProof,
					processCensus: cwdState(canonicalPath, cwdRows),
					terminalAuthority:
						authority.state === "valid" && authority.identity
							? { state: "valid", identity: authority.identity }
							: authority.state === "changed"
								? {
										state: "changed",
										reason: authority.reason ?? "authority_changed",
									}
								: {
										state: "missing",
										reason: authority.reason ?? "terminal_authority_missing",
									},
				});
			}
			await input.authorityCheck();
			return buildStockCleanupPreview({
				projectName: input.projectName,
				observedAt,
				targets,
			});
		},
	};
}
