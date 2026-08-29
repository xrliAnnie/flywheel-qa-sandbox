// FLY-1062 PR2 · default-command orchestration: detect/reuse → acquire key →
// exchange key for payload → install → flip current → exec onboard.sh.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { versionPrefix } from "./config.mjs";
import { downloadPayload, EndpointError, fetchManifest } from "./endpoint.mjs";
import {
	currentPkgRoot,
	flipCurrent,
	installedComplete,
	installVersion,
} from "./install.mjs";
import { recordVersion } from "./journal.mjs";
import {
	hiddenPrompt,
	keyFromEnv,
	persistKey,
	storedKey,
	stripKeyFromEnv,
} from "./key.mjs";
import { MSG } from "./messages.mjs";

// messageFor <error> → the honest customer message for a failure kind.
// Only a genuine network failure gets the "check your network" advice; a
// protocol error (malformed manifest) or any non-endpoint failure (disk,
// permissions, npm, mirror) gets a generic honest message — never mis-advise
// the customer to check their network for a local problem (Codex R1#7).
export function messageFor(e) {
	if (e instanceof EndpointError) {
		if (e.kind === "unauthorized") return MSG.keyInvalid;
		if (e.kind === "checksum") return MSG.checksum;
		if (e.kind === "network") return MSG.network;
		return MSG.generic; // protocol / anything else
	}
	return MSG.generic;
}

// acquireKey → { key, isNew }. Order: stored .env → env(double-switch) →
// hidden TTY prompt. Never echoes the key.
export async function acquireKey(
	cfg,
	{ io, promptFn = hiddenPrompt, env = process.env },
) {
	const stored = storedKey(cfg.envFile);
	if (stored) return { key: stored, isNew: false };
	const { key: envKey, rejected } = keyFromEnv(env);
	if (rejected) io.err(MSG.keyRejectedEnv);
	if (envKey) return { key: envKey, isNew: true };
	io.out(`${MSG.keyMissing}\n`);
	const k = await promptFn(MSG.keyPromptHidden, {
		input: io.input,
		output: io.output,
	});
	return { key: (k || "").trim(), isNew: true };
}

// exchangeWithRotation <cfg> <opts> → { key, manifest, entry?, tarball?,
// skipped? }. Fetches the manifest with the key; on 401 (revoked key) it
// rotates ONCE when the key came from storage — hidden-reads a new key,
// atomically persists it (the license換發 channel, Codex R4#1), and retries.
// A freshly-typed key that 401s is NOT rotated (mistyped → surface
// keyInvalid). If shouldDownload(manifest) is false the payload is skipped
// (update's "already latest" short-circuit) and {skipped:true} is returned;
// otherwise the payload is downloaded + sha-verified. Persists a successful
// new key to 0600 .env.
export async function exchangeWithRotation(
	cfg,
	{
		io,
		fetchImpl = fetch,
		promptFn = hiddenPrompt,
		key,
		keyIsStored,
		persistOnSuccess,
		shouldDownload = () => true,
	},
) {
	let curKey = key;
	let canRotate = keyIsStored === true;
	let persist = persistOnSuccess === true;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		try {
			const manifest = await fetchManifest(cfg.endpoint, curKey, { fetchImpl });
			if (persist) persistKey(cfg.envFile, curKey);
			if (!shouldDownload(manifest)) {
				return { key: curKey, manifest, skipped: true };
			}
			const entry = manifest.versions.find((v) => v.ver === manifest.latest);
			if (!entry || typeof entry.sha256 !== "string") {
				throw new EndpointError(
					"protocol",
					"manifest latest has no sha256 entry",
				);
			}
			const tarball = await downloadPayload(
				cfg.endpoint,
				curKey,
				entry.ver,
				entry.sha256,
				{
					fetchImpl,
				},
			);
			return { key: curKey, manifest, entry, tarball };
		} catch (e) {
			if (
				e instanceof EndpointError &&
				e.kind === "unauthorized" &&
				canRotate
			) {
				io.err(MSG.keyInvalid);
				io.out("请粘贴新的授权码(粘贴时不会显示):\n");
				const nk = (
					(await promptFn(MSG.keyPromptHidden, {
						input: io.input,
						output: io.output,
					})) || ""
				).trim();
				if (!nk) throw e;
				curKey = nk;
				canRotate = false;
				persist = true;
				continue;
			}
			throw e;
		}
	}
}

