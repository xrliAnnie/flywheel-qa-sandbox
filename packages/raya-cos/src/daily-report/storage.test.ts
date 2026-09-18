import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	deleteDailyReportBody,
	pruneDailyReportBodies,
	readDailyReportBody,
	writeDailyReportBody,
} from "./storage.js";

const roots: string[] = [];

function temporaryStateDir(): string {
	const root = mkdtempSync(join(tmpdir(), "raya-report-storage-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("daily report body storage", () => {
	it("atomically writes an owner-only content-addressed body and reads it", () => {
		const stateDir = temporaryStateDir();
		const body = "## 今天各项目发生了什么\n完成。\n\n## 我的判断\n继续观察。";

		const reference = writeDailyReportBody(stateDir, "2026-09-06", body);

		expect(reference.bodyFile).toMatch(/^2026-09-06\.body\.[0-9a-f]{64}\.md$/);
		expect(reference.bodyBytes).toBe(Buffer.byteLength(body, "utf8"));
		expect(
			statSync(join(stateDir, "daily-report", reference.bodyFile)).mode & 0o777,
		).toBe(0o600);
		expect(readDailyReportBody(stateDir, reference)).toBe(body);
		expect(
			readFileSync(join(stateDir, "daily-report", reference.bodyFile), "utf8"),
		).toBe(body);
		expect(
			existsSync(join(stateDir, "daily-report", `${reference.bodyFile}.tmp`)),
		).toBe(false);
	});

	it("adopts an already-identical body without rewriting its permissions", () => {
		const stateDir = temporaryStateDir();
		const first = writeDailyReportBody(stateDir, "2026-09-06", "same body");
		const path = join(stateDir, "daily-report", first.bodyFile);
		chmodSync(path, 0o400);

		const second = writeDailyReportBody(stateDir, "2026-09-06", "same body");

		expect(second).toEqual(first);
		expect(statSync(path).mode & 0o777).toBe(0o400);
	});

	it("fails closed for path traversal, mismatched references, and tampering", () => {
		const stateDir = temporaryStateDir();
		const reference = writeDailyReportBody(stateDir, "2026-09-06", "body");

		expect(() =>
			readDailyReportBody(stateDir, {
				...reference,
				bodyFile: `../${reference.bodyFile}`,
			}),
		).toThrow(/reference/i);
		expect(() =>
			readDailyReportBody(stateDir, {
				...reference,
				bodySha256: "f".repeat(64),
			}),
		).toThrow(/reference/i);
		writeFileSync(
			join(stateDir, "daily-report", reference.bodyFile),
			"tampered",
			"utf8",
		);
		expect(() => readDailyReportBody(stateDir, reference)).toThrow(
			/integrity/i,
		);
	});

	it("prunes only stale bodies for the same date after the state switch", () => {
		const stateDir = temporaryStateDir();
		const old = writeDailyReportBody(stateDir, "2026-09-06", "old");
		const keep = writeDailyReportBody(stateDir, "2026-09-06", "new");
		const otherDate = writeDailyReportBody(stateDir, "2026-09-05", "other");

		pruneDailyReportBodies(stateDir, "2026-09-06", keep.bodyFile);

		expect(existsSync(join(stateDir, "daily-report", old.bodyFile))).toBe(
			false,
		);
		expect(existsSync(join(stateDir, "daily-report", keep.bodyFile))).toBe(
			true,
		);
		expect(existsSync(join(stateDir, "daily-report", otherDate.bodyFile))).toBe(
			true,
		);
	});

	it("deletes only a validated referenced body and tolerates replay", () => {
		const stateDir = temporaryStateDir();
		const reference = writeDailyReportBody(stateDir, "2026-09-06", "body");

		deleteDailyReportBody(stateDir, reference);
		deleteDailyReportBody(stateDir, reference);

		expect(existsSync(join(stateDir, "daily-report", reference.bodyFile))).toBe(
			false,
		);
	});
});
