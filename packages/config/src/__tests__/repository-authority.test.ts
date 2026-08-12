import { describe, expect, it } from "vitest";
import { parseGitHubPushEndpoint } from "../index.js";
import { normalizeGitHubRepoSlug } from "../repository-authority.js";

describe("legacy repository slug normalization", () => {
	it("preserves every accepted and rejected legacy remote shape", () => {
		const accepted: ReadonlyArray<readonly [string, string]> = [
			["git@github.com:GeoForge3D/flywheel.git", "geoforge3d/flywheel"],
			["https://github.com/GeoForge3D/flywheel.git", "geoforge3d/flywheel"],
			["ssh://git@github.com/GeoForge3D/flywheel.git", "geoforge3d/flywheel"],
			["git://github.com/GeoForge3D/flywheel.git", "geoforge3d/flywheel"],
			["https://example.test/GeoForge3D/flywheel", "geoforge3d/flywheel"],
			["user@example.test:GeoForge3D/flywheel", "geoforge3d/flywheel"],
			["/tmp/GeoForge3D/flywheel", "geoforge3d/flywheel"],
			["nested/GeoForge3D/flywheel/", "geoforge3d/flywheel"],
			["C:\\src\\GeoForge3D\\flywheel.GIT", "geoforge3d/flywheel"],
			[
				"https://github.com/ignored/GeoForge3D/flywheel.git?x=1#y",
				"geoforge3d/flywheel",
			],
		];
		for (const [remote, expected] of accepted) {
			expect(normalizeGitHubRepoSlug(remote), remote).toBe(expected);
		}

		const rejected: ReadonlyArray<readonly [string, string]> = [
			["flywheel.git", "repository origin cannot be normalized to owner/repo"],
			[
				"git@github.com:flywheel.git",
				"repository origin cannot be normalized to owner/repo",
			],
			[
				"https://github.com/flywheel.git",
				"repository origin cannot be normalized to owner/repo",
			],
			[
				"Geo Forge/flywheel",
				"repository origin contains an invalid owner/repo",
			],
			[
				"GeoForge3D/fly wheel",
				"repository origin contains an invalid owner/repo",
			],
			[
				"https://github.com/GeoForge3D/fly%20wheel",
				"repository origin contains an invalid owner/repo",
			],
		];
		for (const [remote, message] of rejected) {
			expect(() => normalizeGitHubRepoSlug(remote), remote).toThrow(message);
		}
		expect(() => normalizeGitHubRepoSlug("not a url://owner/repo")).toThrow();
	});
});

describe("strict GitHub push-endpoint attestation", () => {
	it("accepts only explicit supported github.com owner/repo endpoints", () => {
		const accepted: ReadonlyArray<readonly [string, string]> = [
			["https://github.com/Owner/Repo", "owner/repo"],
			["HTTPS://GitHub.com/Owner/Repo.GIT", "owner/repo"],
			["ssh://git@github.com/Owner/Repo.git", "owner/repo"],
			["ssh://GitHub.com/Owner/Repo", "owner/repo"],
			["git@GitHub.com:Owner/Repo.git", "owner/repo"],
			["git@github.com:Owner/Repo.git.git", "owner/repo.git"],
		];
		for (const [endpoint, expected] of accepted) {
			expect(parseGitHubPushEndpoint(endpoint), endpoint).toBe(expected);
		}

		const rejected = [
			"http://github.com/owner/repo",
			"git://github.com/owner/repo",
			"https://example.test/owner/repo",
			"https://github.com.evil.test/owner/repo",
			"ssh://git@example.test/owner/repo",
			"git@example.test:owner/repo",
			"/tmp/owner/repo",
			"./owner/repo",
			"C:\\src\\owner\\repo",
			"file:///owner/repo",
			"github.com/owner/repo",
			"//github.com/owner/repo",
			"owner/repo",
			"git@github.com:repo",
			"git@github.com:/repo",
			"https://github.com/repo",
			"https://github.com//repo",
			"https://github.com/owner/",
			"https://github.com/owner/repo/extra",
			"git@github.com:owner/repo/extra",
			"https://github.com/owner/repo/",
			"https://user@github.com/owner/repo",
			"https://user:secret@github.com/owner/repo",
			"ssh://root@github.com/owner/repo",
			"ssh://git:secret@github.com/owner/repo",
			"https://github.com:443/owner/repo",
			"ssh://git@github.com:22/owner/repo",
			"https://github.com/owner/repo?ref=main",
			"https://github.com/owner/repo#fragment",
			"https://github.com/owner/repo?",
			"https://github.com/owner/repo#",
			"https://github.com/owner/re%70o",
			"https://github.com/owner/repo%2Fextra",
			"https://github.com/owner/../repo",
			"https://github.com/./repo",
			"https://github.com/owner/.git",
			"https://github.com/owner/re po",
			"https://github.com/owner/repo\n",
			"https://github.com",
			"https://[github.com/owner/repo",
			"ssh:/git@github.com/owner/repo",
			"not a url",
		] as const;
		for (const endpoint of rejected) {
			expect(() => parseGitHubPushEndpoint(endpoint), endpoint).toThrow(
				"push endpoint must be an explicit github.com owner/repo remote",
			);
		}
	});
});
