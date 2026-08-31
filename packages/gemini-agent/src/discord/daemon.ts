/**
 * FLY-1018 M2 — Discord slash-command daemon (plan §3).
 *
 * A thin bot shell over runAgentSession:
 *   - the binding set IS the channel allowlist — interactions from
 *     unbound channels are refused ephemerally (the bot never talks in
 *     channels it was not explicitly configured for; never #core);
 *   - per-channel serial execution (in-memory mutex) — a second
 *     /gemini-advanced while one is running gets an ephemeral busy reply;
 *   - defer → ACK follow-up ("已受理") → final answer chunked at 2000
 *     chars; non-completed Terminals are reported honestly with the
 *     reason + sessionId (audit pointer), never swallowed;
 *   - retired by FLY-2105; config loading refuses every daemon start.
 *
 * The interaction handler + command-upsert helper are exported and tested
 * against structural mocks; only the discord.js login wiring in
 * runDaemon() is untested glue.
 */

import { type AgentConfig, ConfigError, loadAgentConfig } from "../config.js";
import {
	type AgentSessionOptions,
	runAgentSession,
	type SessionResult,
} from "../session.js";
import { type ChannelBinding, loadBindings } from "./bindings.js";
import { chunkMessage } from "./render.js";

export const COMMAND_NAME = "gemini-advanced";

/** The guild slash-command definition upserted at startup. */
export const COMMAND_DEFINITION = {
	name: COMMAND_NAME,
	description:
		"Ask the Gemini dispatch agent (file issues, dispatch runners, check status, memory)",
	options: [
		{
			type: 3, // STRING
			name: "instruction",
			description: "What you want done",
			required: true,
		},
	],
};

/** Structural slice of a discord.js ChatInputCommandInteraction. */
export interface SlashInteractionLike {
	channelId: string;
	commandName: string;
	options: { getString(name: string): string | null };
	deferReply(): Promise<unknown>;
	reply(opts: { content: string; ephemeral?: boolean }): Promise<unknown>;
	followUp(opts: { content: string }): Promise<unknown>;
}

export interface InteractionHandlerDeps {
	bindings: ChannelBinding[];
	config: AgentConfig;
	/** Injectable session runner (tests). */
	runSession?: (opts: AgentSessionOptions) => Promise<SessionResult>;
	/** Injectable session id source (tests). */
	newSessionId?: () => string;
}

export function createInteractionHandler(deps: InteractionHandlerDeps) {
	const byChannel = new Map(deps.bindings.map((b) => [b.channelId, b]));
	const busy = new Map<string, string>(); // channelId → running sessionId
	const runSession = deps.runSession ?? runAgentSession;
	const newSessionId =
		deps.newSessionId ?? (() => Math.random().toString(36).slice(2, 10));

	return async function handleInteraction(
		interaction: SlashInteractionLike,
	): Promise<void> {
		if (interaction.commandName !== COMMAND_NAME) return;

		// allowlist: no binding → ephemeral refusal (plan §3: 不在 allowlist
		// 的 interaction 一律拒)
		const binding = byChannel.get(interaction.channelId);
		if (!binding) {
			await interaction.reply({
				content: "This channel is not configured for /gemini-advanced.",
				ephemeral: true,
			});
			return;
		}

		// per-channel serial execution
		const running = busy.get(interaction.channelId);
		if (running) {
			await interaction.reply({
				content: `上一条还在跑(session ${running})— 请等它完成。`,
				ephemeral: true,
			});
			return;
		}

		const instruction = interaction.options.getString("instruction");
		if (!instruction || instruction.trim() === "") {
			await interaction.reply({
				content: "instruction is required.",
				ephemeral: true,
			});
			return;
		}

		const sessionId = newSessionId();
		busy.set(interaction.channelId, sessionId);
		try {
			await interaction.deferReply(); // 3-second window
			await interaction.followUp({
				content: `已受理,session ${sessionId}`,
			});

			const { terminal } = await runSession({
				config: deps.config,
				binding: {
					projectName: binding.projectName,
					leadId: binding.leadId,
					...(binding.deptLabel && { deptLabel: binding.deptLabel }),
				},
				userText: instruction,
				entry: "discord",
				identityPath: binding.identityPath,
				contextNote: binding.contextNote,
				sessionId,
			});

			if (terminal.reason === "completed") {
				const chunks = chunkMessage(terminal.finalText ?? "(empty answer)");
				for (const chunk of chunks) {
					await interaction.followUp({ content: chunk });
				}
			} else {
				// honest error reporting — reason + sessionId for audit lookup
				const detail = terminal.error
					? ` — ${terminal.error.kind}: ${terminal.error.message.slice(0, 300)}`
					: "";
				await interaction.followUp({
					content: `会话未完成(${terminal.reason})${detail}。审计:session ${sessionId}`,
				});
			}
		} catch (err) {
			// never leave the interaction hanging silently
			try {
				await interaction.followUp({
					content: `内部错误:${String((err as Error)?.message ?? err).slice(0, 300)}(session ${sessionId})`,
				});
			} catch {
				// followUp itself failed — nothing more we can do here
			}
		} finally {
			busy.delete(interaction.channelId);
		}
	};
}

