import type { ReadinessSubject } from "./subject.js";

export function appendBugVersionFooter(
	description: string,
	subject: ReadinessSubject | null,
): string {
	const body = description.replace(
		/\n\n<!-- flywheel-release: version -->\nFlywheel version: [^\n]*/g,
		"",
	);
	return `${body}\n\n<!-- flywheel-release: version -->\nFlywheel version: ${subject ? `${subject.baseVersion} @ ${subject.sourceCommit}` : "unknown"}`;
}
