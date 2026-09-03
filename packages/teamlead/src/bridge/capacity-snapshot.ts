import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	defaultStorePath,
	readStoreStrict,
} from "../account-heal/account-store.js";
import {
	defaultQuotaMonitorConfigPath,
	loadQuotaMonitorConfig,
} from "../account-heal/quota-monitor-config.js";
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
				fiveHPct: number | null;
				sevenDPct: number | null;
				observedAt: string | null;
				ageMinutes: number | null;
				stale: boolean | null;
				weeklyResetAt: string | null;
				exhaustedUntil: string | null;
				authUnusable: boolean;
			}>;
			unavailable?: CapacityUnavailable;
		};
		codex: {
			source: null;
			unavailable: CapacityUnavailable;
		};
	};
}

export interface CapacitySnapshotDeps {
	store: Pick<
		StateStore,
		"getActiveSessions" | "getFleetPressureHold" | "getAdmissionPause"
	>;
	admission?: Pick<RunnerAdmissionController, "probe">;
	readMemoryFreePct: () => Promise<MemoryFreePctReading>;
	accountStorePath?: string;
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
	const quotaConfigPath =
		deps.quotaConfigPath ?? defaultQuotaMonitorConfigPath();
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
	const accounts = accountEntries.map((account) => {
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
			active: account.name === activeAccount,
			fiveHPct: validPct(account.observedFiveHPct),
			sevenDPct: validPct(account.observedSevenDPct),
			observedAt: accountObservedAt,
			ageMinutes,
			stale: ageMinutes === null ? null : ageMinutes > staleAfterMinutes,
			weeklyResetAt: validInstant(account.weeklyResetAt),
			exhaustedUntil: validInstant(account.quotaExhaustedUntil),
			authUnusable:
				account.authExpired === true ||
				account.refreshTokenInvalid === true ||
				account.profileVerifyFailed === true,
		};
	});
	return {
		schemaVersion: CAPACITY_SNAPSHOT_SCHEMA_VERSION,
		generatedAt: observedAt,
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
			codex: {
				source: null,
				unavailable: ["structural: codex_no_usage_api"],
			},
		},
	};
}
