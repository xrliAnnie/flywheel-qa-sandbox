import {
	type DiscordActiveThread,
	type InfraDiscordIdentity,
	isDiscordSnowflake,
	lastActivityMs,
	listGuildActiveThreads,
} from "./discord-guild-active-threads.js";
import type { DoneThreadReconcileConfig } from "./done-thread-reconcile.js";

export const IDLE_THREAD_SWEEP_INTERVAL_MIN = 10;
export const IDLE_THREAD_SWEEP_MAX_ARCHIVES_PER_RUN = 25;
export const IDLE_THREAD_SWEEP_RUN_DEADLINE_MS = 60_000;
export const IDLE_THREAD_SWEEP_SPACING_MS = 500;
export const IDLE_THREAD_SWEEP_REQUEST_TIMEOUT_MS = 5_000;
export const IDLE_THREAD_SWEEP_RETRY_AFTER_FALLBACK_MS = 60_000;

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

export function makeIdleThreadArchiveSweep(opts: {
	identity: InfraDiscordIdentity;
	channelIds: string[];
	fetchImpl?: typeof fetch;
	now?: () => number;
	sleepImpl?: (ms: number) => Promise<void>;
	log?: (message: string) => void;
	onDenied?: (detail: { status: number; context: string }) => void;
}): {
	runOnce: (shouldAbort?: () => boolean) => Promise<IdleThreadSweepResult>;
} {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const now = opts.now ?? Date.now;
	const sleepImpl =
		opts.sleepImpl ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const log = opts.log ?? ((message: string) => console.log(message));
	const channelIds = new Set(opts.channelIds);
	let notBeforeMs = 0;
	let listDeniedLatched = false;
	let threadCredentialDeniedLatched = false;
	const deniedThreadIds = new Set<string>();

	return {
		async runOnce(
			shouldAbort: () => boolean = () => false,
		): Promise<IdleThreadSweepResult> {
			const result = emptyResult();
			const startedAt = now();
			const deadlineAt = startedAt + IDLE_THREAD_SWEEP_RUN_DEADLINE_MS;
			let patchAttempts = 0;
			const finish = () => {
				log(
					`pass done: scanned=${result.scanned} archived=${result.archived} skippedNotIdle=${result.skippedNotIdle} skippedNoPolicy=${result.skippedNoPolicy} skippedNoClock=${result.skippedNoClock} benignMissing=${result.benignMissing} alreadyArchived=${result.alreadyArchived} clientError=${result.clientError} transient=${result.transient} denied=${result.denied} capped=${result.capped} deadlineHit=${result.deadlineHit} notBeforeSet=${result.notBeforeSet} aborted=${result.aborted}`,
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
			): "continue" | "stop" | null => {
				if (response.status === 401) {
					result.denied += 1;
					if (!threadCredentialDeniedLatched) {
						threadCredentialDeniedLatched = true;
						opts.onDenied?.({ status: response.status, context });
					}
					return "stop";
				}
				if (response.status === 403) {
					result.denied += 1;
					if (!deniedThreadIds.has(threadId)) {
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
				const listed = await listGuildActiveThreads(opts.identity, {
					fetchImpl,
					timeoutMs: IDLE_THREAD_SWEEP_REQUEST_TIMEOUT_MS,
				});
				if (!listed.ok) {
					if (listed.status === 401 || listed.status === 403) {
						result.denied += 1;
						if (!listDeniedLatched) {
							listDeniedLatched = true;
							opts.onDenied?.({
								status: listed.status,
								context: "active-thread discovery",
							});
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

				for (const thread of listed.threads) {
					if (checkStop()) break;
					if (!channelIds.has(thread.parent_id)) continue;
					result.scanned += 1;
					if (thread.thread_metadata?.archived === true) {
						result.alreadyArchived += 1;
						continue;
					}
					const policy = thread.thread_metadata?.auto_archive_duration;
					if (![60, 1440, 4320, 10080].includes(policy ?? -1)) {
						result.skippedNoPolicy += 1;
						continue;
					}
					const activity = lastActivityMs(thread);
					if (activity === null) {
						result.skippedNoClock += 1;
						continue;
					}
					if (activity > now() || now() - activity < (policy ?? 0) * 60_000) {
						result.skippedNotIdle += 1;
						continue;
					}
					if (patchAttempts >= IDLE_THREAD_SWEEP_MAX_ARCHIVES_PER_RUN) {
						result.capped = true;
						break;
					}
					await sleepImpl(IDLE_THREAD_SWEEP_SPACING_MS);
					if (checkStop()) break;

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
					);
					if (freshAction) {
						if (freshAction === "continue") continue;
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
					const freshPolicy = fresh.thread_metadata?.auto_archive_duration;
					const freshActivity = lastActivityMs(fresh);
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
