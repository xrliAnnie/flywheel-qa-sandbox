import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBridgeBuildIdentity } from "../build-identity.js";

const SHA = "a".repeat(40);

describe("Bridge build identity", () => {
	it("uses the checkout identity only for an explicit source run", () => {
		expect(
			resolveBridgeBuildIdentity({
				env: {
					FLYWHEEL_BRIDGE_SOURCE_MODE: "1",
					FLYWHEEL_BRIDGE_SOURCE_SHA: SHA,
				},
			}),
		).toEqual({ mode: "source", buildSha: SHA });
	});

	it("reads an immutable artifact SHA for built execution", () => {
		const artifactPath = join(
			mkdtempSync(join(tmpdir(), "fly1655-build-")),
			"build.json",
		);
		writeFileSync(artifactPath, JSON.stringify({ artifactBuildSha: SHA }));
		expect(resolveBridgeBuildIdentity({ env: {}, artifactPath })).toEqual({
			mode: "built",
			buildSha: SHA,
			artifactBuildSha: SHA,
		});
	});

	it("does not guess when source or artifact identity is malformed", () => {
		expect(
			resolveBridgeBuildIdentity({
				env: {
					FLYWHEEL_BRIDGE_SOURCE_MODE: "1",
					FLYWHEEL_BRIDGE_SOURCE_SHA: "stale",
				},
			}),
		).toEqual({ mode: "unknown", buildSha: null });
	});
});
