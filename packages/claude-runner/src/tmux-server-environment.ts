import { homedir } from "node:os";
import { resolve } from "node:path";

const TMUX_SERVER_BIRTH_ALLOWLIST = [
	"SHELL",
	"USER",
	"LOGNAME",
	"LANG",
	"TERM",
	"TMPDIR",
	"TMUX_TMPDIR",
] as const;

/** Exact process environment for an invocation that may create a tmux server. */
export function buildTmuxServerBirthEnvironment(
	source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const home = resolve(source.HOME?.trim() || homedir());
	const env: NodeJS.ProcessEnv = {
		HOME: home,
		PATH: `${home}/.local/bin:${home}/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
	};
	for (const name of TMUX_SERVER_BIRTH_ALLOWLIST) {
		if (source[name] !== undefined) env[name] = source[name];
	}
	return env;
}
