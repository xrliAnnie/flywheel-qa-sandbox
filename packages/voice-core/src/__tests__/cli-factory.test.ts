import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { EdgeTtsBackend } from "../backends/edge-tts/EdgeTtsBackend.js";
import { overridesFromArgs, parseCliArgs, readSayText } from "../cli.js";
import { resolveConfig } from "../config.js";
import { buildRegistry } from "../factory.js";

const cleanup: string[] = [];
afterEach(() => {
	for (const d of cleanup) rmSync(d, { recursive: true, force: true });
	cleanup.length = 0;
});

describe("parseCliArgs", () => {
	it("parses the say command", () => {
		const a = parseCliArgs(["say", "--stdin", "--voice", "en-US-X"]);
		expect(a.command).toBe("say");
		expect(a.stdin).toBe(true);
		expect(a.voice).toBe("en-US-X");
	});
	it("no longer accepts the retired talk command (FLY-2860)", () => {
		const a = parseCliArgs(["talk", "--lead", "tadashi", "--device", ":1"]);
		expect(a.command).toBe("help");
		expect(Object.keys(a).sort()).toEqual(["command", "help", "stdin"]);
	});
	it("defaults to help for an unknown command", () => {
		expect(parseCliArgs(["wat"]).command).toBe("help");
		expect(parseCliArgs([]).command).toBe("help");
	});
});

describe("overridesFromArgs", () => {
	it("maps only the say options (voice, transcript dir)", () => {
		const o = overridesFromArgs(
			parseCliArgs([
				"say",
				"--voice",
				"en-US-X",
				"--transcript-dir",
				"/t",
				"--lead",
				"belle",
				"--project",
				"/x",
			]),
		);
		expect(o).toEqual({ voice: "en-US-X", transcriptDir: "/t" });
	});
});

describe("readSayText (argv hygiene at the CLI)", () => {
	it("reads from --file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "voice-say-"));
		cleanup.push(dir);
		const f = join(dir, "report.txt");
		writeFileSync(f, "早会内容");
		const args = parseCliArgs(["say", "--file", f]);
		expect(await readSayText(args)).toBe("早会内容");
	});
	it("reads from --stdin", async () => {
		const args = parseCliArgs(["say", "--stdin"]);
		const stdin = Readable.from([Buffer.from("piped text")]);
		expect(await readSayText(args, stdin)).toBe("piped text");
	});
	it("throws when neither --file nor --stdin is given (no positional text)", async () => {
		await expect(readSayText(parseCliArgs(["say"]))).rejects.toThrow(
			/--stdin|--file/,
		);
	});
});

// A5 — the pluggability proof: switching backend routes through the registry.
describe("buildRegistry (A5 pluggability)", () => {
	const config = resolveConfig({}, {} as NodeJS.ProcessEnv);

	it("registers only the announce backend (no bundled converse backend)", async () => {
		const r = buildRegistry(config);
		expect(r.ids()).toEqual(["edge-tts"]);
		const announce = await r.create("edge-tts");
		expect(announce).toBeInstanceOf(EdgeTtsBackend);
		expect(announce.capabilities.announce).toBe(true);
	});
});
