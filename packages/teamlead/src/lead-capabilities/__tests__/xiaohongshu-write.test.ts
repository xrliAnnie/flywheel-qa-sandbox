import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { WRITE_OPERATIONS } from "../../xiaohongshu-write/contracts.js";
import type { LeadOperationContext } from "../broker.js";
import { createXhsWriteHandlers } from "../handlers/xiaohongshu-write.js";
import type { OperationReceipt } from "../receipts.js";

const carrier = vi.hoisted(() => vi.fn());
vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({ assertActivationCurrent: carrier }),
}));
const input = {
	proposalId: randomUUID(),
	receiptId: randomUUID(),
	expectedContentDigest: "a".repeat(64),
};
const attemptId = randomUUID();
function setup() {
	carrier.mockReset();
	const call = vi
		.fn<(...args: unknown[]) => Promise<unknown>>()
		.mockResolvedValue({ kind: "attempt", attemptId, state: "succeeded" });
	const context: LeadOperationContext = {
		requestId: randomUUID(),
		projectName: "demo",
		leadId: "eng",
		activationId: "a1",
		signal: new AbortController().signal,
		assertCurrent: vi.fn(async () => {}),
	};
	const options = {
		env: { FLYWHEEL_PROJECT_NAME: "demo", FLYWHEEL_LEAD_ID: "eng" },
		activationId: "a1",
		client: { call },
		now: () => 1789460000000,
	};
	return { call, context, options, handlers: createXhsWriteHandlers(options) };
}
it("maps exactly six registered operations and preserves the caller execution identity", async () => {
	const s = setup();
	expect([...s.handlers.keys()]).toEqual([...WRITE_OPERATIONS]);
	for (const operationId of WRITE_OPERATIONS) {
		expect(
			await s.handlers.get(operationId)!.execute(input, s.context),
		).toMatchObject({
			status: "succeeded",
			providerRef: attemptId,
			data: {
				receiptId: input.receiptId,
				result: { attemptId, state: "succeeded" },
				untrusted: true,
			},
		});
		expect(s.call).toHaveBeenLastCalledWith(
			"execute",
			{
				proposalId: input.proposalId,
				receiptId: input.receiptId,
				contentDigest: input.expectedContentDigest,
				operationId,
				executeRequestId: s.context.requestId,
			},
			s.context.signal,
		);
	}
	expect(carrier).toHaveBeenCalledTimes(6);
});
it("retains no-receipt/default-off refusal and blocks stale carriers before authority calls", async () => {
	const s = setup(),
		handler = s.handlers.get("xiaohongshu.like_feed")!;
	expect(
		await handler.execute(
			{ feed_id: "feed", resourceHandle: "handle" },
			s.context,
		),
	).toMatchObject({
		status: "rejected",
		errorCode: "founder_write_gate_absent",
	});
	const disabled = createXhsWriteHandlers({ ...s.options, client: null });
	expect(
		await disabled.get("xiaohongshu.like_feed")!.execute(input, s.context),
	).toMatchObject({
		status: "rejected",
		errorCode: "founder_write_gate_absent",
	});
	await expect(
		handler.execute({ ...input, payload: "injected" }, s.context),
	).rejects.toThrow();
	await expect(
		handler.execute(input, { ...s.context, activationId: "other" }),
	).rejects.toThrow();
	carrier.mockImplementation(() => {
		throw Error("stale");
	});
	await expect(handler.execute(input, s.context)).rejects.toThrow();
	expect(s.call).not.toHaveBeenCalled();
});
it("treats lost execute responses as unknown and only queries the bound status to reconcile", async () => {
	const s = setup(),
		handler = s.handlers.get("xiaohongshu.like_feed")!;
	s.call.mockRejectedValueOnce(Error("private response lost"));
	expect(await handler.execute(input, s.context)).toMatchObject({
		status: "unknown",
	});
	expect(s.call).toHaveBeenCalledTimes(1);
	s.call.mockResolvedValue({
		proposalId: input.proposalId,
		contentDigest: input.expectedContentDigest,
		state: "consumed",
		expiresAt: 1789460100000,
		attempt: { attemptId, state: "succeeded-noop" },
	});
	expect(
		await handler.reconcile!({} as OperationReceipt, input, s.context),
	).toMatchObject({ status: "succeeded", providerRef: attemptId });
	expect(s.call).toHaveBeenLastCalledWith(
		"status",
		{
			proposalId: input.proposalId,
			receiptId: input.receiptId,
			contentDigest: input.expectedContentDigest,
			operationId: "xiaohongshu.like_feed",
		},
		s.context.signal,
	);
	expect(
		s.call.mock.calls.filter(([action]) => action === "execute"),
	).toHaveLength(1);
	s.call.mockResolvedValue({
		proposalId: input.proposalId,
		contentDigest: "b".repeat(64),
		state: "consumed",
		expiresAt: 1789460100000,
		attempt: { attemptId, state: "succeeded" },
	});
	expect(
		await handler.reconcile!({} as OperationReceipt, input, s.context),
	).toMatchObject({ status: "unknown" });
});
it("never labels pending or malformed authority responses successful", async () => {
	const s = setup(),
		handler = s.handlers.get("xiaohongshu.like_feed")!;
	for (const state of [
		"claimed",
		"dispatch-admitted",
		"dispatched",
		"unknown",
	]) {
		s.call.mockResolvedValue({ kind: "attempt", attemptId, state });
		expect(await handler.execute(input, s.context)).toMatchObject({
			status: "unknown",
		});
	}
	s.call.mockResolvedValue({
		kind: "attempt",
		attemptId,
		state: "succeeded",
		xsec_token: "private",
	});
	expect(await handler.execute(input, s.context)).toEqual({
		status: "unknown",
		errorCode: "provider_unknown",
	});
	s.call.mockResolvedValue({ kind: "attempt", attemptId, state: "failed" });
	expect(await handler.execute(input, s.context)).toMatchObject({
		status: "rejected",
	});
});

