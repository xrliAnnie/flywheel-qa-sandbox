import {
	ChildProcess,
	type ExecFileOptionsWithStringEncoding,
	execFile,
	execFileSync,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execFile: vi.fn(actual.execFile) };
});

import { LeadArtifactStore } from "../../lead-capabilities/artifacts.js";
import { XhsFrozenArtifactStore } from "../artifacts.js";
import { createMediaValidator } from "../media-validator.js";
import { XhsWriteStore } from "../store.js";

const root = mkdtempSync(join(tmpdir(), "xhs-decode-test-"));
const ffmpeg = realpathSync(
	execFileSync("/usr/bin/which", ["ffmpeg"], { encoding: "utf8" }).trim(),
);
const ffprobe = realpathSync(
	execFileSync("/usr/bin/which", ["ffprobe"], { encoding: "utf8" }).trim(),
);
const pin = (path: string) => ({
	path,
	sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
});
const options = {
	scratchRoot: root,
	ffmpeg: pin(ffmpeg),
	ffprobe: pin(ffprobe),
	timeoutMs: 10_000,
};
afterAll(() => rmSync(root, { recursive: true, force: true }));
function media(extension: string): Buffer {
	if (extension === "webp")
		return Buffer.from(
			"UklGRjoAAABXRUJQVlA4IC4AAACwAQCdASoCAAIAAgA0JaACdLoABDAAAP75k2//kB//kB//kB//ID/iF3sYUAAA",
			"base64",
		);
	const path = join(root, `fixture.${extension}`);
	execFileSync(
		ffmpeg,
		[
			"-nostdin",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=c=blue:s=32x32:r=1",
			"-frames:v",
			"1",
			"-threads",
			"1",
			"-y",
			path,
		],
		{ timeout: 10_000 },
	);
	const bytes = readFileSync(path);
	rmSync(path);
	return bytes;
}
it.each([
	["png", "image/png"],
	["jpg", "image/jpeg"],
	["webp", "image/webp"],
	["mp4", "video/mp4"],
] as const)(
	"actually decodes valid %s bytes and removes private scratch",
	async (extension, mime) => {
		const validate = createMediaValidator(options);
		await expect(validate(media(extension), mime)).resolves.toBeUndefined();
		expect(readdirSync(root)).toEqual([]);
	},
);
it("rejects a synthetic magic-only image that the store fixture intentionally accepts", async () => {
	const validate = createMediaValidator(options);
	await expect(
		validate(
			Buffer.from("89504e470d0a1a0a0000000049454e44ae426082", "hex"),
			"image/png",
		),
	).rejects.toThrow("artifact_unverified");
	expect(readdirSync(root)).toEqual([]);
});
it("rejects a changed decoder binary pin and scrubs paths and diagnostics", async () => {
	const validate = createMediaValidator({
		...options,
		ffmpeg: { ...options.ffmpeg, sha256: "0".repeat(64) },
	});
	await expect(validate(media("png"), "image/png")).rejects.toThrow(
		/^artifact_unverified$/,
	);
	expect(readdirSync(root)).toEqual([]);
});

