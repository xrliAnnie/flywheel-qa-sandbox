/**
 * FLY-245 D2 — the AUTHORITATIVE started-evidence checker (plan §5.2.1 item 4,
 * R4-HIGH + the Codex R5 implementation note).
 *
 * "Started" for an execution id means exactly one thing: the Runner
 * SELF-REGISTERED a non-`:pending` tmux identity in CommDB AND that tmux window
 * is live right now. Everything weaker is NOT evidence:
 *   - the intent WAL marker (written before `blueprint.run()`) only proves
 *     "we meant to start";
 *   - the Bridge's CommDB pre-registration (`<session>:pending`, FLY-80) is
 *     written before the runner exists;
 *   - StateStore's early `session_started` event fires before the adapter
 *     spawn — this module never consults StateStore at all, by construction;
 *   - a bare CommDB row without a live window proves a runner once existed,
 *     not that one is running (row exists ≠ live) — a same-execId re-drive
 *     converges via find-or-create, so treating it as not-started is safe.
 *
 * A CommDB read error (or a thrown probe) is `lookup_error`: we could not
 * prove the state either way, and every caller must fail closed on it (a blind
 * re-drive could start a second runner; a blind "started" could swallow one).
 */

import {
	lookupTmuxTarget,
	probeTmuxWindowLiveness,
	type TmuxTargetLookup,
	type TmuxWindowProbe,
} from "./tmux-lookup.js";

export type StartedEvidence =
	| { started: true; tmuxWindow: string }
	| {
			started: false;
			reason: "no_row" | "pending_only" | "tmux_dead" | "lookup_error";
	  };

export interface StartedEvidenceDeps {
	/** CommDB session lookup (default: real `lookupTmuxTarget`). */
	lookup?: (executionId: string, projectName: string) => TmuxTargetLookup;
	/**
	 * Tri-state live tmux window probe (default: real
	 * `probeTmuxWindowLiveness`). MUST distinguish a provably-dead window from an
	 * indeterminate probe failure — see Codex R1 HIGH-4.
	 */
	probeWindow?: (tmuxWindow: string) => Promise<TmuxWindowProbe>;
}

export async function checkStartedEvidence(
	executionId: string,
	projectName: string,
	deps: StartedEvidenceDeps = {},
): Promise<StartedEvidence> {
	const lookup = deps.lookup ?? lookupTmuxTarget;
	const probeWindow = deps.probeWindow ?? probeTmuxWindowLiveness;

	let target: TmuxTargetLookup;
	try {
		target = lookup(executionId, projectName);
	} catch {
		return { started: false, reason: "lookup_error" };
	}
	if (target.kind === "error") {
		return { started: false, reason: "lookup_error" };
	}
	if (target.kind === "gone") {
		return { started: false, reason: "no_row" };
	}
	// FLY-80 pre-registration is `<session>:pending` — never started evidence,
	// and not worth probing (the shared session being alive proves nothing
	// about THIS execution).
	if (target.target.tmuxWindow.endsWith(":pending")) {
		return { started: false, reason: "pending_only" };
	}
	let probe: TmuxWindowProbe;
	try {
		probe = await probeWindow(target.target.tmuxWindow);
	} catch {
		return { started: false, reason: "lookup_error" };
	}
	// HIGH-4: only a PROVABLY dead window is `tmux_dead`. An indeterminate probe
	// (timeout / ENOENT / EACCES) is `lookup_error` (fail-closed) — never a
	// false "dead" that would re-dispatch a second Runner.
	if (probe === "alive") {
		return { started: true, tmuxWindow: target.target.tmuxWindow };
	}
	if (probe === "dead") {
		return { started: false, reason: "tmux_dead" };
	}
	return { started: false, reason: "lookup_error" };
}
