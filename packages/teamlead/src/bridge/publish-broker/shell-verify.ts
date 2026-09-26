/**
 * FLY-1062 broker PR · broker-side verification of a STAGED shell tarball
 * (plan §3 ③): the prepare stage runs in an untrusted runner domain, so the
 * AUTHORITATIVE content gate runs HERE, in the broker's trust domain, on the
 * exact staged bytes. Any failure refuses the publish.
 *
 * Gate layers (Codex code R1: exact set, not prefix rules):
 *  1. rehash — staged bytes must equal the approved sha256 literally;
 *  2. pre-extraction entry audit — every tar entry name must be exactly one
 *     of the PINNED published files (or a directory prefix of one): closes
 *     both in-prefix smuggling (lib/whatever.mjs) and path traversal, before
 *     anything touches the filesystem;
 *  3. regular-files-only — a symlink/hardlink/special entry refuses;
 *  4. exact SET equality — the pinned list is both an upper and a lower
 *     bound (a required file silently dropping out also refuses);
 *  5. content scan — fast in-process credential patterns + private-repo
 *     references, THEN the fleet's calibrated whole-tree scanner
 *     (scan_code_tree_for_secrets: vendor tokens incl. Discord/JWT +
 *     high-entropy layer + config-class net), shared not re-ported,
 *     fail-closed when absent;
 *  6. manifest checks — name/version/private/publishConfig + the .invalid
 *     placeholder endpoint refusal.
 *
 * The pinned file list mirrors the PR2 publish-gate snapshot
 * (packages/onboard-shell/__tests__/onboard-shell-publish-gate.test.sh G2) —
 * a drift test packs the REAL shell and runs this verifier, so a new/renamed
 * shell file must be added in BOTH places deliberately.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** EXACT published file set — byte-for-byte the PR2 publish-gate snapshot. */
export const SHELL_PUBLISH_FILE_SET: readonly string[] = [
	"package.json",
	"README.md",
	"bin/flywheel-onboard.js",
	"lib/config.mjs",
	"lib/messages.mjs",
	"lib/key.mjs",
	"lib/endpoint.mjs",
	"lib/install.mjs",
	"lib/journal.mjs",
	"lib/onboard.mjs",
	"lib/update.mjs",
	"lib/license.mjs",
];

/** credential/secret patterns that must never appear in ANY published file —
 * the fwk_ license-key pattern plus the common vendor token shapes the fleet
 * secret scan knows (a leak here ships to the public registry). */
