/**
 * FLY-2896 — Bridge side of the reset-card ("充值卡") consent loop.
 *
 * The quota daemon proposes; the founder decides on Discord (✅ / ❌); this
 * module is the ONLY writer of `reset-card-consent.json`. It never redeems a
 * card and never switches accounts (invariant I3): it posts one card per
 * proposal, reads reactions by the founder's exact id (fail-closed), writes the
 * decision and SIGUSR1-wakes the daemon through the injected waker.
 *
 * Rides the Bridge's existing poll tick (no timer of its own): `tick()` is
 * synchronous, never throws, never awaits, and starts at most one asynchronous
 * round at a time. Files are read at most every 5 s, reactions every 20 s.
 *
 * The Discord transport is injected (`ResetCardDiscordOps`); the production
 * adapters over `discord-utils` live in `plugin.ts`, which the automated-sender
 * inventory already classifies.
 */

import type {
	AuditTerminalRow,
	ConsentState,
	ProposalStatus,
	ResetCardConsent,
	ResetCardFiles,
	ResetCardProposal,
} from "../account-heal/reset-card-files.js";
import type { ReactionConfirmationCheck } from "../lead-backends/codex/gateway/founder-confirmation.js";

export const APPROVE_EMOJI = "✅";
export const REJECT_EMOJI = "❌";
export const RESET_CARD_FILE_READ_INTERVAL_MS = 5_000;
export const RESET_CARD_REACTION_READ_INTERVAL_MS = 20_000;
/**
 * QA rework: Discord rate-limits back-to-back reaction PUTs on one message
 * (a real probe saw 429 on ❌ at < ~250 ms). Seed in order with a gap, retry a
 * 429 after Discord's own retry_after, and re-seed on a later round if needed.
 */
export const RESET_CARD_REACTION_GAP_MS = 350;
export const RESET_CARD_REACTION_MAX_ATTEMPTS = 3;
const REACTION_RETRY_DEFAULT_MS = 1_000;
const REACTION_RETRY_MAX_MS = 5_000;
/**
 * The card must stay one Discord chunk (the idempotency nonce only covers a
 * single message). `splitDiscordMessage` cuts at 1900 and the automation
 * marker the sender prepends costs a few characters, so bound well below.
 */
export const MAX_RESET_CARD_TEXT_LENGTH = 1_800;

const SNOWFLAKE = /^[0-9]{15,22}$/;
const IN_PROGRESS: ReadonlySet<ProposalStatus> = new Set([
	"executing",
	"redeem_unconfirmed",
	"grant_already_used",
	"redeem_confirmed",
	"recovered_without_proven_redeem",
	"switching",
	"switch_committed",
	"settled",
]);
/** Display keys that already show a final outcome on a card. */
const FINAL_DISPLAY_KEYS: ReadonlySet<string> = new Set([
	"switched",
	"switched_unverified",
	"rejected",
	"expired",
	"cancelled",
	"failed",
	"redeem_ambiguous",
	"redeemed_switch_failed",
]);

// ---------------------------------------------------------------------------
// Injected surfaces

export type ResetCardDiscordCallResult =
	| { ok: true }
	| { ok: false; status?: number; error: string; retryAfterMs?: number };

export interface ResetCardDiscordOps {
	/** One single-chunk POST with an idempotency nonce; pings only `allowedUserIds`. */
	post(args: {
		channelId: string;
		botToken: string;
		text: string;
		nonce: string;
		allowedUserIds: string[];
	}): Promise<{ ok: true; messageId: string } | { ok: false; error: string }>;
	edit(args: {
		channelId: string;
		messageId: string;
		botToken: string;
		text: string;
	}): Promise<ResetCardDiscordCallResult>;
	/** Add the bot's own reaction (the ✅ / ❌ affordances under the card). */
	react(args: {
		channelId: string;
		messageId: string;
		botToken: string;
		emoji: string;
	}): Promise<ResetCardDiscordCallResult>;
	/** Founder-exact, fail-closed reaction check (`checkReactionConfirmation`). */
	checkReaction(args: {
		channelId: string;
		messageId: string;
		botToken: string;
		founderId: string;
		emoji: string;
	}): Promise<ReactionConfirmationCheck>;
}

