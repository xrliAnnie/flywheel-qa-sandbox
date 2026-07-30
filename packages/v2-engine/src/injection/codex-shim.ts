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

function deliveredCorrelationExists(
	result: unknown,
	clientUserMessageId: string,
): boolean {
	if (typeof result !== "object" || result === null || Array.isArray(result)) {
		throw new Error("Codex thread/read returned an ambiguous result");
	}
	const root = result as {
		thread?: { turns?: unknown };
		turns?: unknown;
	};
	const turns = root.thread?.turns ?? root.turns;
	if (!Array.isArray(turns)) {
		throw new Error("Codex thread/read returned no durable turns array");
	}
	for (const value of turns) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			continue;
		}
		const turn = value as { items?: unknown; input?: unknown };
		const items = [
			...(Array.isArray(turn.items) ? turn.items : []),
			...(Array.isArray(turn.input) ? turn.input : []),
		];
		if (
			items.some(
				(item) =>
					typeof item === "object" &&
					item !== null &&
					!Array.isArray(item) &&
					((item as { clientUserMessageId?: unknown }).clientUserMessageId ===
						clientUserMessageId ||
						(item as { clientId?: unknown }).clientId === clientUserMessageId),
			)
		) {
			return true;
		}
	}
	return false;
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
			const existing = await client.readThread(
				target.threadId,
				this.rpcTimeoutMs,
			);
			// Codex R4 MEDIUM-6: correlate on message AND processing attempt, the
			// same key the Claude sidecar uses (FLY-1503 item 10).
			//
			// Deduping on messageUid alone cancelled the redelivery semantics this PR
			// introduced. After a crash the same message is delivered again on a NEW
			// attempt uid; the shim would have found attempt A's correlation, skipped
			// turn/start and resolved, so the host recorded attempt B's delivery as
			// succeeded while the runner never received B's envelope or capability --
			// and the processing attempt wedged again, which is the exact failure the
			// PR exists to fix.
			const deliveryId = `${message.messageUid}:${message.attemptUid}`;
			if (!deliveredCorrelationExists(existing, deliveryId)) {
				await client.startTurn(
					target.threadId,
					encodeInjectionEnvelope(message),
					this.rpcTimeoutMs,
					deliveryId,
				);
			}
		} finally {
			if (client) {
				client.close();
			} else {
				transport.close();
			}
		}
	}
}
