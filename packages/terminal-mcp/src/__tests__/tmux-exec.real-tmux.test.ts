import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execTmux } from "../tmux-exec.js";

const execFileAsync = promisify(execFile);

function defaultServerEnv(root: string): NodeJS.ProcessEnv {
	const env = { ...process.env, TMUX_TMPDIR: root };
	delete env.TMUX;
	delete env.TMUX_PANE;
	return env;
}

// A version check is insufficient in restricted sandboxes: the binary may be
// present while Unix socket creation is denied. Probe a fully isolated default
// server so capability detection never touches the host's real tmux server.
function tmuxUsable(): boolean {
	const root = mkdtempSync(join(tmpdir(), "fly1681-probe-"));
	const env = defaultServerEnv(root);
	const session = `fly1681-probe-${randomUUID().slice(0, 8)}`;
	try {
		if (spawnSync("tmux", ["-V"], { env, stdio: "ignore" }).status !== 0) {
			return false;
		}
		const created = spawnSync(
			"tmux",
			["new-session", "-d", "-s", session, "sleep", "30"],
			{ env, stdio: "ignore", timeout: 5000 },
		);
		if (created.status !== 0) return false;
		return (
			spawnSync("tmux", ["list-panes", "-t", `=${session}`], {
				env,
				stdio: "ignore",
				timeout: 5000,
			}).status === 0
		);
	} finally {
		spawnSync("tmux", ["kill-session", "-t", `=${session}`], {
			env,
			stdio: "ignore",
			timeout: 5000,
		});
		rmSync(root, { recursive: true, force: true });
	}
}

const describeReal = tmuxUsable() ? describe : describe.skip;

async function captureUntil(
	target: string,
	env: NodeJS.ProcessEnv,
	marker: string,
): Promise<string> {
	const deadline = Date.now() + 2000;
	let last = "";
	do {
		const capture = await execTmux(["capture-pane", "-t", target, "-p"], {
			env,
			timeout: 5000,
		});
		last = capture.stdout;
		if (last.includes(marker)) return last;
		await delay(25);
	} while (Date.now() < deadline);
	throw new Error(`tmux marker did not appear before timeout; capture=${last}`);
}

describeReal("execTmux default-server routing (real tmux)", () => {
	let root = "";
	let privateSocket = "";
	let session = "";
	let target = "";
	let baseEnv: NodeJS.ProcessEnv;
	let seatEnv: NodeJS.ProcessEnv;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "fly1681-real-"));
		privateSocket = join(root, "private.sock");
		session = `runner-fly1681-${randomUUID().slice(0, 8)}`;
		baseEnv = defaultServerEnv(root);
		seatEnv = {
			...baseEnv,
			TMUX: `${privateSocket},99999,0`,
			TMUX_PANE: "%0",
		};

		const defaultCreated = spawnSync(
			"tmux",
			[
				"new-session",
				"-d",
				"-s",
				session,
				"sh",
				"-c",
				"printf FLY1681_DEFAULT_SERVER; sleep 60",
			],
			{ env: baseEnv, encoding: "utf8", timeout: 5000 },
		);
		expect(defaultCreated.status, defaultCreated.stderr).toBe(0);
		const listedWindow = spawnSync(
			"tmux",
			["list-windows", "-t", `=${session}`, "-F", "#{window_id}"],
			{ env: baseEnv, encoding: "utf8", timeout: 5000 },
		);
		expect(listedWindow.status, listedWindow.stderr).toBe(0);
		target = `${session}:${listedWindow.stdout.trim()}`;

		const privateCreated = spawnSync(
			"tmux",
			[
				"-S",
				privateSocket,
				"new-session",
				"-d",
				"-s",
				"lead-seat",
				"sleep",
				"60",
			],
			{ env: baseEnv, encoding: "utf8", timeout: 5000 },
		);
		expect(privateCreated.status, privateCreated.stderr).toBe(0);
	});

	afterAll(() => {
		if (baseEnv) {
			spawnSync("tmux", ["kill-session", "-t", `=${session}`], {
				env: baseEnv,
				stdio: "ignore",
				timeout: 5000,
			});
			if (privateSocket) {
				spawnSync(
					"tmux",
					["-S", privateSocket, "kill-session", "-t", "=lead-seat"],
					{
						env: baseEnv,
						stdio: "ignore",
						timeout: 5000,
					},
				);
			}
		}
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("reproduces inherited-TMUX false negatives, then finds only the live default-server target", async () => {
		// Positive control for the reproducer: the unwrapped client inherits the
		// private seat socket and therefore cannot see the default-server session.
		await expect(
			execFileAsync("tmux", ["list-panes", "-t", target], {
				env: seatEnv,
				timeout: 5000,
			}),
		).rejects.toThrow();

		// The production boundary strips only the seat variables. TMUX_TMPDIR stays
		// intact, so tmux resolves this suite's isolated default socket.
		await expect(
			execTmux(["list-panes", "-t", target], {
				env: seatEnv,
				timeout: 5000,
			}),
		).resolves.toMatchObject({ stdout: expect.any(String) });

		await expect(
			captureUntil(target, seatEnv, "FLY1681_DEFAULT_SERVER"),
		).resolves.toContain("FLY1681_DEFAULT_SERVER");

		const killed = spawnSync("tmux", ["kill-session", "-t", `=${session}`], {
			env: baseEnv,
			encoding: "utf8",
			timeout: 5000,
		});
		expect(killed.status, killed.stderr).toBe(0);

		await expect(
			execTmux(["list-panes", "-t", target], {
				env: seatEnv,
				timeout: 5000,
			}),
		).rejects.toThrow();
	});
});
