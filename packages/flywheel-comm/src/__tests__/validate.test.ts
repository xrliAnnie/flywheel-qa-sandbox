import { describe, expect, it } from "vitest";
import { buildSafeRegex, validateProjectName } from "../validate.js";

describe("validateProjectName", () => {
	it("should accept valid project names", () => {
		expect(() => validateProjectName("geoforge3d")).not.toThrow();
		expect(() => validateProjectName("my-project")).not.toThrow();
		expect(() => validateProjectName("project_v2")).not.toThrow();
		expect(() => validateProjectName("a")).not.toThrow();
	});

	it("should reject names with forward slash", () => {
		expect(() => validateProjectName("foo/bar")).toThrow(
			"Invalid project name",
		);
		expect(() => validateProjectName("/etc/passwd")).toThrow(
			"Invalid project name",
		);
	});

	it("should reject names with backslash", () => {
		expect(() => validateProjectName("foo\\bar")).toThrow(
			"Invalid project name",
		);
	});

	it("should reject names with ..", () => {
		expect(() => validateProjectName("..")).toThrow("Invalid project name");
		expect(() => validateProjectName("foo..bar")).toThrow(
			"Invalid project name",
		);
		expect(() => validateProjectName("../etc")).toThrow("Invalid project name");
	});
});

describe("buildSafeRegex", () => {
	it("should accept safe patterns", () => {
		expect(buildSafeRegex("hello")).toBeInstanceOf(RegExp);
		expect(buildSafeRegex("error|warning")).toBeInstanceOf(RegExp);
		expect(buildSafeRegex("[a-z]+")).toBeInstanceOf(RegExp);
		expect(buildSafeRegex("^foo.*bar$")).toBeInstanceOf(RegExp);
	});

	it("should reject nested quantifiers (ReDoS)", () => {
		expect(() => buildSafeRegex("(a+)+")).toThrow("Unsafe regex");
		expect(() => buildSafeRegex("(.*)*")).toThrow("Unsafe regex");
		expect(() => buildSafeRegex("([a-z]+)*")).toThrow("Unsafe regex");
		expect(() => buildSafeRegex("(a+)+$")).toThrow("Unsafe regex");
	});

	it("should reject patterns that are too long", () => {
		expect(() => buildSafeRegex("a".repeat(201))).toThrow("Pattern too long");
	});

	it("should reject invalid regex syntax", () => {
		expect(() => buildSafeRegex("[unclosed")).toThrow("Invalid regex");
	});

	it("should use specified flags", () => {
		const r = buildSafeRegex("test", "gi");
		expect(r.flags).toContain("g");
		expect(r.flags).toContain("i");
	});
});
