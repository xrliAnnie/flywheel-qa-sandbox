import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import {
	LeadCapabilityBroker,
	type LeadOperationHandler,
	leadOperationInputDigest,
} from "../broker.js";
import { PATROL_SNAPSHOT_CLIENT_TIMEOUT_MS } from "../patrol-timeouts.js";

const request = {
	schemaVersion: 1,
	operationId: "discord.thread.reply",
	requestId: "123e4567-e89b-42d3-a456-426614174000",
	input: { threadId: "123", text: "hello" },
};
const output = {
	threadId: "123",
	messageId: "456",
	receiptId: "receipt",
	observedAt: "2026-09-13T00:00:00.000Z",
};
const stores: SqliteJournalStore[] = [];
const roots: string[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
	vi.useRealTimers();
});
function setup(handler?: Partial<LeadOperationHandler>, path = ":memory:") {
	const store = new SqliteJournalStore(path);
	stores.push(store);
	const execute = vi.fn(async () => ({
		status: "succeeded" as const,
		providerRef: "message:456",
		data: output,
	}));
	const assertCurrent = vi.fn(async () => {});
	const allowed = new Set([request.operationId]);
	const broker = new LeadCapabilityBroker({
		projectName: "flywheel",
		leadId: "product",
		activationId: "a1",
		receipts: store.operationReceipts,
		allowedOperationIds: () => allowed,
		assertCurrent,
		handlers: new Map([
			[request.operationId, { authorize: async () => {}, execute, ...handler }],
		]),
		secrets: ["CANARY_SECRET"],
	});
	return { broker, store, execute, assertCurrent, allowed };
}
describe("trusted operation broker engine", () => {
	it("preserves the nonsecret baseline drift failure without exposing provider details", async () => {
		const { broker } = setup({
			execute: async () => ({ status: "unknown", errorCode: "baseline_drift" }),
		});
		expect(await broker.execute(request)).toMatchObject({
			status: "unknown",
			errorCode: "baseline_drift",
			resourceRefs: [],
		});
		await broker.close();
	});

	it("binds the validated request UUID into the trusted handler context", async () => {
		let observed: unknown;
		const { broker } = setup({
			execute: async (_input, context) => {
				observed = context;
				return { status: "succeeded", providerRef: "456", data: output };
			},
		});
		await broker.execute(request);
		expect(observed).toMatchObject({
			requestId: request.requestId,
			projectName: "flywheel",
			leadId: "product",
			activationId: "a1",
		});
	});
	it("executes a validated write once and canonicalizes parsed input for retries", async () => {
		const { broker, execute, store } = setup();
		expect((await broker.execute(request)).status).toBe("succeeded");
		expect(
			(
				await broker.execute({
					...request,
					input: { text: "hello", threadId: "123" },
				})
			).status,
		).toBe("succeeded");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(
			(
				await broker.execute({
					...request,
					input: { threadId: "123", text: "changed" },
				})
			).errorCode,
		).toBe("input_digest_conflict");
		expect(
			store.operationReceipts.get({
				projectName: "flywheel",
				leadId: "product",
				operationId: request.operationId,
				requestId: request.requestId,
			})?.state,
		).toBe("succeeded");
	});
	it("rejects malformed oversized unknown reserved and exact-input violations without side effects", async () => {
		const { broker, execute } = setup();
		for (const invalid of [
			{ ...request, requestId: "bad" },
			{ ...request, token: "secret" },
			{ ...request, operationId: "bridge.raw" },
			{ ...request, operationId: "bridge.ship" },
			{ ...request, input: { ...request.input, url: "evil" } },
			"x".repeat(65537),
		])
			expect((await broker.execute(invalid)).status).toBe("rejected");
		expect(execute).not.toHaveBeenCalled();
	});
	it("rechecks current activation and manifest after asynchronous authorization", async () => {
		let revoke = () => {};
		const { broker, execute, allowed } = setup({
			authorize: async () => {
				revoke();
			},
		});
		revoke = () => allowed.clear();
		expect((await broker.execute(request)).errorCode).toBe(
			"capability_revoked",
		);
		expect(execute).not.toHaveBeenCalled();
		const stale = setup();
		stale.assertCurrent.mockRejectedValue(new Error("private lease"));
		expect((await stale.broker.execute(request)).errorCode).toBe(
			"activation_not_current",
		);
		expect(stale.execute).not.toHaveBeenCalled();
	});
	it("passes a live guard and abort signal into the trusted handler", async () => {
		const { broker } = setup({
			execute: async (_input, context) => {
				expect(context.signal.aborted).toBe(false);
				await context.assertCurrent();
				return {
					status: "succeeded",
					providerRef: "message:456",
					data: output,
				};
			},
		});
		expect((await broker.execute(request)).status).toBe("succeeded");
	});
	it("makes thrown or invalid/secret provider output unknown without leaking or retrying", async () => {
		for (const execute of [
			async () => {
				throw new Error("CANARY_SECRET");
			},
			async () => ({
				status: "succeeded" as const,
				providerRef: "CANARY_SECRET",
				data: output,
			}),
			async () => ({
				status: "succeeded" as const,
				providerRef: "message:456",
				data: { ...output, unexpected: true },
			}),
		]) {
			const call = vi.fn(execute);
			const { broker } = setup({ execute: call });
			const result = await broker.execute(request);
			expect(result.status).toBe("unknown");
			expect(JSON.stringify(result)).not.toContain("CANARY_SECRET");
			await broker.execute(request);
			expect(call).toHaveBeenCalledTimes(1);
		}
	});
	it("times out at fifteen seconds, aborts handler and never resends", async () => {
		vi.useFakeTimers();
		let signal: AbortSignal | undefined;
		const call = vi.fn(async (_input, context) => {
			signal = context.signal;
			return await new Promise<never>(() => {});
		});
		const { broker } = setup({ execute: call });
		const pending = broker.execute(request);
		await vi.advanceTimersByTimeAsync(15000);
		expect((await pending).status).toBe("unknown");
		expect(signal?.aborted).toBe(true);
		await broker.execute(request);
		expect(call).toHaveBeenCalledTimes(1);
	});
	it("keeps patrol snapshots alive through the handler budget before the broker aborts", async () => {
		vi.useFakeTimers();
		const store = new SqliteJournalStore(":memory:");
		stores.push(store);
		let signal: AbortSignal | undefined;
		const operationId = "patrol.snapshot";
		const broker = new LeadCapabilityBroker({
			projectName: "flywheel",
			leadId: "product",
			activationId: "a1",
			receipts: store.operationReceipts,
			allowedOperationIds: () => new Set([operationId]),
			assertCurrent: async () => {},
			handlers: new Map([
				[
					operationId,
					{
						authorize: async () => {},
						execute: async (_input, context) => {
							signal = context.signal;
							return await new Promise<never>(() => {});
						},
					},
				],
			]),
			secrets: [],
		});
		const pending = broker.execute({
			...request,
			operationId,
			input: { tickId: "1" },
		});
		await vi.advanceTimersByTimeAsync(PATROL_SNAPSHOT_CLIENT_TIMEOUT_MS);
		expect(signal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await pending).toMatchObject({
			status: "rejected",
			errorCode: "operation_timeout",
		});
		expect(signal?.aborted).toBe(true);
	});
	it("uses only explicit read-only reconciliation for unknown receipts", async () => {
		const reconcile = vi.fn(async () => ({
			status: "succeeded" as const,
			providerRef: "message:456",
			data: output,
		}));
		const { broker, execute } = setup({
			execute: async () => {
				throw new Error("network");
			},
			reconcile,
		});
		expect((await broker.execute(request)).status).toBe("unknown");
		expect(reconcile).not.toHaveBeenCalled();
		expect((await broker.execute(request)).status).toBe("succeeded");
		expect(reconcile).toHaveBeenCalledTimes(1);
		expect(execute).not.toHaveBeenCalled();
	});
});

