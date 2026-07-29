#!/usr/bin/env node

import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { CodexDiscordGateway } from "./lead-backends/codex/CodexDiscordGateway.js";
import { FileInboundCursorStore } from "./lead-backends/codex/InboundCursorStore.js";
import { RestPollDiscordInboundSource } from "./lead-backends/codex/RestPollDiscordInboundSource.js";
import { V2DiscordIngress } from "./lead-backends/codex/V2DiscordIngress.js";

export interface V2DiscordIngressConfig {
	v2CliBin: string;
	socketPath: string;
	secretPath: string;
	leadId: string;
	botToken: string;
	botUserId: string;
	channelIds: string[];
	cursorPath: string;
}

function required(
	env: Record<string, string | undefined>,
	name: string,
): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function absolute(
	env: Record<string, string | undefined>,
	name: string,
): string {
	const value = required(env, name);
	if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
	return value;
}

export function readV2DiscordIngressConfig(
	env: Record<string, string | undefined> = process.env,
): V2DiscordIngressConfig {
	const channelIds = [
		required(env, "FLYWHEEL_LEAD_CHAT_CHANNEL_ID"),
		env.FLYWHEEL_LEAD_CORE_CHANNEL_ID?.trim(),
	].filter((value): value is string => Boolean(value));
	return {
		v2CliBin: env.FLYWHEEL_V2_CLI_BIN?.trim() || "flywheel-v2",
		socketPath: absolute(env, "FLYWHEEL_V2_HOST_SOCKET"),
		secretPath: absolute(env, "FLYWHEEL_V2_HOST_SECRET"),
		leadId: required(env, "FLYWHEEL_V2_LEAD_ID"),
		botToken: required(env, "FLYWHEEL_LEAD_BOT_TOKEN"),
		botUserId: required(env, "FLYWHEEL_LEAD_BOT_USER_ID"),
		channelIds: [...new Set(channelIds)],
		cursorPath: absolute(env, "FLYWHEEL_V2_INBOUND_CURSOR"),
	};
}

export async function main(
	env: Record<string, string | undefined> = process.env,
): Promise<number> {
	const config = readV2DiscordIngressConfig(env);
	const source = new RestPollDiscordInboundSource({
		botToken: config.botToken,
		channelIds: config.channelIds,
		cursorStore: new FileInboundCursorStore(config.cursorPath),
		logger: console,
	});
	const gateway = new CodexDiscordGateway({
		source,
		router: new V2DiscordIngress({
			v2CliBin: config.v2CliBin,
			socketPath: config.socketPath,
			secretPath: config.secretPath,
			leadId: config.leadId,
		}),
		botUserId: config.botUserId,
		channelIds: config.channelIds,
		logger: console,
	});
	await gateway.start();
	process.stdout.write(
		`${JSON.stringify({
			status: "ready",
			mode: "v2-only",
			leadId: config.leadId,
			channelIds: config.channelIds,
		})}\n`,
	);
	await new Promise<void>((resolve) => {
		process.once("SIGINT", resolve);
		process.once("SIGTERM", resolve);
	});
	await gateway.stop();
	return 0;
}

const invokedPath = process.argv[1]
	? pathToFileURL(process.argv[1]).href
	: undefined;
if (invokedPath === import.meta.url) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			process.stderr.write(
				`v2-discord-ingress: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			process.exitCode = 1;
		});
}
