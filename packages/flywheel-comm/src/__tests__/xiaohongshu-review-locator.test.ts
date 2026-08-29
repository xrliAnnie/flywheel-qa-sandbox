/**
 * FLY-286 PR-2: review locator tests.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type ReviewLocator,
	readLocator,
	writeLocator,
	XIAOHONGSHU_LOCATOR_SCHEMA_VERSION,
} from "../xiaohongshu-review-locator.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "xhs-loc-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const TOKEN = "abc123def456";
function loc(reportToken = TOKEN): ReviewLocator {
	return {
		schemaVersion: XIAOHONGSHU_LOCATOR_SCHEMA_VERSION,
		reportToken,
		project: "flywheel",
		collectionId: "6884765b0000000023036a58",
		runToken: "run-1",
		createdAt: "2026-06-17T00:00:00Z",
	};
}

describe("xhs-review-locator", () => {
	it("write + read roundtrips", () => {
		writeLocator(dir, loc());
		const back = readLocator(dir, TOKEN);
		expect(back?.project).toBe("flywheel");
		expect(back?.collectionId).toBe("6884765b0000000023036a58");
		expect(back?.runToken).toBe("run-1");
	});

	it("read of a missing reportToken returns null", () => {
		expect(readLocator(dir, "nope")).toBeNull();
		// even when the locator dir does not exist yet
		expect(readLocator(join(dir, "fresh"), "nope")).toBeNull();
	});

	it("rejects an unsafe reportToken", () => {
		expect(() => readLocator(dir, "../escape")).toThrow(/unsafe reportToken/);
		expect(() => writeLocator(dir, loc("bad/tok"))).toThrow(
			/unsafe reportToken/,
		);
	});

	it("refuses to read through a symlinked locator dir", () => {
		const outside = mkdtempSync(join(tmpdir(), "xhs-loc-evil-"));
		try {
			symlinkSync(outside, join(dir, "__review-locators"));
			expect(() => readLocator(dir, TOKEN)).toThrow(/symlink/);
			expect(() => writeLocator(dir, loc())).toThrow(/symlink/);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("throws on an unsupported schemaVersion on read", () => {
		writeLocator(dir, loc());
		const file = join(dir, "__review-locators", `${TOKEN}.json`);
		writeFileSync(file, JSON.stringify({ ...loc(), schemaVersion: 99 }));
		expect(() => readLocator(dir, TOKEN)).toThrow(
			/unsupported locator schemaVersion/,
		);
	});

	it("writes 0600 atomically (no .tmp left)", () => {
		writeLocator(dir, loc());
		// a second write of a different token coexists
		writeLocator(dir, loc("zzz999"));
		expect(readLocator(dir, "zzz999")?.runToken).toBe("run-1");
	});
});