// execOnboardShell <cfg> — hand off to the packaged Buddy onboard entry. The
// key has already been stripped from env before we get here.
export function execOnboardShell(cfg, exec = execFileSync) {
	const script = path.join(cfg.currentLink, "scripts", "flywheel-onboard.sh");
	exec("bash", [script], { stdio: "inherit" });
}

// handoff <cfg> <exec> <io> → exit code. The install is complete and KEPT
// (installedComplete re-runs resume at this step — rolling it back would force a
// re-download, defeating the resumable fast path). So a setup-script failure is
// NOT an install failure: keep `current`, and give the honest resumable message
// instead of the generic "unexpected error" (Codex R4).
function handoff(cfg, exec, io) {
	try {
		execOnboardShell(cfg, exec);
		return 0;
	} catch {
		io.err(MSG.setupFailed);
		return 1;
	}
}

// runOnboard <cfg> <opts> → exit code. opts.io = {out,err,input,output}.
export async function runOnboard(
	cfg,
	{
		io,
		exec = execFileSync,
		fetchImpl = fetch,
		promptFn = hiddenPrompt,
		env = process.env,
	} = {},
) {
	if (installedComplete(cfg)) {
		// Second run: nothing to fetch, no key prompt — just hand off. Strip
		// any inherited key from the env first so the exec'd child can't read
		// it (Codex R1#1 — the fast path skipped this).
		stripKeyFromEnv(env);
		return handoff(cfg, exec, io);
	}
	let key = null;
	let tarball = null;
	try {
		const acq = await acquireKey(cfg, { io, promptFn, env });
		key = acq.key;
		// Strip the key from the env NOW — before any child process (npm,
		// mirror, restart, the exec'd onboard.sh) is spawned. The key lives
		// only in the local `key`/curKey variables from here on (Codex R1#1).
		stripKeyFromEnv(env);
		if (!key) {
			io.err(MSG.keyMissing);
			return 1;
		}
		const ex = await exchangeWithRotation(cfg, {
			io,
			fetchImpl,
			promptFn,
			key,
			keyIsStored: !acq.isNew, // a stored key that 401s is a revocation → rotate
			persistOnSuccess: acq.isNew, // a freshly-typed key persists on success
		});
		tarball = ex.tarball;
		// Capture the previous current BEFORE promotion so a failed flip can be
		// undone (fresh install → null). installVersion is already fail-closed
		// (removes the version dir on any install error); the remaining window is
		// the flip itself — make it transactional too (Codex R3): on a flip
		// failure remove the just-installed version dir and restore the previous
		// current, so no half-baked version tree or dangling link is left behind.
		const prevCurrent = currentPkgRoot(cfg);
		const pkgRoot = installVersion(cfg, ex.entry.ver, tarball, { exec });
		try {
			flipCurrent(cfg, pkgRoot);
		} catch (e) {
			try {
				fs.rmSync(versionPrefix(cfg, ex.entry.ver), {
					recursive: true,
					force: true,
				});
			} catch {}
			if (prevCurrent) {
				try {
					flipCurrent(cfg, prevCurrent);
				} catch {}
			} else {
				try {
					fs.rmSync(cfg.currentLink, { force: true });
				} catch {}
			}
			throw e;
		}
		// The journal is a best-effort resume hint — a write failure must NOT fail
		// an otherwise-successful install (current already points at a valid tree).
		try {
			recordVersion(cfg, ex.entry.ver);
		} catch {}
	} catch (e) {
		io.err(messageFor(e));
		return 1;
	} finally {
		if (tarball) {
			try {
				fs.rmSync(path.dirname(tarball), { recursive: true, force: true });
			} catch {}
		}
		key = null;
	}
	io.out(`${MSG.done}\n`);
	return handoff(cfg, exec, io);
}
