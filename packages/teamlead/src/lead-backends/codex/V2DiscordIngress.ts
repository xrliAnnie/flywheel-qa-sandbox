import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

export interface V2DiscordEnqueueInput {
	idempotencyKey: string;
	source: "discord" | "mailbox";
	payload: string;
	replyChannelId?: string;
}

export interface V2DiscordIngressOptions {
	v2CliBin: string;
	socketPath: string;
	secretPath: string;
	leadId: string;
	run?: typeof spawnSync;
}

interface EnqueueReceipt {
	status?: unknown;
	messageUid?: unknown;
}

export class V2DiscordIngress {
	private readonly run: typeof spawnSync;

	constructor(private readonly options: V2DiscordIngressOptions) {
		if (!options.v2CliBin.trim()) {
			throw new TypeError("v2CliBin must not be empty");
		}
		if (!isAbsolute(options.socketPath) || !isAbsolute(options.secretPath)) {
			throw new TypeError("v2 Discord ingress paths must be absolute");
		}
		if (!options.leadId.trim()) {
			throw new TypeError("leadId must not be empty");
		}
		this.run = options.run ?? spawnSync;
	}

	submit(input: V2DiscordEnqueueInput): {
		accepted: boolean;
		entryId: string;
	} {
		if (input.source !== "discord") {
			throw new TypeError("v2 Discord ingress accepts Discord inputs only");
		}
		const result = this.run(
			this.options.v2CliBin,
			[
				"enqueue",
				"--socket",
				this.options.socketPath,
				"--secret",
				this.options.secretPath,
				"--source-kind",
				"discord",
				"--source-id",
				input.idempotencyKey,
				"--payload",
				input.payload,
				"--to-agent",
				this.options.leadId,
				"--kind",
				"instruction",
				"--retention",
				"business",
			],
			{
				encoding: "utf8",
				timeout: 10_000,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		if (result.status !== 0) {
			throw new Error(
				`v2 Discord enqueue failed: ${result.stderr || result.error?.message || `exit ${result.status}`}`,
			);
		}
		let receipt: EnqueueReceipt;
		try {
			receipt = JSON.parse(result.stdout || "{}") as EnqueueReceipt;
		} catch {
			throw new Error("v2 Discord enqueue returned malformed JSON");
		}
		if (
			(receipt.status !== "enqueued" && receipt.status !== "duplicate") ||
			typeof receipt.messageUid !== "string"
		) {
			throw new Error(
				`v2 Discord enqueue was rejected: ${JSON.stringify(receipt)}`,
			);
		}
		return {
			accepted: receipt.status === "enqueued",
			entryId: receipt.messageUid,
		};
	}
}
