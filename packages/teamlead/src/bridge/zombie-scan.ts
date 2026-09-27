/**
 * FLY-1082 (Task 2.6): cross-Lead zombie session DETECTION — the FLY-1066
 * three-shape taxonomy, detection-only (no reaping here; the reaper is
 * FLY-1066's deliverable — kind-contract remediationRef).
 *
 * Shapes (research §2.6):
 *  ① commdb_orphan   — CommDB `running` row with NO StateStore session at all;
 *  ② terminal_desync — StateStore session is TERMINAL but the CommDB
 *                      registration still says `running` (the FLY-817
 *                      reconcile deletes the deletable subset; the preserved
 *                      failed/blocked residue is exactly this shape);
 *  ③ stale_target    — nonterminal bookkeeping remains after confirmed process death.
 *
 * Pure over injected accessors — the plugin wires CommDB rows + StateStore
 * lookups + the common body observation; tests feed fixtures.
 */

export type ZombieShape = "commdb_orphan" | "terminal_desync" | "stale_target";

export interface ZombieFinding {
	shape: ZombieShape;
	executionId: string;
	projectName: string;
	detail: string;
}

export interface CommRunningRow {
	execution_id: string;
	project_name: string;
	tmux_window?: string | null;
}

export interface ZombieScanInputs {
	/** All CommDB `running` rows across projects. */
	commRunning: CommRunningRow[];
	/** StateStore session lookup (undefined = no row — shape ①). */
	storeSession: (
		executionId: string,
	) => { status: string; heartbeat_at?: string | null } | undefined;
	/** Common process evidence; unknown never counts as a dead body. */
	bodyLiveness: (
		executionId: string,
		projectName: string,
	) => Promise<"alive" | "dead" | "unknown">;
}

const TERMINAL_STATUSES = new Set([
	"completed",
	"failed",
	"blocked",
	"terminated",
	"rejected",
	"deferred",
	"shelved",
	"approved",
]);

export async function scanZombies(
	inputs: ZombieScanInputs,
): Promise<ZombieFinding[]> {
	const out: ZombieFinding[] = [];
	for (const row of inputs.commRunning) {
		const session = inputs.storeSession(row.execution_id);
		if (!session) {
			out.push({
				shape: "commdb_orphan",
				executionId: row.execution_id,
				projectName: row.project_name,
				detail: "CommDB running,StateStore 无此 session",
			});
			continue;
		}
		if (TERMINAL_STATUSES.has(session.status)) {
			out.push({
				shape: "terminal_desync",
				executionId: row.execution_id,
				projectName: row.project_name,
				detail: `StateStore 已终态(${session.status}),CommDB 仍 running`,
			});
			continue;
		}
		// Window presence, heartbeat age and parked/review labels do not prove
		// process liveness. Preserve the alert shape key for existing consumers.
		let verdict: "alive" | "dead" | "unknown" = "unknown";
		try {
			verdict = await inputs.bodyLiveness(row.execution_id, row.project_name);
		} catch {
			// Observation failure is not death evidence.
		}
		if (verdict === "dead") {
			out.push({
				shape: "stale_target",
				executionId: row.execution_id,
				projectName: row.project_name,
				detail: `进程已证实死亡，StateStore 仍为非终态(${session.status})`,
			});
		}
	}
	return out;
}

/** The founder-facing sample list (≤10 lines) + total, for the ticket body. */
export function formatZombieSamples(findings: ZombieFinding[]): string {
	const samples = findings
		.slice(0, 10)
		.map(
			(f) => `- [${f.shape}] ${f.executionId} (${f.projectName}) — ${f.detail}`,
		);
	const truncated =
		findings.length > 10 ? `\n…共 ${findings.length} 个（仅列前 10）` : "";
	return `${samples.join("\n")}${truncated}`;
}
