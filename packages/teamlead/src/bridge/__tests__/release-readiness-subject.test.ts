import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	parseReadinessSubject,
	readLocalDeployedSha,
	readRunningSubject,
} from "../release-readiness/subject.js";

describe("readiness subject", () => {
	it("rejects whitespace around an API base version instead of inheriting regex end-of-line matching", () => {
		expect(parseReadinessSubject("1.56.0\n", "a".repeat(40))).toBeNull();
	});
	it("reads build identity separately from deployment evidence and fails closed on missing or invalid files", () => {
		const dir = mkdtempSync(join(tmpdir(), "readiness-subject-"));
		try {
			const versionPath = join(dir, "VERSION");
			const deployedPath = join(dir, "deployed-sha");
			const identity = {
				mode: "built" as const,
				buildSha: "a".repeat(40),
				artifactBuildSha: "a".repeat(40),
			};
			expect(readRunningSubject(versionPath, identity)).toBeNull();
			expect(readLocalDeployedSha(deployedPath)).toBeNull();
			writeFileSync(versionPath, "v1.56.0\n");
			writeFileSync(deployedPath, `${"b".repeat(40)}\n`);
			expect(readRunningSubject(versionPath, identity)).toEqual({
				baseVersion: "1.56.0",
				sourceCommit: identity.buildSha,
			});
			expect(readLocalDeployedSha(deployedPath)).toBe("b".repeat(40));
			expect(
				readRunningSubject(versionPath, { mode: "unknown", buildSha: null }),
			).toBeNull();
			writeFileSync(versionPath, "1.56.0-beta.1");
			writeFileSync(deployedPath, "abcdef1");
			expect(readRunningSubject(versionPath, identity)).toBeNull();
			expect(readLocalDeployedSha(deployedPath)).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("accepts only an exact base version and a full lowercase source commit", () => {
		const sourceCommit = "a".repeat(40);
		expect(parseReadinessSubject("1.56.0", sourceCommit)).toEqual({
			baseVersion: "1.56.0",
			sourceCommit,
		});
		for (const base of ["v1.56.0", "1.56.0-beta.1", "01.56.0", "", undefined]) {
			expect(parseReadinessSubject(base, sourceCommit)).toBeNull();
		}
		for (const sha of [
			"a".repeat(7),
			"A".repeat(40),
			`${sourceCommit}\n`,
			"g".repeat(40),
			undefined,
		]) {
			expect(parseReadinessSubject("1.56.0", sha)).toBeNull();
		}
	});
});
