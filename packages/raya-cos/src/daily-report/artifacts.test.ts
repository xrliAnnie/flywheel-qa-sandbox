import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BusinessRound } from "../business-round.js";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "report-artifacts-"));
	roots.push(root);
	const round = new BusinessRound(root, () =>
		Date.parse("2026-09-16T03:00:00Z"),
	);
	let v = round.prepare({
		schemaVersion: 2,
		kind: "daily_report",
		sourceRefs: ["wake"],
		wake: {
			scheduleId: "daily-report",
			revision: 1,
			configDigest: "a".repeat(64),
			localDate: "2026-09-15",
			dueAt: "2026-09-16T03:00:00Z",
			timezone: "America/Los_Angeles",
		},
	});
	const record = (result: object) => {
		v = round.record({
			schemaVersion: 2,
			operationId: v.operationId,
			expectedRevision: v.revision,
			tool: "current_turn",
			callId: String(v.revision),
			result,
		});
		return v;
	};
	record({
		action: "collect",
		mainCommit: "b".repeat(40),
		sources: [],
		silent: [],
	});
	const generated = record({
		action: "generate",
		body: `## 今天各项目发生了什么\n${"🦊".repeat(1801)}\n## 我的判断\n继续观察。`,
		sourceRefs: [],
	});
	const document = String(generated.material?.document),
		fileSha = createHash("sha1")
			.update(`blob ${Buffer.byteLength(document)}\0`)
			.update(document)
			.digest("hex");
	return { root, round, generated, record, document, fileSha };
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("durable report artifacts", () => {
	it("writes hashed body before publication and freezes readable Unicode chunks in context", () => {
		const f = fixture();
		expect(f.generated.material?.bodyFile).toEqual(expect.any(String));
		const body = readFileSync(
			join(
				f.root,
				"state/daily-report",
				String(f.generated.material?.bodyFile),
			),
			"utf8",
		);
		expect(body).toBe(f.generated.material?.body);
		const written = f.record({
			action: "probe",
			repo: "xrliAnnie/raya",
			ref: "main",
			path: "reports/2026-09-15.md",
			status: "exists",
			document: f.document,
			fileSha: f.fileSha,
		});
		expect(written.stage).toBe("context_ready");
		const context = JSON.parse(
			readFileSync(
				join(f.root, "state/daily-report/2026-09-15.context.json"),
				"utf8",
			),
		);
		expect(context).toMatchObject({
			fileSha: f.fileSha,
			bodySha256: written.material?.bodySha256,
		});
		for (const chunk of context.chunks) {
			expect(chunk.text.length).toBeLessThanOrEqual(1800);
			expect(chunk.text).not.toMatch(/[\uD800-\uDBFF]$/);
		}
		expect(f.round.resume(written.operationId)).toEqual(written);
	});
	it("does not overwrite a conflicting context and resumes after explicit artifact repair", () => {
		const f = fixture(),
			path = join(f.root, "state/daily-report/2026-09-15.context.json");
		mkdirSync(join(f.root, "state/daily-report"), { recursive: true });
		writeFileSync(path, "foreign");
		expect(() =>
			f.record({
				action: "probe",
				repo: "xrliAnnie/raya",
				ref: "main",
				path: "reports/2026-09-15.md",
				status: "exists",
				document: f.document,
				fileSha: f.fileSha,
			}),
		).toThrow();
		expect(readFileSync(path, "utf8")).toBe("foreign");
		rmSync(path);
		expect(f.round.resume(f.generated.operationId).stage).toBe("context_ready");
	});
	it("rejects a body symlink on resume instead of following the target", () => {
		const f = fixture(),
			path = join(
				f.root,
				"state/daily-report",
				String(f.generated.material?.bodyFile),
			);
		expect(f.generated.material?.bodyFile).toEqual(expect.any(String));
		const body = String(f.generated.material?.body);
		rmSync(path);
		writeFileSync(join(f.root, "foreign"), body);
		symlinkSync(join(f.root, "foreign"), path);
		expect(() => f.round.resume(f.generated.operationId)).toThrow();
	});
});
