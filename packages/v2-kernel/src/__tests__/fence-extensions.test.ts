import { afterEach, describe, expect, it } from "vitest";
import { CasViolation } from "../errors.js";
import { FENCE } from "../fence.js";
import { Kernel } from "../kernel.js";
import { migrateDatabase } from "../migrator.js";
import { makeTempDatabase, type TempDatabase } from "./helpers.js";

function insertMailbox(
	kernel: Kernel,
	uid: string,
	agent: string,
	state: "pending" | "applied" = "pending",
): void {
	kernel.write("test.seed-mailbox", (tx) => {
		tx.run(
			`INSERT INTO agents(agent_id,kind,generation,last_poll_at,state)
			 VALUES (@agent,'runner',0,NULL,'offline')
			 ON CONFLICT(agent_id) DO NOTHING`,
			{ agent },
		);
		tx.run(
			`INSERT INTO mailbox
			 (message_uid,source_kind,source_id,payload,payload_digest,to_agent,kind,
			  retention_class,cutover_epoch,state,retry_count,created_at)
			 VALUES (@uid,'lead',@sourceId,'{}','digest',@agent,'instruction',
			  'business',1,@state,0,'2026-07-27T00:00:00.000Z')`,
			{ uid, sourceId: `source-${uid}`, agent, state },
		);
	});
}

describe("mailbox failure fence templates", () => {
	let temp: TempDatabase | undefined;
	let kernel: Kernel | undefined;

	afterEach(() => {
		kernel?.close();
		temp?.cleanup();
		kernel = undefined;
		temp = undefined;
	});

	it("increments retry exactly once for scheduled and terminal failure", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		insertMailbox(kernel, "retry", "runner-a");
		insertMailbox(kernel, "failure-dead", "runner-a");

		kernel.write("test.fences", (tx) => {
			tx.cas(FENCE.mailboxCasScheduleRetry, {
				uid: "retry",
				agent: "runner-a",
				nextRetryAt: "2026-07-27T00:00:30.000Z",
			});
			tx.cas(FENCE.mailboxCasFailureDead, {
				uid: "failure-dead",
				agent: "runner-a",
			});
		});

		expect(
			kernel.read((tx) =>
				tx.all(
					`SELECT message_uid,state,retry_count,next_retry_at
					 FROM mailbox ORDER BY message_uid`,
				),
			),
		).toEqual([
			{
				message_uid: "failure-dead",
				state: "dead",
				retry_count: 1,
				next_retry_at: null,
			},
			{
				message_uid: "retry",
				state: "pending",
				retry_count: 1,
				next_retry_at: "2026-07-27T00:00:30.000Z",
			},
		]);
	});

	it("binds both failure transitions to the intended recipient and pending state", () => {
		temp = makeTempDatabase();
		migrateDatabase({ path: temp.path });
		kernel = Kernel.open({ path: temp.path });
		insertMailbox(kernel, "wrong-agent", "runner-a");
		insertMailbox(kernel, "already-applied", "runner-a", "applied");

		for (const [sql, params] of [
			[
				FENCE.mailboxCasScheduleRetry,
				{
					uid: "wrong-agent",
					agent: "runner-b",
					nextRetryAt: "2026-07-27T00:00:30.000Z",
				},
			],
			[
				FENCE.mailboxCasFailureDead,
				{ uid: "already-applied", agent: "runner-a" },
			],
		] as const) {
			expect(() =>
				kernel?.write("test.rejected-fence", (tx) => {
					tx.cas(sql, params);
				}),
			).toThrow(CasViolation);
		}
	});
});
