import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CONTENT_REF_THRESHOLD,
	deleteContentRef,
	readContentRef,
	refDir,
	writeContentRef,
} from "../utils/content-ref.js";

describe("content-ref utilities", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-ref-test-"));
		dbPath = join(tmpDir, "comm.db");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("CONTENT_REF_THRESHOLD should be 2048", () => {
		expect(CONTENT_REF_THRESHOLD).toBe(2048);
	});

	it("refDir should return <db-dir>/refs/", () => {
		expect(refDir(dbPath)).toBe(join(tmpDir, "refs"));
	});

	describe("writeContentRef", () => {
		it("should create ref file and return path", () => {
			const content = "Hello, world!";
			const path = writeContentRef(dbPath, "msg-123", content);
			expect(path).toBe(join(tmpDir, "refs", "msg-123.txt"));
			expect(existsSync(path)).toBe(true);
			expect(readFileSync(path, "utf-8")).toBe(content);
		});

		it("should create refs directory if needed", () => {
			const refsPath = refDir(dbPath);
			expect(existsSync(refsPath)).toBe(false);
			writeContentRef(dbPath, "msg-1", "content");
			expect(existsSync(refsPath)).toBe(true);
		});
	});

	describe("readContentRef", () => {
		it("should read existing file", () => {
			const path = writeContentRef(dbPath, "msg-1", "content here");
			expect(readContentRef(path)).toBe("content here");
		});

		it("should return null for missing file", () => {
			expect(readContentRef("/nonexistent/path.txt")).toBeNull();
		});
	});

	describe("deleteContentRef", () => {
		it("should delete existing file", () => {
			const path = writeContentRef(dbPath, "msg-1", "content");
			expect(existsSync(path)).toBe(true);
			deleteContentRef(path);
			expect(existsSync(path)).toBe(false);
		});

		it("should not throw for missing file", () => {
			expect(() => deleteContentRef("/nonexistent/path.txt")).not.toThrow();
		});
	});
});
