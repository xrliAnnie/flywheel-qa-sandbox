// FLY-152 Layer 1 unit tests — verify the Shared Channel Reply Discipline
// sections live in the base rule files with the expected canonical phrases.
//
// These tests do NOT spawn any Lead session; they only read the rule files
// from disk and assert that specific contract-bearing phrases are present.
//
// Each assertion targets a unique rule string that a regression would have
// to remove or rephrase to break — generic keyword presence (e.g. "FLY-152")
// would not catch a regression that deletes the forbidden-examples list or
// past-tense boundary, so the asserts below pick phrases that are tightly
// coupled to the rule's substantive contract.
//
// Project-layer identity.md files (in each project's repo) live separately
// and are validated by Layer 3 Discord E2E, not by these tests.
// See doc/engineer/plan/inprogress/v1.27.0-FLY-152-lead-reply-discipline.md
// §6.1 for the Layer 1 spec.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RULES_DIR = join(__dirname, "..", "..", "lead-rules-base");
const COS_PATH = join(RULES_DIR, "cos-lead-rules.md");
const DEPT_PATH = join(RULES_DIR, "department-lead-rules.md");
const README_PATH = join(RULES_DIR, "README.md");

const cosRules = readFileSync(COS_PATH, "utf8");
const deptRules = readFileSync(DEPT_PATH, "utf8");
const readme = readFileSync(README_PATH, "utf8");

const FLY152_HEADING =
	"## Shared Channel Reply Discipline (FLY-152, strictly enforced)";

describe("FLY-152 base layer — cos-lead-rules.md", () => {
	it("contains the FLY-152 section heading", () => {
		expect(cosRules).toContain(FLY152_HEADING);
	});

	it("declares cos-lead as the default replier", () => {
		// Exact contract phrase — looser "**default replier**" alone would
		// pass under a regression that drops the "cos-lead is the" framing.
		expect(cosRules).toContain("cos-lead is the **default replier**");
	});

	it("includes the abstain trigger contract for dept Lead names / mentions", () => {
		expect(cosRules).toContain("does not reply");
	});

	it("specifies case-insensitive substring matching for text-name trigger", () => {
		expect(cosRules).toContain("case-insensitive substring match");
	});

	it("requires the project file to instantiate dept Lead names", () => {
		// The instantiation contract — projects must plug in concrete names.
		expect(cosRules).toContain(
			"Generic slots your project's `identity.md` MUST instantiate",
		);
	});
});

describe("FLY-152 base layer — department-lead-rules.md", () => {
	it("contains the FLY-152 section heading", () => {
		expect(deptRules).toContain(FLY152_HEADING);
	});

	it("has the strict MUST NOT REPLY directive", () => {
		expect(deptRules).toContain("MUST NOT REPLY");
	});

	it("forbids any reply including ack-style filler", () => {
		// Anchors the "not even 'OK'/'got it'/'收到'" contract.
		expect(deptRules).toContain('not "OK", not "got it", not "收到"');
	});

	it("specifies brief-acknowledgment-only boundary for past-tense / narrative", () => {
		expect(deptRules).toContain("brief, closed acknowledgment only");
	});

	it("explicitly forbids open-ended follow-up question for past-tense ack", () => {
		// Past-tense boundary (B1) — the named Lead replies briefly but
		// MUST NOT invite further conversation with a follow-up question.
		// The base text uses 还需要我做什么? as the canonical forbidden phrase.
		expect(deptRules).toContain("还需要我做什么?");
	});

	it("specifies multi-name dept-specific reply discipline", () => {
		// When several dept Leads are named, each replies dept-specific
		// input rather than duplicating a global analysis.
		expect(deptRules).toContain("dept-specific");
	});

	it("declares topic ownership is NOT a reply trigger (semantic-dept case)", () => {
		// Closes the FLY-152 Round 3 R2-1 finding: topic-only messages
		// (e.g. "product 那边怎样了") must NOT be a reply trigger.
		expect(deptRules).toContain("Topic ownership is NOT a reply trigger");
	});

	it("specifies case-insensitive substring matching for text-name trigger", () => {
		expect(deptRules).toContain("case-insensitive substring match");
	});
});

describe("FLY-152 base layer — README.md file-purpose table", () => {
	it("references FLY-152 in the department-lead-rules.md row", () => {
		// Regex requires FLY-152 reference to appear on the same line as the
		// department-lead-rules.md filename in the table.
		const deptRow = readme
			.split("\n")
			.find(
				(line) =>
					line.includes("department-lead-rules.md") && line.includes("|"),
			);
		expect(deptRow).toBeDefined();
		expect(deptRow).toContain("FLY-152");
	});

	it("references FLY-152 in the cos-lead-rules.md row", () => {
		const cosRow = readme
			.split("\n")
			.find((line) => line.includes("cos-lead-rules.md") && line.includes("|"));
		expect(cosRow).toBeDefined();
		expect(cosRow).toContain("FLY-152");
	});
});
