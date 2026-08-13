import { describe, expect, it, vi } from "vitest";
import { execTmux, sanitizeTmuxEnv } from "../tmux-exec.js";

describe("sanitizeTmuxEnv", () => {
	it("removes seat-scoped tmux variables while preserving the default-server environment", () => {
		const base = {
			PATH: "/usr/bin:/bin",
			TMUX: "/tmp/private.sock,123,0",
			TMUX_PANE: "%0",
			TMUX_TMPDIR: "/tmp/fly1681-default",
			FLYWHEEL_LEAD_ID: "flywheel-eng-lead",
		};

		expect(sanitizeTmuxEnv(base)).toEqual({
			PATH: "/usr/bin:/bin",
			TMUX_TMPDIR: "/tmp/fly1681-default",
			FLYWHEEL_LEAD_ID: "flywheel-eng-lead",
		});
		expect(base).toHaveProperty("TMUX", "/tmp/private.sock,123,0");
		expect(base).toHaveProperty("TMUX_PANE", "%0");
	});

	it("returns an equal copy when the seat variables are already absent", () => {
		const base = { PATH: "/usr/bin:/bin", HOME: "/tmp/home" };
		const sanitized = sanitizeTmuxEnv(base);

		expect(sanitized).toEqual(base);
		expect(sanitized).not.toBe(base);
	});
});

describe("execTmux", () => {
	it("runs tmux with the requested args and a sanitized child environment", async () => {
		const execFileFn = vi.fn().mockResolvedValue({
			stdout: "@1\n",
			stderr: "",
		});
		const args = ["list-panes", "-t", "runner-flywheel:@1"];

		await expect(
			execTmux(args, {
				timeout: 3210,
				env: {
					PATH: "/usr/bin:/bin",
					TMUX: "/tmp/private.sock,123,0",
					TMUX_PANE: "%7",
					TMUX_TMPDIR: "/tmp/default-root",
				},
				execFileFn,
			}),
		).resolves.toEqual({ stdout: "@1\n", stderr: "" });

		expect(execFileFn).toHaveBeenCalledOnce();
		expect(execFileFn).toHaveBeenCalledWith("tmux", args, {
			encoding: "utf-8",
			timeout: 3210,
			env: {
				PATH: "/usr/bin:/bin",
				TMUX_TMPDIR: "/tmp/default-root",
			},
		});
	});
});
