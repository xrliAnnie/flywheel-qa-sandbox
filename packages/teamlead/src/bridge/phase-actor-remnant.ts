import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { deriveRunnerMailboxIdentity } from "flywheel-agent-team-transport";
import type { PhaseSession } from "./phase-orchestrator.js";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 10_000;

/**
 * FLY-1462 (Codex design R1 HIGH-1, R2 HIGH-1/2, R3 HIGH-1/2 + MED-1): direct,
 * adapter-aware process evidence for the no-target re-entry branch. The
 * exec-marker sweep alone is NOT death proof — marker publication is
 * best-effort. Replacement additionally requires this probe to positively
 * return `none`.
 *
 * claude-tmux family (incl. legacy rows with no adapter_type) — two layers:
 *   1. argv needle: the mailbox-era spawn CLI carries the Agent Team identity
 *      (`--agent-id/--agent-name runner-<execId8>`, derived via
 *      `deriveRunnerMailboxIdentity` — reused HERE so the needle cannot drift
 *      from the spawn side). Process argv is readable cross-process on macOS
 *      (`ps -axww -o command=`); process ENV is not, which is why the needle
 *      is argv-based. A hit → `found`.
 *   2. window accounting (R2 HIGH-2: identity flags are CONDITIONAL — commdb
 *      rollback / missing leadId / transport failure legally spawn an
 *      identity-less actor): every TmuxAdapter runner window lives in a
 *      `runner-*` session AND/OR — after the base session is gone — survives
 *      as a `cmux-*` linked-view SOLE HOLDER (R3 HIGH-2, cmux-sync strict
 *      topology), so BOTH namespaces are inventoried, deduped by window id.
 *      Only windows with at least one LIVE pane count (R3 MED-1:
 *      remain-on-exit dead pins cannot write and must not globally veto —
 *      an unrelated pre-marker husk would otherwise hold FLY-1150 forever).
 *      `none` requires every live window to be positively attributed to a
 *      DIFFERENT execution via its `@flywheel_exec_id` marker; an unmarked
 *      live window is an unattributable actor that COULD be this execution →
 *      `indeterminate` (hold). A live window claiming THIS execution →
 *      `found`.
 *
 * codex-tmux (R3 HIGH-1): a point-in-time negative snapshot (shim pid ESRCH +
 * socket unheld + process group empty) is NOT stable death evidence — the
 * codex goal runtime auto-restarts the daemon after transport death, and the
 * next generation's pid/socket only become observable after initialize/
 * ensureThread. Proving "will not spawn again" needs a durable quiescence
 * fence in the adapter runtime (follow-up); until then codex rows are an
 * EXPLICIT conservative boundary: always `indeterminate` → hold + alertHold
 * visibility + manual convergence. (FLY-1150 and the incident class are
 * claude rows; their self-heal is unaffected.)
 *
 * antigravity/kimi (no-transport) and unknown adapters: no process identity
 * signature exists → `indeterminate`. These runners never enter the
 * wake-dependent rework loop (pr_handoff terminal route) — defensive branch.
 */
export type ActorProcessRemnant = "none" | "found" | "indeterminate";

export interface RunnerWindowInventoryEntry {
	windowId: string;
	marker: string;
	hasLivePane: boolean;
}

export interface ActorRemnantDeps {
	/** Injectable `ps -axww -o command=` snapshot (tests). */
	listProcessCommands?(): Promise<string>;
	/** Injectable runner/cmux window inventory (tests). */
	listRunnerWindowInventory?(): Promise<RunnerWindowInventoryEntry[]>;
}

function defaultListProcessCommands(): Promise<string> {
	return execFileAsync("ps", ["-axww", "-o", "command="], {
		timeout: PROBE_TIMEOUT_MS,
	}).then((r) => r.stdout);
}

/**
 * OWNER-AWARE pane-level inventory (R4 HIGH-1/HIGH-2). A raw
 * `tmux list-panes -a` row participates only when its session provably hosts
 * RUNNER windows:
 *   - base `runner-*` sessions count directly;
 *   - managed view namespaces (`cmux-*`, `fwstage-*`, `fwkeeper-*` — the
 *     strict cmux-sync canonical / staging / escrow forms, each of which can
 *     be a live window's SOLE holder) count ONLY when their session-scoped
 *     `@flywheel_cmux_owner` proves the owner is a `runner-*` session. Lead
 *     views carry their lead session as owner and are EXCLUDED — a bare
 *     namespace prefix would let every normal live Lead view permanently veto
 *     the claude self-heal (R4 HIGH-1). The supported
 *     `FLYWHEEL_CMUX_STRICT_VIEW=0` ordered rollback creates OWNERLESS
 *     GROUPED views instead (R5 HIGH-1); for those the tmux session group
 *     (= the base session's name, the same proof the shell helpers use)
 *     decides: runner-* group counts, a lead group is excluded. A managed
 *     view with neither owner nor group — or an included row with an
 *     undecidable pane state — fails the whole inventory closed
 *     (`indeterminate`), never a silent skip.
 * Rows are folded to windows (deduped by window id — linked views re-expose
 * the same id) with the `@flywheel_exec_id` window marker and whether any
 * pane is still live (`#{pane_dead}` = 0).
 */
