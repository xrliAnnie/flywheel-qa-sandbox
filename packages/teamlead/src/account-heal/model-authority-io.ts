import {
	closeSync,
	constants as fsConstants,
	fsyncSync,
	lstatSync,
	openSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	getModelConfigSnapshot,
	resetModelConfigCacheForTests,
} from "flywheel-config";

/**
 * FLY-2775: model-authority file primitives shared by every model-family sync
 * (Fable since FLY-2766, Opus since FLY-2775). Moved verbatim out of
 * fable-model-sync.ts — behavior is unchanged and pinned by the Fable suite.
 */

export function authorityIsSafe(path: string): boolean {
	try {
		const stat = lstatSync(path);
		return (
			stat.isFile() &&
			!stat.isSymbolicLink() &&
			(stat.mode & 0o777) === 0o600 &&
			(process.getuid === undefined || stat.uid === process.getuid())
		);
	} catch {
		return false;
	}
}

let tempSequence = 0;

export function atomicReplace(
	path: string,
	contents: string,
	beforeRename?: (tempPath: string) => void,
): void {
	const directory = dirname(path);
	tempSequence += 1;
	const tempPath = join(
		directory,
		`.${path.split("/").at(-1) ?? "models.json"}.${process.pid}.${tempSequence}.tmp`,
	);
	let file: number | undefined;
	try {
		file = openSync(
			tempPath,
			fsConstants.O_CREAT |
				fsConstants.O_EXCL |
				fsConstants.O_WRONLY |
				(fsConstants.O_NOFOLLOW ?? 0),
			0o600,
		);
		writeSync(file, contents, undefined, "utf8");
		fsyncSync(file);
		closeSync(file);
		file = undefined;
		beforeRename?.(tempPath);
		renameSync(tempPath, path);
		const directoryFd = openSync(directory, fsConstants.O_RDONLY);
		try {
			fsyncSync(directoryFd);
		} finally {
			closeSync(directoryFd);
		}
	} catch (error) {
		if (file !== undefined) closeSync(file);
		try {
			unlinkSync(tempPath);
		} catch {
			// Temp may already have been atomically renamed.
		}
		throw error;
	}
}

export function readVerifiedSnapshot(path: string) {
	const previous = process.env.FLYWHEEL_MODELS_CONFIG;
	process.env.FLYWHEEL_MODELS_CONFIG = path;
	resetModelConfigCacheForTests();
	try {
		return getModelConfigSnapshot();
	} finally {
		if (previous === undefined) delete process.env.FLYWHEEL_MODELS_CONFIG;
		else process.env.FLYWHEEL_MODELS_CONFIG = previous;
		resetModelConfigCacheForTests();
	}
}
