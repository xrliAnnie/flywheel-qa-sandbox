/**
 * HeadlessClaudeBrain — the POC BrainAdapter (plan.md r2 §4 step 5; §0 safety
 * boundary). `claude -p` with ZERO tools + the Lead's identity.md persona + a
 * voice-context preamble. READ-ONLY approximation of the Lead: it discusses and
 * explains, executes nothing. Saying "approve/ship/merge" only gets a spoken
 * reply. Prompt goes via STDIN, never argv (argv hygiene).
 *
 * Parameters are FROZEN by the S0.1 spike (evidence/spike-phase0.md):
 *   - zero tools = "--tools '' --strict-mcp-config" (both — else project .mcp.json
 *     MCP servers still load). Re-sent every turn (tool config is not session-persistent).
 *   - persona = --append-system-prompt-file <identity.md> (kept across --resume).
 *   - streaming = --output-format stream-json --include-partial-messages --verbose;
 *     take only text_delta (ignore thinking_delta).
 *   - session_id captured from the stream → subsequent turns use --resume (persona
 *     retained; no history re-injection). History re-injection is the fallback.
 *   - voice-context MUST say "you have no tools, don't fake execution with code
 *     blocks" (the spike saw zero-tool models pretend to run commands).
 */
import { existsSync } from "node:fs";
import {
	NodeProcessRunner,
	type ProcessHandle,
	type ProcessRunner,
} from "../process.js";
import { type BrainAdapter, type Turn, VoiceError } from "../types.js";
import { parseStreamLine } from "./stream-parse.js";

// FLY-1160 §3.0: the parser moved to the shared stream-parse module (the
// resident brain needs the kind-annotated variant); the public import path
// from this file keeps working.
export { parseStreamLine } from "./stream-parse.js";

const DEFAULT_VOICE_CONTEXT = [
	"You are speaking with the founder over a VOICE channel.",
	"Answer in short, spoken, conversational sentences. No markdown, no code blocks, no bullet lists.",
	"You have NO tools and can execute nothing — do not output code blocks pretending to run commands.",
	"If asked to approve / ship / merge / deploy / restart / delete anything, you may DISCUSS it, but",
	"make clear you cannot perform actions here — real actions happen through the normal Lead + approval",
	"flow, not this voice session.",
].join(" ");

const DEFAULT_TOOL_DISABLE_ARGS = ["--tools", "", "--strict-mcp-config"];

export interface HeadlessClaudeBrainOptions {
	claudeBin: string;
	/** path to the Lead's identity.md (required — persona source). */
	identityFile: string;
	voiceContext?: string;
	/** flags that disable all tools; S0.1 default = --tools "" --strict-mcp-config. */
	toolDisableArgs?: string[];
	/** extra passthrough args (model, etc.). */
	extraArgs?: string[];
	timeoutMs?: number;
	runner?: ProcessRunner;
	/** use --resume to keep one headless session across turns (default true). */
	useResume?: boolean;
}

export class HeadlessClaudeBrain implements BrainAdapter {
	private readonly runner: ProcessRunner;
	private sessionId?: string;

	constructor(private readonly opts: HeadlessClaudeBrainOptions) {
		this.runner = opts.runner ?? new NodeProcessRunner();
	}

	async *respond(
		turn: { text: string; history: Turn[] },
		opts: { signal: AbortSignal },
	): AsyncIterable<string> {
		if (!existsSync(this.opts.identityFile)) {
			throw new VoiceError(
				"component-missing",
				`identity file not found: ${this.opts.identityFile} (set FLYWHEEL_VOICE_IDENTITY to the Lead's identity.md)`,
			);
		}
		if (opts.signal.aborted)
			throw new VoiceError("cancelled", "brain aborted before start");

		const useResume =
			(this.opts.useResume ?? true) && this.sessionId !== undefined;
		const voiceContext = this.opts.voiceContext ?? DEFAULT_VOICE_CONTEXT;
		const toolDisable = this.opts.toolDisableArgs ?? DEFAULT_TOOL_DISABLE_ARGS;

		const args = ["-p", ...toolDisable];
		if (useResume) {
			// persona retained by the session; re-send tool-disable flags (not persistent).
			args.push("--resume", this.sessionId as string);
		} else {
			args.push("--append-system-prompt-file", this.opts.identityFile);
		}
		args.push(
			"--output-format",
			"stream-json",
			"--include-partial-messages",
			"--verbose",
		);
		args.push(...(this.opts.extraArgs ?? []));

		// resume keeps history in-session → send only the new turn; else re-inject.
		const prompt = useResume
			? buildPrompt(voiceContext, [], turn.text)
			: buildPrompt(voiceContext, turn.history, turn.text);

		const child = this.runner.spawn(this.opts.claudeBin, args);
		const stream = new BrainStream(child, opts.signal, this.opts.timeoutMs);
		child.end(prompt); // write prompt + close stdin (EOF) so claude -p starts
		try {
			yield* stream.chunks();
		} finally {
			const captured = stream.capturedSessionId();
			if (captured) this.sessionId = captured;
			stream.dispose();
		}
	}
}

