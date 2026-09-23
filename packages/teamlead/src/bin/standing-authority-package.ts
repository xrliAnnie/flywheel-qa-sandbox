import { createHash } from "node:crypto";
import {
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalStandingJson } from "./standing-authority.js";

export interface StandingAuthorityPackageManifest {
	schemaVersion: 1;
	kind: "standing-authority-execution-package";
	sourceCommit: string;
	files: {
		path: string;
		kind: "file" | "symlink";
		size: number;
		sha256: string;
		mode: number;
	}[];
	packageDigest: string;
}

const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MANIFEST_PATH = "standing-authority-package.json";
const digest = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");

function fail(reason: string): never {
	throw new Error(`standing-authority-package-${reason}`);
}

function safePackagePath(path: string) {
	const hasControlCharacter = [...path].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint < 0x20 || codePoint === 0x7f;
	});
	return (
		typeof path === "string" &&
		path.length > 0 &&
		!hasControlCharacter &&
		!path.startsWith("/") &&
		path
			.split("/")
			.every((segment) => segment !== "" && segment !== "." && segment !== "..")
	);
}

function packageFiles(root: string) {
	const output: StandingAuthorityPackageManifest["files"] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const absolute = join(dir, name);
			const item = lstatSync(absolute);
			const path = relative(root, absolute).split(sep).join("/");
			if (!safePackagePath(path)) fail(`path:${path}`);
			if (item.isSymbolicLink()) {
				const link = readlinkSync(absolute);
				const target = resolve(dirname(absolute), link);
				if (
					!target.startsWith(`${root}${sep}`) ||
					realpathSync(absolute) !== realpathSync(target)
				)
					fail(`symlink-target:${path}`);
				const bytes = Buffer.from(link);
				output.push({
					path,
					kind: "symlink",
					size: bytes.length,
					sha256: digest(bytes),
					mode: item.mode & 0o777,
				});
				continue;
			}
			if (item.isDirectory()) {
				walk(absolute);
				continue;
			}
			if (!item.isFile() || item.nlink !== 1) fail("file-type");
			if (path === MANIFEST_PATH) continue;
			const bytes = readFileSync(absolute);
			output.push({
				path,
				kind: "file",
				size: bytes.length,
				sha256: digest(bytes),
				mode: item.mode & 0o777,
			});
		}
	};
	walk(root);
	return output.sort((a, b) => a.path.localeCompare(b.path));
}

function manifestIdentity(
	manifest: Omit<StandingAuthorityPackageManifest, "packageDigest">,
) {
	return {
		schemaVersion: manifest.schemaVersion,
		kind: manifest.kind,
		sourceCommit: manifest.sourceCommit,
		files: manifest.files,
	};
}

export function buildStandingAuthorityPackageManifest(input: {
	root: string;
	sourceCommit: string;
}): StandingAuthorityPackageManifest {
	if (!isAbsolute(input.root) || realpathSync(input.root) !== input.root)
		fail("root-invalid");
	if (!SHA40.test(input.sourceCommit)) fail("source-commit-invalid");
	const identity = {
		schemaVersion: 1 as const,
		kind: "standing-authority-execution-package" as const,
		sourceCommit: input.sourceCommit,
		files: packageFiles(input.root),
	};
	if (identity.files.length === 0) fail("empty");
	return {
		...identity,
		packageDigest: digest(canonicalStandingJson(identity)),
	};
}

function assertManifest(
	value: StandingAuthorityPackageManifest,
): StandingAuthorityPackageManifest {
	if (
		!value ||
		value.schemaVersion !== 1 ||
		value.kind !== "standing-authority-execution-package" ||
		!SHA40.test(value.sourceCommit) ||
		!SHA256.test(value.packageDigest) ||
		!Array.isArray(value.files) ||
		value.files.length === 0 ||
		Object.keys(value).sort().join(",") !==
			"files,kind,packageDigest,schemaVersion,sourceCommit"
	)
		fail("manifest-invalid");
	let prior = "";
	for (const file of value.files) {
		if (
			Object.keys(file).sort().join(",") !== "kind,mode,path,sha256,size" ||
			!safePackagePath(file.path) ||
			(file.kind !== "file" && file.kind !== "symlink") ||
			(prior !== "" && file.path.localeCompare(prior) <= 0) ||
			!Number.isSafeInteger(file.size) ||
			file.size < 0 ||
			!SHA256.test(file.sha256) ||
			!Number.isSafeInteger(file.mode) ||
			file.mode < 0 ||
			file.mode > 0o777
		)
			fail("manifest-invalid");
		prior = file.path;
	}
	if (
		digest(canonicalStandingJson(manifestIdentity(value))) !==
		value.packageDigest
	)
		fail("digest-mismatch");
	return value;
}

export function verifyStandingAuthorityPackage(
	root: string,
	manifest: StandingAuthorityPackageManifest,
): { packageDigest: string; fileCount: number } {
	if (!isAbsolute(root) || realpathSync(root) !== root) fail("root-invalid");
	assertManifest(manifest);
	const actual = packageFiles(root);
	if (
		actual.map((file) => file.path).join("\n") !==
		manifest.files.map((file) => file.path).join("\n")
	)
		fail("inventory-mismatch");
	for (let index = 0; index < actual.length; index += 1) {
		const observed = actual[index]!;
		const expected = manifest.files[index]!;
		if (
			observed.kind !== expected.kind ||
			observed.size !== expected.size ||
			observed.sha256 !== expected.sha256 ||
			observed.mode !== expected.mode
		)
			fail("file-mismatch");
	}
	return { packageDigest: manifest.packageDigest, fileCount: actual.length };
}

export function resolveStandingAuthorityPackageEntry(
	root: string,
	manifest: StandingAuthorityPackageManifest,
	entryPath: string,
): string {
	if (!safePackagePath(entryPath)) fail("entry-invalid");
	assertManifest(manifest);
	if (!manifest.files.some((file) => file.path === entryPath))
		fail("entry-undeclared");
	const absolute = resolve(root, entryPath);
	if (
		!absolute.startsWith(`${root}${sep}`) ||
		realpathSync(absolute) !== absolute
	)
		fail("entry-invalid");
	verifyStandingAuthorityPackage(root, manifest);
	return absolute;
}
