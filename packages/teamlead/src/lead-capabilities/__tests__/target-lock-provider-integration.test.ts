import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readVoiceTargetTerminalProof } from "../../bridge/voice-target-reconcile.js";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { StateStore } from "../../StateStore.js";
import { LeadArtifactStore } from "../artifacts.js";
import {
	type HandlerOutcome,
	LeadCapabilityBroker,
	type LeadOperationHandler,
} from "../broker.js";
import { createBrowserHandlers } from "../handlers/browser.js";
import type { LeadTargetLockClient } from "../target-lock-client.js";

const SESSION = "a0000000-0000-4000-8000-000000000001";
const GENERATION = "b0000000-0000-4000-8000-000000000001";
const requestId = (n: number) =>
	`c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const disposals: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposals.splice(0).reverse()) await dispose();
	vi.useRealTimers();
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
async function observed(check: () => boolean) {
	for (let n = 0; n < 200; n++) {
		if (check()) return;
		await Promise.resolve();
	}
	throw new Error("expected async boundary was not reached");
}
const success = (): HandlerOutcome => ({
	status: "succeeded",
	providerRef: "message:456",
	data: {
		threadId: "123",
		messageId: "456",
		receiptId: "receipt",
		observedAt: "2026-09-26T00:00:00.000Z",
	},
});
const request = (n: number) => ({
	schemaVersion: 1,
	operationId: "discord.thread.reply",
	requestId: requestId(n),
	input: { threadId: "123", text: "new value" },
});
async function fixture() {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "voice-target-integration-")),
	);
	disposals.push(() => rmSync(root, { recursive: true, force: true }));
	let store = await StateStore.create(join(root, "teamlead.db"));
	disposals.push(() => store.close());
	const journalRoot = join(root, "voice-capability", SESSION);
	mkdirSync(journalRoot, { recursive: true, mode: 0o700 });
	const voiceJournal = new SqliteJournalStore(join(journalRoot, "journal.db"));
	const residentJournal = new SqliteJournalStore(join(root, "resident.db"));
	disposals.push(
		() => voiceJournal.close(),
		() => residentJournal.close(),
	);
	let enabled = true;
	const acquisitions: Array<{
		actor: string;
		status: string;
		requestId: string;
	}> = [];
	const locks = (
		actor: "voice" | "resident",
		activationId: string,
	): LeadTargetLockClient => ({
		actor,
		acquire: async (input) => {
			input.signal.throwIfAborted();
			const result = store.acquireCapabilityTargetLock({
				...input,
				actor,
				activationId,
				projectName: "flywheel",
				leadId: "eng",
				now: Date.now(),
				checkOnly: actor === "resident" && !enabled,
			});
			acquisitions.push({
				actor,
				status: result.status,
				requestId: input.requestId,
			});
			return result;
		},
		markDispatched: async (input) =>
			store.markCapabilityTargetLockDispatched({
				...input,
				activationId,
				now: Date.now(),
			}),
		release: async (input) => {
			store.releaseCapabilityTargetLock({ ...input, activationId });
		},
		cancel: async (input) => {
			store.cancelCapabilityTargetLockWaiter({ ...input, activationId });
		},
	});
	const makeBroker = (
		actor: "voice" | "resident",
		handler: LeadOperationHandler,
		operationId = "discord.thread.reply",
	) => {
		const activationId =
			actor === "voice" ? `voice:${SESSION}` : "resident:one";
		const broker = new LeadCapabilityBroker({
			projectName: "flywheel",
			leadId: "eng",
			activationId,
			receipts: (actor === "voice" ? voiceJournal : residentJournal)
				.operationReceipts,
			allowedOperationIds: () => new Set([operationId]),
			assertCurrent: async () => {
				if (actor === "voice" && !enabled) throw new Error("voice_disabled");
			},
			handlers: new Map([[operationId, handler]]),
			secrets: [],
			targetLocks: locks(actor, activationId),
		});
		disposals.push(() => broker.close());
		return broker;
	};
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	vi.setSystemTime(new Date("2026-09-26T00:00:00Z"));
	return {
		root,
		get store() {
			return store;
		},
		voiceJournal,
		residentJournal,
		acquisitions,
		locks,
		makeBroker,
		disable() {
			enabled = false;
		},
		async restartBridge() {
			store.close();
			store = await StateStore.create(join(root, "teamlead.db"));
		},
		voiceReceipt(n: number, operationId = "discord.thread.reply") {
			return voiceJournal.operationReceipts.get({
				projectName: "flywheel",
				leadId: "eng",
				operationId,
				requestId: requestId(n),
			});
		},
	};
}

describe("target lock provider and durable state integration", () => {
	it("keeps rollback draining until the timed-out original provider settles, then permits the resident's later write", async () => {
		const h = await fixture();
		const provider = deferred<HandlerOutcome>();
		let remoteValue = "old";
		const execute = vi.fn(async () => {
			const result = await provider.promise;
			remoteValue = "voice";
			return result;
		});
		const voice = h.makeBroker("voice", { authorize: async () => {}, execute });
		const residentExecute = vi.fn(async () => {
			remoteValue = "resident";
			return success();
		});
		const resident = h.makeBroker("resident", {
			authorize: async () => {},
			execute: residentExecute,
		});
		const pending = voice.execute(request(1));
		await observed(() => execute.mock.calls.length === 1);
		const targetKey = h.voiceReceipt(1)!.targetKey!;
		expect(
			h.store.getCapabilityTargetLock(targetKey)?.dispatchedAt,
		).not.toBeNull();
		await vi.advanceTimersByTimeAsync(15_001);
		expect(await pending).toMatchObject({
			status: "unknown",
			errorCode: "operation_timeout",
		});
		h.disable();
		expect(await resident.execute(request(2))).toMatchObject({
			status: "rejected",
			errorCode: "target_pending_reconcile",
		});
		expect(residentExecute).not.toHaveBeenCalled();
		expect(remoteValue).toBe("old");
		const lock = h.store.getCapabilityTargetLock(targetKey)!;
		// Reading the unchanged resource cannot manufacture old-request terminal evidence.
		expect(readVoiceTargetTerminalProof(h.root, lock)).toBeNull();
		expect(h.store.getCapabilityTargetLock(targetKey)?.state).toBe("unknown");
		provider.resolve(success());
		await observed(
			() =>
				h.voiceReceipt(1)?.state === "succeeded" &&
				!h.store.getCapabilityTargetLock(targetKey),
		);
		expect(remoteValue).toBe("voice");
		expect(readVoiceTargetTerminalProof(h.root, lock)).toMatchObject({
			outcome: "succeeded",
			providerRef: "message:456",
		});
		expect(await resident.execute(request(3))).toMatchObject({
			status: "succeeded",
		});
		expect(remoteValue).toBe("resident");
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("retains unknown when transport aborts although the remote later commits without a success response", async () => {
		const h = await fixture();
		const provider = deferred<HandlerOutcome>();
		const execute = vi.fn(() => provider.promise);
		const voice = h.makeBroker("voice", { authorize: async () => {}, execute });
		const pending = voice.execute(request(4));
		await observed(() => execute.mock.calls.length === 1);
		await voice.close();
		expect(await pending).toMatchObject({
			status: "unknown",
			errorCode: "broker_closed",
		});
		provider.reject(new Error("connection_aborted"));
		await Promise.resolve();
		const targetKey = h.voiceReceipt(4)!.targetKey!;
		expect(
			readVoiceTargetTerminalProof(
				h.root,
				h.store.getCapabilityTargetLock(targetKey)!,
			),
		).toBeNull();
		h.disable();
		const resident = h.makeBroker("resident", {
			authorize: async () => {},
			execute: async () => success(),
		});
		expect(await resident.execute(request(5))).toMatchObject({
			errorCode: "target_pending_reconcile",
		});
		expect(h.voiceReceipt(4)?.state).toBe("unknown");
	});

	it("removes a canceled resident waiter so it cannot block the next voice write", async () => {
		const h = await fixture();
		const provider = deferred<HandlerOutcome>();
		const execute = vi.fn(() => provider.promise);
		const voice = h.makeBroker("voice", { authorize: async () => {}, execute });
		const pendingVoice = voice.execute(request(6));
		await observed(() => execute.mock.calls.length === 1);
		const resident = h.makeBroker("resident", {
			authorize: async () => {},
			execute: async () => success(),
		});
		const pendingResident = resident.execute(request(7));
		await observed(() =>
			h.acquisitions.some(
				(row) => row.requestId === requestId(7) && row.status === "waiting",
			),
		);
		await resident.close();
		expect(await pendingResident).toMatchObject({
			status: "rejected",
			errorCode: "broker_closed",
		});
		provider.resolve(success());
		expect(await pendingVoice).toMatchObject({ status: "succeeded" });
		expect(await voice.execute(request(8))).toMatchObject({
			status: "succeeded",
		});
	});

	it("clears abandoned waiters across Bridge restart while preserving the dispatched holder", async () => {
		const h = await fixture();
		const provider = deferred<HandlerOutcome>();
		const execute = vi.fn(() => provider.promise);
		const voice = h.makeBroker("voice", { authorize: async () => {}, execute });
		const pendingVoice = voice.execute(request(9));
		await observed(() => execute.mock.calls.length === 1);
		const targetKey = h.voiceReceipt(9)!.targetKey!;
		const original = h.store.getCapabilityTargetLock(targetKey)!;
		expect(
			await h
				.locks("resident", "resident:crashed")
				.acquire({
					operationId: "discord.thread.reply",
					requestId: requestId(10),
					targetKey,
					deadline: Date.now() + 15_000,
					signal: new AbortController().signal,
				}),
		).toMatchObject({ status: "waiting" });
		await h.restartBridge();
		expect(h.store.getCapabilityTargetLock(targetKey)).toMatchObject({
			fence: original.fence,
			dispatchedAt: original.dispatchedAt,
		});
		provider.resolve(success());
		expect(await pendingVoice).toMatchObject({ status: "succeeded" });
		expect(await voice.execute(request(11))).toMatchObject({
			status: "succeeded",
		});
	});

	it("preserves a late browser success as receipt evidence even after the output-delivery guard is revoked", async () => {
		const h = await fixture();
		const provider = deferred<{ result: unknown }>();
		const call = vi.fn(() => provider.promise);
		const artifactRoot = join(h.root, "artifacts");
		mkdirSync(artifactRoot, { mode: 0o700 });
		const artifacts = new LeadArtifactStore({
			projectRoot: h.root,
			artifactRoot,
			assertCurrent() {},
		});
		disposals.push(() => artifacts.close());
		const handler = createBrowserHandlers({
			activationId: `voice:${SESSION}`,
			generation: GENERATION,
			worker: { call },
			workerArtifactRoot: artifactRoot,
			store: artifacts,
			assertCurrent() {},
		}).get("browser.click")!;
		const voice = h.makeBroker("voice", handler, "browser.click");
		const pending = voice.execute({
			schemaVersion: 1,
			operationId: "browser.click",
			requestId: requestId(12),
			input: { generation: GENERATION, arguments: { uid: "button" } },
		});
		await observed(() => call.mock.calls.length === 1);
		await vi.advanceTimersByTimeAsync(15_001);
		expect(await pending).toMatchObject({ status: "unknown" });
		h.disable();
		const targetKey = h.voiceReceipt(12, "browser.click")!.targetKey!;
		provider.resolve({
			result: { content: [{ type: "text", text: "clicked" }] },
		});
		await observed(
			() => h.voiceReceipt(12, "browser.click")?.state === "succeeded",
		);
		expect(h.store.getCapabilityTargetLock(targetKey)).toBeUndefined();
		expect(call).toHaveBeenCalledTimes(1);
	});
	it("does not classify a browser tool error response as terminal success", async () => {
		const h = await fixture();
		const artifactRoot = join(h.root, "artifacts");
		mkdirSync(artifactRoot, { mode: 0o700 });
		const artifacts = new LeadArtifactStore({
			projectRoot: h.root,
			artifactRoot,
			assertCurrent() {},
		});
		disposals.push(() => artifacts.close());
		const handler = createBrowserHandlers({
			activationId: `voice:${SESSION}`,
			generation: GENERATION,
			worker: {
				call: async () => ({
					result: {
						isError: true,
						content: [{ type: "text", text: "remote may have committed" }],
					},
				}),
			},
			workerArtifactRoot: artifactRoot,
			store: artifacts,
			assertCurrent() {},
		}).get("browser.click")!;
		const voice = h.makeBroker("voice", handler, "browser.click");
		expect(
			await voice.execute({
				schemaVersion: 1,
				operationId: "browser.click",
				requestId: requestId(13),
				input: { generation: GENERATION, arguments: { uid: "button" } },
			}),
		).toMatchObject({ status: "unknown" });
		const receipt = h.voiceReceipt(13, "browser.click")!;
		expect(receipt.state).toBe("unknown");
		expect(h.store.getCapabilityTargetLock(receipt.targetKey!)?.state).toBe(
			"unknown",
		);
	});
});