export interface ResetCardConsentDeps {
	files: ResetCardFiles;
	now: () => number;
	/** Canonical founder id, or null when missing / conflicting (fail-closed). */
	founderId: () => string | null;
	channelId: () => string | null;
	botToken: () => string | null;
	discord: ResetCardDiscordOps;
	/** A dedicated `createQuotaDaemonWaker()` instance in production. */
	wake: () => unknown;
	timezone: () => string;
	log: (message: string) => void;
	fileReadIntervalMs?: number;
	reactionReadIntervalMs?: number;
	/** Injectable wait for reaction pacing; tests pass a recorder. */
	sleep?: (ms: number) => Promise<void>;
}

export interface ResetCardConsentTicker {
	/** Synchronous, never throws: starts one round when idle and due. */
	tick(): void;
	/** Resolves once the in-flight round (if any) has settled. Tests only. */
	settle(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Rendering (pure)

const MARKDOWN_SPECIAL = /[\\*_~`|>#@<:[\]()]/g;

/** Backslash-escape Discord markdown; control characters become spaces. */
export function escapeDiscordMarkdown(value: string): string {
	return [...value]
		.map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
		.join("")
		.replace(MARKDOWN_SPECIAL, "\\$&");
}

interface LocalParts {
	year: string;
	month: string;
	day: string;
	weekday: string;
	hour: string;
	minute: string;
}

function localParts(iso: string, timezone: string): LocalParts | null {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return null;
	const values = Object.fromEntries(
		new Intl.DateTimeFormat("zh-CN", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			weekday: "short",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(new Date(ms))
			.map((part) => [part.type, part.value]),
	);
	if (
		!values.year ||
		!values.month ||
		!values.day ||
		!values.weekday ||
		!values.hour ||
		!values.minute
	) {
		return null;
	}
	return values as unknown as LocalParts;
}

const formatClock = (parts: LocalParts) => `${parts.hour}:${parts.minute}`;
const formatDay = (parts: LocalParts) => `${parts.month}/${parts.day}`;
/** "还要 5 天 3 小时", rounded to the hour. */
export function formatRemaining(fromMs: number, toMs: number): string {
	const hours = Math.round((toMs - fromMs) / 3_600_000);
	if (!Number.isFinite(hours) || hours <= 0) return "不到 1 小时";
	const days = Math.floor(hours / 24);
	const rest = hours % 24;
	if (days === 0) return `还要 ${rest} 小时`;
	return rest === 0 ? `还要 ${days} 天` : `还要 ${days} 天 ${rest} 小时`;
}

const pct = (value: number) => String(Math.round(value));

/**
 * The consent card (plan §5.6). Relative phrases are anchored on
 * `proposal.createdAt`, so re-rendering for an outcome edit reproduces the
 * original body. With `outcome`, the ✅/❌ call to action is replaced by it.
 */
export function renderResetCardText(
	proposal: ResetCardProposal,
	options: { founderId: string; timezone: string; outcome?: string },
): string {
	// Founder v4 explicitly uses PT, independent of the Bridge display timezone.
	const timezone = "America/Los_Angeles";
	const active = escapeDiscordMarkdown(proposal.active.name);
	const target = escapeDiscordMarkdown(proposal.target.name);
	const dayTime = (iso: string | null) => {
		const parts = iso === null ? null : localParts(iso, timezone);
		return parts === null
			? "未知"
			: `${Number(parts.month)}/${Number(parts.day)} ${formatClock(parts)}`;
	};
	const endDate = (iso: string | null) => {
		const parts = iso === null ? null : localParts(iso, timezone);
		return parts === null ? "未知" : formatDay(parts);
	};
	// Legacy proposals can still complete; unavailable historical facts stay unknown.
	const accounts = proposal.accountRows ?? [
		{
			...proposal.active,
			recoveryAt:
				proposal.active.drivingWindow === "5h"
					? proposal.active.fiveHResetAt
					: proposal.active.sevenDResetAt,
			cards: null,
		},
		{
			...proposal.target,
			cards: [
				{ count: proposal.grant.cardsLeftTotal, endsAt: proposal.grant.endsAt },
			],
		},
	];
	const remaining = (used: number | null) =>
		used === null ? "未知" : `${Math.max(0, 100 - Math.round(used))}%`;
	const rows = [
		["账号", "5小时", "周", "自然恢复", "重置卡"],
		...accounts.map((row) => [
			// File validation forbids code fences/control characters; preserve full names.
			row.name + (row.name === proposal.active.name ? "*" : ""),
			remaining(row.fiveHPct),
			remaining(row.sevenDPct),
			dayTime(row.recoveryAt),
			row.cards === null
				? "未知"
				: row.cards.length === 0
					? "无"
					: row.cards
							.map((card) => `${card.count}张 ${endDate(card.endsAt)}`)
							.join("、"),
		]),
	];
	const width = (text: string) =>
		[...text].reduce((n, c) => n + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
	const widths = [0, 1, 2, 3, 4].map((col) =>
		Math.max(...rows.map((row) => width(row[col] ?? ""))),
	);
	const table = rows.map((row) =>
		row
			.map((cell, col) =>
				col === row.length - 1
					? cell
					: cell + " ".repeat((widths[col] ?? 0) - width(cell)),
			)
			.join("  "),
	);
	const lines = [
		`Claude 额度快用完了：在用的 ${active} 5 小时已用 ${pct(proposal.active.fiveHPct)}%，其他号都不能直接切。`,
		`<@${options.founderId}>`,
		"```",
		...table,
		"```",
		"* = 在用；时间是 PT",
		`建议用 ${target} 的重置卡：它最晚才自然恢复（${dayTime(proposal.target.recoveryAt)}），${proposal.grant.endsAt === null ? "卡到期时间未知" : `卡 ${endDate(proposal.grant.endsAt)} 到期`}。用完切到 ${target}。`,
		options.outcome ?? "同意吗？在这条消息上点 ✅ 同意，点 ❌ 不用。",
	];
	return lines.join("\n");
}

const REASON_TEXT: Readonly<Record<string, string>> = {
	direct_candidate_appeared: "出现了能直接切的号",
	active_changed: "在用号变了",
	active_recovered: "在用号额度已恢复",
	usage_not_recovered: "用卡后额度没恢复",
	concurrent_switch: "有别的切号在进行",
	interrupted: "执行被打断",
	credential_changed: "凭据变了",
	disabled: "功能已关闭",
	not_limited: "号已经不满了",
	cooldown: "卡在冷却期",
	ineligible: "号不符合用卡条件",
	rate_limited: "被限流",
	auth_error: "凭据失效",
};

/** Known reason codes → short Chinese; anything else is the escaped code. */
export function describeReason(reason: string | null): string {
	if (reason === null) return "原因未知";
	if (reason.startsWith("facts_changed")) return "情况变了";
	const cause = reason.startsWith("not_spent:")
		? reason.slice("not_spent:".length)
		: reason;
	return REASON_TEXT[cause] ?? escapeDiscordMarkdown(reason);
}

export interface OutcomeDisplay {
	/** `/^[a-z_]{1,40}$/`; persisted as `<proposalId>:<key>` once rendered. */
	key: string;
	text: string;
}

export function outcomeDisplay(input: {
	status: ProposalStatus;
	statusReason: string | null;
	consentState: ConsentState;
	activeName: string;
	switchAtPct: number;
	targetName: string;
	targetAfter: { fiveHPct: number } | null;
}): OutcomeDisplay | null {
	const target = escapeDiscordMarkdown(input.targetName);
	const active = escapeDiscordMarkdown(input.activeName);
	switch (input.status) {
		case "awaiting_consent":
			if (input.consentState === "approved") {
				return {
					key: "approved_waiting",
					text: `✅ 你已同意：在用号 ${active} 用到 ${pct(input.switchAtPct)}% 时执行（只给 ${target} 用这一张卡）`,
				};
			}
			if (input.consentState === "rejected") {
				return { key: "rejected", text: "❌ 你已拒绝，未用卡" };
			}
			if (input.consentState === "expired") {
				return { key: "expired", text: "⌛ 已过期，未用卡" };
			}
			return null;
		case "switched":
			return {
				key: "switched",
				text:
					input.targetAfter === null
						? `✅ 已用卡并切到 ${target}`
						: `✅ 已用卡并切到 ${target}（5 小时 ${pct(input.targetAfter.fiveHPct)}%）`,
			};
		case "switched_unverified":
			return {
				key: "switched_unverified",
				text: `⚠️ 已用卡并切到 ${target}，但切后读数未确认，请看额度页`,
			};
		case "rejected":
			return { key: "rejected", text: "❌ 你已拒绝，未用卡" };
		case "expired":
			return { key: "expired", text: "⌛ 已过期，未用卡" };
		case "cancelled":
			return {
				key: "cancelled",
				text: `已取消，未用卡：${describeReason(input.statusReason)}`,
			};
		case "failed":
			return {
				key: "failed",
				text: `⚠️ 用卡失败：${describeReason(input.statusReason)}${
					input.statusReason?.startsWith("not_spent") ? "（这次没有花卡）" : ""
				}`,
			};
		case "redeem_ambiguous":
			return {
				key: "redeem_ambiguous",
				text: "⚠️ 用卡后状态不确定，请人工核对（审计里有 request id）",
			};
		case "redeemed_switch_failed":
			return {
				key: "redeemed_switch_failed",
				text: `⚠️ 已用卡但切号没成：${describeReason(input.statusReason)}；请核对额度页并手动切号`,
			};
		case "post_failed":
			return null;
		default:
			return IN_PROGRESS.has(input.status)
				? { key: "in_progress", text: "⏳ 正在用卡并切号…" }
				: null;
	}
}

/** Body for a card whose proposal was replaced before it reached a final display. */
export function supersededText(
	old: ResetCardConsent,
	terminal: AuditTerminalRow | null,
): string {
	if (terminal !== null) {
		const display = outcomeDisplay({
			status: terminal.outcome,
			statusReason: terminal.reason,
			consentState: old.state,
			activeName: terminal.active.name,
			switchAtPct: 0,
			targetName: terminal.target.name,
			targetAfter: terminal.target.after,
		});
		if (display !== null) return display.text;
	}
	return old.state === "approved" ? "已被新情况取代" : "已被新情况取代，未用卡";
}

/** Discord nonce (≤ 25 chars) derived from the proposal: a crash between the
 * POST and persisting `messageId` cannot produce a second card. */
export function resetCardNonce(proposalId: string): string {
	return proposalId.replace(/-/g, "").slice(0, 25);
}

// ---------------------------------------------------------------------------
// Ticker

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}

