/**
 * FLY-286 PR-2: review-report LOCATOR.
 *
 * The merged stores key on `(project, collectionId, runToken)`, but the local
 * review URL is `/xhs-review/:reportToken` — an opaque, unguessable token. This
 * locator maps `reportToken → {project, collectionId, runToken}` so the route
 * can resolve a delivered report back to its analysis run + feedback file
 * WITHOUT scanning every collection (codex design review R1#1).
 *
 * Stored at a fixed top-level dir `<stateDir>/__review-locators/<reportToken>.json`
 * (NOT under a collection dir, so resolution needs no prior collection
 * knowledge). Same fs-safety discipline as the data layer (codex R2#2): safe
 * token segment, atomic `0600` write, symlink-rejecting read, hard size cap,
 * missing → null.
 */

import {
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const XIAOHONGSHU_LOCATOR_SCHEMA_VERSION = 1 as const;
const MAX_LOCATOR_BYTES = 64 * 1024; // generous; a locator is tiny
const LOCATOR_DIRNAME = "__review-locators";

export interface ReviewLocator {
	schemaVersion: typeof XIAOHONGSHU_LOCATOR_SCHEMA_VERSION;
	reportToken: string;
	project: string;
	collectionId: string;
	runToken: string;
	createdAt: string;
}

/** Reject anything that could escape the locator dir (reportToken is hex). */
function safeToken(reportToken: string): string {
	if (
		typeof reportToken !== "string" ||
		!/^[A-Za-z0-9._-]+$/.test(reportToken)
	) {
		throw new Error(
			`xhs-review-locator: unsafe reportToken ${JSON.stringify(reportToken)} (allowed: A-Za-z0-9._-)`,
		);
	}
	return reportToken;
}

function locatorDir(stateDir: string): string {
	return join(stateDir, LOCATOR_DIRNAME);
}

function locatorFile(stateDir: string, reportToken: string): string {
	return join(locatorDir(stateDir), `${safeToken(reportToken)}.json`);
}

/** Write a locator atomically (0600). The dir component is symlink-checked. */
export function writeLocator(stateDir: string, locator: ReviewLocator): void {
	if (locator.schemaVersion !== XIAOHONGSHU_LOCATOR_SCHEMA_VERSION) {
		throw new Error(
			`xhs-review-locator: unsupported locator schemaVersion ${locator.schemaVersion}`,
		);
	}
	safeToken(locator.reportToken);
	const dir = locatorDir(stateDir);
	// Create dir; reject if a symlink was pre-planted at the locator dir.
	mkdirSync(stateDir, { recursive: true });
	try {
		const st = lstatSync(dir);
		if (st.isSymbolicLink()) {
			throw new Error(
				`xhs-review-locator: refusing to write through symlink ${dir}`,
			);
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			mkdirSync(dir, { mode: 0o700 });
		} else {
			throw err;
		}
	}
	const file = locatorFile(stateDir, locator.reportToken);
	const json = JSON.stringify(locator, null, 2);
	if (Buffer.byteLength(json, "utf-8") > MAX_LOCATOR_BYTES) {
		throw new Error("xhs-review-locator: locator exceeds size cap");
	}
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, json, { mode: 0o600, flag: "wx" });
	renameSync(tmp, file);
}

/** Read a locator. Missing → null. Symlinked dir/file or oversized → throw. */
export function readLocator(
	stateDir: string,
	reportToken: string,
): ReviewLocator | null {
	safeToken(reportToken); // validate BEFORE any fs access (even if dir missing)
	const dir = locatorDir(stateDir);
	// Reject a symlinked locator dir before reading through it.
	try {
		if (lstatSync(dir).isSymbolicLink()) {
			throw new Error(
				`xhs-review-locator: refusing to read through symlink ${dir}`,
			);
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	const file = locatorFile(stateDir, reportToken);
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	if (st.isSymbolicLink()) {
		throw new Error(
			`xhs-review-locator: refusing to read through symlink ${file}`,
		);
	}
	if (statSync(file).size > MAX_LOCATOR_BYTES) {
		throw new Error("xhs-review-locator: locator exceeds size cap");
	}
	const loc = JSON.parse(readFileSync(file, "utf-8")) as ReviewLocator;
	if (loc.schemaVersion !== XIAOHONGSHU_LOCATOR_SCHEMA_VERSION) {
		throw new Error(
			`xhs-review-locator: unsupported locator schemaVersion ${loc.schemaVersion} in ${file}`,
		);
	}
	return loc;
}
