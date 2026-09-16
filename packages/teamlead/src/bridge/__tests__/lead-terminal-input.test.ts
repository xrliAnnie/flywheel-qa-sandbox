import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SqliteOutboundDedupStore } from "../../lead-backends/codex/SqliteOutboundDedupStore.js";
import { executeLeadTerminalInput } from "../lead-terminal-input.js";

it("keeps successful and unknown input receipts across Bridge storage reopen without resending", async () => {
	const home = mkdtempSync(join(tmpdir(), "terminal-restart-")),
		path = join(home, "outbound.db");
	let store = new SqliteOutboundDedupStore(path);
	const send = vi.fn(async () => {});
	const options = {
		projectName: "project",
		leadId: "eng",
		activationId: "a1",
		requestId: randomUUID(),
		input: { executionId: "exec", expectedSessionId: "$2:%3", text: "yes" },
		signal: new AbortController().signal,
		secrets: [],
		assertCurrent: async () => {},
		authorize: async () => {},
		inputTerminal: send,
		sideEffectsPossible: () => true,
	};
	try {
		expect(
			(
				await executeLeadTerminalInput({
					...options,
					receipts: store.operationReceipts,
				})
			).status,
		).toBe("succeeded");
		const unknownId = randomUUID();
		send.mockImplementation(async () => {
			throw new Error("lost");
		});
		expect(
			(
				await executeLeadTerminalInput({
					...options,
					requestId: unknownId,
					receipts: store.operationReceipts,
				})
			).status,
		).toBe("unknown");
		store.close();
		store = new SqliteOutboundDedupStore(path);
		expect(
			(
				await executeLeadTerminalInput({
					...options,
					activationId: "a2",
					receipts: store.operationReceipts,
				})
			).status,
		).toBe("succeeded");
		expect(
			(
				await executeLeadTerminalInput({
					...options,
					activationId: "a2",
					requestId: unknownId,
					receipts: store.operationReceipts,
				})
			).status,
		).toBe("unknown");
		expect(send).toHaveBeenCalledTimes(2);
	} finally {
		store.close();
		rmSync(home, { recursive: true, force: true });
	}
});
it("settles in-flight input as unknown when the request is canceled", async () => {
	const store = new SqliteOutboundDedupStore(":memory:"),
		controller = new AbortController();
	let entered!: () => void, finish!: () => void;
	const started = new Promise<void>((r) => {
			entered = r;
		}),
		pending = new Promise<void>((r) => {
			finish = r;
		});
	const key = {
		projectName: "project",
		leadId: "eng",
		operationId: "terminal.input",
		requestId: randomUUID(),
	};
	try {
		const work = executeLeadTerminalInput({
			...key,
			activationId: "a1",
			input: { executionId: "exec", expectedSessionId: "$2:%3", text: "yes" },
			receipts: store.operationReceipts,
			signal: controller.signal,
			secrets: [],
			assertCurrent: async () => {},
			authorize: async () => {},
			inputTerminal: async () => {
				entered();
				await pending;
			},
			sideEffectsPossible: () => true,
		});
		await started;
		controller.abort();
		expect((await work).status).toBe("unknown");
		expect(store.operationReceipts.get(key)?.state).toBe("unknown");
	} finally {
		finish();
		store.close();
	}
});
