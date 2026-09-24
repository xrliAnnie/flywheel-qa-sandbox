import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FfmpegPcmDecoder } from "../audio/FfmpegPcmDecoder.js";
import { NodeProcessRunner } from "../process.js";
import type { StreamingTtsChunk } from "../types.js";
import { FakeProcessRunner } from "./fakes.js";

const MP3 = { encoding: "mp3", sampleRateHz: 24_000, channels: 1 } as const;

/** Real ffmpeg with an MP3 encoder, when the execution host has one. */
const REAL_FFMPEG = ((): string | undefined => {
	for (const candidate of ["ffmpeg", "/opt/homebrew/bin/ffmpeg"]) {
		try {
			const encoders = execFileSync(
				candidate,
				["-hide_banner", "-encoders"],
				{ stdio: ["ignore", "pipe", "ignore"] },
			).toString();
			if (encoders.includes("libmp3lame")) return candidate;
		} catch {
			// not installed at this path
		}
	}
	return undefined;
})();

describe("FfmpegPcmDecoder", () => {
	it("streams PCM16 mono 24 kHz before encoded synthesis completes", async () => {
		const runner = new FakeProcessRunner();
		let releaseSecond!: () => void;
		const secondReady = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		async function* encoded(): AsyncIterable<StreamingTtsChunk> {
			yield {
				audio: Buffer.from("encoded-first"),
				format: MP3,
				ttsFirstByteMs: 17,
			};
			await secondReady;
			yield { audio: Buffer.from("encoded-second"), format: MP3 };
		}

		const iterator = new FfmpegPcmDecoder({
			ffmpegBin: "ffmpeg-custom",
			runner,
		})
			.decode(encoded(), { signal: new AbortController().signal })
			[Symbol.asyncIterator]();
		const first = iterator.next();
		await vi.waitFor(() => expect(runner.handles).toHaveLength(1));
		const handle = runner.handles[0]!;
		await vi.waitFor(() => expect(handle.written).toEqual(["encoded-first"]));
		expect(handle.ended).toBe(false);
		expect(runner.spawnCalls[0]).toEqual({
			cmd: "ffmpeg-custom",
			args: [
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"mp3",
				"-i",
				"pipe:0",
				"-f",
				"s16le",
				"-acodec",
				"pcm_s16le",
				"-ac",
				"1",
				"-ar",
				"24000",
				"pipe:1",
			],
			opts: undefined,
		});

		handle.emitStdout(Buffer.from([1, 0, 2, 0]));
		await expect(first).resolves.toEqual({
			done: false,
			value: {
				audio: Buffer.from([1, 0, 2, 0]),
				format: {
					encoding: "pcm16",
					sampleRateHz: 24_000,
					channels: 1,
				},
				ttsFirstByteMs: 17,
			},
		});

		releaseSecond();
		await vi.waitFor(() =>
			expect(handle.written).toEqual(["encoded-first", "encoded-second"]),
		);
		await vi.waitFor(() => expect(handle.ended).toBe(true));
		const second = iterator.next();
		handle.emitStdout(Buffer.from([3, 0]));
		await expect(second).resolves.toMatchObject({
			done: false,
			value: { audio: Buffer.from([3, 0]) },
		});
		handle.emitExit(0);
		await expect(iterator.next()).resolves.toEqual({
			done: true,
			value: undefined,
		});
	});

	it("stops pulling encoded chunks while decoder stdin is backpressured", async () => {
		let pulled = 0;
		async function* encoded(): AsyncIterable<StreamingTtsChunk> {
			pulled += 1;
			yield { audio: Buffer.from("first"), format: MP3 };
			pulled += 1;
			yield { audio: Buffer.from("second"), format: MP3 };
		}
		const runner = new FakeProcessRunner(undefined, (handle) => {
			handle.writesBeforeBlock = 0;
		});
		const iterator = new FfmpegPcmDecoder({ ffmpegBin: "ffmpeg", runner })
			.decode(encoded(), { signal: new AbortController().signal })
			[Symbol.asyncIterator]();
		const firstOutput = iterator.next();
		await vi.waitFor(() => expect(runner.handles).toHaveLength(1));
		const handle = runner.handles[0]!;
		await vi.waitFor(() => expect(handle.written).toEqual(["first"]));
		expect(pulled).toBe(1);

		handle.emitDrain();
		await vi.waitFor(() => expect(handle.written).toEqual(["first", "second"]));
		await vi.waitFor(() => expect(handle.ended).toBe(true));
		handle.emitStdout(Buffer.from([1, 0]));
		await firstOutput;
		handle.emitExit(0);
		await expect(iterator.next()).resolves.toEqual({
			done: true,
			value: undefined,
		});
	});

	it("aborts the decoder while the encoded source is stalled", async () => {
		let releaseSource!: () => void;
		const stalled = new Promise<void>((resolve) => {
			releaseSource = resolve;
		});
		async function* encoded(): AsyncIterable<StreamingTtsChunk> {
			yield { audio: Buffer.from("first"), format: MP3 };
			await stalled;
		}
		const runner = new FakeProcessRunner();
		const abort = new AbortController();
		const iterator = new FfmpegPcmDecoder({ ffmpegBin: "ffmpeg", runner })
			.decode(encoded(), { signal: abort.signal })
			[Symbol.asyncIterator]();
		const pending = iterator.next();
		const outcome = pending.then(
			() => "resolved",
			(error: { code?: string }) => error.code,
		);
		await vi.waitFor(() => expect(runner.handles).toHaveLength(1));
		const handle = runner.handles[0]!;
		await vi.waitFor(() => expect(handle.written).toEqual(["first"]));

		abort.abort();
		const killedWith = handle.killedWith;
		releaseSource();
		expect({ killedWith, outcome: await outcome }).toEqual({
			killedWith: "SIGKILL",
			outcome: "cancelled",
		});
	});

	it("preserves complete samples and then fails a truncated PCM tail", async () => {
		async function* encoded(): AsyncIterable<StreamingTtsChunk> {
			yield { audio: Buffer.from("encoded"), format: MP3 };
		}
		const runner = new FakeProcessRunner();
		const iterator = new FfmpegPcmDecoder({ ffmpegBin: "ffmpeg", runner })
			.decode(encoded(), { signal: new AbortController().signal })
			[Symbol.asyncIterator]();
		const first = iterator.next();
		await vi.waitFor(() => expect(runner.handles).toHaveLength(1));
		const handle = runner.handles[0]!;
		await vi.waitFor(() => expect(handle.ended).toBe(true));
		handle.emitStdout(Buffer.from([1, 0, 2]));
		const firstResult = await first;
		const final = iterator.next();
		const finalOutcome = final.then(
			() => "resolved",
			(error: { code?: string; message?: string }) => ({
				code: error.code,
				message: error.message,
			}),
		);
		handle.emitExit(0);

		expect({ firstResult, finalOutcome: await finalOutcome }).toEqual({
			firstResult: {
				done: false,
				value: {
					audio: Buffer.from([1, 0]),
					format: {
						encoding: "pcm16",
						sampleRateHz: 24_000,
						channels: 1,
					},
				},
			},
			finalOutcome: {
				code: "subprocess-failed",
				message: "ffmpeg PCM decoder produced a truncated sample",
			},
		});
	});

	it("pauses decoder stdout at the PCM queue high-water mark and resumes after consumption", async () => {
		async function* encoded(): AsyncIterable<StreamingTtsChunk> {
			yield { audio: Buffer.from("encoded"), format: MP3 };
			await new Promise(() => {});
		}
		const runner = new FakeProcessRunner();
		const abort = new AbortController();
		const iterator = new FfmpegPcmDecoder({
			ffmpegBin: "ffmpeg",
			runner,
			maxBufferedBytes: 2,
			timeoutMs: 2,
		})
			.decode(encoded(), { signal: abort.signal })
			[Symbol.asyncIterator]();
		const first = iterator.next();
		await vi.waitFor(() => expect(runner.handles).toHaveLength(1));
		const handle = runner.handles[0]!;
		handle.emitStdout(Buffer.from([1, 0]));
		expect(handle.stdoutPaused).toBe(true);

		await expect(first).resolves.toMatchObject({
			done: false,
			value: { audio: Buffer.from([1, 0]) },
		});
		expect(handle.stdoutPaused).toBe(false);
		handle.emitStdout(Buffer.from([2, 0]));
		expect(handle.stdoutPaused).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(handle.killedWith).toBeUndefined();
		await expect(iterator.next()).resolves.toMatchObject({
			done: false,
			value: { audio: Buffer.from([2, 0]) },
		});
		expect(handle.stdoutPaused).toBe(false);
		expect(handle.stdoutPauseCount).toBe(2);
		expect(handle.stdoutResumeCount).toBe(2);
		abort.abort();
		await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled" });
	});

	it("rejects a non-MP3 synthesis stream before feeding the decoder", async () => {
		async function* encoded(): AsyncIterable<StreamingTtsChunk> {
			yield {
				audio: Buffer.from([1, 0]),
				format: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
			};
		}
		const runner = new FakeProcessRunner();
		const iterator = new FfmpegPcmDecoder({ ffmpegBin: "ffmpeg", runner })
			.decode(encoded(), { signal: new AbortController().signal })
			[Symbol.asyncIterator]();
		const outcome = iterator.next().then(
			() => "resolved",
			(error: { code?: string }) => error.code,
		);
		await vi.waitFor(() => expect(runner.handles).toHaveLength(1));
		const handle = runner.handles[0]!;
		await vi.waitFor(() =>
			expect(
				handle.written.length + (handle.killedWith ? 1 : 0),
			).toBeGreaterThan(0),
		);
		if (!handle.killedWith) handle.emitExit(0);

		await expect(outcome).resolves.toBe("backend-protocol");
		expect(handle.written).toEqual([]);
		expect(handle.killedWith).toBe("SIGKILL");
	});

	it("fails a successful decoder exit that produced no PCM", async () => {
		async function* encoded(): AsyncIterable<StreamingTtsChunk> {
			yield { audio: Buffer.from("encoded"), format: MP3 };
		}
		const runner = new FakeProcessRunner();
		const iterator = new FfmpegPcmDecoder({ ffmpegBin: "ffmpeg", runner })
			.decode(encoded(), { signal: new AbortController().signal })
			[Symbol.asyncIterator]();
		const outcome = iterator.next().then(
			() => "resolved",
			(error: { code?: string }) => error.code,
		);
		await vi.waitFor(() => expect(runner.handles).toHaveLength(1));
		const handle = runner.handles[0]!;
		await vi.waitFor(() => expect(handle.ended).toBe(true));
		handle.emitExit(0);

		await expect(outcome).resolves.toBe("subprocess-failed");
	});

	it("fails when ffmpeg exits before the encoded stream is complete", async () => {
		let sourceClosed = false;
		let releaseSource!: () => void;
		const stalled = new Promise<void>((resolve) => {
			releaseSource = resolve;
		});
		async function* encoded(): AsyncIterable<StreamingTtsChunk> {
			try {
				yield { audio: Buffer.from("encoded"), format: MP3 };
				await stalled;
				yield { audio: Buffer.from("must-not-be-written"), format: MP3 };
			} finally {
				sourceClosed = true;
			}
		}
		const runner = new FakeProcessRunner();
		const iterator = new FfmpegPcmDecoder({ ffmpegBin: "ffmpeg", runner })
			.decode(encoded(), { signal: new AbortController().signal })
			[Symbol.asyncIterator]();
		const first = iterator.next();
		await vi.waitFor(() => expect(runner.handles).toHaveLength(1));
		const handle = runner.handles[0]!;
		await vi.waitFor(() => expect(handle.written).toEqual(["encoded"]));
		handle.emitStdout(Buffer.from([1, 0]));
		await first;
		const finalOutcome = iterator.next().then(
			() => "resolved",
			(error: { code?: string; message?: string }) => ({
				code: error.code,
				message: error.message,
			}),
		);
		handle.emitExit(0);
		const outcome = await finalOutcome;
		releaseSource();
		await new Promise<void>((resolve) => setImmediate(resolve));
		const closedBeforeDrain = sourceClosed;
		if (!sourceClosed) handle.emitDrain();
		await vi.waitFor(() => expect(sourceClosed).toBe(true));

		expect({ outcome, closedBeforeDrain, written: handle.written }).toEqual({
			outcome: {
				code: "subprocess-failed",
				message: "ffmpeg PCM decoder exited before input completed",
			},
			closedBeforeDrain: true,
			written: ["encoded"],
		});
	});

	it("keeps PCM that arrives after a clean exit until stdio closes", async () => {
		async function* encoded(): AsyncIterable<StreamingTtsChunk> {
			yield { audio: Buffer.from("encoded"), format: MP3 };
		}
		const runner = new FakeProcessRunner();
		const iterator = new FfmpegPcmDecoder({ ffmpegBin: "ffmpeg", runner })
			.decode(encoded(), { signal: new AbortController().signal })
			[Symbol.asyncIterator]();
		const first = iterator.next();
		await vi.waitFor(() => expect(runner.handles).toHaveLength(1));
		const handle = runner.handles[0]!;
		handle.closeOnExit = false;
		await vi.waitFor(() => expect(handle.ended).toBe(true));
		handle.emitStdout(Buffer.from([1, 0]));
		await expect(first).resolves.toMatchObject({
			value: { audio: Buffer.from([1, 0]) },
		});

		handle.emitExit(0);
		const second = iterator.next();
		handle.emitStdout(Buffer.from([2, 0, 3, 0]));
		await expect(second).resolves.toMatchObject({
			done: false,
			value: { audio: Buffer.from([2, 0, 3, 0]) },
		});
		const end = iterator.next();
		handle.emitClose(0);
		await expect(end).resolves.toEqual({ done: true, value: undefined });
		expect(handle.killedWith).toBeUndefined();
	});

	it("delivers every byte a real child writes before exiting while a paced consumer drains", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ffmpeg-pcm-decoder-"));
		const fixture = join(dir, "fake-ffmpeg.sh");
		const totalBytes = 300_000;
		writeFileSync(
			fixture,
			`#!/bin/sh\ncat >/dev/null\nhead -c ${totalBytes} /dev/zero\n`,
		);
		chmodSync(fixture, 0o755);
		async function* encoded(): AsyncIterable<StreamingTtsChunk> {
			yield { audio: Buffer.from("encoded"), format: MP3 };
		}
		try {
			let received = 0;
			for await (const chunk of new FfmpegPcmDecoder({
				ffmpegBin: fixture,
				runner: new NodeProcessRunner(),
				timeoutMs: 10_000,
			}).decode(encoded(), { signal: new AbortController().signal })) {
				received += chunk.audio.length;
				await new Promise((resolve) => setTimeout(resolve, 15));
			}
			expect(received).toBe(totalBytes);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!REAL_FFMPEG)(
		"real ffmpeg: a paced consumer receives the same PCM as a fast one",
		async () => {
			const mp3 = execFileSync(
				REAL_FFMPEG as string,
				[
					"-hide_banner",
					"-loglevel",
					"error",
					"-f",
					"lavfi",
					"-i",
					"sine=frequency=440:duration=6",
					"-ac",
					"1",
					"-ar",
					"24000",
					"-f",
					"mp3",
					"pipe:1",
				],
				{ maxBuffer: 16 * 1024 * 1024 },
			);
			async function* encoded(): AsyncIterable<StreamingTtsChunk> {
				yield { audio: mp3, format: MP3 };
			}
			const decodeBytes = async (paceMs: number): Promise<number> => {
				let received = 0;
				for await (const chunk of new FfmpegPcmDecoder({
					ffmpegBin: REAL_FFMPEG as string,
					runner: new NodeProcessRunner(),
					timeoutMs: 10_000,
				}).decode(encoded(), { signal: new AbortController().signal })) {
					received += chunk.audio.length;
					if (paceMs > 0) {
						await new Promise((resolve) => setTimeout(resolve, paceMs));
					}
				}
				return received;
			};
			const fast = await decodeBytes(0);
			expect(fast).toBeGreaterThan(200_000);
			expect(await decodeBytes(40)).toBe(fast);
		},
	);

	it("times out a decoder that never produces or exits", async () => {
		let sourceClosed = false;
		let releaseSource!: () => void;
		const stalled = new Promise<void>((resolve) => {
			releaseSource = resolve;
		});
		async function* encoded(): AsyncIterable<StreamingTtsChunk> {
			try {
				yield { audio: Buffer.from("encoded"), format: MP3 };
				await stalled;
				yield { audio: Buffer.from("must-not-be-written"), format: MP3 };
			} finally {
				sourceClosed = true;
			}
		}
		const runner = new FakeProcessRunner();
		const abort = new AbortController();
		const iterator = new FfmpegPcmDecoder({
			ffmpegBin: "ffmpeg",
			runner,
			timeoutMs: 2,
		})
			.decode(encoded(), { signal: abort.signal })
			[Symbol.asyncIterator]();
		const outcome = iterator.next().then(
			() => "resolved",
			(error: { code?: string }) => error.code,
		);
		const raced = await Promise.race([
			outcome,
			new Promise<string>((resolve) =>
				setTimeout(() => resolve("still-pending"), 20),
			),
		]);
		releaseSource();
		await new Promise<void>((resolve) => setImmediate(resolve));
		abort.abort();
		await outcome;

		expect({
			raced,
			killedWith: runner.handles[0]?.killedWith,
			sourceClosed,
			written: runner.handles[0]?.written,
		}).toEqual({
			raced: "timeout",
			killedWith: "SIGKILL",
			sourceClosed: true,
			written: ["encoded"],
		});
	});
});
