import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAsyncExecFile } from "../src/index.js";

const scratch: string[] = [];

afterEach(() => {
	for (const path of scratch.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

describe("defaultAsyncExecFile", () => {
	it("honors cwd and replaces rather than merges the parent environment", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "flywheel-async-exec-"));
		scratch.push(cwd);
		process.env.FLYWHEEL_ASYNC_EXEC_PARENT_SECRET = "must-not-leak";
		try {
			const result = await defaultAsyncExecFile(
				process.execPath,
				[
					"-e",
					"process.stdout.write(JSON.stringify({cwd:process.cwd(),only:process.env.ONLY,parent:process.env.FLYWHEEL_ASYNC_EXEC_PARENT_SECRET,home:process.env.HOME}))",
				],
				{
					cwd,
					env: { ONLY: "visible" },
					envMode: "replace",
					timeoutMs: 2_000,
				},
			);

			expect(JSON.parse(result.stdout)).toEqual({
				cwd: realpathSync(cwd),
				only: "visible",
			});
		} finally {
			delete process.env.FLYWHEEL_ASYNC_EXEC_PARENT_SECRET;
		}
	});

	it("writes the provided input and closes stdin", async () => {
		const result = await defaultAsyncExecFile(
			process.execPath,
			[
				"-e",
				"let body='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>body+=c);process.stdin.on('end',()=>process.stdout.write(body.toUpperCase()))",
			],
			{ input: "bridge child\n", timeoutMs: 500 },
		);

		expect(result.stdout).toBe("BRIDGE CHILD\n");
	});

	it("fails within a bounded drain window when a grandchild holds stdio", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "flywheel-async-exec-group-"));
		const pidFile = join(cwd, "grandchild.pid");
		const readyFile = join(cwd, "parent-ready-at");
		const holdMs = 5_000;
		scratch.push(cwd);
		const grandchildProgram =
			"const fs=require('node:fs');fs.writeFileSync(process.env.PID_FILE,String(process.pid));process.send?.('ready');setTimeout(()=>{},Number(process.env.HOLD_MS))";
		const parentProgram = `const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(
			grandchildProgram,
		)}],{stdio:['ignore',1,2,'ipc'],env:process.env});child.once('message',()=>{fs.writeFileSync(process.env.READY_FILE,String(Date.now()));child.disconnect();child.unref();process.exit(0)});child.once('error',()=>process.exit(2));`;
		const originalKill = process.kill;
		const negativeGroupKills: number[] = [];
		const killSpy = vi
			.spyOn(process, "kill")
			.mockImplementation((pid, signal) => {
				if (pid < 0) negativeGroupKills.push(pid);
				return originalKill(pid, signal);
			});
		let grandchildPid = 0;
		const run = defaultAsyncExecFile(process.execPath, ["-e", parentProgram], {
			env: {
				HOLD_MS: String(holdMs),
				PID_FILE: pidFile,
				READY_FILE: readyFile,
			},
			timeoutMs: holdMs * 2,
		});

		try {
			await expect(run).rejects.toMatchObject({
				code: "ERR_CHILD_STDIO_DRAIN_TIMEOUT",
			});
			grandchildPid = Number(readFileSync(pidFile, "utf8"));
			const readyAt = Number(readFileSync(readyFile, "utf8"));
			expect(Date.now() - readyAt).toBeLessThan(holdMs / 2);
			expect(negativeGroupKills).toEqual([]);
		} finally {
			killSpy.mockRestore();
			if (grandchildPid > 0) {
				try {
					process.kill(grandchildPid, "SIGKILL");
				} catch {
					// The pre-fix implementation may already have killed the group.
				}
			}
		}
		await vi.waitFor(
			() => {
				expect(() => process.kill(grandchildPid, 0)).toThrow();
			},
			{ timeout: 1_000, interval: 20 },
		);
	});

	it("hard-times out with captured output without blocking the event loop", async () => {
		const timeoutMs = 2_000;
		let ticks = 0;
		const interval = setInterval(() => {
			ticks += 1;
		}, 25);
		const startedAt = Date.now();
		try {
			await expect(
				defaultAsyncExecFile(
					process.execPath,
					["-e", "process.stdout.write('started');setInterval(()=>{},1000)"],
					{ timeoutMs },
				),
			).rejects.toMatchObject({
				code: "ETIMEDOUT",
				killed: true,
				signal: "SIGKILL",
				timedOut: true,
				stdout: "started",
			});
		} finally {
			clearInterval(interval);
		}
		const elapsedMs = Date.now() - startedAt;
		expect(elapsedMs).toBeGreaterThanOrEqual(timeoutMs * 0.8);
		expect(elapsedMs).toBeLessThan(timeoutMs * 2);
		expect(ticks).toBeGreaterThan(0);
	}, 10_000);

	it("preserves stdout, stderr, exit code, and signal fields on non-zero exit", async () => {
		await expect(
			defaultAsyncExecFile(
				process.execPath,
				[
					"-e",
					"process.stdout.write('out');process.stderr.write('err');process.exit(7)",
				],
				{ timeoutMs: 2_000 },
			),
		).rejects.toMatchObject({
			code: 7,
			message: expect.stringContaining("\nerr"),
			status: 7,
			killed: false,
			timedOut: false,
			stdout: "out",
			stderr: "err",
			signal: null,
		});
	});

	it("preserves ENOENT while enriching spawn failures", async () => {
		await expect(
			defaultAsyncExecFile("flywheel-command-that-does-not-exist", [], {
				timeoutMs: 2_000,
			}),
		).rejects.toMatchObject({
			code: "ENOENT",
			killed: false,
			timedOut: false,
			stdout: "",
			stderr: "",
		});
	});

	it("kills the process group when either output stream exceeds maxBuffer", async () => {
		await expect(
			defaultAsyncExecFile(
				process.execPath,
				["-e", "process.stderr.write('0123456789');setInterval(()=>{},1000)"],
				{ maxBuffer: 4, timeoutMs: 2_000 },
			),
		).rejects.toMatchObject({
			code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
			killed: true,
			timedOut: false,
			stderr: "0123456789",
		});
	});
});
