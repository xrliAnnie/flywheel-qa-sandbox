import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyEnvChange,
	computeEnvSha,
	readEnvValue,
	writeEnvFileAtomic,
} from "../bridge/env-file-writer.js";

const SAMPLE = [
	"# flywheel env",
	"FLYWHEEL_AUTO_QA=0",
	"CASS_BOT_TOKEN=abc123",
	"",
].join("\n");

describe("readEnvValue", () => {
	it("reads a simple KEY=value", () => {
		expect(readEnvValue(SAMPLE, "FLYWHEEL_AUTO_QA")).toBe("0");
		expect(readEnvValue(SAMPLE, "CASS_BOT_TOKEN")).toBe("abc123");
	});
	it("undefined when absent", () => {
		expect(readEnvValue(SAMPLE, "NOT_THERE")).toBeUndefined();
	});
	it("ignores commented lines and takes the last assignment", () => {
		const c = "#FLYWHEEL_X=1\nFLYWHEEL_X=0\nFLYWHEEL_X=1\n";
		expect(readEnvValue(c, "FLYWHEEL_X")).toBe("1");
	});
	it("reads an export form", () => {
		expect(readEnvValue("export FLYWHEEL_X=1\n", "FLYWHEEL_X")).toBe("1");
	});
});

describe("computeEnvSha", () => {
	it("is deterministic and changes with content", () => {
		expect(computeEnvSha(SAMPLE)).toBe(computeEnvSha(SAMPLE));
		expect(computeEnvSha(SAMPLE)).not.toBe(computeEnvSha(`${SAMPLE}X`));
	});
});

describe("applyEnvChange", () => {
	it("replaces an existing simple line in place, preserving other bytes", () => {
		const r = applyEnvChange(SAMPLE, "FLYWHEEL_AUTO_QA", "1");
		expect(r.ok).toBe(true);
		expect(r.next).toContain("FLYWHEEL_AUTO_QA=1");
		expect(r.next).toContain("# flywheel env");
		expect(r.next).toContain("CASS_BOT_TOKEN=abc123");
		expect(readEnvValue(r.next as string, "FLYWHEEL_AUTO_QA")).toBe("1");
	});

	it("appends an absent key (keeping the trailing blank line)", () => {
		const r = applyEnvChange(SAMPLE, "FLYWHEEL_NEW", "1");
		expect(r.ok).toBe(true);
		expect(readEnvValue(r.next as string, "FLYWHEEL_NEW")).toBe("1");
		expect((r.next as string).endsWith("\n")).toBe(true);
	});

	it("deletes an existing key (null)", () => {
		const r = applyEnvChange(SAMPLE, "FLYWHEEL_AUTO_QA", null);
		expect(r.ok).toBe(true);
		expect(readEnvValue(r.next as string, "FLYWHEEL_AUTO_QA")).toBeUndefined();
		expect(r.next).toContain("CASS_BOT_TOKEN=abc123");
	});

	it("delete of an absent key is a no-op", () => {
		const r = applyEnvChange(SAMPLE, "FLYWHEEL_NOPE", null);
		expect(r.ok).toBe(true);
		expect(r.next).toBe(SAMPLE);
	});

	it("rejects an unsafe key name", () => {
		expect(applyEnvChange(SAMPLE, "bad-key", "1").ok).toBe(false);
		expect(applyEnvChange(SAMPLE, "9KEY", "1").ok).toBe(false);
	});

	it("rejects an unsafe value (space / quote / $ / newline)", () => {
		expect(applyEnvChange(SAMPLE, "FLYWHEEL_X", "a b").ok).toBe(false);
		expect(applyEnvChange(SAMPLE, "FLYWHEEL_X", '"x"').ok).toBe(false);
		expect(applyEnvChange(SAMPLE, "FLYWHEEL_X", "$(rm)").ok).toBe(false);
		expect(applyEnvChange(SAMPLE, "FLYWHEEL_X", "a\nb").ok).toBe(false);
	});

	it("refuses to touch an export form (edit by hand)", () => {
		const r = applyEnvChange("export FLYWHEEL_X=1\n", "FLYWHEEL_X", "0");
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/export/);
	});

	it("refuses to touch a quoted value", () => {
		const r = applyEnvChange('FLYWHEEL_X="1"\n', "FLYWHEEL_X", "0");
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/quoted/);
	});

	it("refuses a duplicated key", () => {
		const r = applyEnvChange("FLYWHEEL_X=1\nFLYWHEEL_X=0\n", "FLYWHEEL_X", "1");
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/more than once/);
	});

	it("a prefix key does NOT match (FLYWHEEL_X vs FLYWHEEL_XY)", () => {
		const c = "FLYWHEEL_XY=1\n";
		const r = applyEnvChange(c, "FLYWHEEL_X", "0");
		expect(r.ok).toBe(true);
		// FLYWHEEL_X was absent → appended; FLYWHEEL_XY untouched
		expect(readEnvValue(r.next as string, "FLYWHEEL_XY")).toBe("1");
		expect(readEnvValue(r.next as string, "FLYWHEEL_X")).toBe("0");
	});
});

describe("writeEnvFileAtomic", () => {
	const dirs: string[] = [];
	function tmp(): string {
		const d = mkdtempSync(join(tmpdir(), "ffenv-"));
		dirs.push(d);
		return d;
	}
	afterEach(() => {
		// best-effort; tmp dirs are small
	});

	it("writes content with 0600 perms", () => {
		const d = tmp();
		const p = join(d, ".env");
		writeEnvFileAtomic(p, "FLYWHEEL_X=1\n");
		expect(readFileSync(p, "utf-8")).toBe("FLYWHEEL_X=1\n");
		expect(statSync(p).mode & 0o777).toBe(0o600);
	});

	it("overwrites an existing file atomically", () => {
		const d = tmp();
		const p = join(d, ".env");
		writeFileSync(p, "old", { mode: 0o600 });
		writeEnvFileAtomic(p, "new");
		expect(readFileSync(p, "utf-8")).toBe("new");
	});

	it("refuses a symlink target", () => {
		const d = tmp();
		const real = join(d, "real");
		writeFileSync(real, "x");
		const link = join(d, ".env");
		symlinkSync(real, link);
		expect(() => writeEnvFileAtomic(link, "y")).toThrow(/symlink/);
	});

	it("refuses a group/world-writable parent dir", () => {
		const d = tmp();
		chmodSync(d, 0o777);
		expect(() => writeEnvFileAtomic(join(d, ".env"), "x")).toThrow(/writable/);
	});
});
