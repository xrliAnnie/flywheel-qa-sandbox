import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MailboxBatchConflictError,
	readMailboxEntries,
	type SidecarRecord,
	writeMailboxBatch,
} from "../ClaudeMailboxCodec.js";

describe("FLY-1373 Claude mailbox atomic batches", () => {
	let dir: string;
	let inboxPath: string;
	let sidecarPath: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "fly1373-mailbox-batch-"));
		inboxPath = join(dir, "lead-a.json");
		sidecarPath = `${inboxPath}.flywheel.jsonl`;
	});

	afterEach(async () => rm(dir, { recursive: true, force: true }));

	function members() {
		return [
			{
				flywheelId: "question:lead-a:q1",
				payload: { from: "bridge", to: "lead-a", content: "same body" },
			},
			{
				flywheelId: "question:lead-a:q2",
				payload: { from: "bridge", to: "lead-a", content: "same body" },
			},
		];
	}

	async function sidecarRecords(): Promise<SidecarRecord[]> {
		return (await readFile(sidecarPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as SidecarRecord);
	}

	it("atomically appends every ordered member and dedupes the frozen batch", async () => {
		const first = await writeMailboxBatch({
			inboxPath,
			sidecarPath,
			batchId: "batch-1",
			members: members(),
		});
		expect(first.status).toBe("accepted_new");
		expect(
			(await readMailboxEntries(inboxPath)).map(({ text }) => text),
		).toEqual(["same body", "same body"]);
		expect(await sidecarRecords()).toEqual([
			expect.objectContaining({
				flywheelId: "question:lead-a:q1",
				batchId: "batch-1",
				batchIndex: 0,
				status: "finalized",
			}),
			expect.objectContaining({
				flywheelId: "question:lead-a:q2",
				batchId: "batch-1",
				batchIndex: 1,
				status: "finalized",
			}),
		]);

		const duplicate = await writeMailboxBatch({
			inboxPath,
			sidecarPath,
			batchId: "batch-1",
			members: members(),
		});
		expect(duplicate.status).toBe("accepted_duplicate_same_membership");
		expect(await readMailboxEntries(inboxPath)).toHaveLength(2);
	});

	it("recovers a crash after Phase A without changing member refs", async () => {
		await expect(
			writeMailboxBatch({
				inboxPath,
				sidecarPath,
				batchId: "batch-a-crash",
				members: members(),
				hooks: { afterPhaseA: () => Promise.reject(new Error("kill after A")) },
			}),
		).rejects.toThrow("kill after A");
		const refsBefore = (await sidecarRecords()).map(({ mainEntryRef }) =>
			JSON.stringify(mainEntryRef),
		);

		const recovered = await writeMailboxBatch({
			inboxPath,
			sidecarPath,
			batchId: "batch-a-crash",
			members: members(),
		});
		expect(recovered.status).toBe("accepted_new");
		expect(
			(await sidecarRecords()).map(({ mainEntryRef }) =>
				JSON.stringify(mainEntryRef),
			),
		).toEqual(refsBefore);
		expect(await readMailboxEntries(inboxPath)).toHaveLength(2);
	});

	it("recovers a crash after Phase B by finalizing exact refs without rewriting", async () => {
		await expect(
			writeMailboxBatch({
				inboxPath,
				sidecarPath,
				batchId: "batch-b-crash",
				members: members(),
				hooks: { afterPhaseB: () => Promise.reject(new Error("kill after B")) },
			}),
		).rejects.toThrow("kill after B");
		expect(await readMailboxEntries(inboxPath)).toHaveLength(2);
		expect(
			(await sidecarRecords()).every(({ status }) => status === "pending"),
		).toBe(true);

		const recovered = await writeMailboxBatch({
			inboxPath,
			sidecarPath,
			batchId: "batch-b-crash",
			members: members(),
		});
		expect(recovered.status).toBe("accepted_duplicate_same_membership");
		expect(await readMailboxEntries(inboxPath)).toHaveLength(2);
		expect(
			(await sidecarRecords()).every(({ status }) => status === "finalized"),
		).toBe(true);
	});

	it("fails closed on a partial main-file batch", async () => {
		await expect(
			writeMailboxBatch({
				inboxPath,
				sidecarPath,
				batchId: "batch-partial",
				members: members(),
				hooks: { afterPhaseA: () => Promise.reject(new Error("stop")) },
			}),
		).rejects.toThrow("stop");
		const [first] = await sidecarRecords();
		await writeFile(
			inboxPath,
			JSON.stringify([
				{
					from: first!.mainEntryRef!.from,
					text: "same body",
					timestamp: first!.mainEntryRef!.timestamp,
					read: false,
				},
			]),
			"utf8",
		);

		await expect(
			writeMailboxBatch({
				inboxPath,
				sidecarPath,
				batchId: "batch-partial",
				members: members(),
			}),
		).rejects.toBeInstanceOf(MailboxBatchConflictError);
		expect(await readMailboxEntries(inboxPath)).toHaveLength(1);
	});

	it("rejects reuse of a batch id with different membership", async () => {
		await writeMailboxBatch({
			inboxPath,
			sidecarPath,
			batchId: "batch-conflict",
			members: members(),
		});
		await expect(
			writeMailboxBatch({
				inboxPath,
				sidecarPath,
				batchId: "batch-conflict",
				members: members().slice(0, 1),
			}),
		).rejects.toBeInstanceOf(MailboxBatchConflictError);
	});

	it("uses collision-resistant immutable refs for distinct batches created in one millisecond", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_721_404_800_000);
		await writeMailboxBatch({
			inboxPath,
			sidecarPath,
			batchId: "batch-same-ms-a",
			members: members(),
		});
		await writeMailboxBatch({
			inboxPath,
			sidecarPath,
			batchId: "batch-same-ms-b",
			members: members().map((member, index) => ({
				...member,
				flywheelId: `question:lead-a:q${index + 3}`,
			})),
		});

		const records = await sidecarRecords();
		expect(
			new Set(records.map((record) => record.mainEntryRef?.timestamp)).size,
		).toBe(4);
		expect(
			records.every((record) =>
				Number.isFinite(Date.parse(record.mainEntryRef?.timestamp ?? "")),
			),
		).toBe(true);
		expect(await readMailboxEntries(inboxPath)).toHaveLength(4);
		vi.restoreAllMocks();
	});
});
