import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FULL_SHA = /^[0-9a-f]{40}$/;
const GITHUB_HTTPS_REMOTE = /^https:\/\/github\.com\//i;

const PROOF_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"XDG_CONFIG_HOME",
	"GH_CONFIG_DIR",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"SSH_AUTH_SOCK",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
] as const;

/**
 * Keep repository/user Git configuration out of the proof while retaining the
 * narrow process context needed to authenticate a private origin. In
 * particular, GH_TOKEN and gh's config directory must reach the credential
 * helper spawned by Git.
 */
export function buildProofGitEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of PROOF_ENV_ALLOWLIST) {
		if (source[name] !== undefined) env[name] = source[name];
	}
	return {
		...env,
		LANG: "C",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
	};
}

/** Return command-local auth configuration; never trust a cloned repo config. */
export function buildProofFetchArgs(remoteUrl: string): string[] {
	return GITHUB_HTTPS_REMOTE.test(remoteUrl.trim())
		? [
				"-c",
				"credential.helper=",
				"-c",
				"credential.https://github.com.helper=!gh auth git-credential",
			]
		: [];
}

export type CleanBaseMergeProof =
	| {
			ok: true;
			proofKind: "clean_base_merge_tree_identity";
			approvedHead: string;
			baseOid: string;
			candidateHead: string;
			secondParentObserved: string;
			proofTreeOid: string;
	  }
	| {
			ok: false;
			reason:
				| "invalid_proof_input"
				| "proof_object_unavailable"
				| "uncontrolled_merge_config"
				| "parent_identity_mismatch"
				| "merge_tree_unavailable"
				| "tree_identity_mismatch";
	  };

async function git(repoRoot: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, {
		cwd: repoRoot,
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
		env: buildProofGitEnv(process.env),
	});
	return result.stdout.trim();
}

/**
 * Prove that candidateHead is exactly the clean base merge Git would produce
 * from the founder-approved head and the observed base. Parent equality alone
 * is insufficient: an attacker can create a merge commit with matching parents
 * and an arbitrary tree, so the computed merge-tree OID is the authority.
 */
export async function proveCleanBaseMergeTreeIdentity(input: {
	repoRoot: string;
	approvedHead: string;
	baseOid: string;
	candidateHead: string;
}): Promise<CleanBaseMergeProof> {
	const approvedHead = input.approvedHead.trim().toLowerCase();
	const baseOid = input.baseOid.trim().toLowerCase();
	const candidateHead = input.candidateHead.trim().toLowerCase();
	if (
		!input.repoRoot ||
		!FULL_SHA.test(approvedHead) ||
		!FULL_SHA.test(baseOid) ||
		!FULL_SHA.test(candidateHead) ||
		new Set([approvedHead, baseOid, candidateHead]).size !== 3
	) {
		return { ok: false, reason: "invalid_proof_input" };
	}
	try {
		const localConfig = await git(input.repoRoot, [
			"config",
			"--local",
			"--list",
		]);
		if (
			localConfig
				.split("\n")
				.some((entry) =>
					/^(?:merge\..*\.driver|filter\..*\.(?:clean|smudge|process|required)|core\.attributesfile)=/i.test(
						entry,
					),
				)
		) {
			return { ok: false, reason: "uncontrolled_merge_config" };
		}
	} catch {
		return { ok: false, reason: "uncontrolled_merge_config" };
	}

	try {
		await Promise.all(
			[approvedHead, baseOid, candidateHead].map((oid) =>
				git(input.repoRoot, ["cat-file", "-e", `${oid}^{commit}`]),
			),
		);
	} catch {
		return { ok: false, reason: "proof_object_unavailable" };
	}

	let parents: string[];
	let candidateTree: string;
	try {
		const [parentLine, tree] = await Promise.all([
			git(input.repoRoot, ["rev-list", "--parents", "-n", "1", candidateHead]),
			git(input.repoRoot, ["rev-parse", `${candidateHead}^{tree}`]),
		]);
		parents = parentLine
			.split(/\s+/)
			.slice(1)
			.map((oid) => oid.toLowerCase());
		candidateTree = tree.toLowerCase();
	} catch {
		return { ok: false, reason: "proof_object_unavailable" };
	}
	if (
		parents.length !== 2 ||
		parents[0] !== approvedHead ||
		parents[1] !== baseOid
	) {
		return { ok: false, reason: "parent_identity_mismatch" };
	}

	let proofTreeOid: string;
	try {
		const output = await git(input.repoRoot, [
			"-c",
			"merge.renormalize=false",
			"merge-tree",
			"--write-tree",
			baseOid,
			approvedHead,
		]);
		proofTreeOid = output.split(/\s+/)[0]?.toLowerCase() ?? "";
	} catch {
		return { ok: false, reason: "merge_tree_unavailable" };
	}
	if (!FULL_SHA.test(proofTreeOid)) {
		return { ok: false, reason: "merge_tree_unavailable" };
	}
	if (proofTreeOid !== candidateTree) {
		return { ok: false, reason: "tree_identity_mismatch" };
	}
	return {
		ok: true,
		proofKind: "clean_base_merge_tree_identity",
		approvedHead,
		baseOid,
		candidateHead,
		secondParentObserved: parents[1],
		proofTreeOid,
	};
}

/**
 * Fetch only the immutable PR ref into a disposable bare repository. The
 * candidate merge commit necessarily brings both parents and their trees, so
 * the proof never depends on a runner worktree or its local git configuration.
 */
export async function proveCleanBaseMergeInIsolatedClone(input: {
	remoteUrl: string;
	prNumber: number;
	approvedHead: string;
	baseOid: string;
	candidateHead: string;
}): Promise<CleanBaseMergeProof> {
	if (
		!input.remoteUrl.trim() ||
		!Number.isInteger(input.prNumber) ||
		input.prNumber < 1
	) {
		return { ok: false, reason: "invalid_proof_input" };
	}
	const proofRoot = mkdtempSync(join(tmpdir(), "flywheel-land-proof-"));
	try {
		await git(proofRoot, ["init", "--bare"]);
		await git(proofRoot, [
			...buildProofFetchArgs(input.remoteUrl),
			"fetch",
			"--no-tags",
			"--force",
			"--",
			input.remoteUrl,
			`+refs/pull/${input.prNumber}/head:refs/flywheel/candidate`,
		]);
		return await proveCleanBaseMergeTreeIdentity({
			repoRoot: proofRoot,
			approvedHead: input.approvedHead,
			baseOid: input.baseOid,
			candidateHead: input.candidateHead,
		});
	} catch {
		return { ok: false, reason: "proof_object_unavailable" };
	} finally {
		rmSync(proofRoot, { recursive: true, force: true });
	}
}

export class GitLandHeadRefreshProver {
	constructor(
		private readonly projectRootFor: (
			projectName: string,
		) => string | undefined,
	) {}

	async prove(input: {
		projectName: string;
		prNumber: number;
		approvedHead: string;
		baseOid: string;
		candidateHead: string;
	}): Promise<CleanBaseMergeProof> {
		const projectRoot = this.projectRootFor(input.projectName);
		if (!projectRoot) return { ok: false, reason: "invalid_proof_input" };
		let remoteUrl: string;
		try {
			remoteUrl = await git(projectRoot, ["remote", "get-url", "origin"]);
		} catch {
			return { ok: false, reason: "proof_object_unavailable" };
		}
		return proveCleanBaseMergeInIsolatedClone({
			remoteUrl,
			prNumber: input.prNumber,
			approvedHead: input.approvedHead,
			baseOid: input.baseOid,
			candidateHead: input.candidateHead,
		});
	}
}
