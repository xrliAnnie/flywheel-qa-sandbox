/**
 * FLY-1389 P1-0: path-hygiene predicates — TypeScript host.
 *
 * Incident 2026-07-20 (529 Room): `~/.flywheel/bin/agent-team-transport`
 * pointed into a worktree's dist; the worktree was cleaned, the symlink
 * broke, and the next Lead start died FATAL at the transport preflight.
 * Root cause class: installers derive their source root from their own
 * location and write that root into GLOBAL config — run once from a
 * temp/worktree checkout and the global config permanently remembers a
 * temporary address.
 *
 * Rule (Annie red line): global bin links point at the main checkout ONLY —
 * refuse AT WRITE TIME. The bash host of the same single-truth predicates is
 * `scripts/lib/path-hygiene.sh` — keep the two aligned (both test suites pin
 * the same fixture matrix).
 *
 * Judgment basis (research §7c, macOS verified):
 * - temp shape: canonical path under /tmp, /private/tmp, /var/folders,
 *   /private/var/folders (macOS `/var` → `/private/var` symlink — judge
 *   AFTER canonicalization).
 * - worktree root: `<dir>/.git` exists and is a FILE (linked-worktree gitdir
 *   pointer); main checkouts have a .git DIRECTORY. Root-only test — naming
 *   heuristics (path contains /worktrees/) are known to miss real shapes.
 * - canonicalize: allow-missing contract — resolve the longest EXISTING
 *   ancestor physically, then append the missing suffix (a clean host
 *   without ~/.flywheel/bin must still be recognized as global). Any other
 *   resolution failure (empty input, dot segments in the missing suffix)
 *   throws, and callers treat it FAIL-CLOSED (guard triggers).
 */

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

/** Canonical temp prefixes (boundary-safe: `/tmpfoo` is not `/tmp`). */
const TEMP_PREFIXES = [
	"/tmp",
	"/private/tmp",
	"/var/folders",
	"/private/var/folders",
] as const;

function isExistingDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Canonicalize a path without requiring it to exist: physical realpath of
 * the longest existing ancestor + the missing suffix appended verbatim.
 * Throws on unresolvable input (empty path, `.`/`..` segments in the
 * missing suffix) — callers must fail closed.
 */
export function canonicalizeAllowMissing(p: string): string {
	if (!p) throw new Error("path-hygiene: empty path");
	// Mirror the bash host: prepend the physical cwd for relative inputs,
	// WITHOUT lexical normalization (join/resolve would silently collapse
	// dot segments that the missing-suffix walk must reject).
	let abs = isAbsolute(p) ? p : `${process.cwd()}/${p}`;
	while (abs.length > 1 && abs.endsWith("/")) abs = abs.slice(0, -1);

	let suffix = "";
	let cur = abs;
	while (!isExistingDir(cur) && cur !== "/") {
		const base = basename(cur);
		if (base === "." || base === "..") {
			throw new Error(
				`path-hygiene: unresolvable dot segment in missing suffix: ${p}`,
			);
		}
		suffix = suffix ? `${base}/${suffix}` : base;
		cur = dirname(cur);
	}
	const resolved = realpathSync(cur);
	if (!suffix) return resolved;
	return resolved === "/" ? `/${suffix}` : `${resolved}/${suffix}`;
}

/** Pure prefix verdict on an ALREADY-canonical path. */
export function isTempPath(canonical: string): boolean {
	return TEMP_PREFIXES.some(
		(pre) => canonical === pre || canonical.startsWith(`${pre}/`),
	);
}

/**
 * `true` = temp/worktree shape → writers must REFUSE.
 * `false` = trusted root (main checkout, packaged tree, fleet custom root).
 * Fail-closed: unresolvable input → `true`.
 */
export function isTempOrWorktreeRoot(dir: string): boolean {
	let canon: string;
	try {
		canon = canonicalizeAllowMissing(dir);
	} catch {
		return true;
	}
	if (isTempPath(canon)) return true;
	try {
		if (statSync(join(canon, ".git")).isFile()) return true;
	} catch {
		// no .git entry — not a worktree root
	}
	return false;
}

/**
 * `true` = resolved identity equals the effective global bin
 * (`$HOME/.flywheel/bin`), regardless of how the value was spelled
 * (FLYWHEEL_BIN_DIR override, symlink alias, redundant slashes).
 * Fail-closed: unresolvable input → `true` (guard triggers).
 */
export function isGlobalBinDir(
	dir: string,
	opts?: { globalBinDir?: string },
): boolean {
	const globalRef = opts?.globalBinDir ?? join(homedir(), ".flywheel", "bin");
	let canon: string;
	let globalCanon: string;
	try {
		canon = canonicalizeAllowMissing(dir);
		globalCanon = canonicalizeAllowMissing(globalRef);
	} catch {
		return true;
	}
	return canon === globalCanon;
}
