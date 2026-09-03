import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { send } from "../commands/send.js";
import { CommDB } from "../db.js";
import { MailboxQueue } from "../mailbox-queue.js";
import { createTestLeadIdentityEnvs } from "./helpers/lead-identity-env.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

type CancelMailboxDelivery = (input: {
	sourceId: string;
	operationId: string;
	now: string;
}) => {
	ok: boolean;
	idempotentReplay: boolean;
	noop: boolean;
};

describe("FLY-2278 R4#1 mailbox cancellation fence", () => {
	it("terminally cancels a real send and removes it from the runner claim/delivery flow", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2278-mailbox-cancel-"));
		roots.push(root);
		const dbPath = join(root, "comm.db");
		const leadEnv = createTestLeadIdentityEnvs(
			root,
			["flywheel-eng-lead"],
			"flywheel",
		)["flywheel-eng-lead"]!;
		const setup = new CommDB(dbPath);
		setup.registerSession(
			"recipient-exec",
			"recipient-window",
			"flywheel",
			"FLY-2278",
			"flywheel-eng-lead",
			"codex",
		);
		setup.close();

		const sourceId = await send({
			fromAgent: "flywheel-eng-lead",
			toAgent: "recipient-exec",
			content: "run the bounded implementation",
			dbPath,
			env: leadEnv,
		});
		const queue = new MailboxQueue(dbPath);
		const commDb = new CommDB(dbPath);
		try {
			queue.acquireOrRenewOwner({
				ownerEpoch: "runner-lane:1",
				now: "2026-09-03T10:00:00.000Z",
				leaseTtlMs: 60_000,
			});
			const claimed = queue.claimRunnerBatch({
				ownerEpoch: "runner-lane:1",
				now: "2026-09-03T10:00:01.000Z",
				transportClaimTtlMs: 60_000,
				batchWindowMs: 60_000,
				batchMaxSize: 10,
				inflightMaxBatches: 3,
			});
			expect(claimed?.map(({ id }) => id)).toEqual([sourceId]);

			const cancel = (
				commDb as unknown as { cancelMailboxDelivery?: CancelMailboxDelivery }
			).cancelMailboxDelivery;
			expect(typeof cancel).toBe("function");
			const operationId = "hold-resume:cancel-mailbox:1";
			expect(
				cancel!.call(commDb, {
					sourceId,
					operationId,
					now: "2026-09-03T10:00:02.000Z",
				}),
			).toEqual({ ok: true, idempotentReplay: false, noop: false });

			const raw = (commDb as unknown as { db: Database.Database }).db;
			expect(
				raw
					.prepare(
						`SELECT state, dead_reason, dead_at, superseded_by,
						        claimed_by, claim_expires_at, batch_id, next_retry_at
						   FROM mailbox WHERE id = ?`,
					)
					.get(sourceId),
			).toEqual({
				state: "DEAD",
				dead_reason: `cancelled_by_operator:${operationId}`,
				dead_at: "2026-09-03T10:00:02.000Z",
				superseded_by: `cancelled:${operationId}`,
				claimed_by: null,
				claim_expires_at: null,
				batch_id: null,
				next_retry_at: null,
			});
			expect(
				cancel!.call(commDb, {
					sourceId,
					operationId,
					now: "2026-09-03T10:00:03.000Z",
				}),
			).toEqual({ ok: true, idempotentReplay: true, noop: false });
			expect(
				queue.claimRunnerBatch({
					ownerEpoch: "runner-lane:1",
					now: "2026-09-03T10:00:04.000Z",
					transportClaimTtlMs: 60_000,
					batchWindowMs: 60_000,
					batchMaxSize: 10,
					inflightMaxBatches: 3,
				}),
			).toBeUndefined();
			expect(queue.getById(sourceId)?.delivered_at).toBeNull();
		} finally {
			queue.close();
			commDb.close();
		}
	});
});
