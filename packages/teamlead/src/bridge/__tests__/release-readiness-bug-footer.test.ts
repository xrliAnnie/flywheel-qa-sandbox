import { expect, it } from "vitest";
import { appendBugVersionFooter } from "../release-readiness/bug-footer.js";

it("adds a visible version and replaces its own footer idempotently", () => {
	const subject = { baseVersion: "1.56.0", sourceCommit: "a".repeat(40) };
	const once = appendBugVersionFooter("User details", subject);
	expect(once).toContain(`Flywheel version: 1.56.0 @ ${subject.sourceCommit}`);
	expect(appendBugVersionFooter(once, subject)).toBe(once);
	const unknown = appendBugVersionFooter(once, null);
	expect(unknown).toContain("Flywheel version: unknown");
	expect(unknown.match(/<!-- flywheel-release:/g)).toHaveLength(1);
});
