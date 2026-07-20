/**
 * FLY-1389 P1-0: TS host of the path-hygiene predicates. Mirrors the fixture
 * matrix of scripts/__tests__/path-hygiene.test.sh — the bash host and this
 * one are two hosts of ONE truth; when a scenario is added on one side, add
 * it to the other.
 *
 * Trusted-root fixtures live under the REPO checkout (not mktemp) because
 * mktemp roots are temp by the very predicate under test. The predicate only
 * inspects the given dir's OWN .git entry (no ancestor walk), so fixtures
 * inside this checkout are judged by their own .git shape.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
	canonicalizeAllowMissing,
	isGlobalBinDir,
	isTempOrWorktreeRoot,
	isTempPath,
} from "../bridge/path-hygiene.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// In-repo sandbox for trusted-root fixtures; temp-shape fixtures are pinned
// under literal /tmp (NOT os.tmpdir() — runner sessions redirect TMPDIR to
// ~/.flywheel/runner-state, which is deliberately not a temp shape).
const RSB = mkdtempSync(join(HERE, ".tmp-path-hygiene-"));
const TSB = mkdtempSync("/tmp/fly1389-hygiene-ts-");

afterAll(() => {
	rmSync(RSB, { recursive: true, force: true });
	rmSync(TSB, { recursive: true, force: true });
});

describe("isTempPath (pure prefix matrix)", () => {
	it("matches all four canonical temp prefixes, boundary-safe", () => {
		for (const p of [
			"/tmp",
			"/tmp/x",
			"/private/tmp",
			"/private/tmp/deep/x",
			"/var/folders",
			"/var/folders/zz/abc",
			"/private/var/folders",
			"/private/var/folders/zz/abc",
		]) {
			expect(isTempPath(p), p).toBe(true);
		}
		for (const p of [
			"/tmpfoo",
			"/private/tmpfoo",
			"/var/foldersfoo",
			"/private/var/foldersfoo",
			"/home/user/tmp",
			"/Users/x/Dev/flywheel",
			"/var/log",
		]) {
			expect(isTempPath(p), p).toBe(false);
		}
	});
});

describe("isTempOrWorktreeRoot", () => {
	it("flags a linked-worktree root (.git is a FILE)", () => {
		const wt = join(RSB, "worktree-shaped");
		mkdirSync(wt, { recursive: true });
		writeFileSync(join(wt, ".git"), "gitdir: /some/main/.git/worktrees/x\n");
		expect(isTempOrWorktreeRoot(wt)).toBe(true);
	});

	it("trusts a main checkout root (.git is a DIRECTORY)", () => {
		const mc = join(RSB, "main-checkout");
		mkdirSync(join(mc, ".git"), { recursive: true });
		expect(isTempOrWorktreeRoot(mc)).toBe(false);
	});

	it("trusts a non-git non-temp root (packaged tree shape)", () => {
		const pk = join(RSB, "packaged-tree");
		mkdirSync(pk, { recursive: true });
		writeFileSync(join(pk, ".flywheel-prebuilt"), "");
		expect(isTempOrWorktreeRoot(pk)).toBe(false);
	});

	it("flags a real /tmp dir via canonical temp prefix (macOS: /private/tmp)", () => {
		expect(isTempOrWorktreeRoot(TSB)).toBe(true);
	});

	it("fail-closed on unresolvable input", () => {
		expect(isTempOrWorktreeRoot("")).toBe(true);
		expect(isTempOrWorktreeRoot("/nonexistent-fly1389/../weird")).toBe(true);
	});

	if (process.platform === "darwin") {
		it("macOS real-machine fact: /var/folders canonicalizes to /private/var/folders (FLY-1285)", () => {
			expect(canonicalizeAllowMissing("/var/folders")).toBe(
				"/private/var/folders",
			);
		});
	}
});

describe("isGlobalBinDir", () => {
	const fh = join(TSB, "home");
	it("resolved-identity matrix: exact / redundant slashes / symlink alias / other", () => {
		mkdirSync(join(fh, ".flywheel", "bin"), { recursive: true });
		mkdirSync(join(fh, "elsewhere"), { recursive: true });
		symlinkSync(join(fh, ".flywheel", "bin"), join(fh, "alias-bin"));
		const opts = { globalBinDir: join(fh, ".flywheel", "bin") };
		expect(isGlobalBinDir(join(fh, ".flywheel", "bin"), opts)).toBe(true);
		expect(isGlobalBinDir(`${fh}/.flywheel//bin`, opts)).toBe(true);
		expect(isGlobalBinDir(join(fh, "alias-bin"), opts)).toBe(true);
		expect(isGlobalBinDir(join(fh, "elsewhere"), opts)).toBe(false);
	});

	it("clean-host allow-missing: recognized as global, zero side effects", () => {
		const ch = join(TSB, "cleanhost");
		mkdirSync(ch, { recursive: true });
		const opts = { globalBinDir: join(ch, ".flywheel", "bin") };
		expect(isGlobalBinDir(join(ch, ".flywheel", "bin"), opts)).toBe(true);
		expect(existsSync(join(ch, ".flywheel"))).toBe(false);
	});

	it("fail-closed on unresolvable input", () => {
		expect(isGlobalBinDir("/nonexistent-fly1389/../weird")).toBe(true);
	});
});

describe("canonicalizeAllowMissing", () => {
	it("resolves the longest existing ancestor and appends the missing suffix", () => {
		const base = join(TSB, "exists");
		mkdirSync(base, { recursive: true });
		const canonBase = canonicalizeAllowMissing(base);
		expect(canonicalizeAllowMissing(join(base, "missing", "deep"))).toBe(
			`${canonBase}/missing/deep`,
		);
	});

	it("throws on dot segments inside the missing suffix", () => {
		expect(() =>
			canonicalizeAllowMissing("/nonexistent-fly1389/../x"),
		).toThrow();
		expect(() => canonicalizeAllowMissing("")).toThrow();
	});

	it("strips trailing slashes", () => {
		const base = join(TSB, "exists2");
		mkdirSync(base, { recursive: true });
		expect(canonicalizeAllowMissing(`${base}/`)).toBe(
			canonicalizeAllowMissing(base),
		);
	});
});
