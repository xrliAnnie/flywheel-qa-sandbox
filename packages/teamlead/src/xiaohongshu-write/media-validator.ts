import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import type { FrozenArtifact } from "./contracts.js";

type BinaryPin = { path: string; sha256: string };
type Options = {
	scratchRoot: string;
	ffmpeg: BinaryPin;
	ffprobe: BinaryPin;
	timeoutMs?: number;
};
function verify(pin: BinaryPin): void {
	const stat = lstatSync(pin.path);
	if (
		!isAbsolute(pin.path) ||
		!stat.isFile() ||
		(stat.mode & 0o022) !== 0 ||
		!/^[a-f0-9]{64}$/.test(pin.sha256) ||
		createHash("sha256").update(readFileSync(pin.path)).digest("hex") !==
			pin.sha256
	)
		throw Error("artifact_unverified");
}
/** Policy supplies immutable binaries and a private scratch root; never a model path. */
export function createMediaValidator(options: Options) {
	const policy = structuredClone(options);
	const timeout = Math.min(policy.timeoutMs ?? 60_000, 60_000);
	if (!Number.isSafeInteger(timeout) || timeout <= 0)
		throw Error("artifact_unverified");
	return async (
		bytes: Buffer,
		mime: FrozenArtifact["mimeType"],
	): Promise<void> => {
		let scratch: string | undefined;
		try {
			if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw Error();
			verify(policy.ffmpeg);
			verify(policy.ffprobe);
			const root = lstatSync(policy.scratchRoot);
			if (
				!isAbsolute(policy.scratchRoot) ||
				!root.isDirectory() ||
				(root.mode & 0o777) !== 0o700
			)
				throw Error();
			scratch = mkdtempSync(join(policy.scratchRoot, "decode-"));
			const inputPath = join(scratch, "input");
			writeFileSync(inputPath, bytes, { flag: "wx", mode: 0o600 });
			const demuxer = {
				"image/png": "png_pipe",
				"image/jpeg": "jpeg_pipe",
				"image/webp": "webp_pipe",
				"video/mp4": "mov",
			}[mime];
			if (!demuxer) throw Error();
			const input = [
				"-protocol_whitelist",
				"file,pipe",
				"-f",
				demuxer,
				...(mime === "video/mp4"
					? ["-enable_drefs", "0", "-use_absolute_path", "0"]
					: []),
				"-i",
				inputPath,
			];
			const run = (binary: BinaryPin, args: string[]) =>
				new Promise<string>((resolve, reject) => {
					verify(binary);
					execFile(
						binary.path,
						args,
						{
							cwd: scratch,
							timeout,
							killSignal: "SIGKILL",
							maxBuffer: 65536,
							encoding: "utf8",
							env: {
								PATH: "/usr/bin:/bin",
								LANG: "C",
								LC_ALL: "C",
								HOME: scratch,
							},
						},
						(error, stdout) => {
							if (error) reject(Error("artifact_unverified"));
							else resolve(stdout);
						},
					);
				});
			const probe = JSON.parse(
				await run(policy.ffprobe, [
					"-v",
					"error",
					"-max_alloc",
					"67108864",
					...input,
					"-show_entries",
					"stream=codec_type,codec_name,width,height",
					"-of",
					"json",
				]),
			) as {
				streams?: Array<{
					codec_type?: string;
					codec_name?: string;
					width?: number;
					height?: number;
				}>;
			};
			const streams = probe.streams;
			if (
				!Array.isArray(streams) ||
				streams.length < 1 ||
				streams.length > 2 ||
				streams.some(
					(stream) => !["video", "audio"].includes(stream.codec_type ?? ""),
				)
			)
				throw Error();
			const videos = streams.filter((stream) => stream.codec_type === "video");
			if (videos.length !== 1) throw Error();
			const video = videos[0]!;
			if (
				!Number.isSafeInteger(video.width) ||
				!Number.isSafeInteger(video.height) ||
				video.width! <= 0 ||
				video.height! <= 0 ||
				video.width! * video.height! > 40_000_000
			)
				throw Error();
			if (mime !== "video/mp4") {
				const expected = {
					"image/png": "png",
					"image/jpeg": "mjpeg",
					"image/webp": "webp",
				}[mime];
				if (streams.length !== 1 || video.codec_name !== expected)
					throw Error();
			}
			await run(policy.ffmpeg, [
				"-nostdin",
				"-v",
				"error",
				"-xerror",
				"-max_alloc",
				"67108864",
				"-err_detect",
				"explode",
				"-threads",
				"1",
				...input,
				"-map",
				"0:v:0",
				"-map",
				"0:a?",
				"-threads",
				"1",
				"-filter_threads",
				"1",
				"-f",
				"null",
				"-",
			]);
		} catch {
			throw Error("artifact_unverified");
		} finally {
			if (scratch) rmSync(scratch, { recursive: true, force: true });
		}
	};
}
