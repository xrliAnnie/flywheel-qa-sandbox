import {
	existsSync,
	mkdtempSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("PatrolStateStore", () => {
	it("serializes mutator updates so independent fields are preserved", async () => {
		const module = await import("./patrol-state.js").catch(() => ({}));
		const PatrolStateStore = (module as { PatrolStateStore?: unknown })
			.PatrolStateStore;
		expect(PatrolStateStore).toBeTypeOf("function");
		if (typeof PatrolStateStore !== "function") return;
		const stateDir = mkdtempSync(join(tmpdir(), "raya-patrol-state-"));
		const store = new (
			PatrolStateStore as new (
				stateDir: string,
			) => {
				read: () => Record<string, unknown>;
				update: (
					mutator: (state: Record<string, unknown>) => Record<string, unknown>,
				) => Promise<Record<string, unknown>>;
				statePath: string;
			}
		)(stateDir);

		await Promise.all([
			store.update((state) => ({
				...state,
				injected: { threadId: "thread-1", snapshotId: "snapshot-1" },
			})),
			store.update((state) => ({
				...state,
				attempt: {
					attemptId: "attempt-1",
					snapshotId: "snapshot-1",
					status: "posting",
					at: "2026-09-06T12:00:00Z",
				},
			})),
		]);

		expect(store.read()).toMatchObject({
			v: 1,
			injected: { threadId: "thread-1", snapshotId: "snapshot-1" },
			attempt: { attemptId: "attempt-1", status: "posting" },
		});
		expect(statSync(store.statePath).mode & 0o777).toBe(0o600);
	});

	it("renames corrupt state, returns empty state, and appends private events", async () => {
		const { PatrolStateStore } = await import("./patrol-state.js");
		const stateDir = mkdtempSync(join(tmpdir(), "raya-patrol-corrupt-"));
		const onCorrupt = vi.fn();
		const store = new PatrolStateStore(stateDir, {
			onCorrupt,
			nowMs: () => 42,
		});
		writeFileSync(store.statePath, "broken", { mode: 0o600 });

		expect(store.read()).toEqual({ v: 1 });
		expect(onCorrupt).toHaveBeenCalledOnce();
		expect(existsSync(store.statePath)).toBe(false);
		expect(
			readdirSync(join(stateDir, "portfolio")).some((name) =>
				name.includes("patrol-state.json.corrupt-42"),
			),
		).toBe(true);
		store.appendEvent("patrol_started", { reason: "interval" });
		expect(statSync(store.eventsPath).mode & 0o777).toBe(0o600);
	});
});
