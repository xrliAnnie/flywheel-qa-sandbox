import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CodexLeadDeliveryAdapter,
	LeadDeliveryUnavailableError,
} from "../../../bridge/lead-delivery-adapter.js";
import {
	CodexLeadInboxRejectedError,
	CodexLeadInboxServer,
	LEAD_INTERRUPT_STEER_FEATURE,
	probeCodexLeadInboxCapabilities,
	resolveCodexLeadInboxSocketPath,
	submitCodexLeadInterrupt,
} from "../CodexLeadInboxSocket.js";

const roots: string[] = [];
const servers: CodexLeadInboxServer[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

const BATCH = {
	batchId: "batch-1#r0",
	memberIds: ["lead-interrupt:li_00000000-0000-4000-8000-000000000001#r0"],
	payload:
		"[mailbox-batch batch-1 | 1 messages]\n\n[加急 · 语音代 founder 转问] …",
};

async function serve(
	interrupt?: ConstructorParameters<
		typeof CodexLeadInboxServer
	>[0]["interrupt"],
) {
	const stateDir = mkdtempSync(join(tmpdir(), "fly2883-sock-"));
	roots.push(stateDir);
	const submitBatch = vi.fn(() => ({
		status: "accepted_new" as const,
		entryId: "entry-1",
	}));
	const server = new CodexLeadInboxServer({
		socketPath: resolveCodexLeadInboxSocketPath(stateDir),
		leadId: "codex-lead",
		authSecret: "test-secret",
		router: { submitBatch },
		...(interrupt ? { interrupt } : {}),
	});
	servers.push(server);
	await server.listen();
	return {
		stateDir,
		submitBatch,
		args: {
			socketPath: resolveCodexLeadInboxSocketPath(stateDir),
			leadId: "codex-lead",
			authSecret: "test-secret",
		},
	};
}

function rawRequest(socketPath: string, payload: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		const socket = createConnection(socketPath);
		socket.once("connect", () => socket.end(payload));
		socket.on("data", (chunk: Buffer) => chunks.push(chunk));
		socket.once("error", reject);
		socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
	});
}

describe("FLY-2883 Codex submitInterrupt socket method", () => {
	it("advertises the steer feature only when the runtime injects an interrupt handler", async () => {
		const without = await serve();
		expect(
			(await probeCodexLeadInboxCapabilities(without.args)).features,
		).not.toContain(LEAD_INTERRUPT_STEER_FEATURE);
		const withHandler = await serve({
			submit: async () => ({ outcome: "steered" }),
		});
		expect(
			(await probeCodexLeadInboxCapabilities(withHandler.args)).features,
		).toContain(LEAD_INTERRUPT_STEER_FEATURE);
	});

	it.each([
		[{ outcome: "steered" } as const],
		[{ outcome: "queued_turn" } as const],
		[{ outcome: "steer_failed", detail: "stale_turn" } as const],
	])("round-trips %j to the injected handler", async (result) => {
		const submit = vi.fn(async () => result);
		const { args, submitBatch } = await serve({ submit });
		expect(
			await submitCodexLeadInterrupt({
				...args,
				ownerEpoch: "epoch-a",
				batch: BATCH,
			}),
		).toEqual(result);
		expect(submit).toHaveBeenCalledWith(BATCH);
		expect(submitBatch).not.toHaveBeenCalled();
	});

	it("refuses an interrupt when no handler is injected", async () => {
		const { args } = await serve();
		await expect(
			submitCodexLeadInterrupt({
				...args,
				ownerEpoch: "epoch-a",
				batch: BATCH,
			}),
		).rejects.toThrow(/lead interrupt unavailable/);
	});

	it("refuses a wrong secret and a multi-member batch", async () => {
		const submit = vi.fn(async () => ({ outcome: "steered" as const }));
		const { args } = await serve({ submit });
		await expect(
			submitCodexLeadInterrupt({
				...args,
				authSecret: "wrong",
				ownerEpoch: "epoch-a",
				batch: BATCH,
			}),
		).rejects.toThrow(/authentication rejected/);
		await expect(
			submitCodexLeadInterrupt({
				...args,
				ownerEpoch: "epoch-a",
				batch: { ...BATCH, memberIds: ["a#r0", "b#r0"] },
			}),
		).rejects.toThrow(/malformed submitInterrupt request/);
		expect(submit).not.toHaveBeenCalled();
	});

	it("refuses unknown fields in the request frame", async () => {
		const submit = vi.fn(async () => ({ outcome: "steered" as const }));
		const { args } = await serve({ submit });
		const response = JSON.parse(
			await rawRequest(
				args.socketPath,
				`${JSON.stringify({
					version: 2,
					method: "submitInterrupt",
					leadId: "codex-lead",
					ownerEpoch: "epoch-a",
					batch: BATCH,
					cancelTurn: true,
					auth: "0".repeat(64),
				})}\n`,
			),
		);
		expect(response).toEqual({
			ok: false,
			error: "malformed submitInterrupt request",
		});
		expect(submit).not.toHaveBeenCalled();
	});

	it("never forwards a handler result outside the contract", async () => {
		const { args } = await serve({
			submit: async () =>
				({ outcome: "cancelled" }) as unknown as { outcome: "steered" },
		});
		await expect(
			submitCodexLeadInterrupt({
				...args,
				ownerEpoch: "epoch-a",
				batch: BATCH,
			}),
		).rejects.toThrow(/invalid interrupt result/);
	});
});

