import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCodexHomeReconcileHealthRider } from "../codex-home-reconcile-rider.js";

describe("Codex home reconcile health rider", () => {
	it("uses the existing tick but launches at most once while a cycle is in flight", async () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "fly2523-rider-"));
		let release!: () => void;
		const runCycle = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const rider = createCodexHomeReconcileHealthRider({
			stateRoot,
			now: () => Date.parse("2026-09-18T00:00:00.000Z"),
			runCycle,
		});

		const first = rider.tick();
		await rider.tick();
		expect(runCycle).toHaveBeenCalledTimes(1);
		release();
		await first;
	});

	it("honors the durable one-hour timestamp across rider instances", async () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "fly2523-rider-"));
		const migration = join(stateRoot, "codex-quota/home-migration");
		mkdirSync(migration, { recursive: true });
		writeFileSync(
			join(migration, "schedule.json"),
			JSON.stringify({
				schemaVersion: 1,
				lastAttemptStartedAt: "2026-09-18T00:00:00.000Z",
				source: "updater",
			}),
		);
		const runCycle = vi.fn().mockResolvedValue(undefined);
		const early = createCodexHomeReconcileHealthRider({
			stateRoot,
			now: () => Date.parse("2026-09-18T00:59:59.999Z"),
			runCycle,
		});
		await early.tick();
		expect(runCycle).not.toHaveBeenCalled();

		const due = createCodexHomeReconcileHealthRider({
			stateRoot,
			now: () => Date.parse("2026-09-18T01:00:00.000Z"),
			runCycle,
		});
		await due.tick();
		expect(runCycle).toHaveBeenCalledTimes(1);
	});

	it("is a complete VITEST no-op unless fixture paths are explicitly enabled", async () => {
		const runCycle = vi.fn().mockResolvedValue(undefined);
		const rider = createCodexHomeReconcileHealthRider({
			stateRoot: "/must/not/be/read",
			enabled: false,
			runCycle,
		});
		await rider.tick();
		expect(runCycle).not.toHaveBeenCalled();
	});
});
