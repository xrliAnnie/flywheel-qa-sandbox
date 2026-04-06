import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Threshold above which content is stored as a file reference. */
export const CONTENT_REF_THRESHOLD = 2048; // 2 KB

/**
 * Create a stable message ID and determine whether content should be stored
 * as a file reference. This is the first phase of the two-phase write:
 *   1. createMessageId() — get ID + decide ref vs inline
 *   2. Write file if ref, then insert DB row
 */
export function createMessageId(): string {
	return randomUUID();
}

/**
 * Resolve the directory where content_ref files live for a given DB path.
 * Convention: <db-dir>/refs/
 */
export function refDir(dbPath: string): string {
	return join(dirname(dbPath), "refs");
}

/**
 * Write content to a ref file and return the file path.
 * Creates the refs/ directory if needed.
 */
export function writeContentRef(
	dbPath: string,
	messageId: string,
	content: string,
): string {
	const dir = refDir(dbPath);
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, `${messageId}.txt`);
	writeFileSync(filePath, content, "utf-8");
	return filePath;
}

/**
 * Validate that a content_ref path is within a refs/ directory.
 * Defense-in-depth: prevent reading/deleting arbitrary files if DB is tampered.
 */
function isValidRefPath(filePath: string): boolean {
	const resolved = resolve(filePath);
	return basename(dirname(resolved)) === "refs" && resolved.endsWith(".txt");
}

/**
 * Read content from a ref file. Returns null if the file doesn't exist
 * or the path is not within a refs/ directory.
 */
export function readContentRef(filePath: string): string | null {
	try {
		if (!isValidRefPath(filePath)) return null;
		if (!existsSync(filePath)) return null;
		return readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

/**
 * Delete a content_ref file. Best-effort — no error if missing.
 * Only deletes files within refs/ directories.
 */
export function deleteContentRef(filePath: string): void {
	try {
		if (!isValidRefPath(filePath)) return;
		if (existsSync(filePath)) unlinkSync(filePath);
	} catch {
		// Best-effort
	}
}
