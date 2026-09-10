#!/usr/bin/env node
// Deployment receipt generation is read-only toward every credential/home.
// Only an explicitly supplied approved inventory is eligible; no auto-enrollment.
import { createHash, randomUUID } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

let temporary;
try {
	const args = process.argv.slice(2),
		values = new Map();
	const keys = [
		"--approved-homes",
		"--canonical-home",
		"--state-root",
		"--build-sha",
	];
	if (args.length !== 8) throw new Error("usage");
	for (let i = 0; i < args.length; i += 2) {
		if (!keys.includes(args[i]) || values.has(args[i]) || !args[i + 1])
			throw new Error("usage");
		values.set(args[i], args[i + 1]);
	}
	const approvedPath = values.get("--approved-homes"),
		canonicalHome = values.get("--canonical-home"),
		stateRoot = values.get("--state-root"),
		buildSha = values.get("--build-sha");
	if (
		![approvedPath, canonicalHome, stateRoot].every(
			(path) => isAbsolute(path) && resolve(path) === path,
		) ||
		!/^[a-f0-9]{40}$/.test(buildSha)
	)
		throw new Error("arguments");
	const approvedStat = lstatSync(approvedPath);
	if (
		!approvedStat.isFile() ||
		approvedStat.isSymbolicLink() ||
		approvedStat.size > 1024 * 1024
	)
		throw new Error("approved_inventory");
	const input = JSON.parse(readFileSync(approvedPath, "utf8"));
	if (!Array.isArray(input) || input.length === 0 || input.length > 5000)
		throw new Error("approved_inventory");
	const canonicalPath = join(canonicalHome, "auth.json"),
		canonical = lstatSync(canonicalPath);
	if (
		!canonical.isFile() ||
		canonical.isSymbolicLink() ||
		(canonical.mode & 0o777) !== 0o600
	)
		throw new Error("canonical_unavailable");
	const seen = new Set(),
		checkedAt = new Date().toISOString();
	const homes = input
		.map((entry) => {
			if (
				typeof entry?.home !== "string" ||
				!isAbsolute(entry.home) ||
				resolve(entry.home) !== entry.home ||
				seen.has(entry.home) ||
				!["managed", "independent"].includes(entry.ownership)
			)
				throw new Error("approved_inventory");
			seen.add(entry.home);
			const home = lstatSync(entry.home);
			if (!home.isDirectory() || home.isSymbolicLink())
				throw new Error("home_unavailable");
			let credentialShared = false;
			if (entry.ownership === "managed") {
				const auth = join(entry.home, "auth.json");
				if (
					!lstatSync(auth).isSymbolicLink() ||
					realpathSync(auth) !== realpathSync(canonicalPath)
				)
					throw new Error("credential_not_shared");
				try {
					lstatSync(join(entry.home, ".credential-copy-pending"));
					throw new Error("credential_copy_pending");
				} catch (error) {
					if (error.code !== "ENOENT") throw error;
				}
				credentialShared = true;
			}
			return {
				home: entry.home,
				ownership: entry.ownership,
				credentialShared,
				checkedAt,
			};
		})
		.sort((a, b) => a.home.localeCompare(b.home));
	const inventoryDigest = createHash("sha256")
		.update(
			JSON.stringify(homes.map(({ home, ownership }) => ({ home, ownership }))),
		)
		.digest("hex");
	const directory = join(stateRoot, "codex-quota");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	if (lstatSync(directory).isSymbolicLink()) throw new Error("output_unsafe");
	temporary = join(directory, `.readiness-${randomUUID()}.tmp`);
	writeFileSync(
		temporary,
		`${JSON.stringify({ schemaVersion: 1, buildSha, inventoryDigest, createdAt: checkedAt, homes }, null, 2)}\n`,
		{ mode: 0o600, flag: "wx" },
	);
	renameSync(temporary, join(directory, "readiness-receipt.json"));
	temporary = undefined;
	console.log("CODEX_READINESS_RECEIPT written");
} catch {
	if (temporary) rmSync(temporary, { force: true });
	console.error("CODEX_READINESS_RECEIPT unavailable");
	process.exitCode = 1;
}
