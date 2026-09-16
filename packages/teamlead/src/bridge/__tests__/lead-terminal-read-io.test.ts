import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createTerminalSessionCore } from "flywheel-comm/terminal-observation";
import { expect, it } from "vitest";
import {
	createLeadTerminalInputIo,
	createLeadTerminalReadIo,
} from "../lead-terminal-read-io.js";

const run = promisify(execFile),
	executable =
		process.platform === "darwin" ? "/opt/homebrew/bin/tmux" : "/usr/bin/tmux";
it.skipIf(!existsSync(executable))(
	"reads a private real Runner socket and cannot send keys",
	async () => {
		const home = mkdtempSync(join(tmpdir(), "terminal-io-"));
		const env = { PATH: "/usr/bin:/bin", HOME: home, TMUX_TMPDIR: home };
		const controller = new AbortController();
		try {
			await run(
				executable,
				[
					"-f",
					"/dev/null",
					"new-session",
					"-d",
					"-s",
					"fixture",
					"/bin/sh",
					"-c",
					"printf 'TERMINAL_IO_CANARY\\n'; sleep 60",
				],
				{ env, timeout: 5000 },
			);
			const io = createLeadTerminalReadIo(controller.signal, {
				...env,
				TMUX: "/ignored-carrier-socket,123,0",
				FLYWHEEL_API_TOKEN: "NEVER_FORWARD",
			});
			const observation = await io.inspect("fixture:0");
			expect(observation.alive).toBe(true);
			expect(observation.observedSessionId).toMatch(/^\$\d+:%\d+$/);
			let text = "";
			for (let i = 0; i < 20; i++) {
				text = await io.capture(
					observation.observedSessionId.split(":")[1]!,
					20,
				);
				if (text.includes("TERMINAL_IO_CANARY")) break;
				await new Promise((r) => setTimeout(r, 25));
			}
			expect(text).toContain("TERMINAL_IO_CANARY");
			await expect(io.send("%0", "yes", async () => {})).rejects.toThrow(
				"terminal_read_only",
			);
			controller.abort();
			await expect(io.inspect("fixture:0")).rejects.toThrow();
		} finally {
			await run(executable, ["kill-server"], { env, timeout: 5000 }).catch(
				() => {},
			);
			rmSync(home, { recursive: true, force: true });
		}
	},
);

it.skipIf(!existsSync(executable))(
	"submits literal input only to the observed waiting private pane",
	async () => {
		const home = mkdtempSync(join(tmpdir(), "terminal-input-io-")),
			env = { PATH: "/usr/bin:/bin", HOME: home, TMUX_TMPDIR: home };
		try {
			await run(
				executable,
				[
					"-f",
					"/dev/null",
					"new-session",
					"-d",
					"-s",
					"fixture",
					"/bin/sh",
					"-c",
					"printf 'Proceed? [Y/n]'; read answer; printf '\\nINPUT:%s\\n' \"$answer\"; sleep 60",
				],
				{ env, timeout: 5000 },
			);
			const io = createLeadTerminalInputIo(new AbortController().signal, env);
			const core = createTerminalSessionCore({
				projectName: "project",
				leadId: "eng",
				assertCurrent: () => {},
				getSession: async (executionId) => ({
					executionId,
					projectName: "project",
					leadId: "eng",
					target: "fixture:0",
					status: "running",
				}),
				...io,
			});
			let status = await core.status("exec");
			for (let i = 0; i < 20 && status.status !== "waiting"; i++) {
				await new Promise((r) => setTimeout(r, 25));
				status = await core.status("exec");
			}
			expect(status.status).toBe("waiting");
			await core.input("exec", status.observedSessionId, "yes");
			let output = "";
			for (let i = 0; i < 20; i++) {
				output = (await core.capture("exec", 20)).text;
				if (output.includes("INPUT:yes")) break;
				await new Promise((r) => setTimeout(r, 25));
			}
			expect(output).toContain("INPUT:yes");
		} finally {
			await run(executable, ["kill-server"], { env, timeout: 5000 }).catch(
				() => {},
			);
			rmSync(home, { recursive: true, force: true });
		}
	},
);

it.each(["id", "index"])(
	"rejects a deleted %s window instead of observing or typing into the other private window",
	async (mode) => {
		const home = mkdtempSync(join(tmpdir(), "t2519-"));
		const env = { PATH: "/usr/bin:/bin", HOME: home, TMUX_TMPDIR: home };
		const cmd = (args: string[]) =>
			run(executable, args, { env, timeout: 5000 });
		try {
			const own = (
				await cmd([
					"-f",
					"/dev/null",
					"new-session",
					"-d",
					"-P",
					"-F",
					"#{window_id}",
					"-s",
					"fixture",
					"/bin/sh",
					"-c",
					"sleep 60",
				])
			).stdout.trim();
			const other = (
				await cmd([
					"new-window",
					"-t",
					"fixture",
					"-P",
					"-F",
					"#{window_id}",
					"/bin/sh",
					"-c",
					"printf 'FOREIGN_CANARY Proceed? [Y/n]'; read answer; printf 'FOREIGN_INPUT:%s' \"$answer\"; sleep 60",
				])
			).stdout.trim();
			const io = createLeadTerminalInputIo(new AbortController().signal, env);
			const windowIndex = (
				await cmd([
					"display-message",
					"-p",
					"-t",
					`fixture:${own}`,
					"#{window_index}",
				])
			).stdout.trim();
			const target = `fixture:${mode === "id" ? own : windowIndex}`;
			const before = await io.inspect(target);
			expect(before.alive).toBe(true);
			await cmd(["kill-window", "-t", target]);
			const core = createTerminalSessionCore({
				projectName: "project",
				leadId: "eng",
				assertCurrent: () => {},
				getSession: async (executionId) => ({
					executionId,
					projectName: "project",
					leadId: "eng",
					target,
					status: "running",
				}),
				...io,
			});
			await expect(io.inspect(target)).rejects.toThrow("terminal_not_found");
			await expect(core.capture("exec", 20)).rejects.toThrow(
				"terminal_not_found",
			);
			await expect(core.status("exec")).rejects.toThrow("terminal_not_found");
			await expect(
				core.input("exec", before.observedSessionId, "INJECTED"),
			).rejects.toThrow("terminal_not_found");
			expect((await io.inspect(`fixture:${other}`)).alive).toBe(true);
			const output = (
				await cmd(["capture-pane", "-p", "-t", `fixture:${other}`])
			).stdout;
			expect(output).not.toContain("INJECTED");
		} finally {
			await cmd(["kill-server"]).catch(() => {});
			rmSync(home, { recursive: true, force: true });
		}
	},
	15_000,
);
