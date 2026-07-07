/** Test doubles for the injectable process seam + voice engines. */
import type { AudioPlayer, Playback } from "../audio/FilePlayer.js";
import {
	AbortError,
	type ProcessHandle,
	type ProcessRunner,
	type RunOptions,
	type RunResult,
	type SpawnOptions,
	TimeoutError,
} from "../process.js";
import type { AudioFormat, BrainAdapter, TtsEngine, Turn } from "../types.js";

export class FakeProcessHandle implements ProcessHandle {
	pid: number | undefined = 4242;
	killedWith?: NodeJS.Signals;
	written: string[] = [];
	ended = false;
	private stdoutCbs: ((c: Buffer) => void)[] = [];
	private exitCbs: ((
		code: number | null,
		sig: NodeJS.Signals | null,
	) => void)[] = [];

	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		this.killedWith = signal;
	}
	onStdout(cb: (chunk: Buffer) => void): void {
		this.stdoutCbs.push(cb);
	}
	onExit(cb: (code: number | null, sig: NodeJS.Signals | null) => void): void {
		this.exitCbs.push(cb);
	}
	write(data: Buffer | string): void {
		this.written.push(String(data));
	}
	end(data?: Buffer | string): void {
		if (data !== undefined) this.written.push(String(data));
		this.ended = true;
	}
	// ---- test drivers ----
	emitStdout(s: string | Buffer): void {
		const buf = Buffer.isBuffer(s) ? s : Buffer.from(s);
		for (const cb of [...this.stdoutCbs]) cb(buf);
	}
	emitExit(code: number | null = 0, sig: NodeJS.Signals | null = null): void {
		for (const cb of [...this.exitCbs]) cb(code, sig);
	}
}

export class FakeProcessRunner implements ProcessRunner {
	runCalls: { cmd: string; args: string[]; opts?: RunOptions }[] = [];
	spawnCalls: { cmd: string; args: string[]; opts?: SpawnOptions }[] = [];
	handles: FakeProcessHandle[] = [];

	constructor(
		private readonly runFn?: (
			cmd: string,
			args: string[],
			opts?: RunOptions,
		) => Promise<RunResult>,
		private readonly spawnFn?: (
			h: FakeProcessHandle,
			cmd: string,
			args: string[],
		) => void,
	) {}

	run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> {
		this.runCalls.push({ cmd, args, opts });
		if (this.runFn) return this.runFn(cmd, args, opts);
		return Promise.resolve({ stdout: Buffer.from(""), stderr: "", code: 0 });
	}

	spawn(cmd: string, args: string[], opts?: SpawnOptions): ProcessHandle {
		const h = new FakeProcessHandle();
		this.spawnCalls.push({ cmd, args, opts });
		this.handles.push(h);
		this.spawnFn?.(h, cmd, args);
		return h;
	}
}

/** run() that rejects with AbortError the moment its signal aborts. */
export function abortAwareRun(result?: RunResult) {
	return (
		_cmd: string,
		_args: string[],
		opts?: RunOptions,
	): Promise<RunResult> =>
		new Promise((resolve, reject) => {
			if (opts?.signal?.aborted) return reject(new AbortError());
			opts?.signal?.addEventListener("abort", () => reject(new AbortError()));
			if (result) setTimeout(() => resolve(result), 0);
		});
}

export function timeoutRun() {
	return (_c: string, _a: string[], opts?: RunOptions): Promise<RunResult> =>
		Promise.reject(new TimeoutError(opts?.timeoutMs ?? 1000));
}

// ---- engine / player fakes ----

export class FakeTts implements TtsEngine {
	synthesizeCalls: string[] = [];
	constructor(
		private readonly audio: Buffer = Buffer.from("MP3DATA"),
		private readonly opts: {
			ttsFirstByteMs?: number;
			throwErr?: unknown;
			hangUntilAbort?: boolean;
			/** actually wait this long (real clock) — simulates non-trivial synth time. */
			realDelayMs?: number;
		} = {},
	) {}
	async synthesize(
		text: string,
		_voice: string,
		o: { signal: AbortSignal },
	): Promise<{ audio: Buffer; format: AudioFormat; ttsFirstByteMs: number }> {
		this.synthesizeCalls.push(text);
		if (this.opts.throwErr) throw this.opts.throwErr;
		if (this.opts.hangUntilAbort) {
			await new Promise<void>((_res, rej) => {
				o.signal.addEventListener("abort", () => rej(new AbortError()));
			});
		}
		if (this.opts.realDelayMs) {
			await new Promise((r) => setTimeout(r, this.opts.realDelayMs));
		}
		return {
			audio: this.audio,
			format: { encoding: "mp3", sampleRateHz: 24_000, channels: 1 },
			ttsFirstByteMs: this.opts.ttsFirstByteMs ?? 5,
		};
	}
}

/** AudioPlayer whose playback completes immediately or on manual interrupt. */
export class FakeAudioPlayer implements AudioPlayer {
	playCount = 0;
	interrupted = false;
	private resolveDone?: (v: { interrupted: boolean }) => void;
	constructor(private readonly mode: "immediate" | "manual" = "immediate") {}
	play(_audio: Buffer, _format: AudioFormat): Playback {
		this.playCount++;
		let resolveDone!: (v: { interrupted: boolean }) => void;
		const done = new Promise<{ interrupted: boolean }>((r) => {
			resolveDone = r;
		});
		this.resolveDone = resolveDone;
		if (this.mode === "immediate") resolveDone({ interrupted: false });
		return {
			spawnMs: 3,
			done,
			interrupt: () => {
				this.interrupted = true;
				this.resolveDone?.({ interrupted: true });
			},
		};
	}
}

/** Brain that yields the given chunks; optionally hangs until aborted. */
export class FakeBrain implements BrainAdapter {
	lastHistory?: Turn[];
	constructor(
		private readonly chunks: string[],
		private readonly opts: {
			hangUntilAbort?: boolean;
			throwErr?: unknown;
		} = {},
	) {}
	async *respond(
		turn: { text: string; history: Turn[] },
		o: { signal: AbortSignal },
	): AsyncIterable<string> {
		this.lastHistory = turn.history;
		if (this.opts.throwErr) throw this.opts.throwErr;
		for (const c of this.chunks) yield c;
		if (this.opts.hangUntilAbort) {
			await new Promise<void>((_res, rej) => {
				o.signal.addEventListener("abort", () => rej(new AbortError()));
			});
		}
	}
}
