import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	CODEX_READING_STALE_AFTER_MS,
	type CodexReadingFreshness,
	codexReadingFreshness,
} from "flywheel-claude-runner/bin/codex-account-core.mjs";
import {
	DATA_VOLUME_PATH,
	GB_BYTES,
	readDataDisk as readSharedDataDisk,
} from "flywheel-comm/snapshot-storage";
import { retirementMs } from "../account-heal/account-retirement.js";
import {
	defaultStorePath,
	readStoreStrict,
} from "../account-heal/account-store.js";
import { defaultMachinePoolDir } from "../account-heal/machine-account.js";
import {
	defaultQuotaMonitorConfigPath,
	loadQuotaMonitorConfig,
} from "../account-heal/quota-monitor-config.js";
import {
	type PoolSubscriptionTier,
	readPoolSubscriptionTier,
} from "../account-heal/quota-monitor-credentials.js";
import {
	defaultClaudeAccountDetailStorePath,
	readClaudeAccountDetailStore,
} from "../claude-quota/account-detail-store.js";
import {
	defaultClaudeManualPrepaidPath,
	readClaudeManualPrepaid,
} from "../claude-quota/manual-prepaid.js";
import {
	type CodexAccountReading,
	defaultCodexAccountQuotaStorePath,
	readCodexAccountQuotaStore,
} from "../codex-quota/codex-account-quota-store.js";
import {
	type CodexSubscriptionReading,
	defaultCodexSubscriptionStorePath,
	readCodexSubscriptionStore,
} from "../codex-quota/codex-subscription-store.js";
import type { StateStore } from "../StateStore.js";
import { parseSqliteUtcMs } from "./founder-notify-utils.js";
import {
	isCapacityUnavailableToken,
	type MemoryFreePctReading,
} from "./machine-free-pct.js";
import type {
	AdmissionDecision,
	AdmissionProbe,
	RunnerAdmissionController,
} from "./runner-admission.js";

export const CAPACITY_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const CAPACITY_MEMORY_TIGHT_BELOW_PCT = 15;
const CAPACITY_ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CAPACITY_PROMPT_TOKEN = /^[A-Za-z0-9._-]{1,64}$/;
const CAPACITY_SENSOR_WATERMARK =
	/^(?:unknown|(?:100\.0|(?:[0-9]|[1-9][0-9])\.[0-9])% free)$/;
const CAPACITY_DIRECTIVE_WORDS =
	/check|verify|suggest|inspect|ignore[_\s-]*previous[_\s-]*instructions|建议|怀疑|该查/iu;

/**
 * Capacity diagnostics are omitted when empty. When present, they are an
 * ordered, non-empty array of allowlisted unavailable tokens.
 */
export type CapacityUnavailable = string[];

export function canonicalCapacityToken(value: unknown): string {
	const text = typeof value === "string" ? value : String(value ?? "");
	if (
		CAPACITY_PROMPT_TOKEN.test(text) &&
		!CAPACITY_DIRECTIVE_WORDS.test(text)
	) {
		return text;
	}
	return `unsafe-${createHash("sha256").update(text).digest("hex").slice(0, 8)}`;
}

function canonicalCapacityWatermark(value: string): string {
	return CAPACITY_SENSOR_WATERMARK.test(value)
		? value
		: canonicalCapacityToken(value);
}

