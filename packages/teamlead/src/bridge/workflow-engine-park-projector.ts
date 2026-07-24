import { CommDB } from "flywheel-comm/db";
import type { StateStore } from "../StateStore.js";

export interface WorkflowEngineParkProjectorDeps {
	store: Pick<StateStore, "listWorkflowEngineParkEventsAfter">;
	projectNames: readonly string[];
	commDbPathForProject(projectName: string): string;
	openDb?: (path: string) => CommDB;
	enabled?: () => boolean;
}

/** StateStore append-only engine truth → CommDB wake-admission projection. */
export async function projectWorkflowEngineParkOutbox(
	deps: WorkflowEngineParkProjectorDeps,
): Promise<number> {
	if ((deps.enabled ?? (() => true))() === false) return 0;
	const openDb = deps.openDb ?? ((path: string) => new CommDB(path, false));
	let applied = 0;
	for (const projectName of deps.projectNames) {
		const db = openDb(deps.commDbPathForProject(projectName));
		try {
			for (;;) {
				const cursor = db.getWorkflowEngineParkCursor(projectName);
				const events = deps.store.listWorkflowEngineParkEventsAfter(
					projectName,
					cursor,
					256,
				);
				if (events.length === 0) break;
				db.applyWorkflowEngineParkEvents(projectName, events);
				applied += events.length;
				if (events.length < 256) break;
			}
		} finally {
			db.close();
		}
	}
	return applied;
}
