import {
	type AccountQuotaPageContext,
	renderAccountQuotaPageHtml,
} from "./account-quota-page.js";
import type {
	CapacitySnapshot,
	CodexAccountProjection,
} from "./capacity-snapshot.js";

const MANUAL_READING_AT = "2026-09-17T23:38:00.000Z";
const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_STATUS = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIMEZONE = "America/Los_Angeles";

interface ManualAccountReading {
	name: string;
	weeklyPct: number;
	fablePct?: number;
	expiry: string;
}

const MANUAL_CLAUDE: readonly ManualAccountReading[] = [
	{ name: "shopping", weeklyPct: 80, fablePct: 79, expiry: "9/20" },
	{ name: "business", weeklyPct: 7, fablePct: 2, expiry: "10/16" },
	{ name: "personal", weeklyPct: 0, fablePct: 0, expiry: "10/4" },
	{ name: "school", weeklyPct: 0, fablePct: 0, expiry: "9/17" },
] as const;

export type QuotaCellSource = "machine" | "manual" | "missing";

export interface QuotaCell {
	display: string;
	source: QuotaCellSource;
	observedAt: string | null;
	stale: boolean;
	/** Validated machine percentage for page-only grouping/progress rendering. */
	rawValue?: number;
	/** Validated machine instant for page-only ordering/date rendering. */
	rawInstant?: string;
}

export interface AccountQuotaRow {
	provider: "Claude" | "Codex";
	name: string;
	identity: string;
	active: boolean;
	accountMissing: boolean;
	ageMinutes: number | null;
	subscriptionTier: QuotaCell;
	tokenStatus: QuotaCell;
	weeklyReset: QuotaCell;
	fiveHReset: QuotaCell;
	fableReset: QuotaCell;
	fiveHUsage: QuotaCell;
	weeklyUsage: QuotaCell;
	fableUsage: QuotaCell;
	/** Codex only: `credits` + `rateLimitResetCredits` as the RPC exposed them. */
	credits: QuotaCell;
	expiry: QuotaCell;
	/** Any machine window at 100% (Claude: also an exhausted-until in the future). */
	exhausted: boolean;
	/** Credentials cannot be used until someone re-logs in; never a quota cap. */
	unusable: boolean;
	/** Machine recovery moment for an exhausted row; null when unknown. */
	recovery: QuotaCell | null;
	/** Why this row has no fresh reading (in use, timed out, …); null when read. */
	note: string | null;
	/** The moment this row next gets better; null sorts last. FLY-2688 ordering key. */
	sortAt: string | null;
}

export const CODEX_MACHINE_SOURCE_LABEL = "机器读数 · account/rateLimits/read";
export type CodexSourceLabel = "无数值源" | typeof CODEX_MACHINE_SOURCE_LABEL;

export interface AccountQuotaView {
	generatedAt: string;
	staleAfterMinutes: number;
	claude: AccountQuotaRow[];
	codex: AccountQuotaRow[];
	codexSourceLabel: CodexSourceLabel;
	discrepancies: string[];
	warnings: string[];
	claudeUnavailable: string[];
	codexUnavailable: string[];
}

export interface AccountQuotaViewOptions {
	claudeEmails?: Readonly<Record<string, string>>;
}

type AccountQuotaSnapshot = Pick<CapacitySnapshot, "generatedAt" | "quota">;
type ClaudeAccount = CapacitySnapshot["quota"]["claude"]["accounts"][number];

function validInstant(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function assertPct(value: unknown): number | null {
	if (value === null) return null;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		value > 100
	) {
		throw new Error("invalid quota percentage");
	}
	return value;
}

function formatPct(value: number): string {
	return `${Number.isInteger(value) ? value : value.toFixed(1).replace(/\.0$/, "")}%`;
}

function formatSubscriptionTier(account: ClaudeAccount): string | null {
	const tier = account.subscriptionTier;
	if (tier === undefined) return null;
	const type = tier.subscriptionType.toLowerCase();
	const label =
		({ max: "Max", pro: "Pro", plus: "Plus" } as const)[
			type as "max" | "pro" | "plus"
		] ?? tier.subscriptionType;
	const multiplier = tier.rateLimitTier?.match(
		/^default_claude_max_(\d+)x$/i,
	)?.[1];
	return type === "max" && multiplier ? `${label} ${multiplier}x` : label;
}

