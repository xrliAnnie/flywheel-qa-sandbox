import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { applyVersion } from "./apply.mjs";
import { currentPkgRoot } from "./install.mjs";
import { previousGood } from "./ledger.mjs";
import { LockBusy } from "./lock.mjs";
import { MSG } from "./messages.mjs";
import { messageFor } from "./onboard.mjs";
import { mutatorPreflight } from "./preflight.mjs";

export async function runRollback(
	cfg,
	{ io, exec = execFileSync, env = process.env, ...options } = {},
) {
	let ctx;
	try {
		ctx = await mutatorPreflight(cfg, { exec, env });
		const fromPkgRoot = currentPkgRoot(cfg);
		const fromVer = fromPkgRoot
			? fs
					.readFileSync(path.join(fromPkgRoot, ".flywheel-prebuilt"), "utf8")
					.trim()
			: null;
		const target = previousGood(cfg, ctx.ledger, fromVer);
		if (!target) {
			io.err(MSG.rollbackNone);
			return 1;
		}
		const result = await applyVersion(cfg, ctx.ledger, {
			...options,
			operation: "rollback",
			ver: target.ver,
			fromVer,
			fromPkgRoot,
			holdOutgoingReason: fromVer === null ? null : "manual_rollback",
			exec,
			env,
			loadTarball: () => {
				throw new Error("local rollback target disappeared");
			},
		});
		if (result.outcome === "updated") {
			io.out(`${MSG.rollbackDone}\n`);
			return 0;
		}
		io.err(
			result.outcome === "rolled_back"
				? MSG.rollbackFailedRestored
				: MSG.updateRollbackDegraded,
		);
		return 1;
	} catch (error) {
		io.err(messageFor(error));
		return error instanceof LockBusy ? 75 : 1;
	} finally {
		ctx?.lock.release();
	}
}
