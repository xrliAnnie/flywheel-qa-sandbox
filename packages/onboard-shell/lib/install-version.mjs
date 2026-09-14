import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { applyVersion } from "./apply.mjs";
import { isSafeVersion } from "./config.mjs";
import { downloadPayload, EndpointError, fetchManifest } from "./endpoint.mjs";
import { currentPkgRoot, verifyPkgRoot } from "./install.mjs";
import { storedKey, stripKeyFromEnv } from "./key.mjs";
import { LockBusy } from "./lock.mjs";
import { MSG } from "./messages.mjs";
import { messageFor } from "./onboard.mjs";
import { mutatorPreflight } from "./preflight.mjs";
import { pruneVersions } from "./prune.mjs";

export async function runInstallVersion(
	cfg,
	ver,
	{
		io,
		exec = execFileSync,
		fetchImpl = fetch,
		env = process.env,
		...options
	} = {},
) {
	if (!isSafeVersion(ver)) {
		io.err(MSG.versionNotAvailable);
		return 2;
	}
	let ctx;
	let tarball;
	try {
		ctx = await mutatorPreflight(cfg, { exec, env });
		const key = storedKey(cfg.envFile);
		stripKeyFromEnv(env);
		if (!key) throw new EndpointError("unauthorized", "missing stored key");
		const manifest = await fetchManifest(cfg.endpoint, key, { fetchImpl });
		const entry = manifest.versions.find((v) => v.ver === ver);
		if (!entry || typeof entry.sha256 !== "string") {
			io.err(MSG.versionNotAvailable);
			return 1;
		}
		const current = currentPkgRoot(cfg);
		let fromVer = null;
		try {
			if (current)
				fromVer = fs
					.readFileSync(path.join(current, ".flywheel-prebuilt"), "utf8")
					.trim();
		} catch {}
		if (fromVer === ver) {
			try {
				verifyPkgRoot(current, ver);
			} catch {
				io.err(MSG.currentDamaged);
				return 1;
			}
			if (!Object.hasOwn(ctx.ledger.holds, ver)) {
				io.out(`${MSG.installVersionNone}\n`);
				return 0;
			}
		}
		const result = await applyVersion(cfg, ctx.ledger, {
			...options,
			operation: "install_version",
			ver,
			fromVer,
			fromPkgRoot: fromVer === ver ? null : current,
			clearHoldOnVer: ver,
			exec,
			env,
			loadTarball: async () => {
				tarball = await downloadPayload(cfg.endpoint, key, ver, entry.sha256, {
					fetchImpl,
				});
				return tarball;
			},
		});
		if (result.outcome === "updated") {
			pruneVersions(cfg);
			io.out(`${MSG.installVersionDone}\n`);
			return 0;
		}
		io.err(
			result.outcome === "rolled_back"
				? MSG.updateRollback
				: result.outcome === "degraded"
					? MSG.updateRollbackDegraded
					: messageFor(result.error),
		);
		return 1;
	} catch (error) {
		io.err(messageFor(error));
		return error instanceof LockBusy ? 75 : 1;
	} finally {
		if (tarball) {
			try {
				fs.rmSync(path.dirname(tarball), { recursive: true, force: true });
			} catch {}
		}
		ctx?.lock.release();
	}
}
