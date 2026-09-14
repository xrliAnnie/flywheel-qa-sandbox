import { randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	type Stats,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { blobStoreIdFromToken } from "./report-hosting-credentials.js";
import type { SecretRedactor } from "./vercel-hosting-api.js";

/** The handoff file is never sourced or printed by the migration process. */
export function writeReportHostingSecrets(options: {
	reportsDir: string;
	projectName: string;
	storeId: string;
	token: string;
	redactor: SecretRedactor;
	uid?: number;
	lstat?: (path: string) => Stats;
	rename?: (source: string, target: string) => void;
}): string {
	const { projectName, storeId, token, redactor } = options;
	const lstat = options.lstat ?? lstatSync;
	redactor.add(token, "blob");
	if (
		!/^fw-reports-[0-9a-f]{6}$/.test(projectName) ||
		blobStoreIdFromToken(token) !== storeId
	)
		throw new Error("invalid credential handoff binding");
	const reportsDir = resolve(options.reportsDir);
	const path = join(reportsDir, `retarget.${projectName}.secrets.env`);
	const uid = options.uid ?? process.getuid?.();
	const invalid = () =>
		new Error(
			`credential handoff path is unsafe or contains a noncompliant/other-store file; inspect and remove it before retrying: ${path}`,
		);
	if (uid === undefined) throw invalid();
	const parent = lstat(reportsDir);
	if (
		!parent.isDirectory() ||
		parent.isSymbolicLink() ||
		parent.uid !== uid ||
		(parent.mode & 0o022) !== 0
	)
		throw invalid();
	let existing: Stats | undefined;
	try {
		existing = lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw invalid();
	}
	if (existing) {
		if (
			!existing.isFile() ||
			existing.isSymbolicLink() ||
			existing.uid !== uid ||
			(existing.mode & 0o7777) !== 0o600
		)
			throw invalid();
		const content = readFileSync(path, "utf8");
		const match =
			/^BLOB_READ_WRITE_TOKEN=(vercel_blob_rw_[A-Za-z0-9_]+)\n$/.exec(content);
		if (match) redactor.add(match[1], "existing-blob");
		if (!match || blobStoreIdFromToken(match[1]!) !== storeId) throw invalid();
		return path;
	}
	const temporary = join(
		reportsDir,
		`.retarget.${projectName}.${randomUUID()}.tmp`,
	);
	let fd: number | undefined;
	try {
		fd = openSync(temporary, "wx", 0o600);
		writeFileSync(fd, `BLOB_READ_WRITE_TOKEN=${token}\n`, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		(options.rename ?? renameSync)(temporary, path);
		const final = lstat(path);
		if (
			!final.isFile() ||
			final.isSymbolicLink() ||
			final.uid !== uid ||
			(final.mode & 0o7777) !== 0o600
		)
			throw invalid();
		return path;
	} catch {
		throw invalid();
	} finally {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(temporary);
		} catch {
			/* A completed rename or interrupted write leaves nothing to remove. */
		}
	}
}
