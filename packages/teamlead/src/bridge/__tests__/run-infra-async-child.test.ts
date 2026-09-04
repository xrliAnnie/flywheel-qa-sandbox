import { describe, expect, it, vi } from "vitest";
import {
	runInfraEvidenceCommand,
	runInfraResumeGitRead,
	runInfraShellCommand,
} from "../run-infra.js";

describe("FLY-2331 run-infra async child funnels", () => {
	it("runs evidence commands asynchronously with the 120 second deadline", async () => {
		let resolveChild!: (value: { stdout: string; stderr: string }) => void;
		const execFile = vi.fn(
			() =>
				new Promise<{ stdout: string; stderr: string }>((resolve) => {
					resolveChild = resolve;
				}),
		);
		let intervalTicks = 0;
		const interval = setInterval(() => intervalTicks++, 1);

		const pending = runInfraEvidenceCommand(
			"git",
			["status", "--porcelain"],
			"/repo",
			execFile,
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(intervalTicks).toBeGreaterThan(0);
		resolveChild({ stdout: "clean\n", stderr: "" });

		await expect(pending).resolves.toEqual({ stdout: "clean\n" });
		expect(execFile).toHaveBeenCalledWith("git", ["status", "--porcelain"], {
			cwd: "/repo",
			timeoutMs: 120_000,
		});
		clearInterval(interval);
	});

	it("keeps the loop live and preserves the shell non-zero result contract", async () => {
		let rejectChild!: (reason: unknown) => void;
		const execFile = vi.fn(
			() =>
				new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
					rejectChild = reject;
				}),
		);
		let intervalTicks = 0;
		const interval = setInterval(() => intervalTicks++, 1);

		const pending = runInfraShellCommand(
			"pnpm",
			["install"],
			"/repo",
			execFile,
		);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(intervalTicks).toBeGreaterThan(0);
		rejectChild(
			Object.assign(new Error("exit 7"), { stdout: "partial\n", status: 7 }),
		);

		await expect(pending).resolves.toEqual({
			stdout: "partial\n",
			exitCode: 7,
		});
		expect(execFile).toHaveBeenCalledWith("pnpm", ["install"], {
			cwd: "/repo",
			timeoutMs: 120_000,
		});
		clearInterval(interval);
	});

	it("bounds restart-resume git reads at 20 seconds and fails safe", async () => {
		const execFile = vi
			.fn()
			.mockResolvedValueOnce({ stdout: "abc\n", stderr: "" })
			.mockRejectedValueOnce(new Error("git unavailable"));

		await expect(
			runInfraResumeGitRead("/repo", ["rev-parse", "HEAD"], execFile),
		).resolves.toBe("abc\n");
		await expect(
			runInfraResumeGitRead("/repo", ["show", "HEAD:file"], execFile),
		).resolves.toBeNull();
		expect(execFile).toHaveBeenNthCalledWith(1, "git", ["rev-parse", "HEAD"], {
			cwd: "/repo",
			timeoutMs: 20_000,
		});
	});
});
