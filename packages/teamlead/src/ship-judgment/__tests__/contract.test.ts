import { describe, expect, it } from "vitest";
import {
	aggregateJudgment,
	canonicalDigest,
	citationSchema,
	clarificationId,
	isJudgmentEnabled,
	targetSetDigest,
	validateCitation,
} from "../contract.js";

describe("ship judgment contract", () => {
	it("keeps missing evidence unknown before applying rejection precedence", () => {
		expect(aggregateJudgment("fail", "pass", "undetermined")).toBe(
			"undetermined",
		);
		expect(aggregateJudgment("pass", "pass", "pass")).toBe("can");
		expect(aggregateJudgment("pass", "fail", "pass")).toBe("cannot");
		expect(aggregateJudgment("fail", "fail", "pass")).toBe("recommend_reject");
		expect(aggregateJudgment("pass", "pass", "fail")).toBe("recommend_reject");
	});
	it("enables the same Flywheel judgment in dry_run and auto only", () => {
		for (const project of ["flywheel", "raya", "Flywheel"]) {
			for (const mode of ["off", "dry_run", "auto", "unknown"]) {
				expect(isJudgmentEnabled(project, mode)).toBe(
					project === "flywheel" && ["dry_run", "auto"].includes(mode),
				);
			}
		}
	});
	it("hashes the complete sorted target set and rejects short or duplicate targets", () => {
		const a = {
			repo_identity: "owner/a",
			pr_number: 1,
			head_sha: "a".repeat(40),
			diff_base_sha: "b".repeat(40),
		};
		const b = { ...a, repo_identity: "owner/b" };
		expect(targetSetDigest([a, b], 1)).toBe(targetSetDigest([b, a], 1));
		expect(targetSetDigest([a, b], 1)).not.toBe(targetSetDigest([a], 1));
		expect(targetSetDigest([a], 2)).not.toBe(targetSetDigest([a], 1));
		expect(() => targetSetDigest([{ ...a, head_sha: "abcdef" }], 1)).toThrow();
		expect(() => targetSetDigest([a, a], 1)).toThrow();
		expect(() => targetSetDigest([], 1)).toThrow();
	});
	it("validates Unicode code point citations against frozen sources and files", () => {
		const sources = [{ source_id: "plan", text: "😀需求已实现" }];
		const citation = {
			source_id: "plan",
			quote_start: 1,
			quote_end: 3,
			quote: "需求",
			file_path: "src/a.ts",
		};
		expect(validateCitation(citation, sources, ["src/a.ts"])).toBe(true);
		expect(
			validateCitation({ ...citation, quote: "全都通过" }, sources, [
				"src/a.ts",
			]),
		).toBe(false);
		expect(validateCitation(citation, sources, ["src/b.ts"])).toBe(false);
		expect(
			validateCitation({ ...citation, source_id: "invented" }, sources, [
				"src/a.ts",
			]),
		).toBe(false);
		expect(
			citationSchema.safeParse({ ...citation, url: "https://example.com" })
				.success,
		).toBe(false);
	});
	it("canonicalizes object keys and separates question and reply identities", () => {
		expect(canonicalDigest({ b: 1, a: 2 })).toBe(
			canonicalDigest({ a: 2, b: 1 }),
		);
		expect(() => canonicalDigest({ a: undefined })).toThrow();
		expect(clarificationId("o", "d")).not.toBe(
			clarificationId("o", "d", {
				source_id: "s",
				revision_digest: "a".repeat(64),
			}),
		);
		expect(clarificationId("o", "d")).toBe(clarificationId("o", "d"));
	});
});
