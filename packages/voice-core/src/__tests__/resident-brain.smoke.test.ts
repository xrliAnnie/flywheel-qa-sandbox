/**
 * FLY-1160 §8-6 — REAL claude CLI smoke (gated: RESIDENT_SPIKE=1).
 *
 * Assertion-form of evidence/spike-resident-stream-json.mjs plus the one
 * scenario the spike did not cover: mid-turn SIGKILL → respond throws →
 * --resume respawn → memory intact.
 *
 * Run: RESIDENT_SPIKE=1 pnpm vitest run src/__tests__/resident-brain.smoke.test.ts
 * (spends real model turns — short one-sentence replies on sonnet)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ResidentBrainEvent,
	ResidentClaudeBrain,
} from "../brain/ResidentClaudeBrain.js";
import type { VoiceError } from "../types.js";

const RUN = process.env.RESIDENT_SPIKE === "1";
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";

const cleanup: string[] = [];
const brains: ResidentClaudeBrain[] = [];
afterEach(() => {
	for (const b of brains) {
		try {
			b.forceKill();
		} catch {}
	}
	brains.length = 0;
	for (const d of cleanup) rmSync(d, { recursive: true, force: true });
	cleanup.length = 0;
});

function identityFile(): string {
	const dir = mkdtempSync(join(tmpdir(), "voice-smoke-"));
	cleanup.push(dir);
	const p = join(dir, "identity.md");
	writeFileSync(p, "你是语音助手冒烟测试。用一句简短中文回答。记住对话内容。");
	return p;
}

function makeBrain(events?: ResidentBrainEvent[]): ResidentClaudeBrain {
	const brain = new ResidentClaudeBrain({
		claudeBin: CLAUDE,
		identityFile: identityFile(),
		model: "sonnet",
		turnTimeoutMs: 90_000,
		...(events ? { onEvent: (e) => events.push(e) } : {}),
	});
	brains.push(brain);
	return brain;
}

async function collect(
	iter: AsyncIterable<string>,
	onFirstChunk?: () => void,
): Promise<string> {
	let text = "";
	let first = true;
	for await (const c of iter) {
		if (first) {
			first = false;
			onFirstChunk?.();
		}
		text += c;
	}
	return text;
}

const sig = () => new AbortController().signal;

async function waitFor(cond: () => boolean, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
		await new Promise((r) => setTimeout(r, 100));
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe.runIf(RUN)("ResidentClaudeBrain — real claude CLI smoke", () => {
	it(
		"multi-turn on ONE pid, in-session memory, no per-turn spawn",
		{ timeout: 180_000 },
		async () => {
			const brain = makeBrain();
			const t1 = await collect(
				brain.respond(
					{
						text: "我最喜欢的颜色是青色。记住它,然后用一句话确认。",
						history: [],
					},
					{ signal: sig() },
				),
			);
			expect(t1.length).toBeGreaterThan(0);
			const pid1 = brain.health().pid;
			expect(pid1).toBeDefined();

			const t2 = await collect(
				brain.respond(
					{ text: "我刚才说我最喜欢的颜色是什么?一句话。", history: [] },
					{ signal: sig() },
				),
			);
			expect(t2).toContain("青");
			expect(brain.health().pid).toBe(pid1); // zero per-turn spawn
			expect(brain.health().turns).toBe(2);
			expect(brain.health().sessionId).toBeTruthy();

			await brain.dispose();
			expect(pidAlive(pid1 as number)).toBe(false); // no orphan
		},
	);

	it(
		"in-band interrupt: turn cancelled clean, process SURVIVES, next turn fine",
		{ timeout: 240_000 },
		async () => {
			const brain = makeBrain();
			await collect(
				brain.respond(
					{ text: "记住:我最喜欢的颜色是青色。一句话确认。", history: [] },
					{ signal: sig() },
				),
			);
			const pid1 = brain.health().pid;

			const text = await collect(
				brain.respond(
					{ text: "从 1 数到 100,每个数字一行。", history: [] },
					{ signal: sig() },
				),
				() => void brain.interrupt(),
			);
			// interrupted turn ends CLEAN (whitelisted error_during_execution)
			expect(brain.health().pid).toBe(pid1); // still the same process
			expect(text.length).toBeLessThan(2000); // did not count to 100

			const t3 = await collect(
				brain.respond(
					{ text: "我最喜欢的颜色还记得吗?一句话。", history: [] },
					{ signal: sig() },
				),
			);
			expect(t3).toContain("青");
			await brain.dispose();
		},
	);

	it(
		"mid-turn SIGKILL: respond throws, --resume respawn, memory INTACT (the spike gap)",
		{ timeout: 240_000 },
		async () => {
			const events: ResidentBrainEvent[] = [];
			const brain = makeBrain(events);
			await collect(
				brain.respond(
					{ text: "我最喜欢的颜色是青色。记住它。一句话确认。", history: [] },
					{ signal: sig() },
				),
			);
			const pid1 = brain.health().pid as number;

			const err = await collect(
				brain.respond(
					{ text: "从 1 数到 100,每个数字一行。", history: [] },
					{ signal: sig() },
				),
				() => process.kill(pid1, "SIGKILL"),
			).catch((e) => e);
			expect((err as VoiceError).code).toBe("subprocess-failed");
			expect(
				events.some((e) => e.type === "state" && e.state === "recovering"),
			).toBe(true);

			await waitFor(
				() => brain.health().state === "idle" && brain.health().pid !== pid1,
			);
			const t3 = await collect(
				brain.respond(
					{ text: "崩溃恢复测试:我最喜欢的颜色是什么?一句话。", history: [] },
					{ signal: sig() },
				),
			);
			expect(t3).toContain("青");
			const pid2 = brain.health().pid as number;
			await brain.dispose();
			expect(pidAlive(pid2)).toBe(false);
		},
	);
});
