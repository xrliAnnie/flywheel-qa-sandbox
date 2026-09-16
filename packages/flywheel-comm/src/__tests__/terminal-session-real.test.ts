import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { CommDB } from "../db.js";
import { createTerminalSessionCore } from "../terminal-observation.js";

it.skipIf(!existsSync("/opt/homebrew/bin/tmux"))(
	"binds real private tmux session/pane identity to a readonly CommDB execution before input",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2519-terminal-"));
		const socket = join(root, "tmux.sock"),
			dbPath = join(root, "comm.db");
		const run = promisify(execFile);
		const tmux = async (args: string[]) =>
			(
				await run("/opt/homebrew/bin/tmux", ["-S", socket, ...args], {
					env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root },
					timeout: 5000,
					maxBuffer: 262144,
					encoding: "utf8",
				})
			).stdout;
		const writable = new CommDB(dbPath, true);
		writable.registerSession("fixture", "fixture:0", "test", "FLY-2519", "eng");
		writable.close();
		let sent = 0;
		try {
			await tmux([
				"-f",
				"/dev/null",
				"new-session",
				"-d",
				"-s",
				"fixture",
				"/bin/sh",
				"-c",
				'printf "Do you want to proceed? [Y/n] "; read answer; printf "\\nDONE:%s\\n" "$answer"; sleep 10',
			]);
			const core = createTerminalSessionCore({
				projectName: "test",
				leadId: "eng",
				assertCurrent() {},
				getSession: async (id) => {
					const db = CommDB.openReadonly(dbPath);
					try {
						const row = db.getSession(id);
						return row
							? {
									executionId: row.execution_id,
									projectName: row.project_name,
									leadId: row.lead_id,
									target: row.tmux_window,
									status: row.status,
								}
							: undefined;
					} finally {
						db.close();
					}
				},
				inspect: async (target) => {
					const [observedSessionId, dead] = (
						await tmux([
							"display-message",
							"-p",
							"-t",
							target,
							"#{session_id}:#{pane_id}|#{pane_dead}",
						])
					)
						.trim()
						.split("|");
					return { observedSessionId: observedSessionId!, alive: dead === "0" };
				},
				capture: (target, lines) =>
					tmux(["capture-pane", "-p", "-t", target, "-S", `-${lines}`]),
				send: async (target, text, guard) => {
					await guard();
					await tmux(["send-keys", "-t", target, "-l", "--", text]);
					await guard();
					await tmux(["send-keys", "-t", target, "Enter"]);
					sent++;
				},
			});
			let status = await core.status("fixture");
			for (let n = 0; n < 30 && status.status !== "waiting"; n++) {
				await delay(25);
				status = await core.status("fixture");
			}
			expect(status.status).toBe("waiting");
			expect(status.observedSessionId).toMatch(/^\$\d+:%\d+$/);
			await expect(core.input("fixture", "$999:%999", "yes")).rejects.toThrow(
				"terminal_session_changed",
			);
			expect(sent).toBe(0);
			await core.input("fixture", status.observedSessionId, "yes");
			expect(sent).toBe(1);
			let output = await core.capture("fixture", 30);
			for (let n = 0; n < 30 && !output.text.includes("DONE:yes"); n++) {
				await delay(25);
				output = await core.capture("fixture", 30);
			}
			expect(output.text).toContain("DONE:yes");
		} finally {
			await tmux(["kill-server"]).catch(() => {});
			rmSync(root, { recursive: true, force: true });
		}
	},
	15000,
);