function bounded(text: string): string {
	return text.replace(/\s+/g, " ").slice(0, 160);
}

export function createResetCardConsentTicker(
	deps: ResetCardConsentDeps,
): ResetCardConsentTicker {
	const fileInterval =
		deps.fileReadIntervalMs ?? RESET_CARD_FILE_READ_INTERVAL_MS;
	const reactionInterval =
		deps.reactionReadIntervalMs ?? RESET_CARD_REACTION_READ_INTERVAL_MS;
	let inFlight: Promise<void> | null = null;
	let lastFileReadAt: number | null = null;
	let lastReactionReadAt: number | null = null;
	const sleep =
		deps.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	/**
	 * `<proposalId>:<messageId>` whose ✅ and ❌ this process confirmed. Not
	 * persisted: after a restart each posted card is re-seeded once, and a PUT
	 * of the bot's own reaction is idempotent on Discord.
	 */
	const seeded = new Set<string>();

	const log = (message: string): void => {
		try {
			deps.log(`[reset-card-consent] ${message}`);
		} catch {
			/* logging must never break the tick */
		}
	};
	const nowIso = (): string => new Date(deps.now()).toISOString();

	function terminalRow(proposalId: string): AuditTerminalRow | null {
		const audit = deps.files.readAudit();
		if (audit.status === "absent") return null;
		if (audit.status === "invalid") {
			log(`audit unreadable: ${audit.reason}`);
			return null;
		}
		return (
			audit.value.find(
				(row): row is AuditTerminalRow =>
					row.kind === "terminal" && row.proposalId === proposalId,
			) ?? null
		);
	}

	async function supersede(old: ResetCardConsent): Promise<void> {
		if (old.channelId === null || old.messageId === null) return;
		const renderedKey = old.outcomeRenderedFor?.split(":")[1];
		if (renderedKey !== undefined && FINAL_DISPLAY_KEYS.has(renderedKey)) {
			return; // the old card already shows its real final outcome
		}
		const botToken = deps.botToken();
		if (botToken === null) {
			log("old card not marked superseded: bot token missing");
			return;
		}
		const result = await deps.discord.edit({
			channelId: old.channelId,
			messageId: old.messageId,
			botToken,
			text: supersededText(old, terminalRow(old.proposalId)),
		});
		if (!result.ok) log(`superseded edit failed: ${bounded(result.error)}`);
	}

	async function post(
		proposal: ResetCardProposal,
		consent: ResetCardConsent,
	): Promise<ResetCardConsent> {
		const fail = (reason: string): ResetCardConsent => {
			const failed: ResetCardConsent = {
				...consent,
				state: "post_failed",
				reason,
			};
			deps.files.writeConsent(failed);
			log(`card not posted: ${reason}`);
			return failed;
		};
		const founderId = deps.founderId();
		if (founderId === null) return fail("founder_id_missing");
		if (!SNOWFLAKE.test(founderId)) return fail("founder_id_invalid");
		const channelId = deps.channelId();
		if (channelId === null) return fail("channel_missing");
		if (!SNOWFLAKE.test(channelId)) return fail("channel_invalid");
		const botToken = deps.botToken();
		if (botToken === null) return fail("bot_token_missing");
		const text = renderResetCardText(proposal, {
			founderId,
			timezone: deps.timezone(),
		});
		if (text.length > MAX_RESET_CARD_TEXT_LENGTH) return fail("card_too_long");
		const result = await deps.discord.post({
			channelId,
			botToken,
			text,
			nonce: resetCardNonce(proposal.proposalId),
			allowedUserIds: [founderId],
		});
		if (!result.ok) {
			log(`discord post failed: ${bounded(result.error)}`);
			return fail("post_failed");
		}
		const posted: ResetCardConsent = {
			...consent,
			state: "posted",
			reason: null,
			channelId,
			messageId: result.messageId,
			postedAt: nowIso(),
			founderId,
		};
		// Persist the binding BEFORE the bot's own reactions: a crash after the
		// POST must resume by polling this message, never by posting again.
		deps.files.writeConsent(posted);
		await seedReactions(posted, botToken);
		return posted;
	}

	/** Put the bot's ✅ then ❌ under the card; true once both are confirmed. */
	async function seedReactions(
		consent: ResetCardConsent,
		botToken: string,
	): Promise<boolean> {
		const { channelId, messageId } = consent;
		if (channelId === null || messageId === null) return false;
		const key = `${consent.proposalId}:${messageId}`;
		if (seeded.has(key)) return true;
		let complete = true;
		for (const [index, emoji] of [APPROVE_EMOJI, REJECT_EMOJI].entries()) {
			if (index > 0) await sleep(RESET_CARD_REACTION_GAP_MS);
			let done = false;
			for (
				let attempt = 1;
				attempt <= RESET_CARD_REACTION_MAX_ATTEMPTS && !done;
				attempt++
			) {
				const reaction = await deps.discord.react({
					channelId,
					messageId,
					botToken,
					emoji,
				});
				if (reaction.ok) {
					done = true;
				} else if (
					reaction.status === 429 &&
					attempt < RESET_CARD_REACTION_MAX_ATTEMPTS
				) {
					await sleep(
						Math.min(
							REACTION_RETRY_MAX_MS,
							reaction.retryAfterMs ?? REACTION_RETRY_DEFAULT_MS,
						),
					);
				} else {
					log(
						`seed reaction ${emoji} failed (attempt ${attempt}): ${bounded(reaction.error)}${reaction.status === undefined ? "" : ` status=${reaction.status}`}; retrying next round`,
					);
					break;
				}
			}
			if (!done) complete = false;
		}
		if (complete) seeded.add(key);
		return complete;
	}

	async function decide(
		proposal: ResetCardProposal,
		consent: ResetCardConsent,
	): Promise<ResetCardConsent> {
		const founderId = deps.founderId();
		if (founderId === null) {
			log("founder id unavailable; not deciding");
			return consent;
		}
		if (consent.founderId !== null && consent.founderId !== founderId) {
			log("founder id changed since the card was posted; not deciding");
			return consent;
		}
		const botToken = deps.botToken();
		if (botToken === null) {
			log("bot token unavailable; not deciding");
			return consent;
		}
		const { channelId, messageId } = consent;
		if (channelId === null || messageId === null) {
			log("posted consent has no message binding; not deciding");
			return consent;
		}
		const read = (emoji: string) =>
			deps.discord.checkReaction({
				channelId,
				messageId,
				botToken,
				founderId,
				emoji,
			});
		const expiresMs = Date.parse(proposal.expiresAt);
		const settle = (
			state: "approved" | "rejected" | "expired",
			reason: string | null,
		): ResetCardConsent => {
			const decided: ResetCardConsent = {
				...consent,
				state,
				reason,
				decidedAt: nowIso(),
				founderId,
			};
			deps.files.writeConsent(decided);
			log(`decided ${state}`);
			return decided;
		};

		// Fixed order: ✅ first, ❌ last (the last external read before approval).
		const yes = await read(APPROVE_EMOJI);
		if (!yes.confirmed) {
			if (yes.reason !== "not_yet") log(`approve read: ${yes.reason}`);
			const no = await read(REJECT_EMOJI);
			if (no.confirmed) return settle("rejected", null);
			if (no.reason !== "not_yet") log(`reject read: ${no.reason}`);
			if (deps.now() > expiresMs) return settle("expired", null);
			return consent;
		}
		const no = await read(REJECT_EMOJI);
		if (no.confirmed) return settle("rejected", "both_reactions");
		if (no.reason !== "not_yet") {
			log(`reject read after approve: ${no.reason}; not deciding`);
			return consent;
		}
		if (deps.now() > expiresMs)
			return settle("expired", "approve_after_expiry");
		const onDisk = deps.files.readConsent();
		if (
			onDisk.status !== "ok" ||
			onDisk.value.proposalId !== proposal.proposalId ||
			onDisk.value.state !== "posted"
		) {
			log("consent changed underneath the decision; not approving");
			return consent;
		}
		const approved = settle("approved", null);
		try {
			deps.wake();
		} catch (error) {
			log(`wake failed: ${errorName(error)}`);
		}
		return approved;
	}

	async function renderOutcome(
		proposal: ResetCardProposal,
		consent: ResetCardConsent,
	): Promise<void> {
		if (consent.channelId === null || consent.messageId === null) return;
		const display = outcomeDisplay({
			status: proposal.status,
			statusReason: proposal.statusReason,
			consentState: consent.state,
			activeName: proposal.active.name,
			switchAtPct: proposal.active.switchAtPct,
			targetName: proposal.target.name,
			targetAfter:
				proposal.status === "switched"
					? (terminalRow(proposal.proposalId)?.target.after ?? null)
					: null,
		});
		if (display === null) return;
		const marker = `${proposal.proposalId}:${display.key}`;
		if (consent.outcomeRenderedFor === marker) return;
		const founderId = consent.founderId ?? deps.founderId();
		if (founderId === null) {
			log("outcome not rendered: founder id missing");
			return;
		}
		const botToken = deps.botToken();
		if (botToken === null) {
			log("outcome not rendered: bot token missing");
			return;
		}
		const result = await deps.discord.edit({
			channelId: consent.channelId,
			messageId: consent.messageId,
			botToken,
			text: renderResetCardText(proposal, {
				founderId,
				timezone: deps.timezone(),
				outcome: display.text,
			}),
		});
		if (!result.ok && result.status !== 404) {
			log(`outcome edit failed: ${bounded(result.error)}`);
			return;
		}
		if (!result.ok)
			log("card message is gone (404); outcome recorded as rendered");
		deps.files.writeConsent({ ...consent, outcomeRenderedFor: marker });
	}

	async function round(): Promise<void> {
		const proposalRead = deps.files.readProposal();
		if (proposalRead.status === "absent") return;
		if (proposalRead.status === "invalid") {
			log(`proposal invalid: ${proposalRead.reason}`);
			return;
		}
		const proposal = proposalRead.value;
		const consentRead = deps.files.readConsent();
		if (consentRead.status === "invalid") {
			log(`consent invalid: ${consentRead.reason}; nothing posted or written`);
			return;
		}
		let consent = consentRead.status === "ok" ? consentRead.value : null;

		if (consent === null || consent.proposalId !== proposal.proposalId) {
			if (proposal.status !== "awaiting_consent") return;
			if (consent !== null) await supersede(consent);
			consent = {
				schemaVersion: 1,
				proposalId: proposal.proposalId,
				digest: proposal.digest,
				state: "pending_post",
				reason: null,
				channelId: null,
				messageId: null,
				postedAt: null,
				decidedAt: null,
				founderId: null,
				outcomeRenderedFor: null,
			};
			deps.files.writeConsent(consent);
		} else if (consent.digest !== proposal.digest) {
			log("consent digest differs from the proposal; leaving both untouched");
			return;
		}

		if (consent.state === "pending_post") {
			if (proposal.status !== "awaiting_consent") return;
			consent = await post(proposal, consent);
		} else if (
			consent.state === "posted" &&
			proposal.status === "awaiting_consent"
		) {
			const t = deps.now();
			if (
				lastReactionReadAt === null ||
				t - lastReactionReadAt >= reactionInterval
			) {
				lastReactionReadAt = t;
				// A card missing its ✅/❌ affordance is re-seeded before reading.
				const botToken = deps.botToken();
				if (botToken !== null) await seedReactions(consent, botToken);
				consent = await decide(proposal, consent);
			}
		}
		await renderOutcome(proposal, consent);
	}

	return {
		tick() {
			try {
				if (inFlight !== null) return;
				const t = deps.now();
				if (lastFileReadAt !== null && t - lastFileReadAt < fileInterval) {
					return;
				}
				lastFileReadAt = t;
				inFlight = round()
					.catch((error) => log(`round failed: ${errorName(error)}`))
					.finally(() => {
						inFlight = null;
					});
			} catch (error) {
				inFlight = null;
				log(`tick failed: ${errorName(error)}`);
			}
		},
		settle: () => inFlight ?? Promise.resolve(),
	};
}

/**
 * Plan §5.6 wiring: run the consent tick synchronously (never throwing) and
 * only then continue with the existing tick chain, so neither side can
 * short-circuit the other.
 */
export function withResetCardTick(
	tick: () => void,
	next: () => Promise<void>,
	log: (message: string) => void,
): () => Promise<void> {
	return () => {
		try {
			tick();
		} catch (error) {
			try {
				log(`[reset-card-consent] tick threw: ${errorName(error)}`);
			} catch {
				/* never let logging break the chain */
			}
		}
		return next();
	};
}
