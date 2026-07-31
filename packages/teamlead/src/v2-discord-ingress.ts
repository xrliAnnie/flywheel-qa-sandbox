#!/usr/bin/env node

import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { archiveChatThread } from "./bridge/chat-thread-utils.js";
import { CodexDiscordGateway } from "./lead-backends/codex/CodexDiscordGateway.js";
import { FileInboundCursorStore } from "./lead-backends/codex/InboundCursorStore.js";
import { RestPollDiscordInboundSource } from "./lead-backends/codex/RestPollDiscordInboundSource.js";
import { V2DiscordIngress } from "./lead-backends/codex/V2DiscordIngress.js";
import { V2DiscordOutbound } from "./v2-discord-outbound.js";
import { V2DisplayRefresher } from "./v2-display-refresher.js";
import { openV2DisplayReader } from "./v2-display-state-reader.js";

export interface V2DiscordIngressConfig {
	v2CliBin: string;
	socketPath: string;
	secretPath: string;
	leadId: string;
	botToken: string;
	botUserId: string;
	channelIds: string[];
	cursorPath: string;
	/** FLY-1544 ③: outbound messenger (register-lead evidence + thread state). */
	hostEpoch: string;
	sessionProofRoot: string;
	outboundStatePath: string;
	/** FLY-1549: display refresh ON unless FLYWHEEL_V2_ISSUE_DISPLAY=0. */
	issueDisplayEnabled: boolean;
	/**
	 * The v2 kernel db for read-only display derivation. EXPLICIT — never
	 * defaulted (Codex design R1 #1): the host's real db is its own required
	 * `--db`, and deriving a display from a different-but-valid file would
	 * confirm wrong fingerprints. Unset while display is enabled → display
	 * stays OFF with a loud startup error.
	 */
	kernelDbPath: string | undefined;
	/** Sweep cadence ms; 0 disables. Default 180000. */
	displaySweepMs: number;
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
		// FLY-1544 ③: the ingress is now the BIDIRECTIONAL Discord messenger;
		// the outbound half registers as the `discord-messenger` lead recipient
		// and needs live-session evidence (the host's proof root + epoch) plus a
		// durable issue→thread state file.
		hostEpoch: required(env, "FLYWHEEL_V2_HOST_EPOCH"),
		sessionProofRoot: absolute(env, "FLYWHEEL_V2_SESSION_PROOF_ROOT"),
		outboundStatePath: absolute(env, "FLYWHEEL_V2_OUTBOUND_STATE"),
		issueDisplayEnabled: env.FLYWHEEL_V2_ISSUE_DISPLAY?.trim() !== "0",
		kernelDbPath: optionalAbsolute(env, "FLYWHEEL_V2_DB_PATH"),
		displaySweepMs: nonNegativeIntOr(
			env,
			"FLYWHEEL_V2_DISPLAY_SWEEP_MS",
			180_000,
		),
	};
}

/** Set → must be absolute (an authority-bearing path resolved against the
 * messenger's cwd could read a DIFFERENT valid db — Codex code R1 #3). */
function optionalAbsolute(
	env: Record<string, string | undefined>,
	name: string,
): string | undefined {
	const value = env[name]?.trim();
	if (!value) return undefined;
	if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
	return value;
}

/** Strict canonical non-negative safe integer; anything else fails startup
 * (a NaN cadence would disable BOTH maybeSweep gates and run the sweep on
 * every pull — Codex code R1 #4). */
function nonNegativeIntOr(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
		throw new Error(`${name} must be a non-negative integer`);
	}
	return Number(raw);
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
	const outbound = new V2DiscordOutbound({
		v2CliBin: config.v2CliBin,
		socketPath: config.socketPath,
		secretPath: config.secretPath,
		hostEpoch: config.hostEpoch,
		sessionProofRoot: config.sessionProofRoot,
		statePath: config.outboundStatePath,
		botToken: config.botToken,
		chatChannelId: config.channelIds[0] as string,
		logger: console,
		// FLY-1549: the display surfaces (title badge + pinned pipeline
		// header) derived from the v2 kernel, triggered by the deliveries
		// this messenger already handles. OFF → byte-identical messenger.
		...(config.issueDisplayEnabled && config.kernelDbPath
			? {
					makeDisplayRefresher: (store) =>
						new V2DisplayRefresher({
							reader: openV2DisplayReader(
								config.kernelDbPath as string,
								console,
							),
							store,
							botToken: config.botToken,
							logger: console,
							sweepIntervalMs: config.displaySweepMs,
							archiveThread: async (threadId) => {
								const archived = await archiveChatThread(
									threadId,
									config.botToken,
								);
								return archived.archived || archived.reason === "missing";
							},
						}),
				}
			: {}),
	});
	if (config.issueDisplayEnabled && !config.kernelDbPath) {
		// Fail-closed: no display beats a display derived from the wrong db
		// (Codex design R1 #1). Delivery duty continues unaffected.
		console.error(
			"[v2-discord-ingress] FLYWHEEL_V2_ISSUE_DISPLAY is on but FLYWHEEL_V2_DB_PATH is unset — display surfaces stay OFF; set it to the SAME --db path the v2 host runs with",
		);
	}
	await gateway.start();
	await outbound.start();
	process.stdout.write(
		`${JSON.stringify({
			status: "ready",
			mode: "v2-bidirectional",
			leadId: config.leadId,
			channelIds: config.channelIds,
		})}\n`,
	);
	await new Promise<void>((resolve) => {
		process.once("SIGINT", resolve);
		process.once("SIGTERM", resolve);
	});
	await outbound.stop();
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
