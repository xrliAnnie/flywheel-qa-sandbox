import { type ChildProcess, spawn } from "node:child_process";

const INTENT_ID = /^[0-9a-f]{64}$/;
const SAFE_RECEIPT =
	/^(?:sent channel_id=[0-9]{17,20} binding_digest=[0-9a-f]{64} message_id=[0-9]{17,20}|(?:duplicate|queued_transient|delivery_unknown|dead_lettered|config_error) channel_id=[0-9]{17,20} binding_digest=[0-9a-f]{64}|config_error)$/;
const MAX_QUEUE = 16;
/** How long a stopped sender gets to exit on SIGTERM before SIGKILL. */
const SENDER_STOP_MS = 2_000;

interface VoiceHealthAlertExecOptions {
	/** Its own process group, so shutdown can stop bash and its curl alike. */
	detached: true;
	encoding: "utf8";
	maxBuffer: number;
	shell: false;
	timeout: number;
	windowsHide: true;
}

export type VoiceHealthAlertExecFile = (
	file: string,
	args: string[],
	options: VoiceHealthAlertExecOptions,
	callback: (error: Error | null, stdout: string, stderr: string) => void,
) => ChildProcess;

export interface VoiceHealthAlertDispatcherOptions {
	leadAlertPath: string;
	execFile?: VoiceHealthAlertExecFile;
	/** Tests only: signal a sender's process group. */
	killGroup?: (pid: number, signal: NodeJS.Signals) => void;
	retryDelayMs?: number;
	onUnavailable?: (signal: {
		reasonClass: "health_observation_unavailable";
		operation: "health_store";
	}) => void;
}

/** Waits for `promise` at most `ms`; never rejects. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		promise.catch(() => undefined),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, ms);
			timer.unref?.();
		}),
	]);
	if (timer) clearTimeout(timer);
}

/**
 * execFile semantics (utf8 output, maxBuffer, timeout) on spawn: execFile
 * drops `detached`, and the sender must lead its own process group so
 * shutdown can stop bash together with the curl it waits on.
 */
