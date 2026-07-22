import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitWorkflowDocsGit } from "../bridge/workflow-docs-git.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(options: { symlink?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "fly1307-docgit-"));
	const work = join(root, "work");
	const bare = join(root, "remote.git");
	git(root, ["init", "-q", "--bare", bare]);
	git(root, ["init", "-q", "-b", "main", work]);
	git(work, ["config", "user.name", "Test"]);
	git(work, ["config", "user.email", "test@example.com"]);
	mkdirSync(join(work, "product", "doc"), { recursive: true });
	writeFileSync(join(work, "product", "doc", "existing.md"), "base\n");
	if (options.symlink) {
		mkdirSync(join(work, "outside"));
		symlinkSync("../../outside", join(work, "product", "doc", "link"));
	}
	git(work, ["add", "."]);
	git(work, ["commit", "-qm", "base"]);
	git(work, ["remote", "add", "origin", bare]);
	git(work, ["push", "-q", "origin", "main"]);
	git(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
	const docsGit = new GitWorkflowDocsGit({ remoteUrl: () => bare });
	return { root, work, bare, docsGit, base: git(work, ["rev-parse", "HEAD"]) };
}

const ref = "refs/heads/flywheel/docs/flywheel/FLY-1307";
const repo = "xrliAnnie/flywheel";
const effectId = `mat:${"e".repeat(64)}`;
const outputDigest = "d".repeat(64);

describe("GitWorkflowDocsGit", () => {
	it("materializes a deterministic commit without touching the worktree and adopts it on replay", async () => {
		const { work, docsGit, base } = fixture();
		const common = { projectRoot: work, repo, ref };
		await expect(docsGit.resolveBaseHead(common)).resolves.toBe(base);
		const input = {
			...common,
			baseHead: base,
			effectId,
			outputDigest,
			payload: {
				kind: "docs_v1" as const,
				operations: [
					{ op: "delete" as const, path: "product/doc/existing.md" },
					{
						op: "write" as const,
						path: "docs/prototype/index.html",
						content: "<button>Try it</button>\n",
					},
					{
						op: "write" as const,
						path: "docs/prototype/README.md",
						content: "Open with: open docs/prototype/index.html\n",
					},
				],
			},
		};
		const first = await docsGit.prepareOrAdoptCommit(input);
		const replay = await docsGit.prepareOrAdoptCommit(input);
		expect(replay).toEqual(first);
		expect(git(work, ["status", "--porcelain"])).toBe("");
		expect(
			readFileSync(join(work, "product", "doc", "existing.md"), "utf8"),
		).toBe("base\n");
		expect(
			git(work, ["show", `${first.commitHead}:docs/prototype/index.html`]),
		).toBe("<button>Try it</button>");
		expect(
			git(work, ["show", `${first.commitHead}:docs/prototype/README.md`]),
		).toContain("open docs/prototype/index.html");
		expect(() =>
			git(work, [
				"cat-file",
				"-e",
				`${first.commitHead}:product/doc/existing.md`,
			]),
		).toThrow();

		await docsGit.pushCommit({
			...common,
			baseHead: base,
			commitHead: first.commitHead,
		});
		await expect(docsGit.readRemoteHead(common)).resolves.toBe(
			first.commitHead,
		);
	});

	it("rejects a path whose base-tree ancestor is a symlink", async () => {
		const { work, docsGit, base } = fixture({ symlink: true });
		await expect(
			docsGit.prepareOrAdoptCommit({
				projectRoot: work,
				repo,
				ref,
				baseHead: base,
				effectId,
				outputDigest,
				payload: {
					kind: "docs_v1",
					operations: [
						{ op: "write", path: "product/doc/link/pwn.md", content: "x" },
					],
				},
			}),
		).rejects.toThrow(/symlink/i);
	});

	it("rejects a planted deterministic ref whose tree does not match the payload", async () => {
		const { work, docsGit, base } = fixture();
		mkdirSync(join(work, ".github", "workflows"), { recursive: true });
		writeFileSync(join(work, ".github", "workflows", "evil.yml"), "evil\n");
		git(work, ["add", ".github/workflows/evil.yml"]);
		git(work, [
			"commit",
			"-qm",
			[
				"planted materialization",
				"",
				`Flywheel-Materialization-Effect: ${effectId}`,
				`Flywheel-Output-Digest: ${outputDigest}`,
				`Flywheel-Base-Head: ${base}`,
			].join("\n"),
		]);
		const planted = git(work, ["rev-parse", "HEAD"]);
		git(work, [
			"update-ref",
			`refs/flywheel/materializations/${effectId.slice(4)}`,
			planted,
		]);

		await expect(
			docsGit.prepareOrAdoptCommit({
				projectRoot: work,
				repo,
				ref,
				baseHead: base,
				effectId,
				outputDigest,
				payload: {
					kind: "docs_v1",
					operations: [
						{ op: "write", path: "product/doc/prd.md", content: "PRD\n" },
					],
				},
			}),
		).rejects.toThrow(/deterministic.*mismatch|tree.*mismatch/i);
	});

	it("refuses to overwrite a remotely advanced docs ref", async () => {
		const { root, work, bare, docsGit, base } = fixture();
		const common = { projectRoot: work, repo, ref };
		const prepared = await docsGit.prepareOrAdoptCommit({
			...common,
			baseHead: base,
			effectId,
			outputDigest,
			payload: {
				kind: "docs_v1",
				operations: [{ op: "write", path: "docs/a.md", content: "ours\n" }],
			},
		});
		const rival = join(root, "rival");
		git(root, ["clone", "-q", bare, rival]);
		git(rival, ["config", "user.name", "Rival"]);
		git(rival, ["config", "user.email", "rival@example.com"]);
		writeFileSync(join(rival, "rival.md"), "rival\n");
		git(rival, ["add", "."]);
		git(rival, ["commit", "-qm", "rival"]);
		git(rival, ["push", "-q", "origin", `HEAD:${ref}`]);

		await expect(
			docsGit.pushCommit({
				...common,
				baseHead: base,
				commitHead: prepared.commitHead,
			}),
		).rejects.toThrow(/remote.*advanced|stale/i);
	});
});
