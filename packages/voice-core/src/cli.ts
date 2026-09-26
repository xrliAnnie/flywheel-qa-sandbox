#!/usr/bin/env node
/**
 * flywheel-voice-poc — the POC CLI (plan.md r2 §4). One command:
 *
 *   say   — announce face: speak a report / standup. Text comes ONLY from
 *           --stdin (pipe) or --file <path>, never a positional arg (argv
 *           hygiene at the top level too — announce content is report prose).
 *
 * FLY-2860 retired the `talk` converse command. The pure arg-parser + text
 * reader are exported for tests; the command only runs when invoked as a
 * program.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ConfigOverrides, resolveConfig } from "./config.js";
import { JsonlTranscriptSink } from "./transcript.js";

export interface CliArgs {
	command: "say" | "help";
	voice?: string;
	transcriptDir?: string;
	/** say: read text from this file. */
	file?: string;
	/** say: read text from stdin. */
	stdin: boolean;
	help: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
	const [cmd, ...rest] = argv;
	const command: CliArgs["command"] = cmd === "say" ? cmd : "help";
	const args: CliArgs = {
		command,
		stdin: false,
		help: command === "help",
	};
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		const next = () => rest[++i];
		switch (a) {
			case "--voice":
				args.voice = next();
				break;
			case "--transcript-dir":
				args.transcriptDir = next();
				break;
			case "--file":
				args.file = next();
				break;
			case "--stdin":
				args.stdin = true;
				break;
			case "-h":
			case "--help":
				args.help = true;
				break;
			default:
				break;
		}
	}
	return args;
}

export function overridesFromArgs(args: CliArgs): ConfigOverrides {
	const overrides: ConfigOverrides = {};
	if (args.voice) overrides.voice = args.voice;
	if (args.transcriptDir) overrides.transcriptDir = args.transcriptDir;
	return overrides;
}

/** say text source: --file or --stdin only (never a positional/argv value). */
export async function readSayText(
	args: CliArgs,
	stdin: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
	if (args.file) return readFileSync(args.file, "utf8");
	if (args.stdin) {
		const chunks: Buffer[] = [];
		for await (const c of stdin)
			chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
		return Buffer.concat(chunks).toString("utf8");
	}
	throw new Error("say: provide text via --stdin (pipe) or --file <path>");
}

const HELP = `flywheel-voice-poc — pluggable voice POC (FLY-543)

Usage:
  flywheel-voice-poc say --stdin | --file <path> [--voice <id>]

Commands:
  say    announce face (Edge TTS) — speak report/standup text (stdin/file only)

Component paths come from FLYWHEEL_VOICE_* env.
`;

async function runSay(args: CliArgs): Promise<void> {
	const config = resolveConfig(overridesFromArgs(args));
	const text = await readSayText(args);
	const { buildEdgeTtsBackend } = await import("./factory.js");
	const backend = buildEdgeTtsBackend(config);
	const transcriptPath = join(
		config.transcriptDir,
		`voice-say-${Date.now()}.jsonl`,
	);
	const announcer = await backend.createAnnouncer({
		voice: config.voice,
		transcriptSink: new JsonlTranscriptSink(transcriptPath),
	});
	process.stdout.write(
		`flywheel-voice-poc say — backend=${backend.id}  voice=${config.voice}\n`,
	);
	const r = await announcer.speak(text);
	process.stderr.write(
		`  [metrics] ttsFirstByte=${r.ttsFirstByteMs}ms  playbackStart=${r.playbackStartMs}ms  duration=${r.durationMs}ms  (first-response=playbackStart)\n`,
	);
	process.stdout.write(`transcript → ${transcriptPath}\n`);
	await announcer.close();
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (args.help || args.command === "help") {
		process.stdout.write(HELP);
		return;
	}
	return runSay(args);
}

const isMain =
	process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.ts");
if (isMain) {
	main().catch((err) => {
		process.stderr.write(`fatal: ${String(err?.message ?? err)}\n`);
		process.exitCode = 1;
	});
}