function defaultExecFile(
	file: string,
	args: string[],
	options: VoiceHealthAlertExecOptions,
	callback: (error: Error | null, stdout: string, stderr: string) => void,
): ChildProcess {
	const child = spawn(file, args, {
		detached: options.detached,
		shell: options.shell,
		windowsHide: options.windowsHide,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let settled = false;
	const stopGroup = () => {
		try {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
		} catch {
			// Already gone.
		}
	};
	const done = (error: Error | null) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		callback(error, stdout, stderr);
	};
	const collect = (stream: "stdout" | "stderr") => (chunk: string) => {
		if (stream === "stdout") stdout += chunk;
		else stderr += chunk;
		if (
			Buffer.byteLength(stdout, "utf8") > options.maxBuffer ||
			Buffer.byteLength(stderr, "utf8") > options.maxBuffer
		) {
			stopGroup();
			done(new Error("maxBuffer exceeded"));
		}
	};
	child.stdout?.setEncoding(options.encoding);
	child.stderr?.setEncoding(options.encoding);
	child.stdout?.on("data", collect("stdout"));
	child.stderr?.on("data", collect("stderr"));
	const timer = setTimeout(() => {
		stopGroup();
		done(new Error("timed out"));
	}, options.timeout);
	child.once("error", (error) => done(error));
	child.once("close", () => done(null));
	return child;
}

/**
 * Nonblocking, single-flight bridge from source notification ids to the
 * source-validating shell sender. The shell/helper own delivery state.
 */
export class VoiceHealthAlertDispatcher {
	private readonly run: VoiceHealthAlertExecFile;
	private readonly queue: string[] = [];
	private readonly pending = new Set<string>();
	private running = false;
	private settlers: Array<() => void> = [];
	/** The sender now running, stopped if shutdown outlasts its bound. */
	private current?: ChildProcess;
	private currentExited?: Promise<void>;
	private closed = false;

	constructor(private readonly options: VoiceHealthAlertDispatcherOptions) {
		this.run = options.execFile ?? defaultExecFile;
	}

	notify(intentId: string): void {
		if (this.closed) return;
		if (!INTENT_ID.test(intentId)) {
			this.signalUnavailable();
			return;
		}
		if (this.pending.has(intentId)) return;
		if (this.queue.length >= MAX_QUEUE) {
			this.signalUnavailable();
			return;
		}
		this.pending.add(intentId);
		this.queue.push(intentId);
		this.kick();
	}

	/**
	 * FLY-2885 QA@1: daemon shutdown. Alerts already queued get up to
	 * timeoutMs to be delivered; a sender still running then is stopped so no
	 * shell outlives the daemon's bounded exit. True when everything settled.
	 */
	async shutdown(timeoutMs: number): Promise<boolean> {
		this.closed = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const drained = await Promise.race([
			this.whenSettled().then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
				timer.unref?.();
			}),
		]);
		if (timer) clearTimeout(timer);
		if (!drained) {
			this.queue.length = 0;
			await this.stopSender();
		}
		return drained;
	}

	/** Forced exit: stop the sender's whole process group right now. */
	killNow(): void {
		this.signalSender("SIGKILL");
	}

	/** SIGTERM the sender's group, wait for it, then SIGKILL what is left. */
	private async stopSender(): Promise<void> {
		const exited = this.currentExited;
		if (!exited) return;
		this.signalSender("SIGTERM");
		await within(exited, SENDER_STOP_MS);
		// bash may be gone while its curl lives on: the group goes either way.
		this.signalSender("SIGKILL");
		await within(exited, SENDER_STOP_MS);
	}

	private signalSender(signal: NodeJS.Signals): void {
		const pid = this.current?.pid;
		if (pid === undefined) return;
		try {
			(this.options.killGroup ?? ((group, sig) => process.kill(-group, sig)))(
				pid,
				signal,
			);
		} catch {
			// The group is already gone.
		}
	}

	whenSettled(): Promise<void> {
		if (!this.running && this.queue.length === 0) return Promise.resolve();
		return new Promise((resolve) => this.settlers.push(resolve));
	}

	private kick(): void {
		if (this.running) return;
		this.running = true;
		void this.drain();
	}

	private async drain(): Promise<void> {
		try {
			while (this.queue.length > 0) {
				const intentId = this.queue[0]!;
				const outcome = await this.dispatch(intentId);
				if (outcome === "invalid") this.signalUnavailable();
				this.queue.shift();
				if (outcome === "settled") this.pending.delete(intentId);
				else this.scheduleRetry(intentId);
			}
		} finally {
			this.running = false;
			const settlers = this.settlers.splice(0);
			for (const settle of settlers) settle();
			if (this.queue.length > 0 && !this.closed) this.kick();
		}
	}

	private scheduleRetry(intentId: string): void {
		const delayMs = Math.max(
			0,
			Math.min(this.options.retryDelayMs ?? 30_000, 30_000),
		);
		const timer = setTimeout(() => {
			if (this.closed) return;
			if (this.queue.length >= MAX_QUEUE) {
				this.signalUnavailable();
				this.scheduleRetry(intentId);
				return;
			}
			this.queue.push(intentId);
			this.kick();
		}, delayMs);
		timer.unref?.();
	}

	private dispatch(intentId: string): Promise<"settled" | "retry" | "invalid"> {
		return new Promise((resolve) => {
			let settled = false;
			const finish = (outcome: "settled" | "retry" | "invalid") => {
				if (settled) return;
				settled = true;
				resolve(outcome);
			};
			try {
				const child = this.run(
					"/bin/bash",
					[
						this.options.leadAlertPath,
						"--project",
						"flywheel",
						"--lead",
						"voice-health",
						"--kind",
						"voice_daemon_unhealthy",
						"--severity",
						"warning",
						"--voice-intent",
						intentId,
						"--strict-delivery",
					],
					{
						detached: true,
						encoding: "utf8",
						maxBuffer: 4096,
						shell: false,
						timeout: 30_000,
						windowsHide: true,
					},
					(_error, stdout) => {
						const receipt = stdout.trim();
						if (
							Buffer.byteLength(receipt, "utf8") > 512 ||
							!SAFE_RECEIPT.test(receipt)
						) {
							finish("invalid");
							return;
						}
						const status = receipt.split(" ", 1)[0];
						finish(
							status === "queued_transient" || status === "config_error"
								? "retry"
								: "settled",
						);
					},
				);
				this.current = child;
				this.currentExited = new Promise<void>((resolve) => {
					if (typeof child?.once !== "function") return resolve();
					child.once("close", () => resolve());
					child.once("error", () => resolve());
				}).then(() => {
					if (this.current === child) {
						this.current = undefined;
						this.currentExited = undefined;
					}
				});
			} catch {
				finish("invalid");
			}
		});
	}

	private signalUnavailable(): void {
		try {
			this.options.onUnavailable?.({
				reasonClass: "health_observation_unavailable",
				operation: "health_store",
			});
		} catch {
			// Alert diagnostics must not block lease or session work.
		}
	}
}
