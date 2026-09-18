import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
	containsSecretLikeText,
	findByOperationId,
	type Goal,
	nextGoalId,
	operationMatches,
	parseGoalsFile,
	renderGoalsFile,
} from "../contracts/index.js";

export interface GoalOperationRequest {
	operationId: string;
	sourceUrl: string;
	now: Date;
}

export interface RecordGoalRequest extends GoalOperationRequest {
	text: string;
}

export interface WithdrawGoalRequest extends GoalOperationRequest {
	goalId: string;
}

export interface GoalOpResult {
	goal: Goal;
	outcome: "recorded" | "withdrawn" | "replayed";
	push: "pushed" | "local_only" | "unknown";
	externalWrite: boolean;
	indexSync: "ok" | "failed";
}

export interface GitCommandOptions {
	cwd: string;
	timeoutMs: number;
	env?: Record<string, string>;
	input?: string;
}

export type GitRunner = (
	argv: readonly string[],
	options: GitCommandOptions,
) => Promise<string>;

export interface GoalStoreOptions {
	goalsFile: string;
	gitBin: string;
	commandTimeoutMs: number;
	run?: GitRunner;
	onEvent?: (name: string, details?: Record<string, unknown>) => void;
	nowMs?: () => number;
}

interface RepositoryContext {
	toplevel: string;
	relpath: string;
}

interface Preimage {
	existed: boolean;
	content: string;
}

export class GoalStoreError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = "GoalStoreError";
	}
}

function commandTimedOut(error: unknown): boolean {
	const candidate = error as NodeJS.ErrnoException & { killed?: boolean };
	return (
		candidate?.code === "ETIMEDOUT" ||
		candidate?.name === "TimeoutError" ||
		candidate?.killed === true
	);
}

function indexBlob(output: string): string | null {
	const line = output.trim();
	if (!line) return null;
	const match = /^100644 ([0-9a-f]{40,64}) 0\t/.exec(line);
	return match?.[1] ?? null;
}

