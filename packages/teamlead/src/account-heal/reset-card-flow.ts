/**
 * FLY-2896 — quota-daemon orchestration of the reset-card ("充值卡") flow.
 *
 *   evaluate  (H1/H2)  active ≥ askPct, no healthy direct target, an exhausted
 *                      account holds a usable card → write a proposal
 *   execute   (X)      founder approved + active at the switch line → recheck
 *                      every fact → ONE redeem POST → verify → switch → settle
 *   recover   (top)    reconcile any post-POST state a crash left behind
 *
 * Invariants (plan §3.2): never spend without her bound approval (I1); at most
 * one POST per proposal, an unconfirmed result is only ever reconciled
 * read-only (I2); the Bridge never switches or redeems (I3).
 *
 * quota-monitor.ts hands its own functions in as `MonitorOps` so this module
 * never imports it at runtime (no import cycle).
 */

import type { CandidateSelectionResult } from "./account-candidate-selector.js";
import type {
	AccountQuotaObservation,
	AccountStore,
	ResetCardRecoveryResult,
} from "./account-store.js";
import type {
	AccountSnapshot,
	MonitorCredential,
	QuotaMonitorAlertKind,
	QuotaMonitorDeps,
	RefreshNewActiveResult,
	SettleSwitchInput,
} from "./quota-monitor.js";
import type { QuotaMonitorState } from "./quota-monitor-state.js";
import { parseBlockedEpisode } from "./quota-monitor-state.js";
import {
	type AccountUsageResult,
	findModelScopedQuota,
} from "./quota-usage-api.js";
import type { CedarStatus, RedeemOutcome } from "./reset-card-contract.js";
import {
	type AuditRow,
	type AuditTerminalRow,
	auditIntentFor,
	computeProposalDigest,
	hasLiveIntentFor,
	hasTerminalRow,
	isIntentVoided,
	isTerminalStatus,
	type ProposalAccountRow,
	type ProposalStatus,
	type ResetCardConsent,
	type ResetCardFiles,
	type ResetCardProposal,
} from "./reset-card-files.js";
import { type ApprovedRedeem, bindApproval } from "./reset-card-redeem.js";
import {
	type CardCandidateInput,
	drivingWindow,
	episodeKey,
	estimateRunway,
	selectResetCardTarget,
} from "./reset-card-select.js";
import type { SwitchInput, SwitchResult } from "./switch-executor.js";

type SuccessfulUsage = Extract<AccountUsageResult, { ok: unknown }>["ok"];

const NATURAL_RESET_SOON_MS = 30 * 60_000;
const DAEMON_EXPIRY_GRACE_MS = 10 * 60_000;
const RECOVERY_JITTER_MS = 5 * 60_000;
const PROBE_DEADLINE_MS = 45_000;
const UNCONFIRMED_CHECK_SPACING_MS = 60_000;
const MAX_UNCONFIRMED_CHECKS = 3;
/**
 * A refill may take a moment to show in the usage read. Re-read on later polls
 * for this long before calling the refill failed (a read, never another POST).
 */
const RECOVERY_READ_GRACE_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Injected surfaces

export interface PoolCredentialSnapshot {
	accessToken: string;
	expiresAt: number;
	rawDigest: string;
}

export type CardStatusRead =
	| { ok: { usage: SuccessfulUsage; cedar: CedarStatus } }
	| { error: string };

export type CardProfileRead =
	| {
			ok: {
				organizationUuid: string;
				subscription: "active" | "canceled" | "unknown";
			};
	  }
	| { error: string };

export interface ResetCardRuntime {
	files: ResetCardFiles;
	/** Cached observer facts for display only; selection still uses fresh probes. */
	readAccountCards?(): Map<string, ProposalAccountRow["cards"]>;
	/** Usage + card block from one `?cedar_ember=1` read (CLI UA); never refreshes. */
	fetchCardStatus(
		accessToken: string,
		cliVersion: string,
	): Promise<CardStatusRead>;
	fetchProfile(accessToken: string): Promise<CardProfileRead>;
	readCliVersion(): Promise<string | null>;
	redeem(
		approved: ApprovedRedeem,
		request: {
			accessToken: string;
			orgUuid: string;
			cliVersion: string;
			requestId: string;
		},
	): Promise<RedeemOutcome>;
	/** Called only while withAccountsLock is held. */
	readPoolCredentialSnapshot(
		name: string,
	): Promise<PoolCredentialSnapshot | null>;
	/** Called only while withAccountsLock is held. */
	readStoreStrict(): Promise<AccountStore | null>;
	/** Called only while withAccountsLock is held. */
	commitRecovery(input: {
		name: string;
		observation: AccountQuotaObservation;
		expectedGeneration: number;
		expectedActive: string;
	}): Promise<ResetCardRecoveryResult>;
	randomUUID(): string;
}

export interface MonitorOps {
	verifyAndRankCandidates(
		deps: QuotaMonitorDeps,
		snapshot: AccountSnapshot,
	): Promise<CandidateSelectionResult>;
	readCandidateCredential(
		deps: QuotaMonitorDeps,
		snapshot: AccountSnapshot,
		name: string,
		refresh: boolean,
	): Promise<{ credential: MonitorCredential | null; reason?: string }>;
	attemptSwitch(
		deps: QuotaMonitorDeps,
		input: SwitchInput,
	): Promise<{ switched: SwitchResult }>;
	consumeApplyReports(
		deps: QuotaMonitorDeps,
		state: QuotaMonitorState,
		reports: SwitchResult["applyReports"],
	): Promise<void>;
	settle(
		deps: QuotaMonitorDeps,
		currentState: () => QuotaMonitorState,
		input: SettleSwitchInput,
		attemptedKinds: Set<QuotaMonitorAlertKind>,
		hooks: {
			clampReviveRetirement: () => void;
			afterPersist: () => Promise<unknown>;
		},
	): Promise<void>;
	refreshNewActive(
		deps: QuotaMonitorDeps,
		state: QuotaMonitorState,
		expectedName: string,
	): Promise<RefreshNewActiveResult>;
}

export interface ResetCardContext {
	deps: QuotaMonitorDeps;
	rc: ResetCardRuntime;
	ops: MonitorOps;
	getState(): QuotaMonitorState;
	attemptedKinds: Set<QuotaMonitorAlertKind>;
	hooks: {
		clampReviveRetirement: () => void;
		afterPersist: () => Promise<unknown>;
	};
}

// ---------------------------------------------------------------------------
// Small helpers

const STATUS_ZH: Partial<Record<ProposalStatus, string>> = {
	failed: "用卡失败",
	redeem_ambiguous: "用卡后状态不确定，请人工核对",
	redeemed_switch_failed: "已用卡但切号没成",
	switched_unverified: "已用卡并切号，但切后读数未确认",
};

const lastEvaluation = new WeakMap<
	ResetCardRuntime,
	{ episodeKey: string; at: number; line: string }
