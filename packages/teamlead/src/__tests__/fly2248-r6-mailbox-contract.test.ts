import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import { createTestLeadIdentityEnvs } from "../../../flywheel-comm/src/__tests__/helpers/lead-identity-env.js";
import { respond } from "../../../flywheel-comm/src/commands/respond.js";
import { send } from "../../../flywheel-comm/src/commands/send.js";
import { DeliveryProjector } from "../bridge/delivery-contract/projector.js";
import { StateStore } from "../StateStore.js";

const roots: string[] = [];
const stores: StateStore[] = [];
const commDbs: CommDB[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const db of commDbs.splice(0)) db.close();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("FLY-2248 R6#1 mailbox identity and lineage", () => {
	it("projects direct send/respond writes without repurposing ref_id", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2248-r6-mailbox-"));
		roots.push(root);
		const dbPath = join(root, "comm.db");
		const bootstrap = new CommDB(dbPath);
		bootstrap.registerSession(
			"runner-old",
			"old-window",
			"flywheel",
			"FLY-2248",
			"lead-a",
		);
		const questionId = bootstrap.insertQuestion(
			"runner-old",
			"lead-a",
			"Which contract should run?",
		);
		bootstrap.close();
		const leadEnv = createTestLeadIdentityEnvs(root, ["lead-a"])["lead-a"]!;
		const instructionId = await send({
			fromAgent: "lead-a",
			toAgent: "runner-old",
			content: "Apply the generic contract",
			dbPath,
			env: leadEnv,
		});
		await respond({
			questionId,
			fromAgent: "lead-a",
			answer: "Use the durable contract",
			dbPath,
			env: leadEnv,
		});

		const commDb = new CommDB(dbPath);
		commDbs.push(commDb);
		const response = commDb.getResponse(questionId);
		expect(response).toBeDefined();
		const responseId = response!.id;
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const projector = new DeliveryProjector({
			store,
			commDb,
			projectName: "flywheel",
		});
		expect(projector.runPass()).toMatchObject({ examined: 2, minted: 2 });
		const attempts = store.listLiveWorkflowDeliveryAttempts();
		for (const physicalId of [instructionId, responseId]) {
			const attempt = attempts.find(
				(candidate) =>
					JSON.parse(candidate.contract_ref_json).pk === physicalId,
			);
			expect(attempt).toMatchObject({
				generation: 1,
				attempt: 1,
				family: "mailbox",
			});
		}
		const raw = new Database(dbPath);
		expect(
			raw.prepare("SELECT ref_id FROM mailbox WHERE id = ?").get(responseId),
		).toEqual({ ref_id: questionId });
		raw.close();
	});
});
