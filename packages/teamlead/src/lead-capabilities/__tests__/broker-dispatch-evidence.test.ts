import { afterEach, expect, it, vi } from "vitest";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { LeadCapabilityBroker } from "../broker.js";
import type { LeadTargetLockClient } from "../target-lock-client.js";

const requestId = "a0000000-0000-4000-8000-000000000001";
const fence = "c0000000-0000-4000-8000-000000000001";
const request = {
	schemaVersion: 1 as const,
	operationId: "linear.issue.update",
	requestId,
	input: { issueId: "FLY-2886", stateId: "done" },
};
const key = {
	projectName: "flywheel",
	leadId: "eng",
	operationId: request.operationId,
	requestId,
};
const stores: SqliteJournalStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
});

function setup(options: {
	activationId: string;
	locks: Partial<LeadTargetLockClient> & Pick<LeadTargetLockClient, "actor">;
	failAfterMark?: boolean;
	/** Fail the Nth authority check after the lock step (unfenced positions). */
	failNthCheckAfterAcquire?: number;
}) {
	const store = new SqliteJournalStore(":memory:");
	stores.push(store);
	let marked = false,
		acquired = false,
		checksAfterAcquire = 0;
	const execute = vi.fn(async () => ({
		status: "succeeded" as const,
		providerRef: "linear:FLY-2886",
		data: {
			issue: {
				id: "i1",
				identifier: "FLY-2886",
				url: "https://linear.app/x/issue/FLY-2886",
				title: "t",
				state: "done",
				assigneeId: null,
			},
			receiptId: "r1",
			observedAt: "2026-09-26T00:00:00.000Z",
		},
	}));
	const resolveTargetKey = vi.fn(async () => "linear:fly-2886");
	const release = vi.fn(async () => {});
	const acquire = vi.fn(async () => {
		acquired = true;
		return options.locks.actor === "voice"
			? { status: "acquired" as const, fence }
			: { status: "unguarded" as const };
	});
	const broker = new LeadCapabilityBroker({
		projectName: "flywheel",
		leadId: "eng",
		activationId: options.activationId,
		receipts: store.operationReceipts,
		secrets: [],
		allowedOperationIds: () => new Set([request.operationId]),
		assertCurrent: async () => {
			if (options.failAfterMark && marked) throw new Error("revoked");
			if (options.failNthCheckAfterAcquire && acquired) {
				checksAfterAcquire += 1;
				if (checksAfterAcquire >= options.failNthCheckAfterAcquire)
					throw new Error("revoked");
			}
		},
		handlers: new Map([
			[
				request.operationId,
				{ authorize: async () => {}, execute, resolveTargetKey },
			],
		]),
		targetLocks: {
			acquire,
			markDispatched: async () => {
				marked = true;
				return true;
			},
			release,
			cancel: async () => {},
			...options.locks,
		} as LeadTargetLockClient,
	});
	return { broker, store, execute, resolveTargetKey, release, acquire };
}

it("keeps a non-participating resident on the pre-voice write path: no alias lookup and no lock call", async () => {
	const f = setup({
		activationId: "resident:1",
		locks: { actor: "resident", participates: () => false },
	});
	expect((await f.broker.execute(request)).status).toBe("succeeded");
	expect(f.resolveTargetKey).not.toHaveBeenCalled();
	expect(f.acquire).not.toHaveBeenCalled();
	expect(f.execute).toHaveBeenCalledOnce();
});

it("settles a fenced write as not dispatched when authority fails after mark but before the provider call", async () => {
	const f = setup({
		activationId: "voice:b0000000-0000-4000-8000-000000000001",
		locks: { actor: "voice" },
		failAfterMark: true,
	});
	const result = await f.broker.execute(request);
	expect(result).toMatchObject({
		status: "rejected",
		errorCode: "activation_not_current",
	});
	expect(f.execute).not.toHaveBeenCalled();
	expect(f.release).toHaveBeenCalledWith(
		expect.objectContaining({ fence, outcome: "never_invoked" }),
	);
	expect(f.store.operationReceipts.get(key)?.state).toBe("rejected");
});

it("keeps the pre-voice unknown outcome for an unfenced resident in the same position", async () => {
	const f = setup({
		activationId: "resident:1",
		locks: { actor: "resident", participates: () => true },
		// 1st check after the lock step precedes `dispatched`; the 2nd precedes the provider call.
		failNthCheckAfterAcquire: 2,
	});
	const result = await f.broker.execute(request);
	expect(f.acquire).toHaveBeenCalledOnce();
	expect(f.execute).not.toHaveBeenCalled();
	expect(result.status).toBe("unknown");
	expect(f.store.operationReceipts.get(key)?.state).toBe("unknown");
});
