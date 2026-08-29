import { describe, expect, it } from "vitest";
import { classifyCwd } from "../classifier.js";

const HOME = "/Users/tester";
const c = (cwd: string) => classifyCwd(cwd, HOME);

describe("classifyCwd", () => {
	it("classifies a runner issue worktree", () => {
		expect(c("/Users/tester/Dev/flywheel-FLY-614")).toMatchObject({
			kind: "runner",
			project: "flywheel",
			issue: "FLY-614",
			role: "runner",
		});
	});

	it("uppercases the issue id regardless of cwd casing", () => {
		expect(c("/Users/tester/Dev/flywheel-fly-612")).toMatchObject({
			kind: "runner",
			project: "flywheel",
			issue: "FLY-612",
		});
	});

	it("extracts a role suffix (e.g. qa)", () => {
		expect(c("/Users/tester/Dev/geoforge3d-GEO-381-qa")).toMatchObject({
			kind: "runner",
			project: "geoforge3d",
			issue: "GEO-381",
			role: "qa",
		});
	});

	it("ignores nested worktrees/ subdirectories (parses only first /Dev/ segment)", () => {
		expect(
			c("/Users/tester/Dev/flywheel-FLY-612/worktrees/fly-612-impl"),
		).toMatchObject({
			kind: "runner",
			project: "flywheel",
			issue: "FLY-612",
		});
	});

	it("classifies a main checkout", () => {
		expect(c("/Users/tester/Dev/flywheel")).toMatchObject({
			kind: "main",
			project: "flywheel",
			issue: null,
		});
	});

	it("classifies a capitalized main checkout (GeoForge3D)", () => {
		expect(c("/Users/tester/Dev/GeoForge3D")).toMatchObject({
			kind: "main",
			project: "geoforge3d",
		});
	});

	it("folds a known-project prefix with non-standard suffix into the project (sub-<uuid>)", () => {
		expect(
			c("/Users/tester/Dev/sub-c7d63e46-fd29-459b-bfc4-b9e05e9affd8"),
		).toMatchObject({
			kind: "runner",
			project: "sub",
			issue: null,
		});
	});

	it("treats an unknown Dev dir as its own project (personal-assistant)", () => {
		expect(c("/Users/tester/Dev/personal-assistant")).toMatchObject({
			kind: "main",
			project: "personal-assistant",
		});
	});

	it("classifies a lead workspace", () => {
		expect(
			c("/Users/tester/.flywheel/lead-workspace/flywheel-eng-lead"),
		).toMatchObject({
			kind: "lead",
			who: "flywheel-eng-lead",
			project: null,
		});
	});

	it("classifies a sandbox/scratchpad path", () => {
		expect(
			c("/private/tmp/claude-501/-Users-x-Dev-flywheel-FLY-1/abc/scratchpad")
				.kind,
		).toBe("sandbox");
		expect(
			c("/private/tmp/flywheel-test-slot-2/project-slot-2-FLY-124").kind,
		).toBe("sandbox");
	});

	it("buckets non-Dev cwds explicitly (never silently dropped)", () => {
		expect(c("/Users/tester")).toMatchObject({
			kind: "other",
			who: "home-root",
		});
		expect(c("/Users/tester/Documents/notes")).toMatchObject({
			kind: "other",
			who: "home-other",
		});
		expect(c("/opt/weird/path")).toMatchObject({
			kind: "other",
			who: "unknown",
		});
	});

	it("handles empty/null cwd as unknown other", () => {
		expect(classifyCwd(null, HOME)).toMatchObject({
			kind: "other",
			who: "unknown",
		});
		expect(classifyCwd("", HOME)).toMatchObject({
			kind: "other",
			who: "unknown",
		});
	});
});
