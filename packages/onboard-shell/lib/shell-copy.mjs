import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSafeVersion } from "./config.mjs";
import { atomicSymlink, currentPkgRoot } from "./install.mjs";
import { stripKeyFromEnv } from "./key.mjs";

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function verifyCopy(root, version, libs) {
	const pkg = JSON.parse(
		fs.readFileSync(path.join(root, "package.json"), "utf8"),
	);
	if (pkg.version !== version) throw new Error("shell version mismatch");
	for (const file of [
		"bin/flywheel-onboard.js",
		...libs.map((name) => `lib/${name}`),
	]) {
		if (!fs.statSync(path.join(root, file)).isFile())
			throw new Error("incomplete shell copy");
	}
	const copiedLibs = fs
		.readdirSync(path.join(root, "lib"))
		.filter((name) => name.endsWith(".mjs"))
		.sort();
	if (JSON.stringify(copiedLibs) !== JSON.stringify(libs))
		throw new Error("shell file set mismatch");
}

export function refreshShellCopy(
	cfg,
	{ source = SOURCE, checkpoint = () => {} } = {},
) {
	const version = JSON.parse(
		fs.readFileSync(path.join(source, "package.json"), "utf8"),
	).version;
	if (!isSafeVersion(version)) throw new Error("invalid shell version");
	const libs = fs
		.readdirSync(path.join(source, "lib"))
		.filter((name) => name.endsWith(".mjs"))
		.sort();
	const versions = path.join(cfg.stateDir, "shell/versions");
	fs.mkdirSync(versions, { recursive: true });
	const destination = path.join(versions, version);
	let complete = false;
	try {
		verifyCopy(destination, version, libs);
		complete = true;
	} catch {}
	if (!complete) {
		const temp = path.join(versions, `.tmp-${version}-${randomUUID()}`);
		fs.mkdirSync(temp);
		for (const file of ["package.json", "bin", "lib", "README.md"])
			fs.cpSync(path.join(source, file), path.join(temp, file), {
				recursive: true,
			});
		verifyCopy(temp, version, libs);
		checkpoint("copied");
		if (fs.existsSync(destination))
			fs.renameSync(
				destination,
				path.join(versions, `.trash-${version}-${randomUUID()}`),
			);
		fs.renameSync(temp, destination);
		checkpoint("promoted");
	}
	atomicSymlink(destination, path.join(cfg.stateDir, "shell/current"));
	checkpoint("linked");
	for (const name of fs.readdirSync(versions)) {
		if (name.startsWith(".tmp-") || name.startsWith(".trash-"))
			fs.rmSync(path.join(versions, name), { recursive: true, force: true });
	}
	const old = fs
		.readdirSync(versions)
		.filter((name) => name !== version && isSafeVersion(name))
		.sort(
			(a, b) =>
				fs.statSync(path.join(versions, b)).mtimeMs -
				fs.statSync(path.join(versions, a)).mtimeMs,
		);
	for (const name of old.slice(1))
		fs.rmSync(path.join(versions, name), { recursive: true, force: true });
	return destination;
}

// Refresh is auxiliary: failure must not undo a healthy installation.
export function refreshUpdater(
	cfg,
	{ exec = execFileSync, env = process.env } = {},
) {
	try {
		refreshShellCopy(cfg);
		const current = currentPkgRoot(cfg);
		if (!current) return;
		const bootstrap = path.join(
			current,
			"scripts/packaged/bootstrap-services.sh",
		);
		if (!fs.existsSync(bootstrap)) return;
		exec(
			"bash",
			[bootstrap, "--only", "auto-update", "--state-dir", cfg.stateDir],
			{ stdio: "ignore", env: stripKeyFromEnv({ ...env }) },
		);
	} catch {
		try {
			const logs = path.join(cfg.stateDir, "logs");
			fs.mkdirSync(logs, { recursive: true });
			fs.appendFileSync(
				path.join(logs, "auto-update.log"),
				`${new Date().toISOString()} updater_refresh_failed\n`,
			);
		} catch {
			/* No working log destination; preserve the primary command result. */
		}
	}
}
