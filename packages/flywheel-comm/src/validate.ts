/**
 * Validate project name to prevent path traversal.
 * Rejects names containing /, \, or ..
 * Used by CLI (via resolveDbPath), Bridge, and MCP server.
 */
export function validateProjectName(name: string): void {
	if (/[/\\]|\.\./.test(name)) {
		throw new Error(`Invalid project name: '${name}'`);
	}
}

/**
 * Build a safe RegExp from user input, guarding against ReDoS.
 *
 * Rejects patterns with nested quantifiers (e.g. `(a+)+`, `(.*)*`,
 * `([a-z]+)*`) which are the primary cause of catastrophic backtracking.
 * Also rejects patterns longer than maxLength.
 *
 * Returns a compiled RegExp on success; throws on invalid or unsafe patterns.
 */
export function buildSafeRegex(
	pattern: string,
	flags = "i",
	maxLength = 200,
): RegExp {
	if (pattern.length > maxLength) {
		throw new Error(`Pattern too long (max ${maxLength} chars)`);
	}

	// Reject nested quantifiers: a group/class followed by a quantifier,
	// nested inside another quantifier. Catches (a+)+, (.*)+, ([x]+)*, etc.
	if (/(\([^)]*[+*][^)]*\))[+*{]/.test(pattern)) {
		throw new Error(
			"Unsafe regex pattern: nested quantifiers can cause catastrophic backtracking. Use a simpler pattern.",
		);
	}

	try {
		return new RegExp(pattern, flags);
	} catch {
		throw new Error(`Invalid regex pattern: ${pattern}`);
	}
}
