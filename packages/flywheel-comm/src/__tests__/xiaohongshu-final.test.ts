/**
 * FLY-222: prune-gate FINAL validator tests (the all-paths fail-close gate).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { xhsValidateFinal } from "../commands/xhs-validate-final.js";
import { validateFinalResponse } from "../xiaohongshu-final.js";

const RK = "exec-abc-123";

function final(extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ final: true, runKey: RK, keep: ["c1"], ...extra });
}

describe("validateFinalResponse — happy path", () => {
	it("accepts a minimal well-formed FINAL bound to the run key", () => {
		const r = validateFinalResponse(final(), RK);
		expect(r.valid).toBe(true);
		if (r.valid) {
			expect(r.final.keep).toEqual(["c1"]);
			expect(r.final.runKey).toBe(RK);
		}
	});

	it("accepts optional edits + learnings", () => {
		const r = validateFinalResponse(
			final({ edits: { c1: { title: "x" } }, learnings: ["l1", "l2"] }),
			RK,
		);
		expect(r.valid).toBe(true);
		if (r.valid) {
			expect(r.final.learnings).toEqual(["l1", "l2"]);
			expect(r.final.edits).toEqual({ c1: { title: "x" } });
		}
	});

	it("accepts empty keep (Annie kept nothing — still a valid decision)", () => {
		const r = validateFinalResponse(
			JSON.stringify({ final: true, runKey: RK, keep: [] }),
			RK,
		);
		expect(r.valid).toBe(true);
	});
});

describe("validateFinalResponse — fail-close rejections", () => {
	const cases: Array<[string, string, RegExp]> = [
		["empty string", "", /empty response/],
		["whitespace", "   ", /empty response/],
		["non-JSON casual reply", "looks good, ship it!", /not valid JSON/],
		["JSON array", "[1,2,3]", /not a JSON object/],
		["JSON scalar", "42", /not a JSON object/],
		[
			"missing final flag",
			JSON.stringify({ runKey: RK, keep: [] }),
			/non-true `final`/,
		],
		[
			"final not literal true (1)",
			JSON.stringify({ final: 1, runKey: RK, keep: [] }),
			/non-true `final`/,
		],
		[
			'final string "true"',
			JSON.stringify({ final: "true", runKey: RK, keep: [] }),
			/non-true `final`/,
		],
		[
			"missing runKey",
			JSON.stringify({ final: true, keep: [] }),
			/missing `runKey`/,
		],
		[
			"keep not array",
			JSON.stringify({ final: true, runKey: RK, keep: "c1" }),
			/`keep` must be an array/,
		],
		[
			"keep array of non-strings",
			JSON.stringify({ final: true, runKey: RK, keep: [1, 2] }),
			/`keep` must be an array of strings/,
		],
		[
			"edits is array",
			JSON.stringify({ final: true, runKey: RK, keep: [], edits: [] }),
			/`edits` must be an object/,
		],
		[
			"learnings non-string array",
			JSON.stringify({ final: true, runKey: RK, keep: [], learnings: [1] }),
			/`learnings` must be an array of strings/,
		],
	];

	it.each(cases)("rejects %s", (_name, raw, re) => {
		const r = validateFinalResponse(raw, RK);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(re);
	});

	it("rejects a FINAL bound to a DIFFERENT run key (stale/replayed)", () => {
		const r = validateFinalResponse(
			JSON.stringify({ final: true, runKey: "some-other-run", keep: ["c1"] }),
			RK,
		);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/run key mismatch/);
	});

	it("rejects when expected run key is empty (caller misuse)", () => {
		const r = validateFinalResponse(final(), "");
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/expected run key is empty/);
	});
});

describe("xhs-validate-final CLI", () => {
	let dir: string;
	let out: string[];
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "xhs-final-"));
		out = [];
		vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => {
			out.push(String(c));
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});

	function fileWith(content: string): string {
		const p = join(dir, "resp.json");
		writeFileSync(p, content);
		return p;
	}

	it("exit 0 + prints envelope on a valid FINAL", () => {
		const code = xhsValidateFinal([
			"--run-key",
			RK,
			"--response-file",
			fileWith(final()),
		]);
		expect(code).toBe(0);
		expect(JSON.parse(out.join("")).keep).toEqual(["c1"]);
	});

	it("exit 1 + {valid:false} on an invalid FINAL (fail-close signal)", () => {
		const code = xhsValidateFinal([
			"--run-key",
			RK,
			"--response-file",
			fileWith("just chatting"),
		]);
		expect(code).toBe(1);
		expect(JSON.parse(out.join("")).valid).toBe(false);
	});

	it("exit 1 on run-key mismatch", () => {
		const code = xhsValidateFinal([
			"--run-key",
			"different",
			"--response-file",
			fileWith(final()),
		]);
		expect(code).toBe(1);
	});

	it("exit 2 when --run-key missing", () => {
		expect(xhsValidateFinal(["--response-file", fileWith(final())])).toBe(2);
	});
});

describe("validateFinalResponse — strict id + edits validation (codex HIGH-3)", () => {
	it("rejects an empty id in keep", () => {
		const r = validateFinalResponse(final({ keep: ["c1", ""] }), RK);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/empty id/);
	});

	it("rejects a duplicate id in keep", () => {
		const r = validateFinalResponse(final({ keep: ["c1", "c1"] }), RK);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/duplicate/);
	});

	it("rejects an edits key that is not in keep", () => {
		const r = validateFinalResponse(
			final({ keep: ["c1"], edits: { c2: { title: "x" } } }),
			RK,
		);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/not in `keep`/);
	});

	it("rejects a null edits value", () => {
		const r = validateFinalResponse(
			final({ keep: ["c1"], edits: { c1: null } }),
			RK,
		);
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/edits\.c1.*object/);
	});

	it("rejects a non-string / empty edits title", () => {
		expect(
			validateFinalResponse(final({ edits: { c1: { title: 5 } } }), RK).valid,
		).toBe(false);
		expect(
			validateFinalResponse(final({ edits: { c1: { body: "  " } } }), RK).valid,
		).toBe(false);
	});

	it("rejects duplicate / empty learnings", () => {
		expect(
			validateFinalResponse(final({ learnings: ["l1", "l1"] }), RK).valid,
		).toBe(false);
		expect(validateFinalResponse(final({ learnings: [""] }), RK).valid).toBe(
			false,
		);
	});

	it("enforces the candidate manifest subset when provided", () => {
		// keep id not among the presented candidates → reject.
		const r = validateFinalResponse(final({ keep: ["c1"] }), RK, {
			candidateIds: ["c2", "c3"],
		});
		expect(r.valid).toBe(false);
		if (!r.valid) expect(r.reason).toMatch(/not a presented candidate/);
		// keep ⊆ candidates → accept.
		expect(
			validateFinalResponse(final({ keep: ["c1"] }), RK, {
				candidateIds: ["c1", "c2"],
			}).valid,
		).toBe(true);
	});

	it("enforces the learning manifest subset when provided", () => {
		expect(
			validateFinalResponse(final({ learnings: ["l9"] }), RK, {
				learningIds: ["l1"],
			}).valid,
		).toBe(false);
	});
});
