// FLY-1062 PR2 · onboard-shell config — paths + endpoint resolution.
//
// Pure path derivation so every other module (and the tests) can point the
// whole shell at a temp HOME. Nothing here touches the network or the key.
import { homedir } from "node:os";
import path from "node:path";

// The public hosting endpoint is filled in PR3/PR4. Until then the default is
// an obviously-unreachable placeholder so an un-stubbed run fails loudly
// rather than silently hitting something real. Tests inject a stub via
// FLYWHEEL_ONBOARD_ENDPOINT.
export const DEFAULT_ENDPOINT = "https://onboard.flywheel.invalid";

export function resolveConfig(env = process.env) {
	const home = env.HOME || homedir();
	const stateDir = env.FLYWHEEL_STATE_DIR || path.join(home, ".flywheel");
	const runtimeRoot = path.join(stateDir, "runtime");
	return {
		home,
		stateDir,
		envFile: path.join(stateDir, ".env"),
		runtimeRoot,
		versionsDir: path.join(runtimeRoot, "versions"),
		currentLink: path.join(runtimeRoot, "current"),
		endpoint: (env.FLYWHEEL_ONBOARD_ENDPOINT || DEFAULT_ENDPOINT).replace(
			/\/+$/,
			"",
		),
	};
}

// isSafeVersion <ver> — a version string from the (untrusted) manifest becomes
// a filesystem path component AND a target for rmSync. Reject anything that
// could escape versionsDir (path traversal / separators / absolute) so a
// hostile or corrupt `latest: ".."` can never delete outside the runtime
// (Codex R1#2). Grammar = the shipping payload versions (semver-ish).
export function isSafeVersion(ver) {
	return (
		typeof ver === "string" &&
		ver.length > 0 &&
		ver.length <= 64 &&
		/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(ver) &&
		!ver.includes("..")
	);
}

// versionDir <cfg> <ver> — the npm --prefix for a version (PKG_ROOT lives at
// <prefix>/node_modules/<payload-name>, §0 layout contract). Fails closed on
// an unsafe version so a traversal string never reaches path.join / rmSync.
export function versionPrefix(cfg, ver) {
	if (!isSafeVersion(ver)) {
		throw new Error(`unsafe version string refused: ${JSON.stringify(ver)}`);
	}
	return path.join(cfg.versionsDir, ver);
}
