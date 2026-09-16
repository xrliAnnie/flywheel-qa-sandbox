import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { SqliteJournalStore } from "../../lead-backends/codex/SqliteJournalStore.js";
import { executeLeadMemoryAdd } from "../lead-memory.js";

it("binds memory writes to own project and preserves UUID/provenance on replay", async () => {
	const journal = new SqliteJournalStore(":memory:");
	const addMessages = vi.fn(async () => ({ added: 1, updated: 0 }));
	const options = {
		projectName: "p",
		leadId: "l",
		activationId: "a",
		requestId: randomUUID(),
		input: {
			project: "p",
			text: "learning",
			collection: "c",
			noteId: "n",
			opId: "op",
			runKey: "run",
		},
		receipts: journal.operationReceipts,
		signal: new AbortController().signal,
		secrets: ["secret-canary"],
		assertCurrent: async () => {},
		memory: { addMessages },
	};
	try {
		expect(
			(
				await executeLeadMemoryAdd({
					...options,
					input: { ...options.input, project: "other" },
				})
			).status,
		).toBe("rejected");
		expect(addMessages).not.toHaveBeenCalled();
		expect((await executeLeadMemoryAdd(options)).status).toBe("succeeded");
		expect(addMessages).toHaveBeenCalledWith({
			projectName: "p",
			agentId: "l",
			userId: "p",
			messages: [{ role: "user", content: "learning" }],
			metadata: {
				source: "xiaohongshu",
				collection: "c",
				note_id: "n",
				op_id: "op",
				run_key: "run",
			},
		});
		expect(
			(await executeLeadMemoryAdd({ ...options, activationId: "b" })).status,
		).toBe("succeeded");
		expect(addMessages).toHaveBeenCalledTimes(1);
		expect(
			(
				await executeLeadMemoryAdd({
					...options,
					input: { ...options.input, text: "changed" },
				})
			).errorCode,
		).toBe("input_digest_conflict");
		expect(
			(
				await executeLeadMemoryAdd({
					...options,
					requestId: randomUUID(),
					input: { ...options.input, text: "secret-canary" },
				})
			).status,
		).toBe("rejected");
		expect(addMessages).toHaveBeenCalledTimes(1);
	} finally {
		journal.close();
	}
});

it("leaves a cancelled in-flight memory write unknown and never redispatches it", async () => {
	const journal = new SqliteJournalStore(":memory:");
	const controller = new AbortController();
	let finish!: () => void;
	let dispatched!: () => void;
	const started = new Promise<void>((r) => {
		dispatched = r;
	});
	const addMessages = vi.fn(() => {
		dispatched();
		return new Promise<{ added: number; updated: number }>((r) => {
			finish = () => r({ added: 1, updated: 0 });
		});
	});
	const options = {
		projectName: "p",
		leadId: "l",
		activationId: "a",
		requestId: randomUUID(),
		input: {
			project: "p",
			text: "learning",
			collection: "c",
			noteId: "n",
			opId: "op",
			runKey: "run",
		},
		receipts: journal.operationReceipts,
		signal: controller.signal,
		secrets: [],
		assertCurrent: async () => {},
		memory: { addMessages },
	};
	try {
		const pending = executeLeadMemoryAdd(options);
		await started;
		controller.abort();
		expect((await pending).status).toBe("unknown");
		finish();
		await new Promise((r) => setTimeout(r, 0));
		expect(
			(
				await executeLeadMemoryAdd({
					...options,
					activationId: "b",
					signal: new AbortController().signal,
				})
			).status,
		).toBe("unknown");
		expect(addMessages).toHaveBeenCalledTimes(1);
	} finally {
		finish?.();
		journal.close();
	}
});
