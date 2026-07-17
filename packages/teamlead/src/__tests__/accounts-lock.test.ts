import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	reconcileTransitionJournal,
	type TransitionReconcileResult,
	withAccountsLock,
} from "../account-heal/accounts-lock.js";
import type { LeaseProof } from "../account-heal/mkdir-lock.js";

const lease: LeaseProof = {
	lockPath: "/tmp/accounts.lock",
	markerPath: "/tmp/accounts.lock/holder.1.token",
	ownershipToken: "token",
};

async function run(result: TransitionReconcileResult) {
	const fn = vi.fn(async () => "value");
	const lockResult = await withAccountsLock(lease.lockPath, fn, {
		withLock: async (_path, inner) => inner(),
		getProof: () => lease,
		reconcile: async () => result,
	});
	return { fn, lockResult };
}

describe("withAccountsLock", () => {
	it.each(["none", "cleared"] as const)(
		"runs the callback after %s reconciliation",
		async (outcome) => {
			const { fn, lockResult } = await run({ outcome });
			expect(fn).toHaveBeenCalledWith(lease);
			expect(lockResult).toEqual({ kind: "ok", value: "value" });
		},
	);

	it("returns reconciled and skips stale callback after completing a transition", async () => {
		const { fn, lockResult } = await run({
			outcome: "completed",
			activeAccount: "school",
			generation: 9,
		});
		expect(fn).not.toHaveBeenCalled();
		expect(lockResult).toEqual({
			kind: "reconciled",
			activeAccount: "school",
			generation: 9,
		});
	});

	it.each([
		{
			result: { outcome: "writer_alive" } as const,
			reason: { kind: "writer_alive" },
		},
		{
			result: {
				outcome: "conflict",
				reason: "digest_mismatch_both",
			} as const,
			reason: { kind: "conflict", detail: "digest_mismatch_both" },
		},
	])(
		"returns blocked and skips callback: $reason.kind",
		async ({ result, reason }) => {
			const { fn, lockResult } = await run(result);
			expect(fn).not.toHaveBeenCalled();
			expect(lockResult).toEqual({ kind: "blocked", reason });
		},
	);
});

describe("reconcileTransitionJournal", () => {
	it("binds a delegated reconciler to the exact non-default lease path", async () => {
		const root = mkdtempSync(join(tmpdir(), "accounts-lock-"));
		const journalPath = join(root, "transition.json");
		writeFileSync(journalPath, "{}\n");
		const execFile = vi.fn(async () => ({
			stdout: '{"outcome":"none"}\n',
			stderr: "",
		}));
		try {
			await reconcileTransitionJournal(lease, { journalPath, execFile });
			expect(execFile).toHaveBeenCalledWith(
				expect.any(String),
				["reconcile-journal"],
				expect.objectContaining({
					env: expect.objectContaining({
						FLYWHEEL_CLAUDE_ACCOUNTS_LOCK: lease.lockPath,
					}),
				}),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not treat a dangling journal symlink as an absent journal", async () => {
		const root = mkdtempSync(join(tmpdir(), "accounts-lock-"));
		const journalPath = join(root, "transition.json");
		symlinkSync(join(root, "missing-target"), journalPath);
		const execFile = vi.fn(async () => ({
			stdout: '{"outcome":"conflict","reason":"malformed_journal"}\n',
			stderr: "",
		}));
		try {
			await expect(
				reconcileTransitionJournal(lease, { journalPath, execFile }),
			).resolves.toEqual({
				outcome: "conflict",
				reason: "malformed_journal",
			});
			expect(execFile).toHaveBeenCalledOnce();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
