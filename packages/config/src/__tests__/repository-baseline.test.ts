import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureRepositoryBaselineSet,
	verifyRepositoryBaselineSet,
} from "../repository-baseline.js";

const roots: string[] = [];

function git(root: string, ...args: string[]): void {
	execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

function repository(): string {
	const root = mkdtempSync(join(tmpdir(), "fly1638-baseline-"));
	roots.push(root);
	git(root, "init");
	git(root, "config", "user.name", "Flywheel Test");
	git(root, "config", "user.email", "flywheel@example.test");
	writeFileSync(join(root, "README.md"), "baseline\n");
	git(root, "add", "README.md");
	git(root, "commit", "-m", "baseline");
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("repository baseline sealing", () => {
	it("round-trips an unchanged clean repository", () => {
		const root = repository();
		const baseline = captureRepositoryBaselineSet(root);
		expect(
			verifyRepositoryBaselineSet({
				authorityRoot: root,
				baselineJson: baseline.json,
				baselineDigest: baseline.digest,
			}),
		).toEqual({ ok: true, currentDigest: baseline.digest });
	});

	it("fails closed for dirty work, commits, and newly-created nested repositories", () => {
		const root = repository();
		const baseline = captureRepositoryBaselineSet(root);
		writeFileSync(join(root, "dirty.txt"), "dirty\n");
		expect(
			verifyRepositoryBaselineSet({
				authorityRoot: root,
				baselineJson: baseline.json,
				baselineDigest: baseline.digest,
			}),
		).toMatchObject({ ok: false, reason: "repository_inventory_dirty" });
		rmSync(join(root, "dirty.txt"));
		writeFileSync(join(root, "README.md"), "advanced\n");
		git(root, "add", "README.md");
		git(root, "commit", "-m", "advanced");
		expect(
			verifyRepositoryBaselineSet({
				authorityRoot: root,
				baselineJson: baseline.json,
				baselineDigest: baseline.digest,
			}),
		).toMatchObject({ ok: false, reason: "repository_baseline_changed" });
		mkdirSync(join(root, "nested"));
		git(join(root, "nested"), "init");
		expect(
			verifyRepositoryBaselineSet({
				authorityRoot: root,
				baselineJson: baseline.json,
				baselineDigest: baseline.digest,
			}),
		).toMatchObject({ ok: false });
	});

	it("fails closed for a directory symlink that could hide another repository", () => {
		const root = repository();
		const outside = repository();
		symlinkSync(outside, join(root, "linked-repository"));
		expect(() => captureRepositoryBaselineSet(root)).toThrow(
			"repository_inventory_symlink_directory",
		);
	});

	it("detects a commit made only in a sealed nested repository", () => {
		const root = repository();
		const nested = join(root, "nested");
		mkdirSync(nested);
		git(nested, "init");
		git(nested, "config", "user.name", "Flywheel Test");
		git(nested, "config", "user.email", "flywheel@example.test");
		writeFileSync(join(nested, "README.md"), "nested baseline\n");
		git(nested, "add", "README.md");
		git(nested, "commit", "-m", "nested baseline");
		writeFileSync(join(root, ".gitignore"), "nested/\n");
		git(root, "add", ".gitignore");
		git(root, "commit", "-m", "ignore nested repository");
		const baseline = captureRepositoryBaselineSet(root);
		writeFileSync(join(nested, "README.md"), "nested advanced\n");
		git(nested, "add", "README.md");
		git(nested, "commit", "-m", "nested advanced");
		expect(
			verifyRepositoryBaselineSet({
				authorityRoot: root,
				baselineJson: baseline.json,
				baselineDigest: baseline.digest,
			}),
		).toMatchObject({ ok: false, reason: "repository_baseline_changed" });
	});
});
