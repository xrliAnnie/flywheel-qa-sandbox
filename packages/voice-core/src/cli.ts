#!/usr/bin/env node
/**
 * flywheel-voice-poc — the POC CLI (plan.md r2 §4). Two commands:
 *
 *   say   — announce face: speak a report / standup. Text comes ONLY from
 *           --stdin (pipe) or --file <path>, never a positional arg (argv
 *           hygiene at the top level too — announce content is report prose).
 *   talk  — converse face: full voice conversation with a Lead via Gemini Live.
 *
 * Backends resolve through the registry, so switching faces/backends does not
 * touch the loop (A5). The pure arg-parser + text reader are exported for tests;
 * the interactive loop only runs when invoked as a program.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MicCapture } from "./audio/MicCapture.js";
import { StreamPlayer } from "./audio/StreamPlayer.js";
import {
	type ConfigOverrides,
	resolveConfig,
	verifyConverseComponents,
} from "./config.js";
import { buildHeadlessBrain, buildRegistry } from "./factory.js";
import { TalkSessionRotator } from "./TalkSessionRotator.js";
import { JsonlTranscriptSink } from "./transcript.js";
import type { AudioFormat, ConversationSession } from "./types.js";

export interface CliArgs {
	command: "say" | "talk" | "help";
	leadId?: string;
	project: string;
	voice?: string;
	transcriptDir?: string;
	device?: string;
	/** say: read text from this file. */
	file?: string;
	/** say: read text from stdin. */
	stdin: boolean;
	help: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs {
	const [cmd, ...rest] = argv;
	const command: CliArgs["command"] =
		cmd === "say" || cmd === "talk" ? cmd : "help";
	const args: CliArgs = {
		command,
		project: process.cwd(),
		stdin: false,
		help: command === "help",
	};
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		const next = () => rest[++i];
		switch (a) {
			case "--lead":
				args.leadId = next();
				break;
			case "--project":
				args.project = next() ?? args.project;
				break;
			case "--voice":
				args.voice = next();
				break;
			case "--transcript-dir":
				args.transcriptDir = next();
				break;
			case "--device":
				args.device = next();
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
	if (args.leadId) {
		overrides.identityFile = join(
			args.project,
			".lead",
			args.leadId,
			"identity.md",
		);
	}
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
  flywheel-voice-poc say  --stdin | --file <path> [--voice <id>]
  flywheel-voice-poc talk --lead <LEAD_ID> --project <dir> [--device :default]

Commands:
  say    announce face (Edge TTS) — speak report/standup text (stdin/file only)
  talk   converse face (Gemini Live) — voice conversation with a Lead

Component paths come from FLYWHEEL_VOICE_* env; the converse face needs GEMINI_API_KEY.
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

async function runTalk(args: CliArgs): Promise<void> {
	const config = resolveConfig(overridesFromArgs(args));
	verifyConverseComponents(config); // fail-fast if GEMINI_API_KEY missing
	const registry = buildRegistry(config, {
		enableConverse: true,
		converse: { apiKey: process.env[config.gemini.apiKeyEnv] },
	});
	const backend = await registry.create("gemini-live");
	const brain = buildHeadlessBrain(config);
	const transcriptPath = join(
		config.transcriptDir,
		`voice-talk-${args.leadId ?? "lead"}-${Date.now()}.jsonl`,
	);
	const transcriptSink = new JsonlTranscriptSink(transcriptPath);
	const player = new StreamPlayer({ ffplayBin: config.ffplayBin });
	const mic = new MicCapture({
		ffmpegBin: config.ffmpegBin,
		device: args.device ?? config.micDevice,
	});
	const PCM: AudioFormat = {
		encoding: "pcm16",
		sampleRateHz: 16_000,
		channels: 1,
	};

	let finish: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let shuttingDown = false;
	// single shutdown path: SIGINT, mic death, and failed renewal all land here.
	const shutdown = (): void => {
		if (shuttingDown) return;
		shuttingDown = true;
		mic.stop();
		player.close();
		void rotator.close().finally(() => finish());
	};

	const attach = (session: ConversationSession): void => {
		session.on("response-audio", (chunk) => player.feed(chunk));
		session.on("response-cancelled", () => player.interrupt());
		session.on("transcript", ({ role, text, final }) => {
			if (final)
				process.stdout.write(
					`  ${role === "user" ? "you" : "lead"}: ${text}\n`,
				);
		});
		session.on("session-expiring", ({ inSec }) =>
			process.stderr.write(`  [session expiring in ~${inSec}s — renewing]\n`),
		);
		// low-noise regression marker (Codex R1 #2): objective proof the model
		// really called the tool — name+callId only, never args/question text.
		session.on("tool-call", ({ callId, name }) =>
			process.stderr.write(`  [tool-call ${name} ${callId}]\n`),
		);
		session.on("error", (err) =>
			process.stderr.write(`  [error ${err.code}] ${err.message}\n`),
		);
	};

	const rotator = new TalkSessionRotator({
		create: (resumeHandle) =>
			(
				backend.createConversation as NonNullable<
					typeof backend.createConversation
				>
			)({
				brain,
				voice: config.voice,
				systemHint: "spoken, short sentences, no markdown",
				transcriptSink,
				resumeHandle,
			}),
		attach,
		log: (line) => process.stderr.write(`  ${line}\n`),
		onError: (err) => {
			process.stderr.write(
				`  [fatal] session renewal failed: ${String(err)}\n`,
			);
			process.exitCode = 1;
			shutdown();
		},
	});

	await rotator.start();
	mic.start(
		(frame) => rotator.sendAudio(frame, PCM),
		(err) => {
			process.stderr.write(`  [fatal] ${err.message}\n`);
			process.exitCode = 1;
			shutdown();
		},
	);
	process.stdout.write(
		`flywheel-voice-poc talk — backend=${backend.id}  lead=${args.leadId ?? "(none)"}\n` +
			`transcript → ${transcriptPath}\nSpeak now. Ctrl+C to quit.\n`,
	);
	process.on("SIGINT", shutdown);
	await done;
}

async function main(): Promise<void> {
	const args = parseCliArgs(process.argv.slice(2));
	if (args.help || args.command === "help") {
		process.stdout.write(HELP);
		return;
	}
	if (args.command === "say") return runSay(args);
	return runTalk(args);
}

const isMain =
	process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.ts");
if (isMain) {
	main().catch((err) => {
		process.stderr.write(`fatal: ${String(err?.message ?? err)}\n`);
		process.exitCode = 1;
	});
}
