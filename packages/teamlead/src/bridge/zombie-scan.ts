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
 *  ③ stale_target    — both sides say `running` but the tmux target is
 *                      provably dead AND the heartbeat is ≥24h stale.
 *
 * Pure over injected accessors — the plugin wires CommDB rows + StateStore
 * lookups + the tmux probe; tests feed fixtures.
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
	/**
	 * Tri-state tmux target liveness: true=alive, false=provably dead,
	 * null=cannot tell (indeterminate NEVER counts as a zombie).
	 */
	targetAlive: (tmuxWindow: string) => Promise<boolean | null>;
	nowMs: number;
	/** Heartbeat staleness floor for shape ③ (default 24h). */
	staleTargetMs?: number;
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

function sqliteUtcMs(s: string | null | undefined): number | null {
	if (!s) return null;
	const t = Date.parse(`${s.replace(" ", "T")}Z`);
	return Number.isNaN(t) ? null : t;
}

export async function scanZombies(
	inputs: ZombieScanInputs,
): Promise<ZombieFinding[]> {
	const staleMs = inputs.staleTargetMs ?? 24 * 60 * 60 * 1000;
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
		// Shape ③: both running — zombie ONLY when the tmux target is provably
		// dead AND the heartbeat is long stale (never on indeterminate).
		if (session.status === "running" && row.tmux_window) {
			const hb = sqliteUtcMs(session.heartbeat_at);
			if (hb !== null && inputs.nowMs - hb >= staleMs) {
				const alive = await inputs.targetAlive(row.tmux_window);
				if (alive === false) {
					out.push({
						shape: "stale_target",
						executionId: row.execution_id,
						projectName: row.project_name,
						detail: `双侧 running 但 tmux target 已死且心跳陈旧 ≥${Math.round(staleMs / 3_600_000)}h`,
					});
				}
			}
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