function zonedParts(iso: string): Record<string, string> {
	const instant = validInstant(iso);
	if (instant === null) throw new Error("invalid quota instant");
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: TIMEZONE,
		year: "numeric",
		month: "numeric",
		day: "numeric",
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(instant));
	return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function formatReset(iso: string): string {
	const parts = zonedParts(iso);
	if (!parts.month || !parts.day) throw new Error("invalid quota date parts");
	return `${parts.month.padStart(2, "0")}-${parts.day.padStart(2, "0")} ${parts.weekday} ${parts.hour}:${parts.minute} PT`;
}

function formatExpiry(iso: string): string {
	const parts = zonedParts(iso);
	return `${parts.month}/${parts.day}`;
}

function formatCardExpiry(iso: string): string {
	const parts = zonedParts(iso);
	return `${parts.year}/${parts.month}/${parts.day}`;
}

function formatRecovery(iso: string): string {
	const parts = zonedParts(iso);
	if (!parts.month || !parts.day) throw new Error("invalid quota date parts");
	return `${parts.month.padStart(2, "0")}-${parts.day.padStart(2, "0")} ${parts.hour}:${parts.minute} PT`;
}

const NOTE_LABELS: Readonly<Record<string, string>> = {
	in_use_unshared: "使用中，本次未读",
	inventory_unavailable: "占用状态未知，本次未读",
	deadline: "本轮超时未读",
	read_failed: "本次读取失败",
	refresh_invalid: "凭据失效，需重新登录",
	token_revoked: "token 已吊销，需重新登录",
	token_expired: "token 已过期，需重新登录",
	not_logged_in: "未登录",
	invalid_credential: "凭据损坏，需重新登录",
	duplicate_email: "两个目录登录了同一账号，需删除一个",
	// Claude collapses auth expiry and an operator bench mark into one flag, so
	// the page must not instruct a re-login it cannot prove is the fix.
	auth_unusable: "凭据不可用，需人工处理",
	recovery_uncertain: "凭据写回未确认，待人工核",
	identity_mismatch: "身份不符，已跳过",
	readonly_unauthorized: "只读凭据已过期，本次未读",
	readonly_forbidden: "只读接口拒绝，本次未读",
	missing: "无凭据",
};

function noteLabel(note: string | null): string | null {
	if (note === null) return null;
	return NOTE_LABELS[note] ?? "本次未读";
}

function formatPlanType(planType: string | null): string | null {
	if (planType === null) return null;
	const label = (
		{
			max: "Max",
			pro: "Pro",
			plus: "Plus",
			free: "Free",
			team: "Team",
		} as const
	)[planType.toLowerCase() as "max" | "pro" | "plus" | "free" | "team"];
	return label ?? planType;
}

/** Earliest future reset, or the recovery moment when the row is already capped. */
function nextImprovementAt(
	input: {
		exhausted: boolean;
		recoveryAt: string | null;
		resets: readonly (string | null)[];
	},
	generatedAt: string,
): string | null {
	if (input.exhausted) return input.recoveryAt;
	const floor = Date.parse(generatedAt);
	const future = input.resets
		.flatMap((reset) => (reset === null ? [] : [Date.parse(reset)]))
		.filter((ms) => Number.isFinite(ms) && ms > floor);
	return future.length === 0
		? null
		: new Date(Math.min(...future)).toISOString();
}

function sortByNextImprovement(rows: AccountQuotaRow[]): AccountQuotaRow[] {
	return rows.sort((a, b) => {
		const left =
			a.sortAt === null ? Number.POSITIVE_INFINITY : Date.parse(a.sortAt);
		const right =
			b.sortAt === null ? Number.POSITIVE_INFINITY : Date.parse(b.sortAt);
		return left - right || a.name.localeCompare(b.name, "en-US");
	});
}

