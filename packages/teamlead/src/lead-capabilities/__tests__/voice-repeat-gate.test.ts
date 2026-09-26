import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { type HandlerOutcome, LeadCapabilityBroker } from "../broker.js";
import {
	isExplicitRepeatConfirmation,
	VOICE_REPEAT_WINDOW_MS,
	VoiceRepeatWriteGate,
	voiceRepeatFingerprint,
} from "../voice-repeat-gate.js";

const scope = {
	projectName: "flywheel",
	leadId: "eng",
	activationId: "voice:b0000000-0000-4000-8000-000000000001",
};
const ids = [
	"a0000000-0000-4000-8000-000000000001",
	"a0000000-0000-4000-8000-000000000002",
	"a0000000-0000-4000-8000-000000000003",
	"a0000000-0000-4000-8000-000000000004",
];
const fence = "c0000000-0000-4000-8000-000000000001";
const update = (requestId: string, stateId = "done") => ({
	schemaVersion: 1 as const,
	operationId: "linear.issue.update",
	requestId,
	input: { issueId: "FLY-2886", stateId },
});

let journal: SqliteJournalStore | undefined;
beforeEach(() => {
	// Receipts and the gate share one clock; only Date is faked.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => {
	vi.useRealTimers();
	journal?.close();
	journal = undefined;
});

function harness(
	outcome: () => HandlerOutcome = () => ({
		status: "succeeded",
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
	}),
	options: { gate?: boolean } = {},
) {
	journal = new SqliteJournalStore(":memory:");
	let entryId = "entry-1";
	const execute = vi.fn(async () => outcome());
	const gate =
		options.gate === false
			? undefined
			: new VoiceRepeatWriteGate({
					receipts: journal.operationReceipts,
					...scope,
				});
	const broker = new LeadCapabilityBroker({
		...scope,
		receipts: journal.operationReceipts,
		secrets: [],
		allowedOperationIds: () =>
			new Set(["linear.issue.update", "linear.issue.get", "start_runner"]),
		assertCurrent: async () => {},
		deliveryContext: () => ({ id: entryId, assertCurrent: () => {} }),
		handlers: new Map([
			["linear.issue.update", { authorize: async () => {}, execute }],
			["linear.issue.get", { authorize: async () => {}, execute }],
			["start_runner", { authorize: async () => {}, execute }],
		]),
		targetLocks: {
			actor: "voice",
			acquire: async () => ({ status: "acquired", fence }),
			markDispatched: async () => true,
			release: async () => {},
			cancel: async () => {},
		},
		...(gate ? { repeatGate: gate } : {}),
	});
	return {
		broker,
		gate,
		execute,
		setEntry: (id: string) => {
			entryId = id;
		},
		advance: (ms: number) => {
			vi.setSystemTime(Date.now() + ms);
		},
	};
}

