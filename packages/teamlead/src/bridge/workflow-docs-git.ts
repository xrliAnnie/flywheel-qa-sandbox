import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAsyncExecFile } from "flywheel-claude-runner";
import {
	assertPushableBranch,
	GIT_PUSH_SAFE_CONFIG,
	parseOwnerRepo,
} from "../lead-backends/codex/gateway/GitPushRunner.js";
import type { WorkflowDocsGit } from "./workflow-docs-materializer.js";

interface GitResult {
	status: number;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
}

export interface GitWorkflowDocsGitOptions {
	gitPath?: string;
	token?: string;
	remoteUrl?: (repo: string) => string;
	/** Test seam; production network Git calls are capped at 10 seconds. */
	networkTimeoutMs?: number;
	/** Wall-span attribution sink; async child operations never hold sync markers. */
	recordSpan?: (name: string, startMs: number, endMs: number) => void;
}

const SHA_RE = /^[0-9a-f]{40}$/;

export function yieldToTimers(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function gitSubcommand(args: string[]): string {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "-c" || arg === "-C" || arg === "--git-dir") {
			index += 1;
			continue;
		}
		if (arg.startsWith("--git-dir=") || arg.startsWith("-")) continue;
		return arg;
	}
	return "git";
}

export class GitWorkflowDocsGit implements WorkflowDocsGit {
	private readonly gitPath: string;
	private readonly token: string | undefined;
	private readonly remoteUrl: (repo: string) => string;
	private readonly networkTimeoutMs: number;
	private readonly recordSpan:
		| ((name: string, startMs: number, endMs: number) => void)
		| undefined;
	private askpassPath: string | undefined;

	constructor(options: GitWorkflowDocsGitOptions = {}) {
		this.gitPath = options.gitPath ?? "/usr/bin/git";
		this.token =
			options.token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
		this.networkTimeoutMs = options.networkTimeoutMs ?? 10_000;
		this.recordSpan = options.recordSpan;
		this.remoteUrl =
			options.remoteUrl ??
			((repo) => {
				const parsed = parseOwnerRepo(repo);
				return `https://github.com/${parsed.owner}/${parsed.repo}.git`;
			});
	}

	async resolveBaseHead(input: {
		projectRoot: string;
		repo: string;
		ref: string;
	}): Promise<string> {
		const remote = this.validatedRemote(input.repo, input.ref);
		const branch = await this.remoteHead(input.projectRoot, remote, input.ref);
		await yieldToTimers();
		const base =
			branch ?? (await this.remoteHead(input.projectRoot, remote, "HEAD"));
		if (!branch) await yieldToTimers();
		if (!base) throw new Error("materializer_remote_base_unavailable");
		await this.runNetworkOrThrow(
			["fetch", "--quiet", "--no-tags", remote, base],
			input.projectRoot,
			undefined,
			undefined,
			"materializer fetch base",
		);
		await this.runOrThrow(
			["cat-file", "-e", `${base}^{commit}`],
			input.projectRoot,
			undefined,
			undefined,
			"materializer verify base",
		);
		return base;
	}

