import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	captureLeadRuntimeBuild,
	LEAD_BOOTSTRAP_FILES,
	makeLeadBuildIdentity,
} from "../lead-runtime-build.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lead-build-"));
	roots.push(root);
	for (const path of LEAD_BOOTSTRAP_FILES) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), path);
	}
	const identity = makeLeadBuildIdentity(root, "a".repeat(40));
	const artifact = join(root, "packages/teamlead/dist/build-identity.json");
	mkdirSync(dirname(artifact), { recursive: true });
	writeFileSync(artifact, JSON.stringify(identity));
	return { root, artifact, identity };
}
it("binds hot capability to the built bootstrap payload, not an environment assertion", () => {
	const f = fixture();
	expect(captureLeadRuntimeBuild(f.root)).toEqual({
		artifactBuildSha: "a".repeat(40),
		bootstrapBuildSha: "a".repeat(40),
	});
	writeFileSync(
		join(f.root, LEAD_BOOTSTRAP_FILES[0]!),
		"stale installed launcher",
	);
	expect(captureLeadRuntimeBuild(f.root)).toBeUndefined();
});
it("fails closed for legacy metadata, missing files, symlinks and malformed build identity", () => {
	const f = fixture();
	for (const value of [
		{ artifactBuildSha: "a".repeat(40) },
		{ ...f.identity, artifactBuildSha: "unknown" },
	]) {
		writeFileSync(f.artifact, JSON.stringify(value));
		expect(captureLeadRuntimeBuild(f.root)).toBeUndefined();
	}
	writeFileSync(f.artifact, JSON.stringify(f.identity));
	const target = join(f.root, LEAD_BOOTSTRAP_FILES[0]!);
	rmSync(target);
	expect(captureLeadRuntimeBuild(f.root)).toBeUndefined();
	const alternate = join(f.root, "alternate");
	writeFileSync(alternate, LEAD_BOOTSTRAP_FILES[0]!);
	symlinkSync(alternate, target);
	expect(captureLeadRuntimeBuild(f.root)).toBeUndefined();
});
it("returns a captured identity that cannot change when a later build replaces the marker", () => {
	const f = fixture();
	const captured = captureLeadRuntimeBuild(f.root);
	writeFileSync(
		f.artifact,
		JSON.stringify(makeLeadBuildIdentity(f.root, "b".repeat(40))),
	);
	expect(captured?.artifactBuildSha).toBe("a".repeat(40));
	expect(captureLeadRuntimeBuild(f.root)?.artifactBuildSha).toBe(
		"b".repeat(40),
	);
});

it("does not advertise compiled capability from a source-mode runtime", () => {
	expect(captureLeadRuntimeBuild()).toBeUndefined();
});
