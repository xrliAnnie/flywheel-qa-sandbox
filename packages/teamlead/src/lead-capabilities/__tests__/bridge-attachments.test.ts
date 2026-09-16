import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { LeadArtifactStore } from "../artifacts.js";
import { decodeAttachmentUpload } from "../attachment-upload.js";
import { createBridgeAttachmentHandlers } from "../handlers/bridge-attachments.js";

vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({ assertActivationCurrent: () => {} }),
}));
it("imports verified response bytes as owned artifacts and refuses mismatched receipts or secrets", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "attachment-parent-"))),
		artifactRoot = join(root, "artifacts");
	mkdirSync(artifactRoot, { mode: 0o700 });
	const store = new LeadArtifactStore({
		projectRoot: root,
		artifactRoot,
		assertCurrent: () => {},
	});
	const requestId = randomUUID(),
		context = {
			projectName: "demo",
			leadId: "eng",
			activationId: "a1",
			requestId,
			signal: AbortSignal.timeout(15000),
			assertCurrent: async () => {},
		};
	let value = "hello",
		receipt = requestId,
		mime = "application/octet-stream";
	const fetchImpl = vi.fn<typeof fetch>(
		async () =>
			new Response(value, {
				headers: {
					"content-length": String(Buffer.byteLength(value)),
					"x-flywheel-request-id": receipt,
					"x-flywheel-artifact-mime": mime,
					"x-flywheel-artifact-sha256": createHash("sha256")
						.update(value)
						.digest("hex"),
				},
			}),
	);
	const handlers = createBridgeAttachmentHandlers({
		env: {
			FLYWHEEL_PROJECT_NAME: "demo",
			FLYWHEEL_LEAD_ID: "eng",
			FLYWHEEL_API_TOKEN: "API_SECRET",
			FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "CLAIM_SECRET",
			FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9999",
			FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
		},
		activationId: "a1",
		store,
		secrets: [],
		fetchImpl,
	});
	const handler = handlers.get("discord.message.attachments.get")!,
		input = {
			threadId: "111111111111111111",
			messageId: "222222222222222222",
			attachmentId: "333333333333333333",
		};
	try {
		const result = await handler.execute(input, context);
		expect(result.status).toBe("succeeded");
		expect(
			(
				await store.read(
					(result.data as { artifactHandle: string }).artifactHandle,
				)
			).data.toString(),
		).toBe("hello");
		expect(String(fetchImpl.mock.calls[0]![0])).toBe(
			"http://127.0.0.1:9999/api/lead-capabilities/discord",
		);
		receipt = randomUUID();
		expect((await handler.execute(input, context)).status).toBe("unknown");
		receipt = requestId;
		value = "API_SECRET";
		mime = "text/plain";
		expect((await handler.execute(input, context)).status).toBe("unknown");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("handles cancellation during attachment authorization without an unhandled rejection", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "attachment-abort-"))),
		artifactRoot = join(root, "artifacts");
	mkdirSync(artifactRoot, { mode: 0o700 });
	const store = new LeadArtifactStore({
		projectRoot: root,
		artifactRoot,
		assertCurrent: () => {},
	});
	const controller = new AbortController();
	let release!: () => void;
	const authorizing = new Promise<void>((resolve) => {
		release = resolve;
	});
	const prior = process.listeners("unhandledRejection");
	process.removeAllListeners("unhandledRejection");
	const unhandled: unknown[] = [];
	process.on("unhandledRejection", (reason) => unhandled.push(reason));
	try {
		const handler = createBridgeAttachmentHandlers({
			env: {
				FLYWHEEL_PROJECT_NAME: "demo",
				FLYWHEEL_LEAD_ID: "eng",
				FLYWHEEL_API_TOKEN: "API_SECRET",
				FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "CLAIM_SECRET",
				FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9999",
				FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
			},
			activationId: "a1",
			store,
			secrets: [],
			fetchImpl: vi.fn<typeof fetch>(),
		}).get("discord.message.attachments.get")!;
		const running = handler.execute(
			{
				threadId: "111111111111111111",
				messageId: "222222222222222222",
				attachmentId: "333333333333333333",
			},
			{
				projectName: "demo",
				leadId: "eng",
				activationId: "a1",
				requestId: randomUUID(),
				signal: controller.signal,
				assertCurrent: async () => authorizing,
			},
		);
		await Promise.resolve();
		controller.abort();
		await new Promise((resolve) => setImmediate(resolve));
		release();
		expect((await running).status).toBe("unknown");
		await new Promise((resolve) => setImmediate(resolve));
		expect(unhandled).toEqual([]);
	} finally {
		process.removeAllListeners("unhandledRejection");
		for (const listener of prior) process.on("unhandledRejection", listener);
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("uploads only verified handles and reconciles through receipt-only result lookup", async () => {
	const root = realpathSync(
			mkdtempSync(join(tmpdir(), "attachment-send-parent-")),
		),
		artifactRoot = join(root, "artifacts");
	mkdirSync(artifactRoot, { mode: 0o700 });
	const store = new LeadArtifactStore({
		projectRoot: root,
		artifactRoot,
		assertCurrent: () => {},
	});
	const context = {
		projectName: "demo",
		leadId: "eng",
		activationId: "a1",
		requestId: randomUUID(),
		signal: new AbortController().signal,
		assertCurrent: async () => {},
	};
	const env = {
		FLYWHEEL_PROJECT_NAME: "demo",
		FLYWHEEL_LEAD_ID: "eng",
		FLYWHEEL_API_TOKEN: "API_SECRET",
		FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "CLAIM_SECRET",
		FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9999",
		FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
	};
	const envelopes: Record<string, unknown>[] = [];
	let wrongReceipt = false;
	const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
		expect(url).toBe(
			"http://127.0.0.1:9999/api/lead-capabilities/discord/attachments",
		);
		expect(init!.redirect).toBe("error");
		const decoded = decodeAttachmentUpload(
			Buffer.from(init!.body as Uint8Array),
		);
		envelopes.push(decoded.envelope as Record<string, unknown>);
		expect(decoded.files[0]!.data.toString()).toBe("hello");
		expect(new Headers(init!.headers).get("authorization")).toBe(
			"Bearer API_SECRET",
		);
		return Response.json({
			requestId: wrongReceipt ? randomUUID() : context.requestId,
			status: "succeeded",
			resourceRefs: ["discord-message:222222222222222222"],
			data: {
				messageId: "222222222222222222",
				receiptId: context.requestId,
				observedAt: new Date().toISOString(),
			},
		});
	});
	try {
		const artifact = await store.put(Buffer.from("hello"), "text/plain");
		const handler = createBridgeAttachmentHandlers({
			env,
			activationId: "a1",
			store,
			secrets: [],
			fetchImpl,
		}).get("discord.message.attachments.send")!;
		const input = {
			threadId: "111111111111111111",
			artifactHandles: [artifact.handle],
			text: "report",
		};
		expect((await handler.execute(input, context)).status).toBe("succeeded");
		expect(envelopes[0]!.receiptOnly).toBe(false);
		const receipt = {
			projectName: "demo",
			leadId: "eng",
			activationId: "a1",
			requestId: context.requestId,
			operationId: "discord.message.attachments.send",
			inputDigest: "a".repeat(64),
			state: "unknown" as const,
			providerRef: null,
			errorCode: null,
			startedAt: 1,
			updatedAt: 1,
		};
		expect((await handler.reconcile!(receipt, input, context)).status).toBe(
			"succeeded",
		);
		expect(envelopes[1]!.receiptOnly).toBe(true);
		wrongReceipt = true;
		expect((await handler.execute(input, context)).status).toBe("unknown");
		const calls = fetchImpl.mock.calls.length;
		expect(
			(
				await handler.execute(
					{ ...input, artifactHandles: ["unknown"] },
					context,
				)
			).status,
		).toBe("unknown");
		expect(
			(await handler.execute({ ...input, text: "API_SECRET" }, context)).status,
		).toBe("unknown");
		expect(fetchImpl.mock.calls.length).toBe(calls);
		const secretArtifact = await store.put(
			Buffer.from("CLAIM_SECRET"),
			"text/plain",
		);
		expect(
			(
				await handler.execute(
					{ ...input, artifactHandles: [secretArtifact.handle] },
					context,
				)
			).status,
		).toBe("unknown");
		expect(fetchImpl.mock.calls.length).toBe(calls);
		const controller = new AbortController();
		fetchImpl.mockImplementation(() => new Promise(() => {}));
		const pending = handler.execute(input, {
			...context,
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(fetchImpl.mock.calls.length).toBe(calls + 1));
		controller.abort();
		expect((await pending).status).toBe("unknown");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
