import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterExecutionContext } from "flywheel-core";
import { describe, expect, it } from "vitest";
import {
	type BuiltCliArgs,
	defaultExecFile,
	TmuxAdapter,
} from "../src/TmuxAdapter.js";

class SlotProbeAdapter extends TmuxAdapter {
	override readonly type = "slot-probe";
	protected override readonly binaryName = "/bin/sh";

	protected override runPreflight(): void {}

	protected override buildCliArgs(): BuiltCliArgs {
		return { args: ["-c", "sleep 0.2"] };
	}
}

function tmuxUsable(): boolean {
	if (spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0) return false;
	const root = mkdtempSync(join(tmpdir(), "fly1999-tmux-probe-"));
	const session = `runner-fly1999-probe-${randomUUID().slice(0, 8)}`;
	const env = { ...process.env, TMUX_TMPDIR: root };
	delete env.TMUX;
	try {
		return (
			spawnSync("tmux", ["new-session", "-d", "-s", session], {
				env,
				stdio: "ignore",
				timeout: 5000,
			}).status === 0
		);
	} finally {
		spawnSync("tmux", ["kill-server"], { env, stdio: "ignore" });
		rmSync(root, { recursive: true, force: true });
	}
}

const describeReal = tmuxUsable() ? describe : describe.skip;

describeReal("FLY-1999 QA slot tmux routing (real tmux)", () => {
	it("keeps ensure and every subsequent TmuxAdapter call on the TMUX_TMPDIR server", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1999-slot-routing-"));
		const session = `runner-fly1999-${randomUUID().slice(0, 8)}`;
		const uid = typeof process.getuid === "function" ? process.getuid() : 0;
		const socket = join(root, `tmux-${uid}`, "default");
		const prior = {
			TMUX: process.env.TMUX,
			TMUX_TMPDIR: process.env.TMUX_TMPDIR,
			FLYWHEEL_TMUX_SOCKET_OVERRIDE: process.env.FLYWHEEL_TMUX_SOCKET_OVERRIDE,
		};
		let requestedSocket = "";
		let openedSocket = "";
		let canonicalSocket = "";

		try {
			process.env.TMUX_TMPDIR = root;
			delete process.env.TMUX;
			delete process.env.FLYWHEEL_TMUX_SOCKET_OVERRIDE;
			execFileSync("tmux", ["new-session", "-d", "-s", session], {
				timeout: 5000,
			});
			canonicalSocket = realpathSync(socket);

			const adapter = new SlotProbeAdapter(
				session,
				defaultExecFile,
				20,
				5000,
				undefined,
				undefined,
				undefined,
				{
					asyncExecFileFn: async (_cmd, args) => {
						requestedSocket = args[1] ?? "";
						return {
							stdout: JSON.stringify({
								action: "verified",
								reachablePid: process.pid,
							}),
							stderr: "",
						};
					},
					deadlineMs: 1000,
				},
			);
			const context: AdapterExecutionContext = {
				executionId: `fly1999-${randomUUID()}`,
				issueId: "FLY-1999",
				prompt: "",
				cwd: root,
				onTmuxWindowOpened: () => {},
				onTmuxWindowCreated: ({ windowId }) => {
					openedSocket = execFileSync(
						"tmux",
						[
							"display-message",
							"-p",
							"-t",
							`=${session}:${windowId}`,
							"#{socket_path}",
						],
						{ encoding: "utf8", timeout: 5000 },
					).trim();
				},
			};

			await expect(adapter.execute(context)).resolves.toMatchObject({
				success: true,
				timedOut: false,
			});
			expect(requestedSocket).toBe(socket);
			expect(openedSocket).toBe(canonicalSocket);
		} finally {
			try {
				execFileSync("tmux", ["-S", socket, "kill-server"], {
					stdio: "ignore",
					timeout: 5000,
				});
			} catch {}
			for (const [name, value] of Object.entries(prior)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});
});
