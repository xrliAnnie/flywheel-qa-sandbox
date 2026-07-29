import { describe, expect, it } from "vitest";
import { FenceViolation } from "../errors.js";
import { Kernel } from "../kernel.js";
import { migrateDatabase } from "../migrator.js";
import {
	initializeRollbackFenceTx,
	readRollbackFence,
	recordExternalEffectIntentTx,
	rollbackGateCas,
} from "../rollback-fence.js";
import { makeTempDatabase } from "./helpers.js";

function makeTempDb() {
	const temp = makeTempDatabase();
	migrateDatabase({ path: temp.path });
	const kernel = Kernel.open({ path: temp.path });
	return {
		kernel,
		cleanup() {
			kernel.close();
			temp.cleanup();
		},
	};
}

describe("cutover rollback fence", () => {
	it("atomically chooses rollback before the first external effect", () => {
		const fixture = makeTempDb();
		try {
			fixture.kernel.write("test.init-rollback", (tx) => {
				initializeRollbackFenceTx(tx, {
					authorityState: "live",
					nowIso: "2026-07-28T00:00:00.000Z",
				});
			});
			expect(
				fixture.kernel.write("test.rollback", (tx) =>
					rollbackGateCas(tx, "2026-07-28T00:01:00.000Z"),
				),
			).toEqual({
				authorityState: "live",
				effectIntentCount: 0,
				rollbackState: "rollback_started",
			});
			expect(() =>
				fixture.kernel.write("test.effect-after-rollback", (tx) => {
					recordExternalEffectIntentTx(tx, {
						effectKey: "spawn:1",
						family: "spawn",
						nowIso: "2026-07-28T00:02:00.000Z",
					});
				}),
			).toThrow(FenceViolation);
		} finally {
			fixture.cleanup();
		}
	});

	it("rejects rollback after any idempotently-recorded effect intent", () => {
		const fixture = makeTempDb();
		try {
			fixture.kernel.write("test.effect", (tx) => {
				initializeRollbackFenceTx(tx, {
					authorityState: "cutover",
					nowIso: "2026-07-28T00:00:00.000Z",
				});
				recordExternalEffectIntentTx(tx, {
					effectKey: "deliver:1",
					family: "deliver",
					nowIso: "2026-07-28T00:01:00.000Z",
				});
				recordExternalEffectIntentTx(tx, {
					effectKey: "deliver:1",
					family: "deliver",
					nowIso: "2026-07-28T00:01:00.000Z",
				});
			});
			expect(readRollbackFence(fixture.kernel)).toEqual({
				authorityState: "cutover",
				effectIntentCount: 1,
				rollbackState: "clear",
			});
			fixture.kernel.write("test.reinitialize", (tx) => {
				initializeRollbackFenceTx(tx, {
					authorityState: "cutover",
					nowIso: "2026-07-28T00:01:30.000Z",
				});
			});
			expect(readRollbackFence(fixture.kernel)).toEqual({
				authorityState: "cutover",
				effectIntentCount: 1,
				rollbackState: "clear",
			});
			expect(() =>
				fixture.kernel.write("test.rollback", (tx) => {
					rollbackGateCas(tx, "2026-07-28T00:02:00.000Z");
				}),
			).toThrow(/external effect intent/);
		} finally {
			fixture.cleanup();
		}
	});

	it("fails closed when the fence meta is missing or malformed", () => {
		const fixture = makeTempDb();
		try {
			expect(() => readRollbackFence(fixture.kernel)).toThrow(/missing/);
			fixture.kernel.write("test.corrupt", (tx) => {
				tx.run(
					`INSERT INTO meta(key,value,updated_at)
					 VALUES ('rollback_state','clear',@now),
					        ('external_effect_intent_count','wat',@now),
					        ('cutover_authority_state','live',@now)`,
					{ now: "2026-07-28T00:00:00.000Z" },
				);
			});
			expect(() => readRollbackFence(fixture.kernel)).toThrow(/malformed/);
		} finally {
			fixture.cleanup();
		}
	});
});