export interface CapacitySnapshot {
	schemaVersion: 1;
	generatedAt: string;
	disk_avail_gb: number | null;
	disk: {
		volume: typeof DATA_VOLUME_PATH;
		availBytes: number | null;
		observedAt: string | null;
		unavailable?: CapacityUnavailable;
	};
	memory: {
		source: "memory_pressure";
		freePct: number | null;
		observedAt: string | null;
		tightBelowPct: number;
		tight: boolean | null;
		unavailable?: CapacityUnavailable;
	};
	load: {
		load1: number | null;
		cpuCount: number | null;
		perCore: number | null;
		thresholdPerCore: number | null;
		observedAt: string | null;
		unavailable?: CapacityUnavailable;
	};
	brakes: {
		pressureHold: {
			active: boolean | null;
			setBy?: string;
			setAt?: string;
			watermark?: string | null;
			unavailable?: CapacityUnavailable;
		};
		admissionPause: {
			active: boolean | null;
			remainingSeconds: number | null;
			unavailable?: CapacityUnavailable;
		};
		admission: {
			admit: boolean | null;
			reason?: string;
			detail?: string;
			unavailable?: CapacityUnavailable;
		};
		observedAt: string | null;
	};
	runners: {
		running: number | null;
		parked: number | null;
		total: number | null;
		byProject: Record<string, { running: number; parked: number }> | null;
		observedAt: string | null;
		unavailable?: CapacityUnavailable;
	};
	quota: {
		claude: {
			source: "claude-accounts.json";
			activeAccount: string | null;
			staleAfterMinutes: number;
			accounts: Array<{
				name: string;
				active: boolean;
				subscriptionTier?: PoolSubscriptionTier;
				fiveHPct: number | null;
				sevenDPct: number | null;
				fableSevenDPct?: number | null;
				observedAt: string | null;
				ageMinutes: number | null;
				stale: boolean | null;
				subscriptionStatus?: "active" | "canceled" | "unknown";
				detailObservedAt?: string | null;
				usageStatus?: string;
				prepaid?: NonNullable<
					ReturnType<typeof readClaudeAccountDetailStore>
				>["accounts"][number]["prepaid"];
				/** FLY-2864: usage-limit reset cards from the detail probe. */
				resetGrants?: NonNullable<
					NonNullable<
						ReturnType<typeof readClaudeAccountDetailStore>
					>["accounts"][number]["resetGrants"]
				>;
				manualPrepaid?: NonNullable<
					ReturnType<typeof readClaudeManualPrepaid>
				>[number];
				fiveHResetAt?: string | null;
				weeklyResetAt: string | null;
				fableWeeklyResetAt?: string | null;
				retiresAt?: string;
				exhaustedUntil: string | null;
				authUnusable: boolean;
			}>;
			unavailable?: CapacityUnavailable;
		};
		codex: {
			source: "codex-accounts.json" | null;
			/** Present only with a readable Codex store; absent keeps the no-source shape. */
			activeAccount?: string | null;
			staleAfterMinutes?: number;
			accounts?: CodexAccountProjection[];
			unavailable: CapacityUnavailable;
		};
	};
}

export interface CodexAccountProjection {
	name: string;
	active: boolean;
	registeredProfile: string | null;
	planType: string | null;
	fiveHPct: number | null;
	weeklyPct: number | null;
	fiveHResetAt: string | null;
	weeklyResetAt: string | null;
	credits: CodexAccountReading["credits"];
	resetCredits: CodexAccountReading["resetCredits"];
	resetCreditsObservedAt?: string | null;
	observedAt: string | null;
	ageMinutes: number | null;
	stale: boolean | null;
	/**
	 * FLY-2869: only a "fresh" reading may say 打满/正常. Stale, reset-elapsed
	 * and unobserved readings are unknown: no percentages, no exhaustion.
	 */
	freshness?: CodexReadingFreshness;
	/** Any window at 100%; the page marks these rows red. */
	exhausted: boolean;
	/** Latest reset among exhausted windows; null when unknown or not exhausted. */
	recoveryAt: string | null;
	authUnusable: boolean;
	note: string | null;
	/** FLY-2830: bounded reason code behind `note` (store-validated). */
	noteDetail?: string;
	unclassifiedWindows: number;
	tokenState: CodexTokenState;
	/**
	 * FLY-2864: the account's subscription (next charge), only when the reading
	 * belongs to the same login; an identity-less problem row projects its note.
	 */
	subscription?: CodexSubscriptionProjection;
}

export type CodexSubscriptionProjection = Pick<
	CodexSubscriptionReading,
	"status" | "renewsAt" | "endsAt" | "observedAt" | "note"
>;

function projectCodexSubscription(
	reading: CodexAccountReading,
	subscription: CodexSubscriptionReading | undefined,
): CodexSubscriptionProjection | undefined {
	if (subscription === undefined) return undefined;
	if (subscription.identityKey === undefined) {
		return {
			status: "unknown",
			renewsAt: null,
			endsAt: null,
			observedAt: null,
			note: subscription.note,
		};
	}
	if (
		reading.identityKey === undefined ||
		reading.identityKey !== subscription.identityKey
	) {
		return undefined;
	}
	return {
		status: subscription.status,
		renewsAt: subscription.renewsAt,
		endsAt: subscription.endsAt,
		observedAt: subscription.observedAt,
		note: subscription.note,
	};
}

