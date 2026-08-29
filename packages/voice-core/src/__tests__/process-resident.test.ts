/**
 * FLY-1160 §3.1b — ProcessHandle additive extension for the RESIDENT shape.
 *
 * one-shot run()/spawn() semantics are frozen (process.test.ts is the
 * sentinel); a resident child additionally needs:
 *   - onError: spawn ENOENT / stdin EPIPE surface as events, never uncaught
 *   - write → backpressure boolean + onDrain
 *   - closeStdin (EOF = the clean resident shutdown path, spike-verified)
 *   - awaitExit(timeoutMs): bounded exit observation (dispose EOF→TERM→KILL)
 */
import { describe, expect, it } from "vitest";
import { NodeProcessRunner } from "../process.js";

const NODE = process.execPath;
const runner = new NodeProcessRunner();

describe("ProcessHandle resident extensions (real subprocess)", () => {
	it("onError fires on spawn ENOENT instead of throwing uncaught", async () => {
		const handle = runner.spawn("/no/such/binary-fly1160", []);
		const err = await new Promise<Error>((res) => handle.onError(res));
		expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
	});

	it("write returns a backpressure boolean and onDrain fires when the child catches up", async () => {
		// child ignores stdin for 200ms then consumes everything — forces the
		// Writable buffer to fill (write→false), then drain.
		const handle = runner.spawn(NODE, [
			"-e",
			"setTimeout(()=>{process.stdin.resume()},200);setTimeout(()=>{},5000)",
		]);
		const drained = new Promise<void>((res) => handle.onDrain(() => res()));
		const chunk = Buffer.alloc(256 * 1024, 0x61);
		let sawFalse = false;
		for (let i = 0; i < 64 && !sawFalse; i++) {
			sawFalse = handle.write(chunk) === false;
		}
		expect(sawFalse).toBe(true);
		await drained;
		handle.kill("SIGKILL");
		await handle.awaitExit();
	});

	it("closeStdin() delivers EOF (resident clean-exit path)", async () => {
		const handle = runner.spawn(NODE, [
			"-e",
			"process.stdin.resume();process.stdin.on('end',()=>process.exit(0))",
		]);
		handle.closeStdin();
		const exit = await handle.awaitExit(5000);
		expect(exit).not.toBeNull();
		expect(exit?.code).toBe(0);
	});

	it("awaitExit(timeoutMs) returns null while the child is still alive, and resolves immediately once exited", async () => {
		const handle = runner.spawn(NODE, ["-e", "setInterval(()=>{},1000)"]);
		expect(await handle.awaitExit(50)).toBeNull();
		handle.kill("SIGKILL");
		const exit = await handle.awaitExit(5000);
		expect(exit).not.toBeNull();
		// already-exited: immediate resolve, no timer needed
		const again = await handle.awaitExit(1);
		expect(again).not.toBeNull();
	});

	it("spawn failure SYNTHESIZES an exit — awaitExit/onExit lifecycles terminate instead of waiting forever (Codex #550 R1)", async () => {
		const handle = runner.spawn("/no/such/binary-fly1160", []);
		handle.onError(() => {});
		const exited = new Promise<void>((res) => handle.onExit(() => res()));
		const exit = await handle.awaitExit(2000);
		expect(exit).not.toBeNull();
		await exited;
	});

	it("write after exit returns false and surfaces EPIPE-class errors via onError, never uncaught", async () => {
		const handle = runner.spawn(NODE, ["-e", "process.exit(0)"]);
		await handle.awaitExit(5000);
		const errors: Error[] = [];
		handle.onError((e) => errors.push(e));
		const ok = handle.write("late data");
		expect(ok).toBe(false);
		// allow any async stdin error to surface (must not crash the process)
		await new Promise((r) => setTimeout(r, 50));
	});
});