describe("FLY-2883 CodexLeadDeliveryAdapter.deliverInterrupt", () => {
	const deliveryBatch = {
		batchId: BATCH.batchId,
		leadId: "codex-lead",
		ownerEpoch: "epoch-a",
		kind: "model" as const,
		members: [
			{ deliveryId: BATCH.memberIds[0]!, content: "x", priority: 0, seq: 1 },
		],
		modelPayload: BATCH.payload,
	};

	it("steers through the sidecar when the feature is advertised", async () => {
		const submit = vi.fn(async () => ({ outcome: "steered" as const }));
		const { stateDir, submitBatch } = await serve({ submit });
		const adapter = new CodexLeadDeliveryAdapter({
			stateDir,
			leadId: "codex-lead",
			authSecret: "test-secret",
		});
		expect(await adapter.deliverInterrupt(deliveryBatch)).toEqual({
			outcome: "steered",
			receipt: {
				batchId: BATCH.batchId,
				memberIds: BATCH.memberIds,
				status: "accepted_new",
			},
		});
		expect(submit).toHaveBeenCalledWith({
			batchId: BATCH.batchId,
			memberIds: BATCH.memberIds,
			payload: BATCH.payload,
		});
		expect(submitBatch).not.toHaveBeenCalled();
	});

	it("returns steer_failed without submitting ordinary input", async () => {
		const { stateDir, submitBatch } = await serve({
			submit: async () => ({
				outcome: "steer_failed",
				detail: "turn_state_unknown",
			}),
		});
		const adapter = new CodexLeadDeliveryAdapter({
			stateDir,
			leadId: "codex-lead",
			authSecret: "test-secret",
		});
		expect(await adapter.deliverInterrupt(deliveryBatch)).toEqual({
			outcome: "steer_failed",
			detail: "turn_state_unknown",
		});
		expect(submitBatch).not.toHaveBeenCalled();
	});

	it("falls back to an ordinary batch when the sidecar has no steer feature", async () => {
		const { stateDir, submitBatch } = await serve();
		const adapter = new CodexLeadDeliveryAdapter({
			stateDir,
			leadId: "codex-lead",
			authSecret: "test-secret",
		});
		expect(await adapter.deliverInterrupt(deliveryBatch)).toEqual({
			outcome: "mailbox_only",
			reason: "steer_unsupported",
			receipt: {
				batchId: BATCH.batchId,
				memberIds: BATCH.memberIds,
				status: "accepted_new",
			},
		});
		expect(submitBatch).toHaveBeenCalledTimes(1);
	});

	it("reports an unreachable sidecar as Lead-unavailable", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "fly2883-nosock-"));
		roots.push(stateDir);
		const adapter = new CodexLeadDeliveryAdapter({
			stateDir,
			leadId: "codex-lead",
			authSecret: "test-secret",
		});
		await expect(
			adapter.deliverInterrupt(deliveryBatch),
		).rejects.toBeInstanceOf(LeadDeliveryUnavailableError);
	});

	it("surfaces a sidecar rejection unchanged", async () => {
		const { stateDir } = await serve({
			submit: async () => {
				throw new Error("router torn down");
			},
		});
		const adapter = new CodexLeadDeliveryAdapter({
			stateDir,
			leadId: "codex-lead",
			authSecret: "test-secret",
		});
		await expect(
			adapter.deliverInterrupt(deliveryBatch),
		).rejects.toBeInstanceOf(CodexLeadInboxRejectedError);
	});
});
