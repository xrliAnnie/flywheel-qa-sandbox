import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { CommDB } from "../db.js";
import { buildSafeRegex } from "../validate.js";

const execFileAsync = promisify(execFile);

export interface SearchArgs {
	execId: string;
	pattern: string;
	dbPath: string;
	lines?: number;
}

export interface SearchMatch {
	line: number;
	text: string;
}

export interface SearchResult {
	matches: SearchMatch[];
	total_lines: number;
	pattern: string;
}

export async function search(args: SearchArgs): Promise<SearchResult> {
	if (!existsSync(args.dbPath)) {
		throw new Error(`Database not found: ${args.dbPath}`);
	}

	// Pre-validate pattern safety (length + nested quantifiers)
	buildSafeRegex(args.pattern);

	const db = CommDB.openReadonly(args.dbPath);
	let tmuxTarget: string;
	try {
		const session = db.getSession(args.execId);
		if (!session) {
			throw new Error(`No session found for execution: ${args.execId}`);
		}
		tmuxTarget = session.tmux_window;
	} finally {
		db.close();
	}

	const lines = args.lines ?? 500;
	let output: string;
	try {
		const result = await execFileAsync(
			"tmux",
			["capture-pane", "-t", tmuxTarget, "-p", "-S", `-${lines}`],
			{ encoding: "utf-8", timeout: 5000 },
		);
		output = result.stdout;
	} catch {
		throw new Error(`tmux window not found: ${tmuxTarget}`);
	}

	const regex = buildSafeRegex(args.pattern);
	const allLines = output.split("\n");
	const matches: SearchMatch[] = [];
	for (let i = 0; i < allLines.length; i++) {
		const line = allLines[i]!;
		if (regex.test(line)) {
			matches.push({ line: i + 1, text: line });
		}
	}

	return { matches, total_lines: allLines.length, pattern: args.pattern };
}
