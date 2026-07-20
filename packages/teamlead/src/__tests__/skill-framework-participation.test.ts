/**
 * FLY-1356 fix round 2 (Codex R1 HIGH-1): the split-participation reader must
 * treat a NON-MAPPING `skill_framework` key as malformed config (THROW →
 * Blueprint pins the project to A), never as the permissive participate=true
 * default. Acceptance requires REAL config parses — every case below writes a
 * real yaml file and runs the production reader against it, no mocked parser.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeSkillFrameworkParticipationReader } from "../bridge/skill-framework-participation.js";

const dirs: string[] = [];

function readerFor(
	yaml: string | undefined,
): (p: string | undefined) => boolean {
	const dir = mkdtempSync(join(tmpdir(), "fly1356-participation-"));
	dirs.push(dir);
	const configPath = join(dir, "config.yaml");
	if (yaml !== undefined) writeFileSync(configPath, yaml);
	return makeSkillFrameworkParticipationReader(configPath);
}

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("makeSkillFrameworkParticipationReader", () => {
	it("split: false → project opted out", () => {
		expect(readerFor("skill_framework:\n  split: false\n")("p")).toBe(false);
	});

	it("split: true → participates", () => {
		expect(readerFor("skill_framework:\n  split: true\n")("p")).toBe(true);
	});

	it("missing config file (ENOENT) → participates (default)", () => {
		expect(readerFor(undefined)("p")).toBe(true);
	});

	it("config without a skill_framework key → participates (default)", () => {
		expect(readerFor("agents:\n  exec:\n    agent_file: x.md\n")("p")).toBe(
			true,
		);
	});

	it("bare skill_framework: key (parses as null) → participates (default)", () => {
		expect(readerFor("skill_framework:\n")("p")).toBe(true);
	});

	// Codex R1 HIGH-1 acceptance case: `skill_framework: []` used to read as
	// undefined.split → silent participate=true. Malformed config must THROW
	// so Blueprint fails closed (project pinned to A + warn), never silently
	// enter the split.
	it("skill_framework: [] (non-mapping) → THROWS, never the permissive default", () => {
		expect(() => readerFor("skill_framework: []\n")("p")).toThrow(
			/skill_framework must be a mapping/,
		);
	});

	it("skill_framework as a scalar → THROWS", () => {
		expect(() => readerFor('skill_framework: "yes"\n')("p")).toThrow(
			/skill_framework must be a mapping/,
		);
	});

	it("skill_framework as a list of mappings → THROWS", () => {
		expect(() =>
			readerFor("skill_framework:\n  - split: false\n")("p"),
		).toThrow(/skill_framework must be a mapping/);
	});

	it("non-boolean split → THROWS (pre-existing contract preserved)", () => {
		expect(() => readerFor('skill_framework:\n  split: "yes"\n')("p")).toThrow(
			/skill_framework.split must be a boolean/,
		);
	});

	// Codex R2 (whitelist ruling): !!set parses to a Set and !!binary to a
	// Uint8Array — non-Array objects whose .split is undefined, so the R1
	// typeof/Array BLACKLIST read them as the permissive default. Only the
	// plain-record whitelist (prototype Object.prototype or null) kills them.
	it("skill_framework as !!set (Set) → THROWS, never the permissive default", () => {
		expect(() =>
			readerFor("skill_framework: !!set\n  ? a\n  ? b\n")("p"),
		).toThrow(/skill_framework must be a mapping/);
	});

	it("skill_framework as !!binary (Uint8Array) → THROWS, never the permissive default", () => {
		expect(() =>
			readerFor("skill_framework: !!binary aGVsbG8=\n")("p"),
		).toThrow(/skill_framework must be a mapping/);
	});
});
