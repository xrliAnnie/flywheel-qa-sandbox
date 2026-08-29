/**
 * FLY-1062 broker PR · Bridge wiring for the publish broker (plan §3).
 *
 * DEFAULT OFF: without FLYWHEEL_PUBLISH_BROKER=1 nothing starts — no socket,
 * no timer, no Discord surface (byte-compat; the reverse-compat sentinel test
 * pins this). Independently of the flag, the two outward publish tokens are
 * ALWAYS read-and-scrubbed out of process.env at boot so they can never ride
 * into any child the Bridge spawns (plan §3 ①).
 *
 * Token custody (①c): memory-only by design — a Bridge restart drops them and
 * the operator re-provisions at the next boot (see the runbook; approvals are
 * ephemeral too, the founder simply approves again). The env is the injection
 * vehicle at process start, never a resting place: scrubbed here, and never
 * present in ~/.flywheel/.env (runbook red line).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ReactionFetcher } from "../../lead-backends/codex/gateway/founder-confirmation.js";
import { deriveCanonicalFounderId } from "../approval-signal/canonical-founder-id.js";
import { markAutomatedDiscordText } from "../automated-message.js";
import { DISCORD_API } from "../discord-utils.js";
import { PublishBroker } from "./publish-broker.js";
import { executePublishRelease } from "./release-commit.js";
import { executePublishShell } from "./shell-publish.js";
import {
	type PublishSocketServer,
	startPublishBrokerSocket,
} from "./socket-server.js";

export const CUSTOMER_RELEASE_TOKEN_ENV = "FW_CUSTOMER_RELEASE_TOKEN";
export const NPM_GAT_TOKEN_ENV = "FW_NPM_GAT_TOKEN";

const POLL_INTERVAL_MS = 15_000;

/** Read the two outward publish tokens and DELETE them from the live env so
 * no later child spawn can inherit them. Call exactly once, at boot, before
 * any runner/lead is spawned. Safe when the vars are absent (no-op). */
export function readAndScrubPublishTokens(env: NodeJS.ProcessEnv): {
	customerRelease?: string;
	npmGat?: string;
} {
	const customerRelease = env[CUSTOMER_RELEASE_TOKEN_ENV] || undefined;
	const npmGat = env[NPM_GAT_TOKEN_ENV] || undefined;
	delete env[CUSTOMER_RELEASE_TOKEN_ENV];
	delete env[NPM_GAT_TOKEN_ENV];
	return { customerRelease, npmGat };
}

export interface PublishBrokerHandle {
	broker: PublishBroker;
	socketPath: string;
	close(): Promise<void>;
}

export interface WirePublishBrokerArgs {
	env: NodeJS.ProcessEnv;
	stateDir: string;
	discordBotToken?: string;
	discordOwnerUserId?: string;
	founderConsentUserId?: string;
	log?: (line: string) => void;
	/** test seam: overrides the real Discord surface */
	cardOverride?: {
		post: (text: string) => Promise<{ channelId: string; messageId: string }>;
		fetcher: ReactionFetcher;
		founderId: string;
	} | null;
}

/** Build + start the broker when enabled; ALWAYS scrubs the token envs.
 * Returns null when the feature flag is off (production default). */
export async function wirePublishBroker(
	args: WirePublishBrokerArgs,
): Promise<PublishBrokerHandle | null> {
	const tokens = readAndScrubPublishTokens(args.env);
	if (args.env.FLYWHEEL_PUBLISH_BROKER !== "1") return null;

	const log = args.log ?? (() => {});
	const endpoint = args.env.FW_ENDPOINT || "";
	const registryUrl = args.env.FW_NPM_REGISTRY || "https://registry.npmjs.org";
	const auditPath =
		args.env.FLYWHEEL_PUBLISH_AUDIT_PATH ||
		path.join(args.stateDir, "publish-audit.jsonl");
	const socketPath =
		args.env.FLYWHEEL_PUBLISH_BROKER_SOCKET ||
		path.join(args.stateDir, "publish-broker.sock");

	// founder approval surface: canonical founder + bot token + a channel
	const founderId = deriveCanonicalFounderId(
		args.discordOwnerUserId,
		args.founderConsentUserId,
	);
	const channelId = args.env.FLYWHEEL_PUBLISH_APPROVAL_CHANNEL || "";
	const botToken = args.discordBotToken || "";
	const card =
		args.cardOverride !== undefined
			? args.cardOverride
			: founderId && channelId && botToken
				? makeDiscordCardSurface({ botToken, channelId, founderId })
				: null;
	if (!card) {
		log(
			"[publish-broker] approval surface unconfigured (founder id / bot token / FLYWHEEL_PUBLISH_APPROVAL_CHANNEL) — requests will pend",
		);
	}

	mkdirSync(path.dirname(auditPath), { recursive: true });
	const broker = new PublishBroker({
		tokens,
		executors: {
			publishRelease: (req, token) => {
				if (!endpoint) {
					return Promise.reject(new Error("FW_ENDPOINT not configured"));
				}
				return executePublishRelease({ ...req, endpoint, token });
			},
			publishShell: (req, token) =>
				executePublishShell(
					{ stagedPath: req.stagedPath, sha256: req.sha256, registryUrl },
					token,
				),
		},
		audit: (entry) => {
			appendFileSync(auditPath, `${JSON.stringify(entry)}\n`);
		},
		card,
		log,
	});

	const socket: PublishSocketServer = await startPublishBrokerSocket({
		socketPath,
		handle: (raw) => broker.handleRequest(raw),
		log,
	});

	// Broker-owned observation timer, only when the feature is ON (default-off
	// keeps production at zero new timers). pollApprovals() is a same-tick
	// no-op while nothing is pending, so an idle enabled broker costs nothing.
	const timer = setInterval(() => {
		void broker.pollApprovals();
	}, POLL_INTERVAL_MS);
	timer.unref();

	log("[publish-broker] enabled (FLYWHEEL_PUBLISH_BROKER=1)");
	return {
		broker,
		socketPath,
		close: async () => {
			clearInterval(timer);
			await socket.close();
		},
	};
}

function makeDiscordCardSurface(opts: {
	botToken: string;
	channelId: string;
	founderId: string;
}) {
	return {
		founderId: opts.founderId,
		post: async (text: string) => {
			const res = await fetch(
				`${DISCORD_API}/channels/${opts.channelId}/messages`,
				{
					method: "POST",
					headers: {
						authorization: `Bot ${opts.botToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						content: markAutomatedDiscordText(text),
					}),
				},
			);
			if (!res.ok) {
				throw new Error(`discord post failed (HTTP ${res.status})`);
			}
			const body = (await res.json()) as { id: string; channel_id: string };
			return { channelId: body.channel_id, messageId: body.id };
		},
		fetcher: (async ({ channelId, messageId, emoji, after }) => {
			const params = new URLSearchParams({ limit: "100" });
			if (after) params.set("after", after);
			const res = await fetch(
				`${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?${params}`,
				{ headers: { authorization: `Bot ${opts.botToken}` } },
			);
			return {
				status: res.status,
				body: res.ok ? await res.json() : undefined,
			};
		}) satisfies ReactionFetcher,
	};
}
