import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBoundedShutdown } from "../bridge/bounded-shutdown.js";

describe("FLY-516 runBoundedShutdown", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("exits 0 when close() resolves before the timeout", async () => {
		const exits: number[] = [];
		const close = vi.fn().mockResolvedValue(undefined);
		await runBoundedShutdown({
			close,
			timeoutMs: 20_000,
			exit: (c) => exits.push(c),
			log: () => {},
			errorLog: () => {},
		});
		expect(close).toHaveBeenCalledOnce();
		expect(exits).toEqual([0]);
	});

	it("force-exits 1 when close() hangs past the timeout (port released)", async () => {
		const exits: number[] = [];
		// close() never resolves → the only way out is the timeout.
		const close = vi.fn().mockImplementation(() => new Promise<void>(() => {}));
		const p = runBoundedShutdown({
			close,
			timeoutMs: 20_000,
			exit: (c) => exits.push(c),
			log: () => {},
			errorLog: () => {},
		});
		// Nothing yet — close is still pending.
		expect(exits).toEqual([]);
		// Advance to the timeout boundary → timer fires → exit(1).
		await vi.advanceTimersByTimeAsync(20_000);
		expect(exits).toEqual([1]);
		// The runBoundedShutdown promise stays pending (close never resolves);
		// that's fine — in prod process.exit() ends it. Keep a reference so the
		// floating promise doesn't trip unhandled-rejection tooling.
		void p;
	});

	it("does not double-exit if close() resolves AFTER the timeout fired", async () => {
		const exits: number[] = [];
		let resolveClose: (() => void) | undefined;
		const close = vi.fn().mockImplementation(
			() =>
				new Promise<void>((r) => {
					resolveClose = r;
				}),
		);
		const p = runBoundedShutdown({
			close,
			timeoutMs: 20_000,
			exit: (c) => exits.push(c),
			log: () => {},
			errorLog: () => {},
		});
		await vi.advanceTimersByTimeAsync(20_000);
		expect(exits).toEqual([1]); // timeout fired
		// Late resolution must NOT add a second exit(0).
		resolveClose?.();
		await p;
		expect(exits).toEqual([1]);
	});

	it("exits 0 (logged) when close() throws — process still dies, port releases", async () => {
		const exits: number[] = [];
		const errors: string[] = [];
		const close = vi.fn().mockRejectedValue(new Error("teardown boom"));
		await runBoundedShutdown({
			close,
			timeoutMs: 20_000,
			exit: (c) => exits.push(c),
			log: () => {},
			errorLog: (m) => errors.push(m),
		});
		expect(exits).toEqual([0]);
		expect(errors.join("\n")).toContain("teardown boom");
	});

	it("clears the timer on graceful close so it cannot fire later", async () => {
		const exits: number[] = [];
		const close = vi.fn().mockResolvedValue(undefined);
		await runBoundedShutdown({
			close,
			timeoutMs: 20_000,
			exit: (c) => exits.push(c),
			log: () => {},
			errorLog: () => {},
		});
		expect(exits).toEqual([0]);
		// Advancing well past the timeout must not produce a stray exit.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(exits).toEqual([0]);
	});
});