function contains(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export class GoalStore {
	private readonly run: GitRunner;
	private readonly onEvent: NonNullable<GoalStoreOptions["onEvent"]>;
	private readonly nowMs: () => number;
	private tail: Promise<void> = Promise.resolve();

	constructor(private readonly options: GoalStoreOptions) {
		if (!options.run) throw new Error("host command adapter required");
		this.run = options.run;
		this.onEvent = options.onEvent ?? (() => {});
		this.nowMs = options.nowMs ?? Date.now;
	}

	record(request: RecordGoalRequest): Promise<GoalOpResult> {
		return this.serialized(() => this.mutate("record", request));
	}

	withdraw(request: WithdrawGoalRequest): Promise<GoalOpResult> {
		return this.serialized(() => this.mutate("withdraw", request));
	}

	preflight(): Promise<Goal[]> {
		return this.serialized(async () => {
			const repository = await this.prepareRepository();
			try {
				const name = await this.git(repository, [
					"config",
					"--get",
					"user.name",
				]);
				const email = await this.git(repository, [
					"config",
					"--get",
					"user.email",
				]);
				if (!name.trim() || !email.trim()) throw new Error("missing identity");
			} catch {
				throw new GoalStoreError("goal_repo_identity");
			}
			return this.readGoals();
		});
	}

	private serialized<T>(work: () => Promise<T>): Promise<T> {
		const operation = this.tail.then(work, work);
		this.tail = operation.then(
			() => {},
			() => {},
		);
		return operation;
	}

	private async mutate(
		kind: "record" | "withdraw",
		request: RecordGoalRequest | WithdrawGoalRequest,
	): Promise<GoalOpResult> {
		const repository = await this.prepareRepository();
		const goals = this.readGoals();
		const existing = findByOperationId(goals, request.operationId);
		const operation =
			kind === "record"
				? {
						kind,
						text: (request as RecordGoalRequest).text,
						sourceUrl: request.sourceUrl,
					}
				: {
						kind,
						goalId: (request as WithdrawGoalRequest).goalId,
						sourceUrl: request.sourceUrl,
					};
		if (existing) {
			if (!operationMatches(existing, operation)) {
				throw new GoalStoreError("goal_operation_conflict");
			}
			return {
				goal: existing,
				outcome: "replayed",
				push: "unknown",
				externalWrite: false,
				indexSync: "ok",
			};
		}

		let goal: Goal;
		if (kind === "record") {
			const text = (request as RecordGoalRequest).text;
			if (containsSecretLikeText(text)) {
				throw new GoalStoreError("goal_rejected_secret_like");
			}
			goal = {
				id: nextGoalId(goals, request.now.toISOString().slice(0, 10)),
				operationId: request.operationId,
				recordedAt: request.now.toISOString(),
				sourceUrl: request.sourceUrl,
				status: "active",
				text,
			};
			goals.push(goal);
		} else {
			const goalId = (request as WithdrawGoalRequest).goalId;
			const index = goals.findIndex((candidate) => candidate.id === goalId);
			const current = goals[index];
			if (!current || current.status !== "active") {
				throw new GoalStoreError("goal_not_active");
			}
			goal = {
				...current,
				status: "withdrawn",
				withdrawnAt: request.now.toISOString(),
				withdrawnSourceUrl: request.sourceUrl,
				withdrawOperationId: request.operationId,
			};
			goals[index] = goal;
		}

		const content = renderGoalsFile(goals);
		parseGoalsFile(content);
		const preimage = this.capturePreimage();
		this.atomicWrite(content);
		return this.commit(repository, preimage, content, goal, kind);
	}

	private async prepareRepository(): Promise<RepositoryContext> {
		const memoryDir = dirname(this.options.goalsFile);
		let toplevel: string;
		try {
			toplevel = realpathSync(
				(
					await this.run(
						[
							this.options.gitBin,
							"-C",
							memoryDir,
							"rev-parse",
							"--show-toplevel",
						],
						{
							cwd: memoryDir,
							timeoutMs: this.options.commandTimeoutMs,
						},
					)
				).trim(),
			);
		} catch {
			throw new GoalStoreError("goal_repo_missing");
		}
		const canonicalMemoryDir = realpathSync(memoryDir);
		const goalsFile = join(
			canonicalMemoryDir,
			basename(this.options.goalsFile),
		);
		if (
			!contains(toplevel, canonicalMemoryDir) ||
			!contains(toplevel, goalsFile)
		) {
			throw new GoalStoreError("goal_repo_missing");
		}
		const repository = {
			toplevel,
			relpath: relative(toplevel, goalsFile),
		};
		const status = await this.git(repository, [
			"status",
			"--porcelain",
			"--",
			repository.relpath,
		]);
		const corruptPath = status.trim()
			? await this.findCorruptQuarantine(repository)
			: null;
		if (corruptPath) {
			this.onEvent("goals_corrupt", { corruptPath });
			throw new GoalStoreError("goals_corrupt");
		}
		if (status.trim() && !(await this.reconcileOwnIndexSkew(repository))) {
			throw new GoalStoreError("goal_dirty_tree");
		}
		const verifiedStatus = await this.git(repository, [
			"status",
			"--porcelain",
			"--",
			repository.relpath,
		]);
		if (verifiedStatus.trim()) throw new GoalStoreError("goal_dirty_tree");
		return repository;
	}

	private async findCorruptQuarantine(
		repository: RepositoryContext,
	): Promise<string | null> {
		if (existsSync(this.options.goalsFile)) return null;
		const committed = await this.tryGit(repository, [
			"show",
			`HEAD:${repository.relpath}`,
		]);
		if (committed === null) return null;
		try {
			parseGoalsFile(committed);
			return null;
		} catch {
			const directory = dirname(this.options.goalsFile);
			const prefix = `${basename(this.options.goalsFile)}.corrupt-`;
			const candidates = readdirSync(directory)
				.filter((name) => name.startsWith(prefix))
				.sort()
				.reverse();
			for (const name of candidates) {
				const path = join(directory, name);
				try {
					if (readFileSync(path, "utf8") === committed) return path;
				} catch {
					// Ignore unrelated or unreadable quarantine-shaped entries.
				}
			}
			return null;
		}
	}

	private async reconcileOwnIndexSkew(
		repository: RepositoryContext,
	): Promise<boolean> {
		if (!existsSync(this.options.goalsFile)) return false;
		const message = await this.tryGit(repository, ["log", "-1", "--format=%B"]);
		if (
			!message ||
			!/^goal: (record|withdraw) g-\d{8}-\d{2} \S+:(record|withdraw):\d+ \(FLY-2381\)$/m.test(
				message.trim(),
			)
		) {
			return false;
		}
		const headBlob = await this.tryGit(repository, [
			"rev-parse",
			`HEAD:${repository.relpath}`,
		]);
		const worktreeBlob = await this.tryGit(repository, [
			"hash-object",
			this.options.goalsFile,
		]);
		if (!headBlob || worktreeBlob?.trim() !== headBlob.trim()) return false;
		const committed = await this.tryGit(repository, [
			"show",
			`HEAD:${repository.relpath}`,
		]);
		if (!committed) return false;
		try {
			parseGoalsFile(committed);
		} catch {
			return false;
		}
		const index = indexBlob(
			(await this.tryGit(repository, [
				"ls-files",
				"-s",
				"--",
				repository.relpath,
			])) ?? "",
		);
		const parentBlob = (
			await this.tryGit(repository, [
				"rev-parse",
				`HEAD^:${repository.relpath}`,
			])
		)?.trim();
		if (index !== (parentBlob ?? null)) return false;
		await this.git(repository, [
			"update-index",
			"--add",
			"--cacheinfo",
			`100644,${headBlob.trim()},${repository.relpath}`,
		]);
		this.onEvent("goal_index_reconciled", { goal: repository.relpath });
		return true;
	}

	private readGoals(): Goal[] {
		if (!existsSync(this.options.goalsFile)) return [];
		const content = readFileSync(this.options.goalsFile, "utf8");
		try {
			return parseGoalsFile(content);
		} catch {
			const corruptPath = `${this.options.goalsFile}.corrupt-${this.nowMs()}`;
			renameSync(this.options.goalsFile, corruptPath);
			this.onEvent("goals_corrupt", { corruptPath });
			throw new GoalStoreError("goals_corrupt");
		}
	}

	private capturePreimage(): Preimage {
		return existsSync(this.options.goalsFile)
			? {
					existed: true,
					content: readFileSync(this.options.goalsFile, "utf8"),
				}
			: { existed: false, content: "" };
	}

	private restorePreimage(preimage: Preimage): void {
		if (preimage.existed) this.atomicWrite(preimage.content);
		else if (existsSync(this.options.goalsFile))
			unlinkSync(this.options.goalsFile);
	}

	private atomicWrite(content: string): void {
		const temporary = `${this.options.goalsFile}.tmp-${process.pid}-${this.nowMs()}`;
		const descriptor = openSync(temporary, "w", 0o600);
		try {
			writeFileSync(descriptor, content, "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(temporary, this.options.goalsFile);
		chmodSync(this.options.goalsFile, 0o600);
	}

	private async commit(
		repository: RepositoryContext,
		preimage: Preimage,
		content: string,
		goal: Goal,
		kind: "record" | "withdraw",
	): Promise<GoalOpResult> {
		let branch: string;
		try {
			branch = (
				await this.git(repository, ["symbolic-ref", "--short", "HEAD"])
			).trim();
			if (!branch) throw new Error("detached");
		} catch {
			this.restorePreimage(preimage);
			throw new GoalStoreError("goal_repo_detached");
		}
		const oldHead =
			(await this.tryGit(repository, ["rev-parse", "HEAD"]))?.trim() ?? null;
		const message = `goal: ${kind} ${goal.id} ${kind === "record" ? goal.operationId : goal.withdrawOperationId} (FLY-2381)`;
		const temporaryRoot = mkdtempSync(join(tmpdir(), "raya-goal-index-"));
		const temporaryIndex = join(temporaryRoot, "index");
		let blob: string;
		let newHead: string;
		try {
			blob = (
				await this.git(repository, ["hash-object", "-w", "--stdin"], {
					input: content,
				})
			).trim();
			const env = { GIT_INDEX_FILE: temporaryIndex };
			await this.git(
				repository,
				oldHead ? ["read-tree", oldHead] : ["read-tree", "--empty"],
				{ env },
			);
			await this.git(
				repository,
				[
					"update-index",
					"--add",
					"--cacheinfo",
					`100644,${blob},${repository.relpath}`,
				],
				{ env },
			);
			const tree = (await this.git(repository, ["write-tree"], { env })).trim();
			newHead = (
				await this.git(repository, [
					"commit-tree",
					tree,
					...(oldHead ? ["-p", oldHead] : []),
					"-m",
					message,
				])
			).trim();
		} catch {
			this.restorePreimage(preimage);
			throw new GoalStoreError("goal_commit_failed");
		} finally {
			rmSync(temporaryRoot, { recursive: true, force: true });
		}

		try {
			await this.git(repository, [
				"update-ref",
				"-m",
				message,
				`refs/heads/${branch}`,
				newHead,
				...(oldHead ? [oldHead] : []),
			]);
		} catch (error) {
			if (commandTimedOut(error)) {
				const verdict = await this.verifyCommit(
					repository,
					oldHead,
					newHead,
					blob,
					requestOperationId(goal, kind),
				);
				if (verdict === "valid") {
					return this.syncIndexAndPush(repository, blob, goal, kind);
				}
				if (verdict === "old") {
					this.restorePreimage(preimage);
					throw new GoalStoreError("goal_commit_failed");
				}
			} else {
				this.restorePreimage(preimage);
			}
			throw new GoalStoreError("goal_head_moved");
		}

		const verdict = await this.verifyCommit(
			repository,
			oldHead,
			newHead,
			blob,
			requestOperationId(goal, kind),
		);
		if (verdict !== "valid") {
			if (verdict === "invalid") {
				try {
					if (oldHead) {
						await this.git(repository, [
							"update-ref",
							`refs/heads/${branch}`,
							oldHead,
							newHead,
						]);
					} else {
						await this.git(repository, [
							"update-ref",
							"-d",
							`refs/heads/${branch}`,
							newHead,
						]);
					}
					this.restorePreimage(preimage);
				} catch {
					throw new GoalStoreError("goal_head_moved");
				}
				throw new GoalStoreError("goal_commit_verify_failed");
			}
			throw new GoalStoreError("goal_head_moved");
		}
		return this.syncIndexAndPush(repository, blob, goal, kind);
	}

	private async verifyCommit(
		repository: RepositoryContext,
		oldHead: string | null,
		newHead: string,
		blob: string,
		operationId: string,
	): Promise<"valid" | "old" | "moved" | "invalid"> {
		const head = (await this.tryGit(repository, ["rev-parse", "HEAD"]))?.trim();
		if (head !== newHead) return head === oldHead ? "old" : "moved";
		const parent = oldHead
			? (await this.tryGit(repository, ["rev-parse", "HEAD^"]))?.trim()
			: null;
		const headBlob = (
			await this.tryGit(repository, ["rev-parse", `HEAD:${repository.relpath}`])
		)?.trim();
		const message = await this.tryGit(repository, ["log", "-1", "--format=%B"]);
		return parent === oldHead &&
			headBlob === blob &&
			message?.includes(operationId)
			? "valid"
			: "invalid";
	}

	private async syncIndexAndPush(
		repository: RepositoryContext,
		blob: string,
		goal: Goal,
		kind: "record" | "withdraw",
	): Promise<GoalOpResult> {
		try {
			await this.git(repository, [
				"update-index",
				"--add",
				"--cacheinfo",
				`100644,${blob},${repository.relpath}`,
			]);
			const indexed = indexBlob(
				await this.git(repository, [
					"ls-files",
					"-s",
					"--",
					repository.relpath,
				]),
			);
			if (indexed !== blob) throw new Error("index mismatch");
		} catch {
			this.onEvent("goal_index_sync_failed", { goalId: goal.id });
			return {
				goal,
				outcome: kind === "record" ? "recorded" : "withdrawn",
				push: "unknown",
				externalWrite: false,
				indexSync: "failed",
			};
		}

		const worktreeBlob = (
			await this.tryGit(repository, ["hash-object", this.options.goalsFile])
		)?.trim();
		const externalWrite = worktreeBlob !== blob;
		if (externalWrite) {
			this.onEvent("goal_external_write", { goalId: goal.id });
		} else {
			const status = await this.git(repository, [
				"status",
				"--porcelain",
				"--",
				repository.relpath,
			]);
			if (status.trim()) {
				this.onEvent("goal_index_sync_failed", { goalId: goal.id });
				return {
					goal,
					outcome: kind === "record" ? "recorded" : "withdrawn",
					push: "unknown",
					externalWrite: false,
					indexSync: "failed",
				};
			}
		}

		let push: GoalOpResult["push"];
		try {
			await this.git(repository, ["push"]);
			push = "pushed";
		} catch (error) {
			push = commandTimedOut(error) ? "unknown" : "local_only";
			this.onEvent("goal_push_failed", { goalId: goal.id, push });
		}
		return {
			goal,
			outcome: kind === "record" ? "recorded" : "withdrawn",
			push,
			externalWrite,
			indexSync: "ok",
		};
	}

	private git(
		repository: RepositoryContext,
		args: string[],
		extra: Pick<GitCommandOptions, "env" | "input"> = {},
	): Promise<string> {
		return this.run([this.options.gitBin, ...args], {
			cwd: repository.toplevel,
			timeoutMs: this.options.commandTimeoutMs,
			...extra,
		});
	}

	private async tryGit(
		repository: RepositoryContext,
		args: string[],
	): Promise<string | null> {
		try {
			return await this.git(repository, args);
		} catch {
			return null;
		}
	}
}

function requestOperationId(goal: Goal, kind: "record" | "withdraw"): string {
	return kind === "record"
		? goal.operationId
		: (goal.withdrawOperationId ?? "");
}
