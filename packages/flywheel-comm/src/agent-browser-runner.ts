import { execFileSync } from "node:child_process";

export const AGENT_BROWSER_CALL_TIMEOUT_MS = 15_000;

export type RunAgentBrowser = (
	args: string[],
	opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => unknown;

export function defaultRunAgentBrowser(
	args: string[],
	opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
	if (args.at(-1) === "--json") {
		return execFileSync("agent-browser", args, {
			encoding: "utf8",
			stdio: ["pipe", "pipe", "inherit"],
			cwd: opts.cwd,
			env: opts.env,
			timeout: AGENT_BROWSER_CALL_TIMEOUT_MS,
		});
	}
	execFileSync("agent-browser", args, {
		stdio: ["pipe", "inherit", "inherit"],
		cwd: opts.cwd,
		env: opts.env,
		timeout: AGENT_BROWSER_CALL_TIMEOUT_MS,
	});
	return undefined;
}
