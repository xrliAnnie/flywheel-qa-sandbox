import { readFileSync } from "node:fs";
import { openGates, openSnapshot } from "./qa-fly-2456-db.mjs";

function bindingsFor(db, executionId) {
	const bindings = db
		.prepare(
			"SELECT activation_id,execution_id,run_id,node_id,attempt,mode,bound_at FROM workflow_execution_binding WHERE execution_id=? ORDER BY attempt,activation_id",
		)
		.all(executionId);
	const pairs = [
		...new Map(
			bindings.map((b) => [JSON.stringify([b.run_id, b.node_id]), b]),
		).values(),
	];
	const latestNode = db.prepare(
		"SELECT run_id,node_id,attempt,state,execution_id FROM workflow_run_node WHERE run_id=? AND node_id=? ORDER BY attempt DESC LIMIT 1",
	);
	const latestNodes = pairs.map(
		(b) => latestNode.get(b.run_id, b.node_id) ?? null,
	);
	return { executionId, bindings, latestNodes };
}
export function activationParse(path, executionId) {
	let db;
	try {
		if (typeof executionId !== "string" || !executionId)
			throw new Error("execution invalid");
		({ db } = openSnapshot(path));
		return { status: "pass", ...bindingsFor(db, executionId) };
	} catch (error) {
		return { status: "fail", reason: error.message };
	} finally {
		db?.close();
	}
}
export function campaignShape({ dbPath, commPath, livenessPath, bodies }) {
	let db, comm;
	const failures = [],
		evidence = {};
	try {
		if (
			!bodies ||
			Object.keys(bodies).sort().join(",") !== "B1,B2,B3" ||
			Object.values(bodies).some((x) => typeof x !== "string" || !x) ||
			new Set(Object.values(bodies)).size !== 3
		)
			throw new Error("body identities invalid");
		({ db } = openSnapshot(dbPath));
		({ db: comm } = openSnapshot(commPath));
		const probes = JSON.parse(readFileSync(livenessPath, "utf8"));
		if (!Array.isArray(probes)) throw new Error("liveness array missing");
		for (const [label, executionId] of Object.entries(bodies)) {
			const reject = (reason) => failures.push({ label, executionId, reason });
			const parsed = bindingsFor(db, executionId),
				{ bindings, latestNodes } = parsed;
			const session = db
				.prepare(
					"SELECT execution_id,issue_id,project_name,status,adapter_type FROM sessions WHERE execution_id=?",
				)
				.get(executionId);
			const matches = probes.filter((x) => x.executionId === executionId),
				probe = matches[0];
			evidence[label] = { ...parsed, session, probe };
			const expectedCount = label === "B1" ? 2 : 1;
			if (
				bindings.length !== expectedCount ||
				bindings.some(
					(b, i) =>
						b.attempt !== i + 1 ||
						b.mode !== (i === 0 ? "spawn" : "wake") ||
						b.node_id !== "implement" ||
						b.run_id !== bindings[0]?.run_id,
				) ||
				new Set(bindings.map((b) => b.activation_id)).size !== expectedCount
			)
				reject("activation_shape");
			if (
				latestNodes.length !== 1 ||
				!latestNodes[0] ||
				latestNodes[0].attempt !== expectedCount ||
				latestNodes[0].execution_id !== executionId
			)
				reject("latest_node_mismatch");
			if (
				!session ||
				session.adapter_type !== "codex-tmux" ||
				session.status !== (label === "B3" ? "ship_parked" : "running")
			)
				reject("session_ineligible");
			const run = bindings[0]
				? db
						.prepare(
							"SELECT run_id,status,issue_id,project_name FROM workflow_run WHERE run_id=?",
						)
						.get(bindings[0].run_id)
				: null;
			if (
				!run ||
				run.status !== "active" ||
				run.issue_id !== session?.issue_id ||
				run.project_name !== session?.project_name
			)
				reject("run_ineligible");
			const turn = session
				? comm
						.prepare("SELECT * FROM three_stage_turn WHERE issue_id=?")
						.get(session.issue_id)
				: null;
			evidence[label].turn = turn;
			evidence[label].run = run;
			if (
				!turn ||
				(label === "B3"
					? turn.holder_exec_id === executionId
					: turn.holder_exec_id !== executionId)
			)
				reject("turn_ineligible");
			if (label !== "B3") {
				const gates = openGates(comm, executionId);
				evidence[label].openGateIds = gates.map((g) => g.id);
				if (!gates.length) reject("open_gate_missing");
				if (
					matches.length !== 1 ||
					probe.verdict !== "alive" ||
					probe.groupState !== "alive" ||
					!Number.isInteger(probe.persistedPgidBefore) ||
					probe.persistedPgidBefore <= 1 ||
					probe.persistedPgidBefore !== probe.persistedPgidAfter ||
					!Array.isArray(probe.holderPids) ||
					!probe.holderPids.some(
						(p) =>
							Number.isInteger(p.pid) &&
							p.pid > 0 &&
							p.pgid === probe.persistedPgidBefore,
					)
				)
					reject("liveness_ownership_unproven");
			} else if (
				matches.length !== 1 ||
				!["alive", "absent"].includes(probe.verdict)
			)
				reject("liveness_unknown");
		}
		return {
			status: failures.length ? "fail" : "pass",
			failures,
			bodies: evidence,
		};
	} catch (error) {
		return {
			status: "fail",
			failures: [...failures, { reason: error.message }],
			bodies: evidence,
		};
	} finally {
		db?.close();
		comm?.close();
	}
}
