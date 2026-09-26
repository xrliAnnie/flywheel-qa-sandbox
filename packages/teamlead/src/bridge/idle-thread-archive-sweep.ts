import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type DiscordActiveThread,
	type InfraDiscordIdentity,
	isDiscordSnowflake,
	lastActivityMs,
	listGuildActiveThreads,
	resolveInfraDiscordIdentity,
	snowflakeToMs,
} from "./discord-guild-active-threads.js";
import type { DoneThreadReconcileConfig } from "./done-thread-reconcile.js";

export const IDLE_THREAD_SWEEP_INTERVAL_MIN = 10;
export const IDLE_THREAD_SWEEP_MAX_ARCHIVES_PER_RUN = 25;
export const IDLE_THREAD_SWEEP_RUN_DEADLINE_MS = 60_000;
export const IDLE_THREAD_SWEEP_SPACING_MS = 500;
export const IDLE_THREAD_SWEEP_REQUEST_TIMEOUT_MS = 5_000;
export const IDLE_THREAD_SWEEP_RETRY_AFTER_FALLBACK_MS = 60_000;
/** QA group denial alerts repeat at most this often per channel (FLY-2916). */
export const IDLE_THREAD_SWEEP_DENIED_ALERT_DEBOUNCE_MS = 24 * 60 * 60_000;
/** Env var holding the NAME of the env var with the QA group's bot token. */
export const QA_IDLE_THREAD_SWEEP_BOT_TOKEN_ENV_VAR =
	"FLYWHEEL_QA_IDLE_THREAD_SWEEP_BOT_TOKEN_ENV";

export const IDLE_THREAD_SWEEP_SCHEDULER_CONFIG: DoneThreadReconcileConfig = {
	enabled: true,
	intervalMin: IDLE_THREAD_SWEEP_INTERVAL_MIN,
	dryRun: false,
	maxArchivesPerRun: IDLE_THREAD_SWEEP_MAX_ARCHIVES_PER_RUN,
	maxCandidatesPerRun: IDLE_THREAD_SWEEP_MAX_ARCHIVES_PER_RUN,
	runDeadlineMs: IDLE_THREAD_SWEEP_RUN_DEADLINE_MS,
};

export interface IdleThreadSweepResult {
	scanned: number;
	archived: number;
	skippedNotIdle: number;
	skippedNoPolicy: number;
	skippedNoClock: number;
	benignMissing: number;
	alreadyArchived: number;
	clientError: number;
	transient: number;
	denied: number;
	skippedDeniedParent: number;
	capped: boolean;
	deadlineHit: boolean;
	notBeforeSet: boolean;
	aborted: boolean;
}

export function resolveIdleThreadSweepChannelIds(
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	return [
		env.FLYWHEEL_ROUNDTABLE_CHANNEL_ID,
		env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID,
	]
		.map((value) => value?.trim())
		.filter((value): value is string => Boolean(value))
		.filter((value, index, values) => values.indexOf(value) === index);
}

/**
 * The QA Testing group sweeps with its own bot (FLY-2916): the infra bot has no
 * VIEW_CHANNEL there. The env names the token's env var, so no Lead is baked in.
 */
export function resolveQaIdleThreadSweepIdentity(
	env: NodeJS.ProcessEnv = process.env,
	log: (message: string) => void = console.warn,
): { tokenEnv: string; identity: InfraDiscordIdentity } | null {
	const tokenEnv = env[QA_IDLE_THREAD_SWEEP_BOT_TOKEN_ENV_VAR]?.trim();
	if (!tokenEnv) return null;
	if (!/^[A-Z][A-Z0-9_]*$/.test(tokenEnv)) {
		log(
			`[idle-thread-sweep] QA group disabled: ${QA_IDLE_THREAD_SWEEP_BOT_TOKEN_ENV_VAR} is not an env var name`,
		);
		return null;
	}
	const botToken = env[tokenEnv]?.trim();
	const guildId =
		env.DISCORD_GUILD_ID?.trim() || env.FLYWHEEL_ROUNDTABLE_GUILD_ID?.trim();
	if (!botToken || !guildId) {
		log(
			`[idle-thread-sweep] QA group disabled: ${tokenEnv} or the Discord guild id is unset`,
		);
		return null;
	}
	return { tokenEnv, identity: { botToken, guildId } };
}

