import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

it("persists only pre-adapter receipts, preserving the first receipt across replay and restart", async () => {
	const root = mkdtempSync(join(tmpdir(), "fly2490-receipt-"));
	let store: StateStore | undefined;
	try {
		const path = join(root, "state.db");
		store = await StateStore.create(path);
		const input = {
			executionId: "exec",
			failureKind: "worktree_takeover_failed",
			sourceEventId: "event-1",
			now: "2026-09-11T00:00:00Z",
		};
		expect(store.getPreAdapterFailureReceipt("exec")).toBeUndefined();
		expect(
			store.recordPreAdapterFailureReceipt({
				...input,
				failureKind: "goal_blocked",
			}),
		).toEqual({ ok: false, reason: "kind_not_pre_adapter" });
		expect(store.recordPreAdapterFailureReceipt(input)).toEqual({
			ok: true,
			inserted: true,
		});
		expect(
			store.recordPreAdapterFailureReceipt({
				...input,
				sourceEventId: "event-2",
			}),
		).toEqual({ ok: true, inserted: false });
		store.close();
		store = await StateStore.create(path);
		store.migrate();
		expect(store.getPreAdapterFailureReceipt("exec")).toEqual({
			failureKind: input.failureKind,
			sourceEventId: "event-1",
			recordedAt: input.now,
		});
	} finally {
		store?.close();
		rmSync(root, { recursive: true, force: true });
	}
});