	async prepareOrAdoptCommit(input: {
		projectRoot: string;
		repo: string;
		ref: string;
		baseHead: string;
		effectId: string;
		outputDigest: string;
		payload: Parameters<WorkflowDocsGit["prepareOrAdoptCommit"]>[0]["payload"];
	}): Promise<{ treeHead: string; commitHead: string }> {
		this.validatedRemote(input.repo, input.ref);
		this.assertSha(input.baseHead, "base head");
		if (!/^mat:[0-9a-f]{64}$/.test(input.effectId)) {
			throw new Error("materializer effect id invalid");
		}
		if (!/^[0-9a-f]{64}$/.test(input.outputDigest)) {
			throw new Error("materializer output digest invalid");
		}
		const deterministicRef = `refs/flywheel/materializations/${input.effectId.slice(4)}`;
		for (const operation of input.payload.operations) {
			await this.assertNoSymlinkAncestor(
				input.projectRoot,
				input.baseHead,
				operation.path,
			);
		}
		const indexDir = mkdtempSync(join(tmpdir(), "flywheel-doc-index-"));
		const indexPath = join(indexDir, "index");
		const indexEnv = { GIT_INDEX_FILE: indexPath };
		let treeHead: string;
		try {
			await this.runOrThrow(
				["read-tree", input.baseHead],
				input.projectRoot,
				indexEnv,
				undefined,
				"materializer read base tree",
			);
			for (const operation of input.payload.operations) {
				if (operation.op === "delete") {
					await this.runOrThrow(
						["update-index", "--force-remove", "--", operation.path],
						input.projectRoot,
						indexEnv,
						undefined,
						"materializer delete path",
					);
					continue;
				}
				const blob = (
					await this.runOrThrow(
						["hash-object", "-w", "--no-filters", "--stdin"],
						input.projectRoot,
						undefined,
						operation.content,
						"materializer hash content",
					)
				).stdout.trim();
				this.assertSha(blob, "blob head");
				await this.runOrThrow(
					[
						"update-index",
						"--add",
						"--cacheinfo",
						"100644",
						blob,
						operation.path,
					],
					input.projectRoot,
					indexEnv,
					undefined,
					"materializer write path",
				);
			}
			treeHead = (
				await this.runOrThrow(
					["write-tree"],
					input.projectRoot,
					indexEnv,
					undefined,
					"materializer write tree",
				)
			).stdout.trim();
			this.assertSha(treeHead, "tree head");
		} finally {
			rmSync(indexDir, { recursive: true, force: true });
		}

		const message = [
			"Flywheel docs materialization",
			"",
			`Flywheel-Materialization-Effect: ${input.effectId}`,
			`Flywheel-Output-Digest: ${input.outputDigest}`,
			`Flywheel-Base-Head: ${input.baseHead}`,
		].join("\n");
		const commitEnv = {
			GIT_AUTHOR_NAME: "Flywheel Materializer",
			GIT_AUTHOR_EMAIL: "materializer@flywheel.local",
			GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
			GIT_COMMITTER_NAME: "Flywheel Materializer",
			GIT_COMMITTER_EMAIL: "materializer@flywheel.local",
			GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
		};
		const commitHead = (
			await this.runOrThrow(
				["commit-tree", treeHead, "-p", input.baseHead, "-m", message],
				input.projectRoot,
				commitEnv,
				undefined,
				"materializer create commit",
			)
		).stdout.trim();
		this.assertSha(commitHead, "commit head");
		const update = await this.run(
			["update-ref", deterministicRef, commitHead, "0".repeat(40)],
			input.projectRoot,
		);
		if (update.status !== 0) {
			const winner = await this.readAndValidateCommit(input, deterministicRef);
			if (!winner)
				throw new Error("materializer deterministic ref race failed");
			this.assertExpectedCommit(winner, { treeHead, commitHead });
			return winner;
		}
		const verified = await this.readAndValidateCommit(input, deterministicRef);
		if (!verified) {
			throw new Error("materializer deterministic commit verification failed");
		}
		this.assertExpectedCommit(verified, { treeHead, commitHead });
		return verified;
	}

	async readRemoteHead(input: {
		projectRoot: string;
		repo: string;
		ref: string;
	}): Promise<string | undefined> {
		const remote = this.validatedRemote(input.repo, input.ref);
		return await this.remoteHead(input.projectRoot, remote, input.ref);
	}

	async pushCommit(input: {
		projectRoot: string;
		repo: string;
		ref: string;
		baseHead: string;
		commitHead: string;
	}): Promise<void> {
		const remote = this.validatedRemote(input.repo, input.ref);
		this.assertSha(input.baseHead, "base head");
		this.assertSha(input.commitHead, "commit head");
		const parent = (
			await this.runOrThrow(
				["rev-parse", `${input.commitHead}^`],
				input.projectRoot,
				undefined,
				undefined,
				"materializer verify commit parent",
			)
		).stdout.trim();
		if (parent !== input.baseHead) {
			throw new Error("materializer commit base mismatch");
		}
		const current = await this.remoteHead(input.projectRoot, remote, input.ref);
		if (current === input.commitHead) return;
		if (current !== undefined && current !== input.baseHead) {
			throw new Error("materializer remote ref advanced; stale base refused");
		}
		await yieldToTimers();
		await this.runNetworkOrThrow(
			["push", "--porcelain", remote, `${input.commitHead}:${input.ref}`],
			input.projectRoot,
			undefined,
			undefined,
			"materializer push",
		);
		await yieldToTimers();
		const confirmed = await this.remoteHead(
			input.projectRoot,
			remote,
			input.ref,
		);
		if (confirmed !== input.commitHead) {
			throw new Error("materializer remote head confirmation failed");
		}
	}

