import { execFile } from "node:child_process";

const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface MergedWorktreeProof {
	operationId: string;
	operationGeneration: number;
	projectName: string;
	issueId: string;
	runId: string | null;
	repoIdentity: string;
	projectRoot: string;
	prNumber: number;
	baseRefName: "main";
	mergedPrHead: string;
	mergeSha: string;
	mergeReceiptId: string;
	observedAt: string;
}

export type BranchCoverage =
	| { ok: true; via: "exact_pr_head" | "ancestor_of_main"; mainSha?: string }
	| {
			ok: false;
			detail:
				| "merge_proof_missing"
				| "merge_proof_invalid"
				| "head_not_merged"
				| "merge_probe_unknown"
				| "protected_branch";
	  };

export type MergedProofGitExec = (
	args: string[],
	cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultGitExec: MergedProofGitExec = (args, cwd) =>
	new Promise((resolve) => {
		execFile(
			"git",
			args,
			{ cwd, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => {
				resolve({
					code: error ? ((error as { code?: number }).code ?? 1) : 0,
					stdout: stdout ?? "",
					stderr: stderr ?? "",
				});
			},
		);
	});

function normalizeRepoIdentity(value: string): string | undefined {
	const trimmed = value.trim().replace(/\.git$/i, "");
	if (REPO_RE.test(trimmed)) return trimmed.toLowerCase();
	const scp = trimmed.match(/^git@github\.com:([^/]+\/[^/]+)$/i)?.[1];
	if (scp && REPO_RE.test(scp)) return scp.toLowerCase();
	try {
		const parsed = new URL(trimmed);
		if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
		const repo = parsed.pathname.replace(/^\/+/, "");
		return REPO_RE.test(repo) ? repo.toLowerCase() : undefined;
	} catch {
		return undefined;
	}
}

function isProtectedBranch(
	branch: string,
	protectedBranches: readonly string[],
): boolean {
	if (branch === "main" || branch === "master") return true;
	return protectedBranches.some((pattern) =>
		pattern.endsWith("*")
			? branch.startsWith(pattern.slice(0, -1))
			: branch === pattern,
	);
}

export function buildMergedWorktreeProof(input: {
	operation: {
		operationId: string;
		operationGeneration: number;
		projectName: string;
		issueId: string;
		runId: string | null;
		prNumber: number;
		approvedHead: string;
	};
	mergeReceipt: {
		receiptId: string;
		observedAt: string;
		receipt: Record<string, unknown>;
	};
	projectRoot: string;
	trustedRepoIdentity: string;
}): MergedWorktreeProof | undefined {
	const { operation, mergeReceipt } = input;
	const receipt = mergeReceipt.receipt;
	const approvedHead = operation.approvedHead.trim().toLowerCase();
	const headSha = String(receipt.headSha ?? "")
		.trim()
		.toLowerCase();
	const mergeSha = String(receipt.mergeSha ?? "")
		.trim()
		.toLowerCase();
	const receiptRepo = normalizeRepoIdentity(String(receipt.repoIdentity ?? ""));
	const trustedRepo = normalizeRepoIdentity(input.trustedRepoIdentity);
	if (
		!operation.operationId ||
		!Number.isSafeInteger(operation.operationGeneration) ||
		operation.operationGeneration < 0 ||
		!operation.projectName ||
		!operation.issueId ||
		!Number.isSafeInteger(operation.prNumber) ||
		operation.prNumber < 1 ||
		Number(receipt.prNumber) !== operation.prNumber ||
		!SHA_RE.test(approvedHead) ||
		receipt.state !== "MERGED" ||
		receipt.baseRefName !== "main" ||
		!SHA_RE.test(headSha) ||
		headSha !== approvedHead ||
		!SHA_RE.test(mergeSha) ||
		!receiptRepo ||
		!trustedRepo ||
		receiptRepo !== trustedRepo ||
		!input.projectRoot ||
		!mergeReceipt.receiptId ||
		!Number.isFinite(Date.parse(mergeReceipt.observedAt))
	) {
		return undefined;
	}
	return {
		operationId: operation.operationId,
		operationGeneration: operation.operationGeneration,
		projectName: operation.projectName,
		issueId: operation.issueId,
		runId: operation.runId,
		repoIdentity: input.trustedRepoIdentity,
		projectRoot: input.projectRoot,
		prNumber: operation.prNumber,
		baseRefName: "main",
		mergedPrHead: headSha,
		mergeSha,
		mergeReceiptId: mergeReceipt.receiptId,
		observedAt: mergeReceipt.observedAt,
	};
}

export async function verifyMergedBranchCoverage(input: {
	proof: MergedWorktreeProof;
	projectRoot: string;
	registeredBranch: string;
	registeredHead: string;
	protectedBranches: readonly string[];
	gitExec?: MergedProofGitExec;
}): Promise<BranchCoverage> {
	const registeredHead = input.registeredHead.trim().toLowerCase();
	if (
		input.proof.projectRoot !== input.projectRoot ||
		!SHA_RE.test(registeredHead) ||
		!normalizeRepoIdentity(input.proof.repoIdentity)
	) {
		return { ok: false, detail: "merge_proof_invalid" };
	}
	if (isProtectedBranch(input.registeredBranch, input.protectedBranches)) {
		return { ok: false, detail: "protected_branch" };
	}
	if (registeredHead === input.proof.mergedPrHead) {
		return { ok: true, via: "exact_pr_head" };
	}

	const gitExec = input.gitExec ?? defaultGitExec;
	const run = (args: string[]) =>
		gitExec(["-C", input.projectRoot, ...args], input.projectRoot);
	const remote = await run(["remote", "get-url", "origin"]);
	if (remote.code !== 0) return { ok: false, detail: "merge_probe_unknown" };
	if (
		normalizeRepoIdentity(remote.stdout) !==
		normalizeRepoIdentity(input.proof.repoIdentity)
	) {
		return { ok: false, detail: "merge_proof_invalid" };
	}

	const advertised = await run([
		"ls-remote",
		"--heads",
		"origin",
		"refs/heads/main",
	]);
	if (advertised.code !== 0) {
		return { ok: false, detail: "merge_probe_unknown" };
	}
	const mainLine = advertised.stdout
		.split("\n")
		.find((line) => line.endsWith("\trefs/heads/main"));
	const mainSha = mainLine?.split("\t")[0]?.trim().toLowerCase() ?? "";
	if (!SHA_RE.test(mainSha)) {
		return { ok: false, detail: "merge_probe_unknown" };
	}

	const fetched = await run([
		"fetch",
		"--no-tags",
		"--quiet",
		"origin",
		"refs/heads/main",
	]);
	if (fetched.code !== 0) {
		return { ok: false, detail: "merge_probe_unknown" };
	}
	const fetchHead = await run(["rev-parse", "--verify", "FETCH_HEAD"]);
	if (
		fetchHead.code !== 0 ||
		fetchHead.stdout.trim().toLowerCase() !== mainSha
	) {
		return { ok: false, detail: "merge_probe_unknown" };
	}

	const ancestor = await run([
		"merge-base",
		"--is-ancestor",
		registeredHead,
		mainSha,
	]);
	if (ancestor.code === 0) {
		return { ok: true, via: "ancestor_of_main", mainSha };
	}
	return ancestor.code === 1
		? { ok: false, detail: "head_not_merged" }
		: { ok: false, detail: "merge_probe_unknown" };
}