function manualStale(generatedAt: string, staleAfterMinutes: number): boolean {
	const generatedMs = Date.parse(generatedAt);
	const manualMs = Date.parse(MANUAL_READING_AT);
	return (
		Number.isFinite(generatedMs) &&
		generatedMs - manualMs > staleAfterMinutes * 60_000
	);
}

function machineCell(
	display: string,
	observedAt: string | null,
	stale: boolean,
): QuotaCell {
	return { display, source: "machine", observedAt, stale };
}

function manualCell(
	display: string,
	generatedAt: string,
	staleAfterMinutes: number,
): QuotaCell {
	return {
		display,
		source: "manual",
		observedAt: MANUAL_READING_AT,
		stale: manualStale(generatedAt, staleAfterMinutes),
	};
}

function missingCell(display = "无数据"): QuotaCell {
	return { display, source: "missing", observedAt: null, stale: false };
}

function machinePctCell(
	value: number | null,
	account: ClaudeAccount,
): QuotaCell | null {
	const pct = assertPct(value);
	if (pct === null) return null;
	const observedAt = validInstant(account.observedAt);
	return {
		...machineCell(
			formatPct(pct),
			observedAt,
			observedAt !== null && account.stale === true,
		),
		rawValue: pct,
	};
}

function machineResetCell(
	value: string | null,
	account: ClaudeAccount,
): QuotaCell | null {
	if (value === null) return null;
	const instant = validInstant(value);
	if (instant === null) throw new Error("invalid quota reset");
	const observedAt = validInstant(account.observedAt);
	return {
		...machineCell(
			formatReset(instant),
			observedAt,
			observedAt !== null && account.stale === true,
		),
		rawInstant: instant,
	};
}

function identityFor(
	name: string,
	emails: Readonly<Record<string, string>> | undefined,
): string {
	const candidate = emails?.[name]?.trim();
	if (
		candidate &&
		candidate.length <= 320 &&
		![...candidate].some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		})
	) {
		return candidate;
	}
	return name;
}

function validateClaudeAccount(account: ClaudeAccount): void {
	if (
		!ACCOUNT_NAME.test(account.name) ||
		typeof account.active !== "boolean" ||
		typeof account.authUnusable !== "boolean"
	) {
		throw new Error("invalid Claude account");
	}
	assertPct(account.fiveHPct);
	assertPct(account.sevenDPct);
	assertPct(account.fableSevenDPct ?? null);
	if (
		account.subscriptionTier !== undefined &&
		(typeof account.subscriptionTier.subscriptionType !== "string" ||
			account.subscriptionTier.subscriptionType.length === 0 ||
			(account.subscriptionTier.rateLimitTier !== null &&
				typeof account.subscriptionTier.rateLimitTier !== "string"))
	) {
		throw new Error("invalid Claude subscription tier");
	}
	if (account.observedAt === null) {
		if (account.ageMinutes !== null || account.stale !== null) {
			throw new Error("invalid unobserved Claude account");
		}
	} else if (
		validInstant(account.observedAt) === null ||
		typeof account.ageMinutes !== "number" ||
		!Number.isFinite(account.ageMinutes) ||
		account.ageMinutes < 0 ||
		typeof account.stale !== "boolean"
	) {
		throw new Error("invalid Claude observation metadata");
	}
	for (const reset of [
		account.fiveHResetAt ?? null,
		account.weeklyResetAt,
		account.fableWeeklyResetAt ?? null,
		account.exhaustedUntil,
	]) {
		if (reset !== null && validInstant(reset) === null) {
			throw new Error("invalid Claude reset instant");
		}
	}
	if (
		account.retiresAt !== undefined &&
		validInstant(account.retiresAt) === null
	) {
		throw new Error("invalid Claude retirement instant");
	}
	if (
		account.subscriptionStatus !== undefined &&
		!(["active", "canceled", "unknown"] as const).includes(
			account.subscriptionStatus,
		)
	) {
		throw new Error("invalid Claude subscription status");
	}
	if (
		account.detailObservedAt !== undefined &&
		account.detailObservedAt !== null &&
		validInstant(account.detailObservedAt) === null
	) {
		throw new Error("invalid Claude detail observation");
	}
	if (
		account.usageStatus !== undefined &&
		!SAFE_STATUS.test(account.usageStatus)
	) {
		throw new Error("invalid Claude usage status");
	}
	if (account.prepaid !== undefined) {
		if (
			typeof account.prepaid.known !== "boolean" ||
			(account.prepaid.cards !== null && !Array.isArray(account.prepaid.cards))
		) {
			throw new Error("invalid Claude prepaid detail");
		}
		for (const card of account.prepaid.cards ?? []) {
			if (
				(card.source !== "tranche" && card.source !== "promo") ||
				validInstant(card.expiresAt) === null
			) {
				throw new Error("invalid Claude prepaid card");
			}
		}
	}
	if (account.manualPrepaid !== undefined) {
		const manual = account.manualPrepaid;
		if (
			manual.account !== account.name ||
			typeof manual.confirmedBy !== "string" ||
			manual.confirmedBy.length === 0 ||
			manual.confirmedBy.length > 64 ||
			validInstant(manual.confirmedAt) === null ||
			!Array.isArray(manual.cards) ||
			manual.cards.length > 128 ||
			manual.cards.some((card) => validInstant(card.expiresAt) === null)
		) {
			throw new Error("invalid Claude manual prepaid detail");
		}
	}
}