export type CodexTokenState =
	| "正常"
	| "打满"
	| "读数过期"
	| "已过重置待探"
	| "已吊销"
	| "已过期"
	| "凭据失效"
	| "未登录"
	| "凭据损坏"
	| "重复登录"
	| "在用未探"
	| "未探";

export function codexTokenState(
	reading: Pick<
		CodexAccountReading,
		"authHealth" | "note" | "fiveH" | "weekly"
	>,
): CodexTokenState {
	switch (reading.note) {
		case "token_revoked":
			return "已吊销";
		case "token_expired":
			return "已过期";
		case "refresh_invalid":
			return "凭据失效";
		case "not_logged_in":
			return "未登录";
		case "invalid_credential":
			return "凭据损坏";
		case "duplicate_email":
			return "重复登录";
	}
	if (reading.authHealth === "in_use_unshared") return "在用未探";
	if (reading.authHealth !== "valid") return "未探";
	return [reading.fiveH, reading.weekly].some(
		(window) => window?.usedPercent === 100,
	)
		? "打满"
		: "正常";
}

/** FLY-2869: Codex readings go unknown after this, independent of Claude's sweep. */
export const CODEX_STALE_AFTER_MINUTES = CODEX_READING_STALE_AFTER_MS / 60_000;

const FRESHNESS_TOKEN_STATE: Record<
	Exclude<CodexReadingFreshness, "fresh">,
	CodexTokenState
> = {
	stale: "读数过期",
	reset_elapsed: "已过重置待探",
	unobserved: "未探",
};

function projectCodexAccount(
	reading: CodexAccountReading,
	input: {
		activeAccount: string | null;
		nowMs: number;
		staleAfterMinutes: number;
		subscription?: CodexSubscriptionReading;
	},
): CodexAccountProjection {
	const subscription = projectCodexSubscription(reading, input.subscription);
	const freshness = codexReadingFreshness(
		reading,
		input.nowMs,
		input.staleAfterMinutes * 60_000,
	);
	const fresh = freshness === "fresh";
	// A non-fresh reading keeps only reset instants that are still ahead.
	const futureReset = (resetAt: string | null) =>
		fresh || (resetAt !== null && Date.parse(resetAt) > input.nowMs)
			? resetAt
			: null;
	const windows = [reading.fiveH, reading.weekly].filter(
		(window): window is NonNullable<typeof window> => window !== null,
	);
	const exhaustedResets = fresh
		? windows
				.filter((window) => window.usedPercent === 100)
				.map((window) => window.resetAt)
		: [];
	const exhausted = exhaustedResets.length > 0;
	const judged = codexTokenState(reading);
	const tokenState =
		!fresh && (judged === "打满" || judged === "正常")
			? FRESHNESS_TOKEN_STATE[freshness]
			: judged;
	const recoveryAt =
		exhausted && exhaustedResets.every((reset) => reset !== null)
			? new Date(
					Math.max(...exhaustedResets.map((reset) => Date.parse(reset!))),
				).toISOString()
			: null;
	const observedMs =
		reading.observedAt === null ? null : Date.parse(reading.observedAt);
	const ageMinutes =
		observedMs === null
			? null
			: Math.max(0, Math.round((input.nowMs - observedMs) / 60_000));
	return {
		name: reading.name,
		active: reading.name === input.activeAccount,
		registeredProfile: reading.registeredProfile,
		planType: reading.planType,
		fiveHPct: fresh ? (reading.fiveH?.usedPercent ?? null) : null,
		weeklyPct: fresh ? (reading.weekly?.usedPercent ?? null) : null,
		fiveHResetAt: futureReset(reading.fiveH?.resetAt ?? null),
		weeklyResetAt: futureReset(reading.weekly?.resetAt ?? null),
		credits: reading.credits,
		resetCredits: reading.resetCredits,
		resetCreditsObservedAt:
			reading.resetCreditsObservedAt ?? reading.observedAt,
		observedAt: reading.observedAt,
		ageMinutes,
		stale: reading.observedAt === null ? null : freshness === "stale",
		freshness,
		exhausted,
		recoveryAt,
		authUnusable:
			reading.authHealth === "missing" ||
			reading.note === "read_failed" ||
			[
				"已吊销",
				"已过期",
				"凭据失效",
				"未登录",
				"凭据损坏",
				"重复登录",
			].includes(tokenState),
		note: reading.note,
		...(reading.noteDetail === undefined
			? {}
			: { noteDetail: reading.noteDetail }),
		unclassifiedWindows: reading.unclassifiedWindows,
		tokenState,
		...(subscription === undefined ? {} : { subscription }),
	};
}

