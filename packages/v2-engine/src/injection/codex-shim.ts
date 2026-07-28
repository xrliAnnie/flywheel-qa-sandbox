import {
	CodexDaemonClient,
	type ConnectDaemonTransportOptions,
	connectDaemonTransport,
	type DaemonTransport,
} from "flywheel-claude-runner";
import type { InjectionShim } from "../types.js";
import { encodeInjectionEnvelope } from "./envelope.js";
import {
	type CodexInjectionSessionRef,
	parseCodexSessionRef,
} from "./session-ref.js";

export type { CodexInjectionSessionRef };

type ConnectDaemon = (
	options: ConnectDaemonTransportOptions,
) => Promise<DaemonTransport>;

export interface CodexInjectionShimOptions {
	connect?: ConnectDaemon;
	connectTimeoutMs?: number;
	rpcTimeoutMs?: number;
}

function boundedTimeout(value: number | undefined, fallback: number): number {
	const resolved = value ?? fallback;
	if (
		!Number.isFinite(resolved) ||
		!Number.isInteger(resolved) ||
		resolved <= 0 ||
		resolved > 5 * 60_000
	) {
		throw new TypeError("Codex injection timeout must be 1..300000ms");
	}
	return resolved;
}

export class CodexInjectionShim implements InjectionShim {
	private readonly connect: ConnectDaemon;
	private readonly connectTimeoutMs: number;
	private readonly rpcTimeoutMs: number;

	constructor(options: CodexInjectionShimOptions = {}) {
		this.connect = options.connect ?? connectDaemonTransport;
		this.connectTimeoutMs = boundedTimeout(options.connectTimeoutMs, 10_000);
		this.rpcTimeoutMs = boundedTimeout(options.rpcTimeoutMs, 30_000);
	}

	async hint(sessionRef: string): Promise<void> {
		parseCodexSessionRef(sessionRef);
	}

	async deliver(
		sessionRef: string,
		message: Parameters<InjectionShim["deliver"]>[1],
	): Promise<void> {
		const target = parseCodexSessionRef(sessionRef);
		const transport = await this.connect({
			socketPath: target.socketPath,
			connectTimeoutMs: this.connectTimeoutMs,
		});
		let client: CodexDaemonClient | undefined;
		try {
			client = new CodexDaemonClient({
				transport,
				requestTimeoutMs: this.rpcTimeoutMs,
				clientName: "flywheel-v2-injection",
			});
			await client.initialize();
			await client.startTurn(
				target.threadId,
				encodeInjectionEnvelope(message),
				this.rpcTimeoutMs,
			);
		} finally {
			if (client) {
				client.close();
			} else {
				transport.close();
			}
		}
	}
}
