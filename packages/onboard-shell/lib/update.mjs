// FLY-1062 PR2 · packaged update seam — NOT restart-services.sh. Uses the
// stored key to fetch the manifest, installs a new version dir, atomically
// flips current (keeping the old one as a rollback slot), restarts the
// already-installed services through the supervisor seam (PR1's
// restart-packaged-services.sh, which carries its own health gate), and rolls
// back current on failure.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { versionPrefix } from "./config.mjs";
import { currentPkgRoot, flipCurrent, installVersion } from "./install.mjs";
import { recordVersion } from "./journal.mjs";
import { hiddenPrompt, storedKey, stripKeyFromEnv } from "./key.mjs";
import { MSG } from "./messages.mjs";
import { exchangeWithRotation, messageFor } from "./onboard.mjs";

// restartServices <pkgRoot> <exec> — run a PKG_ROOT's supervisor restart seam;
// throws (its non-zero exit) if the tree is unhealthy. The seam is a REQUIRED
// payload file (verifyPkgRoot enforces it), so a missing seam is a broken tree,
// not a no-op: fail loud so the update rolls back instead of silently promoting
// a version whose services never actually restart onto the new code (Codex R2).
function restartServices(pkgRoot, exec) {
	const restart = path.join(
		pkgRoot,
		"scripts",
		"packaged",
		"restart-packaged-services.sh",
	);
	if (!fs.existsSync(restart)) {
		throw new Error(`payload missing restart seam: ${restart}`);
	}
	exec("bash", [restart], { stdio: "ignore" });
}

export async function runUpdate(
	cfg,
	{
		io,
		exec = execFileSync,
		fetchImpl = fetch,
		promptFn = hiddenPrompt,
		env = process.env,
	} = {},
) {
	const key = storedKey(cfg.envFile);
	if (!key) {
		io.err(MSG.keyInvalid);
		return 1;
	}
	// The stored key came from the .env file; a customer may ALSO have exported
	// FLYWHEEL_LICENSE_KEY into this process's env. Strip it before spawning any
	// child (npm / mirror / restart seam) so the key never leaks into a child
	// process env in the update path (Codex R2 — mirrors runOnboard's strip).
	stripKeyFromEnv(env);
	const oldPkgRoot = currentPkgRoot(cfg);
	const oldVer = oldPkgRoot
		? (() => {
				try {
					return fs
						.readFileSync(path.join(oldPkgRoot, ".flywheel-prebuilt"), "utf8")
						.trim();
				} catch {
					return null;
				}
			})()
		: null;
	let tarball = null;
	try {
		// one exchange: fetch manifest (401 → rotate once, key is stored), skip
		// the payload download when already at latest.
		const ex = await exchangeWithRotation(cfg, {
			io,
			fetchImpl,
			promptFn,
			key,
			keyIsStored: true,
			persistOnSuccess: false, // rotation persists internally; unchanged key stays
			shouldDownload: (m) => m.latest !== oldVer,
		});
		if (ex.skipped) {
			io.out(`${MSG.updateNone}\n`);
			return 0;
		}
		const entry = ex.entry;
		tarball = ex.tarball;
		const newPkgRoot = installVersion(cfg, entry.ver, tarball, { exec });
		// Make the flip transactional too (Codex R3): if it throws, current is
		// unchanged (atomic rename) but the new version dir is residue — remove it
		// so a failed update leaves the old tree intact and no orphan dir.
		try {
			flipCurrent(cfg, newPkgRoot);
		} catch (e) {
			try {
				fs.rmSync(versionPrefix(cfg, entry.ver), {
					recursive: true,
					force: true,
				});
			} catch {}
			throw e;
		}
		try {
			restartServices(newPkgRoot, exec);
		} catch {
			// Health gate failed → transactional rollback (Codex R1#4):
			//  1. remove the failed new version dir (no residue);
			//  2. if an old version exists, flip current back AND restart it so
			//     the running Bridge/Lead return to the last good code (a symlink
			//     flip alone does not restart an already-started process);
			//  3. if there is NO old version, current now points at the (removed)
			//     new dir — drop the current symlink so nothing points at a
			//     half-baked/deleted tree.
			// A clean rollback requires BOTH: (1) the failed new version dir is
			// removed (no residue — the "zero half-baked = no orphan version dir"
			// goal, Codex R4), and (2) current points at a WORKING, running previous
			// version. If either fails — or there is no previous version to return
			// to — we do NOT claim a clean rollback; we tell the customer the machine
			// is degraded and needs us (Codex R2/R3/R4).
			let residueCleared = true;
			try {
				fs.rmSync(versionPrefix(cfg, entry.ver), {
					recursive: true,
					force: true,
				});
			} catch {
				residueCleared = false;
			}
			let restored = false;
			if (oldPkgRoot) {
				try {
					flipCurrent(cfg, oldPkgRoot);
					restartServices(oldPkgRoot, exec);
					restored = true;
				} catch {
					restored = false;
				}
			} else {
				// No previous version — dropping the (now-removed) new dir's symlink
				// leaves the machine with NO working version. That is a degraded /
				// incomplete state, NOT a rollback to a last-good version, so it must
				// never claim "切回上一个能用的版本" (Codex R3).
				try {
					fs.rmSync(cfg.currentLink, { force: true });
				} catch {}
				restored = false;
			}
			io.err(
				restored && residueCleared
					? MSG.updateRollback
					: MSG.updateRollbackDegraded,
			);
			return 1;
		}
		// The journal is a best-effort resume hint — a write failure must NOT turn
		// an update that already flipped + restarted successfully into a reported
		// failure (Codex R3).
		try {
			recordVersion(cfg, entry.ver);
		} catch {}
		io.out(`${MSG.done}\n`);
		return 0;
	} catch (e) {
		io.err(messageFor(e));
		return 1;
	} finally {
		if (tarball) {
			try {
				fs.rmSync(path.dirname(tarball), { recursive: true, force: true });
			} catch {}
		}
	}
}
