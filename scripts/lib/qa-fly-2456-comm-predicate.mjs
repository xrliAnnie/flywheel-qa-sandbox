const quote = (s) => `"${s.replaceAll('"', '""')}"`;

export function commMarkers(
	{ slot, executions = [], lead } = {},
	allowEmpty = false,
) {
	if (
		!/^[1-9][0-9]*$/.test(String(slot)) ||
		!Number.isSafeInteger(Number(slot)) ||
		!Array.isArray(executions) ||
		(!allowEmpty && !executions.length) ||
		executions.some((x) => typeof x !== "string" || !x) ||
		(lead !== undefined && (typeof lead !== "string" || !lead))
	)
		throw Error("arguments_invalid");
	return [
		...new Set([
			`test-slot-${slot}`,
			`flywheel-test-${slot}`,
			...executions,
			...(lead ? [lead] : []),
		]),
	];
}

// instr reads through embedded NULs; LIKE/replace truncate legal state keys.
// Bind literal markers so %, _ and backslash never become wildcards.
export function commMatch(columns, markers) {
	return {
		sql: columns
			.flatMap((column) => markers.map(() => `instr(${quote(column)}, ?) > 0`))
			.join(" OR "),
		params: columns.flatMap(() => markers),
	};
}

export function commInvalidStorage(columns) {
	return columns
		.map(
			(column) =>
				`(${quote(column)} IS NOT NULL AND typeof(${quote(column)}) != 'text')`,
		)
		.join(" OR ");
}
