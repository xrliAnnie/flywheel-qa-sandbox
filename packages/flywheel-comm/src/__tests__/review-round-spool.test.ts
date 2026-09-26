import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	countReviewRoundSpool,
	parseReviewRoundSpoolFile,
	REVIEW_ROUND_SPOOL_MAX_BYTES,
	reviewRoundSpoolDir,
	writeReviewRoundSpoolRecord,
} from "../review-round-spool.js";

const EXEC = "11111111-2222-4333-8444-555555555555";
const TURN = "01a0daf6-2634-7a23-a8e9-c1669023f451";

function body(overrides: Record<string, unknown> = {}) {
	return {
		executionId: EXEC,
		reviewType: "design",
		codexThreadId: "01a0daf6-1f50-7522-b7dc-f0b3812a5dab",
		codexTurnId: TURN,
		round: 2,
		verdict: "CHANGES_REQUESTED",
		modelEvidence: "unavailable",
		reviewedAt: "2026-09-25T11:00:00.000Z",
		...overrides,
	};
}

describe("FLY-2891 review round spool", () => {
	let dir: string;
	beforeEach(() => {
		dir = join(mkdtempSync(join(tmpdir(), "fly2891-spool-")), "spool");
	});
	afterEach(() => {
		rmSync(join(dir, ".."), { recursive: true, force: true });
	});

	it("resolves the spool under the Flywheel state root", () => {
		expect(reviewRoundSpoolDir({ FLYWHEEL_STATE_DIR: "/x/.flywheel" })).toBe(
			"/x/.flywheel/state/review-round-spool",
		);
		expect(reviewRoundSpoolDir({ FLYWHEEL_STATE_DIR: " " })).toMatch(
			/\.flywheel\/state\/review-round-spool$/,
		);
	});

	it("writes one private file per delivery with a unique name", () => {
		const first = writeReviewRoundSpoolRecord(dir, body());
		const second = writeReviewRoundSpoolRecord(dir, body());
		expect(first).not.toBe(second);
		const names = readdirSync(dir).filter((name) => !name.startsWith("."));
		expect(names).toHaveLength(2);
		for (const name of names)
			expect(name).toMatch(
				new RegExp(
					`^${EXEC}\\.design\\.${TURN}\\.round\\.[0-9a-f-]{36}\\.json$`,
				),
			);
		expect(statSync(first).mode & 0o777).toBe(0o600);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(parseReviewRoundSpoolFile(readFileSync(first, "utf8"))).toEqual({
			ok: true,
			record: expect.objectContaining({ schemaVersion: 1, body: body() }),
		});
	});

	it("names gate acceptances with a gate segment", () => {
		const path = writeReviewRoundSpoolRecord(
			dir,
			body({ kind: "gate_acceptance" }),
		);
		expect(path).toMatch(/\.gate\.[0-9a-f-]{36}\.json$/);
	});

	it("quarantines with a reason file beside the record", () => {
		const path = writeReviewRoundSpoolRecord(dir, body(), {
			quarantineReason: "conflict: review round already recorded",
		});
		expect(path).toContain(join(dir, "quarantine"));
		expect(readFileSync(`${path}.reason`, "utf8")).toContain("conflict");
		expect(countReviewRoundSpool(dir)).toEqual({ pending: 0, quarantined: 1 });
	});

	it("refuses path-injecting execution or turn ids", () => {
		expect(() =>
			writeReviewRoundSpoolRecord(dir, body({ executionId: "../../etc" })),
		).toThrow(/execution id/);
		expect(() =>
			writeReviewRoundSpoolRecord(dir, body({ codexTurnId: "a/b/c/d/e/f" })),
		).toThrow(/turn id/);
		expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
	});

	it("refuses records larger than the reconciler would accept", () => {
		expect(() =>
			writeReviewRoundSpoolRecord(
				dir,
				body({ reviewedTarget: "x".repeat(REVIEW_ROUND_SPOOL_MAX_BYTES) }),
			),
		).toThrow(/too large/);
	});

	it("counts pending and quarantined records, ignoring temp files", () => {
		expect(countReviewRoundSpool(dir)).toEqual({ pending: 0, quarantined: 0 });
		writeReviewRoundSpoolRecord(dir, body());
		writeReviewRoundSpoolRecord(dir, body({ round: 3 }));
		writeReviewRoundSpoolRecord(dir, body(), { quarantineReason: "invalid" });
		expect(countReviewRoundSpool(dir)).toEqual({ pending: 2, quarantined: 1 });
	});

	it("does not count symlinks as pending work", () => {
		writeReviewRoundSpoolRecord(dir, body());
		const target = join(dir, "..", "elsewhere.json");
		writeFileSync(target, "{}");
		symlinkSync(
			target,
			join(
				dir,
				`${EXEC}.design.${TURN}.round.00000000-0000-4000-8000-000000000009.json`,
			),
		);
		expect(countReviewRoundSpool(dir)).toEqual({ pending: 1, quarantined: 0 });
	});

	it("rejects malformed spool files on parse", () => {
		expect(parseReviewRoundSpoolFile("{nope")).toMatchObject({ ok: false });
		expect(
			parseReviewRoundSpoolFile(JSON.stringify({ schemaVersion: 2, body: {} })),
		).toMatchObject({ ok: false });
		expect(
			parseReviewRoundSpoolFile(JSON.stringify({ schemaVersion: 1 })),
		).toMatchObject({ ok: false });
	});

	it("loses no record when 20 processes spool concurrently", async () => {
		const moduleUrl = new URL("../review-round-spool.ts", import.meta.url).href;
		const scriptPath = join(dir, "..", "spool-writer.mjs");
		writeFileSync(
			scriptPath,
			`import { writeReviewRoundSpoolRecord } from ${JSON.stringify(moduleUrl)};\n` +
				`writeReviewRoundSpoolRecord(${JSON.stringify(dir)}, {\n` +
				`  executionId: ${JSON.stringify(EXEC)}, reviewType: "code",\n` +
				`  codexThreadId: "01a0daf6-1f50-7522-b7dc-f0b3812a5dab",\n` +
				`  codexTurnId: ${JSON.stringify(TURN)}, round: Number(process.argv[2]),\n` +
				`  verdict: "CHANGES_REQUESTED", modelEvidence: "unavailable",\n` +
				`  reviewedAt: "2026-09-25T11:00:00.000Z",\n` +
				`});\n`,
		);
		await Promise.all(
			Array.from(
				{ length: 20 },
				(_, index) =>
					new Promise<void>((resolve, reject) => {
						let stderr = "";
						const child = spawn(
							process.execPath,
							["--import", "tsx", scriptPath, String(index + 1)],
							{ cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
						);
						child.stderr?.on("data", (chunk) => {
							stderr += String(chunk);
						});
						child.once("error", reject);
						child.once("exit", (code) =>
							code === 0
								? resolve()
								: reject(new Error(`exit ${code}: ${stderr}`)),
						);
					}),
			),
		);
		const rounds = readdirSync(dir)
			.filter((name) => name.endsWith(".json"))
			.map(
				(name) =>
					JSON.parse(readFileSync(join(dir, name), "utf8")).body
						.round as number,
			)
			.sort((a, b) => a - b);
		expect(rounds).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
	}, 60_000);
});
