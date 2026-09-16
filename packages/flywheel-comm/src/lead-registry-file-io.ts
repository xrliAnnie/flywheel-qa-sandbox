import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export class LeadRegistryCommandError extends Error {
	constructor(
		readonly code: string,
		readonly exitCode: 64 | 70 | 75 | 78,
		message: string,
	) {
		super(`${code}: ${message}`);
		this.name = "LeadRegistryCommandError";
	}
}

export function writeDurableFile(
	path: string,
	contents: string,
	mode: number,
): void {
	const fd = openSync(path, "wx", mode);
	try {
		writeSync(fd, contents);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function fsyncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function writeAtomic(
	path: string,
	contents: string,
	mode = 0o600,
): void {
	const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	try {
		writeDurableFile(temp, contents, mode);
		renameSync(temp, path);
		fsyncDirectory(dirname(path));
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {}
		throw error;
	}
}

export function readRegularFileNoFollow(
	path: string,
	label: string,
	ownerOnly = false,
): string {
	let parent: ReturnType<typeof lstatSync>;
	try {
		parent = lstatSync(dirname(path));
	} catch (error) {
		throw new LeadRegistryCommandError(
			"lead_registry_source_invalid",
			78,
			`${label} parent cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!parent.isDirectory() || parent.isSymbolicLink()) {
		throw new LeadRegistryCommandError(
			"lead_registry_source_invalid",
			78,
			`${label} parent must be a real directory`,
		);
	}
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		throw new LeadRegistryCommandError(
			"lead_registry_source_invalid",
			78,
			`${label} cannot be opened without following links: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) {
			throw new LeadRegistryCommandError(
				"lead_registry_source_invalid",
				78,
				`${label} must be a regular file`,
			);
		}
		if (ownerOnly && (stat.mode & 0o077) !== 0) {
			throw new LeadRegistryCommandError(
				"lead_registry_source_invalid",
				78,
				`${label} must be owner-only (0600 or stricter)`,
			);
		}
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}
