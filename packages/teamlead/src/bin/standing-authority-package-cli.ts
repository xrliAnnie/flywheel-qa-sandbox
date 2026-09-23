#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
	buildStandingAuthorityPackageManifest,
	resolveStandingAuthorityPackageEntry,
	type StandingAuthorityPackageManifest,
	verifyStandingAuthorityPackage,
} from "./standing-authority-package.js";

export function runStandingAuthorityPackageCli(argv: string[]): number {
	try {
		const parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			strict: true,
			options: {
				root: { type: "string" },
				manifest: { type: "string" },
				"source-commit": { type: "string" },
				path: { type: "string" },
			},
		});
		const command = parsed.positionals[0];
		const root = parsed.values.root;
		if (!root) throw new Error("--root is required");
		if (command === "build") {
			if (!parsed.values["source-commit"])
				throw new Error("--source-commit is required");
			const manifest = buildStandingAuthorityPackageManifest({
				root,
				sourceCommit: parsed.values["source-commit"],
			});
			writeFileSync(
				parsed.values.manifest ??
					resolve(root, "standing-authority-package.json"),
				`${JSON.stringify(manifest)}\n`,
				{ encoding: "utf8", mode: 0o444, flag: "wx" },
			);
			process.stdout.write(
				`${JSON.stringify({ packageDigest: manifest.packageDigest, fileCount: manifest.files.length })}\n`,
			);
			return 0;
		}
		const manifestPath =
			parsed.values.manifest ??
			resolve(root, "standing-authority-package.json");
		const manifest = JSON.parse(
			readFileSync(manifestPath, "utf8"),
		) as StandingAuthorityPackageManifest;
		if (command === "verify") {
			process.stdout.write(
				`${JSON.stringify(verifyStandingAuthorityPackage(root, manifest))}\n`,
			);
			return 0;
		}
		if (command === "resolve") {
			if (!parsed.values.path) throw new Error("--path is required");
			process.stdout.write(
				`${resolveStandingAuthorityPackageEntry(root, manifest, parsed.values.path)}\n`,
			);
			return 0;
		}
		throw new Error("command must be build, verify, or resolve");
	} catch (error) {
		process.stderr.write(`${(error as Error).message}\n`);
		return 2;
	}
}

if (
	process.argv[1] &&
	pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
	process.exitCode = runStandingAuthorityPackageCli(process.argv.slice(2));
