import { execFile } from "node:child_process";
import { promisify } from "node:util";

interface TmuxExecFileOptions {
	encoding: "utf-8";
	timeout: number;
	env: NodeJS.ProcessEnv;
}

export type TmuxExecFile = (
	file: string,
	args: string[],
	options: TmuxExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile) as TmuxExecFile;

/**
 * terminal-mcp targets socket-less CommDB `session:window` identifiers, which
 * belong to the default tmux server. A v2 Lead seat injects its private server
 * through TMUX; inheriting that value redirects every client call away from the
 * Runner namespace. Strip only seat-scoped variables at the subprocess edge.
 * TMUX_TMPDIR deliberately remains available to steer the default socket.
 */
export function sanitizeTmuxEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...base };
	delete env.TMUX;
	delete env.TMUX_PANE;
	return env;
}

export interface ExecTmuxOptions {
	timeout: number;
	/** Test seams. Production call sites use the process environment and execFile. */
	env?: NodeJS.ProcessEnv;
	execFileFn?: TmuxExecFile;
}

export function execTmux(
	args: string[],
	options: ExecTmuxOptions,
): Promise<{ stdout: string; stderr: string }> {
	const run = options.execFileFn ?? execFileAsync;
	return run("tmux", args, {
		encoding: "utf-8",
		timeout: options.timeout,
		env: sanitizeTmuxEnv(options.env ?? process.env),
	});
}
