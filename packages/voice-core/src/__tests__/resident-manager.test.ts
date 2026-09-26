/**
 * FLY-1160 §3.2 — ResidentBrainManager: key → resident session, global hard
 * cap, and the reaping iron rule (who spawns, reaps — FLY-1148 lesson; only
 * the daemon spawns). close/closeAll must CONFIRM process exit; forceKillAll
 * is the synchronous shutdown hard-timer path.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResidentBrainManager } from "../brain/ResidentBrainManager.js";
import type { VoiceError } from "../types.js";
import { FakeProcessRunner } from "./fakes.js";

const cleanup: string[] = [];
const managers: ResidentBrainManager[] = [];
afterEach(() => {
	for (const m of managers) {
		try {
			m.forceKillAll();
		} catch {}
	}
	managers.length = 0;
	for (const d of cleanup) rmSync(d, { recursive: true, force: true });
	cleanup.length = 0;
});

function identityFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "voice-identity-"));
	cleanup.push(dir);
	const p = join(dir, "identity.md");
	writeFileSync(p, "You are Tadashi.");
	return p;
}

function setup(maxSessions?: number) {
	const runner = new FakeProcessRunner();
	const manager = new ResidentBrainManager(
		maxSessions === undefined ? {} : { maxSessions },
	);
	managers.push(manager);
	const brainOpts = {
		claudeBin: "claude",
		identityFile: identityFile(),
		runner,
		eofGraceMs: 30,
		termGraceMs: 30,
	};
	return { runner, manager, brainOpts };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
		await new Promise((r) => setTimeout(r, 5));
	}
}

describe("ResidentBrainManager", () => {
	it("open is idempotent per key: same brain instance, one spawn, PIDs registered", () => {
		const { runner, manager, brainOpts } = setup();
		const a1 = manager.open("FLY-1011:flywheel-eng-lead", brainOpts);
		const a2 = manager.open("FLY-1011:flywheel-eng-lead", brainOpts);
		expect(a2).toBe(a1);
		expect(runner.spawnCalls.length).toBe(1);
		expect(manager.stats()).toEqual({ active: 1 });
		expect(a1.health().pid).toBe(4242); // registered live PID
		expect(manager.get("FLY-1011:flywheel-eng-lead")).toBe(a1);
		expect(manager.get("missing")).toBeUndefined();
	});

	it("global hard cap: over the limit open throws resource-exhausted (fail-loud, no queueing); existing keys unaffected", () => {
		const { manager, brainOpts } = setup(2);
		manager.open("a", brainOpts);
		manager.open("b", brainOpts);
		let err: unknown;
		try {
			manager.open("c", brainOpts);
		} catch (e) {
			err = e;
		}
		expect((err as VoiceError).code).toBe("resource-exhausted");
		expect(manager.stats()).toEqual({ active: 2 });
		// idempotent re-open of an existing key is NOT a new session
		expect(manager.open("a", brainOpts)).toBe(manager.get("a"));
	});

	it("close(key) disposes, CONFIRMS exit, unregisters; reopening spawns fresh", async () => {
		const { runner, manager, brainOpts } = setup();
		manager.open("a", brainOpts);
		const h = runner.handles[0];
		const p = manager.close("a");
		await waitFor(() => h.stdinClosed);
		h.emitExit(0, null);
		await p;
		expect(manager.get("a")).toBeUndefined();
		expect(manager.stats()).toEqual({ active: 0 });
		manager.open("a", brainOpts);
		expect(runner.spawnCalls.length).toBe(2);
	});

	it("closeAll resolves only after EVERY child's exit is confirmed (reaping iron rule)", async () => {
		const { runner, manager, brainOpts } = setup();
		manager.open("a", brainOpts);
		manager.open("b", brainOpts);
		const [h1, h2] = runner.handles;
		let done = false;
		const p = manager.closeAll().then(() => {
			done = true;
		});
		await waitFor(() => h1.stdinClosed && h2.stdinClosed);
		h1.emitExit(0, null);
		await new Promise((r) => setTimeout(r, 20));
		expect(done).toBe(false); // second child still unreaped
		h2.emitExit(0, null);
		await p;
		expect(done).toBe(true);
		expect(manager.stats()).toEqual({ active: 0 });
	});

	it("a dying child still holds its process slot: over-cap open refused until the exit is CONFIRMED (Codex #550 R1)", async () => {
		const { runner, manager, brainOpts } = setup(1);
		manager.open("a", brainOpts);
		const h = runner.handles[0];
		const closing = manager.close("a");
		// child not exited yet — the slot is still occupied
		expect(() => manager.open("b", brainOpts)).toThrow(
			/resident brain session limit/,
		);
		await waitFor(() => h.stdinClosed);
		h.emitExit(0, null);
		await closing;
		manager.open("b", brainOpts); // now fits
		expect(runner.spawnCalls.length).toBe(2);
	});

	it("closeAll waits for closes that were already in flight when it started (Codex #550 R1)", async () => {
		const { runner, manager, brainOpts } = setup();
		manager.open("a", brainOpts);
		const h = runner.handles[0];
		const first = manager.close("a");
		let done = false;
		const all = manager.closeAll().then(() => {
			done = true;
		});
		await new Promise((r) => setTimeout(r, 20));
		expect(done).toBe(false); // the in-flight close is unreaped
		await waitFor(() => h.stdinClosed);
		h.emitExit(0, null);
		await first;
		await all;
		expect(done).toBe(true);
	});

	it("repeat close(key) while the child is dying returns the SAME in-flight promise (Codex #550 R2)", async () => {
		const { runner, manager, brainOpts } = setup();
		manager.open("a", brainOpts);
		const h = runner.handles[0];
		const p1 = manager.close("a");
		const p2 = manager.close("a");
		expect(p2).toBe(p1);
		await waitFor(() => h.stdinClosed);
		h.emitExit(0, null);
		await p1;
	});

	it("a FAILED dispose keeps the brain in the hard-timer kill set — the kill handle is never lost (Codex #550 R2)", async () => {
		const { runner, manager, brainOpts } = setup();
		const brain = manager.open("a", brainOpts);
		vi.spyOn(brain, "dispose").mockRejectedValueOnce(new Error("dispose boom"));
		await expect(manager.close("a")).rejects.toThrow("dispose boom");
		manager.forceKillAll();
		expect(runner.handles[0].kills).toContain("SIGKILL");
	});

	it("forceKillAll SIGKILLs every registered child synchronously (shutdown hard-timer path)", () => {
		const { runner, manager, brainOpts } = setup();
		manager.open("a", brainOpts);
		manager.open("b", brainOpts);
		manager.forceKillAll();
		expect(runner.handles[0].kills).toContain("SIGKILL");
		expect(runner.handles[1].kills).toContain("SIGKILL");
	});
});