function claudePrepaidCell(
	account: ClaudeAccount | undefined,
	generatedAt: string,
	staleAfterMinutes: number,
): QuotaCell {
	const machine = account?.prepaid;
	if (machine?.known && machine.cards !== null) {
		const observedAt = validInstant(account?.detailObservedAt ?? null);
		const stale =
			observedAt !== null &&
			Date.parse(generatedAt) - Date.parse(observedAt) >
				staleAfterMinutes * 60_000;
		const lines = machine.cards.map(
			(card, index) => `#${index + 1} 到期 ${formatCardExpiry(card.expiresAt)}`,
		);
		return machineCell(
			machine.cards.length === 0
				? "0 张"
				: `${machine.cards.length} 张\n${lines.join("\n")}`,
			observedAt,
			stale,
		);
	}
	const manual = account?.manualPrepaid;
	if (manual !== undefined) {
		const lines = manual.cards.map(
			(card, index) => `#${index + 1} 到期 ${formatCardExpiry(card.expiresAt)}`,
		);
		return {
			display: `${manual.cards.length} 张${lines.length > 0 ? `\n${lines.join("\n")}` : ""}\n确认人 ${manual.confirmedBy}`,
			source: "manual",
			observedAt: manual.confirmedAt,
			stale:
				Date.parse(generatedAt) - Date.parse(manual.confirmedAt) >
				staleAfterMinutes * 60_000,
		};
	}
	if (machine?.known) {
		const observedAt = validInstant(account?.detailObservedAt ?? null);
		return machineCell(
			"明细未提供",
			observedAt,
			observedAt !== null &&
				Date.parse(generatedAt) - Date.parse(observedAt) >
					staleAfterMinutes * 60_000,
		);
	}
	return missingCell();
}

