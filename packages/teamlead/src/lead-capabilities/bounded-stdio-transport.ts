import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	type JSONRPCMessage,
	JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";

export interface PinnedStdioLaunch {
	command: string;
	args: readonly string[];
	env: Readonly<Record<string, string>>;
	cwd: string;
}
/** Parent-owned MCP process with bounded frames, exact environment and process-group cleanup. */
export class BoundedStdioTransport implements Transport {
	onclose?: Transport["onclose"];
	onerror?: Transport["onerror"];
	onmessage?: Transport["onmessage"];
	private child?: ChildProcessWithoutNullStreams;
	private buffer = Buffer.alloc(0);
	private started = false;
	private closed = false;
	private closing?: Promise<void>;
	private readonly launch: PinnedStdioLaunch;
	constructor(
		launch: PinnedStdioLaunch,
		private readonly options: {
			errorCode: string;
			observe?: (stream: "stdout" | "stderr", chunk: Buffer) => void;
		},
	) {
		if (
			!isAbsolute(launch.command) ||
			!isAbsolute(launch.cwd) ||
			Object.values(launch.env).some(
				(value) => typeof value !== "string" || value.includes("\0"),
			)
		)
			throw new Error("stdio_transport_configuration_invalid");
		this.launch = { ...launch, args: [...launch.args], env: { ...launch.env } };
	}
	private lost() {
		return new Error(this.options.errorCode);
	}

	get pid(): number | null {
		return this.child?.pid ?? null;
	}
	async start(): Promise<void> {
		if (this.started || this.closed) throw this.lost();
		this.started = true;
		const child = spawn(this.launch.command, [...this.launch.args], {
			env: { ...this.launch.env },
			cwd: this.launch.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			detached: true,
		});
		this.child = child;
		// Diagnostics remain parent-only; observers retain counters, never raw output.
		child.stderr.on("data", (chunk: Buffer) =>
			this.options.observe?.("stderr", chunk),
		);
		child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
		child.stdout.on("error", () => this.fail());
		child.stdin.on("error", () => this.fail());
		child.once("close", () => {
			this.notifyClosed();
			void this.close();
		});
		await new Promise<void>((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", () => {
				reject(this.lost());
				this.fail();
			});
		});
	}
	private read(chunk: Buffer) {
		if (this.closed) return;
		this.options.observe?.("stdout", chunk);
		if (this.buffer.length + chunk.length > 4 * 1024 * 1024) {
			this.fail();
			return;
		}
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (!this.closed) {
			const end = this.buffer.indexOf(10);
			if (end < 0) return;
			const line = this.buffer.subarray(0, end);
			this.buffer = this.buffer.subarray(end + 1);
			try {
				const decoded = new TextDecoder("utf-8", { fatal: true }).decode(line);
				const message = JSONRPCMessageSchema.parse(JSON.parse(decoded));
				this.onmessage?.(message);
			} catch {
				this.fail();
				return;
			}
		}
	}
	async send(message: JSONRPCMessage): Promise<void> {
		const child = this.child;
		if (!child || this.closed) throw this.lost();
		const text = JSON.stringify(message);
		if (Buffer.byteLength(text) > 65536)
			throw new Error("stdio_request_too_large");
		await new Promise<void>((resolve, reject) =>
			child.stdin.write(`${text}\n`, (err) =>
				err ? reject(this.lost()) : resolve(),
			),
		);
	}
	private notifyClosed() {
		if (this.closed) return;
		this.closed = true;
		this.buffer = Buffer.alloc(0);
		this.onclose?.();
	}
	private fail() {
		if (this.closed) return;
		this.onerror?.(this.lost());
		this.notifyClosed();
		void this.close();
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.notifyClosed();
		const child = this.child;
		this.child = undefined;
		this.closing = (async () => {
			if (!child) return;
			child.stdin.end();
			const pid = child.pid;
			// Only this owned process group is eligible for cleanup.
			const signalGroup = (signal: NodeJS.Signals) => {
				if (pid)
					try {
						process.kill(-pid, signal);
					} catch {
						/* already gone */
					}
			};
			if (child.exitCode === null && child.signalCode === null) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(() => {
						signalGroup("SIGTERM");
						resolve();
					}, 1000);
					child.once("close", () => {
						clearTimeout(timer);
						resolve();
					});
				});
			}
			signalGroup("SIGTERM");
			// A crashed MCP may leave helpers alive after its own exit.
			const groupAlive = () => {
				if (!pid) return false;
				try {
					process.kill(-pid, 0);
					return true;
				} catch {
					return false;
				}
			};
			if (groupAlive()) {
				await new Promise<void>((resolve) => setTimeout(resolve, 250));
				if (groupAlive()) signalGroup("SIGKILL");
			}
		})();
		return this.closing;
	}
}
