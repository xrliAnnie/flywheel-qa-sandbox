import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { applyVersion } from "./apply.mjs";
import { downloadPayload, EndpointError, fetchManifest } from "./endpoint.mjs";
import { currentPkgRoot } from "./install.mjs";
import { recordVersion } from "./journal.mjs";
import { hiddenPrompt, storedKey, stripKeyFromEnv } from "./key.mjs";
import { holdBlocks, recordRun, setHold, writeLedger } from "./ledger.mjs";
import { LockBusy } from "./lock.mjs";
import { MSG } from "./messages.mjs";
import { exchangeWithRotation, messageFor } from "./onboard.mjs";
import { mutatorPreflight } from "./preflight.mjs";
import { pruneVersions } from "./prune.mjs";
import { inApplyWindow, nextApplyAt, readSchedule } from "./schedule.mjs";
import { refreshUpdater } from "./shell-copy.mjs";

export async function runUpdate(
	cfg,
	{
		io,
		exec = execFileSync,
		fetchImpl = fetch,
		promptFn = hiddenPrompt,
		env = process.env,
		now = () => new Date().toISOString(),
		unattended = false,
	} = {},
) {
	let ctx;
	let tarball = null;
	let latest = null;
	let priorRun = null;
	const trigger = unattended ? "timer" : "manual";
	function record(outcome) {
		recordRun(ctx.ledger, { at: now(), trigger, outcome, latest, detail: "" });
		writeLedger(cfg, ctx.ledger);
	}
	try {
		ctx = await mutatorPreflight(cfg, { exec, env, unattended });
		if (ctx.disabled) return 0;
		priorRun = ctx.ledger.lastRun;
		const key = storedKey(cfg.envFile);
		if (!key) throw new EndpointError("unauthorized", "missing stored key");
		stripKeyFromEnv(env);
		const exchange = unattended
			? { key, manifest: await fetchManifest(cfg.endpoint, key, { fetchImpl }) }
			: await exchangeWithRotation(cfg, {
					io,
					exec,
					fetchImpl,
					promptFn,
					key,
					keyIsStored: true,
					persistOnSuccess: false,
					shouldDownload: () => false,
				});
		const manifest = exchange.manifest;
		latest = manifest.latest;
		const entry = manifest.versions.find((v) => v.ver === manifest.latest);
		if (!entry || typeof entry.sha256 !== "string")
			throw new EndpointError("protocol", "missing latest entry");
		const oldPkgRoot = currentPkgRoot(cfg);
		let oldVer = null;
		try {
			if (oldPkgRoot)
				oldVer = fs
					.readFileSync(path.join(oldPkgRoot, ".flywheel-prebuilt"), "utf8")
					.trim();
		} catch {}
		const immediate =
			oldVer !== null && !manifest.versions.some((v) => v.ver === oldVer);
		if (immediate) {
			setHold(ctx.ledger, oldVer, "withdrawn_observed", now());
			writeLedger(cfg, ctx.ledger);
		}
		if (oldVer === manifest.latest) {
			ctx.ledger.pendingVersion = null;
			ctx.ledger.nextApplyAt = null;
			record("up_to_date");
			io.out(`${MSG.updateNone}\n`);
			return 0;
		}
		if (holdBlocks(ctx.ledger, latest, Date.parse(now()))) {
			record("held");
			io.out(`${MSG.heldSkip}\n`);
			return 0;
		}
		const schedule = readSchedule(cfg);
		if (unattended && !immediate && !inApplyWindow(schedule, new Date(now()))) {
			ctx.ledger.pendingVersion = latest;
			ctx.ledger.nextApplyAt = nextApplyAt(schedule, new Date(now()));
			record("deferred");
			return 0;
		}
		const result = await applyVersion(cfg, ctx.ledger, {
			ver: entry.ver,
			fromVer: oldVer,
			fromPkgRoot: oldPkgRoot,
			exec,
			env,
			now,
			trigger,
			loadTarball: async () => {
				tarball = await downloadPayload(
					cfg.endpoint,
					exchange.key,
					entry.ver,
					entry.sha256,
					{ fetchImpl },
				);
				return tarball;
			},
		});
		if (result.outcome !== "updated") {
			io.err(
				result.outcome === "rolled_back"
					? MSG.updateRollback
					: result.outcome === "degraded"
						? MSG.updateRollbackDegraded
						: messageFor(result.error),
			);
			return 1;
		}
		pruneVersions(cfg);
		try {
			recordVersion(cfg, entry.ver);
		} catch {}
		io.out(`${MSG.done}\n`);
		return 0;
	} catch (error) {
		const outcome =
			error instanceof EndpointError && error.kind === "paused"
				? "paused"
				: error instanceof EndpointError && error.kind === "unauthorized"
					? "unauthorized"
					: "error";
		if (ctx?.ledger && ctx.ledger.applying === null) record(outcome);
		if (outcome === "paused") {
			io.out(`${MSG.paused}\n`);
			return 0;
		}
		io.err(messageFor(error));
		return error instanceof LockBusy ? 75 : 1;
	} finally {
		if (tarball) {
			try {
				fs.rmSync(path.dirname(tarball), { recursive: true, force: true });
			} catch {}
		}
		if (ctx && !unattended) refreshUpdater(cfg, { exec, env });
		ctx?.lock.release();
		if (unattended && ctx?.ledger?.lastRun && ctx.ledger.lastRun !== priorRun)
			io.out(
				`${ctx.ledger.lastRun.at} outcome=${ctx.ledger.lastRun.outcome}\n`,
			);
	}
}