export interface CapacitySnapshotDeps {
	store: Pick<
		StateStore,
		"getActiveSessions" | "getFleetPressureHold" | "getAdmissionPause"
	>;
	admission?: Pick<RunnerAdmissionController, "probe">;
	readMemoryFreePct: () => Promise<MemoryFreePctReading>;
	readDataDisk?: typeof readSharedDataDisk;
	accountStorePath?: string;
	codexAccountStorePath?: string;
	codexSubscriptionStorePath?: string;
	claudeAccountDetailStorePath?: string;
	claudeManualPrepaidPath?: string;
	claudeProfilesDir?: string;
	quotaConfigPath?: string;
	now?: () => number;
}

function validPct(value: unknown): number | null {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 100
		? value
		: null;
}

function validInstant(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const time = Date.parse(value);
	return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function validSqliteUtcInstant(value: string): string | undefined {
	const time = parseSqliteUtcMs(value);
	return time === null ? undefined : new Date(time).toISOString();
}

function validObservationInstant(value: unknown, nowMs: number): string | null {
	const instant = validInstant(value);
	return instant !== null && Date.parse(instant) <= nowMs + 60_000
		? instant
		: null;
}

function validAuthFlags(account: {
	authExpired?: unknown;
	refreshTokenInvalid?: unknown;
	profileVerifyFailed?: unknown;
}): boolean {
	return [
		account.authExpired,
		account.refreshTokenInvalid,
		account.profileVerifyFailed,
	].every((value) => value === undefined || typeof value === "boolean");
}

function appendUnavailable(tokens: string[], token: string): void {
	if (!tokens.includes(token)) tokens.push(token);
}

function admissionSnapshot(decision: AdmissionDecision): {
	admit: boolean;
	reason?: string;
	detail?: string;
} {
	if (decision.admit) return { admit: true };

	let detail: string;
	switch (decision.reason) {
		case "load_pressure":
		case "memory_pressure":
			detail = decision.detail;
			break;
		case "admission_paused":
		case "pressure_hold":
			detail = canonicalCapacityToken(decision.detail);
			break;
	}

	return {
		admit: false,
		reason: decision.reason,
		detail,
	};
}

export async function buildCapacitySnapshot(
	deps: CapacitySnapshotDeps,
): Promise<CapacitySnapshot> {
	const nowMs = (deps.now ?? Date.now)();
	const observedAt = new Date(nowMs).toISOString();
	let disk: CapacitySnapshot["disk"];
	let diskAvailGb: number | null;
	try {
		const reading = (deps.readDataDisk ?? readSharedDataDisk)();
		if (
			reading.disk.volume !== DATA_VOLUME_PATH ||
			(reading.disk.availBytes === null
				? reading.disk_avail_gb !== null ||
					reading.disk.observedAt !== null ||
					!Array.isArray(reading.disk.unavailable) ||
					reading.disk.unavailable.length === 0 ||
					!reading.disk.unavailable.every(isCapacityUnavailableToken)
				: !Number.isSafeInteger(reading.disk.availBytes) ||
					reading.disk.availBytes < 0 ||
					validInstant(reading.disk.observedAt) === null ||
					reading.disk_avail_gb !== reading.disk.availBytes / GB_BYTES)
		) {
			throw new Error("invalid Data volume reading");
		}
		disk =
			reading.disk.availBytes === null
				? {
						volume: DATA_VOLUME_PATH,
						availBytes: null,
						observedAt: null,
						unavailable: reading.disk.unavailable,
					}
				: {
						volume: DATA_VOLUME_PATH,
						availBytes: reading.disk.availBytes,
						observedAt: reading.disk.observedAt,
					};
		diskAvailGb = reading.disk_avail_gb;
	} catch {
		diskAvailGb = null;
		disk = {
			volume: DATA_VOLUME_PATH,
			availBytes: null,
			observedAt: null,
			unavailable: ["transient: data_volume_unreadable"],
		};
	}
	let memoryReading: {
		freePct: number | null;
		observedAt: string | null;
		unavailable?: string;
	};
	try {
		const reading = await deps.readMemoryFreePct();
		const freePct = validPct(reading.freePct);
		const readingObservedAt = validInstant(reading.observedAt);
		memoryReading =
			freePct === null || readingObservedAt === null
				? {
						freePct: null,
						observedAt: null,
						unavailable: isCapacityUnavailableToken(reading.unavailable)
							? reading.unavailable
							: "transient: memory_pressure_parse_failed",
					}
				: { freePct, observedAt: readingObservedAt };
	} catch {
		memoryReading = {
			freePct: null,
			observedAt: null,
			unavailable: "transient: memory_pressure_timeout",
		};
	}
	let probe: AdmissionProbe | undefined;
	let admissionUnavailable: string | undefined;
	if (!deps.admission) {
		admissionUnavailable = "structural: admission_controller_absent";
	} else {
		try {
			probe = deps.admission.probe();
		} catch {
			admissionUnavailable = "transient: load_probe_failed";
		}
	}
	let pressureHold: ReturnType<StateStore["getFleetPressureHold"]>;
	let pressureHoldUnavailable: string | undefined;
	try {
		pressureHold = deps.store.getFleetPressureHold();
	} catch {
		pressureHoldUnavailable = "transient: state_store_unreadable";
	}
	let admissionPause: ReturnType<StateStore["getAdmissionPause"]>;
	let admissionPauseUnavailable: string | undefined;
	try {
		admissionPause = deps.store.getAdmissionPause(observedAt);
	} catch {
		admissionPauseUnavailable = "transient: state_store_unreadable";
	}
	let sessions: ReturnType<StateStore["getActiveSessions"]> = [];
	let runnersUnavailable: string | undefined;
	try {
		sessions = deps.store.getActiveSessions();
	} catch {
		runnersUnavailable = "transient: session_store_unreadable";
	}
	const byProject = new Map<string, { running: number; parked: number }>();
	let running = 0;
	let parked = 0;
	for (const session of sessions) {
		const bucket = byProject.get(session.project_name) ?? {
			running: 0,
			parked: 0,
		};
		if (session.status === "running") {
			running++;
			bucket.running++;
		} else {
			parked++;
			bucket.parked++;
		}
		byProject.set(session.project_name, bucket);
	}

	const accountStorePath = deps.accountStorePath ?? defaultStorePath();
	const claudeProfilesDir =
		deps.claudeProfilesDir ??
		(deps.accountStorePath === undefined
			? defaultMachinePoolDir()
			: join(dirname(accountStorePath), "claude-profiles"));
	const codexAccountStorePath =
		deps.codexAccountStorePath ??
		(deps.accountStorePath === undefined
			? defaultCodexAccountQuotaStorePath()
			: join(dirname(accountStorePath), "codex-accounts.json"));
	const codexSubscriptionStorePath =
		deps.codexSubscriptionStorePath ??
		(deps.accountStorePath === undefined
			? defaultCodexSubscriptionStorePath()
			: join(dirname(accountStorePath), "codex-subscriptions.json"));
	const claudeAccountDetailStorePath =
		deps.claudeAccountDetailStorePath ??
		(deps.accountStorePath === undefined
			? defaultClaudeAccountDetailStorePath()
			: join(dirname(accountStorePath), "claude-account-details.json"));
	const claudeManualPrepaidPath =
		deps.claudeManualPrepaidPath ??
		(deps.accountStorePath === undefined
			? defaultClaudeManualPrepaidPath()
			: join(dirname(accountStorePath), "manual-prepaid.json"));
	const claudeManualPrepaidStateDir =
		deps.accountStorePath === undefined
			? dirname(dirname(defaultClaudeManualPrepaidPath()))
			: dirname(accountStorePath);
	const quotaConfigPath =
		deps.quotaConfigPath ?? defaultQuotaMonitorConfigPath();
	const codexStore = readCodexAccountQuotaStore(codexAccountStorePath);
	// A missing or invalid subscription file only drops the next-charge facts.
	const codexSubscriptionsByName = new Map(
		(
			readCodexSubscriptionStore(codexSubscriptionStorePath)?.accounts ?? []
		).map((account) => [account.name, account]),
	);
	const claudeDetails = readClaudeAccountDetailStore(
		claudeAccountDetailStorePath,
	);
	const claudeDetailsByName = new Map(
		(claudeDetails?.accounts ?? []).map((account) => [account.name, account]),
	);
	const manualPrepaid = readClaudeManualPrepaid(
		claudeManualPrepaidPath,
		claudeManualPrepaidStateDir,
	);
	const manualPrepaidByName = new Map(
		(manualPrepaid ?? []).map((entry) => [entry.account, entry]),
	);
	const staleAfterMinutes =
		loadQuotaMonitorConfig(quotaConfigPath).config.candidateSweepMinutes * 2;
	let accountStore: ReturnType<typeof readStoreStrict> = null;
	const claudeUnavailable: string[] = [];
	try {
		if (!existsSync(accountStorePath)) {
			appendUnavailable(
				claudeUnavailable,
				"structural: account_pool_not_provisioned",
			);
		} else {
			accountStore = readStoreStrict(accountStorePath);
			if (accountStore === null) {
				appendUnavailable(
					claudeUnavailable,
					"transient: account_store_unreadable",
				);
			}
		}
	} catch {
		appendUnavailable(claudeUnavailable, "transient: account_store_unreadable");
	}
	let accountEntries = accountStore?.accounts ?? [];
	let activeAccount = accountStore?.activeAccount ?? null;
	if (accountStore !== null) {
		const names = accountEntries.map((account) => account.name);
		if (
			names.some((name) => !CAPACITY_ACCOUNT_NAME.test(name)) ||
			new Set(names).size !== names.length
		) {
			accountEntries = [];
			activeAccount = null;
			appendUnavailable(claudeUnavailable, "transient: account_store_invalid");
		}
	}
	if (accountEntries.some((account) => !validAuthFlags(account))) {
		accountEntries = accountEntries.filter(validAuthFlags);
		appendUnavailable(claudeUnavailable, "transient: account_entry_invalid");
	}
	if (
		activeAccount !== null &&
		!accountEntries.some((account) => account.name === activeAccount)
	) {
		activeAccount = null;
		appendUnavailable(claudeUnavailable, "transient: account_store_invalid");
	}
	for (const account of accountEntries) {
		if (account.unavailable !== undefined) {
			appendUnavailable(
				claudeUnavailable,
				`structural: account_unavailable:${account.name}`,
			);
		}
	}
	const accounts = accountEntries.map((account) => {
		const detail = claudeDetailsByName.get(account.name);
		const manual = manualPrepaidByName.get(account.name);
		// FLY-2864: the live profile tier wins; the credential file only records
		// the tier at login time (business read 5x after an upgrade to 20x).
		const subscriptionTier =
			detail?.tier ?? readPoolSubscriptionTier(claudeProfilesDir, account.name);
		const accountObservedAt = validObservationInstant(
			account.lastObservedAt,
			nowMs,
		);
		const observedMs =
			accountObservedAt === null ? null : Date.parse(accountObservedAt);
		const ageMinutes =
			observedMs === null ? null : Math.max(0, (nowMs - observedMs) / 60_000);
		return {
			name: account.name,
			...(subscriptionTier === null ? {} : { subscriptionTier }),
			...(Number.isFinite(retirementMs(account.retiresAt))
				? { retiresAt: new Date(retirementMs(account.retiresAt)).toISOString() }
				: {}),
			active: account.name === activeAccount,
			fiveHPct: validPct(account.observedFiveHPct),
			sevenDPct: validPct(account.observedSevenDPct),
			...(account.observedFableSevenDPct === undefined
				? {}
				: { fableSevenDPct: validPct(account.observedFableSevenDPct) }),
			observedAt: accountObservedAt,
			ageMinutes,
			stale: ageMinutes === null ? null : ageMinutes > staleAfterMinutes,
			...(detail === undefined
				? {}
				: {
						subscriptionStatus: detail.subscription,
						detailObservedAt: detail.observedAt,
						usageStatus: detail.usageStatus,
						prepaid: detail.prepaid,
						...(detail.resetGrants === undefined
							? {}
							: { resetGrants: detail.resetGrants }),
					}),
			...(manual === undefined ? {} : { manualPrepaid: manual }),
			...(account.fiveHResetAt === undefined
				? {}
				: { fiveHResetAt: validInstant(account.fiveHResetAt) }),
			weeklyResetAt: validInstant(account.weeklyResetAt),
			...(account.fableWeeklyResetAt === undefined
				? {}
				: { fableWeeklyResetAt: validInstant(account.fableWeeklyResetAt) }),
			exhaustedUntil: validInstant(account.quotaExhaustedUntil),
			authUnusable:
				account.authExpired === true ||
				account.refreshTokenInvalid === true ||
				account.profileVerifyFailed === true ||
				account.unavailable !== undefined,
		};
	});
	return {
		schemaVersion: CAPACITY_SNAPSHOT_SCHEMA_VERSION,
		generatedAt: observedAt,
		disk_avail_gb: diskAvailGb,
		disk,
		memory: {
			source: "memory_pressure",
			freePct: memoryReading.freePct,
			observedAt: memoryReading.observedAt,
			tightBelowPct: CAPACITY_MEMORY_TIGHT_BELOW_PCT,
			tight:
				memoryReading.freePct === null
					? null
					: memoryReading.freePct < CAPACITY_MEMORY_TIGHT_BELOW_PCT,
			...(memoryReading.unavailable
				? { unavailable: [memoryReading.unavailable] }
				: {}),
		},
		load: probe
			? {
					load1: probe.load1,
					cpuCount: probe.cpuCount,
					perCore: probe.perCore,
					thresholdPerCore: probe.thresholdPerCore,
					observedAt,
				}
			: {
					load1: null,
					cpuCount: null,
					perCore: null,
					thresholdPerCore: null,
					observedAt: null,
					unavailable: [admissionUnavailable!],
				},
		brakes: {
			pressureHold: pressureHoldUnavailable
				? { active: null, unavailable: [pressureHoldUnavailable] }
				: pressureHold
					? (() => {
							const setAt = validSqliteUtcInstant(pressureHold.set_at);
							return setAt === undefined
								? {
										active: null,
										unavailable: ["transient: state_store_unreadable"],
									}
								: {
										active: true,
										setBy: canonicalCapacityToken(pressureHold.set_by),
										setAt,
										watermark:
											pressureHold.watermark === null
												? null
												: canonicalCapacityWatermark(pressureHold.watermark),
									};
						})()
					: { active: false },
			admissionPause: admissionPauseUnavailable
				? {
						active: null,
						remainingSeconds: null,
						unavailable: [admissionPauseUnavailable],
					}
				: admissionPause
					? {
							active: admissionPause.active,
							remainingSeconds: admissionPause.remainingSeconds,
						}
					: { active: false, remainingSeconds: 0 },
			admission: probe
				? admissionSnapshot(probe.decision)
				: { admit: null, unavailable: [admissionUnavailable!] },
			observedAt,
		},
		runners: runnersUnavailable
			? {
					running: null,
					parked: null,
					total: null,
					byProject: null,
					observedAt: null,
					unavailable: [runnersUnavailable],
				}
			: {
					running,
					parked,
					total: running + parked,
					byProject: Object.fromEntries(byProject),
					observedAt,
				},
		quota: {
			claude: {
				source: "claude-accounts.json",
				activeAccount,
				staleAfterMinutes,
				accounts,
				...(claudeUnavailable.length === 0
					? {}
					: { unavailable: claudeUnavailable }),
			},
			codex: codexStore
				? {
						source: "codex-accounts.json" as const,
						activeAccount: codexStore.activeAccount,
						staleAfterMinutes: CODEX_STALE_AFTER_MINUTES,
						accounts: codexStore.accounts.map((reading) =>
							projectCodexAccount(reading, {
								activeAccount: codexStore.activeAccount,
								nowMs,
								staleAfterMinutes: CODEX_STALE_AFTER_MINUTES,
								subscription: codexSubscriptionsByName.get(reading.name),
							}),
						),
						unavailable: [],
					}
				: {
						source: null,
						unavailable: ["structural: codex_no_usage_api"],
					},
		},
	};
}
