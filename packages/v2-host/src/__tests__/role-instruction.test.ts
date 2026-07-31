import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRoleInstruction } from "../role-instruction.js";

const roots: string[] = [];

function git(root: string, args: string[]): string {
	return execFileSync(
		"/usr/bin/git",
		[
			"-C",
			root,
			"-c",
			"user.name=V2 Test",
			"-c",
			"user.email=v2@example.invalid",
			...args,
		],
		{ encoding: "utf8" },
	).trim();
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "flywheel-v2-role-"));
	roots.push(root);
	mkdirSync(join(root, ".flywheel", "agents", "nodes"), { recursive: true });
	writeFileSync(
		join(root, ".flywheel", "agents", "nodes", "implement.md"),
		"# Implement\n\nFollow the project contract.\n",
	);
	git(root, ["init", "-q"]);
	git(root, ["add", "."]);
	git(root, ["commit", "-qm", "fixture"]);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("runtime node instruction resolution (FLY-1544 ① / FLY-1556 blob pin)", () => {
	it("resolves the node instruction from the committed blob at HEAD", () => {
		const root = fixture();
		const canonicalRoot = realpathSync.native(root);
		const resolved = resolveRoleInstruction({
			projectRoot: root,
			taskKind: "implement",
		});
		expect(resolved).toMatchObject({
			projectRoot: canonicalRoot,
			sourcePath: join(
				canonicalRoot,
				".flywheel",
				"agents",
				"nodes",
				"implement.md",
			),
			contentBytes: 42,
			content: "# Implement\n\nFollow the project contract.\n",
		});
		expect(resolved.contentDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(resolved.sourceCommit).toBe(git(root, ["rev-parse", "HEAD"]));
		expect(resolved.sourceBlob).toBe(
			git(root, ["rev-parse", "HEAD:.flywheel/agents/nodes/implement.md"]),
		);
	});

	it("FLY-1556: pins the blob, not the mutable working file", () => {
		const root = fixture();
		const before = resolveRoleInstruction({
			projectRoot: root,
			taskKind: "implement",
		});
		// The very self-poison scenario of FLY-1547: the working file is edited
		// (the task's own job) but not committed. The pin must not move.
		writeFileSync(
			join(root, ".flywheel", "agents", "nodes", "implement.md"),
			"# Implement (edited by the running task)\n",
		);
		const after = resolveRoleInstruction({
			projectRoot: root,
			taskKind: "implement",
		});
		expect(after.contentDigest).toBe(before.contentDigest);
		expect(after.sourceBlob).toBe(before.sourceBlob);
		expect(after.content).toBe(before.content);
	});

	it("fails closed for missing, traversal-shaped, symlinked, or uncommitted node kinds", () => {
		const root = fixture();
		expect(() =>
			resolveRoleInstruction({
				projectRoot: root,
				taskKind: "missing",
			}),
		).toThrow(/node instruction for missing cannot be resolved/);

		// A kind is a path segment; anything outside the strict shape is refused
		// before filesystem access.
		for (const hostile of ["../outside", "a/b", "", ".hidden", "UPPER"]) {
			expect(() =>
				resolveRoleInstruction({
					projectRoot: root,
					taskKind: hostile,
				}),
			).toThrow(/not a valid node instruction name/);
		}

		// A committed symlink is a 120000 blob — not an instruction book.
		symlinkSync(
			join(root, ".flywheel", "agents", "nodes", "implement.md"),
			join(root, ".flywheel", "agents", "nodes", "linked.md"),
		);
		git(root, ["add", "."]);
		git(root, ["commit", "-qm", "symlink"]);
		expect(() =>
			resolveRoleInstruction({
				projectRoot: root,
				taskKind: "linked",
			}),
		).toThrow(/not a regular file/);

		// A file that only exists in the working tree has no blob at HEAD — the
		// pin source is the commit, so it does not resolve.
		writeFileSync(
			join(root, ".flywheel", "agents", "nodes", "uncommitted.md"),
			"# Not yet committed\n",
		);
		expect(() =>
			resolveRoleInstruction({
				projectRoot: root,
				taskKind: "uncommitted",
			}),
		).toThrow(/no committed file/);
	});

	it("refuses an empty instruction file", () => {
		const root = fixture();
		writeFileSync(
			join(root, ".flywheel", "agents", "nodes", "empty.md"),
			"\n\n",
		);
		git(root, ["add", "."]);
		git(root, ["commit", "-qm", "empty"]);
		expect(() =>
			resolveRoleInstruction({
				projectRoot: root,
				taskKind: "empty",
			}),
		).toThrow(/must contain role instructions/);
	});

	it("refuses a repository with no commits", () => {
		const root = mkdtempSync(join(tmpdir(), "flywheel-v2-role-"));
		roots.push(root);
		mkdirSync(join(root, ".flywheel", "agents", "nodes"), { recursive: true });
		writeFileSync(
			join(root, ".flywheel", "agents", "nodes", "implement.md"),
			"# Implement\n",
		);
		git(root, ["init", "-q"]);
		expect(() =>
			resolveRoleInstruction({
				projectRoot: root,
				taskKind: "implement",
			}),
		).toThrow(/HEAD is unreadable/);
	});
});
