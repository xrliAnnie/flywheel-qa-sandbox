import { type ChildProcess, execFile } from "node:child_process";

const INTENT_ID = /^[0-9a-f]{64}$/;
const SAFE_RECEIPT =
	/^(?:sent channel_id=[0-9]{17,20} binding_digest=[0-9a-f]{64} message_id=[0-9]{17,20}|(?:duplicate|queued_transient|delivery_unknown|dead_lettered|config_error) channel_id=[0-9]{17,20} binding_digest=[0-9a-f]{64}|config_error)$/;
const MAX_QUEUE = 16;

interface VoiceHealthAlertExecOptions {
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
	retryDelayMs?: number;
	onUnavailable?: (signal: {
		reasonClass: "health_observation_unavailable";
		operation: "health_store";
	}) => void;
}

function defaultExecFile(
	file: string,
	args: string[],
	options: VoiceHealthAlertExecOptions,
	callback: (error: Error | null, stdout: string, stderr: string) => void,
): ChildProcess {
	return execFile(file, args, options, callback);
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

	constructor(private readonly options: VoiceHealthAlertDispatcherOptions) {
		this.run = options.execFile ?? defaultExecFile;
	}

	notify(intentId: string): void {
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
			if (this.queue.length > 0) this.kick();
		}
	}

	private scheduleRetry(intentId: string): void {
		const delayMs = Math.max(
			0,
			Math.min(this.options.retryDelayMs ?? 30_000, 30_000),
		);
		const timer = setTimeout(() => {
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
				this.run(
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