it("keeps failed read-only reconciliation unknown and never retries provider writes", async () => {
	const call = vi.fn(async () => {
		throw new Error("write outcome lost");
	});
	const { broker } = setup({
		execute: call,
		reconcile: async () => {
			throw new Error("lookup unavailable CANARY_SECRET");
		},
	});
	await broker.execute(request);
	const result = await broker.execute(request);
	expect(result.status).toBe("unknown");
	expect(JSON.stringify(result)).not.toContain("CANARY_SECRET");
	expect(call).toHaveBeenCalledTimes(1);
});
it("bounds read output and rejects secret-bearing read data without persistence", async () => {
	const { store } = setup();
	const operationId = "github.pr.diff";
	for (const diff of ["CANARY_SECRET", "a".repeat(262144)]) {
		const handler: LeadOperationHandler = {
			authorize: async () => {},
			execute: async () => ({
				status: "succeeded",
				data: {
					diff,
					truncated: false,
					nextCursor: null,
					receiptId: "r",
					observedAt: output.observedAt,
				},
			}),
		};
		const broker = new LeadCapabilityBroker({
			projectName: "flywheel",
			leadId: "product",
			activationId: "a1",
			receipts: store.operationReceipts,
			allowedOperationIds: () => new Set([operationId]),
			assertCurrent: async () => {},
			handlers: new Map([[operationId, handler]]),
			secrets: ["CANARY_SECRET"],
		});
		const result = await broker.execute({
			...request,
			operationId,
			input: { number: 1 },
		});
		expect(result.status).toBe("rejected");
		expect(JSON.stringify(result)).not.toContain("CANARY_SECRET");
		expect(
			store.operationReceipts.get({
				projectName: "flywheel",
				leadId: "product",
				operationId,
				requestId: request.requestId,
			}),
		).toBeUndefined();
	}
});