/** Structural slice of discord.js REST for command upsert. */
export interface RestLike {
	put(route: string, opts: { body: unknown }): Promise<unknown>;
}

/**
 * Upsert the guild command for every guild the bindings live in.
 * Guild-scoped on purpose (instant propagation + never global — the bot
 * only exists where it was explicitly configured).
 */
export async function upsertGuildCommands(
	rest: RestLike,
	applicationId: string,
	guildIds: string[],
): Promise<void> {
	for (const guildId of [...new Set(guildIds)]) {
		await rest.put(
			`/applications/${applicationId}/guilds/${guildId}/commands`,
			{ body: [COMMAND_DEFINITION] },
		);
	}
}

/** Daemon entry — real discord.js wiring (untested glue; logic above is tested). */
export async function runDaemon(): Promise<number> {
	let config: AgentConfig;
	try {
		config = loadAgentConfig();
	} catch (err) {
		if (err instanceof ConfigError) {
			console.error(`config_error: ${err.message}`);
			return 2;
		}
		throw err;
	}
	const botToken = process.env.FLYWHEEL_GEMINI_AGENT_DISCORD_TOKEN?.trim();
	if (!botToken) {
		console.error(
			"config_error: FLYWHEEL_GEMINI_AGENT_DISCORD_TOKEN is required for the daemon",
		);
		return 2;
	}
	let bindings: ChannelBinding[];
	try {
		bindings = loadBindings();
	} catch (err) {
		if (err instanceof ConfigError) {
			console.error(`config_error: ${err.message}`);
			return 2;
		}
		throw err;
	}

	const { Client, GatewayIntentBits, REST } = await import("discord.js");
	const client = new Client({ intents: [GatewayIntentBits.Guilds] });
	const handler = createInteractionHandler({ bindings, config });

	client.on("interactionCreate", (interaction) => {
		if (!interaction.isChatInputCommand()) return;
		void handler(interaction as unknown as SlashInteractionLike);
	});

	await client.login(botToken);
	const applicationId = client.application?.id ?? client.user?.id;
	if (!applicationId) {
		console.error("daemon: could not resolve application id after login");
		return 1;
	}

	// derive guild ids from the bound channels
	const guildIds: string[] = [];
	for (const b of bindings) {
		try {
			const channel = await client.channels.fetch(b.channelId);
			const guildId = (channel as { guildId?: string } | null)?.guildId;
			if (guildId) guildIds.push(guildId);
			else
				console.error(
					`daemon: channel ${b.channelId} has no guild — binding skipped for command registration`,
				);
		} catch (err) {
			console.error(
				`daemon: cannot fetch bound channel ${b.channelId}: ${(err as Error).message}`,
			);
		}
	}
	const rest = new REST({ version: "10" }).setToken(botToken);
	await upsertGuildCommands(
		{
			put: (route, opts) => rest.put(route as never, opts),
		},
		applicationId,
		guildIds,
	);

	console.error(
		`[gemini-agent daemon] up — ${bindings.length} channel binding(s), ${new Set(guildIds).size} guild(s), model ${config.model}`,
	);
	// keep the process alive until SIGINT
	await new Promise<void>((resolve) => {
		process.on("SIGINT", () => resolve());
		process.on("SIGTERM", () => resolve());
	});
	await client.destroy();
	return 0;
}
