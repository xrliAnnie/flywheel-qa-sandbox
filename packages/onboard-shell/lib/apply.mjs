import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { versionPrefix } from "./config.mjs";
import {
	currentPkgRoot,
	flipCurrent,
	installVersion,
	pkgRootOf,
	verifyPkgRoot,
} from "./install.mjs";
import { stripKeyFromEnv } from "./key.mjs";
import {
	commitApplySuccess,
	recordRun,
	setApplying,
	setHold,
	writeLedger,
} from "./ledger.mjs";

export function restartServices(pkgRoot, exec = execFileSync) {
	exec(
		"bash",
		[path.join(pkgRoot, "scripts/packaged/restart-packaged-services.sh")],
		{ stdio: "ignore" },
	);
}

export async function applyVersion(
	cfg,
	ledger,
	{
		ver,
		fromVer = null,
		fromPkgRoot = null,
		operation = "update",
		trigger = "manual",
		holdOutgoingReason = null,
		clearHoldOnVer = null,
		loadTarball,
		exec = execFileSync,
		env = process.env,
		now = () => new Date().toISOString(),
		checkpoint = () => {},
		fsImpl = fs,
		flip = flipCurrent,
	} = {},
) {
	stripKeyFromEnv(env);
	const prefix = versionPrefix(cfg, ver);
	let target = pkgRootOf(prefix);
	let invalidTarget = false;
	try {
		if (target) verifyPkgRoot(target, ver);
		else invalidTarget = fs.existsSync(prefix);
	} catch {
		invalidTarget = true;
	}
	if (invalidTarget) {
		const current = currentPkgRoot(cfg);
		const prefixRoot = fs.realpathSync(prefix);
		if (
			current &&
			(current === prefixRoot || current.startsWith(`${prefixRoot}${path.sep}`))
		)
			throw new Error("current payload is damaged");
		target = null;
	}
	const applying = {
		operation,
		ver,
		fromVer,
		fromPkgRoot,
		targetCreated: !target,
		phase: "installing",
		holdOutgoingReason,
		clearHoldOnVer,
		startedAt: now(),
		trigger,
	};
	setApplying(cfg, ledger, applying, { fsImpl });
	checkpoint("installing_intent");
	try {
		if (invalidTarget) fs.rmSync(prefix, { recursive: true, force: true });
		if (!target)
			target = installVersion(cfg, ver, await loadTarball(), { exec });
	} catch (error) {
		if (applying.targetCreated)
			fs.rmSync(prefix, { recursive: true, force: true });
		finishSettlement(cfg, ledger, "error", now(), fsImpl);
		return { outcome: "error", error };
	}
	checkpoint("installed");
	try {
		setApplying(cfg, ledger, { ...applying, phase: "flipped" }, { fsImpl });
	} catch (error) {
		if (applying.targetCreated)
			fsImpl.rmSync(prefix, { recursive: true, force: true });
		finishSettlement(cfg, ledger, "error", now(), fsImpl);
		return { outcome: "error", error };
	}
	checkpoint("flipped_intent");
	try {
		flip(cfg, target);
	} catch (error) {
		if (applying.targetCreated)
			fsImpl.rmSync(prefix, { recursive: true, force: true });
		finishSettlement(cfg, ledger, "error", now(), fsImpl);
		return { outcome: "error", error };
	}
	checkpoint("flipped");
	try {
		restartServices(target, exec);
	} catch {
		return recoverApply(cfg, ledger, { exec, now, checkpoint, fsImpl });
	}
	checkpoint("healthy");
	commitApplySuccess(cfg, ledger, { at: now(), fsImpl });
	checkpoint("committed");
	return { outcome: "updated" };
}

export function isSelfReapply(a) {
	return (
		a.operation === "install_version" &&
		a.fromVer === a.ver &&
		a.fromPkgRoot === null &&
		a.targetCreated === false
	);
}

