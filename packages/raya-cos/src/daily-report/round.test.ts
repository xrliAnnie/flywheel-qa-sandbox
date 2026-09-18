import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BusinessRound } from "../business-round.js";
import {
	parseReportDocument,
	serializeReportDocument,
} from "../contracts/daily-report.js";

const roots: string[] = [];
const now = Date.parse("2026-09-16T03:00:00Z");
const wake = {
	scheduleId: "daily-report",
	revision: 1,
	configDigest: "a".repeat(64),
	localDate: "2026-09-15",
	dueAt: "2026-09-16T03:00:00Z",
	timezone: "America/Los_Angeles",
};
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "daily-round-"));
	roots.push(root);
	return { root, round: new BusinessRound(root, () => now) };
}
const prepare = (round: BusinessRound, w = wake) =>
	round.prepare({
		schemaVersion: 2,
		kind: "daily_report",
		wake: w,
		sourceRefs: ["business-wake:raya:raya:daily-report:2026-09-15"],
	});
function record(
	round: BusinessRound,
	v: { operationId: string; revision: number },
	result: object,
) {
	return round.record({
		schemaVersion: 2,
		operationId: v.operationId,
		expectedRevision: v.revision,
		tool: "current_turn",
		callId: `turn:${v.revision}`,
		result,
	});
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("durable current-turn daily report", () => {
	it("keeps one operation per frozen local date across schedule revisions and restart", () => {
		const { root, round } = fixture(),
			v = prepare(round);
		expect(v).toMatchObject({
			operationId: "daily-report:2026-09-15",
			stage: "prepared",
			next: { tool: "current_turn" },
		});
		expect(
			prepare(new BusinessRound(root, () => now), { ...wake, revision: 2 }),
		).toEqual(v);
		expect(() => prepare(round, { ...wake, localDate: "2026-02-31" })).toThrow(
			/date/,
		);
	});
	it("freezes an empty collection and sanitized generated document without external effects", () => {
		const { root, round } = fixture(),
			initial = prepare(round);
		const collected = record(round, initial, {
			action: "collect",
			mainCommit: "b".repeat(40),
			sources: [],
			silent: [],
		});
		const generated = record(round, collected, {
			action: "generate",
			body: "## 今天各项目发生了什么\n暂无新材料。\n## 我的判断\n证据不足。sk-abcdefghijklmnopqrstuv",
			sourceRefs: [],
		});
		expect(generated).toMatchObject({
			stage: "generated",
			next: {
				tool: "current_turn",
				arguments: {
					action: "probe_report",
					repo: "xrliAnnie/raya",
					ref: "main",
					path: "reports/2026-09-15.md",
				},
			},
		});
		expect(generated.material?.body).toContain("[redacted]");
		expect(generated.material?.body).not.toContain("sk-abcdefghijklmnopqrstuv");
		expect(
			new BusinessRound(root, () => now + 86400000).resume(
				generated.operationId,
			),
		).toEqual(generated);
		expect(() =>
			record(round, generated, {
				action: "generate",
				body: "changed",
				sourceRefs: [],
			}),
		).toThrow();
	});
	it("rejects claims citing absent manifest entries before storing a report", () => {
		const { round } = fixture(),
			initial = prepare(round);
		const collected = record(round, initial, {
			action: "collect",
			mainCommit: "b".repeat(40),
			sources: [],
			silent: [],
		});
		expect(() =>
			record(round, collected, {
				action: "generate",
				body: "## 今天各项目发生了什么\n见 [source:0]。\n## 我的判断\n待确认。",
				sourceRefs: [0],
			}),
		).toThrow(/source/);
		expect(round.resume(initial.operationId).stage).toBe("collecting_complete");
	});
});

it("accepts exact readable source citations and rejects omitted content", () => {
	const { round } = fixture(),
		initial = prepare(round);
	const source = {
		state: "open",
		pr: 123,
		head: "b".repeat(40),
		blob: "c".repeat(40),
		path: "summaries/flywheel/2026-09-15--eng--01.md",
		project: "flywheel",
		lead: "eng",
		contract: "ok",
		bytes: 21,
		truncated: false,
		omitted: false,
		divergent: false,
		also_in: [],
		content: "事实与判断。",
	};
	const collected = record(round, initial, {
		action: "collect",
		mainCommit: "d".repeat(40),
		sources: [source],
		silent: [],
	});
	const body =
		"## 今天各项目发生了什么\n待吸收的进度更新 [source:0]。\n## 我的判断\n需要先确认。";
	expect(
		record(round, collected, { action: "generate", body, sourceRefs: [0] }),
	).toMatchObject({ stage: "generated", material: { citedSources: [0] } });
	const f = fixture(),
		p = prepare(f.round);
	const omitted = record(f.round, p, {
		action: "collect",
		mainCommit: "d".repeat(40),
		sources: [{ ...source, content: "", omitted: true }],
		silent: [],
	});
	expect(() =>
		record(f.round, omitted, { action: "generate", body, sourceRefs: [0] }),
	).toThrow(/readable manifest/);
});

describe("report repository reconciliation", () => {
	function generated() {
		const f = fixture(),
			p = prepare(f.round);
		const c = record(f.round, p, {
			action: "collect",
			mainCommit: "b".repeat(40),
			sources: [],
			silent: [],
		});
		return {
			...f,
			v: record(f.round, c, {
				action: "generate",
				body: "## 今天各项目发生了什么\n暂无新材料。\n## 我的判断\n需要继续观察。",
				sourceRefs: [],
			}),
		};
	}
	const binding = {
		repo: "xrliAnnie/raya",
		ref: "main",
		path: "reports/2026-09-15.md",
	};
	it("creates only after absence and re-reads ambiguous creates", () => {
		const { root, round, v } = generated();
		const absent = record(round, v, {
			action: "probe",
			...binding,
			status: "absent",
		});
		expect(absent.next).toMatchObject({
			tool: "current_turn",
			arguments: {
				action: "create_report",
				...binding,
				createOnly: true,
				document: v.material?.document,
			},
		});
		expect(absent.next?.arguments).not.toHaveProperty("sha");
		const unknown = record(round, absent, {
			action: "create",
			...binding,
			status: "unknown",
		});
		expect(
			new BusinessRound(root, () => now).resume(v.operationId),
		).toMatchObject({
			stage: "reconciling_file",
			needsReconciliation: true,
			next: { arguments: { action: "probe_report" } },
		});
		expect(() =>
			record(round, unknown, {
				action: "create",
				...binding,
				status: "created",
				fileSha: "c".repeat(40),
			}),
		).toThrow();
	});
	it("adopts the actual existing document and validates its Git blob identity", () => {
		const { round, v } = generated();
		const original = String(v.material?.document);
		const adopted = original.replace("需要继续观察。", "采用已发布判断。");
		// Re-serialize to keep the report body's metadata honest.
		const parsed = parseReportDocument(original, { date: "2026-09-15" });
		const { body_sha256: _hash, body_bytes: _bytes, ...metadata } = parsed.meta;
		const document = serializeReportDocument(
			metadata,
			parsed.body.replace("需要继续观察。", "采用已发布判断。"),
		);
		const fileSha = blob(document);
		expect(() =>
			record(round, v, {
				action: "probe",
				...binding,
				status: "exists",
				document: adopted,
				fileSha,
			}),
		).toThrow();
		const written = record(round, v, {
			action: "probe",
			...binding,
			status: "exists",
			document,
			fileSha,
		});
		expect(written).toMatchObject({
			stage: "context_ready",
			material: {
				adopted: true,
				fileSha,
				document,
				body: expect.stringContaining("采用已发布判断。"),
			},
		});
		expect(written.material?.draftDocument).toBe(original);
	});
	it("rejects a foreign path and freezes exact created content", () => {
		const { round, v } = generated();
		expect(() =>
			record(round, v, {
				action: "probe",
				...binding,
				path: "scripts/run.sh",
				status: "absent",
			}),
		).toThrow(/binding/);
		const absent = record(round, v, {
			action: "probe",
			...binding,
			status: "absent",
		});
		expect(() =>
			record(round, absent, {
				action: "create",
				...binding,
				status: "created",
				fileSha: "a".repeat(40),
			}),
		).toThrow(/blob/);
		expect(
			record(round, absent, {
				action: "create",
				...binding,
				status: "created",
				fileSha: blob(String(v.material?.document)),
			}),
		).toMatchObject({ stage: "context_ready", material: { adopted: false } });
	});
});

function blob(document: string) {
	return createHash("sha1")
		.update(`blob ${Buffer.byteLength(document)}\0`)
		.update(document)
		.digest("hex");
}
