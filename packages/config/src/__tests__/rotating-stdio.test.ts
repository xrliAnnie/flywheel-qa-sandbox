import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearRotationErrorMarker,
	installRotatingStdio,
	installRotatingStdioFromEnv,
	type RotatingWritable,
	writeBoundedRotationErrorMarker,
} from "../rotating-stdio.js";

const roots: string[] = [];
function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "fly2049-rotating-stdio-"));
	roots.push(root);
	return root;
}

function fakeWritable(): {
	stream: RotatingWritable;
	originalWrite: ReturnType<typeof vi.fn>;
	text: () => string;
} {
	const chunks: Buffer[] = [];
	const originalWrite = vi.fn(
		(
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | (() => void),
			callback?: () => void,
		) => {
			const encoding =
				typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
			chunks.push(
				typeof chunk === "string"
					? Buffer.from(chunk, encoding)
					: Buffer.from(chunk),
			);
			const done =
				typeof encodingOrCallback === "function"
					? encodingOrCallback
					: callback;
			done?.();
			return true;
		},
	);
	return {
		stream: { write: originalWrite },
		originalWrite,
		text: () => Buffer.concat(chunks).toString("utf8"),
	};
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("rotating stdio", () => {
	it("rotates a live stream without restarting it and preserves exact bytes", () => {
		const log = join(tempRoot(), "bridge.log");
		const stdout = fakeWritable();
		const stderr = fakeWritable();
		const restore = installRotatingStdio({
			logPath: log,
			maxBytes: 16,
			keep: 3,
			stdout: stdout.stream,
			stderr: stderr.stream,
		});
		const writes = [
			"segment-01\n",
			"segment-02\n",
			"segment-03\n",
			"post-rotation-sentinel\n",
		];

		for (const write of writes) stdout.stream.write(write);

		expect(existsSync(`${log}.1`)).toBe(true);
		expect(readFileSync(log, "utf8")).toContain("post-rotation-sentinel");
		const reassembled = [3, 2, 1]
			.filter((generation) => existsSync(`${log}.${generation}`))
			.map((generation) => readFileSync(`${log}.${generation}`))
			.concat(readFileSync(log));
		expect(Buffer.concat(reassembled)).toEqual(Buffer.from(writes.join("")));
		expect(stdout.originalWrite).not.toHaveBeenCalled();
		expect(stderr.originalWrite).not.toHaveBeenCalled();

		const installedWrite = stdout.stream.write;
		restore();
		restore();
		stdout.stream.write("restored-stream\n");
		installedWrite("saved-closure-after-restore\n");
		expect(stdout.text()).toBe(
			"restored-stream\nsaved-closure-after-restore\n",
		);
	});

	it("supports encoded strings, Uint8Array, optional callbacks, and bare writes", async () => {
		const log = join(tempRoot(), "bridge.log");
		const stdout = fakeWritable();
		const stderr = fakeWritable();
		const callback = vi.fn();
		const restore = installRotatingStdio({
			logPath: log,
			maxBytes: 1024,
			keep: 3,
			stdout: stdout.stream,
			stderr: stderr.stream,
		});

		expect(stdout.stream.write("é", "latin1", callback)).toBe(true);
		expect(stdout.stream.write(Uint8Array.from([0x0a]))).toBe(true);
		expect(() => stdout.stream.write("bare-write-no-callback\n")).not.toThrow();
		expect(callback).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(callback).toHaveBeenCalledTimes(1);
		expect(readFileSync(log)).toEqual(
			Buffer.concat([
				Buffer.from("é", "latin1"),
				Buffer.from("\n"),
				Buffer.from("bare-write-no-callback\n"),
			]),
		);
		restore();
	});

	it("falls back to defaults for malformed numeric env and records one warning", () => {
		const log = join(tempRoot(), "bridge.log");
		const stdout = fakeWritable();
		const stderr = fakeWritable();
		const restore = installRotatingStdioFromEnv({
			env: {
				FLYWHEEL_BRIDGE_LOG_PATH: log,
				FLYWHEEL_BRIDGE_LOG_MAX_BYTES: "0",
				FLYWHEEL_BRIDGE_LOG_RETENTION: "1.5",
			},
			stdout: stdout.stream,
			stderr: stderr.stream,
		});

		expect(restore).toBeTypeOf("function");
		expect(readFileSync(log, "utf8")).toContain("invalid numeric log config");
		expect(stderr.originalWrite).not.toHaveBeenCalled();
		restore?.();
	});

	it("latches the first write failure and never repeats the error callback", () => {
		const root = tempRoot();
		const parentFile = join(root, "not-a-directory");
		const log = join(parentFile, "bridge.log");
		writeFileSync(parentFile, "x");
		const stdout = fakeWritable();
		const stderr = fakeWritable();
		const onWriteError = vi.fn();
		installRotatingStdio({
			logPath: log,
			maxBytes: 16,
			keep: 3,
			stdout: stdout.stream,
			stderr: stderr.stream,
			onWriteError,
		});

		stdout.stream.write("first-failed-write\n");
		stdout.stream.write("after-failure\n");
		stderr.stream.write("stderr-after-failure\n");

		expect(onWriteError).toHaveBeenCalledTimes(1);
		expect(stderr.text()).toContain("[rotating-stdio]");
		expect(stdout.text()).toContain("after-failure");
	});

	it("disables only rotation after a stall and keeps short-FD appends alive", () => {
		const root = tempRoot();
		const log = join(root, "bridge.log");
		writeFileSync(log, "123456");
		mkdirSync(`${log}.rotate.lock`);
		const stdout = fakeWritable();
		const stderr = fakeWritable();
		const onWriteError = vi.fn();
		installRotatingStdio({
			logPath: log,
			maxBytes: 3,
			keep: 3,
			stdout: stdout.stream,
			stderr: stderr.stream,
			onWriteError,
		});

		expect(() => stdout.stream.write("7")).not.toThrow();
		expect(() => stdout.stream.write("8")).not.toThrow();

		expect(readFileSync(log, "utf8")).toBe("12345678");
		expect(existsSync(`${log}.1`)).toBe(false);
		expect(onWriteError).toHaveBeenCalledTimes(1);
		expect(onWriteError.mock.calls[0]?.[0]).toMatchObject({
			message: "rotation_stalled",
		});
		expect(stdout.originalWrite).not.toHaveBeenCalled();
		expect(stderr.text()).toContain("rotation_stalled");
	});

	it("writes a bounded overwrite-only 0600 marker and clears stale state", () => {
		const root = tempRoot();
		const state = join(root, "state");
		const marker = join(state, "bridge-log-rotation-error.json");
		mkdirSync(state);

		writeBoundedRotationErrorMarker(marker, new Error("x".repeat(20_000)));
		const first = statSync(marker);
		expect(first.size).toBeLessThanOrEqual(4096);
		expect(first.mode & 0o777).toBe(0o600);
		expect(lstatSync(marker).isSymbolicLink()).toBe(false);

		writeBoundedRotationErrorMarker(marker, new Error("second-cause"));
		const secondText = readFileSync(marker, "utf8");
		expect(statSync(marker).size).toBeLessThan(first.size);
		expect(secondText).toContain("second-cause");
		expect(secondText).not.toContain("xxxxxxxxxxxxxxxx");

		clearRotationErrorMarker(marker);
		expect(existsSync(marker)).toBe(false);
	});

	it("rejects a symlink marker parent without touching its target", () => {
		const root = tempRoot();
		const target = join(root, "target-state");
		const linkedParent = join(root, "linked-state");
		mkdirSync(target);
		symlinkSync(target, linkedParent);

		expect(() =>
			writeBoundedRotationErrorMarker(
				join(linkedParent, "bridge-log-rotation-error.json"),
				new Error("must-not-land"),
			),
		).toThrow(/marker_parent_unsafe/);
		expect(existsSync(join(target, "bridge-log-rotation-error.json"))).toBe(
			false,
		);
	});
});
