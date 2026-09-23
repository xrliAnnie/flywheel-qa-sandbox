#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const value = (name) => {
	const index = args.indexOf(name);
	if (index < 0 || !args[index + 1]) throw new Error(`${name} is required`);
	return args[index + 1];
};
const output = resolve(value("--output"));
const sourceCommit = value("--source-commit");
if (!/^[a-f0-9]{40}$/.test(sourceCommit))
	throw new Error("--source-commit must be a full lowercase SHA");
const parent = dirname(output);
mkdirSync(parent, { recursive: true, mode: 0o700 });
if (existsSync(output)) throw new Error(`output already exists: ${output}`);
const tracked = spawnSync("git", ["ls-files", "-z"], {
	cwd: repo,
	encoding: "utf8",
});
if (tracked.status !== 0)
	throw new Error(
		`git ls-files failed: ${tracked.stderr?.trim() || tracked.status}`,
	);
const sourceModes = tracked.stdout
	.split("\0")
	.filter(Boolean)
	.flatMap((relativePath) => {
		const absolute = join(repo, relativePath);
		if (!existsSync(absolute)) return [];
		const item = lstatSync(absolute);
		return item.isSymbolicLink() ? [] : [[absolute, item.mode & 0o777]];
	});
// pnpm legacy deploy calculates workspace bin links relative to its staging
// directory and cannot deploy directly under /private/tmp on macOS. Keep only
// the ephemeral assembly directory inside the repository, then rename the
// content-addressed result to the requested release root.
const temporary = mkdtempSync(join(repo, ".standing-authority-package."));
const deployed = join(temporary, "deployed-teamlead");
const packageRoot = join(temporary, "package");
try {
	const deploy = spawnSync(
		"pnpm",
		["--filter", "flywheel-teamlead", "deploy", "--prod", "--legacy", deployed],
		{ cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	if (deploy.status !== 0)
		throw new Error(
			`pnpm deploy failed: ${deploy.stderr?.trim() || deploy.stdout?.trim() || deploy.status}`,
		);
	mkdirSync(join(packageRoot, "packages"), { recursive: true });
	cpSync(deployed, join(packageRoot, "packages", "teamlead"), {
		recursive: true,
		dereference: false,
	});
	const commRoot = join(packageRoot, "packages", "flywheel-comm");
	mkdirSync(join(commRoot, "src", "bin"), { recursive: true });
	cpSync(
		join(repo, "packages", "flywheel-comm", "dist"),
		join(commRoot, "dist"),
		{
			recursive: true,
			dereference: false,
		},
	);
	cpSync(
		join(
			repo,
			"packages",
			"flywheel-comm",
			"src",
			"bin",
			"summary-registry.ts",
		),
		join(commRoot, "src", "bin", "summary-registry.ts"),
	);
	cpSync(
		join(repo, "packages", "flywheel-comm", "package.json"),
		join(commRoot, "package.json"),
	);
	cpSync(join(repo, "scripts"), join(packageRoot, "scripts"), {
		recursive: true,
		dereference: false,
	});
	const delivery = `${output}.staged.${randomUUID()}`;
	cpSync(packageRoot, delivery, { recursive: true, dereference: false });
	// pnpm may optimize deployed workspace files with hard links. Replace every
	// delivery file with a byte-for-byte private inode before chmod, so freezing
	// the execution closure can never mutate a source checkout or shared store.
	const freeze = (path) => {
		const item = lstatSync(path);
		if (item.isSymbolicLink()) {
			let target;
			try {
				target = realpathSync(path);
			} catch {
				// pnpm may retain platform-optional links whose target was not
				// deployed. A dangling link cannot be loaded and is not package data.
				unlinkSync(path);
				return;
			}
			if (!target.startsWith(`${delivery}/`)) {
				let rebasedTarget;
				if (target.startsWith(`${deployed}/`))
					rebasedTarget = join(
						delivery,
						"packages",
						"teamlead",
						relative(deployed, target),
					);
				else if (target === join(repo, "packages", "teamlead"))
					rebasedTarget = join(delivery, "packages", "teamlead");
				else if (target === join(repo, "packages", "flywheel-comm"))
					rebasedTarget = join(delivery, "packages", "flywheel-comm");
				else
					throw new Error(
						`package symlink escapes delivery: ${path} -> ${readlinkSync(path)}`,
					);
				if (!realpathSync(rebasedTarget).startsWith(`${delivery}/`))
					throw new Error(`package symlink rebase failed: ${path}`);
				unlinkSync(path);
				symlinkSync(relative(dirname(path), rebasedTarget), path);
			}
			return;
		}
		if (item.isDirectory()) {
			for (const name of readdirSync(path)) freeze(join(path, name));
			chmodSync(path, 0o555);
			return;
		}
		if (!item.isFile()) throw new Error(`package contains non-file: ${path}`);
		if (item.nlink > 1) {
			const privateFile = `${path}.private.${randomUUID()}`;
			copyFileSync(path, privateFile);
			chmodSync(privateFile, item.mode & 0o111 ? 0o555 : 0o444);
			renameSync(privateFile, path);
		} else chmodSync(path, item.mode & 0o111 ? 0o555 : 0o444);
	};
	for (const name of readdirSync(delivery)) freeze(join(delivery, name));
	const cli = join(
		delivery,
		"packages",
		"teamlead",
		"dist",
		"bin",
		"standing-authority-package-cli.js",
	);
	const built = spawnSync(
		process.execPath,
		[cli, "build", "--root", delivery, "--source-commit", sourceCommit],
		{ encoding: "utf8" },
	);
	if (built.status !== 0)
		throw new Error(
			`package inventory failed: ${built.stderr?.trim() || built.stdout?.trim() || built.status}`,
		);
	chmodSync(join(delivery, "standing-authority-package.json"), 0o444);
	chmodSync(delivery, 0o555);
	renameSync(delivery, output);
	process.stdout.write(built.stdout);
} finally {
	const thaw = (path) => {
		if (!existsSync(path)) return;
		const item = lstatSync(path);
		if (item.isDirectory()) {
			chmodSync(path, 0o700);
			for (const name of readdirSync(path)) thaw(join(path, name));
		} else if (!item.isSymbolicLink()) chmodSync(path, 0o600);
	};
	thaw(temporary);
	rmSync(temporary, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 100,
	});
	for (const [path, mode] of sourceModes) {
		if (!existsSync(path)) continue;
		const item = lstatSync(path);
		if (!item.isSymbolicLink() && (item.mode & 0o777) !== mode)
			chmodSync(path, mode);
	}
}
