/**
 * FLY-116: StateStore-aware Terminal viewer identity resolver.
 *
 * Pure title helpers (formatViewTitle / parseViewTitle / ViewTitleParts) live
 * in `flywheel-core` to avoid `core → teamlead` reverse dependency. This module
 * imports them and adds Session/TmuxTarget knowledge.
 */

import { formatViewTitle, type ViewTitleParts } from "flywheel-core";
import type { Session } from "../StateStore.js";
import type { TmuxTarget } from "./tmux-lookup.js";

export interface TerminalViewIdentity extends ViewTitleParts {
	customTitle: string;
}

/**
 * Resolve the unique Terminal viewer identity for a given Runner session.
 * Returns null if `target.tmuxWindow` is malformed (must be `<sessionName>:@<windowId>`).
 *
 * NOTE: `sessionRole` comes from `StateStore.sessions.session_role` (FLY-59),
 * NOT from CommDB target. CommDB only carries `tmuxWindow`.
 */
export function resolveTerminalViewIdentity(
	session: Pick<Session, "execution_id" | "project_name" | "session_role">,
	target: TmuxTarget,
): TerminalViewIdentity | null {
	// target.tmuxWindow = "<sessionName>:<windowId>", e.g. "runner-flywheel:@42"
	const m = target.tmuxWindow.match(/^([^:]+):(@[^:]+)$/);
	if (!m) return null;
	const sessionName = m[1];
	const windowId = m[2];
	if (!sessionName || !windowId) return null;

	const parts: ViewTitleParts = {
		sessionName,
		projectName: session.project_name,
		executionId: session.execution_id,
		windowId,
		sessionRole: session.session_role ?? undefined,
	};
	return { ...parts, customTitle: formatViewTitle(parts) };
}
