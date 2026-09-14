import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { repositorySlugSchema } from "./contract.js";
import { FrozenGitReader } from "./git-input.js";
import type { PreparedJudgmentGit } from "./runtime-collect.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const requestSchema = z
	.object({
		repoIdentity: z.string().min(1).max(200),
		repoSlug: repositorySlugSchema,
		prNumber: z.number().int().positive().safe(),
		headSha: sha,
		diffBaseSha: sha.optional(),
		mainSha: sha,
		targetBaseSha: sha.optional(),
	})
	.strict();
export interface GitPreparationCommand {
	args: string[];
	env: NodeJS.ProcessEnv;
	signal: AbortSignal;
}
function runCommand(command: GitPreparationCommand): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			command.args,
			{
				env: command.env,
				signal: command.signal,
				encoding: "utf8",
				timeout: 20_000,
				killSignal: "SIGKILL",
				maxBuffer: 131_072,
			},
			(error, stdout) =>
				error ? reject(new Error("git_preparation_failed")) : resolve(stdout),
		);
	});
}

/** Fetch into a fresh private bare store, without inheriting host Git configuration or credential helpers. */
export async function prepareJudgmentGit(
	request: z.infer<typeof requestSchema>,
	deps: {
		repositories: readonly string[];
		token(signal: AbortSignal): Promise<string>;
		command?: (command: GitPreparationCommand) => Promise<string>;
	},
	signal: AbortSignal,
): Promise<{
	material: PreparedJudgmentGit;
	gitDir: string;
	dispose(): Promise<void>;
}> {
	const value = requestSchema.parse(request);
	if (!deps.repositories.includes(value.repoSlug))
		throw new Error("repository_not_allowed");
	signal.throwIfAborted();
	const gitDir = await mkdtemp(join(tmpdir(), "ship-judgment-git-"));
	const dispose = () => rm(gitDir, { recursive: true, force: true });
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 60_000);
	const bound = AbortSignal.any([signal, controller.signal]);
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		LC_ALL: "C",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_NO_LAZY_FETCH: "1",
	};
	const run = async (args: string[], auth?: string) => {
		bound.throwIfAborted();
		const output = await (deps.command ?? runCommand)({
			args: [
				"-c",
				"credential.helper=",
				"-c",
				"core.fsmonitor=false",
				"-c",
				"protocol.allow=never",
				"-c",
				"protocol.https.allow=always",
				"-c",
				"http.followRedirects=false",
				"-c",
				"maintenance.auto=false",
				"-c",
				"gc.auto=0",
				`--git-dir=${gitDir}`,
				...args,
			],
			env: auth
				? {
						...env,
						GIT_CONFIG_COUNT: "1",
						GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
						GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${auth}`).toString("base64")}`,
					}
				: env,
			signal: bound,
		});
		bound.throwIfAborted();
		return output;
	};
	try {
		await run(["init", "--bare", "--template=", gitDir]);
		let onAbort: (() => void) | undefined;
		let token: string;
		try {
			token = await Promise.race([
				deps.token(bound),
				new Promise<never>((_, reject) => {
					onAbort = () => reject(new Error("git_preparation_failed"));
					bound.addEventListener("abort", onAbort, { once: true });
					if (bound.aborted) onAbort();
				}),
			]);
		} finally {
			if (onAbort) bound.removeEventListener("abort", onAbort);
		}
		if (!token || /[\r\n]/.test(token))
			throw new Error("git_preparation_failed");
		const objects = [
			...new Set([
				value.headSha,
				...(value.diffBaseSha ? [value.diffBaseSha] : []),
				value.mainSha,
				...(value.targetBaseSha ? [value.targetBaseSha] : []),
			]),
		];
		await run(
			[
				"fetch",
				"--no-tags",
				"--no-recurse-submodules",
				"--no-write-fetch-head",
				`https://github.com/${value.repoSlug}.git`,
				...objects,
			],
			token,
		);
		for (const object of objects)
			await run(["cat-file", "-e", `${object}^{commit}`]);
		const diffBaseSha =
			value.diffBaseSha ??
			(await new FrozenGitReader(gitDir, bound).mergeBase(
				value.targetBaseSha ?? value.mainSha,
				value.headSha,
			));
		return {
			gitDir,
			dispose,
			material: {
				repoIdentity: value.repoIdentity,
				repoSlug: value.repoSlug,
				prNumber: value.prNumber,
				headSha: value.headSha,
				diffBaseSha,
				reader: (abort) => new FrozenGitReader(gitDir, abort),
			},
		};
	} catch {
		await dispose();
		throw new Error("git_preparation_failed");
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}
