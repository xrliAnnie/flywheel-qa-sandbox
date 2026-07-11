/**
 * FLY-1160 §3.2 — REAL claude CLI manager smoke (gated: RESIDENT_SPIKE=1).
 *
 * QA addition (FLY-1160 three-stage QA): the resident-brain.smoke suite drives
 * ResidentClaudeBrain DIRECTLY, but the plan's §3.2 reaping iron rule ("who
 * spawns, reaps" — the FLY-1148 orphan-claude-process load incident) is only
 * ever exercised over FAKE processes. This closes that gap: real `claude`
 * children are spawned THROUGH the manager, the global hard cap is proven to
 * fail-loud, and closeAll() is proven to leave ZERO orphan PIDs behind.
 *
 * open() spawns the child in ResidentClaudeBrain's constructor but sends NO
 * user turn — so this spends real PROCESSES, not real model turns (fast, no
 * subscription cost).
 *
 * Run: RESIDENT_SPIKE=1 pnpm vitest run src/__tests__/resident-manager.smoke.test.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResidentBrainManager } from "../brain/ResidentBrainManager.js";
import type { ResidentBrainOptions } from "../brain/ResidentClaudeBrain.js";
import type { VoiceError } from "../types.js";

const RUN = process.env.RESIDENT_SPIKE === "1";
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";

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
	const dir = mkdtempSync(join(tmpdir(), "voice-mgr-smoke-"));
	cleanup.push(dir);
	const p = join(dir, "identity.md");
	writeFileSync(p, "你是语音助手冒烟测试。用一句简短中文回答。");
	return p;
}

function brainOpts(): ResidentBrainOptions {
	return {
		claudeBin: CLAUDE,
		identityFile: identityFile(),
		model: "sonnet",
		turnTimeoutMs: 90_000,
		// keep the reaping ladder snappy so an EOF-clean child reaps fast
		eofGraceMs: 4_000,
		termGraceMs: 2_000,
	};
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe.runIf(RUN)("ResidentBrainManager — real claude CLI reaping", () => {
	it(
		"global cap fails loud, and closeAll reaps every real child (no orphans)",
		{ timeout: 60_000 },
		async () => {
			const manager = new ResidentBrainManager({ maxSessions: 2 });
			managers.push(manager);

			// two distinct meeting lines → two REAL, distinct claude processes
			const a = manager.open("FLY-1160:lead-a", brainOpts());
			const b = manager.open("FLY-1160:lead-b", brainOpts());
			const pidA = a.health().pid;
			const pidB = b.health().pid;
			expect(pidA).toBeGreaterThan(0);
			expect(pidB).toBeGreaterThan(0);
			expect(pidA).not.toBe(pidB); // one process per line, not shared
			expect(pidAlive(pidA as number)).toBe(true);
			expect(pidAlive(pidB as number)).toBe(true);
			expect(manager.stats()).toEqual({ active: 2 });

			// idempotent: same key returns the SAME brain, spawns nothing new
			expect(manager.open("FLY-1160:lead-a", brainOpts())).toBe(a);
			expect(manager.stats()).toEqual({ active: 2 });

			// third distinct line over the cap → fail-loud, NEVER a silent 3rd spawn
			const err = (() => {
				try {
					manager.open("FLY-1160:lead-c", brainOpts());
					return undefined;
				} catch (e) {
					return e as VoiceError;
				}
			})();
			expect(err?.code).toBe("resource-exhausted");
			expect(manager.stats()).toEqual({ active: 2 }); // cap held the line

			// the reaping iron rule: closeAll CONFIRMS every child exited
			await manager.closeAll();
			expect(pidAlive(pidA as number)).toBe(false);
			expect(pidAlive(pidB as number)).toBe(false);
			expect(manager.stats()).toEqual({ active: 0 });
		},
	);
});
