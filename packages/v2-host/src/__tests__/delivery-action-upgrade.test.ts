import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	initializeEngineDb,
	provisionAgentRecipient,
	registerAgentTx,
} from "flywheel-v2-engine";
import {
	Kernel,
	migrateDatabase,
	recordActionIntent,
} from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import { deliveryActionId, deliveryLogicalEffectId } from "../host.js";

/**
 * Codex R4 MEDIUM-5 — an action written before the delivery logical scope changed
 * must not collide with one written after.
 *
 * Re-scoping the logical effect from (message) to (message, processing attempt)
 * changed the effect key, but the action id was still
 * `mailbox-delivery:<attemptUid>`. recordActionIntent looks up a replay by effect
 * key ONLY, so against a row written by an older host it found nothing and
 * inserted with the same id -- `UNIQUE constraint failed: actions.id`, retried
 * forever. The scenario is an old host that delivered and then died with the
 * processing attempt still running: exactly the crash this PR set out to make
 * recoverable.
 *
 * This proves the collision and the fix at the layer they live in. The
 * host-socket route was tried first and abandoned: the lead's drain lifecycle
 * decides which message is polled next, so the test could not deterministically
 * force a second delivery of the ONE attempt the legacy row names, and a version
 * that appeared to pass was only asserting the constant it had just changed.
 */
const EPOCH = 41;
const LEAD_SESSION = "lead-session-1";
const ATTEMPT_UID = "cf6b3c1e-9a1e-4a3f-9d0b-1f2a3b4c5d6e#2";
const MESSAGE_UID = "cf6b3c1e-9a1e-4a3f-9d0b-1f2a3b4c5d6e";
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function liveKernel(): Kernel {
	const root = mkdtempSync(join(tmpdir(), "fly1503-action-upgrade-"));
	roots.push(root);
	chmodSync(root, 0o700);
	const dbPath = join(root, "flywheel-v2.db");
	migrateDatabase({ path: dbPath });
	const kernel = Kernel.open({ path: dbPath });
	initializeEngineDb(kernel);
	provisionAgentRecipient(kernel, "lead-runtime", "lead");
	// The actions triggers require the actor to be the agent's CURRENT identity, and
	// the agents row only moves through registerAgentTx.
	kernel.write("test.register-lead", (tx) =>
		registerAgentTx(
			tx,
			{
				clock: {
					nowMs: () => Date.parse("2026-07-29T00:03:00.000Z"),
					nowIso: () => "2026-07-29T00:03:00.000Z",
				},
			},
			"lead-runtime",
			{
				kind: "lead",
				leadId: "lead-runtime",
				instanceId: LEAD_SESSION,
				sessionBinding: {
					v: 1,
					hostEpoch: "fly1503-host",
					sessionId: LEAD_SESSION,
					pid: 41_001,
					pidStart: "fly1503-pid-start-41001",
				},
			},
		),
	);
	kernel.write("test.epoch", (tx) => {
		tx.run(
			`INSERT INTO meta(key,value,updated_at) VALUES ('cutover_epoch',@epoch,@now)
			 ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
			{ epoch: String(EPOCH), now: "2026-07-29T00:00:00.000Z" },
		);
	});
	return kernel;
}

/**
 * The row a pre-upgrade host left behind -- produced by the PRODUCTION writer with
 * the old inputs, not by hand.
 *
 * Codex R5 LOW-1: hardcoding `pre-upgrade-logical-key` / `pre-upgrade-effect-key`
 * meant this suite would still pass if #prepareDelivery reverted to the message-only
 * scope, or if the id prefix regressed -- it asserted only the constants the test
 * itself chose. Driving recordActionIntent with the old logicalEffectId and the old
 * id shape yields a row with the REAL legacy keys, so the comparison is against what
 * an older host actually wrote.
 */
function seedPreUpgradeDelivery(kernel: Kernel): void {
	kernel.write("test.pre-upgrade-delivery", (tx) =>
		recordActionIntent(tx, {
			// The pre-upgrade id: no scope marker.
			id: `mailbox-delivery:${ATTEMPT_UID}`,
			actor: {
				kind: "lead",
				agentId: "lead-runtime",
				instanceId: LEAD_SESSION,
				generation: 1,
			},
			kind: "mailbox.deliver",
			payload: { message_uid: MESSAGE_UID, attempt_uid: ATTEMPT_UID },
			// The pre-upgrade scope: message only.
			logicalEffectId: `deliver:${MESSAGE_UID}`,
			invocationUid: `mailbox:${ATTEMPT_UID}`,
			cutoverEpoch: EPOCH,
			createdAt: "2026-07-29T00:04:30.000Z",
		}),
	);
}

function recordDelivery(kernel: Kernel, actionId: string): void {
	kernel.write("test.delivery-intent", (tx) =>
		recordActionIntent(tx, {
			id: actionId,
			actor: {
				kind: "lead",
				agentId: "lead-runtime",
				instanceId: LEAD_SESSION,
				generation: 1,
			},
			kind: "mailbox.deliver",
			payload: { message_uid: MESSAGE_UID, attempt_uid: ATTEMPT_UID },
			// The post-upgrade scope, taken from production rather than restated.
			logicalEffectId: deliveryLogicalEffectId(MESSAGE_UID, ATTEMPT_UID),
			invocationUid: `mailbox:${ATTEMPT_UID}`,
			cutoverEpoch: EPOCH,
			createdAt: "2026-07-29T00:05:00.000Z",
		}),
	);
}

describe("Codex R4 MEDIUM-5 — delivery action upgrade compatibility", () => {
	it("collides on actions.id when the new scope reuses the old id", () => {
		const kernel = liveKernel();
		try {
			seedPreUpgradeDelivery(kernel);
			// This is the pre-fix behaviour: same id, new effect key. The replay lookup
			// is by effect key, so it misses the legacy row and inserts.
			expect(() =>
				recordDelivery(kernel, `mailbox-delivery:${ATTEMPT_UID}`),
			).toThrow(/UNIQUE constraint failed: actions.id/);
		} finally {
			kernel.close();
		}
	});

	it("inserts alongside the legacy row once the id carries the scope", () => {
		const kernel = liveKernel();
		try {
			seedPreUpgradeDelivery(kernel);
			// The fix: the id carries the logical scope, so the two records cannot
			// share an id. Both are true -- the old host really did hand over bytes,
			// and so does this one.
			expect(() =>
				recordDelivery(kernel, deliveryActionId(ATTEMPT_UID)),
			).not.toThrow();
			const ids = kernel.read((tx) =>
				tx
					.all<{ id: string }>(
						"SELECT id FROM actions WHERE kind='mailbox.deliver' ORDER BY id",
					)
					.map((row) => row.id),
			);
			expect(ids).toEqual([
				`mailbox-delivery:${ATTEMPT_UID}`,
				deliveryActionId(ATTEMPT_UID),
			]);
			// The versioned id must actually differ from the legacy one, or this suite
			// would pass a regression that removed the scope marker.
			expect(deliveryActionId(ATTEMPT_UID)).not.toBe(
				`mailbox-delivery:${ATTEMPT_UID}`,
			);
			// Replaying the new intent is still idempotent.
			expect(() =>
				recordDelivery(kernel, deliveryActionId(ATTEMPT_UID)),
			).not.toThrow();
		} finally {
			kernel.close();
		}
	});
});
