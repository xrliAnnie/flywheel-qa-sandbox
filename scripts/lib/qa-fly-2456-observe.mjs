import { openEvidence } from "./qa-fly-2456-evidence.mjs";

const text = (value) =>
	typeof value === "string" && value.length > 0 && !value.includes("\0");
const bound = (value) => Number.isSafeInteger(value) && value >= 0;
const schemas = {
	sessions: ["execution_id", "status", "last_error"],
	session_events: [
		"id",
		"event_id",
		"ts",
		"execution_id",
		"source",
		"event_type",
		"payload",
	],
	workflow_run: ["run_id"],
	workflow_run_event: [
		"seq",
		"run_id",
		"event_uid",
		"at",
		"kind",
		"node_id",
		"execution_id",
		"payload",
	],
	recovery_claim: ["execution_id", "episode_id", "episode_attempts"],
};
function requireSchema(db, names) {
	for (const table of names) {
		if (
			!db
				.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
				.get(table)
		)
			throw new Error("table missing");
		const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
		if (!schemas[table].every((name) => columns.some((c) => c.name === name)))
			throw new Error("column missing");
		for (const name of schemas[table].filter(
			(name) => !["id", "seq", "episode_attempts"].includes(name),
		)) {
			if (
				db
					.prepare(
						`SELECT 1 FROM "${table}" WHERE "${name}" IS NOT NULL AND (typeof("${name}")!='text' OR instr("${name}",char(0))>0) LIMIT 1`,
					)
					.get()
			)
				throw new Error("text storage invalid");
		}
	}
}
function withSnapshot(path, fn) {
	let db;
	try {
		const opened = openEvidence(path, "observation");
		db = opened.db;
		return { ...fn(db), metadata: opened.metadata };
	} catch {
		return { status: "fail", reason: "snapshot_schema_or_evidence_invalid" };
	} finally {
		db?.close();
	}
}
function requireRuns(db, ids) {
	if (
		!Array.isArray(ids) ||
		!ids.length ||
		!ids.every(text) ||
		new Set(ids).size !== ids.length
	)
		throw new Error("runs invalid");
	for (const id of ids)
		if (!db.prepare("SELECT 1 FROM workflow_run WHERE run_id=?").get(id))
			throw new Error("run missing");
}
export function eventBounds(dbPath, runIds) {
	return withSnapshot(dbPath, (db) => {
		requireSchema(db, ["session_events", "workflow_run", "workflow_run_event"]);
		requireRuns(db, runIds);
		const sessionEventsMaxId = db
			.prepare("SELECT COALESCE(MAX(id),0) AS id FROM session_events")
			.get().id;
		const runEventMaxSeq = Object.fromEntries(
			runIds.map((id) => [
				id,
				db
					.prepare(
						"SELECT COALESCE(MAX(seq),0) AS seq FROM workflow_run_event WHERE run_id=?",
					)
					.get(id).seq,
			]),
		);
		if (
			!bound(sessionEventsMaxId) ||
			!Object.values(runEventMaxSeq).every(bound)
		)
			throw new Error("event bounds invalid");
		return { status: "pass", sessionEventsMaxId, runEventMaxSeq };
	});
}
function decode(row) {
	if (
		(Object.hasOwn(row, "id") && (!bound(row.id) || row.id === 0)) ||
		(Object.hasOwn(row, "seq") && (!bound(row.seq) || row.seq === 0))
	)
		throw new Error("event sequence invalid");
	const parsedPayload = row.payload === null ? {} : JSON.parse(row.payload);
	if (
		!parsedPayload ||
		typeof parsedPayload !== "object" ||
		Array.isArray(parsedPayload)
	)
		throw new Error("payload invalid");
	if (
		Object.hasOwn(parsedPayload, "episodeId") &&
		!text(parsedPayload.episodeId)
	)
		throw new Error("episode identity invalid");
	return { ...row, parsedPayload };
}
function replacementProof(db, events, body) {
	const candidates = [];
	for (const materialized of events.filter(
		(e) =>
			e.kind === "rework_replacement_materialized" &&
			e.execution_id === body.executionId &&
			e.node_id === body.nodeId,
	)) {
		const m = materialized.parsedPayload;
		if (
			!text(m.newExecutionId) ||
			m.newExecutionId === body.executionId ||
			m.deadExecutionId !== body.executionId ||
			!text(m.requestId) ||
			!Number.isSafeInteger(m.launchOrdinal) ||
			m.launchOrdinal <= 0
		)
			continue;
		// Rollback is optional: a terminal actor can be replaced via the delivery
		// coordinator. When present, its identity must still match materialization.
		const rollbacks = events.filter(
			(e) =>
				e.kind === "execution_dead_rolled_back" &&
				e.execution_id === body.executionId &&
				e.node_id === body.nodeId,
		);
		const rollback = rollbacks.find(
			(e) =>
				e.seq < materialized.seq &&
				e.parsedPayload.newExecutionId === m.newExecutionId &&
				e.parsedPayload.launchOrdinal === m.launchOrdinal,
		);
		if (rollbacks.length && !rollback) continue;
		const launched = events.find(
			(e) =>
				e.seq > materialized.seq &&
				["rework_replacement_launched", "rework_replacement"].includes(
					e.kind,
				) &&
				e.execution_id === m.newExecutionId &&
				e.node_id === body.nodeId &&
				e.parsedPayload.requestId === m.requestId &&
				(e.kind !== "rework_replacement" ||
					(e.parsedPayload.newExecutionId === m.newExecutionId &&
						e.parsedPayload.targetNodeId === body.nodeId)),
		);
		if (
			!launched ||
			!db
				.prepare("SELECT 1 FROM sessions WHERE execution_id=?")
				.get(m.newExecutionId)
		)
			continue;
		candidates.push({
			executionId: m.newExecutionId,
			runId: body.runId,
			nodeId: body.nodeId,
			requestId: m.requestId,
			launchOrdinal: m.launchOrdinal,
			...(rollback ? { rollbackSeq: rollback.seq } : {}),
			materializedSeq: materialized.seq,
			launchedSeq: launched.seq,
		});
	}
	return candidates.length === 1 ? candidates[0] : undefined;
}

