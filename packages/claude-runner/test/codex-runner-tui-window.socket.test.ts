import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn,
}));

import { ensureRunnerTuiWindow } from "../src/codex-runner-tui-window.js";

afterEach(() => {
	vi.unstubAllEnvs();
	spawn.mockReset();
});

it.each(["slot", "override", "production"] as const)(
	"selects the confined session socket: %s",
	async (mode) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "fly2454-socket-")));
		const creates: string[] = [];
		vi.stubEnv("TMUX_TMPDIR", mode === "production" ? undefined : root);
		vi.stubEnv(
			"FLYWHEEL_TMUX_SOCKET_OVERRIDE",
			mode === "override" ? join(root, "override.sock") : undefined,
		);
		spawn.mockImplementation((_cmd: string, args: string[]) => {
			// Model the rescue helper's actual --create command without allowing a
			// regression to write to the host's production tmux server.
			const create = args.indexOf("--create");
			expect(create).toBeGreaterThan(0);
			expect(args.slice(create + 1, create + 3)).toEqual(["tmux", "-S"]);
			expect(args[create + 4]).toBe("new-session");
			creates.push(args[create + 3]);
			const child = new EventEmitter();
			Object.assign(child, { stdout: new PassThrough(), pid: undefined });
			queueMicrotask(() => child.emit("close", 0, null));
			return child;
		});
		try {
			await ensureRunnerTuiWindow(
				{
					tmuxSession: "runner-test-fly2454-fresh",
					windowName: "FLY-2454",
					codexHome: root,
					socketPath: join(root, "app.sock"),
					cwd: root,
					threadId: "thread-2454",
					executionId: "exec-2454",
				},
				{
					// Keep the default ensure-session implementation; only unrelated
					// window probes are substituted. A sync exec would bypass it.
					execAsync: async () => ({ ok: true }),
					execOutAsync: async () => undefined,
					sleepAsync: async () => {},
				},
			);
			expect(creates.length).toBeGreaterThan(0);
			const productionSocket = join(
				realpathSync("/tmp"),
				`tmux-${process.getuid?.()}`,
				"default",
			);
			if (mode !== "production")
				expect(creates).not.toContain(productionSocket);
			const expected =
				mode === "override"
					? join(root, "override.sock")
					: mode === "production"
						? productionSocket
						: join(root, `tmux-${process.getuid?.()}`, "default");
			expect(new Set(creates)).toEqual(new Set([expected]));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