it("runs receipt inputs through the real catalog/broker and replays unknown results without executing twice", async () => {
	const { LeadCapabilityBroker } = await import("../broker.js");
	const { SqliteJournalStore } = await import(
		"../../lead-backends/codex/SqliteJournalStore.js"
	);
	const { getLeadCapability } = await import("../catalog.js");
	const s = setup(),
		store = new SqliteJournalStore(":memory:");
	const broker = new LeadCapabilityBroker({
		projectName: "demo",
		leadId: "eng",
		activationId: "a1",
		receipts: store.operationReceipts,
		allowedOperationIds: () => new Set(s.handlers.keys()),
		assertCurrent: async () => {},
		handlers: s.handlers,
		secrets: [],
	});
	const operationId = "xiaohongshu.like_feed";
	const request = {
		schemaVersion: 1,
		operationId,
		requestId: randomUUID(),
		input,
	};
	try {
		expect(
			getLeadCapability(operationId)!.inputSchema.safeParse(input).success,
		).toBe(true);
		for (const invalid of [
			{ ...input, feed_id: "mixed" },
			{ proposalId: input.proposalId },
			{ ...input, expectedContentDigest: "invalid" },
		])
			expect(
				getLeadCapability(operationId)!.inputSchema.safeParse(invalid).success,
			).toBe(false);
		s.call.mockRejectedValueOnce(Error("lost"));
		expect(await broker.execute(request)).toMatchObject({ status: "unknown" });
		s.call.mockResolvedValue({
			proposalId: input.proposalId,
			contentDigest: input.expectedContentDigest,
			state: "consumed",
			expiresAt: 1789460100000,
			attempt: { attemptId, state: "succeeded" },
		});
		expect(await broker.execute(request)).toMatchObject({
			status: "succeeded",
			resourceRefs: [attemptId],
		});
		expect(await broker.execute(request)).toMatchObject({
			status: "succeeded",
		});
		expect(s.call.mock.calls.map(([action]) => action)).toEqual([
			"execute",
			"status",
		]);
		expect(
			await broker.execute({
				...request,
				input: { ...input, expectedContentDigest: "c".repeat(64) },
			}),
		).toMatchObject({ status: "rejected", errorCode: "input_digest_conflict" });
		expect(s.call).toHaveBeenCalledTimes(2);
	} finally {
		store.close();
	}
});