it("reconciles across activation without dispatching or mutating the old receipt", async () => {
	const first = setup({
		execute: async () => {
			throw new Error("ambiguous provider");
		},
	});
	await first.broker.execute(request);
	const execute = vi.fn(async () => ({
		status: "succeeded" as const,
		providerRef: "message:456",
		data: output,
	}));
	const reconcile = vi.fn(async () => ({
		status: "succeeded" as const,
		providerRef: "message:456",
		data: output,
	}));
	const next = new LeadCapabilityBroker({
		projectName: "flywheel",
		leadId: "product",
		activationId: "a2",
		receipts: first.store.operationReceipts,
		allowedOperationIds: () => first.allowed,
		assertCurrent: async () => {},
		handlers: new Map([
			[request.operationId, { authorize: async () => {}, execute, reconcile }],
		]),
		secrets: [],
	});
	expect((await next.execute(request)).status).toBe("succeeded");
	expect(execute).not.toHaveBeenCalled();
	expect(reconcile).toHaveBeenCalledTimes(1);
	const saved = first.store.operationReceipts.get({
		projectName: "flywheel",
		leadId: "product",
		operationId: request.operationId,
		requestId: request.requestId,
	});
	expect(saved?.activationId).toBe("a1");
	expect(saved?.state).toBe("unknown");
});
it("handler guard refuses side effects after authorization is revoked during an await", async () => {
	let revoke = () => {};
	let writes = 0;
	const { broker, allowed } = setup({
		execute: async (_input, context) => {
			await Promise.resolve();
			revoke();
			await context.assertCurrent();
			writes++;
			return { status: "succeeded", providerRef: "message:456", data: output };
		},
	});
	revoke = () => allowed.clear();
	expect((await broker.execute(request)).status).toBe("unknown");
	expect(writes).toBe(0);
});
it("returns pending for a concurrent duplicate instead of invoking its handler", async () => {
	let release: (() => void) | undefined;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	const call = vi.fn(async () => {
		await wait;
		return {
			status: "succeeded" as const,
			providerRef: "message:456",
			data: output,
		};
	});
	const { broker } = setup({ execute: call });
	const first = broker.execute(request);
	await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
	expect((await broker.execute(request)).status).toBe("pending");
	expect(call).toHaveBeenCalledTimes(1);
	release!();
	expect((await first).status).toBe("succeeded");
});

