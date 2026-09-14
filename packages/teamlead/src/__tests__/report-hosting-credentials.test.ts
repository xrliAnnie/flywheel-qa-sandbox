import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	blobStoreIdFromToken,
	FileReportHostingCredentials,
} from "../bridge/report-hosting-credentials.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
it("reloads changed files, isolates credential keys and treats explicit empty as absent", () => {
	const dir = mkdtempSync(join(tmpdir(), "fly2538-credentials-"));
	dirs.push(dir);
	const path = join(dir, ".env");
	const env = { BLOB_READ_WRITE_TOKEN: "process-blob", VERCEL_TOKEN: "legacy" };
	writeFileSync(
		path,
		'BLOB_READ_WRITE_TOKEN=" file-a "\nREPORT_HOSTING_VERCEL_TOKEN=account-a\n',
	);
	const credentials = new FileReportHostingCredentials({
		envPath: path,
		env,
		warn: vi.fn(),
	});
	const first = credentials.snapshot("BLOB_READ_WRITE_TOKEN");
	expect(first).toMatchObject({ value: "file-a", source: "file" });
	expect(credentials.snapshot("VERCEL_TOKEN")).toMatchObject({
		value: "legacy",
		source: "process",
	});
	writeFileSync(path, "BLOB_READ_WRITE_TOKEN='file-b-longer'\n");
	const second = credentials.snapshot("BLOB_READ_WRITE_TOKEN");
	expect(second.value).toBe("file-b-longer");
	expect(second.generation).toBeGreaterThan(first.generation);
	expect(first.value).toBe("file-a");
	expect(
		credentials.snapshot("REPORT_HOSTING_VERCEL_TOKEN").value,
	).toBeUndefined();
	writeFileSync(path, "BLOB_READ_WRITE_TOKEN=\n");
	expect(credentials.snapshot("BLOB_READ_WRITE_TOKEN")).toMatchObject({
		value: undefined,
		source: "absent",
	});
});
it("falls back when the file is unreadable and warns once per failure transition", () => {
	const dir = mkdtempSync(join(tmpdir(), "fly2538-no-env-"));
	dirs.push(dir);
	const path = join(dir, ".env");
	const warn = vi.fn();
	const credentials = new FileReportHostingCredentials({
		envPath: path,
		env: { VERCEL_TOKEN: "legacy" },
		warn,
	});
	expect(credentials.snapshot("VERCEL_TOKEN").value).toBe("legacy");
	credentials.snapshot("VERCEL_TOKEN");
	expect(warn).toHaveBeenCalledTimes(1);
	writeFileSync(path, "VERCEL_TOKEN=from-file");
	expect(credentials.snapshot("VERCEL_TOKEN").source).toBe("file");
	rmSync(path);
	credentials.snapshot("VERCEL_TOKEN");
	expect(warn).toHaveBeenCalledTimes(2);
	expect(warn.mock.calls.flat().join(" ")).not.toContain("legacy");
});
it("extracts a canonical Blob store identity only from valid RW tokens", () => {
	expect(blobStoreIdFromToken("vercel_blob_rw_AbC123_secret")).toBe("abc123");
	expect(blobStoreIdFromToken("arbitrary")).toBeUndefined();
});
