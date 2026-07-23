import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	normalizeGitHubRepoSlug,
	resolveBoundRepositoryAuthority,
} from "../repository-authority.js";

const cleanups: string[] = [];

afterEach(() => {
	for (const root of cleanups.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function createRepository(
	parent: string,
	name: string,
	remote: string,
): string {
	const repo = join(parent, name);
	mkdirSync(repo, { recursive: true });
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "config", "user.email", "fly1434@test"]);
	execFileSync("git", ["-C", repo, "config", "user.name", "FLY-1434"]);
	writeFileSync(join(repo, "README.md"), `${name}\n`);
	execFileSync("git", ["-C", repo, "add", "README.md"]);
	execFileSync("git", ["-C", repo, "commit", "-q", "-m", "initial"]);
	execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
	return realpathSync(repo);
}

describe("FLY-1434 bound repository authority", () => {
	it.each([
		["git@github.com:GeoForge3D/flywheel.git", "geoforge3d/flywheel"],
		["https://github.com/GeoForge3D/flywheel.git", "geoforge3d/flywheel"],
	])("normalizes GitHub remote %s", (remote, expected) => {
		expect(normalizeGitHubRepoSlug(remote)).toBe(expected);
	});

	it("derives main and nested repository identities and exact server HEADs", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1434-repo-authority-"));
		cleanups.push(root);
		const main = createRepository(
			root,
			"main",
			"git@github.com:GeoForge3D/flywheel.git",
		);
		const nested = createRepository(
			main,
			"nested",
			"https://github.com/GeoForge3D/flywheel-dashboard.git",
		);

		await expect(
			resolveBoundRepositoryAuthority({ authorityRoot: main }),
		).resolves.toEqual({
			path: main,
			identity: "__main__",
			probeRepoSlug: "geoforge3d/flywheel",
			headSha: execFileSync("git", ["-C", main, "rev-parse", "HEAD"], {
				encoding: "utf8",
			})
				.trim()
				.toLowerCase(),
		});
		await expect(
			resolveBoundRepositoryAuthority({
				authorityRoot: main,
				requestedRepoPath: "nested",
			}),
		).resolves.toMatchObject({
			path: nested,
			identity: "geoforge3d/flywheel-dashboard",
			probeRepoSlug: "geoforge3d/flywheel-dashboard",
		});
	});

	it("rejects traversal and non-repository subdirectories", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1434-repo-authority-"));
		cleanups.push(root);
		const main = createRepository(
			root,
			"main",
			"git@github.com:GeoForge3D/flywheel.git",
		);
		mkdirSync(join(main, "plain"));

		await expect(
			resolveBoundRepositoryAuthority({
				authorityRoot: main,
				requestedRepoPath: "../outside",
			}),
		).rejects.toThrow("safe relative path");
		await expect(
			resolveBoundRepositoryAuthority({
				authorityRoot: main,
				requestedRepoPath: "plain",
			}),
		).rejects.toThrow("exact git repository root");
	});
});