it("applies the result byte limit to the complete protocol envelope", async () => {
	const { store } = setup();
	const operationId = "github.pr.diff";
	const data = {
		diff: "",
		truncated: false,
		nextCursor: null,
		receiptId: "r",
		observedAt: output.observedAt,
	};
	data.diff = "a".repeat(
		262144 - Buffer.byteLength(JSON.stringify({ status: "succeeded", data })),
	);
	const broker = new LeadCapabilityBroker({
		projectName: "flywheel",
		leadId: "product",
		activationId: "a1",
		receipts: store.operationReceipts,
		allowedOperationIds: () => new Set([operationId]),
		assertCurrent: async () => {},
		handlers: new Map([
			[
				operationId,
				{
					authorize: async () => {},
					execute: async () => ({ status: "succeeded", data }),
				},
			],
		]),
		secrets: [],
	});
	expect(
		(await broker.execute({ ...request, operationId, input: { number: 1 } }))
			.errorCode,
	).toBe("output_too_large");
});

it.each([
	[
		"git.feature.push",
		{ branch: "flywheel/test", expectedHead: "a".repeat(40) },
		"lead_runner_owned_operation",
	],
	[
		"github.pr.create",
		{
			head: "feature/test",
			base: "main",
			title: "title",
			body: "body",
			draft: true,
		},
		"lead_runner_owned_operation",
	],
	[
		"github.issue.comment",
		{ number: 7, body: "comment" },
		"lead_github_issue_write_denied",
	],
] as const)(
	"denies tier C %s before any injected provider or old receipt replay",
	async (operationId, input, errorCode) => {
		const store = new SqliteJournalStore(":memory:");
		stores.push(store);
		const authorize = vi.fn(async () => {}),
			execute = vi.fn(async () => ({ status: "succeeded" as const }));
		const broker = new LeadCapabilityBroker({
			projectName: "flywheel",
			leadId: "product",
			activationId: "a1",
			receipts: store.operationReceipts,
			allowedOperationIds: () => new Set([operationId]),
			assertCurrent: async () => {},
			handlers: new Map([[operationId, { authorize, execute }]]),
			secrets: [],
		});
		const operation = { ...request, operationId, input };
		const historical = {
			projectName: "flywheel",
			leadId: "product",
			operationId,
			requestId: request.requestId,
			inputDigest: leadOperationInputDigest(input),
			activationId: "a1",
			now: 1,
		};
		store.operationReceipts.prepare(historical);
		store.operationReceipts.transition({
			...historical,
			from: "prepared",
			to: "dispatched",
		});
		store.operationReceipts.transition({
			...historical,
			from: "dispatched",
			to: "succeeded",
			providerRef: "historic:success",
		});

		expect(await broker.execute(operation)).toMatchObject({
			status: "rejected",
			errorCode,
		});
		expect(await broker.execute(operation)).toMatchObject({
			status: "rejected",
			errorCode,
		});
		expect(authorize).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
		await broker.close();
	},
);

