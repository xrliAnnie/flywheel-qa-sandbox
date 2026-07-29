import { initializeRollbackFenceTx, type Kernel } from "flywheel-v2-kernel";
import { seedEngineConfigTx } from "./config.js";
import { ENGINE_SQL } from "./sql.js";

export function initializeEngineDb(kernel: Kernel): void {
	kernel.write("engine.bootstrap", (tx) => {
		const now = new Date().toISOString();
		tx.run(ENGINE_SQL.initializeCutoverEpoch, {
			now,
		});
		initializeRollbackFenceTx(tx, {
			authorityState: "cutover",
			nowIso: now,
		});
		seedEngineConfigTx(tx, now);
	});
}
