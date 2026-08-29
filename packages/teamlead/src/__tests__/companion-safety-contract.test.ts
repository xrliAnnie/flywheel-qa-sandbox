import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * FLY-285: companion-safety-contract.md content regression.
 *
 * Path (a) of the Mufasa COE evolution keeps companions hard-sandboxed but lets a
 * companion that ALSO acts as a COE Director coordinate its content team by
 * *conversation only*. The contract gains a narrow positive allowance for that —
 * WITHOUT weakening any hard prohibition (Codex design review R1 #4).
 *
 * This test is a safety regression guard. It deliberately asserts the *actual
 * normative clauses* (not loose substrings) so it FAILS if a future edit deletes
 * or weakens a hard boundary — even if the stray keyword survives elsewhere
 * (Codex code review R1 #1/#2/#3: substring checks were too weak because
 * "Runner"/"personally"/"payload" also appear in the new allowance text).
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = join(
	__dirname,
	"..",
	"..",
	"lead-rules-base",
	"companion-safety-contract.md",
);
const contract = readFileSync(CONTRACT_PATH, "utf-8");
// Collapse whitespace (incl. markdown line-wrapping) so a clause that wraps
// across lines still matches as one normative sentence.
const flat = contract.replace(/\s+/g, " ");

describe("companion-safety-contract.md (FLY-285)", () => {
	describe("hard prohibitions remain intact (must NOT be weakened)", () => {
		it("keeps the hard Runner-lifecycle prohibition (not just the delegation carve-out)", () => {
			// The prohibition BULLET itself — its removal must break the test even
			// though "Runners"/"personally" also occur in the allowance section.
			expect(flat).toContain("No hands-on Runner lifecycle");
			expect(flat).toContain(
				"you do not *personally* start, stop, retry, close, or manage Runners",
			);
		});

		it("keeps the hard Bridge-action prohibition incl. both endpoint aliases + the script clause", () => {
			expect(flat).toContain("you do not call the Bridge action API");
			expect(contract).toContain("http://localhost:9876/api/actions/*");
			expect(contract).toContain("http://localhost:9876/actions/*");
			expect(flat).toContain("never run a script that does");
		});

		it("keeps the no-code/repo-engineering prohibition", () => {
			expect(flat).toContain("No code / repo engineering actions");
		});

		it("keeps the explicit-confirmation gate on irreversible founder-behalf actions", () => {
			expect(flat).toContain("No irreversible actions on the founder's behalf");
			expect(flat).toContain(
				"clearly, explicitly confirmed that specific action right now",
			);
		});

		it("keeps the prompt-injection warning", () => {
			expect(flat).toContain("prompt injection");
		});
	});

	describe("new COE-Director coordination allowance (path a) — narrow + safe", () => {
		it("is conditional on the COE Director identity (inert for a teamless companion)", () => {
			expect(flat).toContain("COE Director");
			expect(flat).toMatch(
				/only if your identity says you are a COE Director/i,
			);
			expect(flat).toContain("Most companions have **no team**");
		});

		it("permits natural-language delegation ONLY", () => {
			expect(flat).toContain("natural-language delegation only");
		});

		it("forbids relaying EVERY executable-mechanism class named in the contract", () => {
			// Codex R1 #2: assert each mechanism class, not just one — deleting any
			// of these is the safety-critical "describe the goal, never the how" hole.
			expect(flat).toContain("Bridge command");
			expect(flat).toContain("script");
			expect(flat).toContain("API payload");
			expect(flat).toContain("`curl` line");
			expect(flat).toContain("copy-paste operational instruction");
			// the equivalence that makes relaying == performing the reserved action.
			expect(flat).toContain(
				"is the same as performing the reserved action yourself",
			);
		});

		it("reaffirms the never-personally boundary inside the allowance (no loophole)", () => {
			expect(flat).toContain(
				"You still never *personally* start/stop/manage Runners, call Bridge actions, or touch code",
			);
		});
	});
});