describe("voice write-before repeat gate (Lead ruling, upstream ordering limit)", () => {
	it("blocks the repeated original request after a succeeded write with a late handoff and speaks the confirmation", async () => {
		const h = harness();
		expect((await h.broker.execute(update(ids[0]!))).status).toBe("succeeded");
		h.gate!.turnEnded("entry-1");
		// The handoff for her first request arrives late; she repeats the same words.
		h.setEntry("entry-2");
		h.advance(30_000);
		const repeated = await h.broker.execute(update(ids[1]!));
		expect(h.execute).toHaveBeenCalledTimes(1);
		expect(repeated).toMatchObject({
			requestId: ids[1],
			status: "rejected",
			errorCode: "duplicate_recent_write",
			data: {
				spokenText:
					"这件刚才已经做了：Linear 上 FLY-2886 已更新，要再做一次吗？",
				duplicateOf: { requestId: ids[0], outcome: "succeeded" },
			},
		});
		expect(
			journal!.operationReceipts.get({
				projectName: scope.projectName,
				leadId: scope.leadId,
				operationId: "linear.issue.update",
				requestId: ids[1]!,
			}),
		).toBeUndefined();
	});

	it("writes exactly once more with a different requestId only after her explicit redo reply", async () => {
		const h = harness();
		await h.broker.execute(update(ids[0]!));
		h.gate!.turnEnded("entry-1");
		h.setEntry("entry-2");
		expect((await h.broker.execute(update(ids[1]!))).errorCode).toBe(
			"duplicate_recent_write",
		);
		h.gate!.turnEnded("entry-2");
		h.gate!.observeFounderUtterance("要，再做一次");
		h.setEntry("entry-3");
		const again = await h.broker.execute(update(ids[2]!));
		expect(again).toMatchObject({ requestId: ids[2], status: "succeeded" });
		expect(h.execute).toHaveBeenCalledTimes(2);
		expect(ids[2]).not.toBe(ids[0]);
		// The confirmation is consumed by that single write.
		const third = await h.broker.execute(update(ids[3]!));
		expect(third.errorCode).toBe("duplicate_recent_write");
		expect(h.execute).toHaveBeenCalledTimes(2);
	});

	it("writes normally when the normalized key parameters differ", async () => {
		const h = harness();
		await h.broker.execute(update(ids[0]!, "done"));
		h.setEntry("entry-2");
		const other = await h.broker.execute(update(ids[1]!, "in_progress"));
		expect(other.status).toBe("succeeded");
		expect(h.execute).toHaveBeenCalledTimes(2);
	});

	it("uses the unknown wording while the earlier dispatched write has no terminal proof", async () => {
		const h = harness(() => ({ status: "unknown" }));
		expect((await h.broker.execute(update(ids[0]!))).status).toBe("unknown");
		h.setEntry("entry-2");
		const repeated = await h.broker.execute(update(ids[1]!));
		expect(h.execute).toHaveBeenCalledTimes(1);
		expect(repeated).toMatchObject({
			status: "rejected",
			errorCode: "duplicate_recent_write",
			data: {
				spokenText: "这件刚才已经发出去了，结果还在核对，要再发一次吗？",
				duplicateOf: { requestId: ids[0], outcome: "unknown" },
			},
		});
	});

	it.each([
		["她沉默", undefined],
		["其他回答", "先不用了"],
		["无关请求", "帮我查一下 FLY-100 的状态"],
		["否定", "不要再做"],
	])("never writes again on %s", async (_label, reply) => {
		const h = harness();
		await h.broker.execute(update(ids[0]!));
		h.gate!.turnEnded("entry-1");
		h.setEntry("entry-2");
		await h.broker.execute(update(ids[1]!));
		h.gate!.turnEnded("entry-2");
		if (reply) h.gate!.observeFounderUtterance(reply);
		h.setEntry("entry-3");
		expect((await h.broker.execute(update(ids[2]!))).errorCode).toBe(
			"duplicate_recent_write",
		);
		expect(h.execute).toHaveBeenCalledTimes(1);
	});

	it("does not treat words spoken before the confirmation could be heard as her answer", async () => {
		const h = harness();
		await h.broker.execute(update(ids[0]!));
		h.setEntry("entry-2");
		await h.broker.execute(update(ids[1]!));
		// The blocking turn has not ended, so its question has not been spoken yet.
		h.gate!.observeFounderUtterance("再做一次");
		h.gate!.turnEnded("entry-2");
		h.setEntry("entry-3");
		expect((await h.broker.execute(update(ids[2]!))).errorCode).toBe(
			"duplicate_recent_write",
		);
		expect(h.execute).toHaveBeenCalledTimes(1);
	});

	it("only looks back ten minutes", async () => {
		const h = harness();
		await h.broker.execute(update(ids[0]!));
		h.setEntry("entry-2");
		h.advance(VOICE_REPEAT_WINDOW_MS + 1);
		expect((await h.broker.execute(update(ids[1]!))).status).toBe("succeeded");
		expect(h.execute).toHaveBeenCalledTimes(2);
	});

	it("excludes the per-attempt business idempotency key from the key parameters", async () => {
		const h = harness(() => ({
			status: "succeeded",
			providerRef: "runner:e1",
			data: {
				result: {
					outcome: "started",
					idempotencyKey: "k1",
					source: "bridge",
					sourceRef: null,
				},
				receiptId: "r1",
				observedAt: "2026-09-26T00:00:00.000Z",
			},
		}));
		const start = (requestId: string, idempotencyKey: string) => ({
			schemaVersion: 1 as const,
			operationId: "start_runner",
			requestId,
			input: { issueId: "FLY-2886", taskCategory: "code", idempotencyKey },
		});
		await h.broker.execute(start(ids[0]!, "attempt-1"));
		h.setEntry("entry-2");
		const repeated = await h.broker.execute(start(ids[1]!, "attempt-2"));
		expect(repeated.errorCode).toBe("duplicate_recent_write");
		expect(h.execute).toHaveBeenCalledTimes(1);
	});

	it("leaves read capabilities and same-requestId replays untouched", async () => {
		const h = harness(() => ({
			status: "succeeded",
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
		const read = (requestId: string) => ({
			schemaVersion: 1 as const,
			operationId: "linear.issue.get",
			requestId,
			input: { issueId: "FLY-2886" },
		});
		expect((await h.broker.execute(read(ids[0]!))).status).toBe("succeeded");
		expect((await h.broker.execute(read(ids[1]!))).status).toBe("succeeded");
		await h.broker.execute(update(ids[2]!));
		const replay = await h.broker.execute(update(ids[2]!));
		expect(replay).toMatchObject({ status: "succeeded", requestId: ids[2] });
		expect(replay.errorCode).toBeUndefined();
		expect(h.execute).toHaveBeenCalledTimes(3);
	});

	it("keeps a broker without the voice gate byte-for-byte on its existing write path", async () => {
		const h = harness(undefined, { gate: false });
		await h.broker.execute(update(ids[0]!));
		await h.broker.execute(update(ids[1]!));
		expect(h.execute).toHaveBeenCalledTimes(2);
	});
});

describe("voice repeat gate primitives", () => {
	it("normalizes key parameters but keeps capability and target distinct", () => {
		const base = voiceRepeatFingerprint({
			operationId: "linear.issue.update",
			targetKey: "flywheel:linear:fly-2886",
			input: { issueId: "FLY-2886", stateId: "done" },
		});
		expect(
			voiceRepeatFingerprint({
				operationId: "linear.issue.update",
				targetKey: "flywheel:linear:fly-2886",
				input: { stateId: " done ", issueId: "fly-2886" },
			}),
		).toBe(base);
		expect(
			voiceRepeatFingerprint({
				operationId: "linear.comment.create",
				targetKey: "flywheel:linear:fly-2886",
				input: { issueId: "FLY-2886", stateId: "done" },
			}),
		).not.toBe(base);
		expect(
			voiceRepeatFingerprint({
				operationId: "linear.issue.update",
				targetKey: "flywheel:linear:fly-2887",
				input: { issueId: "FLY-2886", stateId: "done" },
			}),
		).not.toBe(base);
	});

	it.each([
		["要", true],
		["要的。", true],
		["嗯，要", true],
		["对，再做一次", true],
		["再发一次吧", true],
		["好，重新做", true],
		["要再做一次", true],
		["不要", false],
		["不用再做了", false],
		["算了", false],
		["先别发", false],
		["好的我知道了，那 FLY-100 呢", false],
		["", false],
	])("classifies %j as explicit redo=%s", (text, expected) => {
		expect(isExplicitRepeatConfirmation(text)).toBe(expected);
	});
});
