import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ensureRunnerTuiWindow,
	type RunnerTuiWindowDeps,
	type RunnerTuiWindowSpec,
} from "../src/codex-runner-tui-window.js";

const describeReal =
	spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0
		? describe
		: describe.skip;

function realTmuxHarness() {
	const root = mkdtempSync(join(tmpdir(), "fly2170-tmux-"));
	const socket = join(root, "s");
	const codexBin = join(root, "codex-test-bin");
	writeFileSync(codexBin, "#!/bin/sh\nexec /bin/sleep 600\n", {
		mode: 0o755,
	});
	const run = (args: string[]) =>
		spawnSync("tmux", ["-S", socket, ...args], {
			encoding: "utf8",
			timeout: 5_000,
		});
	const exec: NonNullable<RunnerTuiWindowDeps["execAsync"]> = async (
		cmd,
		args,
	) => {
		if (cmd !== "tmux") return { ok: false };
		const result = run(args);
		return {
			ok: result.status === 0,
			...(result.status === 0 ? { stdout: result.stdout.trim() } : {}),
		};
	};
	const execOut: NonNullable<RunnerTuiWindowDeps["execOutAsync"]> = async (
		cmd,
		args,
	) => {
		if (cmd !== "tmux") return undefined;
		const result = run(args);
		return result.status === 0 ? result.stdout.trim() : undefined;
	};
	const ensureSession: NonNullable<
		RunnerTuiWindowDeps["ensureSessionAsync"]
	> = async (session) => {
		if (run(["has-session", "-t", `=${session}`]).status === 0) return true;
		return run(["new-session", "-d", "-s", session]).status === 0;
	};
	const dispose = () => {
		spawnSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
		rmSync(root, { recursive: true, force: true });
	};
	return { root, socket, codexBin, run, exec, execOut, ensureSession, dispose };
}

function createWindow(
	harness: ReturnType<typeof realTmuxHarness>,
	session: string,
	name: string,
	executionId: string,
): string {
	const created = harness.run([
		"new-window",
		"-d",
		"-t",
		`=${session}`,
		"-P",
		"-F",
		"#{window_id}",
		"-n",
		name,
		"sleep 600",
	]);
	expect(created.status).toBe(0);
	const windowId = created.stdout.trim();
	expect(windowId).toMatch(/^@[0-9]+$/);
	expect(
		harness.run([
			"set-option",
			"-w",
			"-t",
			`=${session}:${windowId}`,
			"@flywheel_exec_id",
			executionId,
		]).status,
	).toBe(0);
	return windowId;
}

function markedWindows(
	harness: ReturnType<typeof realTmuxHarness>,
	executionId: string,
): Array<{ id: string; name: string }> {
	const result = harness.run([
		"list-windows",
		"-a",
		"-F",
		"#{window_id}|#{window_name}|#{@flywheel_exec_id}",
	]);
	expect(result.status).toBe(0);
	const unique = new Map<string, string>();
	for (const line of result.stdout.trim().split("\n")) {
		const [id, name, marker] = line.split("|");
		if (id && name && marker === executionId) unique.set(id, name);
	}
	return [...unique].map(([id, name]) => ({ id, name }));
}

function realSpec(
	harness: ReturnType<typeof realTmuxHarness>,
	session: string,
	windowName: string,
	executionId: string,
): RunnerTuiWindowSpec {
	return {
		tmuxSession: session,
		windowName,
		codexHome: harness.root,
		socketPath: join(harness.root, "app.sock"),
		cwd: harness.root,
		threadId: randomUUID(),
		executionId,
		codexBin: harness.codexBin,
	};
}