function buildClaudeRows(
	snapshot: AccountQuotaSnapshot,
	options: AccountQuotaViewOptions,
): { rows: AccountQuotaRow[]; discrepancies: string[]; warnings: string[] } {
	const quota = snapshot.quota.claude;
	if (
		quota.source !== "claude-accounts.json" ||
		!Array.isArray(quota.accounts) ||
		typeof quota.staleAfterMinutes !== "number" ||
		!Number.isFinite(quota.staleAfterMinutes) ||
		quota.staleAfterMinutes < 0
	) {
		throw new Error("invalid Claude quota snapshot");
	}
	const byName = new Map<string, ClaudeAccount>();
	let activeName: string | null = null;
	for (const account of quota.accounts) {
		validateClaudeAccount(account);
		if (byName.has(account.name)) throw new Error("duplicate Claude account");
		byName.set(account.name, account);
		if (account.active) {
			if (activeName !== null)
				throw new Error("multiple active Claude accounts");
			activeName = account.name;
		}
	}
	if (quota.activeAccount !== activeName) {
		throw new Error("invalid active Claude account");
	}

	const manualByName = new Map(
		MANUAL_CLAUDE.map((entry) => [entry.name, entry]),
	);
	const order = [
		...MANUAL_CLAUDE.map((entry) => entry.name),
		...quota.accounts
			.map((account) => account.name)
			.filter((name) => !manualByName.has(name))
			.sort((a, b) => a.localeCompare(b, "en-US")),
	];
	const discrepancies: string[] = [];
	const warnings: string[] = [];
	const rows = order.map((name): AccountQuotaRow => {
		const account = byName.get(name);
		const manual = manualByName.get(name);
		if (!account) warnings.push(`Claude ${name}：容量快照中无该账号`);
		const weeklyMachine = account
			? machinePctCell(account.sevenDPct, account)
			: null;
		const fableMachine = account
			? machinePctCell(account.fableSevenDPct ?? null, account)
			: null;
		const fiveHMachine = account
			? machinePctCell(account.fiveHPct, account)
			: null;
		const canceled =
			account?.subscriptionStatus === "canceled" &&
			account.usageStatus !== undefined &&
			account.usageStatus !== "ok";
		const canceledObservedAt = validInstant(account?.detailObservedAt ?? null);
		const canceledStale =
			canceledObservedAt !== null &&
			Date.parse(snapshot.generatedAt) - Date.parse(canceledObservedAt) >
				quota.staleAfterMinutes * 60_000;
		const canceledCell = (rawInstant?: string | null): QuotaCell => {
			const cell = machineCell("已取消", canceledObservedAt, canceledStale);
			const instant = rawInstant == null ? null : validInstant(rawInstant);
			return instant === null ? cell : { ...cell, rawInstant: instant };
		};
		const subscriptionTier = account ? formatSubscriptionTier(account) : null;
		const expiryMachine = account?.retiresAt
			? machineCell(
					formatExpiry(account.retiresAt),
					snapshot.generatedAt,
					false,
				)
			: null;
		if (
			weeklyMachine &&
			manual &&
			weeklyMachine.display !== formatPct(manual.weeklyPct)
		) {
			discrepancies.push(
				`${name} 周用量：机器 ${weeklyMachine.display} / 手填 ${formatPct(manual.weeklyPct)}`,
			);
		}
		if (
			fableMachine &&
			manual?.fablePct !== undefined &&
			fableMachine.display !== formatPct(manual.fablePct)
		) {
			discrepancies.push(
				`${name} Fable 周用量：机器 ${fableMachine.display} / 手填 ${formatPct(manual.fablePct)}`,
			);
		}
		if (expiryMachine && manual && expiryMachine.display !== manual.expiry) {
			discrepancies.push(
				`${name} 到期：机器 ${expiryMachine.display} / 手填 ${manual.expiry}`,
			);
		}
		const exhaustedUntil = account?.exhaustedUntil ?? null;
		const cappedWindows = account
			? [
					account.fiveHPct === 100 ? (account.fiveHResetAt ?? null) : undefined,
					account.sevenDPct === 100 ? account.weeklyResetAt : undefined,
					(account.fableSevenDPct ?? null) === 100
						? (account.fableWeeklyResetAt ?? null)
						: undefined,
				].filter((reset): reset is string | null => reset !== undefined)
			: [];
		const unusable = account?.authUnusable === true;
		const exhausted =
			cappedWindows.length > 0 ||
			(exhaustedUntil !== null &&
				Date.parse(exhaustedUntil) > Date.parse(snapshot.generatedAt));
		const cappedResets = [
			...cappedWindows,
			...(exhaustedUntil === null ? [] : [exhaustedUntil]),
		];
		const recoveryAt =
			exhausted &&
			cappedResets.length > 0 &&
			cappedResets.every((r) => r !== null)
				? new Date(
						Math.max(...cappedResets.map((reset) => Date.parse(reset!))),
					).toISOString()
				: null;
		return {
			provider: "Claude",
			name,
			identity: identityFor(name, options.claudeEmails),
			active: account?.active ?? false,
			accountMissing: account === undefined,
			ageMinutes: account?.ageMinutes ?? null,
			tokenStatus: missingCell("—"),
			subscriptionTier: canceled
				? canceledCell()
				: account && subscriptionTier
					? machineCell(subscriptionTier, snapshot.generatedAt, false)
					: missingCell("未知"),
			weeklyReset: canceled
				? canceledCell(account?.weeklyResetAt)
				: account
					? (machineResetCell(account.weeklyResetAt, account) ?? missingCell())
					: missingCell(),
			fiveHReset: canceled
				? canceledCell(account?.fiveHResetAt)
				: account
					? (machineResetCell(account.fiveHResetAt ?? null, account) ??
						missingCell())
					: missingCell(),
			fableReset: canceled
				? canceledCell(account?.fableWeeklyResetAt)
				: account
					? (machineResetCell(account.fableWeeklyResetAt ?? null, account) ??
						missingCell())
					: missingCell(),
			fiveHUsage: canceled ? canceledCell() : (fiveHMachine ?? missingCell()),
			weeklyUsage: canceled
				? canceledCell()
				: (weeklyMachine ??
					(manual
						? manualCell(
								formatPct(manual.weeklyPct),
								snapshot.generatedAt,
								quota.staleAfterMinutes,
							)
						: missingCell())),
			fableUsage: canceled
				? canceledCell()
				: (fableMachine ??
					(manual?.fablePct !== undefined
						? manualCell(
								formatPct(manual.fablePct),
								snapshot.generatedAt,
								quota.staleAfterMinutes,
							)
						: missingCell())),
			credits: canceled
				? canceledCell()
				: claudePrepaidCell(
						account,
						snapshot.generatedAt,
						quota.staleAfterMinutes,
					),
			expiry: canceled
				? canceledCell()
				: (expiryMachine ??
					(manual
						? manualCell(
								manual.expiry,
								snapshot.generatedAt,
								quota.staleAfterMinutes,
							)
						: missingCell())),
			exhausted,
			unusable,
			recovery:
				exhausted && account
					? recoveryAt === null
						? missingCell("恢复时刻未知")
						: machineCell(
								formatRecovery(recoveryAt),
								validInstant(account.observedAt),
								account.stale === true,
							)
					: null,
			// An auth-dead account is not quota-capped: waiting does not fix it.
			note: unusable ? noteLabel("auth_unusable") : null,
			sortAt: unusable
				? null
				: nextImprovementAt(
						{
							exhausted,
							recoveryAt,
							resets: account
								? [
										account.fiveHResetAt ?? null,
										account.weeklyResetAt,
										account.fableWeeklyResetAt ?? null,
									]
								: [],
						},
						snapshot.generatedAt,
					),
		};
	});
	if (quota.unavailable) warnings.push(...quota.unavailable);
	return { rows, discrepancies, warnings };
}