// The private-repo slug is BUILT from fragments: this module rides inside the
// vendored teamlead dist of the payload, whose own zero-repo-access gate
// (package-onboard gate④) greps every payload byte for the literal — a
// detection pattern must never trip the detector it feeds (same technique as
// the simba-grep-zero fixture fix, PR #557).
const PRIVATE_REPO_OWNER = ["xrli", "Annie"].join("");
const FORBIDDEN_CONTENT: [RegExp, string][] = [
	[/fwk_[0-9a-f]{32,}/, "license-key material"],
	[/npm_[A-Za-z0-9]{36}/, "npm token"],
	[/gh[pousr]_[A-Za-z0-9]{36,}/, "GitHub token"],
	[/github_pat_[A-Za-z0-9_]{20,}/, "GitHub fine-grained token"],
	[/AKIA[0-9A-Z]{16}/, "AWS access key id"],
	[/xox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
	[/AIza[0-9A-Za-z_-]{35}/, "Google API key"],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
	[/\bsk-[A-Za-z0-9_-]{20,}\b/, "sk- API key"],
	[
		new RegExp(`github\\.com[/:]${PRIVATE_REPO_OWNER}`, "i"),
		"private repo URL",
	],
	[new RegExp(`${PRIVATE_REPO_OWNER}/flywheel`, "i"), "private repo slug"],
];

export function sha256FileSync(file: string): string {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// ── calibrated secret scan (Codex code R2 HIGH) ─────────────────────────────
// The finite pattern list above is fast in-process defence-in-depth, but the
// AUTHORITATIVE net is the fleet's calibrated scanner
// (scripts/lib/fleet-sanitize.sh::scan_code_tree_for_secrets — Discord/JWT/
// vendor tokens + the whole-tree high-entropy layer + the config-class
// assignment net). We SHARE it rather than re-port it so the two can never
// drift. Fail-closed: a missing scanner or a scanner error refuses the
// publish — an unscanned tarball is never treated as clean.

const HERE = path.dirname(fileURLToPath(import.meta.url));
// packages/teamlead/{src|dist}/bridge/publish-broker → 5 levels up = repo root
const REPO_ROOT = path.resolve(HERE, "../../../../..");

function fleetSanitizePath(): string {
	return (
		process.env.FLYWHEEL_FLEET_SANITIZE ||
		path.join(REPO_ROOT, "scripts", "lib", "fleet-sanitize.sh")
	);
}

function runCalibratedSecretScan(treeDir: string): void {
	const scanner = fleetSanitizePath();
	if (!fs.existsSync(scanner)) {
		throw new Error(
			"calibrated secret scanner missing (scripts/lib/fleet-sanitize.sh) — fail-closed, publish refused",
		);
	}
	const res = spawnSync(
		"bash",
		[
			"-c",
			'source "$1" && scan_code_tree_for_secrets "$2"',
			"bash",
			scanner,
			treeDir,
		],
		{ encoding: "utf8" },
	);
	if (res.status === 0) return;
	// The scanner redacts its own output; the thrown error carries ONLY the
	// hit categories + relative file names — never a matched value.
	const summary = new Set<string>();
	for (const line of (res.stderr || "").split("\n")) {
		const cat = /\[(vendor-token|high-entropy)\]/.exec(line);
		if (cat?.[1]) summary.add(cat[1]);
		if (line.startsWith(`${treeDir}/`)) {
			const rel = line
				.slice(treeDir.length + 1)
				.split(":")[0]
				?.replace(/^package\//, "");
			if (rel) summary.add(rel);
		}
	}
	throw new Error(
		`forbidden content (calibrated secret scan: ${
			[...summary].join(", ") || "scan refused"
		})`,
	);
}

export interface ShellTarballIdentity {
	name: string;
	version: string;
	/** the FULL parsed package.json — the registry publish document must carry
	 * it (bin/engines/etc.), or `npx @flywheel/onboard` cannot resolve the
	 * executable (Codex code R1 HIGH). */
	manifest: Record<string, unknown>;
}

const ALLOWED_SET = new Set(SHELL_PUBLISH_FILE_SET.map((f) => `package/${f}`));
const ALLOWED_DIRS = new Set(["package", "package/bin", "package/lib"]);

export function verifyShellTarball(
	tarballPath: string,
	expectedSha256: string,
): ShellTarballIdentity {
	if (!fs.existsSync(tarballPath)) {
		throw new Error("staged tarball missing");
	}
	// 1. the approval binds these exact bytes
	const got = sha256FileSync(tarballPath);
	if (got !== expectedSha256) {
		throw new Error(
			"staged tarball sha256 does not match the approved artifact",
		);
	}

	// 2. audit every entry name BEFORE extraction — exact pinned names only
	const listing = execFileSync("tar", ["-tzf", tarballPath], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	})
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const seen = new Set<string>();
	for (const raw of listing) {
		const entry = raw.replace(/\/+$/, "");
		if (raw.endsWith("/")) {
			if (!ALLOWED_DIRS.has(entry)) {
				throw new Error(`unexpected directory in shell tarball: ${raw}`);
			}
			continue;
		}
		if (!ALLOWED_SET.has(entry)) {
			throw new Error(`non-whitelisted file in shell tarball: ${entry}`);
		}
		seen.add(entry);
	}
	// 4a. lower bound: every pinned file must be present
	for (const required of ALLOWED_SET) {
		if (!seen.has(required)) {
			throw new Error(`required published file missing: ${required}`);
		}
	}

	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-shell-verify-"));
	try {
		execFileSync("tar", ["-xzf", tarballPath, "-C", workDir], {
			stdio: "pipe",
		});
		const root = path.join(workDir, "package");

		for (const rel of SHELL_PUBLISH_FILE_SET) {
			const p = path.join(root, rel);
			// 3. regular files only — a symlink (even to an in-tree file) refuses
			const st = fs.lstatSync(p, { throwIfNoEntry: false });
			if (!st) throw new Error(`required published file missing: ${rel}`);
			if (!st.isFile()) {
				throw new Error(`non-regular file in shell tarball: ${rel}`);
			}
			// 3b. NUL-free text only (Codex R3): the calibrated scanner's greps
			// skip binary-looking files (-I), so a NUL byte smuggled into a
			// required .mjs would exempt that file from the whole-tree net.
			// Published JS/JSON/MD is never legitimately binary — refuse.
			const bytes = fs.readFileSync(p);
			if (bytes.includes(0)) {
				throw new Error(`binary content in published file: ${rel}`);
			}
			// 5. content scan
			const content = bytes.toString("utf8");
			for (const [re, what] of FORBIDDEN_CONTENT) {
				if (re.test(content)) {
					throw new Error(`forbidden content (${what}) in ${rel}`);
				}
			}
		}

		// 5b. the calibrated whole-tree net (authoritative; fail-closed)
		runCalibratedSecretScan(root);

		// 6. manifest checks
		const pkg = JSON.parse(
			fs.readFileSync(path.join(root, "package.json"), "utf8"),
		) as Record<string, unknown> & {
			name?: string;
			version?: string;
			private?: boolean;
			publishConfig?: { access?: string };
		};
		if (pkg.name !== "@flywheel/onboard") {
			throw new Error(`unexpected package name ${pkg.name ?? "(none)"}`);
		}
		if (
			typeof pkg.version !== "string" ||
			!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(pkg.version)
		) {
			throw new Error("invalid package version");
		}
		if (pkg.private) {
			throw new Error("package is private:true — not a publishable form");
		}
		if (pkg.publishConfig?.access !== "public") {
			throw new Error("publishConfig.access must be public");
		}

		// the baked endpoint must be REAL — a shell pointing at the .invalid
		// placeholder must never reach a customer (shell-publish-preflight #1)
		const config = fs.readFileSync(
			path.join(root, "lib", "config.mjs"),
			"utf8",
		);
		if (config.includes("flywheel.invalid")) {
			throw new Error(
				"DEFAULT_ENDPOINT is still the placeholder — fill the real hosting URL before any publish",
			);
		}

		return { name: pkg.name, version: pkg.version, manifest: pkg };
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true });
	}
}
