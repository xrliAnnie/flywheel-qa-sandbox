import { describe, expect, it } from "vitest";
import { teardownCodexRemote } from "../codex-remote.js";

/** R5-B2: destructive teardown authority — a persisted PGID may be recycled
 * by an unrelated process after a restart, so signalling requires two-fact
 * proof (live socket holder + holder's CURRENT group agreeing). */
describe("teardownCodexRemote authority (R5-B2)", () => {
	const state = {
		socket_path: "/tmp/fly1547-b2-nonexistent.sock",
		daemon_pgid: 7777,
	};

	function ports(overrides: {
		alive?: () => boolean;
		holders?: number[];
		groupOf?: (pid: number) => number | null;
	}) {
		const signals: Array<{ pgid: number; signal: string }> = [];
		let alive = overrides.alive ?? (() => false);
		return {
			signals,
			setAlive(fn: () => boolean) {
				alive = fn;
			},
			ports: {
				connect: (async () => {
					if (!alive()) throw new Error("connect refused");
					return { close: () => {} };
				}) as never,
				socketHolderPids: () => overrides.holders ?? [],
				processGroupOf: overrides.groupOf ?? (() => null),
				killGroup: (pgid: number, signal: string) => {
					signals.push({ pgid, signal });
				},
				sleep: async () => {},
			},
		};
	}

	it("never signals anything when the socket is already dead", async () => {
		const { ports: p, signals } = ports({ alive: () => false });
		await expect(teardownCodexRemote(state, p)).resolves.toBe(true);
		expect(signals).toEqual([]);
	});

	it("refuses destructively when the live socket has no provable holder", async () => {
		const { ports: p, signals } = ports({ alive: () => true, holders: [] });
		await expect(teardownCodexRemote(state, p)).resolves.toBe(false);
		expect(signals).toEqual([]);
	});

	it("refuses when the holder's current group disagrees with the persisted PGID", async () => {
		const { ports: p, signals } = ports({
			alive: () => true,
			holders: [500],
			groupOf: () => 9999, // recycled — not the persisted 7777
		});
		await expect(teardownCodexRemote(state, p)).resolves.toBe(false);
		expect(signals).toEqual([]);
	});

	it("refuses to signal its own process group", async () => {
		const own = 4242;
		const { ports: p, signals } = ports({
			alive: () => true,
			holders: [500],
			groupOf: () => own, // holder group == our own group
		});
		await expect(
			teardownCodexRemote({ ...state, daemon_pgid: own }, p),
		).resolves.toBe(false);
		expect(signals).toEqual([]);
	});

	it("signals only the proven group and verifies death by socket", async () => {
		let dead = false;
		const harness = ports({
			alive: () => !dead,
			holders: [500, 501],
			groupOf: (pid) => (pid === process.pid ? 1 : 7777),
		});
		harness.ports.killGroup = (pgid: number, signal: string) => {
			harness.signals.push({ pgid, signal });
			dead = true; // TERM kills the group; socket goes quiet
		};
		await expect(teardownCodexRemote(state, harness.ports)).resolves.toBe(true);
		expect(harness.signals).toEqual([{ pgid: 7777, signal: "SIGTERM" }]);
	});

	it("derives the group from live holders when no PGID was persisted (pre-spawn intent)", async () => {
		let dead = false;
		const harness = ports({
			alive: () => !dead,
			holders: [600],
			groupOf: (pid) => (pid === process.pid ? 1 : 8888),
		});
		harness.ports.killGroup = (pgid: number, signal: string) => {
			harness.signals.push({ pgid, signal });
			dead = true;
		};
		await expect(
			teardownCodexRemote({ ...state, daemon_pgid: null }, harness.ports),
		).resolves.toBe(true);
		expect(harness.signals).toEqual([{ pgid: 8888, signal: "SIGTERM" }]);
	});
});