/** The QA Room already owns this guild/category configuration (FLY-529). */
export function resolveQaTestingCategoryId(
	guildId: string,
	slotsPath = join(homedir(), ".flywheel", "test-slots.json"),
	log: (message: string) => void = console.warn,
): string | undefined {
	try {
		const config: unknown = JSON.parse(readFileSync(slotsPath, "utf8"));
		if (
			!config ||
			typeof config !== "object" ||
			!("guildId" in config) ||
			config.guildId !== guildId ||
			!("categoryId" in config) ||
			!isDiscordSnowflake(config.categoryId)
		) {
			log(
				"[idle-thread-sweep] QA category disabled: invalid or different-guild test-slots config",
			);
			return undefined;
		}
		return config.categoryId;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			log(
				"[idle-thread-sweep] QA category disabled: could not read test-slots config",
			);
		}
		return undefined;
	}
}

/** One channel group, swept by one identity on its own scheduler and budget. */
export type IdleThreadSweepGroup =
	| {
			name: "production";
			tokenEnv: string;
			identity: InfraDiscordIdentity;
			channelIds: string[];
	  }
	| {
			name: "qa-testing";
			tokenEnv: string;
			identity: InfraDiscordIdentity;
			qaTestingCategoryId: string;
	  };

export function resolveIdleThreadSweepGroups(
	env: NodeJS.ProcessEnv = process.env,
	opts: { slotsPath?: string; log?: (message: string) => void } = {},
): IdleThreadSweepGroup[] {
	const groups: IdleThreadSweepGroup[] = [];
	const infra = resolveInfraDiscordIdentity(env);
	const channelIds = resolveIdleThreadSweepChannelIds(env);
	if (infra && channelIds.length > 0) {
		groups.push({
			name: "production",
			tokenEnv: "CLAUDE_INFRA_BOT_TOKEN",
			identity: infra,
			channelIds,
		});
	}
	const qa = resolveQaIdleThreadSweepIdentity(env, opts.log);
	const qaTestingCategoryId = qa
		? resolveQaTestingCategoryId(qa.identity.guildId, opts.slotsPath, opts.log)
		: undefined;
	if (qa && qaTestingCategoryId) {
		groups.push({ name: "qa-testing", ...qa, qaTestingCategoryId });
	}
	return groups;
}

export interface IdleThreadSweepDenial {
	status: number;
	context: string;
	channelId?: string;
}

export function describeIdleThreadSweepDenial(
	group: IdleThreadSweepGroup,
	{ status, context, channelId }: IdleThreadSweepDenial,
): {
	reason: "idle_thread_sweep_denied" | "qa_idle_thread_sweep_denied";
	title: string;
	body: string;
} {
	if (group.name === "production") {
		return {
			reason: "idle_thread_sweep_denied",
			title: "Discord idle-thread sweep denied",
			body: `Discord HTTP ${status} during ${context}; check claw-infra-bot VIEW_CHANNEL and MANAGE_THREADS permissions.`,
		};
	}
	return {
		reason: "qa_idle_thread_sweep_denied",
		title: "QA Testing idle-thread sweep denied",
		body: `Discord HTTP ${status} during ${context}${channelId ? ` in channel ${channelId}` : ""}; check the ${group.tokenEnv} bot's VIEW_CHANNEL and MANAGE_THREADS permissions in QA Testing. Repeats at most once per 24h per channel.`,
	};
}

function emptyResult(): IdleThreadSweepResult {
	return {
		scanned: 0,
		archived: 0,
		skippedNotIdle: 0,
		skippedNoPolicy: 0,
		skippedNoClock: 0,
		benignMissing: 0,
		alreadyArchived: 0,
		clientError: 0,
		transient: 0,
		denied: 0,
		skippedDeniedParent: 0,
		capped: false,
		deadlineHit: false,
		notBeforeSet: false,
		aborted: false,
	};
}

function isThread(value: unknown): value is DiscordActiveThread {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<DiscordActiveThread>;
	return (
		isDiscordSnowflake(candidate.id) && typeof candidate.parent_id === "string"
	);
}

/**
 * One instance sweeps exactly one channel group: the static production
 * channels, or the QA Testing category (discovered each pass). QA passes run
 * on their own identity and scheduler, so they never spend production budget.
 */