	private validatedRemote(repo: string, ref: string): string {
		parseOwnerRepo(repo);
		assertPushableBranch(ref);
		return this.remoteUrl(repo);
	}

	private async remoteHead(
		projectRoot: string,
		remote: string,
		ref: string,
	): Promise<string | undefined> {
		const result = await this.runNetwork(
			["ls-remote", "--exit-code", remote, ref],
			projectRoot,
		);
		if (result.status === 2) return undefined;
		if (result.status !== 0) {
			throw new Error(
				`materializer remote probe failed: ${result.stderr.trim() || `exit ${result.status}`}`,
			);
		}
		const head = result.stdout.trim().split(/\s+/)[0]?.toLowerCase();
		if (!head || !SHA_RE.test(head)) {
			throw new Error("materializer remote returned an invalid head");
		}
		return head;
	}

	private async readAndValidateCommit(
		input: {
			projectRoot: string;
			baseHead: string;
			effectId: string;
			outputDigest: string;
		},
		ref: string,
	): Promise<{ treeHead: string; commitHead: string } | undefined> {
		const found = await this.run(
			["show-ref", "--verify", "--hash", ref],
			input.projectRoot,
		);
		if (found.status !== 0) return undefined;
		const commitHead = found.stdout.trim();
		this.assertSha(commitHead, "adopted commit head");
		const parent = (
			await this.runOrThrow(
				["rev-parse", `${commitHead}^`],
				input.projectRoot,
				undefined,
				undefined,
				"materializer inspect adopted parent",
			)
		).stdout.trim();
		if (parent !== input.baseHead)
			throw new Error("materializer adopted base mismatch");
		const body = (
			await this.runOrThrow(
				["show", "-s", "--format=%B", commitHead],
				input.projectRoot,
				undefined,
				undefined,
				"materializer inspect adopted commit",
			)
		).stdout;
		for (const trailer of [
			`Flywheel-Materialization-Effect: ${input.effectId}`,
			`Flywheel-Output-Digest: ${input.outputDigest}`,
			`Flywheel-Base-Head: ${input.baseHead}`,
		]) {
			if (!body.split(/\r?\n/).includes(trailer)) {
				throw new Error("materializer adopted commit trailer mismatch");
			}
		}
		const treeHead = (
			await this.runOrThrow(
				["rev-parse", `${commitHead}^{tree}`],
				input.projectRoot,
				undefined,
				undefined,
				"materializer inspect adopted tree",
			)
		).stdout.trim();
		this.assertSha(treeHead, "adopted tree head");
		return { treeHead, commitHead };
	}

	private async assertNoSymlinkAncestor(
		projectRoot: string,
		baseHead: string,
		path: string,
	): Promise<void> {
		const segments = path.split("/");
		for (let length = 1; length <= segments.length; length += 1) {
			const prefix = segments.slice(0, length).join("/");
			const row = (
				await this.runOrThrow(
					["ls-tree", baseHead, "--", prefix],
					projectRoot,
					undefined,
					undefined,
					"materializer inspect base path",
				)
			).stdout.trim();
			if (row.startsWith("120000 ")) {
				throw new Error(`materializer path has symlink semantics: ${prefix}`);
			}
		}
	}

	private assertSha(value: string, label: string): void {
		if (!SHA_RE.test(value)) throw new Error(`materializer ${label} invalid`);
	}