>();

function nowIso(ctx: ResetCardContext): string {
	return new Date(ctx.deps.now()).toISOString();
}

function config(ctx: ResetCardContext) {
	return ctx.deps.config.config;
}

function safeReason(value: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9_:]+/g, "_")
		.replace(/^[^a-z]+/, "");
	return (normalized || "unknown").slice(0, 96);
}

function toObservation(
	usage: SuccessfulUsage,
	observedAtMs: number,
): AccountQuotaObservation {
	const fable = findModelScopedQuota(usage.raw, "Fable");
	return {
		fiveHPct: usage.fiveH.pct,
		sevenDPct: usage.sevenD.pct,
		fiveHResetAt: usage.fiveH.resetsAt,
		sevenDResetAt: usage.sevenD.resetsAt,
		fableSevenDPct: fable?.pct ?? null,
		fableSevenDResetAt: fable?.resetsAt ?? null,
		observedAt: new Date(observedAtMs).toISOString(),
	};
}

function canonicalInstant(value: string | null): string | null {
	if (value === null) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function windowsOf(usage: SuccessfulUsage) {
	return {
		fiveHPct: usage.fiveH.pct,
		sevenDPct: usage.sevenD.pct,
		fiveHResetAt: canonicalInstant(usage.fiveH.resetsAt),
		sevenDResetAt: canonicalInstant(usage.sevenD.resetsAt),
	};
}

async function safeAlert(
	ctx: ResetCardContext,
	title: string,
	body: string,
	signature: string,
): Promise<void> {
	try {
		await ctx.deps.alert({
			kind: "quota_no_target",
			severity: "severe",
			title,
			body,
			signature,
		});
	} catch (error) {
		ctx.deps.log(
			`reset_card alert failed: ${error instanceof Error ? error.name : "unknown"}`,
		);
	}
}

function day(ctx: ResetCardContext): string {
	return nowIso(ctx).slice(0, 10);
}

/** Consent that belongs to exactly this proposal; anything else is "none". */
function boundConsent(
	ctx: ResetCardContext,
	proposal: ResetCardProposal,
): ResetCardConsent | null {
	const read = ctx.rc.files.readConsent();
	if (read.status !== "ok") return null;
	return read.value.proposalId === proposal.proposalId &&
		read.value.digest === proposal.digest
		? read.value
		: null;
}

function save(
	ctx: ResetCardContext,
	proposal: ResetCardProposal,
	patch: Partial<ResetCardProposal>,
): ResetCardProposal {
	const next: ResetCardProposal = {
		...proposal,
		...patch,
		statusAt: nowIso(ctx),
	};
	ctx.rc.files.writeProposal(next);
	return next;
}

/** The audit as rows; absent is empty, invalid is null (callers fail closed). */
function auditRowsOrNull(ctx: ResetCardContext): AuditRow[] | null {
	const read = ctx.rc.files.readAudit();
	if (read.status === "invalid") return null;
	return read.status === "ok" ? read.value : [];
}

interface TerminalExtra {
	targetAfter?: { fiveHPct: number; sevenDPct: number } | null;
	redeemProven?: boolean | null;
	switch?: { outcome: string; generation: number | null } | null;
}

/**
 * Enter a terminal status. Order is the durability contract: (F1) void a
 * provably-unsent intent, then append + fsync the audit terminal row, and only
 * then persist the terminal proposal.
 */
async function finalize(
	ctx: ResetCardContext,
	proposal: ResetCardProposal,
	status: ProposalStatus,
	reason: string | null,
	extra: TerminalExtra = {},
): Promise<ResetCardProposal> {
	const rows = auditRowsOrNull(ctx);
	if (rows === null) throw new Error("reset-card audit unusable");
	const intent = auditIntentFor(rows, proposal.proposalId);
	// POST happens only after `executing` is durable, so an awaiting proposal
	// with an intent row provably never sent its request.
	if (
		proposal.status === "awaiting_consent" &&
		intent !== null &&
		!isIntentVoided(rows, proposal.proposalId)
	) {
		ctx.rc.files.appendAudit({
			at: nowIso(ctx),
			kind: "voided",
			proposalId: proposal.proposalId,
			requestId: intent.requestId,
			reason: "aborted_before_post",
		});
	}
	if (!hasTerminalRow(rows, proposal.proposalId)) {
		const consent = boundConsent(ctx, proposal);
		const row: AuditTerminalRow = {
			at: nowIso(ctx),
			kind: "terminal",
			proposalId: proposal.proposalId,
			episodeKey: proposal.episodeKey,
			outcome: status,
			reason: reason === null ? null : safeReason(reason),
			active: {
				name: proposal.active.name,
				fiveHPct: proposal.active.fiveHPct,
				sevenDPct: proposal.active.sevenDPct,
			},
			target: {
				name: proposal.target.name,
				before: {
					fiveHPct: proposal.target.fiveHPct,
					sevenDPct: proposal.target.sevenDPct,
				},
				after: extra.targetAfter ?? null,
			},
			grant: {
				id: proposal.grant.id,
				resetsLeftBefore: proposal.grant.resetsLeftBefore,
				resetsLeftAfter: proposal.redeem?.resetsLeftAfter ?? null,
			},
			requestId: proposal.redeem?.requestId ?? intent?.requestId ?? null,
			redeemResult:
				proposal.redeem?.result === null || proposal.redeem === null
					? null
					: safeReason(proposal.redeem.result),
			redeemProven: extra.redeemProven ?? null,
			consent:
				consent === null
					? null
					: {
							state: consent.state,
							founderId: consent.founderId,
							decidedAt: consent.decidedAt,
							channelId: consent.channelId,
							messageId: consent.messageId,
						},
			switch: extra.switch ?? null,
		};
		ctx.rc.files.appendAudit(row);
	}
	const finished = save(ctx, proposal, {
		status,
		statusReason: reason === null ? null : safeReason(reason),
	});
	const zh = STATUS_ZH[status];
	if (zh !== undefined) {
		await safeAlert(
			ctx,
			`Claude 充值卡：${zh}`,
			[
				`target=${proposal.target.name}; status=${status}; reason=${finished.statusReason ?? "none"}`,
				`request_id=${proposal.redeem?.requestId ?? "none"}; proposal=${proposal.proposalId}`,
				"审计：~/.flywheel/claude-quota/reset-card-audit.jsonl",
			].join("\n"),
			`reset-card-${proposal.proposalId}-${status}`,
		);
	}
	ctx.deps.log(
		JSON.stringify({
			event: "reset_card_terminal",
			proposalId: proposal.proposalId,
			status,
			reason: finished.statusReason,
		}),
	);
	return finished;
}

function readProposalFailClosed(
	ctx: ResetCardContext,
):
	| { kind: "none" }
	| { kind: "ok"; proposal: ResetCardProposal }
	| { kind: "invalid" } {
	const read = ctx.rc.files.readProposal();
	if (read.status === "absent") return { kind: "none" };
	if (read.status === "invalid") return { kind: "invalid" };
	return { kind: "ok", proposal: read.value };
}

async function alertInvalidProposal(ctx: ResetCardContext): Promise<void> {
	await safeAlert(
		ctx,
		"Claude 充值卡：提议文件损坏，已停用自动征询",
		"reset-card-proposal.json 存在但校验失败；本功能停用（不征询、不执行），请人工核对 audit 后修复或删除该文件",
		`reset-card-proposal-invalid-${day(ctx)}`,
	);
}

async function alertInvalidAudit(ctx: ResetCardContext): Promise<void> {
	await safeAlert(
		ctx,
		"Claude 充值卡：审计文件不可读，已停用自动征询",
		"reset-card-audit.jsonl 有截断/畸形行或超限；自动切号暂停。请人工核对并修复审计后自动恢复，或手动切号；不要重发兑卡请求",
		`reset-card-audit-invalid-${day(ctx)}`,
	);
}

/** Windows that were capped when the proposal was written. */
function cappedWindows(proposal: ResetCardProposal): {
	five: boolean;
	seven: boolean;
} {
	return {
		five:
			proposal.target.fiveHPct >= 100 ||
			proposal.target.exhausted.includes("five_hour"),
		seven:
			proposal.target.sevenDPct >= 100 ||
			proposal.target.exhausted.includes("seven_day") ||
			proposal.target.exhausted.includes("seven_day_overage_included"),
	};
}

function windowsRecovered(
	ctx: ResetCardContext,
	proposal: ResetCardProposal,
	usage: SuccessfulUsage,
): boolean {
	const capped = cappedWindows(proposal);
	if (!capped.five && !capped.seven) return false;
	return (
		(!capped.five || usage.fiveH.pct < config(ctx).trigger5hPct) &&
		(!capped.seven || usage.sevenD.pct < 100)
	);
}

// ---------------------------------------------------------------------------
// Candidate probing (evaluate + execution recheck)

interface ProbedCandidates {
	inputs: CardCandidateInput[];
	refused: Array<{ name: string; reason: string }>;
	orgUuid: Map<string, string>;
	targetCredential: PoolCredentialSnapshot | null;
	abort?: string;
}

async function probeCardCandidates(
	ctx: ResetCardContext,
	snapshot: AccountSnapshot,
	candidates: CandidateSelectionResult,
	cliVersion: string,
	refreshTarget: string | null,
): Promise<ProbedCandidates> {
	const started = ctx.deps.now();
	const out: ProbedCandidates = {
		inputs: [],
		refused: [],
		orgUuid: new Map(),
		targetCredential: null,
	};
	const names = candidates.panorama
		.filter(
			(entry) =>
				entry.excludedBy === "quota" || entry.excludedBy === "cooldown",
		)
		.map((entry) => entry.name);
	for (const name of names) {
		if (ctx.deps.now() - started > PROBE_DEADLINE_MS) {
			out.refused.push({ name, reason: "deadline" });
			continue;
		}
		const refresh = name === refreshTarget;
		const checked = await ctx.ops.readCandidateCredential(
			ctx.deps,
			snapshot,
			name,
			refresh,
		);
		if (checked.reason === "active_witness_changed") {
			return { ...out, abort: "active_changed" };
		}
		let token = checked.credential?.accessToken ?? null;
		let expiresAt = checked.credential?.expiresAt ?? 0;
		if (refresh && checked.credential !== null) {
			// The digest binds the exact credential the redeem will use (§5.4-4).
			const snap = await ctx.deps.withAccountsLock(() =>
				ctx.rc.readPoolCredentialSnapshot(name),
			);
			out.targetCredential = snap;
			token = snap?.accessToken ?? null;
			expiresAt = snap?.expiresAt ?? 0;
		}
		if (token === null || expiresAt <= ctx.deps.now()) {
			out.refused.push({ name, reason: "credential_unavailable" });
			continue;
		}
		const [profile, status] = await Promise.all([
			ctx.rc.fetchProfile(token),
			ctx.rc.fetchCardStatus(token, cliVersion),
		]);
		if ("error" in profile) {
			out.refused.push({ name, reason: `profile_${profile.error}` });
			continue;
		}
		if ("error" in status) {
			out.refused.push({ name, reason: `status_${status.error}` });
			continue;
		}
		out.orgUuid.set(name, profile.ok.organizationUuid);
		out.inputs.push({
			name,
			usage: status.ok.usage,
			cedar: status.ok.cedar,
			subscription: profile.ok.subscription,
		});
	}
	return out;
}

function proposalAccountRows(
	ctx: ResetCardContext,
	snapshot: AccountSnapshot,
	activeUsage: SuccessfulUsage,
	inputs: CardCandidateInput[],
): ProposalAccountRow[] {
	const cached = ctx.rc.readAccountCards?.() ?? new Map();
	return snapshot.store.accounts.map((account) => {
		const input = inputs.find((entry) => entry.name === account.name);
		const usage =
			account.name === snapshot.activeName ? activeUsage : input?.usage;
		const fiveHPct = usage?.fiveH.pct ?? account.observedFiveHPct ?? null;
		const sevenDPct = usage?.sevenD.pct ?? account.observedSevenDPct ?? null;
		const fiveReset = canonicalInstant(
			usage?.fiveH.resetsAt ?? account.fiveHResetAt ?? null,
		);
		const sevenReset = canonicalInstant(
			usage?.sevenD.resetsAt ?? account.weeklyResetAt ?? null,
		);
		const capped = [
			...(fiveHPct !== null && fiveHPct >= 100 ? [fiveReset] : []),
			...(sevenDPct !== null && sevenDPct >= 100 ? [sevenReset] : []),
		];
		const recoveryAt =
			capped.length > 0
				? capped.includes(null)
					? null
					: [...capped].sort().at(-1)!
				: fiveHPct !== null && fiveHPct >= config(ctx).resetCardAskPct
					? fiveReset
					: sevenDPct !== null && sevenDPct >= config(ctx).resetCardAskPct
						? sevenReset
						: (canonicalInstant(account.quotaExhaustedUntil) ??
							fiveReset ??
							sevenReset);
		const cards =
			input === undefined
				? (cached.get(account.name) ?? null)
				: input.cedar.grants.map((grant) => ({
						count: grant.resetsLeft,
						endsAt: grant.endsAt,
					}));
		return {
			name: account.name,
			fiveHPct,
			sevenDPct,
			recoveryAt,
			cards:
				cards === null
					? null
					: cards.filter(
							(card: { count: number; endsAt: string | null }) =>
								card.count > 0 &&
								(card.endsAt === null ||
									Date.parse(card.endsAt) > ctx.deps.now()),
						),
		};
	});
}

function hasHealthyCandidate(candidates: CandidateSelectionResult): boolean {
	return candidates.ranked.length > 0 && !candidates.headroomDegraded;
}

function statusLine(
	ctx: ResetCardContext,
	proposal: ResetCardProposal,
): string {
	if (proposal.status === "awaiting_consent") {
		const consent = boundConsent(ctx, proposal);
		return consent?.state === "approved"
			? "reset_card: approved_pending_trigger"
			: `reset_card: awaiting ${proposal.target.name}`;
	}
	if (isTerminalStatus(proposal.status)) {
		return `reset_card: ${proposal.status}`;
	}
	return "reset_card: in_progress";
}

// ---------------------------------------------------------------------------
// H1 / H2 — evaluate and propose

export async function evaluateResetCardAsk(
	ctx: ResetCardContext,
	input: {
		snapshot: AccountSnapshot;
		usage: SuccessfulUsage;
		/** H2 passes the round's verified candidates; H1 verifies its own. */
		candidates: CandidateSelectionResult | null;
	},
): Promise<string> {
	const { snapshot, usage } = input;
	const cfg = config(ctx);
	if (snapshot.activeName === null) return "reset_card: none:active_unknown";
	const existing = readProposalFailClosed(ctx);
	if (existing.kind === "invalid") {
		await alertInvalidProposal(ctx);
		return "reset_card: none:proposal_invalid";
	}
	const auditRows = auditRowsOrNull(ctx);
	if (auditRows === null) {
		await alertInvalidAudit(ctx);
		return "reset_card: none:audit_invalid";
	}
	// One threshold for H1, H2, review and execution, so all compute the same
	// episode (H1 only fires when askPct < trigger5hPct anyway).
	const driving = drivingWindow(
		usage,
		Math.min(cfg.resetCardAskPct, cfg.trigger5hPct),
	);
	if (driving === null) return "reset_card: none:below_ask";
	if (driving.resetAt === null) return "reset_card: none:no_reset_time";
	const resetMs = Date.parse(driving.resetAt);
	const now = ctx.deps.now();
	if (!Number.isFinite(resetMs)) return "reset_card: none:no_reset_time";
	if (resetMs - now < NATURAL_RESET_SOON_MS) {
		ctx.deps.log("reset_card skip:natural_reset_soon");
		return "reset_card: none:natural_reset_soon";
	}
	const key = episodeKey(
		snapshot.activeName,
		snapshot.store.generation,
		driving.window,
		new Date(resetMs).toISOString(),
	);
	if (existing.kind === "ok") {
		const current = existing.proposal;
		if (current.episodeKey === key && current.status !== "cancelled") {
			return statusLine(ctx, current);
		}
		if (!isTerminalStatus(current.status)) {
			if (current.status !== "awaiting_consent") {
				return "reset_card: in_progress";
			}
			// A different episode (e.g. the 5h window reset and the week took
			// over): the old ask no longer describes the facts.
			await finalize(ctx, current, "cancelled", "facts_changed:episode");
		}
	}
	const cached = lastEvaluation.get(ctx.rc);
	if (
		cached !== undefined &&
		cached.episodeKey === key &&
		now - cached.at < cfg.candidateSweepMinutes * 60_000
	) {
		return cached.line;
	}
	const remember = (line: string): string => {
		lastEvaluation.set(ctx.rc, { episodeKey: key, at: now, line });
		return line;
	};
	const candidates =
		input.candidates ??
		(await ctx.ops.verifyAndRankCandidates(ctx.deps, snapshot));
	if (hasHealthyCandidate(candidates)) {
		return remember("reset_card: none:direct_candidate");
	}
	const cliVersion = await ctx.rc.readCliVersion();
	if (cliVersion === null)
		return remember("reset_card: none:cli_version_unknown");
	const probed = await probeCardCandidates(
		ctx,
		snapshot,
		candidates,
		cliVersion,
		null,
	);
	if (probed.abort !== undefined) return `reset_card: none:${probed.abort}`;
	const selection = selectResetCardTarget(probed.inputs, now);
	if ("none" in selection) {
		const reasons = [...probed.refused, ...selection.none]
			.slice(0, 6)
			.map((entry) => `${entry.name}=${entry.reason}`)
			.join(", ");
		return remember(
			`reset_card: none:${reasons === "" ? "no_card_candidates" : reasons}`,
		);
	}
	if (hasLiveIntentFor(auditRows, selection.target.name, selection.grant.id)) {
		await safeAlert(
			ctx,
			"Claude 充值卡：这张卡已有未完结的领卡记录，不再征询",
			`target=${selection.target.name}; grant=${selection.grant.id}; 审计里已有该号该卡的 intent 行（可能已发出过领卡请求），请人工核对`,
			`reset-card-intent-recorded-${selection.target.name}-${selection.grant.id}`,
		);
		return remember("reset_card: none:intent_recorded");
	}
	const createdAt = new Date(now).toISOString();
	const core = {
		accountRows: proposalAccountRows(ctx, snapshot, usage, probed.inputs),
		schemaVersion: 1 as const,
		proposalId: ctx.rc.randomUUID(),
		episodeKey: key,
		createdAt,
		expiresAt: new Date(
			now + cfg.resetCardConsentMinutes * 60_000,
		).toISOString(),
		status: "awaiting_consent" as const,
		statusReason: null,
		statusAt: createdAt,
		active: {
			name: snapshot.activeName,
			generation: snapshot.store.generation,
			drivingWindow: driving.window,
			switchAtPct: Math.min(100, cfg.trigger5hPct),
			...windowsOf(usage),
		},
		target: {
			name: selection.target.name,
			recoveryAt: selection.recoveryAt,
			exhausted: [...selection.target.cedar.exhausted],
			...windowsOf(selection.target.usage),
		},
		grant: {
			id: selection.grant.id,
			endsAt: selection.grant.endsAt,
			clears: [...selection.grant.clears],
			resetsLeftBefore: selection.grant.resetsLeft,
			cardsLeftTotal: selection.cardsLeft,
		},
		runway: estimateRunway(usage, now),
		redeem: null,
		switchIntent: null,
		blockedEpisodeAtSwitch: null,
	};
	const proposal: ResetCardProposal = {
		...core,
		digest: computeProposalDigest(core),
	};
	ctx.rc.files.writeProposal(proposal);
	lastEvaluation.delete(ctx.rc);
	ctx.deps.log(
		JSON.stringify({
			event: "reset_card_proposed",
			proposalId: proposal.proposalId,
			active: proposal.active.name,
			target: proposal.target.name,
			recoveryAt: proposal.target.recoveryAt,
		}),
	);
	return `reset_card: proposed ${proposal.target.name}`;
}

// ---------------------------------------------------------------------------
// Every usage poll: bind founder decisions, cheap staleness review

export async function reviewResetCardProposal(
	ctx: ResetCardContext,
	snapshot: AccountSnapshot,
	usage: SuccessfulUsage,
): Promise<void> {
	const read = readProposalFailClosed(ctx);
	if (read.kind !== "ok") return;
	const proposal = read.proposal;
	if (proposal.status !== "awaiting_consent") return;
	const consent = boundConsent(ctx, proposal);
	if (
		consent !== null &&
		(consent.state === "rejected" ||
			consent.state === "expired" ||
			consent.state === "post_failed")
	) {
		await finalize(ctx, proposal, consent.state, consent.reason);
		return;
	}
	if (
		proposal.active.name !== snapshot.activeName ||
		proposal.active.generation !== snapshot.store.generation
	) {
		await finalize(ctx, proposal, "cancelled", "active_changed");
		return;
	}
	const askPct = Math.min(
		config(ctx).resetCardAskPct,
		config(ctx).trigger5hPct,
	);
	if (usage.fiveH.pct < askPct && usage.sevenD.pct < askPct) {
		await finalize(ctx, proposal, "cancelled", "active_recovered");
		return;
	}
	const decided = consent?.state === "approved";
	if (
		!decided &&
		ctx.deps.now() > Date.parse(proposal.expiresAt) + DAEMON_EXPIRY_GRACE_MS
	) {
		await finalize(ctx, proposal, "expired", "bridge_silent");
	}
}

/** Local-only: an approved, bound consent forces this poll's usage read (B3). */
export function resetCardExecutionPending(rc: ResetCardRuntime): boolean {
	try {
		const read = rc.files.readProposal();
		if (read.status !== "ok" || read.value.status !== "awaiting_consent") {
			return false;
		}
		const consent = rc.files.readConsent();
		return (
			consent.status === "ok" &&
			consent.value.proposalId === read.value.proposalId &&
			consent.value.digest === read.value.digest &&
			consent.value.state === "approved"
		);
	} catch {
		return false;
	}
}

/** A durable post-POST state owns switching until recovery reaches a terminal outcome. */
export function resetCardSwitchPending(rc: ResetCardRuntime): boolean {
	try {
		const read = rc.files.readProposal();
		return (
			read.status === "ok" &&
			read.value.status !== "awaiting_consent" &&
			!isTerminalStatus(read.value.status)
		);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// X — execute an approved proposal at the switch line

export async function executeApprovedResetCard(
	ctx: ResetCardContext,
	snapshot: AccountSnapshot,
	usage: SuccessfulUsage,
	trigger: { scope: "5h" | "weekly" | "both"; resetAt: string },
): Promise<"switched" | "continue"> {
	const read = readProposalFailClosed(ctx);
	if (read.kind !== "ok") return "continue";
	let proposal = read.proposal;
	if (proposal.status !== "awaiting_consent") return "continue";
	const consent = boundConsent(ctx, proposal);
	if (consent === null || consent.state !== "approved") return "continue";
	const bound = bindApproval(proposal, consent);
	if ("refused" in bound) {
		ctx.deps.log(`reset_card bind_refused:${bound.refused}`);
		return "continue";
	}
	if (!config(ctx).resetCardEnabled) return "continue";
	if (snapshot.activeName === null) return "continue";

	// Step 4 — re-run the selection with live facts (outside the lock).
	const cancel = async (reason: string): Promise<"continue"> => {
		await finalize(ctx, proposal, "cancelled", reason);
		return "continue";
	};
	if (
		proposal.active.name !== snapshot.activeName ||
		proposal.active.generation !== snapshot.store.generation
	) {
		return cancel("active_changed");
	}
	// She approved "switch at N%": a different live switch line is a new fact.
	if (Math.min(100, config(ctx).trigger5hPct) !== proposal.active.switchAtPct) {
		return cancel("facts_changed:switch_line");
	}
	const candidates = await ctx.ops.verifyAndRankCandidates(ctx.deps, snapshot);
	if (hasHealthyCandidate(candidates))
		return cancel("direct_candidate_appeared");
	const driving = drivingWindow(
		usage,
		Math.min(config(ctx).resetCardAskPct, config(ctx).trigger5hPct),
	);
	const resetMs = Date.parse(driving?.resetAt ?? "");
	if (
		driving === null ||
		!Number.isFinite(resetMs) ||
		episodeKey(
			snapshot.activeName,
			snapshot.store.generation,
			driving.window,
			new Date(resetMs).toISOString(),
		) !== proposal.episodeKey
	) {
		return cancel("facts_changed:episode");
	}
	const cliVersion = await ctx.rc.readCliVersion();
	if (cliVersion === null) return cancel("facts_changed:cli_version");
	const probed = await probeCardCandidates(
		ctx,
		snapshot,
		candidates,
		cliVersion,
		proposal.target.name,
	);
	if (probed.abort !== undefined) return cancel(probed.abort);
	const selection = selectResetCardTarget(probed.inputs, ctx.deps.now());
	if ("none" in selection) return cancel("facts_changed:no_target");
	const sorted = (keys: readonly string[]) => JSON.stringify([...keys].sort());
	const mismatch =
		selection.target.name !== proposal.target.name
			? "target"
			: selection.grant.id !== proposal.grant.id
				? "grant"
				: selection.grant.endsAt !== proposal.grant.endsAt
					? "grant_ends"
					: sorted(selection.grant.clears) !== sorted(proposal.grant.clears)
						? "clears"
						: sorted(selection.target.cedar.exhausted) !==
								sorted(proposal.target.exhausted)
							? "exhausted"
							: Math.abs(
										Date.parse(selection.recoveryAt) -
											Date.parse(proposal.target.recoveryAt),
									) > RECOVERY_JITTER_MS
								? "recovery"
								: selection.cardsLeft !== proposal.grant.cardsLeftTotal
									? "cards_left"
									: null;
	if (mismatch !== null) return cancel(`facts_changed:${mismatch}`);
	const targetCredential = probed.targetCredential;
	const orgUuid = probed.orgUuid.get(proposal.target.name);
	if (targetCredential === null || orgUuid === undefined) {
		return cancel("facts_changed:target_credential");
	}

	// Step 5 — linearization point under the accounts lock.
	const linearized = await ctx.deps.withAccountsLock(async () => {
		const witness = await ctx.deps.readSnapshot();
		const activeSame =
			witness.activeName === snapshot.activeName &&
			witness.store.generation === snapshot.store.generation &&
			(witness.activeCredential?.rawDigest !== undefined &&
			snapshot.activeCredential?.rawDigest !== undefined
				? witness.activeCredential.rawDigest ===
					snapshot.activeCredential.rawDigest
				: witness.activeCredential?.accessToken ===
					snapshot.activeCredential?.accessToken);
		if (!activeSame) return { cancel: "active_changed" };
		const target = await ctx.rc.readPoolCredentialSnapshot(
			proposal.target.name,
		);
		if (target === null || target.rawDigest !== targetCredential.rawDigest) {
			return { cancel: "facts_changed:target_credential" };
		}
		const again = ctx.rc.files.readProposal();
		const againConsent = ctx.rc.files.readConsent();
		if (
			again.status !== "ok" ||
			again.value.proposalId !== proposal.proposalId ||
			again.value.status !== "awaiting_consent" ||
			againConsent.status !== "ok" ||
			againConsent.value.proposalId !== proposal.proposalId ||
			againConsent.value.state !== "approved"
		) {
			return { cancel: "consent_changed" };
		}
		if (!config(ctx).resetCardEnabled) return { cancel: "disabled" };
		const rows = auditRowsOrNull(ctx);
		if (rows === null) return { cancel: "audit_invalid" };
		const prior = auditIntentFor(rows, proposal.proposalId);
		if (prior !== null && isIntentVoided(rows, proposal.proposalId)) {
			return { cancel: "intent_voided" };
		}
		if (
			prior !== null &&
			(prior.target !== proposal.target.name ||
				prior.grantId !== proposal.grant.id)
		) {
			return { fail: "intent_mismatch" };
		}
		const requestId = prior?.requestId ?? ctx.rc.randomUUID();
		if (prior === null) {
			ctx.rc.files.appendAudit({
				at: nowIso(ctx),
				kind: "intent",
				proposalId: proposal.proposalId,
				target: proposal.target.name,
				grantId: proposal.grant.id,
				requestId,
			});
		}
		const executing = save(ctx, proposal, {
			status: "executing",
			statusReason: null,
			redeem: {
				requestId,
				startedAt: nowIso(ctx),
				result: null,
				cause: null,
				resetsLeftAfter: null,
				unconfirmedChecks: 0,
			},
			switchIntent: {
				from: snapshot.activeName as string,
				to: proposal.target.name,
				generationBefore: snapshot.store.generation,
				expectedGeneration: snapshot.store.generation + 1,
				trigger: {
					scope: trigger.scope,
					resetAt: new Date(Date.parse(trigger.resetAt)).toISOString(),
				},
				targetDigest: targetCredential.rawDigest,
				verifiedAt: null,
			},
		});
		return { executing, token: target.accessToken, requestId };
	});
	if ("cancel" in linearized) return cancel(linearized.cancel as string);
	if ("fail" in linearized) {
		await finalize(ctx, proposal, "failed", linearized.fail as string);
		return "continue";
	}
	proposal = linearized.executing;

	// Step 6 — the single POST.
	let outcome: RedeemOutcome;
	try {
		outcome = await ctx.rc.redeem(bound.ok, {
			accessToken: linearized.token,
			orgUuid,
			cliVersion,
			requestId: linearized.requestId,
		});
	} catch {
		outcome = { kind: "unconfirmed", cause: "network" };
	}
	ctx.deps.log(
		JSON.stringify({
			event: "reset_card_redeem",
			proposalId: proposal.proposalId,
			outcome: outcome.kind,
		}),
	);
	return afterRedeem(ctx, proposal, outcome);
}

async function afterRedeem(
	ctx: ResetCardContext,
	proposal: ResetCardProposal,
	outcome: RedeemOutcome,
): Promise<"switched" | "continue"> {
	const redeem = proposal.redeem;
	if (redeem === null) return "continue";
	switch (outcome.kind) {
		case "reset": {
			const confirmed = save(ctx, proposal, {
				status: "redeem_confirmed",
				redeem: {
					...redeem,
					result: "reset",
					resetsLeftAfter: outcome.resetsLeft,
				},
			});
			return verifyAndSwitch(ctx, confirmed, true);
		}
		case "not_spent": {
			// No intermediate write: finalize persists the result with the
			// terminal status (audit row first), so a crash cannot turn a proven
			// "not spent" into an unconfirmed POST.
			await finalize(
				ctx,
				{
					...proposal,
					redeem: { ...redeem, result: "not_spent", cause: outcome.cause },
				},
				"failed",
				`not_spent:${outcome.cause}`,
				{ redeemProven: false },
			);
			return "continue";
		}
		case "already_used": {
			const used = save(ctx, proposal, {
				status: "grant_already_used",
				redeem: { ...redeem, result: "already_used" },
			});
			return resolveAlreadyUsed(ctx, used);
		}
		case "unconfirmed": {
			save(ctx, proposal, {
				status: "redeem_unconfirmed",
				redeem: { ...redeem, result: "unconfirmed", cause: outcome.cause },
			});
			return "continue";
		}
	}
}

/** Read the target's usage through the credential bound at the intent. */
async function readBoundTarget(
	ctx: ResetCardContext,
	proposal: ResetCardProposal,
): Promise<
	| { ok: PoolCredentialSnapshot }
	| { credential_changed: true }
	| { unavailable: true }
> {
	const intent = proposal.switchIntent;
	if (intent === null) return { unavailable: true };
	const snap = await ctx.deps.withAccountsLock(() =>
		ctx.rc.readPoolCredentialSnapshot(intent.to),
	);
	if (snap === null) return { unavailable: true };
	if (snap.rawDigest !== intent.targetDigest)
		return { credential_changed: true };
	return { ok: snap };
}

async function resolveAlreadyUsed(
	ctx: ResetCardContext,
	proposal: ResetCardProposal,
): Promise<"switched" | "continue"> {
	const target = await readBoundTarget(ctx, proposal);
	if ("credential_changed" in target) {
		await finalize(ctx, proposal, "redeem_ambiguous", "credential_changed");
		return "continue";
	}
	if ("unavailable" in target) return "continue";
	const usage = await ctx.deps.fetchUsage(target.ok.accessToken);
	if (!("ok" in usage)) return "continue";
	if (!windowsRecovered(ctx, proposal, usage.ok)) {
		await finalize(ctx, proposal, "failed", "already_used_not_recovered", {
			targetAfter: {
				fiveHPct: usage.ok.fiveH.pct,
				sevenDPct: usage.ok.sevenD.pct,
			},
		});
		return "continue";
	}
	const recovered = save(ctx, proposal, {
		status: "recovered_without_proven_redeem",
	});
	return verifyAndSwitch(ctx, recovered, null);
}

/** Step 7 — read-only reconciliation of an unconfirmed POST (never resends). */
async function reconcileUnconfirmed(
	ctx: ResetCardContext,
	proposal: ResetCardProposal,
): Promise<"switched" | "continue"> {
	const redeem = proposal.redeem;
	if (redeem === null) return "continue";
	if (
		ctx.deps.now() - Date.parse(proposal.statusAt) <
		UNCONFIRMED_CHECK_SPACING_MS
	) {
		return "continue";
	}
	const target = await readBoundTarget(ctx, proposal);
	if ("credential_changed" in target) {
		await finalize(ctx, proposal, "redeem_ambiguous", "credential_changed");
		return "continue";
	}
	if ("unavailable" in target) return "continue";
	const cliVersion = await ctx.rc.readCliVersion();
	if (cliVersion === null) return "continue";
	const status = await ctx.rc.fetchCardStatus(
		target.ok.accessToken,
		cliVersion,
	);
	if ("error" in status) return "continue";
	const grant = status.ok.cedar.grants.find(
		(candidate) => candidate.id === proposal.grant.id,
	);
	if (
		grant !== undefined &&
		grant.resetsLeft <= proposal.grant.resetsLeftBefore - 1
	) {
		const confirmed = save(ctx, proposal, {
			status: "redeem_confirmed",
			redeem: {
				...redeem,
				result: "reset_inferred",
				resetsLeftAfter: grant.resetsLeft,
				unconfirmedChecks: redeem.unconfirmedChecks + 1,
			},
		});
		return verifyAndSwitch(ctx, confirmed, true);
	}
	if (windowsRecovered(ctx, proposal, status.ok.usage)) {
		const recovered = save(ctx, proposal, {
			status: "recovered_without_proven_redeem",
			redeem: { ...redeem, unconfirmedChecks: redeem.unconfirmedChecks + 1 },
		});
		return verifyAndSwitch(ctx, recovered, null);
	}
	const checks = redeem.unconfirmedChecks + 1;
	if (checks >= MAX_UNCONFIRMED_CHECKS) {
		const last = save(ctx, proposal, {
			redeem: { ...redeem, unconfirmedChecks: MAX_UNCONFIRMED_CHECKS },
		});
		await finalize(ctx, last, "redeem_ambiguous", "unconfirmed_after_checks");
		return "continue";
	}
	save(ctx, proposal, { redeem: { ...redeem, unconfirmedChecks: checks } });
	return "continue";
}

/** Step 8 — verify the refill, then CAS-first single store write, then switch. */
async function verifyAndSwitch(
	ctx: ResetCardContext,
	proposal: ResetCardProposal,
	redeemProven: boolean | null,
): Promise<"switched" | "continue"> {
	const intent = proposal.switchIntent;
	if (intent === null) return "continue";
	const target = await readBoundTarget(ctx, proposal);
	if ("credential_changed" in target) {
		await finalize(
			ctx,
			proposal,
			"redeemed_switch_failed",
			"credential_changed",
			{
				redeemProven,
			},
		);
		return "continue";
	}
	if ("unavailable" in target) return "continue";
	const usage = await ctx.deps.fetchUsage(target.ok.accessToken);
	if (!("ok" in usage)) return "continue";
	const after = {
		fiveHPct: usage.ok.fiveH.pct,
		sevenDPct: usage.ok.sevenD.pct,
	};
	if (!windowsRecovered(ctx, proposal, usage.ok)) {
		if (
			ctx.deps.now() - Date.parse(proposal.statusAt) <
			RECOVERY_READ_GRACE_MS
		) {
			ctx.deps.log("reset_card usage_not_recovered_yet; re-reading next poll");
			return "continue";
		}
		await finalize(ctx, proposal, "failed", "usage_not_recovered", {
			targetAfter: after,
			redeemProven,
		});
		return "continue";
	}
	const verifiedAt = nowIso(ctx);
	const committed = await ctx.deps.withAccountsLock(async () => {
		const store = await ctx.rc.readStoreStrict();
		if (
			store === null ||
			store.generation !== intent.generationBefore ||
			store.activeAccount !== intent.from
		) {
			return { failed: "active_changed_after_redeem" };
		}
		const snap = await ctx.rc.readPoolCredentialSnapshot(intent.to);
		if (snap === null || snap.rawDigest !== intent.targetDigest) {
			return { failed: "credential_changed" };
		}
		const result = await ctx.rc.commitRecovery({
			name: intent.to,
			observation: toObservation(usage.ok, ctx.deps.now()),
			expectedGeneration: intent.generationBefore,
			expectedActive: intent.from,
		});
		if (result !== "updated") return { failed: `recovery_${result}` };
		const blocked = parseBlockedEpisode(
			structuredClone(ctx.getState().blockedEpisode),
		);
		return {
			switching: save(ctx, proposal, {
				status: "switching",
				switchIntent: { ...intent, verifiedAt },
				blockedEpisodeAtSwitch: blocked ?? null,
			}),
		};
	});
	if ("failed" in committed) {
		await finalize(
			ctx,
			proposal,
			"redeemed_switch_failed",
			committed.failed as string,
			{ targetAfter: after, redeemProven },
		);
		return "continue";
	}
	return switchToTarget(
		ctx,
		committed.switching,
		usage.ok,
		after,
		redeemProven,
	);
}

function lastSwitchMatches(
	store: AccountStore | null,
	intent: NonNullable<ResetCardProposal["switchIntent"]>,
): boolean {
	return (
		store !== null &&
		store.generation === intent.expectedGeneration &&
		store.activeAccount === intent.to &&
		store.lastSwitch?.generation === intent.expectedGeneration &&
		store.lastSwitch.from === intent.from &&
		store.lastSwitch.to === intent.to &&
		store.lastSwitch.triggerKind === "quota"
	);
}

/** Step 9 — the switch itself; success is only what the store proves. */
async function switchToTarget(
	ctx: ResetCardContext,
	proposal: ResetCardProposal,
	targetUsage: SuccessfulUsage,
	after: { fiveHPct: number; sevenDPct: number },
	redeemProven: boolean | null,
): Promise<"switched" | "continue"> {
	const intent = proposal.switchIntent;
	if (intent === null || intent.verifiedAt === null) return "continue";
	if (ctx.deps.config.monitorOnly) {
		await finalize(ctx, proposal, "redeemed_switch_failed", "monitor_only", {
			targetAfter: after,
			redeemProven,
		});
		return "continue";
	}
	const now = ctx.deps.now();
	const lastSwitchAt = ctx.getState().lastSwitchAt;
	if (
		lastSwitchAt !== null &&
		now - lastSwitchAt < config(ctx).minSwitchIntervalMinutes * 60_000
	) {
		ctx.deps.log("reset_card min_interval_bypassed_by_consent");
	}
	const { switched } = await ctx.ops.attemptSwitch(ctx.deps, {
		trigger: {
			kind: "quota",
			scope: intent.trigger.scope,
			resetAt: intent.trigger.resetAt,
		},
		observedAccount: intent.from,
		observedGeneration: intent.generationBefore,
		now: new Date(now),
		preferredOrder: [intent.to],
		verifiedAt: intent.verifiedAt,
		quotaPreverified: true,
		resetCardTarget: { name: intent.to },
		notificationContext: {
			usageByName: new Map([[intent.to, targetUsage]]),
		},
	});
	await ctx.ops.consumeApplyReports(
		ctx.deps,
		ctx.getState(),
		switched.applyReports,
	);
	const store = await ctx.deps.withAccountsLock(() => ctx.rc.readStoreStrict());
	if (!lastSwitchMatches(store, intent)) {
		const reason =
			switched.outcome === "noop_already_switched" ||
			switched.outcome === "noop_reconciled" ||
			switched.outcome === "switched"
				? "concurrent_switch"
				: `switch_failed:${switched.reasonCode}`;
		await finalize(ctx, proposal, "redeemed_switch_failed", reason, {
			targetAfter: after,
			redeemProven,
			switch: {
				outcome: switched.outcome,
				generation: store?.generation ?? null,
			},
		});
		return "continue";
	}
	const committed = save(ctx, proposal, { status: "switch_committed" });
	return settleResetCardSwitch(ctx, committed, after, redeemProven);
}

/** Step 10 — shared settlement, post-switch proof, audit, terminal. */
async function settleResetCardSwitch(
	ctx: ResetCardContext,
	proposal: ResetCardProposal,
	after: { fiveHPct: number; sevenDPct: number } | null,
	redeemProven: boolean | null,
): Promise<"switched" | "continue"> {
	const intent = proposal.switchIntent;
	if (intent === null) return "continue";
	let current = proposal;
	if (current.status === "switch_committed") {
		await ctx.ops.settle(
			ctx.deps,
			ctx.getState,
			{
				now: ctx.deps.now(),
				generation: intent.expectedGeneration,
				from: intent.from,
				to: intent.to,
				scope: intent.trigger.scope,
				resetAt: intent.trigger.resetAt,
				restoreBlockedEpisode: current.blockedEpisodeAtSwitch,
			},
			ctx.attemptedKinds,
			ctx.hooks,
		);
		current = save(ctx, current, { status: "settled" });
	}
	const refreshed = await ctx.ops.refreshNewActive(
		ctx.deps,
		ctx.getState(),
		intent.to,
	);
	const trigger = config(ctx).trigger5hPct;
	const verified =
		refreshed.status === "updated" &&
		refreshed.usage.fiveH.pct < trigger &&
		refreshed.usage.sevenD.pct < trigger;
	await finalize(
		ctx,
		current,
		verified ? "switched" : "switched_unverified",
		verified ? null : `post_switch_${refreshed.status}`,
		{
			targetAfter:
				refreshed.status === "updated"
					? {
							fiveHPct: refreshed.usage.fiveH.pct,
							sevenDPct: refreshed.usage.sevenD.pct,
						}
					: after,
			redeemProven,
			switch: { outcome: "switched", generation: intent.expectedGeneration },
		},
	);
	return "switched";
}

// ---------------------------------------------------------------------------
// Recovery — every poll, before reconcileActive, regardless of the switch

export async function recoverResetCard(ctx: ResetCardContext): Promise<void> {
	const read = readProposalFailClosed(ctx);
	if (read.kind !== "ok") return;
	let proposal = read.proposal;
	// §5.7: an unreadable audit disables the feature until a human repairs it,
	// recovery included — no store write, no switch on a broken ledger.
	const rows = auditRowsOrNull(ctx);
	if (rows === null) {
		// Persist the episode notification on the proposal, never in the broken
		// audit. This is a nonterminal hold, not permission to spend or switch.
		if (proposal.statusReason !== "audit_invalid_hold") {
			await alertInvalidAudit(ctx);
			if (
				proposal.status !== "awaiting_consent" &&
				!isTerminalStatus(proposal.status)
			) {
				save(ctx, proposal, { statusReason: "audit_invalid_hold" });
			}
		}
		return;
	}
	if (proposal.statusReason === "audit_invalid_hold") {
		proposal = save(ctx, proposal, { statusReason: null });
	}
	if (!isTerminalStatus(proposal.status)) {
		// finalize appends the terminal audit row before the proposal write: a
		// crash in between leaves the decided outcome only in the audit. Re-enter
		// finalize so the alert and terminal log still happen (audit row is kept).
		const decided = rows.find(
			(row): row is AuditTerminalRow =>
				row.kind === "terminal" && row.proposalId === proposal.proposalId,
		);
		if (decided !== undefined) {
			await finalize(ctx, proposal, decided.outcome, decided.reason);
			return;
		}
	}
	const redeemProven =
		proposal.redeem?.result === "reset" ||
		proposal.redeem?.result === "reset_inferred"
			? true
			: null;
	// Bound failed reads by the original request time, not statusAt (which
	// changes on each reconciliation). Reboots and missing credentials must not
	// extend a possibly spent card's recovery indefinitely. Already-committed
	// switches still use their exact-store reconciliation below.
	if (
		proposal.status !== "awaiting_consent" &&
		!isTerminalStatus(proposal.status) &&
		!["switching", "switch_committed", "settled"].includes(proposal.status) &&
		proposal.redeem?.result !== "not_spent" &&
		ctx.deps.now() -
			Date.parse(proposal.redeem?.startedAt ?? proposal.statusAt) >=
			RECOVERY_READ_GRACE_MS
	) {
		await finalize(
			ctx,
			proposal,
			redeemProven ? "redeemed_switch_failed" : "redeem_ambiguous",
			"recovery_deadline_exceeded",
			{ redeemProven },
		);
		return;
	}
	switch (proposal.status) {
		case "executing": {
			// The POST may or may not have left: never resend, reconcile read-only.
			if (proposal.redeem === null) return;
			if (proposal.redeem.result === "not_spent") {
				await finalize(
					ctx,
					proposal,
					"failed",
					`not_spent:${proposal.redeem.cause ?? "unknown"}`,
					{ redeemProven: false },
				);
				return;
			}
			save(ctx, proposal, {
				status: "redeem_unconfirmed",
				redeem: {
					...proposal.redeem,
					result: "unconfirmed",
					cause: "interrupted",
				},
			});
			return;
		}
		case "redeem_unconfirmed":
			await reconcileUnconfirmed(ctx, proposal);
			return;
		case "grant_already_used":
			await resolveAlreadyUsed(ctx, proposal);
			return;
		case "redeem_confirmed":
		case "recovered_without_proven_redeem":
			await verifyAndSwitch(ctx, proposal, redeemProven);
			return;
		case "switching": {
			// Never retry the switch: only an exact store match counts as done.
			const intent = proposal.switchIntent;
			if (intent === null) return;
			const store = await ctx.deps.withAccountsLock(() =>
				ctx.rc.readStoreStrict(),
			);
			if (lastSwitchMatches(store, intent)) {
				const committed = save(ctx, proposal, { status: "switch_committed" });
				await settleResetCardSwitch(ctx, committed, null, redeemProven);
			} else {
				await finalize(ctx, proposal, "redeemed_switch_failed", "interrupted", {
					redeemProven,
				});
			}
			return;
		}
		case "switch_committed":
		case "settled":
			await settleResetCardSwitch(ctx, proposal, null, redeemProven);
			return;
		default: {
			if (!isTerminalStatus(proposal.status)) return;
			const rows = auditRowsOrNull(ctx);
			if (rows !== null && !hasTerminalRow(rows, proposal.proposalId)) {
				await finalize(ctx, proposal, proposal.status, proposal.statusReason, {
					redeemProven,
				});
			}
		}
	}
}
