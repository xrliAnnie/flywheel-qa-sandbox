import { resolve } from "node:path";
import Database from "better-sqlite3";
import { commDbPathForProject } from "flywheel-config";
import { resolveStateDbPath } from "./commands/verify-approval.js";

/** Read live actor authority before acquiring the CommDB write lock. */
export function readTurnWaitSuppression(
	stateDbPath: string,
	input: { executionId: string; runId: string; issueId: string },
): string | null {
	let state: Database.Database | undefined;
	try {
		state = new Database(stateDbPath, { readonly: true, fileMustExist: true });
		const row = state
			.prepare(`
   SELECT r.status, r.current_node_id, n.attempt, n.state, n.execution_id, n.ended_at
   FROM workflow_run r
   LEFT JOIN workflow_run_node n ON n.run_id = r.run_id AND n.node_id = r.current_node_id
    AND n.attempt = (SELECT MAX(latest.attempt) FROM workflow_run_node latest
     WHERE latest.run_id = r.run_id AND latest.node_id = r.current_node_id)
   WHERE r.run_id = ? AND r.issue_id = ?
    AND EXISTS (SELECT 1 FROM workflow_execution_binding b
     WHERE b.run_id = r.run_id AND b.execution_id = ?)
  `)
			.get(input.runId, input.issueId, input.executionId) as
			| {
					status: string;
					current_node_id: string | null;
					attempt: number | null;
					state: string | null;
					execution_id: string | null;
					ended_at: string | null;
			  }
			| undefined;
		if (!row || (row.attempt === null && row.status !== "completed"))
			return null;
		if (!["active", "held", "terminated", "completed"].includes(row.status))
			return null;
		if (
			row.status !== "completed" &&
			![
				"pending",
				"admitted",
				"running",
				"review",
				"done",
				"failed",
				"completed",
				"superseded",
			].includes(row.state ?? "")
		)
			return null;
		if (
			row.status !== "completed" &&
			row.ended_at === null &&
			["pending", "admitted", "running", "review"].includes(row.state ?? "") &&
			row.execution_id === input.executionId
		)
			return null;
		return `not_current_actor:${input.runId}:${row.current_node_id}:${row.attempt}:actor=${row.execution_id}:state=${row.state}:run=${row.status}`;
	} catch (error) {
		console.error(
			`[turn] workflow actor unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	} finally {
		state?.close();
	}
}

/** Reuse existing resolvers; an isolated CommDB must name its StateStore. */
export function resolveTurnWaitStateDbPath(
	commDbPath: string,
	project: string | undefined,
	override?: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (
		override?.trim() ||
		env.FLYWHEEL_STATE_DB_PATH?.trim() ||
		env.TEAMLEAD_DB_PATH?.trim() ||
		(project &&
			resolve(commDbPath) === resolve(commDbPathForProject(project, {})))
	) {
		return resolveStateDbPath(override, env);
	}
	console.error(
		"[turn] isolated or unscoped CommDB requires --state-db or a StateStore environment override; retaining TURN wait alerts",
	);
	return undefined;
}
