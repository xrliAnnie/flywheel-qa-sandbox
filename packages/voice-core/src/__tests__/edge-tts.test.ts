import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EdgeTts } from "../backends/edge-tts/EdgeTtsEngine.js";
import { VoiceError } from "../types.js";
import { FakeProcessRunner, timeoutRun } from "./fakes.js";

const SECRET = "Discord bot token is sk-abc123 do not commit";

describe("EdgeTts", () => {
	it("writes text to a temp file (argv hygiene) and returns mp3 audio", async () => {
		// The runner writes fake media where --write-media points, so read succeeds.
		const runner = new FakeProcessRunner(async (_cmd, args) => {
			const mediaIdx = args.indexOf("--write-media");
			const outPath = args[mediaIdx + 1];
			const { writeFileSync } = await import("node:fs");
			writeFileSync(outPath, Buffer.from("ID3-FAKE-MP3"));
			// also assert the source text file exists at synth time
			const fileIdx = args.indexOf("--file");
			expect(existsSync(args[fileIdx + 1])).toBe(true);
			expect(readFileSync(args[fileIdx + 1], "utf8")).toBe(SECRET);
			return { stdout: Buffer.from(""), stderr: "", code: 0 };
		});
		const tts = new EdgeTts({ command: "edge-tts", runner });
		const r = await tts.synthesize(SECRET, "zh-CN-XiaoxiaoNeural", {
			signal: new AbortController().signal,
		});
		expect(r.audio.toString()).toBe("ID3-FAKE-MP3");
		expect(r.format.encoding).toBe("mp3");
		expect(r.ttsFirstByteMs).toBeGreaterThanOrEqual(0);
		// argv hygiene: the SECRET text must NEVER appear on the process argv.
		const call = runner.runCalls[0];
		expect(call.args.join(" ")).not.toContain(SECRET);
		expect(call.args).toContain("--voice");
		expect(call.args).toContain("zh-CN-XiaoxiaoNeural");
	});

	it("honors baseArgs (python -m edge_tts form)", async () => {
		const runner = new FakeProcessRunner(async (_cmd, args) => {
			const mediaIdx = args.indexOf("--write-media");
			const { writeFileSync } = await import("node:fs");
			writeFileSync(args[mediaIdx + 1], Buffer.from("x"));
			return { stdout: Buffer.from(""), stderr: "", code: 0 };
		});
		const tts = new EdgeTts({
			command: "python",
			baseArgs: ["-m", "edge_tts"],
			runner,
		});
		await tts.synthesize("hi", "v", { signal: new AbortController().signal });
		expect(runner.runCalls[0].cmd).toBe("python");
		expect(runner.runCalls[0].args.slice(0, 2)).toEqual(["-m", "edge_tts"]);
	});

	it("throws on empty text", async () => {
		const tts = new EdgeTts({
			command: "edge-tts",
			runner: new FakeProcessRunner(),
		});
		await expect(
			tts.synthesize("   ", "v", { signal: new AbortController().signal }),
		).rejects.toMatchObject({
			code: "subprocess-failed",
		});
	});

	it("maps timeout to a timeout VoiceError", async () => {
		const tts = new EdgeTts({
			command: "edge-tts",
			timeoutMs: 10,
			runner: new FakeProcessRunner(timeoutRun()),
		});
		const err = await tts
			.synthesize("hi", "v", { signal: new AbortController().signal })
			.catch((e) => e);
		expect(err).toBeInstanceOf(VoiceError);
		expect((err as VoiceError).code).toBe("timeout");
	});

	it("throws when the media file is missing (rate-limit/no-SLA path)", async () => {
		const tts = new EdgeTts({
			command: "edge-tts",
			runner: new FakeProcessRunner(async () => ({
				stdout: Buffer.from(""),
				stderr: "429",
				code: 0,
			})),
		});
		await expect(
			tts.synthesize("hi", "v", { signal: new AbortController().signal }),
		).rejects.toMatchObject({
			code: "subprocess-failed",
		});
	});
});
