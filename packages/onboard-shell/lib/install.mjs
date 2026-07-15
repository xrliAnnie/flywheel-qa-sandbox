// FLY-1062 PR2 · install orchestration — npm install --prefix, compat mirror,
// smoke check, atomic `current` flip. Zero-half-baked discipline: a version
// dir that fails any step is removed and `current` is never pointed at it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { versionPrefix } from "./config.mjs";

// pkgRootOf <prefix> → the installed PKG_ROOT (the dir under
// <prefix>/node_modules that carries the .flywheel-prebuilt sentinel), or null.
export function pkgRootOf(prefix) {
	const nm = path.join(prefix, "node_modules");
	let entries;
	try {
		entries = fs.readdirSync(nm);
	} catch {
		return null;
	}
	for (const e of entries) {
		const root = path.join(nm, e);
		if (fs.existsSync(path.join(root, ".flywheel-prebuilt"))) return root;
	}
	return null;
}

// verifyPkgRoot <pkgRoot> <ver> — smoke gate: sentinel present + version match
// + compiled Bridge entry + the runtime scripts the shell hands off to /
// invokes must ALL be present. A payload missing any of them must be REFUSED
// at install time, never promoted to `current` (Codex R1#3 — the exec'd
// onboard.sh + the compat mirror the installer calls are required, not
// optional). "installs ≠ boots" bar, cheap prefix of it.
const REQUIRED_PKG_FILES = [
	"dist/run-bridge.js",
	"scripts/flywheel-onboard.sh",
	"scripts/packaged/create-compat-mirror.sh",
	// The update seam restarts services onto new code; a payload without it can
	// be flipped to `current` but never actually restart onto the new version —
	// require it so an incomplete tree is refused at install, not silently
	// promoted with exit 0 (Codex R2).
	"scripts/packaged/restart-packaged-services.sh",
];
// isFile <p> → true only for a regular file (a directory sharing the name of a
// required file must NOT satisfy the smoke gate — Codex R3).
function isFile(p) {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}
export function verifyPkgRoot(pkgRoot, ver) {
	const sentinel = path.join(pkgRoot, ".flywheel-prebuilt");
	if (!isFile(sentinel))
		throw new Error("payload missing .flywheel-prebuilt sentinel");
	const got = fs.readFileSync(sentinel, "utf8").trim();
	if (got !== ver) throw new Error(`payload version ${got} != expected ${ver}`);
	for (const rel of REQUIRED_PKG_FILES) {
		if (!isFile(path.join(pkgRoot, rel))) {
			throw new Error(`payload missing required file: ${rel}`);
		}
	}
}

// atomicSymlink <target> <linkPath> — tmp-symlink + rename so an interrupted
// flip never leaves `current` dangling or half-written. If the rename throws,
// remove the tmp symlink before rethrowing so a failed flip leaves NO stray
// `current.tmp.*` residue (Codex R4).
export function atomicSymlink(target, linkPath) {
	const tmp = `${linkPath}.tmp.${process.pid}.${Date.now()}`;
	try {
		fs.rmSync(tmp, { force: true });
	} catch {}
	fs.symlinkSync(target, tmp);
	try {
		fs.renameSync(tmp, linkPath);
	} catch (e) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {}
		throw e;
	}
}

// currentPkgRoot <cfg> → the PKG_ROOT `current` points at, or null.
export function currentPkgRoot(cfg) {
	try {
		return fs.realpathSync(cfg.currentLink);
	} catch {
		return null;
	}
}

// installVersion <cfg> <ver> <tarball> <opts> → PKG_ROOT (does NOT flip
// current). Fail-closed: removes the version dir on any error.
export function installVersion(
	cfg,
	ver,
	tarball,
	{ exec = execFileSync } = {},
) {
	const prefix = versionPrefix(cfg, ver);
	fs.mkdirSync(prefix, { recursive: true });
	try {
		exec(
			"npm",
			["install", "--prefix", prefix, tarball, "--no-audit", "--no-fund"],
			{
				stdio: "ignore",
			},
		);
		const pkgRoot = pkgRootOf(prefix);
		if (!pkgRoot) throw new Error("installed payload has no PKG_ROOT sentinel");
		const mirror = path.join(
			pkgRoot,
			"scripts",
			"packaged",
			"create-compat-mirror.sh",
		);
		if (fs.existsSync(mirror)) {
			exec("bash", [mirror, pkgRoot], { stdio: "ignore" });
		}
		verifyPkgRoot(pkgRoot, ver);
		return pkgRoot;
	} catch (e) {
		try {
			fs.rmSync(prefix, { recursive: true, force: true });
		} catch {}
		throw e;
	}
}

// flipCurrent <cfg> <pkgRoot> — atomically point current at pkgRoot. The
// previous version dir is left in place as the rollback slot (update rolls
// current back to it on an unhealthy restart); pruning older dirs is a
// follow-up (研究 §10 note in the plan).
export function flipCurrent(cfg, pkgRoot) {
	fs.mkdirSync(cfg.runtimeRoot, { recursive: true });
	atomicSymlink(pkgRoot, cfg.currentLink);
}

// installedComplete <cfg> → true if current points at a smoke-valid PKG_ROOT.
export function installedComplete(cfg) {
	const pkgRoot = currentPkgRoot(cfg);
	if (!pkgRoot) return false;
	try {
		const ver = fs
			.readFileSync(path.join(pkgRoot, ".flywheel-prebuilt"), "utf8")
			.trim();
		verifyPkgRoot(pkgRoot, ver);
		return fs.existsSync(path.join(pkgRoot, "scripts", "flywheel-onboard.sh"));
	} catch {
		return false;
	}
}
