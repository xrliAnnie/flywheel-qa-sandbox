import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { join } from "node:path";
import {
	assertFeaturePushBranch,
	materializeAndPushV2,
} from "../../lead-backends/codex/gateway/GitPushRunner.js";
import type { LeadOperationContext, LeadOperationHandler } from "../broker.js";
import { getLeadCapability } from "../catalog.js";
import { createGitPushTransport } from "../git-push-transport.js";
export interface GitFeaturePushPolicy {
	projectName: string;
	leadId: string;
	revision: string;
	owner: string;
	repo: string;
	branch: string;
	defaultBranch: string;
	gitDir: string;
	commonGitDir: string;
	gitPath: string;
	stagingRoot: string;
}
export interface GitFeaturePushOptions {
	policy(): GitFeaturePushPolicy;
	token(): string;
	authorizeTarget(
		policy: GitFeaturePushPolicy,
		context: LeadOperationContext,
	): Promise<void>;
	assertTargetCurrent(
		policy: GitFeaturePushPolicy,
		context: LeadOperationContext,
	): void;
	fetchImpl?: typeof fetch;
}
function deny(): never {
	throw new Error("git_scope_denied");
}
function read(path: string, max = 1024): string {
	if (realpathSync(path) !== path) deny();
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > max) deny();
		const buffer = Buffer.alloc(max + 1);
		let size = 0;
		while (size < buffer.length) {
			const n = readSync(fd, buffer, size, buffer.length - size, null);
			if (n === 0) break;
			size += n;
		}
		if (size > max) deny();
		return buffer.subarray(0, size).toString("utf8");
	} finally {
		closeSync(fd);
	}
}
function head(policy: GitFeaturePushPolicy): string {
	if (
		realpathSync(policy.gitDir) !== policy.gitDir ||
		realpathSync(policy.commonGitDir) !== policy.commonGitDir
	)
		deny();
	if (
		policy.gitDir !== policy.commonGitDir &&
		realpathSync(
			join(policy.gitDir, read(join(policy.gitDir, "commondir")).trim()),
		) !== policy.commonGitDir
	)
		deny();
	if (
		read(join(policy.gitDir, "HEAD")).trim() !==
		`ref: refs/heads/${policy.branch}`
	)
		deny();
	try {
		return read(
			join(policy.commonGitDir, "refs", "heads", policy.branch),
		).trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const refs = read(
			join(policy.commonGitDir, "packed-refs"),
			4 * 1024 * 1024,
		);
		return (
			refs
				.split("\n")
				.find((line) => line.endsWith(` refs/heads/${policy.branch}`))
				?.split(" ")[0] ?? deny()
		);
	}
}
export function createGitFeaturePushHandler(
	options: GitFeaturePushOptions,
): LeadOperationHandler {
	function current(
		input: Record<string, unknown>,
		context: LeadOperationContext,
		expected?: string,
	) {
		try {
			getLeadCapability("git.feature.push")!.inputSchema.parse(input);
			const policy = options.policy();
			if (
				context.signal.aborted ||
				policy.projectName !== context.projectName ||
				policy.leadId !== context.leadId ||
				!policy.revision ||
				!policy.defaultBranch ||
				input.branch !== policy.branch ||
				(expected && JSON.stringify(policy) !== expected)
			)
				deny();
			assertFeaturePushBranch(policy.branch, policy.defaultBranch);
			if (head(policy) !== input.expectedHead) deny();
			options.assertTargetCurrent(policy, context);
			return policy;
		} catch {
			return deny();
		}
	}
	async function guard(
		input: Record<string, unknown>,
		context: LeadOperationContext,
		expected?: string,
	) {
		const p = current(input, context, expected);
		const pinned = JSON.stringify(p);
		await context.assertCurrent();
		current(input, context, pinned);
		await options.authorizeTarget(p, context);
		return current(input, context, pinned);
	}
	return {
		authorize: async (input, context) => {
			await guard(input, context);
		},
		execute: async (input, context) => {
			let transport:
				| Awaited<ReturnType<typeof createGitPushTransport>>
				| undefined;
			try {
				const p = await guard(input, context);
				const pinned = JSON.stringify(p);
				const assertCurrent = async () => {
					await guard(input, context, pinned);
				};
				const assertCurrentSync = () => {
					current(input, context, pinned);
				};
				transport = await createGitPushTransport({
					owner: p.owner,
					repo: p.repo,
					branch: p.branch,
					expectedHead: input.expectedHead as string,
					token: options.token,
					signal: context.signal,
					assertCurrent,
					assertCurrentSync,
					fetchImpl: options.fetchImpl,
				});
				const result = await materializeAndPushV2(
					{
						modelGitDir: p.commonGitDir,
						headSha: input.expectedHead as string,
						branch: p.branch,
						transport,
						signal: context.signal,
						assertCurrent,
						assertCurrentSync,
					},
					{ gitPath: p.gitPath, stagingRoot: p.stagingRoot },
				);
				if (!result.ok) return { status: "unknown" };
				await assertCurrent();
				return {
					status: "succeeded",
					providerRef: `git-push:${createHash("sha256")
						.update(
							JSON.stringify([p.owner, p.repo, p.branch, result.pushedSha]),
						)
						.digest("hex")}`,
					data: {
						head: result.pushedSha,
						receiptId: randomUUID(),
						observedAt: new Date().toISOString(),
					},
				};
			} catch {
				return { status: "unknown" };
			} finally {
				await transport?.close();
			}
		},
	};
}
