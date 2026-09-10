// Read-only QA projection of tmux's globally identified, possibly linked windows.
export function foldTmuxWindows(rows, { executionMarker = false } = {}) {
	const offset = executionMarker ? 1 : 0;
	const windows = new Map();
	for (const row of rows) {
		if (
			row.length !== offset + 3 ||
			row.some(
				(field) => typeof field !== "string" || /[\r\n\0]/.test(field),
			) ||
			!row[offset] ||
			!/^@\d+$/.test(row[offset + 1]) ||
			!row[offset + 2]
		)
			throw new Error("tmux inventory invalid");
		const prior = windows.get(row[offset + 1]);
		if (
			prior &&
			(prior[offset + 2] !== row[offset + 2] ||
				(executionMarker && prior[0] !== row[0]))
		)
			throw new Error("tmux window identity conflict");
		const compare = prior
			? Number(row[offset].startsWith("cmux-")) -
					Number(prior[offset].startsWith("cmux-")) ||
				row[offset].localeCompare(prior[offset])
			: -1;
		if (compare < 0) windows.set(row[offset + 1], row);
	}
	return [...windows.values()];
}
