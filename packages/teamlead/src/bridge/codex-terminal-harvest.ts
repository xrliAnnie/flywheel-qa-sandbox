import type { CodexDaemonEvidence } from "flywheel-claude-runner";
import type { Session } from "../StateStore.js";
import type { RunnerTmuxTargetDiscovery } from "./tmux-lookup.js";

export type CodexTerminalHarvestResult =
	| "not_applicable"
	| "keep"
	| { kind: "absent"; canFinalize: () => boolean };
export interface CodexTerminalHarvestDeps {
	getSession: () => Session | undefined;
	isOwned: () => boolean;
	residentHoldState: () => string | undefined;
	targetUnchangedAndNoTurn: () => boolean;
	discover: () => Promise<RunnerTmuxTargetDiscovery>;
	evidence: () => Promise<CodexDaemonEvidence>;
	absence: () => Promise<"alive" | "dead" | "unknown">;
	close: (session: Session, beforeSignal: () => boolean) => Promise<unknown>;
}
const TERMINAL = new Set(["completed", "failed", "terminated"]);

/** The caller has already proved the registered tmux target absent. Never
 * infer daemon absence from a terminal status or an unresolved window. */
export async function harvestTerminalCodexDaemon(
	executionId: string,
	projectName: string,
	deps: CodexTerminalHarvestDeps,
): Promise<CodexTerminalHarvestResult> {
	try {
		const matches = (session: Session | undefined): session is Session =>
			session?.execution_id === executionId &&
			session.project_name === projectName &&
			session.adapter_type === "codex-tmux" &&
			TERMINAL.has(session.status);
		const session = deps.getSession();
		if (
			session?.execution_id === executionId &&
			session.project_name === projectName &&
			session.adapter_type !== "codex-tmux"
		)
			return "not_applicable";
		if (!matches(session)) return "keep";
		const beforeSignal = () => {
			try {
				if (!matches(deps.getSession())) return false;
				if (deps.isOwned()) {
					console.log(
						`[codex-terminal-harvest] window_recovery_needed: ${executionId} is owned`,
					);
					return false;
				}
				const hold = deps.residentHoldState();
				return (
					hold !== "resident" &&
					hold !== "woken" &&
					deps.targetUnchangedAndNoTurn()
				);
			} catch {
				return false;
			}
		};
		if (!beforeSignal()) return "keep";
		if ((await deps.discover()).kind !== "missing") return "keep";
		const evidence = await deps.evidence();
		if ((await deps.discover()).kind !== "missing") return "keep";
		if (!beforeSignal()) return "keep";
		if (evidence.liveness === "absent") {
			const absence = await deps.absence();
			return absence === "dead" && beforeSignal()
				? { kind: "absent", canFinalize: beforeSignal }
				: "keep";
		}
		if (evidence.ledger !== "valid_group" || !evidence.socketLive)
			return "keep";
		// The existing reaper independently proves socket-holder -> persisted PGID
		// ownership and invokes this synchronous guard after its final await.
		const outcome = await deps.close(session, beforeSignal);
		console.log(
			`[codex-terminal-harvest] ${executionId} status=${session.status} window=dead evidence=${JSON.stringify(evidence)} close=${JSON.stringify(outcome)}; retained_until_next_pass`,
		);
		return "keep";
	} catch (error) {
		console.warn(
			`[codex-terminal-harvest] ${executionId} retained: ${error instanceof Error ? error.message : String(error)}`,
		);
		return "keep";
	}
}
