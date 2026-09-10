import { spawn } from "node:child_process";
import type { IngestLane } from "./delivery.js";

export class DiscordMirrorClient {
	private readonly fetchImpl: typeof fetch;

	constructor(
		private readonly options: {
			token: string;
			timeoutMs: number;
			fetchImpl?: typeof fetch;
		},
	) {
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	async post(
		channelId: string,
		text: string,
		nonce: string,
	): Promise<{ messageId: string }> {
		if (!text || Array.from(text).length > 2_000) {
			throw new Error("discord_mirror_content_invalid");
		}
		if (!/^[0-9a-z]{1,25}$/u.test(nonce)) {
			throw new Error("discord_mirror_nonce_invalid");
		}
		const response = await this.fetchImpl(
			`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
			{
				method: "POST",
				signal: AbortSignal.timeout(this.options.timeoutMs),
				headers: {
					Authorization: `Bot ${this.options.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					content: text,
					nonce,
					enforce_nonce: true,
					allowed_mentions: { parse: [] },
				}),
			},
		);
		if (!response.ok) throw new Error(`discord_mirror_http_${response.status}`);
		const body = (await response.json()) as { id?: unknown };
		if (typeof body.id !== "string" || !body.id) {
			throw new Error("discord_mirror_id_missing");
		}
		return { messageId: body.id };
	}
}

export type CommandRunner = (
	args: string[],
	stdin?: string,
) => Promise<{ stdout: string }>;

const runCommand: CommandRunner = (args, stdin) =>
	new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_096);
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve({ stdout });
			else
				reject(
					new Error(`flywheel_comm_exit_${code ?? signal}:${stderr.trim()}`),
				);
		});
		child.stdin.end(stdin);
	});

function json(stdout: string): Record<string, unknown> {
	const line = stdout.trim().split("\n").at(-1);
	if (!line) throw new Error("flywheel_comm_empty_output");
	return JSON.parse(line) as Record<string, unknown>;
}

export class FlywheelCommDelivery {
	private readonly run: CommandRunner;

	constructor(
		private readonly options: {
			cliPath: string;
			dbPath: string;
			founderUserId: string;
			run?: CommandRunner;
		},
	) {
		this.run = options.run ?? runCommand;
	}

	async ingest(input: {
		leadId: string;
		voiceSessionId: string;
		threadId: string;
		messageId: string;
		authorId: string;
		authorName: string;
		text: string;
		ts: string;
	}): Promise<{ lane: IngestLane; deliveryId: string }> {
		const result = json(
			(
				await this.run(
					[
						this.options.cliPath,
						"chat-ingest",
						"--db",
						this.options.dbPath,
						"--lead",
						input.leadId,
						"--chat-id",
						input.threadId,
						"--origin-channel-id",
						input.threadId,
						"--message-id",
						input.messageId,
						"--author-id",
						input.authorId,
						"--author-name",
						input.authorName,
						"--ts",
						input.ts,
						"--msg-kind",
						"guild",
						"--origin",
						"voice",
						"--voice-session",
						input.voiceSessionId,
						"--founder-id",
						this.options.founderUserId,
						"--reply-channel-id",
						input.threadId,
						"--content-stdin",
					],
					input.text,
				)
			).stdout,
		);
		if (
			typeof result.lane !== "string" ||
			typeof result.deliveryId !== "string"
		) {
			throw new Error("flywheel_comm_ingest_output_invalid");
		}
		return {
			lane: result.lane as IngestLane,
			deliveryId: result.deliveryId,
		};
	}

	async read(deliveryId: string): Promise<{
		origin: string;
		voiceSessionId: string;
		authorId: string;
		text: string;
	} | null> {
		let result: Record<string, unknown>;
		try {
			result = json(
				(
					await this.run([
						this.options.cliPath,
						"message-status",
						deliveryId,
						"--db",
						this.options.dbPath,
						"--json",
						"--with-envelope",
					])
				).stdout,
			);
		} catch {
			return null;
		}
		return typeof result.origin === "string" &&
			typeof result.voiceSessionId === "string" &&
			typeof result.authorId === "string" &&
			typeof result.text === "string"
			? {
					origin: result.origin,
					voiceSessionId: result.voiceSessionId,
					authorId: result.authorId,
					text: result.text,
				}
			: null;
	}
}