export function parseRunnerWindowInventory(
	raw: string,
): RunnerWindowInventoryEntry[] {
	const byWindow = new Map<string, RunnerWindowInventoryEntry>();
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		const [
			sessionName,
			windowId,
			paneDead,
			marker = "",
			owner = "",
			group = "",
		] = line.split("\t");
		if (!sessionName || !windowId) continue;
		const isBaseRunner = sessionName.startsWith("runner-");
		const isManagedView =
			sessionName.startsWith("cmux-") ||
			sessionName.startsWith("fwstage-") ||
			sessionName.startsWith("fwkeeper-");
		let include: boolean;
		if (isBaseRunner) {
			include = true;
		} else if (isManagedView) {
			if (owner) {
				// Strict topology: the session-scoped owner is authoritative.
				include = owner.startsWith("runner-");
			} else if (group) {
				// R5 HIGH-1: `FLYWHEEL_CMUX_STRICT_VIEW=0` is a SUPPORTED ordered
				// rollback that creates ownerless GROUPED views (and invariant
				// rollback repair does the same). The tmux session group carries
				// the base session's name — the same ownership proof the shell
				// helpers use: runner-* group counts, a lead group is excluded.
				include = group.startsWith("runner-");
			} else {
				// Ownerless, ungrouped managed view: no ownership proof exists in
				// either supported topology. A destructive decision must not
				// silently skip it — fail the whole inventory closed.
				throw new Error(
					`unattributable managed view ${sessionName} (${windowId}): no owner and no session group`,
				);
			}
		} else {
			include = false;
		}
		if (!include) continue;
		if (paneDead !== "0" && paneDead !== "1") {
			// An included row with an undecidable pane state must not be guessed
			// into a dead husk (R5) — fail the inventory closed.
			throw new Error(
				`undecidable pane_dead ${JSON.stringify(paneDead)} for ${sessionName} (${windowId})`,
			);
		}
		const prev = byWindow.get(windowId);
		const live = paneDead === "0";
		if (prev) {
			prev.hasLivePane = prev.hasLivePane || live;
			if (!prev.marker && marker) prev.marker = marker;
		} else {
			byWindow.set(windowId, { windowId, marker, hasLivePane: live });
		}
	}
	return [...byWindow.values()];
}

async function defaultListRunnerWindowInventory(): Promise<
	RunnerWindowInventoryEntry[]
> {
	const { stdout } = await execFileAsync(
		"tmux",
		[
			"list-panes",
			"-a",
			"-F",
			"#{session_name}\t#{window_id}\t#{pane_dead}\t#{@flywheel_exec_id}\t#{@flywheel_cmux_owner}\t#{session_group}",
		],
		{ timeout: PROBE_TIMEOUT_MS },
	);
	return parseRunnerWindowInventory(stdout);
}

export async function probeActorProcessRemnant(
	session: PhaseSession,
	deps: ActorRemnantDeps = {},
): Promise<ActorProcessRemnant> {
	const adapter = session.adapter_type ?? "claude-tmux";
	if (adapter !== "claude-tmux") return "indeterminate";
	// Same derivation the spawn side uses (teamName is irrelevant to the
	// agentName and PhaseSession has no lead column — FLY-855).
	if (session.execution_id.length < 8) return "indeterminate";
	const needle = deriveRunnerMailboxIdentity(
		session.execution_id,
		"unused",
	).agentName;
	let snapshot: string;
	try {
		snapshot = await (deps.listProcessCommands ?? defaultListProcessCommands)();
	} catch {
		return "indeterminate";
	}
	if (!snapshot.trim()) return "indeterminate";
	if (snapshot.includes(needle)) return "found";
	let windows: RunnerWindowInventoryEntry[];
	try {
		windows = await (
			deps.listRunnerWindowInventory ?? defaultListRunnerWindowInventory
		)();
	} catch {
		return "indeterminate";
	}
	for (const w of windows) {
		if (!w.hasLivePane) continue;
		if (w.marker === session.execution_id) return "found";
		if (!w.marker.trim()) return "indeterminate";
	}
	return "none";
}
