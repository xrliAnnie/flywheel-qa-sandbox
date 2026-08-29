import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { EdgeTtsBackend } from "../backends/edge-tts/EdgeTtsBackend.js";
import { GeminiLiveBackend } from "../backends/gemini/GeminiLiveBackend.js";
import type {
	GeminiLiveTransport,
	LiveConnection,
	LiveConnectParams,
} from "../backends/gemini/transport.js";
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
	it("parses the talk command", () => {
		const a = parseCliArgs([
			"talk",
			"--lead",
			"tadashi",
			"--project",
			"/repo",
			"--device",
			":1",
		]);
		expect(a.command).toBe("talk");
		expect(a.leadId).toBe("tadashi");
		expect(a.device).toBe(":1");
	});
	it("defaults to help for an unknown command", () => {
		expect(parseCliArgs(["wat"]).command).toBe("help");
		expect(parseCliArgs([]).command).toBe("help");
	});
});

describe("overridesFromArgs", () => {
	it("derives identity path from project + lead", () => {
		const o = overridesFromArgs(
			parseCliArgs(["talk", "--lead", "belle", "--project", "/x"]),
		);
		expect(o.identityFile).toBe("/x/.lead/belle/identity.md");
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
describe("buildRegistry (A5 pluggability, dual-face)", () => {
	const config = resolveConfig({}, {} as NodeJS.ProcessEnv);
	const fakeTransport: GeminiLiveTransport = {
		async connect(_p: LiveConnectParams): Promise<LiveConnection> {
			return {
				sendAudio() {},
				sendText() {},
				sendToolResponse() {},
				onEvent() {},
				async close() {},
			};
		},
	};

	it("registers only the announce backend by default", () => {
		const r = buildRegistry(config);
		expect(r.ids()).toEqual(["edge-tts"]);
	});

	it("registers both faces and creates each by id (consistency passes)", async () => {
		const r = buildRegistry(config, {
			enableConverse: true,
			converse: { transport: fakeTransport },
		});
		expect(r.ids().sort()).toEqual(["edge-tts", "gemini-live"]);
		const announce = await r.create("edge-tts");
		const converse = await r.create("gemini-live");
		expect(announce).toBeInstanceOf(EdgeTtsBackend);
		expect(announce.capabilities.announce).toBe(true);
		expect(converse).toBeInstanceOf(GeminiLiveBackend);
		expect(converse.capabilities.converse).toBe(true);
	});
});
