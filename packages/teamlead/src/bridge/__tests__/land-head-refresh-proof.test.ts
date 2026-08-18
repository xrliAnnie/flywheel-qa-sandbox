import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildProofFetchArgs,
	buildProofGitEnv,
	proveCleanBaseMergeInIsolatedClone,
	proveCleanBaseMergeTreeIdentity,
} from "../land-head-refresh-proof.js";

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fixture(): {
	root: string;
	approvedHead: string;
	baseOid: string;
	mergedHead: string;
} {
	const root = mkdtempSync(join(tmpdir(), "fly1833-proof-"));
	roots.push(root);
	git(root, "init", "-b", "main");
	git(root, "config", "user.email", "flywheel-test@example.com");
	git(root, "config", "user.name", "Flywheel Test");
	writeFileSync(join(root, "root.txt"), "root\n");
	git(root, "add", "root.txt");
	git(root, "commit", "-m", "root");
	git(root, "checkout", "-b", "feature");
	writeFileSync(join(root, "feature.txt"), "approved feature\n");
	git(root, "add", "feature.txt");
	git(root, "commit", "-m", "approved feature");
	const approvedHead = git(root, "rev-parse", "HEAD");
	git(root, "checkout", "main");
	writeFileSync(join(root, "base.txt"), "moving base\n");
	git(root, "add", "base.txt");
	git(root, "commit", "-m", "move base");
	const baseOid = git(root, "rev-parse", "HEAD");
	git(root, "checkout", "feature");
	git(root, "merge", "--no-ff", "--no-edit", baseOid);
	return {
		root,
		approvedHead,
		baseOid,
		mergedHead: git(root, "rev-parse", "HEAD"),
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("clean base-merge tree identity proof", { timeout: 60_000 }, () => {
	it("keeps Git config isolated while carrying only the auth context needed for a private GitHub fetch", () => {
		const env = buildProofGitEnv({
			PATH: "/usr/bin",
			HOME: "/private/auth-home",
			GH_CONFIG_DIR: "/private/gh-config",
			GH_TOKEN: "test-token",
			GIT_CONFIG_GLOBAL: "/attacker/config",
		});
		expect(env).toMatchObject({
			PATH: "/usr/bin",
			HOME: "/private/auth-home",
			GH_CONFIG_DIR: "/private/gh-config",
			GH_TOKEN: "test-token",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
		});
		expect(
			buildProofFetchArgs("https://github.com/xrliAnnie/flywheel.git"),
		).toEqual([
			"-c",
			"credential.helper=",
			"-c",
			"credential.https://github.com.helper=!gh auth git-credential",
		]);
	});

	it("proves an exact two-parent clean base merge using git merge-tree", async () => {
		const sample = fixture();
		const proof = await proveCleanBaseMergeTreeIdentity({
			repoRoot: sample.root,
			approvedHead: sample.approvedHead,
			baseOid: sample.baseOid,
			candidateHead: sample.mergedHead,
		});

		expect(proof).toEqual({
			ok: true,
			proofKind: "clean_base_merge_tree_identity",
			approvedHead: sample.approvedHead,
			baseOid: sample.baseOid,
			candidateHead: sample.mergedHead,
			secondParentObserved: sample.baseOid,
			proofTreeOid: git(
				sample.root,
				"rev-parse",
				`${sample.mergedHead}^{tree}`,
			),
		});
	});

	it("rejects an evil merge whose parents match but whose tree carries extra content", async () => {
		const sample = fixture();
		writeFileSync(join(sample.root, "smuggled.txt"), "not approved\n");
		git(sample.root, "add", "smuggled.txt");
		git(sample.root, "commit", "--amend", "--no-edit");
		const evilHead = git(sample.root, "rev-parse", "HEAD");

		await expect(
			proveCleanBaseMergeTreeIdentity({
				repoRoot: sample.root,
				approvedHead: sample.approvedHead,
				baseOid: sample.baseOid,
				candidateHead: evilHead,
			}),
		).resolves.toMatchObject({
			ok: false,
			reason: "tree_identity_mismatch",
		});
	});

	it("rejects reversed parents even when the resulting tree is identical", async () => {
		const sample = fixture();
		git(sample.root, "checkout", "main");
		git(sample.root, "merge", "--no-ff", "--no-edit", sample.approvedHead);
		const reversedHead = git(sample.root, "rev-parse", "HEAD");

		await expect(
			proveCleanBaseMergeTreeIdentity({
				repoRoot: sample.root,
				approvedHead: sample.approvedHead,
				baseOid: sample.baseOid,
				candidateHead: reversedHead,
			}),
		).resolves.toMatchObject({
			ok: false,
			reason: "parent_identity_mismatch",
		});
	});

	it("refuses repository-local custom merge or filter drivers", async () => {
		const sample = fixture();
		git(sample.root, "config", "merge.flywheel-test.driver", "cp %B %A");

		await expect(
			proveCleanBaseMergeTreeIdentity({
				repoRoot: sample.root,
				approvedHead: sample.approvedHead,
				baseOid: sample.baseOid,
				candidateHead: sample.mergedHead,
			}),
		).resolves.toEqual({ ok: false, reason: "uncontrolled_merge_config" });
	});

	it("fails closed when any proof object is unavailable", async () => {
		const sample = fixture();
		await expect(
			proveCleanBaseMergeTreeIdentity({
				repoRoot: sample.root,
				approvedHead: "f".repeat(40),
				baseOid: sample.baseOid,
				candidateHead: sample.mergedHead,
			}),
		).resolves.toEqual({ ok: false, reason: "proof_object_unavailable" });
	});

	it("fetches the proof objects into a disposable Bridge-owned bare clone", async () => {
		const sample = fixture();
		const remote = mkdtempSync(join(tmpdir(), "fly1833-proof-remote-"));
		roots.push(remote);
		git(remote, "init", "--bare");
		git(sample.root, "remote", "add", "proof-origin", remote);
		git(
			sample.root,
			"push",
			"proof-origin",
			`${sample.baseOid}:refs/heads/main`,
		);
		git(
			sample.root,
			"push",
			"proof-origin",
			`${sample.mergedHead}:refs/pull/1833/head`,
		);

		await expect(
			proveCleanBaseMergeInIsolatedClone({
				remoteUrl: remote,
				prNumber: 1833,
				approvedHead: sample.approvedHead,
				baseOid: sample.baseOid,
				candidateHead: sample.mergedHead,
			}),
		).resolves.toMatchObject({
			ok: true,
			proofKind: "clean_base_merge_tree_identity",
			candidateHead: sample.mergedHead,
		});
	}, 30_000);
});
