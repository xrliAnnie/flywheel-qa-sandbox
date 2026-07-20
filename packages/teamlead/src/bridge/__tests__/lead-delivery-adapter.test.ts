import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CodexLeadInboxServer,
	resolveCodexLeadInboxSocketPath,
} from "../../lead-backends/codex/CodexLeadInboxSocket.js";
import { LeadInputRouter } from "../../lead-backends/codex/LeadInputRouter.js";
import {
	InMemoryJournalStore,
	LeadJournal,
} from "../../lead-backends/codex/LeadJournal.js";
import {
	ClaudeLeadDeliveryAdapter,
	CodexLeadDeliveryAdapter,
	type LeadDeliveryBatch,
} from "../lead-delivery-adapter.js";

const servers: CodexLeadInboxServer[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

const batch: LeadDeliveryBatch = {
	batchId: "batch-1",
	leadId: "lead-a",
	ownerEpoch: "owner-1",
	members: [
		{
			deliveryId: "question:lead-a:q1",
			content: "one",
			priority: 1,
			seq: 1,
		},
		{
			deliveryId: "report:lead-a:r1",
			content: "two",
			priority: 2,
			seq: 2,
		},
	],
	modelPayload: "one packaged turn",
};

describe("LeadDeliveryAdapter", () => {
	it("Claude hands every ordered member to one atomic mailbox batch", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1373-claude-adapter-"));
		const inboxPath = join(dir, "lead-a.json");
		const receipt = await new ClaudeLeadDeliveryAdapter({
			inboxPath,
			sidecarPath: `${inboxPath}.flywheel.jsonl`,
		}).deliverBatch(batch);
		expect(receipt.status).toBe("accepted_new");
		expect(receipt.memberIds).toEqual(batch.members.map((m) => m.deliveryId));
		const inbox = JSON.parse(await readFile(inboxPath, "utf8")) as Array<{
			text: string;
		}>;
		expect(inbox.map(({ text }) => text)).toEqual(["one", "two"]);
	});

	it("Claude classifies a deterministic mailbox conflict as terminal membership conflict", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1373-claude-conflict-"));
		const inboxPath = join(dir, "lead-a.json");
		const adapter = new ClaudeLeadDeliveryAdapter({
			inboxPath,
			sidecarPath: `${inboxPath}.flywheel.jsonl`,
		});
		await adapter.deliverBatch(batch);
		await expect(
			adapter.deliverBatch({
				...batch,
				members: batch.members.slice(0, 1),
			}),
		).resolves.toMatchObject({
			status: "membership_conflict",
			memberIds: ["question:lead-a:q1"],
		});
	});

	it("Codex binds the owner epoch and reaches the TUI-owned router", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "fly1373-codex-adapter-"));
		const router = new LeadInputRouter({
			leadId: "lead-a",
			threadId: "thread-a",
			journal: new LeadJournal({ store: new InMemoryJournalStore() }),
			executor: {
				async startTurn() {
					return "turn-1";
				},
				async awaitCompletion() {
					return { output: "ok" };
				},
				async reconcile() {
					return { exists: false, completed: false };
				},
			},
			sender: {
				async enqueue() {
					return "out-1";
				},
				async deliver() {},
			},
		});
		const server = new CodexLeadInboxServer({
			socketPath: resolveCodexLeadInboxSocketPath(stateDir),
			leadId: "lead-a",
			router,
			authSecret: "lead-bot-token",
		});
		servers.push(server);
		await server.listen();

		const receipt = await new CodexLeadDeliveryAdapter({
			stateDir,
			leadId: "lead-a",
			authSecret: "lead-bot-token",
		}).deliverBatch(batch);
		expect(receipt.status).toBe("accepted_new");
		await router.whenIdle();
	});
});