it("rejects truncated video bytes and cleans its private working directory", async () => {
	const validate = createMediaValidator(options);
	const video = media("mp4");
	await expect(validate(video.subarray(0, 48), "video/mp4")).rejects.toThrow(
		/^artifact_unverified$/,
	);
	expect(readdirSync(root)).toEqual([]);
});
it("kills and waits for the exact timed-out decoder process", async () => {
	const directory = mkdtempSync(join(tmpdir(), "xhs-decoder-process-"));
	const actual =
		await vi.importActual<typeof import("node:child_process")>(
			"node:child_process",
		);
	let child: ChildProcess | undefined;
	try {
		const probe = join(directory, "probe"),
			decoder = join(directory, "decoder");
		writeFileSync(probe, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
		writeFileSync(decoder, "#!/bin/sh\nexec /bin/sleep 10\n", { mode: 0o700 });
		// Real decoding/probing is covered above. Isolate the kill test from probe startup
		// scheduling, then retain the real ChildProcess identity and exit signal.
		type Callback = (
			error: Error | null,
			stdout: string,
			stderr: string,
		) => void;
		const invoke = (
			file: string,
			args: readonly string[],
			opts: ExecFileOptionsWithStringEncoding,
			callback: Callback,
		) => {
			if (file === probe) {
				queueMicrotask(() =>
					callback(
						null,
						JSON.stringify({
							streams: [
								{
									codec_type: "video",
									codec_name: "png",
									width: 32,
									height: 32,
								},
							],
						}),
						"",
					),
				);
				return new ChildProcess();
			}
			child = actual.execFile(file, args, opts, callback);
			return child;
		};
		vi.mocked(execFile).mockImplementation(invoke as typeof execFile);
		const validate = createMediaValidator({
			...options,
			ffmpeg: pin(decoder),
			ffprobe: pin(probe),
			timeoutMs: 2000,
		});
		await expect(validate(media("png"), "image/png")).rejects.toThrow(
			/^artifact_unverified$/,
		);
		const pid = child?.pid;
		expect(pid).toBeGreaterThan(0);
		expect(child?.signalCode).toBe("SIGKILL");
		expect(() => process.kill(pid!, 0)).toThrow();
		expect(readdirSync(root)).toEqual([]);
	} finally {
		vi.mocked(execFile).mockImplementation(actual.execFile);
		if (child?.exitCode === null && child.signalCode === null)
			child.kill("SIGKILL");
		rmSync(directory, { recursive: true, force: true });
	}
});

it("carries real generated image/video through parent registration and authority decoding with stable reuse", async () => {
	const projectRoot = realpathSync(
		mkdtempSync(join(tmpdir(), "xhs-real-media-chain-")),
	);
	const artifactRoot = join(projectRoot, "artifacts"),
		privateRoot = join(projectRoot, "private-media");
	mkdirSync(artifactRoot, { mode: 0o700 });
	mkdirSync(privateRoot, { mode: 0o700 });
	const parent = new LeadArtifactStore({
		projectRoot,
		artifactRoot,
		assertCurrent: () => {},
	});
	const ledger = new XhsWriteStore(join(projectRoot, "ledger.db"), {
		initialize: true,
		providerGeneration: "generation",
	});
	const authority = new XhsFrozenArtifactStore(privateRoot, ledger, {
		attachmentLimit: 10 * 1024 * 1024,
		validate: createMediaValidator(options),
	});
	try {
		for (const extension of ["png", "mp4"] as const) {
			const data = media(extension),
				mime = extension === "png" ? "image/png" : "video/mp4";
			const registered =
				extension === "mp4"
					? await parent.putVideo(
							(async function* () {
								yield data;
							})(),
						)
					: await parent.put(data, mime);
			const loaded = await parent.read(registered.handle);
			const upload = () =>
				authority.import(
					"project",
					mime,
					(async function* () {
						yield loaded.data;
					})(),
					Date.now(),
				);
			const frozen = await upload();
			expect(frozen).toMatchObject({
				mimeType: mime,
				sizeBytes: registered.size,
				sha256: registered.sha256,
			});
			expect(await authority.read("project", frozen)).toEqual(data);
			expect(await upload()).toEqual(frozen);
		}
		const truncated = media("mp4").subarray(0, 48);
		const registered = await parent.putVideo(
			(async function* () {
				yield truncated;
			})(),
		);
		const loaded = await parent.read(registered.handle);
		await expect(
			authority.import(
				"project",
				"video/mp4",
				(async function* () {
					yield loaded.data;
				})(),
				Date.now(),
			),
		).rejects.toThrow("artifact_unverified");
		expect(readdirSync(privateRoot)).toHaveLength(2);
		expect(readdirSync(root)).toEqual([]);
	} finally {
		parent.close();
		ledger.close();
		rmSync(projectRoot, { recursive: true, force: true });
	}
});