describeReal("FLY-2170 Codex TUI identity (real tmux)", () => {
	it("does not retarget marker publication when the new window dies after the settle probe", async () => {
		const harness = realTmuxHarness();
		try {
			const suffix = randomUUID().slice(0, 8);
			const session = `fly2170-retarget-${suffix}`;
			const executionId = `exec-${randomUUID()}`;
			const victimExecutionId = `victim-${randomUUID()}`;
			const windowName = `FLY-2170-retarget-${suffix}`;
			expect(harness.run(["new-session", "-d", "-s", session]).status).toBe(0);
			const victimWindowId = harness
				.run(["list-windows", "-t", `=${session}`, "-F", "#{window_id}"])
				.stdout.trim();
			expect(victimWindowId).toMatch(/^@[0-9]+$/);
			expect(
				harness.run([
					"set-option",
					"-w",
					"-t",
					victimWindowId,
					"@flywheel_exec_id",
					victimExecutionId,
				]).status,
			).toBe(0);

			let createdWindowId: string | undefined;
			const faultExec: NonNullable<RunnerTuiWindowDeps["execAsync"]> = async (
				cmd,
				args,
				options,
			) => {
				const result = await harness.exec(cmd, args, options);
				if (result.ok && args[0] === "new-window") {
					createdWindowId = result.stdout;
				}
				return result;
			};
			const faultExecOut: NonNullable<
				RunnerTuiWindowDeps["execOutAsync"]
			> = async (cmd, args, options) => {
				const result = await harness.execOut(cmd, args, options);
				if (
					createdWindowId &&
					args[0] === "display-message" &&
					args.at(-1) === "#{window_id} #{window_name} #{pane_dead}"
				) {
					expect(
						harness.run(["kill-window", "-t", createdWindowId]).status,
					).toBe(0);
				}
				return result;
			};

			await expect(
				ensureRunnerTuiWindow(
					realSpec(harness, session, windowName, executionId),
					{
						execAsync: faultExec,
						execOutAsync: faultExecOut,
						ensureSessionAsync: harness.ensureSession,
						sleepAsync: async () => {},
					},
				),
			).resolves.toEqual({
				created: false,
				category: "retryable-transient-ipc",
				reason: "marker_unproven",
			});
			expect(
				harness
					.run([
						"display-message",
						"-p",
						"-t",
						victimWindowId,
						"#{@flywheel_exec_id}",
					])
					.stdout.trim(),
			).toBe(victimExecutionId);
			expect(
				harness.run(["list-windows", "-t", `=${session}`, "-F", "#{window_id}"])
					.stdout,
			).not.toContain(createdWindowId);
		} finally {
			harness.dispose();
		}
	});

	it("converges differing labels and a cross-session residue to one birth-label window", async () => {
		const harness = realTmuxHarness();
		try {
			const suffix = randomUUID().slice(0, 8);
			const base = `fly2170-${suffix}`;
			const other = `fly2170-other-${suffix}`;
			const executionId = `exec-${randomUUID()}`;
			const birthLabel = `FLY-2170-implement-${suffix}`;
			expect(harness.run(["new-session", "-d", "-s", base]).status).toBe(0);
			expect(harness.run(["new-session", "-d", "-s", other]).status).toBe(0);
			createWindow(harness, base, birthLabel, executionId);
			createWindow(harness, base, `guessed-${suffix}`, executionId);
			createWindow(harness, other, `cross-${suffix}`, executionId);

			// Mutation control: the former name-only behavior permits all three ids.
			expect(markedWindows(harness, executionId)).toHaveLength(3);

			const outcome = await ensureRunnerTuiWindow(
				realSpec(harness, base, birthLabel, executionId),
				{
					execAsync: harness.exec,
					execOutAsync: harness.execOut,
					ensureSessionAsync: harness.ensureSession,
					sleepAsync: async () => {},
				},
			);

			expect(outcome).toMatchObject({ created: true });
			expect(markedWindows(harness, executionId)).toEqual([
				{ id: outcome.created ? outcome.windowId : "", name: birthLabel },
			]);
		} finally {
			harness.dispose();
		}
	});

	it("rolls back a real marker mismatch, verifies absence, then succeeds on retry", async () => {
		const harness = realTmuxHarness();
		try {
			const logs: string[] = [];
			const suffix = randomUUID().slice(0, 8);
			const session = `fly2170-fault-${suffix}`;
			const executionId = `exec-${randomUUID()}`;
			const windowName = `FLY-2170-fault-${suffix}`;
			expect(harness.run(["new-session", "-d", "-s", session]).status).toBe(0);
			const spec = realSpec(harness, session, windowName, executionId);
			const faultExec: NonNullable<RunnerTuiWindowDeps["execAsync"]> = async (
				cmd,
				args,
				options,
			) => {
				const result = await harness.exec(cmd, args, options);
				if (
					result.ok &&
					args[0] === "set-option" &&
					args.at(-1) === executionId
				) {
					const corrupted = harness.run([...args.slice(0, -1), "wrong-exec"]);
					expect(corrupted.status).toBe(0);
				}
				return result;
			};

			await expect(
				ensureRunnerTuiWindow(spec, {
					execAsync: faultExec,
					execOutAsync: harness.execOut,
					ensureSessionAsync: harness.ensureSession,
					sleepAsync: async () => {},
					log: (message) => logs.push(message),
				}),
			).resolves.toEqual({
				created: false,
				category: "retryable-transient-ipc",
				reason: "marker_unproven",
			});
			expect(markedWindows(harness, executionId)).toEqual([]);
			expect(logs.some((message) => message.includes("marker rollback"))).toBe(
				false,
			);
			expect(
				harness.run([
					"list-windows",
					"-t",
					`=${session}`,
					"-F",
					"#{window_name}",
				]).stdout,
			).not.toContain(windowName);

			await expect(
				ensureRunnerTuiWindow(spec, {
					execAsync: harness.exec,
					execOutAsync: harness.execOut,
					ensureSessionAsync: harness.ensureSession,
					sleepAsync: async () => {},
				}),
			).resolves.toMatchObject({ created: true });
			expect(markedWindows(harness, executionId)).toHaveLength(1);
		} finally {
			harness.dispose();
		}
	});
});