function creditsCell(
	account: CodexAccountProjection,
	observedAt: string | null,
	stale: boolean,
): QuotaCell {
	const { resetCredits } = account;
	if (!resetCredits.known || resetCredits.availableCount === null) {
		return missingCell("兑换卡未暴露");
	}
	const count = resetCredits.availableCount;
	if (count === 0) return machineCell("0 张", observedAt, stale);
	if (resetCredits.credits === null) {
		return machineCell(`${count} 张\n明细未提供`, observedAt, stale);
	}
	const details = resetCredits.credits.map((credit, index) =>
		credit.expiresAt === null
			? `#${index + 1} 到期未知`
			: `#${index + 1} 到期 ${formatCardExpiry(credit.expiresAt)}`,
	);
	const hidden = count - resetCredits.credits.length;
	if (hidden > 0) details.push(`还有 ${hidden} 张，明细未给全`);
	return machineCell(`${count} 张\n${details.join("\n")}`, observedAt, stale);
}

function buildMachineCodexRows(
	snapshot: AccountQuotaSnapshot,
	staleAfterMinutes: number,
): {
	rows: AccountQuotaRow[];
	warnings: string[];
} {
	const codex = snapshot.quota.codex;
	const accounts = codex.accounts ?? [];
	const warnings: string[] = [...codex.unavailable];
	const rows = accounts.map((account): AccountQuotaRow => {
		if (!ACCOUNT_NAME.test(account.name)) {
			throw new Error("invalid Codex account");
		}
		const observedAt = validInstant(account.observedAt);
		const stale = observedAt !== null && account.stale === true;
		const resetCreditsObservedAt = validInstant(
			account.resetCreditsObservedAt ?? account.observedAt,
		);
		const resetCreditsStale =
			resetCreditsObservedAt !== null &&
			Date.parse(snapshot.generatedAt) - Date.parse(resetCreditsObservedAt) >
				staleAfterMinutes * 60_000;
		const pct = (value: number | null): QuotaCell =>
			value === null
				? missingCell()
				: {
						...machineCell(formatPct(assertPct(value)!), observedAt, stale),
						rawValue: value,
					};
		const reset = (value: string | null): QuotaCell => {
			if (value === null) return missingCell();
			const instant = validInstant(value);
			if (instant === null) throw new Error("invalid Codex reset");
			return {
				...machineCell(formatReset(instant), observedAt, stale),
				rawInstant: instant,
			};
		};
		const note = noteLabel(account.note);
		if (note !== null) warnings.push(`Codex ${account.name}：${note}`);
		if (account.unclassifiedWindows > 0) {
			warnings.push(
				`Codex ${account.name}：${account.unclassifiedWindows} 个窗口未给出时长，未归入 5h/周`,
			);
		}
		const planType = formatPlanType(account.planType);
		return {
			provider: "Codex" as const,
			name: account.name,
			identity: account.name,
			active: account.active,
			accountMissing: observedAt === null,
			ageMinutes: account.ageMinutes,
			tokenStatus: machineCell(account.tokenState, observedAt, stale),
			subscriptionTier:
				planType === null
					? missingCell("未知")
					: machineCell(planType, observedAt, stale),
			weeklyReset: reset(account.weeklyResetAt),
			fiveHReset: reset(account.fiveHResetAt),
			fableReset: missingCell("—"),
			fiveHUsage: pct(account.fiveHPct),
			weeklyUsage: pct(account.weeklyPct),
			fableUsage: missingCell("—"),
			credits: creditsCell(account, resetCreditsObservedAt, resetCreditsStale),
			expiry: missingCell(),
			exhausted: account.exhausted,
			unusable: account.authUnusable,
			recovery: account.exhausted
				? account.recoveryAt === null
					? missingCell("恢复时刻未知")
					: machineCell(formatRecovery(account.recoveryAt), observedAt, stale)
				: null,
			note,
			sortAt: account.authUnusable
				? null
				: nextImprovementAt(
						{
							exhausted: account.exhausted,
							recoveryAt: account.recoveryAt,
							resets: [account.fiveHResetAt, account.weeklyResetAt],
						},
						snapshot.generatedAt,
					),
		};
	});
	return { rows, warnings };
}

