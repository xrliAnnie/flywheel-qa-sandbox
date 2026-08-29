import { describe, expect, it } from "vitest";
import { AbortError, NodeProcessRunner, TimeoutError } from "../process.js";

const NODE = process.execPath;
const runner = new NodeProcessRunner();

describe("NodeProcessRunner.run (real subprocess)", () => {
	it("captures stdout and exit code", async () => {
		const r = await runner.run(NODE, [
			"-e",
			"process.stdout.write('hello world')",
		]);
		expect(r.stdout.toString()).toBe("hello world");
		expect(r.code).toBe(0);
	});

	it("pipes stdin to the child (argv-hygiene path)", async () => {
		const r = await runner.run(
			NODE,
			[
				"-e",
				"let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))",
			],
			{ stdin: "SECRET_VIA_STDIN" },
		);
		expect(r.stdout.toString()).toBe("SECRET_VIA_STDIN");
	});

	it("reports a non-zero exit code", async () => {
		const r = await runner.run(NODE, ["-e", "process.exit(7)"]);
		expect(r.code).toBe(7);
	});

	it("kills on timeout and rejects with TimeoutError", async () => {
		const err = await runner
			.run(NODE, ["-e", "setTimeout(()=>{}, 10000)"], { timeoutMs: 100 })
			.catch((e) => e);
		expect(err).toBeInstanceOf(TimeoutError);
	});

	it("kills on abort and rejects with AbortError", async () => {
		const ctrl = new AbortController();
		const p = runner.run(NODE, ["-e", "setTimeout(()=>{}, 10000)"], {
			signal: ctrl.signal,
		});
		setTimeout(() => ctrl.abort(), 20);
		const err = await p.catch((e) => e);
		expect(err).toBeInstanceOf(AbortError);
	});
});

describe("NodeProcessRunner.spawn (real subprocess)", () => {
	it("streams stdout and reports exit; kill terminates the child", async () => {
		const handle = runner.spawn(NODE, [
			"-e",
			"process.stdout.write('chunk');setInterval(()=>{},1000)",
		]);
		const out: string[] = [];
		handle.onStdout((c) => out.push(c.toString()));
		const exit = new Promise<{
			code: number | null;
			sig: NodeJS.Signals | null;
		}>((res) => handle.onExit((code, sig) => res({ code, sig })));
		// node cold-start on a loaded machine is ~150ms; wait generously for output.
		await new Promise((r) => setTimeout(r, 800));
		expect(out.join("")).toContain("chunk");
		handle.kill("SIGTERM");
		const { code, sig } = await exit;
		expect(code === null || sig === "SIGTERM").toBe(true);
	});
});
