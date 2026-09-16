import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TerminalSessionCoreOptions } from "flywheel-comm/terminal-observation";

const run = promisify(execFile);
/** Fixed read commands against the Runner namespace; no carrier credentials or seat socket. */
export function createLeadTerminalReadIo(
	signal: AbortSignal,
	env: NodeJS.ProcessEnv,
) {
	return createLeadTerminalIo(signal, env, false);
}
export function createLeadTerminalInputIo(
	signal: AbortSignal,
	env: NodeJS.ProcessEnv,
) {
	return createLeadTerminalIo(signal, env, true);
}
function createLeadTerminalIo(
	signal: AbortSignal,
	env: NodeJS.ProcessEnv,
	writable: boolean,
): Pick<TerminalSessionCoreOptions, "inspect" | "capture" | "send"> {
	const executable =
		process.platform === "darwin" ? "/opt/homebrew/bin/tmux" : "/usr/bin/tmux";
	const childEnv = {
		PATH: "/usr/bin:/bin",
		HOME: "/var/empty",
		...(env.TMUX_TMPDIR ? { TMUX_TMPDIR: env.TMUX_TMPDIR } : {}),
	};
	const command = async (target: string, args: string[]) => {
		signal.throwIfAborted();
		if (!/^[A-Za-z0-9_.:@%$-]{1,256}$/.test(target))
			throw new Error("terminal_unavailable");
		const { stdout } = await run(executable, args, {
			env: childEnv,
			signal,
			timeout: 5000,
			maxBuffer: 1024 * 1024,
			encoding: "utf8",
		});
		signal.throwIfAborted();
		return stdout;
	};
	return {
		inspect: async (target) => {
			let expectedWindow = /:(@\d+)$/.exec(target)?.[1];
			if (!expectedWindow) {
				try {
					expectedWindow = (
						await command(target, [
							"list-panes",
							"-t",
							target,
							"-F",
							"#{window_id}",
						])
					)
						.trim()
						.split("\n")[0];
				} catch {
					signal.throwIfAborted();
					throw new Error("terminal_not_found");
				}
			}
			if (!expectedWindow || !/^@\d+$/.test(expectedWindow))
				throw new Error("terminal_not_found");
			const output = await command(target, [
				"display-message",
				"-p",
				"-t",
				target,
				"#{session_id}:#{pane_id}|#{pane_dead}|#{window_id}",
			]).catch(() => {
				signal.throwIfAborted();
				throw new Error("terminal_not_found");
			});
			const [observedSessionId, dead, observedWindow] = output
				.trim()
				.split("|");
			if (observedWindow !== expectedWindow)
				throw new Error("terminal_not_found");
			return {
				observedSessionId: observedSessionId ?? "",
				alive: dead === "0",
			};
		},
		capture: (target, lines) =>
			command(target, [
				"capture-pane",
				"-p",
				"-t",
				target,
				"-S",
				String(-lines),
			]),
		send: async (target, text, beforeSend) => {
			if (!writable) throw new Error("terminal_read_only");
			await beforeSend();
			await command(target, ["send-keys", "-t", target, "-l", "--", text]);
			await beforeSend();
			await command(target, ["send-keys", "-t", target, "Enter"]);
		},
	};
}
