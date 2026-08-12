import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface LeadIdentityFailureMarker {
	schemaVersion: 1;
	selectorDigest: string;
	projectsPath: string;
	projectName: string;
	leadId: string;
	code: string;
	message: string;
	failedAt: string;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function leadIdentitySelectorDigest(input: {
	projectsPath: string;
	projectName: string;
	leadId: string;
}): string {
	return sha256(
		JSON.stringify({
			projectsPath: resolve(input.projectsPath),
			projectName: input.projectName,
			leadId: input.leadId,
		}),
	);
}

/**
 * Persist a local, secret-free startup diagnostic. This is deliberately not a
 * remote notification path: it remains available even when identity cannot be
 * established safely enough to attribute a Bridge/Discord write.
 */
export function writeLeadIdentityFailureMarker(input: {
	projectsPath: string;
	projectName: string;
	leadId: string;
	code: string;
	message: string;
	failureDir?: string;
	now?: () => string;
}): LeadIdentityFailureMarker {
	const selectorDigest = leadIdentitySelectorDigest(input);
	const failureDir =
		input.failureDir ??
		join(homedir(), ".flywheel", "state", "lead-identity-failures");
	mkdirSync(failureDir, { recursive: true, mode: 0o700 });
	const target = join(failureDir, `${selectorDigest}.json`);
	try {
		if (lstatSync(target).isSymbolicLink()) {
			throw new Error("refusing to replace symlink identity failure marker");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const marker: LeadIdentityFailureMarker = {
		schemaVersion: 1,
		selectorDigest,
		projectsPath: resolve(input.projectsPath),
		projectName: input.projectName,
		leadId: input.leadId,
		code: input.code,
		message: input.message.slice(0, 1024),
		failedAt: input.now?.() ?? new Date().toISOString(),
	};
	const temp = join(failureDir, `.${selectorDigest}-${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = openSync(temp, "wx", 0o600);
		writeFileSync(fd, `${JSON.stringify(marker)}\n`, "utf8");
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temp, target);
		const dirFd = openSync(failureDir, "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} catch (error) {
		if (fd !== undefined) closeSync(fd);
		try {
			unlinkSync(temp);
		} catch {
			// Preserve the original persistence error.
		}
		throw error;
	}
	return marker;
}
