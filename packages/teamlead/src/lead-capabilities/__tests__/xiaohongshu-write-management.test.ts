import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { LeadArtifactStore } from "../artifacts.js";
import type { LeadOperationContext } from "../broker.js";
import { createXhsWriteManagementHandlers } from "../handlers/xiaohongshu-write-management.js";
import type { OperationReceipt } from "../receipts.js";

vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({ assertActivationCurrent: () => {} }),
}));
const proposalId = randomUUID();
const prepared = {
	proposalId,
	contentDigest: "a".repeat(64),
	state: "awaiting_approval",
	expiresAt: 1789470000000,
	cardRef: null,
};
const context: LeadOperationContext = {
	requestId: randomUUID(),
	projectName: "demo",
	leadId: "eng",
	activationId: "a1",
	signal: new AbortController().signal,
	assertCurrent: async () => {},
};
const draft = {
	operationId: "xiaohongshu.like_feed",
	accountSelector: "account-a",
	payload: {},
	artifactHandles: [],
	resourceHandle: randomUUID(),
};
function setup() {
	const call = vi
		.fn<(...args: unknown[]) => Promise<unknown>>()
		.mockResolvedValue(prepared);
	const options = {
		env: { FLYWHEEL_PROJECT_NAME: "demo", FLYWHEEL_LEAD_ID: "eng" },
		activationId: "a1",
		client: {
			call,
			importArtifact: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
		},
		artifacts: { read: vi.fn<LeadArtifactStore["read"]>() },
	};
	return { call, options, handlers: createXhsWriteManagementHandlers(options) };
}
it("prepares with original envelope identity and recovers only by readonly request lookup", async () => {
	const s = setup(),
		handler = s.handlers.get("xiaohongshu.write.prepare")!;
	expect(await handler.execute(draft, context)).toMatchObject({
		status: "succeeded",
		providerRef: proposalId,
		data: prepared,
	});
	expect(s.call).toHaveBeenLastCalledWith(
		"prepare",
		expect.objectContaining({
			prepareRequestId: context.requestId,
			operationId: draft.operationId,
			accountSelector: draft.accountSelector,
			artifactIds: [],
			targetHandle: draft.resourceHandle,
		}),
		context.signal,
	);
	expect(
		await handler.reconcile!({} as OperationReceipt, draft, context),
	).toMatchObject({ status: "succeeded", providerRef: proposalId });
	expect(s.call).toHaveBeenLastCalledWith(
		"status",
		{ prepareRequestId: context.requestId },
		context.signal,
	);
	expect(s.call.mock.calls.map(([action]) => action)).toEqual([
		"prepare",
		"status",
	]);
});
it("status is read-only and cancellation recovery never cancels twice", async () => {
	const s = setup(),
		input = { proposalId };
	s.call.mockResolvedValue({
		proposalId,
		contentDigest: prepared.contentDigest,
		state: "revoked",
		expiresAt: prepared.expiresAt,
		attempt: null,
	});
	expect(
		await s.handlers.get("xiaohongshu.write.status")!.execute(input, context),
	).toMatchObject({ status: "succeeded" });
	s.call.mockResolvedValueOnce({ state: "revoked" });
	const cancel = s.handlers.get("xiaohongshu.write.cancel")!;
	expect(await cancel.execute(input, context)).toMatchObject({
		status: "succeeded",
		data: { state: "revoked" },
	});
	expect(
		await cancel.reconcile!({} as OperationReceipt, input, context),
	).toMatchObject({ status: "succeeded", data: { state: "revoked" } });
	expect(s.call.mock.calls.map(([action]) => action)).toEqual([
		"status",
		"cancel",
		"status",
	]);
});
it("rejects scope or schema injection before transport and keeps unavailable writes uncertain", async () => {
	const s = setup(),
		handler = s.handlers.get("xiaohongshu.write.prepare")!;
	for (const input of [
		{ ...draft, projectId: "other" },
		{ ...draft, payload: { xsec_token: "secret" } },
		{ ...draft, artifactHandles: ["/tmp/file"] },
	])
		await expect(handler.execute(input, context)).rejects.toThrow();
	await expect(
		handler.execute(draft, { ...context, activationId: "other" }),
	).rejects.toThrow();
	expect(s.call).not.toHaveBeenCalled();
	s.call.mockRejectedValue(Error("lost"));
	expect(await handler.execute(draft, context)).toMatchObject({
		status: "unknown",
	});
	expect(
		await createXhsWriteManagementHandlers({ ...s.options, client: null })
			.get("xiaohongshu.write.prepare")!
			.execute(draft, context),
	).toMatchObject({
		status: "rejected",
		errorCode: "founder_write_gate_absent",
	});
});
it("uses real broker receipts for preparation and read-only recovery", async () => {
	const { LeadCapabilityBroker } = await import("../broker.js");
	const { SqliteJournalStore } = await import(
		"../../lead-backends/codex/SqliteJournalStore.js"
	);
	const s = setup(),
		store = new SqliteJournalStore(":memory:");
	const broker = new LeadCapabilityBroker({
		projectName: "demo",
		leadId: "eng",
		activationId: "a1",
		handlers: s.handlers,
		receipts: store.operationReceipts,
		allowedOperationIds: () => new Set(s.handlers.keys()),
		assertCurrent: async () => {},
		secrets: [],
	});
	const request = {
		schemaVersion: 1,
		operationId: "xiaohongshu.write.prepare",
		requestId: context.requestId,
		input: draft,
	};
	try {
		s.call.mockRejectedValueOnce(Error("lost preparation response"));
		expect(await broker.execute(request)).toMatchObject({ status: "unknown" });
		expect(await broker.execute(request)).toMatchObject({
			status: "succeeded",
			resourceRefs: [proposalId],
			data: prepared,
		});
		expect(await broker.execute(request)).toMatchObject({
			status: "succeeded",
		});
		expect(s.call.mock.calls.map(([action]) => action)).toEqual([
			"prepare",
			"status",
		]);
	} finally {
		store.close();
	}
});