	private assertExpectedCommit(
		actual: { treeHead: string; commitHead: string },
		expected: { treeHead: string; commitHead: string },
	): void {
		if (
			actual.treeHead !== expected.treeHead ||
			actual.commitHead !== expected.commitHead
		) {
			throw new Error("materializer deterministic commit/tree mismatch");
		}
	}

	private async runOrThrow(
		args: string[],
		cwd: string,
		extraEnv?: Record<string, string>,
		input?: string,
		label = "git",
	): Promise<GitResult> {
		const result = await this.run(args, cwd, extraEnv, input);
		if (result.status !== 0) {
			throw new Error(
				`${label} failed: ${result.stderr.trim() || `exit ${result.status}`}`,
			);
		}
		return result;
	}

	private async runNetworkOrThrow(
		args: string[],
		cwd: string,
		extraEnv?: Record<string, string>,
		input?: string,
		label = "git",
	): Promise<GitResult> {
		const result = await this.runNetwork(args, cwd, extraEnv, input);
		if (result.status !== 0) {
			throw new Error(
				`${label} failed: ${result.stderr.trim() || `exit ${result.status}`}`,
			);
		}
		return result;
	}

	private run(
		args: string[],
		cwd: string,
		extraEnv?: Record<string, string>,
		input?: string,
	): Promise<GitResult> {
		return this.execute(args, cwd, extraEnv, input, 30_000);
	}

	private runNetwork(
		args: string[],
		cwd: string,
		extraEnv?: Record<string, string>,
		input?: string,
	): Promise<GitResult> {
		return this.execute(args, cwd, extraEnv, input, this.networkTimeoutMs);
	}

	private async execute(
		args: string[],
		cwd: string,
		extraEnv: Record<string, string> | undefined,
		input: string | undefined,
		timeout: number,
	): Promise<GitResult> {
		const credentialEnv = this.token ? this.gitCredentialEnv() : {};
		const label = gitSubcommand(args);
		const startedAt = Date.now();
		try {
			const result = await defaultAsyncExecFile(
				this.gitPath,
				[...GIT_PUSH_SAFE_CONFIG, ...args],
				{
					cwd,
					timeoutMs: timeout,
					input,
					envMode: "replace",
					env: {
						PATH: `${this.gitPath.replace(/\/[^/]+$/, "")}:/usr/bin:/bin`,
						LC_ALL: "C",
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_CONFIG_SYSTEM: "/dev/null",
						GIT_TERMINAL_PROMPT: "0",
						GIT_OPTIONAL_LOCKS: "0",
						...credentialEnv,
						...(extraEnv ?? {}),
					},
				},
			);
			return { status: 0, stdout: result.stdout, stderr: result.stderr };
		} catch (error) {
			const failure = error as Error & {
				code?: unknown;
				status?: unknown;
				stdout?: unknown;
				stderr?: unknown;
				timedOut?: unknown;
			};
			const status =
				typeof failure.status === "number"
					? failure.status
					: typeof failure.code === "number"
						? failure.code
						: 1;
			return {
				status,
				stdout: typeof failure.stdout === "string" ? failure.stdout : "",
				stderr:
					typeof failure.stderr === "string" && failure.stderr
						? failure.stderr
						: failure.message,
				timedOut: failure.timedOut === true || failure.code === "ETIMEDOUT",
			};
		} finally {
			this.recordSpan?.(`workflow-docs-git:${label}`, startedAt, Date.now());
		}
	}

	private gitCredentialEnv(): Record<string, string> {
		if (!this.askpassPath) {
			const dir = mkdtempSync(join(tmpdir(), "flywheel-doc-askpass-"));
			this.askpassPath = join(dir, "askpass.sh");
			writeFileSync(
				this.askpassPath,
				'#!/bin/sh\ncase "$1" in *Username*) printf %s x-access-token;; *) printf %s "$FLYWHEEL_GIT_TOKEN";; esac\n',
				{ mode: 0o700 },
			);
			chmodSync(this.askpassPath, 0o700);
		}
		return {
			GIT_ASKPASS: this.askpassPath,
			FLYWHEEL_GIT_TOKEN: this.token!,
		};
	}
}
