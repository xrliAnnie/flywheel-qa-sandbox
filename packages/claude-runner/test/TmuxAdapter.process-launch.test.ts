import { execFile } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityTmuxAdapter } from "../src/AntigravityTmuxAdapter.js";
import type {
	ExecutionProcessLaunchManifest,
	TmuxProcessLaunchDeps,
	TmuxProcessLaunchLease,
} from "../src/execution-process-launch.js";
import { KimiTmuxAdapter } from "../src/KimiTmuxAdapter.js";
import {
	buildAmbientSafeWindowCommand,
	TmuxAdapter,
} from "../src/TmuxAdapter.js";

class TestKimi extends KimiTmuxAdapter {
	protected override runPreflight() {}
}
class TestAntigravity extends AntigravityTmuxAdapter {
	protected override runPreflight() {}
}
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function harness(
	kind = "claude-tmux",
	overrides: Partial<TmuxProcessLaunchLease> = {},
) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "fly2919-a5-adapter-")));
	dirs.push(dir);
	const calls: string[][] = [];
	let killed = false;
	const exec = (_cmd: string, args: string[]) => {
		calls.push(args);
		if (args[0] === "new-window")
			return { stdout: "@42|/tmp/test/default|123|17" };
		if (args[0] === "kill-window") {
			killed = true;
			return { stdout: "" };
		}
		if (args[0] === "display-message") {
			if (killed) throw new Error("gone");
			return { stdout: "@42" };
		}
		if (args[0] === "list-panes") return { stdout: killed ? "" : "1" };
		return { stdout: "" };
	};
	const lease: TmuxProcessLaunchLease = {
		generation: 1,
		ownerToken: "owner-1",
		nonce: "nonce-1",
		prepareSpawn: vi.fn(async () => {}),
		authorizeSpawn: vi.fn(() => true),
		acceptSpawn: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
		finish: vi.fn(async () => {}),
		...overrides,
	};
	let observed: ExecutionProcessLaunchManifest | undefined;
	const deps: TmuxProcessLaunchDeps = {
		createLaunch: vi.fn(async () => lease),
		manifestDirectory: () => dir,
		waitForCandidate: async (m) => {
			observed = m;
			const cmd = calls.find((a) => a[0] === "new-window")!;
			const shell = cmd.indexOf("sh");
			expect(existsSync(cmd[shell + 3]!)).toBe(false);
			return {
				...m.request,
				pid: 42,
				pgid: 42,
				startIdentity: "start-1",
				hostBootId: "boot-1",
				shellExecutable: "/bin/sh",
			};
		},
	};
	const adapter =
		kind === "claude-tmux"
			? new TmuxAdapter(
					"tests",
					exec,
					1,
					1000,
					undefined,
					undefined,
					undefined,
					undefined,
					deps,
				)
			: kind === "kimi-tmux"
				? new TestKimi("tests", exec, 1, 1000, undefined, deps)
				: new TestAntigravity("tests", exec, 1, 1000, undefined, deps);
	const heartbeat = vi.fn(),
		opened = vi.fn();
	const ctx = {
		executionId: "exec-1",
		issueId: "FLY-2919",
		cwd: dir,
		prompt: "task",
		onTmuxWindowOpened: vi.fn(),
		onTmuxWindowCreated: opened,
		onHeartbeat: heartbeat,
	};
	return {
		adapter,
		ctx,
		lease,
		deps,
		calls,
		heartbeat,
		opened,
		observed: () => observed,
		killed: () => killed,
	};
}
describe("FLY-2919 tmux launch admission", () => {
	it.each([true, false])(
		"standby confirmation needs a current body proof after owner drain (current=%s)",
		async (current) => {
			const onRetired = vi.fn();
			let drained = false;
			const body = { verdict: "dead" } as never;
			const h = harness("claude-tmux", {
				observeBody: async () => body,
				isCurrentBody: () => !drained || current,
				classifyBodyExit: async () => "completed",
				finish: vi.fn(async () => {
					expect(onRetired).not.toHaveBeenCalled();
					drained = true;
				}),
			});
			await h.adapter.execute({
				...h.ctx,
				processLifecycle: {
					mode: "initial",
					generation: 1,
					retirementApproved: () => true,
					onRetired,
				},
			});
			expect(onRetired).toHaveBeenCalledTimes(current ? 1 : 0);
		},
	);

	it("never confirms standby from missing windows before writer drain succeeds", async () => {
		const onRetired = vi.fn();
		const h = harness("claude-tmux", {
			finish: vi.fn(async () => {
				throw new Error("writers remain");
			}),
		});
		await expect(
			h.adapter.execute({
				...h.ctx,
				processLifecycle: {
					mode: "initial",
					generation: 1,
					retirementApproved: () => true,
					onRetired,
				},
			}),
		).rejects.toThrow("process_launch_cleanup_unconfirmed");
		expect(onRetired).not.toHaveBeenCalled();
	});

	it.each(["claude-tmux", "kimi-tmux", "antigravity-tmux"])(
		"awaits trusted native acceptance for %s before startup callbacks",
		async (kind) => {
			let accepted!: () => void;
			const h = harness(kind, {
				acceptSpawn: vi.fn(
					async () =>
						new Promise<void>((r) => {
							accepted = r;
						}),
				),
			});
			const execution = h.adapter.execute(h.ctx);
			await vi.waitFor(() =>
				expect(h.lease.acceptSpawn).toHaveBeenCalledOnce(),
			);
			expect(h.heartbeat).not.toHaveBeenCalled();
			expect(h.opened).not.toHaveBeenCalled();
			expect(h.observed()?.request.adapter).toBe(kind);
			expect(h.observed()?.request.nativeSessionId === null).toBe(
				kind !== "claude-tmux",
			);
			const command = h.calls.find((a) => a[0] === "new-window")!;
			expect(command).toContain("FLYWHEEL_EXECUTION_NONCE=nonce-1");
			expect(command.join(" ")).not.toContain("pane_pid");
			accepted();
			await execution;
			expect(h.heartbeat).toHaveBeenCalled();
			expect(h.opened).toHaveBeenCalledOnce();
			expect(h.lease.close).toHaveBeenCalledOnce();
			expect(h.lease.finish).toHaveBeenCalledOnce();
		},
	);
	it("pins the verified command path and interpreter PATH into the actual pane launch", async () => {
		const h = harness("kimi-tmux", {
			launchPath: "/tools/kimi",
			launchEnvPath: "/tools:/bin",
		} as Partial<TmuxProcessLaunchLease>);
		await h.adapter.execute(h.ctx);
		expect(h.observed()?.request.binaryName).toBe("/tools/kimi");
		const command = h.calls.find((a) => a[0] === "new-window")!;
		expect(command).toContain("/tools/kimi");
		expect(command).toContain("PATH=/tools:/bin");
	});
	it("closes and cleans up when native acceptance fails", async () => {
		const h = harness("claude-tmux", {
			acceptSpawn: vi.fn(async () => {
				throw new Error("native mismatch");
			}),
		});
		await expect(h.adapter.execute(h.ctx)).rejects.toThrow("native mismatch");
		expect(h.killed()).toBe(true);
		expect(h.opened).not.toHaveBeenCalled();
		expect(h.lease.finish).toHaveBeenCalledOnce();
	});
	it("revoked permission before commit never accepts a worker", async () => {
		const h = harness("kimi-tmux", { authorizeSpawn: () => false });
		await expect(h.adapter.execute(h.ctx)).rejects.toThrow();
		expect(h.lease.acceptSpawn).not.toHaveBeenCalled();
		expect(h.opened).not.toHaveBeenCalled();
		expect(h.lease.finish).toHaveBeenCalledOnce();
	});
	it("drains cancellation racing awaited acceptance without reporting startup success", async () => {
		const signal = new AbortController();
		let release!: () => void;
		const h = harness("claude-tmux", {
			signal: signal.signal,
			acceptSpawn: vi.fn(
				async () =>
					new Promise<void>((r) => {
						release = r;
					}),
			),
		});
		const execution = h.adapter.execute(h.ctx);
		await vi.waitFor(() => expect(h.lease.acceptSpawn).toHaveBeenCalledOnce());
		signal.abort();
		await vi.waitFor(() => expect(h.lease.close).toHaveBeenCalledOnce());
		release();
		await expect(execution).rejects.toThrow();
		expect(h.killed()).toBe(true);
		expect(h.opened).not.toHaveBeenCalled();
		expect(h.lease.finish).toHaveBeenCalledOnce();
	});
	it("refuses a candidate in the tmux server process group", async () => {
		const h = harness();
		h.deps.waitForCandidate = async (m) => ({
			...m.request,
			pid: 17,
			pgid: 17,
			startIdentity: "start",
			hostBootId: "boot",
			shellExecutable: "/bin/sh",
		});
		await expect(h.adapter.execute(h.ctx)).rejects.toThrow();
		expect(h.lease.acceptSpawn).not.toHaveBeenCalled();
	});
	it("delays fresh identity publication until native acceptance and canonicalizes symlink cwd", async () => {
		let release!: () => void;
		const h = harness("claude-tmux", {
			acceptSpawn: vi.fn(
				async () =>
					new Promise<void>((r) => {
						release = r;
					}),
			),
		});
		const persist = vi
			.spyOn(
				h.adapter as unknown as {
					persistClaudeSessionState: () => Promise<void>;
				},
				"persistClaudeSessionState",
			)
			.mockResolvedValue();
		const identity = vi.fn();
		const link = join(h.ctx.cwd, "alias");
		symlinkSync(h.ctx.cwd, link);
		const execution = h.adapter.execute({
			...h.ctx,
			cwd: link,
			processLifecycle: {
				mode: "initial",
				generation: 1,
				onIdentityVerified: identity,
			},
		});
		await vi.waitFor(() => expect(h.lease.acceptSpawn).toHaveBeenCalledOnce());
		expect(h.observed()?.request.cwd).toBe(h.ctx.cwd);
		expect(identity).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
		release();
		await execution;
		expect(identity).toHaveBeenCalledOnce();
		expect(persist).toHaveBeenCalledOnce();
	});
	it("does not turn an unconfirmed finish into a successful result", async () => {
		const h = harness("kimi-tmux", {
			finish: vi.fn(async () => {
				throw new Error("unknown");
			}),
		});
		await expect(h.adapter.execute(h.ctx)).rejects.toThrow(
			"process_launch_cleanup_unconfirmed",
		);
		expect(h.lease.close).toHaveBeenCalledOnce();
	});
	it("fails factory acquisition before any native launch", async () => {
		const h = harness();
		h.deps.createLaunch = async () => {
			throw new Error("owner unavailable");
		};
		await expect(h.adapter.execute(h.ctx)).rejects.toThrow("owner unavailable");
		expect(h.calls.some((a) => a[0] === "new-window")).toBe(false);
	});
	it("passes the exact exec arguments to registration as data before native launch", async () => {
		const directory = mkdtempSync(join(tmpdir(), "fly2919-a8-shell-"));
		dirs.push(directory);
		const gate = join(directory, "gate"),
			helper = join(directory, "helper.cjs"),
			receipt = join(directory, "receipt");
		writeFileSync(gate, "token");
		writeFileSync(
			helper,
			'require("node:fs").writeFileSync(process.argv[3], JSON.stringify({pid: process.argv[4], args: process.argv.slice(5)}));',
		);
		const args = [
			"-e",
			"process.stdout.write(String(process.pid))",
			"--",
			"space and $(literal)",
		];
		const command = buildAmbientSafeWindowCommand({
			binaryName: process.execPath,
			binaryArgs: args,
			gateFile: gate,
			launchToken: "token",
			processRegistration: {
				nodePath: process.execPath,
				helperPath: helper,
				requestPath: receipt,
			},
		});
		const { stdout } = await promisify(execFile)("/bin/sh", command.slice(1), {
			timeout: 3000,
		});
		const actual = JSON.parse(readFileSync(receipt, "utf8"));
		expect(actual.args).toEqual([process.execPath, ...args]);
		expect(Number(actual.pid)).toBeGreaterThan(1);
		expect(stdout).toBe(actual.pid);
	});
	it("puts pre-exec registration before the commit wait and passes the shell PID", () => {
		const command = buildAmbientSafeWindowCommand({
			binaryName: "claude",
			binaryArgs: [],
			gateFile: "/gate",
			launchToken: "token",
			processRegistration: {
				nodePath: "/node",
				helperPath: "/helper.js",
				requestPath: "/request",
			},
		});
		const script = command[2]!;
		expect(script).toContain('"$$"');
		expect(script.slice(0, script.indexOf("register"))).toContain("env -i");
		expect(script.indexOf("register")).toBeLessThan(script.indexOf("while"));
		expect(command).toContain("/request");
	});
});