it("reads only registered parent handles, uploads in order and passes authority IDs to prepare", async () => {
	const root = realpathSync(mkdtempSync("/tmp/xhs-parent-media-")),
		artifactRoot = join(root, "artifacts");
	mkdirSync(artifactRoot, { mode: 0o700 });
	const store = new LeadArtifactStore({
		projectRoot: root,
		artifactRoot,
		assertCurrent: () => {},
	});
	const s = setup();
	const first = await store.put(Buffer.from("first"), "image/png");
	const second = await store.put(Buffer.from("second"), "image/jpeg");
	const ids = [randomUUID(), randomUUID()];
	s.options.client.importArtifact.mockImplementation(async (input) => {
		const item = input as { data: Buffer; mimeType: string };
		const known = item.data.toString() === "first" ? first : second;
		return {
			artifactId: known === first ? ids[0] : ids[1],
			mimeType: known.mimeType,
			sizeBytes: known.size,
			sha256: known.sha256,
		};
	});
	const handler = createXhsWriteManagementHandlers({
		...s.options,
		artifacts: store,
	}).get("xiaohongshu.write.prepare")!;
	const input = {
		...draft,
		operationId: "xiaohongshu.publish_content",
		artifactHandles: [second.handle, first.handle],
	};
	try {
		expect(await handler.execute(input, context)).toMatchObject({
			status: "succeeded",
		});
		expect(
			s.options.client.importArtifact.mock.calls.map(([value]) =>
				(value as { data: Buffer }).data.toString(),
			),
		).toEqual(["second", "first"]);
		expect(s.call).toHaveBeenCalledWith(
			"prepare",
			expect.objectContaining({ artifactIds: [ids[1], ids[0]] }),
			context.signal,
		);
		s.call.mockClear();
		s.options.client.importArtifact.mockClear();
		expect(
			await handler.execute(
				{ ...input, artifactHandles: ["unknown-handle"] },
				context,
			),
		).toMatchObject({ status: "unknown" });
		expect(s.options.client.importArtifact).not.toHaveBeenCalled();
		expect(s.call).not.toHaveBeenCalled();
		writeFileSync(join(root, first.relativePath), Buffer.from("other"));
		expect(
			await handler.execute(
				{ ...input, artifactHandles: [first.handle] },
				context,
			),
		).toMatchObject({ status: "unknown" });
		expect(s.options.client.importArtifact).not.toHaveBeenCalled();
		expect(s.call).not.toHaveBeenCalled();
		const text = await store.put(Buffer.from("not media"), "text/plain");
		expect(
			await handler.execute(
				{ ...input, artifactHandles: [text.handle] },
				context,
			),
		).toMatchObject({ status: "unknown" });
		expect(s.options.client.importArtifact).not.toHaveBeenCalled();
		s.options.client.importArtifact.mockResolvedValueOnce({
			artifactId: ids[1],
			mimeType: second.mimeType,
			sizeBytes: second.size,
			sha256: "0".repeat(64),
		});
		expect(
			await handler.execute(
				{ ...input, artifactHandles: [second.handle] },
				context,
			),
		).toMatchObject({ status: "unknown" });
		expect(s.call).not.toHaveBeenCalled();
		const abort = new AbortController();
		s.options.client.importArtifact.mockImplementationOnce(async () => {
			abort.abort();
			return {
				artifactId: ids[1],
				mimeType: second.mimeType,
				sizeBytes: second.size,
				sha256: second.sha256,
			};
		});
		expect(
			await handler.execute(
				{ ...input, artifactHandles: [second.handle] },
				{ ...context, signal: abort.signal },
			),
		).toMatchObject({ status: "unknown" });
		expect(s.call).not.toHaveBeenCalled();
		const videoBytes = Buffer.from(
			"000000186674797069736f6d0000000069736f6d6d703432",
			"hex",
		);
		const video = await store.putVideo(
			(async function* () {
				yield videoBytes;
			})(),
		);
		const videoId = randomUUID();
		s.options.client.importArtifact.mockResolvedValueOnce({
			artifactId: videoId,
			mimeType: video.mimeType,
			sizeBytes: video.size,
			sha256: video.sha256,
		});
		expect(
			await handler.execute(
				{
					...input,
					operationId: "xiaohongshu.publish_with_video",
					artifactHandles: [video.handle],
				},
				context,
			),
		).toMatchObject({ status: "succeeded" });
		expect(s.options.client.importArtifact).toHaveBeenLastCalledWith(
			{ data: videoBytes, mimeType: "video/mp4" },
			context.signal,
		);
		expect(s.call).toHaveBeenLastCalledWith(
			"prepare",
			expect.objectContaining({
				operationId: "xiaohongshu.publish_with_video",
				artifactIds: [videoId],
			}),
			context.signal,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
