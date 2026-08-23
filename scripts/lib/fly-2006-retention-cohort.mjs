import { createHash } from "node:crypto";

const EXACT_KEY_CEILING = 20_000;
const RANGE_SHARD_CEILING = 50_000;
const PARTITIONS = Object.freeze([
	"candidate",
	"recent",
	"invalidTime",
	"activeProtected",
	"oldProtected",
]);

function sortedUnique(values) {
	return [
		...new Set(values.filter((value) => value !== null && value !== undefined)),
	]
		.map(String)
		.sort();
}

function sha256Lines(values) {
	const hash = createHash("sha256");
	for (const value of values) hash.update(`${JSON.stringify(value)}\n`);
	return hash.digest("hex");
}

export function buildActiveSnapshot({
	liveSessions,
	runs,
	nodes,
	commSessions,
}) {
	const activeRuns = runs.filter((run) =>
		new Set(["active", "held"]).has(run.status),
	);
	const runIds = sortedUnique(activeRuns.map((run) => run.runId));
	const activeRunSet = new Set(runIds);
	const runningComm = commSessions.filter(
		(session) => session.status === "running",
	);
	const executionIds = sortedUnique([
		...liveSessions.map((session) => session.executionId),
		...nodes
			.filter((node) => activeRunSet.has(node.runId))
			.map((node) => node.executionId),
		...runningComm.map((session) => session.executionId),
	]);
	const issueIds = sortedUnique([
		...liveSessions.map((session) => session.issueId),
		...activeRuns.map((run) => run.issueId),
		...runningComm.map((session) => session.issueId),
	]);
	const snapshot = { runIds, executionIds, issueIds };
	return { ...snapshot, digest: sha256Lines([snapshot]) };
}

export function jsonContainsExactScalar(payload, values) {
	let parsed;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return false;
	}
	const visit = (value) => {
		if (value === null) return false;
		if (typeof value !== "object") return values.has(value);
		return Array.isArray(value)
			? value.some(visit)
			: Object.values(value).some(visit);
	};
	return visit(parsed);
}

function sortedRows(rows, primaryKey) {
	const keyType = rows.length === 0 ? "number" : typeof rows[0][primaryKey];
	if (!new Set(["number", "string"]).has(keyType))
		throw new Error("cohort_primary_key_type_unsupported");
	const sorted = [...rows].sort((left, right) =>
		left[primaryKey] < right[primaryKey]
			? -1
			: left[primaryKey] > right[primaryKey]
				? 1
				: 0,
	);
	let previous = null;
	for (const row of sorted) {
		const value = row[primaryKey];
		if (
			typeof value !== keyType ||
			(keyType === "number" && !Number.isSafeInteger(value))
		)
			throw new Error("cohort_primary_key_type_mismatch");
		if (previous !== null && value <= previous)
			throw new Error("range_primary_key_not_strictly_monotonic");
		previous = value;
	}
	return sorted;
}

function projected(row, casFields) {
	return Object.fromEntries(casFields.map((field) => [field, row[field]]));
}

function digestRows(rows, casFields) {
	return sha256Lines(rows.map((row) => projected(row, casFields)));
}

export function freezeCohort(
	rows,
	{
		primaryKey,
		casFields,
		exactKeyCeiling = EXACT_KEY_CEILING,
		rangeShardCeiling = RANGE_SHARD_CEILING,
	},
) {
	if (!casFields.includes(primaryKey))
		throw new Error("cohort_cas_primary_key_required");
	const ordered = sortedRows(rows, primaryKey);
	const base = {
		rowCount: ordered.length,
		casFields: [...casFields],
		digest: digestRows(ordered, casFields),
	};
	if (ordered.length <= exactKeyCeiling) {
		return {
			...base,
			mode: "exact-keys",
			primaryKeys: ordered.map((row) => row[primaryKey]),
		};
	}
	if (typeof ordered[0]?.[primaryKey] !== "number")
		throw new Error("range_primary_key_not_safe_integer");
	const shards = [];
	for (let index = 0; index < ordered.length; index += rangeShardCeiling) {
		const rowsInShard = ordered.slice(index, index + rangeShardCeiling);
		shards.push({
			minPrimaryKey: rowsInShard[0][primaryKey],
			maxPrimaryKey: rowsInShard.at(-1)[primaryKey],
			rowCount: rowsInShard.length,
			digest: digestRows(rowsInShard, casFields),
		});
	}
	return { ...base, mode: "range-digest", shards };
}

export function assertFrozenCohort(rows, frozen, options) {
	const current = freezeCohort(rows, {
		...options,
		exactKeyCeiling:
			frozen.mode === "exact-keys" ? Math.max(frozen.rowCount, 20_000) : 20_000,
	});
	if (current.mode !== frozen.mode || current.rowCount !== frozen.rowCount)
		throw new Error("cohort_cas_count_mismatch");
	if (current.digest !== frozen.digest)
		throw new Error("cohort_cas_digest_mismatch");
	if (
		frozen.mode === "exact-keys" &&
		JSON.stringify(current.primaryKeys) !== JSON.stringify(frozen.primaryKeys)
	)
		throw new Error("cohort_cas_primary_keys_mismatch");
	if (
		frozen.mode === "range-digest" &&
		JSON.stringify(current.shards) !== JSON.stringify(frozen.shards)
	)
		throw new Error("cohort_cas_shards_mismatch");
	return true;
}

export function partitionRows(rows, classify) {
	const counts = Object.fromEntries(PARTITIONS.map((name) => [name, 0]));
	const digests = new Map(PARTITIONS.map((name) => [name, []]));
	for (const row of rows) {
		const classification = classify(row);
		if (!PARTITIONS.includes(classification))
			throw new Error(`unknown_retention_partition:${classification}`);
		counts[classification] += 1;
		digests.get(classification).push(row);
	}
	const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
	if (total !== rows.length)
		throw new Error("retention_partition_sum_mismatch");
	return {
		counts,
		digests: Object.fromEntries(
			[...digests].map(([name, values]) => [name, sha256Lines(values)]),
		),
	};
}