it.each(["authorize", "execute"] as const)(
	"closing broker cancels pending %s before journal teardown and refuses new work",
	async (phase) => {
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let signal: AbortSignal | undefined;
		const handler = {
			[phase]: async (
				_input: Record<string, unknown>,
				ctx: import("../broker.js").LeadOperationContext,
			) => {
				signal = ctx.signal;
				entered();
				await held;
				return {
					status: "succeeded" as const,
					providerRef: "456",
					data: output,
				};
			},
		};
		const root = mkdtempSync(join(tmpdir(), "broker-close-"));
		roots.push(root);
		const path = join(root, "journal.db");
		const { broker, store, execute } = setup(handler, path);
		const pending = broker.execute(request);
		await ready;
		await broker.close();
		expect(signal?.aborted).toBe(true);
		expect((await pending).status).toBe(
			phase === "execute" ? "unknown" : "rejected",
		);
		const key = {
			projectName: "flywheel",
			leadId: "product",
			operationId: request.operationId,
			requestId: request.requestId,
		};
		if (phase === "execute")
			expect(store.operationReceipts.get(key)?.state).toBe("unknown");
		else expect(store.operationReceipts.get(key)).toBeUndefined();
		expect(
			await broker.execute({
				...request,
				requestId: "123e4567-e89b-42d3-a456-426614174001",
			}),
		).toMatchObject({ status: "rejected", errorCode: "broker_closed" });
		const transition = vi.spyOn(store.operationReceipts, "transition");
		stores.splice(stores.indexOf(store), 1);
		store.close();
		release();
		await new Promise((resolve) => setImmediate(resolve));
		expect(transition).not.toHaveBeenCalled();
		if (phase === "execute") {
			const reopened = setup(undefined, path);
			expect((await reopened.broker.execute(request)).status).toBe("unknown");
			expect(reopened.execute).not.toHaveBeenCalled();
			await reopened.broker.close();
		}
		expect(execute).not.toHaveBeenCalled();
		await broker.close();
	},
);

it("captures parent delivery context and rejects it if released during authorization", async () => {
	const store = new SqliteJournalStore(":memory:");
	stores.push(store);
	let active = true;
	let observed: unknown;
	const execute = vi.fn(async () => ({
		status: "succeeded" as const,
		data: output,
	}));
	const broker = new LeadCapabilityBroker({
		projectName: "flywheel",
		leadId: "product",
		activationId: "a1",
		receipts: store.operationReceipts,
		allowedOperationIds: () => new Set([request.operationId]),
		assertCurrent: async () => {},
		secrets: [],
		deliveryContext: () => ({
			id: "journal-1",
			assertCurrent: () => {
				if (!active) throw new Error("released");
			},
		}),
		handlers: new Map([
			[
				request.operationId,
				{
					authorize: async (_input, context) => {
						observed = context.deliveryContext;
						active = false;
					},
					execute,
				},
			],
		]),
	});
	expect((await broker.execute(request)).status).toBe("rejected");
	expect(observed).toBe("journal-1");
	expect(execute).not.toHaveBeenCalled();
	await broker.close();
});

it("refuses a reply outside the parent journal binding when the parent supplies the context authority", async () => {
	const store = new SqliteJournalStore(":memory:");
	stores.push(store);
	const execute = vi.fn(async () => ({
		status: "succeeded" as const,
		providerRef: "456",
		data: output,
	}));
	const broker = new LeadCapabilityBroker({
		projectName: "flywheel",
		leadId: "product",
		activationId: "a1",
		receipts: store.operationReceipts,
		allowedOperationIds: () => new Set([request.operationId]),
		assertCurrent: async () => {},
		secrets: [],
		deliveryContext: () => undefined,
		handlers: new Map([
			[request.operationId, { authorize: async () => {}, execute }],
		]),
	});
	expect((await broker.execute(request)).status).toBe("rejected");
	expect(execute).not.toHaveBeenCalled();
	await broker.close();
});

it("preserves an unavailable native browser as an explicit rejection", async () => {
	const store = new SqliteJournalStore(":memory:");
	stores.push(store);
	const operationId = "browser.list_pages";
	const broker = new LeadCapabilityBroker({
		projectName: "flywheel",
		leadId: "product",
		activationId: "a1",
		receipts: store.operationReceipts,
		allowedOperationIds: () => new Set([operationId]),
		assertCurrent: async () => {},
		secrets: [],
		handlers: new Map([
			[
				operationId,
				{
					authorize: async () => {},
					execute: async () => ({
						status: "rejected",
						errorCode: "browser_unavailable",
					}),
				},
			],
		]),
	});
	try {
		expect(
			await broker.execute({
				...request,
				operationId,
				input: { generation: request.requestId, arguments: {} },
			}),
		).toMatchObject({
			status: "rejected",
			errorCode: "browser_unavailable",
			resourceRefs: [],
		});
	} finally {
		await broker.close();
	}
});
