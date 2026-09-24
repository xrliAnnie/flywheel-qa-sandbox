import { describe, expect, it } from "vitest";
import { EdgeTts } from "../backends/edge-tts/EdgeTtsEngine.js";
import type { VoiceError } from "../types.js";
import { FakeProcessRunner } from "./fakes.js";

const SECRET = "verbatim Lead result sk-do-not-leak";

describe("EdgeTts streaming synthesis", () => {
	it("yields the first media chunk before process exit and keeps text off argv", async () => {
		const runner = new FakeProcessRunner();
		const tts = new EdgeTts({
			command: "edge-tts",
			runner,
			streamCommand: "python3",
			streamScript: "/opt/voice/stream-edge-tts.py",
		});
		const iterator = tts
			.synthesizeStream(
				SECRET,
				{ voiceId: "zh-CN-XiaoxiaoNeural", rate: "-10%", pitch: "+2Hz" },
				{ signal: new AbortController().signal },
			)
			[Symbol.asyncIterator]();
		const first = iterator.next();
		const handle = runner.handles[0]!;
		expect(runner.spawnCalls[0]).toMatchObject({
			cmd: "python3",
			args: [
				"/opt/voice/stream-edge-tts.py",
				"--voice",
				"zh-CN-XiaoxiaoNeural",
				"--rate=-10%",
				"--pitch=+2Hz",
			],
		});
		expect(runner.spawnCalls[0]?.args.join(" ")).not.toContain(SECRET);
		expect(handle.written).toEqual([SECRET]);

		handle.emitStdout(Buffer.from("ID3-first"));
		await expect(first).resolves.toMatchObject({
			done: false,
			value: {
				audio: Buffer.from("ID3-first"),
				format: { encoding: "mp3", sampleRateHz: 24_000, channels: 1 },
			},
		});
		handle.emitStdout(Buffer.from("-second"));
		await expect(iterator.next()).resolves.toMatchObject({
			done: false,
			value: { audio: Buffer.from("-second") },
		});
		handle.emitExit(0);
		await expect(iterator.next()).resolves.toEqual({
			done: true,
			value: undefined,
		});
	});

	it("kills and fails a slow consumer instead of buffering without bound", async () => {
		const runner = new FakeProcessRunner();
		const tts = new EdgeTts({
			command: "edge-tts",
			runner,
			streamCommand: "python3",
			streamScript: "/stream.py",
			streamMaxBufferedBytes: 3,
		});
		const iterator = tts
			.synthesizeStream("hello", "voice", {
				signal: new AbortController().signal,
			})
			[Symbol.asyncIterator]();
		const first = iterator.next();
		const handle = runner.handles[0]!;
		handle.emitStdout(Buffer.from("four"));
		await expect(first).rejects.toMatchObject({
			code: "resource-exhausted",
		});
		expect(handle.killedWith).toBe("SIGKILL");
	});

	it("surfaces abort and truncated decoder output", async () => {
		const abortRunner = new FakeProcessRunner();
		const abort = new AbortController();
		const abortIterator = new EdgeTts({
			command: "edge-tts",
			runner: abortRunner,
			streamCommand: "python3",
			streamScript: "/stream.py",
		})
			.synthesizeStream("hello", "voice", { signal: abort.signal })
			[Symbol.asyncIterator]();
		const aborted = abortIterator.next();
		abortRunner.handles[0]?.emitStdout("queued-before-cancel");
		abort.abort();
		await expect(aborted).rejects.toMatchObject({ code: "cancelled" });
		expect(abortRunner.handles[0]?.killedWith).toBe("SIGKILL");

		const truncatedRunner = new FakeProcessRunner();
		const truncatedIterator = new EdgeTts({
			command: "edge-tts",
			runner: truncatedRunner,
			streamCommand: "python3",
			streamScript: "/stream.py",
		})
			.synthesizeStream("hello", "voice", {
				signal: new AbortController().signal,
			})
			[Symbol.asyncIterator]();
		const first = truncatedIterator.next();
		truncatedRunner.handles[0]?.emitStdout("partial");
		await first;
		truncatedRunner.handles[0]?.emitStderr("decoder failed");
		truncatedRunner.handles[0]?.emitExit(1);
		const error = await truncatedIterator.next().catch((caught) => caught);
		expect((error as VoiceError).code).toBe("subprocess-failed");
		expect((error as VoiceError).message).toContain("decoder failed");
	});

	it("keeps media that arrives after a clean helper exit until stdio closes", async () => {
		const runner = new FakeProcessRunner();
		const iterator = new EdgeTts({
			command: "edge-tts",
			runner,
			streamCommand: "python3",
			streamScript: "/stream.py",
		})
			.synthesizeStream("hello", "voice", {
				signal: new AbortController().signal,
			})
			[Symbol.asyncIterator]();
		const first = iterator.next();
		const handle = runner.handles[0]!;
		handle.closeOnExit = false;
		handle.emitStdout(Buffer.from("ID3-head"));
		await expect(first).resolves.toMatchObject({
			value: { audio: Buffer.from("ID3-head") },
		});

		handle.emitExit(0);
		const tail = iterator.next();
		handle.emitStdout(Buffer.from("-tail"));
		await expect(tail).resolves.toMatchObject({
			done: false,
			value: { audio: Buffer.from("-tail") },
		});
		const end = iterator.next();
		handle.emitClose(0);
		await expect(end).resolves.toEqual({ done: true, value: undefined });
	});

	it("rejects a successful helper exit that produced no media", async () => {
		const runner = new FakeProcessRunner();
		const iterator = new EdgeTts({
			command: "edge-tts",
			runner,
			streamCommand: "python3",
			streamScript: "/stream.py",
		})
			.synthesizeStream("hello", "voice", {
				signal: new AbortController().signal,
			})
			[Symbol.asyncIterator]();
		const result = iterator.next();
		runner.handles[0]?.emitExit(0);
		await expect(result).rejects.toMatchObject({ code: "subprocess-failed" });
	});
});