function buildCodexRows(
	snapshot: AccountQuotaSnapshot,
	staleAfterMinutes: number,
): {
	rows: AccountQuotaRow[];
	warnings: string[];
	label: CodexSourceLabel;
} {
	const codex = snapshot.quota.codex;
	if (codex.source === "codex-accounts.json") {
		if (!Array.isArray(codex.accounts) || !Array.isArray(codex.unavailable)) {
			throw new Error("invalid Codex quota snapshot");
		}
		return {
			...buildMachineCodexRows(snapshot, staleAfterMinutes),
			label: CODEX_MACHINE_SOURCE_LABEL,
		};
	}
	if (
		codex.source !== null ||
		!Array.isArray(codex.unavailable) ||
		codex.unavailable.length === 0
	) {
		throw new Error("invalid Codex quota snapshot");
	}
	return {
		rows: [],
		warnings: codex.unavailable,
		label: "无数值源",
	};
}

export function buildAccountQuotaView(
	snapshot: AccountQuotaSnapshot,
	options: AccountQuotaViewOptions = {},
): AccountQuotaView {
	const generatedAt = validInstant(snapshot.generatedAt);
	if (generatedAt === null) throw new Error("invalid capacity generatedAt");
	const normalized = { ...snapshot, generatedAt };
	const claude = buildClaudeRows(normalized, options);
	const codex = buildCodexRows(
		normalized,
		normalized.quota.claude.staleAfterMinutes,
	);
	return {
		generatedAt,
		staleAfterMinutes: normalized.quota.claude.staleAfterMinutes,
		claude: sortByNextImprovement(claude.rows),
		codex: sortByNextImprovement(codex.rows),
		codexSourceLabel: codex.label,
		discrepancies: claude.discrepancies,
		warnings: [...claude.warnings, ...codex.warnings],
		claudeUnavailable: [...(normalized.quota.claude.unavailable ?? [])],
		codexUnavailable: [...normalized.quota.codex.unavailable],
	};
}