function buildPrompt(
	voiceContext: string,
	history: Turn[],
	userText: string,
): string {
	const parts = ["<voice-context>", voiceContext, "</voice-context>", ""];
	if (history.length > 0) {
		parts.push("<conversation-so-far>");
		for (const t of history) {
			parts.push(`${t.role === "user" ? "Founder" : "You"}: ${t.text}`);
		}
		parts.push("</conversation-so-far>", "");
	}
	parts.push(`Founder (now): ${userText}`, "", "You (spoken reply):");
	return parts.join("\n");
}

/** Bridges the callback stdout into an async iterator of assistant text chunks. */
class BrainStream {
	private buf = "";
	private plain = "";
	private emittedStructured = false;
	private sessionId?: string;
	private queue: string[] = [];
	private resolve?: (v: IteratorResult<string>) => void;
	private done = false;
	private error?: Error;
	private exitCode: number | null | undefined;
	private timer?: NodeJS.Timeout;
	private readonly onAbort = () => {
		this.child.kill("SIGKILL");
		this.fail(new VoiceError("cancelled", "brain cancelled"));
	};

	constructor(
		private readonly child: ProcessHandle,
		private readonly signal: AbortSignal,
		timeoutMs?: number,
	) {
		child.onStdout((chunk) => this.onData(chunk));
		child.onExit((code) => this.onExit(code));
		signal.addEventListener("abort", this.onAbort);
		if (timeoutMs && timeoutMs > 0) {
			this.timer = setTimeout(() => {
				child.kill("SIGKILL");
				this.fail(
					new VoiceError("timeout", `brain timed out after ${timeoutMs}ms`),
				);
			}, timeoutMs);
		}
	}

	capturedSessionId(): string | undefined {
		return this.sessionId;
	}

	private onData(chunk: Buffer): void {
		this.buf += chunk.toString("utf8");
		let idx = this.buf.indexOf("\n");
		while (idx >= 0) {
			const line = this.buf.slice(0, idx);
			this.buf = this.buf.slice(idx + 1);
			this.consumeLine(line);
			idx = this.buf.indexOf("\n");
		}
	}

	private consumeLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		const parsed = parseStreamLine(trimmed);
		if (parsed.sessionId) this.sessionId = parsed.sessionId;
		if (parsed.recognized) {
			this.emittedStructured = true;
			if (parsed.text) this.push(parsed.text);
		} else {
			this.plain += `${line}\n`;
		}
	}

	private onExit(code: number | null): void {
		this.exitCode = code;
		if (this.buf.trim()) this.consumeLine(this.buf);
		this.buf = "";
		if (!this.emittedStructured && this.plain.trim())
			this.push(this.plain.trim());
		if (code !== 0 && code !== null) {
			this.fail(
				new VoiceError("subprocess-failed", `claude -p exited ${code}`),
			);
			return;
		}
		this.finish();
	}

	private push(text: string): void {
		if (this.done) return;
		if (this.resolve) {
			const r = this.resolve;
			this.resolve = undefined;
			r({ value: text, done: false });
		} else {
			this.queue.push(text);
		}
	}

	private finish(): void {
		if (this.done) return;
		this.done = true;
		this.cleanup();
		if (this.resolve) {
			const r = this.resolve;
			this.resolve = undefined;
			r({ value: undefined, done: true });
		}
	}

	private fail(err: Error): void {
		if (this.done) return;
		this.error = err;
		this.done = true;
		this.cleanup();
		if (this.resolve) {
			const r = this.resolve;
			this.resolve = undefined;
			r({ value: undefined, done: true });
		}
	}

	private cleanup(): void {
		if (this.timer) clearTimeout(this.timer);
		this.signal.removeEventListener("abort", this.onAbort);
	}

	dispose(): void {
		this.cleanup();
		if (!this.done && this.exitCode === undefined) this.child.kill("SIGKILL");
	}

	async *chunks(): AsyncGenerator<string> {
		while (true) {
			if (this.error) throw this.error;
			if (this.queue.length > 0) {
				const v = this.queue.shift() as string;
				if (v) yield v;
				continue;
			}
			if (this.done) {
				if (this.error) throw this.error;
				return;
			}
			const result = await new Promise<IteratorResult<string>>((res) => {
				this.resolve = res;
			});
			if (this.error) throw this.error;
			if (result.done) return;
			if (result.value) yield result.value;
		}
	}
}
