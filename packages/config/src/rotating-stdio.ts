import {
	closeSync,
	constants,
	fchmodSync,
	fsyncSync,
	lstatSync,
	openSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import {
	appendRotatedLogSync,
	DEFAULT_LOG_MAX_BYTES,
	DEFAULT_LOG_RETENTION,
} from "./log-rotate.js";

export type RotatingWriteCallback = (error?: Error | null) => void;
export type RotatingWrite = (
	chunk: string | Uint8Array,
	encodingOrCallback?: BufferEncoding | RotatingWriteCallback,
	callback?: RotatingWriteCallback,
) => boolean;

export interface RotatingWritable {
	write: RotatingWrite;
}

export interface RotatingStdioOptions {
	logPath: string;
	maxBytes?: number;
	keep?: number;
	stdout?: RotatingWritable;
	stderr?: RotatingWritable;
	onWriteError?: (error: Error) => void;
}

export interface RotatingStdioEnvOptions {
	env?: NodeJS.ProcessEnv;
	stdout?: RotatingWritable;
	stderr?: RotatingWritable;
	onWriteError?: (error: Error) => void;
}

const ERROR_MARKER_MAX_BYTES = 4096;

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function callOriginal(
	write: RotatingWrite,
	chunk: string | Uint8Array,
	encodingOrCallback?: BufferEncoding | RotatingWriteCallback,
	callback?: RotatingWriteCallback,
): boolean {
	if (encodingOrCallback === undefined) return write(chunk);
	if (callback === undefined) return write(chunk, encodingOrCallback);
	return write(chunk, encodingOrCallback, callback);
}

function normalizeWrite(
	chunk: string | Uint8Array,
	encodingOrCallback?: BufferEncoding | RotatingWriteCallback,
	callback?: RotatingWriteCallback,
): { bytes: Uint8Array; callback?: RotatingWriteCallback } | undefined {
	const done =
		typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
	if (typeof chunk !== "string" && !ArrayBuffer.isView(chunk)) return undefined;
	if (
		typeof encodingOrCallback === "string" &&
		!Buffer.isEncoding(encodingOrCallback)
	) {
		return undefined;
	}
	const encoding =
		typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
	return {
		bytes:
			typeof chunk === "string"
				? Buffer.from(chunk, encoding)
				: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
		callback: done,
	};
}

export function installRotatingStdio(
	options: RotatingStdioOptions,
): () => void {
	const stdout =
		options.stdout ?? (process.stdout as unknown as RotatingWritable);
	const stderr =
		options.stderr ?? (process.stderr as unknown as RotatingWritable);
	const originalStdoutWrite = stdout.write.bind(stdout);
	const originalStderrWrite = stderr.write.bind(stderr);
	const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
	const keep = options.keep ?? DEFAULT_LOG_RETENTION;
	let closed = false;
	let failed = false;
	let rotationEnabled = true;
	let errorReported = false;

	const reportWriteError = (cause: Error) => {
		if (errorReported) return;
		errorReported = true;
		try {
			originalStderrWrite(`[rotating-stdio] ${cause.message.slice(0, 512)}\n`);
		} catch {
			// The persistent marker remains authoritative if raw stderr fails.
		}
		try {
			options.onWriteError?.(cause);
		} catch {
			// Never replace the original log failure with a callback failure.
		}
	};

	const patchedWrite =
		(originalWrite: RotatingWrite): RotatingWrite =>
		(chunk, encodingOrCallback, callback) => {
			if (closed || failed) {
				return callOriginal(originalWrite, chunk, encodingOrCallback, callback);
			}
			const normalized = normalizeWrite(chunk, encodingOrCallback, callback);
			if (!normalized) {
				return callOriginal(originalWrite, chunk, encodingOrCallback, callback);
			}
			try {
				const result = appendRotatedLogSync(options.logPath, normalized.bytes, {
					maxBytes,
					keep,
					strict: true,
					rotationEnabled,
				});
				if (result.rotationStalled) {
					rotationEnabled = false;
					reportWriteError(new Error("rotation_stalled"));
				}
			} catch (error) {
				failed = true;
				const cause = asError(error);
				reportWriteError(cause);
				return callOriginal(originalWrite, chunk, encodingOrCallback, callback);
			}
			if (typeof normalized.callback === "function") {
				queueMicrotask(() => normalized.callback?.());
			}
			return true;
		};

	stdout.write = patchedWrite(originalStdoutWrite);
	stderr.write = patchedWrite(originalStderrWrite);

	return () => {
		if (closed) return;
		closed = true;
		stdout.write = originalStdoutWrite;
		stderr.write = originalStderrWrite;
	};
}

function positiveInteger(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function installRotatingStdioFromEnv(
	options: RotatingStdioEnvOptions = {},
): (() => void) | undefined {
	const env = options.env ?? process.env;
	const logPath = env.FLYWHEEL_BRIDGE_LOG_PATH;
	if (!logPath) return undefined;
	if (
		!isAbsolute(logPath) ||
		logPath.includes("\n") ||
		logPath.includes("\r")
	) {
		throw new Error("absolute_safe_log_path_required");
	}
	const parsedMaxBytes = positiveInteger(env.FLYWHEEL_BRIDGE_LOG_MAX_BYTES);
	const parsedKeep = positiveInteger(env.FLYWHEEL_BRIDGE_LOG_RETENTION);
	const invalidNames = [
		env.FLYWHEEL_BRIDGE_LOG_MAX_BYTES !== undefined && !parsedMaxBytes
			? "FLYWHEEL_BRIDGE_LOG_MAX_BYTES"
			: undefined,
		env.FLYWHEEL_BRIDGE_LOG_RETENTION !== undefined && !parsedKeep
			? "FLYWHEEL_BRIDGE_LOG_RETENTION"
			: undefined,
	].filter((name): name is string => name !== undefined);
	const stderr =
		options.stderr ?? (process.stderr as unknown as RotatingWritable);
	const restore = installRotatingStdio({
		logPath,
		maxBytes: parsedMaxBytes ?? DEFAULT_LOG_MAX_BYTES,
		keep: parsedKeep ?? DEFAULT_LOG_RETENTION,
		stdout: options.stdout,
		stderr,
		onWriteError: options.onWriteError,
	});
	if (invalidNames.length > 0) {
		stderr.write(
			`[rotating-stdio] invalid numeric log config (${invalidNames.join(
				", ",
			)}); using defaults\n`,
		);
	}
	return restore;
}

function markerPayload(error: Error): Buffer {
	const base = {
		version: 1,
		timestamp: new Date().toISOString(),
		pid: process.pid,
		message: error.message.slice(0, 1024),
		stack: error.stack?.slice(0, 2048),
	};
	let bytes = Buffer.from(`${JSON.stringify(base)}\n`);
	if (bytes.length <= ERROR_MARKER_MAX_BYTES) return bytes;
	bytes = Buffer.from(
		`${JSON.stringify({
			...base,
			message: error.message.slice(0, 512),
			stack: error.stack?.slice(0, 1024),
			truncated: true,
		})}\n`,
	);
	return bytes.subarray(0, ERROR_MARKER_MAX_BYTES);
}

export function writeBoundedRotationErrorMarker(
	path: string,
	error: unknown,
): void {
	if (!isAbsolute(path) || path.includes("\n") || path.includes("\r")) {
		throw new Error("absolute_safe_marker_path_required");
	}
	const parent = lstatSync(dirname(path));
	if (!parent.isDirectory() || parent.isSymbolicLink()) {
		throw new Error("marker_parent_unsafe");
	}
	const temp = `${path}.tmp.${process.pid}.${Date.now()}`;
	let fd: number | undefined;
	try {
		fd = openSync(
			temp,
			constants.O_CREAT |
				constants.O_EXCL |
				constants.O_WRONLY |
				constants.O_NOFOLLOW,
			0o600,
		);
		fchmodSync(fd, 0o600);
		const bytes = markerPayload(asError(error));
		let offset = 0;
		while (offset < bytes.length) {
			const written = writeSync(fd, bytes, offset, bytes.length - offset);
			if (written <= 0) throw new Error("marker_write_incomplete");
			offset += written;
		}
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temp, path);
	} finally {
		if (fd !== undefined) closeSync(fd);
		rmSync(temp, { force: true });
	}
}

export function clearRotationErrorMarker(path: string): void {
	if (!isAbsolute(path) || path.includes("\n") || path.includes("\r")) {
		throw new Error("absolute_safe_marker_path_required");
	}
	rmSync(path, { force: true });
}