function unavailableSummary(tokens: readonly string[]): string {
	const hidden = tokens.length - 2;
	return `${tokens.slice(0, 2).join("; ")}${hidden > 0 ? `; +${hidden}` : ""}`;
}

function tickPct(cell: QuotaCell): { used: string; left: string } {
	if (cell.source !== "machine") return { used: "n/a", left: "n/a" };
	const match = cell.display.match(/^(\d+(?:\.\d+)?)%$/);
	if (!match) return { used: "n/a", left: "n/a" };
	const pct = Number(match[1]);
	return { used: cell.display, left: formatPct(Math.max(0, 100 - pct)) };
}

function tickReset(cell: QuotaCell): string {
	return cell.source === "machine" ? cell.display.replace(/ PT$/, "") : "n/a";
}

function tickQuotaLine(
	window: string,
	usage: QuotaCell,
	reset: QuotaCell,
): string {
	const { used, left } = tickPct(usage);
	return `${window.padEnd(7)} ${used.padEnd(6)} ${left.padEnd(6)} ${tickReset(reset)}`;
}

function tickExpiry(cell: QuotaCell): string {
	const match = cell.display.match(/^(\d{1,2})\/(\d{1,2})$/);
	return match
		? `${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}`
		: cell.display;
}

function tickQuotaBlock(account: AccountQuotaRow): string {
	const header = `**${account.active ? "★" : ""}${account.name}**${account.expiry.source === "machine" ? ` · 到期 ${tickExpiry(account.expiry)}` : ""}${account.exhausted ? " · 打满" : ""}`;
	const age =
		account.ageMinutes === null
			? "未观测"
			: `${Math.round(account.ageMinutes)}m 前${account.weeklyUsage.stale ? " (stale)" : ""}`;
	return [
		header,
		"```text",
		"window  used   left   reset (PT)",
		tickQuotaLine("5h", account.fiveHUsage, account.fiveHReset),
		tickQuotaLine("7d", account.weeklyUsage, account.weeklyReset),
		...(account.provider === "Claude"
			? [tickQuotaLine("Fable", account.fableUsage, account.fableReset)]
			: []),
		"```",
		`观测：${age}`,
	].join("\n");
}

export function formatAccountQuotaTickLines(view: AccountQuotaView): string[] {
	const accounts = view.claude.filter((account) => !account.accountMissing);
	let claude = accounts.map(tickQuotaBlock).join("\n\n");
	if (accounts.length === 0) {
		claude = view.claudeUnavailable.length
			? `?(${unavailableSummary(view.claudeUnavailable)})`
			: "无账号";
	} else if (view.claudeUnavailable.length > 0) {
		claude += `\n⚠️(${unavailableSummary(view.claudeUnavailable)})`;
	}
	if (view.codexSourceLabel === "无数值源") {
		return ["- 额度 Claude", claude, `- Codex ${view.codexSourceLabel}`];
	}
	const codexAccounts = view.codex.filter((account) => !account.accountMissing);
	let codex =
		codexAccounts.length === 0
			? "无读数"
			: codexAccounts.map(tickQuotaBlock).join("\n\n");
	if (view.codexUnavailable.length > 0) {
		codex += `\n⚠️(${unavailableSummary(view.codexUnavailable)})`;
	}
	return ["- 额度 Claude", claude, `- Codex ${view.codexSourceLabel}`, codex];
}

export function renderAccountsPageHtml(
	view: AccountQuotaView,
	context: AccountQuotaPageContext = {},
): string {
	return renderAccountQuotaPageHtml(view, context);
}
