import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { CommDB } from "../db.js";

export interface CaptureArgs {
	execId: string;
	dbPath: string;
	lines?: number;
}

export function capture(args: CaptureArgs): string {
	if (!existsSync(args.dbPath)) {
		throw new Error(`Database not found: ${args.dbPath}`);
	}
	const db = new CommDB(args.dbPath, false);
	try {
		const session = db.getSession(args.execId);
		if (!session) {
			throw new Error(`No session found for execution: ${args.execId}`);
		}

		// tmux_window stores the full target (e.g., "flywheel:@42")
		const tmuxTarget = session.tmux_window;
		const lines = args.lines ?? 100;
		try {
			const result = execFileSync(
				"tmux",
				["capture-pane", "-t", tmuxTarget, "-p", "-S", `-${lines}`],
				{ encoding: "utf-8" },
			);
			return result;
		} catch {
			throw new Error(
				`tmux window not found: ${tmuxTarget} (session status: ${session.status})`,
			);
		}
	} finally {
		db.close();
	}
}