function classify(db, body, sessionEvents, workflowEvents) {
	const session = db
		.prepare(
			"SELECT execution_id,status,last_error FROM sessions WHERE execution_id=?",
		)
		.get(body.executionId);
	if (!session) throw new Error("original session missing");
	const claim =
		db
			.prepare(
				"SELECT execution_id,episode_id,episode_attempts FROM recovery_claim WHERE execution_id=?",
			)
			.get(body.executionId) ?? null;
	const anchor = sessionEvents.find((e) => text(e.parsedPayload.episodeId));
	const episodeId = anchor?.parsedPayload.episodeId ?? null;
	const nextEpisode =
		anchor &&
		sessionEvents.find(
			(e) =>
				e.id > anchor.id &&
				text(e.parsedPayload.episodeId) &&
				e.parsedPayload.episodeId !== episodeId,
		);
	const episodeEvents = anchor
		? sessionEvents.filter(
				(e) => e.id >= anchor.id && (!nextEpisode || e.id < nextEpisode.id),
			)
		: [];
	const preparedEvents = workflowEvents.filter(
		(e) =>
			e.kind === "codex_recovery_capabilities_prepared" &&
			e.execution_id === body.executionId,
	);
	const attempt2PreparedProof =
		episodeId !== null &&
		preparedEvents.some(
			(e) =>
				e.node_id === body.nodeId &&
				e.parsedPayload.recoveryEpisodeId === episodeId &&
				e.parsedPayload.attempt === 2,
		);
	let classification = "other";
	let replacement;
	if (!sessionEvents.length) classification = "excluded_or_ineligible";
	else if (sessionEvents.every((e) => e.event_type === "reown_watch_started"))
		classification = "watch_only";
	else if (
		sessionEvents.every((e) =>
			[
				"reown_watch_started",
				"reown_skipped_not_turn_holder",
				"reown_skipped_superseded",
			].includes(e.event_type),
		) &&
		sessionEvents.some((e) => e.event_type === "reown_skipped_not_turn_holder")
	)
		classification = "skipped_not_holder";
	else if (
		episodeEvents.some(
			(e) =>
				e.event_type === "reown_revive_succeeded" &&
				e.parsedPayload.episodeId === episodeId,
		)
	)
		classification = "succeeded";
	else if (episodeId) {
		const failures = episodeEvents.filter(
			(e) =>
				e.event_type === "reown_revive_failed" &&
				e.parsedPayload.episodeId === episodeId,
		);
		const driftReason = `workflow capability drift for ${body.executionId}`;
		const drift = (e) =>
			e.parsedPayload.reason === driftReason ||
			(typeof e.parsedPayload.reason === "string" &&
				e.parsedPayload.reason.startsWith(`${driftReason}:`));
		const exhaustion =
			failures.length === 2 &&
			failures.every(
				(e) =>
					drift(e) ||
					e.parsedPayload.reason === "recovery owner failed before commit",
			) &&
			failures[0].parsedPayload.attempt === 1 &&
			failures[1].parsedPayload.attempt === 2 &&
			episodeEvents.some(
				(e) =>
					e.id > failures[1].id &&
					e.event_type === "reown_revive_failed" &&
					e.parsedPayload.reason === "episode_exhausted" &&
					e.parsedPayload.attempts === 2 &&
					!Object.hasOwn(e.parsedPayload, "episodeId"),
			);
		if (
			exhaustion &&
			claim?.episode_id === episodeId &&
			session.status === "failed" &&
			session.last_error === "Codex recovery exhausted after 2 attempts" &&
			(!failures.every(drift) || preparedEvents.length === 0)
		) {
			classification = failures.every(drift)
				? "drift_exhausted"
				: "failed_exhausted_no_replacement";
			replacement = replacementProof(db, workflowEvents, body);
			if (replacement) classification = "replaced";
		}
	}
	return {
		...body,
		classification,
		episodeId,
		session,
		claim,
		sessionEvents,
		workflowEvents,
		preparedEvents,
		attempt2PreparedProof,
		...(replacement ? { replacement } : {}),
	};
}
export function observeRound({ dbPath, bounds, bodies }) {
	return withSnapshot(dbPath, (db) => {
		requireSchema(db, Object.keys(schemas));
		if (
			!bodies ||
			!["B1", "B2", "B3"].every(
				(label) =>
					bodies[label] &&
					["executionId", "runId", "nodeId"].every((k) =>
						text(bodies[label][k]),
					),
			)
		)
			throw new Error("bodies invalid");
		const entries = ["B1", "B2", "B3"].map((label) => [label, bodies[label]]);
		const runIds = entries.map(([, b]) => b.runId);
		requireRuns(db, runIds);
		if (
			new Set(entries.map(([, b]) => b.executionId)).size !== 3 ||
			!bound(bounds?.sessionEventsMaxId) ||
			!bounds.runEventMaxSeq ||
			!runIds.every(
				(id) =>
					Object.hasOwn(bounds.runEventMaxSeq, id) &&
					bound(bounds.runEventMaxSeq[id]),
			)
		)
			throw new Error("bounds invalid");
		const sessionEvents = db
			.prepare(
				"SELECT id,event_id,ts,event_type,payload,execution_id,source FROM session_events WHERE id>? AND source='bridge.codex-session-reown' AND execution_id IN (?,?,?) ORDER BY id",
			)
			.all(bounds.sessionEventsMaxId, ...entries.map(([, b]) => b.executionId))
			.map(decode);
		const workflowRunEvents = runIds.flatMap((run) =>
			db
				.prepare(
					"SELECT seq,event_uid,at,kind,node_id,execution_id,payload,run_id FROM workflow_run_event WHERE run_id=? AND seq>? ORDER BY seq",
				)
				.all(run, bounds.runEventMaxSeq[run])
				.map(decode),
		);
		const classified = Object.fromEntries(
			entries.map(([label, body]) => [
				label,
				classify(
					db,
					body,
					sessionEvents.filter((e) => e.execution_id === body.executionId),
					workflowRunEvents.filter((e) => e.run_id === body.runId),
				),
			]),
		);
		return {
			status: "pass",
			bodies: classified,
			capabilityDriftEvents: db
				.prepare(
					"SELECT id,event_id,ts,event_type,payload,execution_id,source FROM session_events WHERE id>? AND instr(lower(payload),'capability drift')>0 ORDER BY id",
				)
				.all(bounds.sessionEventsMaxId)
				.map(decode),
			timeline: { sessionEvents, workflowRunEvents },
		};
	});
}
