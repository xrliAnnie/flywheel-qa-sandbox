// Publication projection only. Raw evidence and verdict semantics stay private and unchanged.
const id = (v) => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(v);
const number = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const timestamp = (v) =>
	typeof v === "string" &&
	/^(?:\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?|\w{3} \w{3} \d{1,2} \d\d:\d\d:\d\d \d{4})$/.test(
		v,
	) &&
	Number.isFinite(Date.parse(v));
const oneOf =
	(...values) =>
	(v) =>
		values.includes(v);
const status = oneOf("pass", "fail", "needs-attribution", "unavailable");
function pick(row, fields) {
	return Object.fromEntries(
		Object.entries(fields)
			.filter(([key, accepts]) => accepts(row?.[key]))
			.map(([key]) => [key, row[key]]),
	);
}
export function publicEvent(row) {
	const result = pick(row, {
		id: number,
		seq: number,
		event_id: id,
		event_uid: id,
		ts: timestamp,
		at: timestamp,
		kind: id,
		event_type: id,
		execution_id: id,
		run_id: id,
		node_id: id,
	});
	let payload = row?.parsedPayload;
	if (!payload && typeof row?.payload === "string") {
		try {
			payload = JSON.parse(row.payload);
		} catch {
			/* Raw, malformed payload stays private. */
		}
	}
	if (Number.isSafeInteger(payload?.attempt) && payload.attempt > 0)
		result.attempt = payload.attempt;
	if (
		typeof payload?.reason === "string" &&
		payload.reason.startsWith("workflow capability drift for ")
	)
		result.failureKind = "workflow capability drift";
	return result;
}
export function publicReplacement(row) {
	return pick(row, {
		executionId: id,
		runId: id,
		nodeId: id,
		requestId: id,
		launchOrdinal: number,
		rollbackSeq: number,
		materializedSeq: number,
		launchedSeq: number,
	});
}
export function publicAttribution(row) {
	const value = pick(row, {
		executionId: id,
		change: oneOf("added", "removed"),
		kind: oneOf("socket", "window"),
		pid: number,
		ppid: number,
		lstart: timestamp,
		attribution: oneOf("SLOT", "NONSLOT"),
	});
	if (row?.terminalEvidence)
		value.terminalEvidence = pick(row.terminalEvidence, {
			source: oneOf("sessions.terminal_at", "session_events"),
			at: timestamp,
			ts: timestamp,
			event_type: id,
		});
	if (row?.event) value.event = publicEvent(row.event);
	return value;
}
export function publicExplanation(group) {
	return {
		...pick(group, { group: id, phase: id }),
		attributions: (group?.attributions ?? []).map(publicAttribution),
	};
}
export function publicProof(proof) {
	const result = pick(proof, {
		status,
		ok: (v) => typeof v === "boolean",
		hitCount: number,
		baselineHitCount: number,
		newHitCount: number,
		scannedTables: number,
		scannedColumns: number,
		before: number,
		after: number,
		uptime: number,
		buildSha: (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v),
	});
	for (const key of [
		"added",
		"removed",
		"unknown",
		"unexplained",
		"pollution",
		"explanations",
		"refusals",
		"attributions",
		"hits",
		"declared",
	]) {
		if (Array.isArray(proof?.[key])) result[key + "Count"] = proof[key].length;
	}
	for (const key of [
		"added",
		"removed",
		"unexplained",
		"attributions",
		"explanations",
	]) {
		if (Array.isArray(proof?.[key]))
			result[key] = proof[key]
				.map(publicAttribution)
				.filter((row) => Object.keys(row).length);
	}
	return result;
}
export function publicPrecondition(pre) {
	return {
		...pick(pre, {
			startedAt: timestamp,
			endedAt: timestamp,
			waitedMs: number,
			maintenanceTicks: number,
		}),
		tickEvidence: pick(pre?.tickEvidence, {
			status: oneOf("unavailable"),
			reason: oneOf("no_unconditional_tick_observable"),
			rulingQuestionId: id,
		}),
	};
}

export const publicIdentity = (value) =>
	id(value) ? value : "invalid-identity";
export function publicBody(body) {
	return {
		executionId: publicIdentity(body?.executionId),
		runId: publicIdentity(body?.runId),
		classification: oneOf(
			"succeeded",
			"drift_exhausted",
			"failed_exhausted_no_replacement",
			"replaced",
			"watch_only",
			"skipped_not_holder",
			"excluded_or_ineligible",
			"other",
		)(body?.classification)
			? body.classification
			: "other",
		...(body?.replacement
			? { replacement: publicReplacement(body.replacement) }
			: {}),
	};
}
