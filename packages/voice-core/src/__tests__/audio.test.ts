import { describe, expect, it } from "vitest";
import { FilePlayer } from "../audio/FilePlayer.js";
import { MicCapture } from "../audio/MicCapture.js";
import { StreamPlayer } from "../audio/StreamPlayer.js";
import type { AudioFormat, VoiceError } from "../types.js";
import { FakeProcessRunner } from "./fakes.js";

const MP3: AudioFormat = { encoding: "mp3", sampleRateHz: 24_000, channels: 1 };

describe("FilePlayer (announce face)", () => {
	it("spawns afplay, records spawnMs, resolves done on exit", async () => {
		const runner = new FakeProcessRunner();
		const player = new FilePlayer({ afplayBin: "afplay", runner });
		const pb = player.play(Buffer.from("MP3DATA"), MP3);
		expect(runner.spawnCalls[0].cmd).toBe("afplay");
		expect(pb.spawnMs).toBeGreaterThanOrEqual(0);
		runner.handles[0].emitExit(0);
		expect(await pb.done).toEqual({ interrupted: false });
	});

	it("interrupt SIGTERMs afplay and reports interrupted", async () => {
		const runner = new FakeProcessRunner();
		const player = new FilePlayer({ afplayBin: "afplay", runner });
		const pb = player.play(Buffer.from("MP3DATA"), MP3);
		pb.interrupt();
		expect(runner.handles[0].killedWith).toBe("SIGTERM");
		runner.handles[0].emitExit(null, "SIGTERM");
		expect(await pb.done).toEqual({ interrupted: true });
	});

	it("rejects empty audio", () => {
		const player = new FilePlayer({
			afplayBin: "afplay",
			runner: new FakeProcessRunner(),
		});
		expect(() => player.play(Buffer.alloc(0), MP3)).toThrowError(/empty audio/);
	});
});

describe("StreamPlayer (converse face)", () => {
	it("lazily spawns ffplay on first feed and pipes chunks to stdin", () => {
		const runner = new FakeProcessRunner();
		const player = new StreamPlayer({ ffplayBin: "ffplay", runner });
		expect(runner.spawnCalls).toHaveLength(0); // lazy
		player.feed(Buffer.from("PCM1"));
		player.feed(Buffer.from("PCM2"));
		expect(runner.spawnCalls).toHaveLength(1);
		expect(runner.spawnCalls[0].cmd).toBe("ffplay");
		expect(runner.spawnCalls[0].args).toContain("s16le");
		expect(runner.handles[0].written).toEqual(["PCM1", "PCM2"]);
		expect(player.playbackStartAt).toBeDefined();
	});

	it("interrupt kills ffplay (flush) and the next feed respawns fresh", () => {
		const runner = new FakeProcessRunner();
		const player = new StreamPlayer({ ffplayBin: "ffplay", runner });
		player.feed(Buffer.from("A"));
		player.interrupt();
		expect(runner.handles[0].killedWith).toBe("SIGTERM");
		player.feed(Buffer.from("B"));
		expect(runner.spawnCalls).toHaveLength(2); // respawned
		expect(runner.handles[1].written).toEqual(["B"]);
	});

	it("close ends stdin", () => {
		const runner = new FakeProcessRunner();
		const player = new StreamPlayer({ ffplayBin: "ffplay", runner });
		player.feed(Buffer.from("A"));
		player.close();
		expect(runner.handles[0].ended).toBe(true);
	});
});

describe("MicCapture (streaming, converse face)", () => {
	it("streams PCM frames to onFrame; mute stops forwarding without teardown", () => {
		const runner = new FakeProcessRunner();
		const mic = new MicCapture({ ffmpegBin: "ffmpeg", runner });
		const frames: string[] = [];
		mic.start((f) => frames.push(f.toString()));
		expect(runner.spawnCalls[0].cmd).toBe("ffmpeg");
		expect(runner.spawnCalls[0].args).toContain("avfoundation");
		expect(runner.spawnCalls[0].args).toContain("s16le");
		runner.handles[0].emitStdout("frame1");
		mic.setMuted(true);
		runner.handles[0].emitStdout("muted-frame");
		mic.setMuted(false);
		runner.handles[0].emitStdout("frame2");
		expect(frames).toEqual(["frame1", "frame2"]);
		expect(runner.handles[0].killedWith).toBeUndefined(); // no teardown on mute
	});

	it("throws if started twice; stop kills ffmpeg", () => {
		const runner = new FakeProcessRunner();
		const mic = new MicCapture({ ffmpegBin: "ffmpeg", runner });
		mic.start(() => {});
		expect(() => mic.start(() => {})).toThrowError(/already started/);
		mic.stop();
		expect(runner.handles[0].killedWith).toBe("SIGTERM");
	});

	it("captures from the system default input (:default) when no device given", () => {
		const runner = new FakeProcessRunner();
		const mic = new MicCapture({ ffmpegBin: "ffmpeg", runner });
		mic.start(() => {});
		const spawned = runner.spawnCalls[0];
		const i = spawned.args.indexOf("-i");
		expect(spawned.args[i + 1]).toBe(":default");
	});

	it("passes an explicit device through unchanged", () => {
		const runner = new FakeProcessRunner();
		const mic = new MicCapture({ ffmpegBin: "ffmpeg", device: ":2", runner });
		mic.start(() => {});
		expect(runner.spawnCalls[0].args).toContain(":2");
	});

	it("reports a non-zero exit with stderr + device guidance via onError", () => {
		const runner = new FakeProcessRunner();
		const mic = new MicCapture({ ffmpegBin: "ffmpeg", runner });
		const errors: VoiceError[] = [];
		mic.start(
			() => {},
			(e) => errors.push(e),
		);
		const h = runner.handles[0];
		h.emitStderr(": Input/output error");
		h.emitExit(1);
		expect(errors).toHaveLength(1);
		expect(errors[0].code).toBe("subprocess-failed");
		expect(errors[0].message).toContain("Input/output error");
		expect(errors[0].message).toContain("-list_devices");
		expect(errors[0].message).toContain("FLYWHEEL_VOICE_MIC_DEVICE");
	});

	it("stays silent when exit follows an intentional stop()", () => {
		const runner = new FakeProcessRunner();
		const mic = new MicCapture({ ffmpegBin: "ffmpeg", runner });
		const errors: VoiceError[] = [];
		mic.start(
			() => {},
			(e) => errors.push(e),
		);
		const h = runner.handles[0];
		mic.stop();
		h.emitExit(null, "SIGTERM");
		expect(errors).toHaveLength(0);
	});
});
