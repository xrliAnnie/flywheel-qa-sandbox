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

	it("accepts a VoiceSpec with per-call rate/pitch prosody (FLY-546 A1)", async () => {
		const runner = new FakeProcessRunner(async (_cmd, args) => {
			const mediaIdx = args.indexOf("--write-media");
			const { writeFileSync } = await import("node:fs");
			writeFileSync(args[mediaIdx + 1], Buffer.from("x"));
			return { stdout: Buffer.from(""), stderr: "", code: 0 };
		});
		const tts = new EdgeTts({ command: "edge-tts", runner });
		await tts.synthesize(
			"hi",
			{ voiceId: "zh-CN-YunxiNeural", rate: "-10%", pitch: "+2Hz" },
			{ signal: new AbortController().signal },
		);
		const args = runner.runCalls[0].args;
		expect(args[args.indexOf("--voice") + 1]).toBe("zh-CN-YunxiNeural");
		// edge-tts requires `=`-joined prosody flags so a leading `-` value is not
		// parsed as a flag (FLY-960 recipe).
		expect(args).toContain("--rate=-10%");
		expect(args).toContain("--pitch=+2Hz");
	});

	it("VoiceSpec without prosody produces the same argv shape as the string form", async () => {
		const mk = () =>
			new FakeProcessRunner(async (_cmd, args) => {
				const mediaIdx = args.indexOf("--write-media");
				const { writeFileSync } = await import("node:fs");
				writeFileSync(args[mediaIdx + 1], Buffer.from("x"));
				return { stdout: Buffer.from(""), stderr: "", code: 0 };
			});
		const stringRunner = mk();
		await new EdgeTts({ command: "edge-tts", runner: stringRunner }).synthesize(
			"hi",
			"zh-CN-XiaoxiaoNeural",
			{ signal: new AbortController().signal },
		);
		const specRunner = mk();
		await new EdgeTts({ command: "edge-tts", runner: specRunner }).synthesize(
			"hi",
			{ voiceId: "zh-CN-XiaoxiaoNeural" },
			{ signal: new AbortController().signal },
		);
		const shape = (args: string[]) =>
			args.map((a) => (a.includes("voice-tts-") ? "<tmp>" : a));
		expect(shape(specRunner.runCalls[0].args)).toEqual(
			shape(stringRunner.runCalls[0].args),
		);
	});

	it("legacy string voice argv is byte-identical to the pre-FLY-546 shape (reverse-compat sentinel)", async () => {
		const runner = new FakeProcessRunner(async (_cmd, args) => {
			const mediaIdx = args.indexOf("--write-media");
			const { writeFileSync } = await import("node:fs");
			writeFileSync(args[mediaIdx + 1], Buffer.from("x"));
			return { stdout: Buffer.from(""), stderr: "", code: 0 };
		});
		const tts = new EdgeTts({ command: "edge-tts", runner });
		await tts.synthesize("hi", "zh-CN-XiaoxiaoNeural", {
			signal: new AbortController().signal,
		});
		const args = runner.runCalls[0].args;
		expect(args).toHaveLength(6);
		expect(args[0]).toBe("--voice");
		expect(args[1]).toBe("zh-CN-XiaoxiaoNeural");
		expect(args[2]).toBe("--file");
		expect(args[4]).toBe("--write-media");
	});

	it.each([
		["rate missing sign", { voiceId: "v", rate: "10%" }],
		["rate missing unit", { voiceId: "v", rate: "+10" }],
		["pitch wrong unit case", { voiceId: "v", pitch: "+2hz" }],
		["pitch missing sign", { voiceId: "v", pitch: "2Hz" }],
	] as const)(
		"rejects malformed prosody fail-fast: %s",
		async (_name, spec) => {
			const tts = new EdgeTts({
				command: "edge-tts",
				runner: new FakeProcessRunner(),
			});
			await expect(
				tts.synthesize("hi", spec, { signal: new AbortController().signal }),
			).rejects.toMatchObject({ code: "component-missing" });
		},
	);

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