export function makeIdleThreadArchiveSweep(
	opts: {
		identity: InfraDiscordIdentity;
		fetchImpl?: typeof fetch;
		now?: () => number;
		sleepImpl?: (ms: number) => Promise<void>;
		log?: (message: string) => void;
		/** QA group: resolve `false` when the alert was not delivered (retried). */
		onDenied?: (detail: IdleThreadSweepDenial) => Promise<boolean> | undefined;
	} & (
		| { channelIds: string[]; qaTestingCategoryId?: undefined }
		| { channelIds?: undefined; qaTestingCategoryId: string }
	),
): {
	runOnce: (shouldAbort?: () => boolean) => Promise<IdleThreadSweepResult>;
} {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const now = opts.now ?? Date.now;
	const sleepImpl =
		opts.sleepImpl ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const log = opts.log ?? ((message: string) => console.log(message));
	const qaCategoryId = opts.qaTestingCategoryId;
	const qaGroup = qaCategoryId !== undefined;
	const channelIds = new Set(opts.channelIds ?? []);
	let notBeforeMs = 0;
	let listDeniedLatched = false;
	let threadCredentialDeniedLatched = false;
	const deniedThreadIds = new Set<string>();
	// QA group: one alert per channel (or per credential/list failure) per 24h.
	const qaDeniedAlertedAt = new Map<string, number>();
	const alertQaDenied = (detail: IdleThreadSweepDenial) => {
		const key = detail.channelId ?? detail.context;
		const last = qaDeniedAlertedAt.get(key);
		if (
			last !== undefined &&
			now() - last < IDLE_THREAD_SWEEP_DENIED_ALERT_DEBOUNCE_MS
		)
			return;
		const stampedAt = now();
		qaDeniedAlertedAt.set(key, stampedAt);
		// An undelivered alert (e.g. debounced by the notifier) is retried on a
		// later pass instead of being silenced for 24h.
		const forget = () => {
			if (qaDeniedAlertedAt.get(key) === stampedAt)
				qaDeniedAlertedAt.delete(key);
		};
		void Promise.resolve()
			.then(() => opts.onDenied?.(detail))
			.then((delivered) => {
				if (delivered === false) forget();
			}, forget);
	};

	return {
		async runOnce(
			shouldAbort: () => boolean = () => false,
		): Promise<IdleThreadSweepResult> {
			const result = emptyResult();
			const startedAt = now();
			const deadlineAt = startedAt + IDLE_THREAD_SWEEP_RUN_DEADLINE_MS;
			let patchAttempts = 0;
			// Denied reads spend the same per-pass budget as PATCH attempts.
			let deniedReads = 0;
			const finish = () => {
				log(
					`pass done: scanned=${result.scanned} archived=${result.archived} skippedNotIdle=${result.skippedNotIdle} skippedNoPolicy=${result.skippedNoPolicy} skippedNoClock=${result.skippedNoClock} benignMissing=${result.benignMissing} alreadyArchived=${result.alreadyArchived} clientError=${result.clientError} transient=${result.transient} denied=${result.denied} skippedDeniedParent=${result.skippedDeniedParent} capped=${result.capped} deadlineHit=${result.deadlineHit} notBeforeSet=${result.notBeforeSet} aborted=${result.aborted}`,
				);
				return result;
			};
			const checkStop = () => {
				if (shouldAbort()) result.aborted = true;
				else if (now() >= deadlineAt) result.deadlineHit = true;
				return result.aborted || result.deadlineHit;
			};
			const request = async (
				url: string,
				init: RequestInit = {},
			): Promise<{ response: Response; body: unknown } | null> => {
				if (checkStop()) return null;
				const controller = new AbortController();
				const timeoutMs = Math.max(
					1,
					Math.min(IDLE_THREAD_SWEEP_REQUEST_TIMEOUT_MS, deadlineAt - now()),
				);
				const timer = setTimeout(() => controller.abort(), timeoutMs);
				try {
					const response = await fetchImpl(url, {
						...init,
						headers: {
							Authorization: `Bot ${opts.identity.botToken}`,
							...(init.body ? { "Content-Type": "application/json" } : {}),
							...(init.headers ?? {}),
						},
						signal: controller.signal,
					});
					return {
						response,
						body: await response.json().catch((error) => {
							if (controller.signal.aborted) throw error;
							return undefined;
						}),
					};
				} catch (error) {
					if (shouldAbort()) result.aborted = true;
					else if (now() >= deadlineAt) result.deadlineHit = true;
					else result.transient += 1;
					log(
						`request failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
					);
					return null;
				} finally {
					clearTimeout(timer);
				}
			};
			const stopForThreadResponse = (
				response: Response,
				body: unknown,
				context: string,
				threadId: string,
				channelId: string,
			): "continue" | "stop" | null => {
				if (response.status === 401) {
					result.denied += 1;
					if (qaGroup) alertQaDenied({ status: response.status, context });
					else if (!threadCredentialDeniedLatched) {
						threadCredentialDeniedLatched = true;
						opts.onDenied?.({ status: response.status, context });
					}
					return "stop";
				}
				if (response.status === 403) {
					result.denied += 1;
					if (qaGroup)
						alertQaDenied({ status: response.status, context, channelId });
					else if (!deniedThreadIds.has(threadId)) {
						deniedThreadIds.add(threadId);
						opts.onDenied?.({ status: response.status, context });
					}
					return "continue";
				}
				if (response.status === 429) {
					const headerRaw = response.headers.get("retry-after");
					const headerSeconds =
						headerRaw === null ? Number.NaN : Number(headerRaw);
					const bodyRetry = (body as { retry_after?: unknown } | undefined)
						?.retry_after;
					const bodySeconds =
						typeof bodyRetry === "number" || typeof bodyRetry === "string"
							? Number(bodyRetry)
							: Number.NaN;
					const delay = Number.isFinite(headerSeconds)
						? Math.max(0, headerSeconds * 1000)
						: Number.isFinite(bodySeconds)
							? Math.max(0, bodySeconds * 1000)
							: IDLE_THREAD_SWEEP_RETRY_AFTER_FALLBACK_MS;
					notBeforeMs = now() + delay;
					result.notBeforeSet = true;
					result.transient += 1;
					return "stop";
				}
				if (response.status >= 500) {
					result.transient += 1;
					return "stop";
				}
				return null;
			};

			try {
				if (checkStop()) return finish();
				if (now() < notBeforeMs) return finish();
				// Discover membership each pass so new QA channels are included and
				// channels moved out of QA immediately lose the one-hour override.
				const qaChannelIds = new Set<string>();
				if (qaGroup) {
					if (!isDiscordSnowflake(qaCategoryId)) {
						result.clientError += 1;
						log("QA category id is invalid; skipping QA threads");
						return finish();
					}
					const channelsHttp = await request(
						`https://discord.com/api/v10/guilds/${opts.identity.guildId}/channels`,
					);
					if (!channelsHttp) return finish();
					if (
						stopForThreadResponse(
							channelsHttp.response,
							channelsHttp.body,
							"QA category discovery",
							qaCategoryId,
							qaCategoryId,
						)
					)
						return finish();
					if (!channelsHttp.response.ok || !Array.isArray(channelsHttp.body)) {
						result.clientError += 1;
						log("QA category discovery failed; skipping QA threads this pass");
						return finish();
					}
					for (const channel of channelsHttp.body) {
						if (
							channel &&
							isDiscordSnowflake(channel.id) &&
							channel.parent_id === qaCategoryId &&
							[0, 5, 15, 16].includes(channel.type)
						) {
							qaChannelIds.add(channel.id);
						}
					}
					if (qaChannelIds.size === 0) return finish();
				}
				const inScope = (parentId: string) =>
					qaGroup ? qaChannelIds.has(parentId) : channelIds.has(parentId);
				const policyMinutes = (thread: DiscordActiveThread) =>
					qaGroup ? 60 : thread.thread_metadata?.auto_archive_duration;
				const activityMs = (thread: DiscordActiveThread) =>
					qaGroup
						? snowflakeToMs(thread.last_message_id)
						: lastActivityMs(thread);
				const listed = await listGuildActiveThreads(opts.identity, {
					fetchImpl,
					timeoutMs: IDLE_THREAD_SWEEP_REQUEST_TIMEOUT_MS,
				});
				if (!listed.ok) {
					if (listed.status === 401 || listed.status === 403) {
						result.denied += 1;
						const detail = {
							status: listed.status,
							context: "active-thread discovery",
						};
						if (qaGroup) alertQaDenied(detail);
						else if (!listDeniedLatched) {
							listDeniedLatched = true;
							opts.onDenied?.(detail);
						}
						return finish();
					}
					if (listed.status === 429) {
						notBeforeMs =
							now() +
							(listed.retryAfterMs ??
								IDLE_THREAD_SWEEP_RETRY_AFTER_FALLBACK_MS);
						result.notBeforeSet = true;
					}
					result.transient += 1;
					return finish();
				}
				listDeniedLatched = false;

				// QA parents are probed once per pass; a denied (or missing) channel
				// skips all of its threads without reading any of them.
				const readableParents = new Set<string>();
				const skippedParents = new Set<string>();
				for (const thread of listed.threads) {
					if (checkStop()) break;
					if (!inScope(thread.parent_id)) continue;
					result.scanned += 1;
					if (thread.thread_metadata?.archived === true) {
						result.alreadyArchived += 1;
						continue;
					}
					const policy = policyMinutes(thread);
					if (![60, 1440, 4320, 10080].includes(policy ?? -1)) {
						result.skippedNoPolicy += 1;
						continue;
					}
					const activity = activityMs(thread);
					if (activity === null) {
						result.skippedNoClock += 1;
						continue;
					}
					if (activity > now() || now() - activity < (policy ?? 0) * 60_000) {
						result.skippedNotIdle += 1;
						continue;
					}
					if (skippedParents.has(thread.parent_id)) {
						result.skippedDeniedParent += 1;
						continue;
					}
					if (
						patchAttempts + deniedReads >=
						IDLE_THREAD_SWEEP_MAX_ARCHIVES_PER_RUN
					) {
						result.capped = true;
						break;
					}
					await sleepImpl(IDLE_THREAD_SWEEP_SPACING_MS);
					if (checkStop()) break;

					if (qaGroup && !readableParents.has(thread.parent_id)) {
						const parentHttp = await request(
							`https://discord.com/api/v10/channels/${thread.parent_id}`,
						);
						if (!parentHttp) break;
						const parentAction = stopForThreadResponse(
							parentHttp.response,
							parentHttp.body,
							"QA channel read",
							thread.parent_id,
							thread.parent_id,
						);
						if (parentAction === "stop") break;
						if (parentAction === "continue") {
							deniedReads += 1;
							skippedParents.add(thread.parent_id);
							result.skippedDeniedParent += 1;
							continue;
						}
						if (!parentHttp.response.ok) {
							if (parentHttp.response.status === 404) result.benignMissing += 1;
							else result.clientError += 1;
							skippedParents.add(thread.parent_id);
							continue;
						}
						readableParents.add(thread.parent_id);
					}

					const freshHttp = await request(
						`https://discord.com/api/v10/channels/${thread.id}`,
					);
					if (!freshHttp) break;
					const { response: freshResponse, body: fresh } = freshHttp;
					if (freshResponse.status === 404) {
						result.benignMissing += 1;
						continue;
					}
					const freshAction = stopForThreadResponse(
						freshResponse,
						fresh,
						"fresh thread read",
						thread.id,
						thread.parent_id,
					);
					if (freshAction) {
						if (freshAction === "continue") {
							deniedReads += 1;
							continue;
						}
						break;
					}
					if (!freshResponse.ok || !isThread(fresh)) {
						result.clientError += 1;
						continue;
					}
					if (fresh.thread_metadata?.archived === true) {
						result.alreadyArchived += 1;
						continue;
					}
					if (fresh.parent_id !== thread.parent_id) {
						result.benignMissing += 1;
						continue;
					}
					const freshPolicy = policyMinutes(fresh);
					const freshActivity = activityMs(fresh);
					if (
						![60, 1440, 4320, 10080].includes(freshPolicy ?? -1) ||
						freshActivity === null ||
						freshActivity > now() ||
						now() - freshActivity < (freshPolicy ?? 0) * 60_000
					) {
						result.skippedNotIdle += 1;
						continue;
					}

					patchAttempts += 1;
					const patchHttp = await request(
						`https://discord.com/api/v10/channels/${thread.id}`,
						{
							method: "PATCH",
							body: JSON.stringify({ archived: true }),
						},
					);
					if (!patchHttp) break;
					const { response: patchResponse, body: patched } = patchHttp;
					const patchAction = stopForThreadResponse(
						patchResponse,
						patched,
						"thread PATCH",
						thread.id,
						thread.parent_id,
					);
					if (patchAction) {
						if (patchAction === "continue") continue;
						break;
					}
					if (patchResponse.ok) {
						threadCredentialDeniedLatched = false;
						deniedThreadIds.delete(thread.id);
						if (
							isThread(patched) &&
							patched.thread_metadata?.archived === true
						) {
							result.archived += 1;
						} else {
							result.transient += 1;
						}
						continue;
					}
					if (patchResponse.status === 404) {
						result.benignMissing += 1;
						continue;
					}
					if (
						patchResponse.status === 400 &&
						(patched as { code?: unknown } | undefined)?.code === 50083
					) {
						result.alreadyArchived += 1;
						continue;
					}
					result.clientError += 1;
				}
			} catch (error) {
				result.transient += 1;
				log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
			}
			return finish();
		},
	};
}