export function recoverApply(
	cfg,
	ledger,
	{
		exec = execFileSync,
		now = () => new Date().toISOString(),
		checkpoint = () => {},
		fsImpl = fs,
	} = {},
) {
	const a = ledger.applying;
	let receiptWritten = false;
	try {
		const next = structuredClone(ledger);
		setHold(next, a.ver, "health_failed", now(), a.startedAt);
		next.applying.phase = "recovering";
		writeLedger(cfg, next, { fsImpl });
		Object.assign(ledger, next);
		receiptWritten = true;
	} catch {
		/* Recover services even when the receipt could not be persisted. */
	}
	checkpoint("failure_receipt");
	let residueCleared = true;
	let restored = false;
	if (!isSelfReapply(a)) {
		if (a.targetCreated) {
			try {
				fsImpl.rmSync(versionPrefix(cfg, a.ver), {
					recursive: true,
					force: true,
				});
			} catch {
				residueCleared = false;
			}
		}
		checkpoint("target_cleaned");
		let fromValid = false;
		if (a.fromPkgRoot) {
			try {
				verifyPkgRoot(a.fromPkgRoot, a.fromVer);
				fromValid = true;
			} catch {}
		}
		if (fromValid) {
			try {
				flipCurrent(cfg, a.fromPkgRoot);
			} catch {
				fromValid = false;
			}
			checkpoint("restored_pointer");
			if (fromValid) {
				try {
					restartServices(a.fromPkgRoot, exec);
					restored = true;
				} catch {}
			}
		} else {
			try {
				fsImpl.rmSync(cfg.currentLink, { force: true });
			} catch {
				residueCleared = false;
			}
		}
	}
	checkpoint("restored_health");
	const outcome =
		restored && residueCleared && receiptWritten ? "rolled_back" : "degraded";
	if (receiptWritten) {
		const next = structuredClone(ledger);
		next.applying = null;
		recordRun(next, {
			at: now(),
			trigger: a.trigger,
			outcome,
			latest: a.ver,
			detail: residueCleared ? "" : "cleanup_incomplete",
		});
		writeLedger(cfg, next, { fsImpl });
		Object.assign(ledger, next);
	}
	return { outcome };
}

export async function settleInflight(
	cfg,
	ledger,
	{
		exec = execFileSync,
		now = () => new Date().toISOString(),
		checkpoint = () => {},
		fsImpl = fs,
	} = {},
) {
	const a = ledger.applying;
	if (!a) return null;
	const target = pkgRootOf(versionPrefix(cfg, a.ver));
	const current = currentPkgRoot(cfg);
	if (a.phase === "flipped" && target && current === fs.realpathSync(target)) {
		try {
			verifyPkgRoot(target, a.ver);
			restartServices(target, exec);
		} catch {
			return recoverApply(cfg, ledger, { exec, now, checkpoint, fsImpl });
		}
		checkpoint("healthy");
		commitApplySuccess(cfg, ledger, { at: now(), outcome: "settled", fsImpl });
		return { outcome: "settled" };
	}
	if (a.phase === "installing") {
		let clean = true;
		// An unexpected pointer to this target is never permission to delete it.
		if (
			a.targetCreated &&
			!isSelfReapply(a) &&
			!(target && current === fs.realpathSync(target))
		) {
			try {
				fsImpl.rmSync(versionPrefix(cfg, a.ver), {
					recursive: true,
					force: true,
				});
			} catch {
				clean = false;
			}
		}
		return finishSettlement(
			cfg,
			ledger,
			clean ? "settled" : "degraded",
			now(),
			fsImpl,
		);
	}
	let from = null;
	try {
		if (a.fromPkgRoot) from = fs.realpathSync(a.fromPkgRoot);
	} catch {}
	if (
		current &&
		current !== from &&
		(!target || current !== fs.realpathSync(target)) &&
		!isSelfReapply(a)
	) {
		const next = structuredClone(ledger);
		setHold(next, a.ver, "health_failed", now(), a.startedAt);
		next.applying.phase = "recovering";
		writeLedger(cfg, next, { fsImpl });
		Object.assign(ledger, next);
		checkpoint("failure_receipt");
		return finishSettlement(
			cfg,
			ledger,
			"degraded",
			now(),
			fsImpl,
			"current_changed",
		);
	}
	return recoverApply(cfg, ledger, { exec, now, checkpoint, fsImpl });
}

function finishSettlement(cfg, ledger, outcome, at, fsImpl, detail = "") {
	const next = structuredClone(ledger);
	const a = next.applying;
	next.applying = null;
	recordRun(next, {
		at,
		trigger: a.trigger,
		outcome,
		latest: a.ver,
		detail,
	});
	writeLedger(cfg, next, { fsImpl });
	Object.assign(ledger, next);
	return { outcome };
}
