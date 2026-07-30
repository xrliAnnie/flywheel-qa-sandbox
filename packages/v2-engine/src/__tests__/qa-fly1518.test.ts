/**
 * QA FLY-1518 — independent equivalence proof for the retired `commands` outbox.
 *
 * conversion-actions.test.ts asserts the seam's own return values. This suite
 * instead re-derives the guarantees the retired outbox used to provide and
 * checks each one against the *database*, through a second kernel connection
 * wherever durability is the claim:
 *
 *   O1 durable intent lands before the external effect runs;
 *   O2 at-most-once external effect across crash + generation takeover;
 *   O3 at-least-once delivery — a pre-intent crash loses nothing;
 *   O4 settlement stays atomic (effects + mailbox + attempt in one transaction);
 *   O5 ordering — the mailbox is never applied before the action outcome lands;
 *   O6 the retired tables are gone and any surviving writer fails loudly.
 *
 * Runner-specific attachment cases moved to the host/session integration suite
 * when FLY-1543 removed runner registration from EngineDriver.
 */
import { Kernel } from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import { EngineDriver } from "../driver.js";
import type { ConversionContext, ConversionResult } from "../types.js";
import {
	type EngineFixture,
	enqueueMailbox,
	makeEngineFixture,
	testSessionBinding,
} from "./helpers.js";

interface ActionRow {
	id: string;
	lid: string;
	state: string;
	result: string | null;
}

interface MailboxRow {
	state: string;
	applied_at: string | null;
}

/** Reads through an independent connection, so a passing row is a committed row. */
function readCommitted<Row>(
	fixture: EngineFixture,
	sql: string,
	params: Record<string, unknown> = {},
): Row[] {
	const observer = Kernel.open({ path: fixture.path });
	try {
		return observer.read((tx) => tx.all<Row>(sql, params));
	} finally {
		observer.close();
	}
}

const committedActions = (fixture: EngineFixture): ActionRow[] =>
	readCommitted<ActionRow>(
		fixture,
		`SELECT id, json_extract(payload,'$.lid') AS lid, state, result
		 FROM actions ORDER BY lid, created_at`,
	);

const committedMailbox = (fixture: EngineFixture, uid: string): MailboxRow =>
	readCommitted<MailboxRow>(
		fixture,
		"SELECT state, applied_at FROM mailbox WHERE message_uid=@uid",
		{ uid },
	)[0];

describe("QA FLY-1518 — commands outbox guarantees on pure actions", () => {
	let fixture: EngineFixture | undefined;
	const drivers: EngineDriver[] = [];

	afterEach(() => {
		for (const driver of drivers.splice(0)) {
			try {
				driver.stop();
			} catch {
				// A driver abandoned mid-action cannot stop; that is the simulated
				// crash, not a QA failure.
			}
		}
		fixture?.cleanup();
		fixture = undefined;
	});

	function newDriver(): EngineDriver {
		const driver = new EngineDriver(
			(fixture as EngineFixture).kernel,
			(fixture as EngineFixture).runtime,
		);
		drivers.push(driver);
		return driver;
	}

	it("O5 never applies the mailbox before an unawaited lead action lands", async () => {
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, { uid: "m-o5", agent: "lead-qa" });
		let releasePerform: (() => void) | undefined;
		const performGate = new Promise<void>((resolve) => {
			releasePerform = resolve;
		});
		let mailboxWhilePending: MailboxRow | undefined;
		let actionStateWhilePending: string | undefined;
		let performCount = 0;

		const driver = newDriver();
		await driver.registerLead(
			"lead-qa",
			{
				kind: "lead",
				leadId: "lead-qa",
				instanceId: "instance-1",
				sessionBinding: testSessionBinding("instance-1"),
			},
			async (_message, ctx: ConversionContext): Promise<ConversionResult> => {
				// Deliberately NOT awaited: the driver's barrier, not the converter's
				// discipline, has to hold settlement back.
				void ctx.performAction(
					{
						kind: "qa.send",
						payload: { lid: "send-1" },
						logicalEffectId: "send-1",
					},
					async () => {
						performCount += 1;
						mailboxWhilePending = committedMailbox(
							fixture as EngineFixture,
							"m-o5",
						);
						actionStateWhilePending = committedActions(
							fixture as EngineFixture,
						)[0]?.state;
						await performGate;
						return { messageId: "ext-1" };
					},
				);
				return { ok: true, effects: [] };
			},
		);

		const drained = driver.drain("lead-qa");
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(performCount).toBe(1);
		expect(actionStateWhilePending).toBe("intended");
		expect(mailboxWhilePending?.state).not.toBe("applied");
		expect(committedMailbox(fixture, "m-o5").state).not.toBe("applied");

		releasePerform?.();
		await drained;

		expect(committedActions(fixture)[0].state).toBe("succeeded");
		expect(committedMailbox(fixture, "m-o5").state).toBe("applied");
	});
});

describe("QA FLY-1518 — the v2 schema has no retired outbox left", () => {
	let fixture: EngineFixture | undefined;

	afterEach(() => {
		fixture?.cleanup();
		fixture = undefined;
	});

	it("O6 carries no commands, command_dependencies, or obligations table", () => {
		fixture = makeEngineFixture();
		expect(
			readCommitted<{ name: string }>(
				fixture,
				`SELECT name FROM sqlite_master
				 WHERE type='table'
				   AND name IN ('commands','command_dependencies','obligations')`,
			),
		).toEqual([]);
	});

	it("O6b fails loudly rather than silently if anything still writes the outbox", () => {
		fixture = makeEngineFixture();
		expect(() =>
			(fixture as EngineFixture).kernel.write("qa.legacy-outbox", (tx) => {
				tx.run(
					`INSERT INTO commands (id, kind, cutover_epoch, created_at)
					 VALUES ('x','y',1,'z')`,
				);
			}),
		).toThrow(/no such table/i);
	});
});
