import { createHash } from "node:crypto";
import {
	ATTENTION_V1,
	type AttentionItem,
	type AttentionSource,
	attentionActions,
	validAttentionSince,
	validDiscordId,
} from "./attention.js";
import { label } from "./labels.js";
import type { Cell, EpicPageV2, MissingReason } from "./model.js";

export function attentionPublicKey(project: string, key: string): string {
	return `a-${createHash("sha256").update(`attention.v1\0${project}\0${key}`).digest("hex")}`;
}

export function attentionSummary(page: EpicPageV2): string {
	const sources = page.attention_sources;
	const identityIncomplete =
		sources.identity.value === null || sources.identity.value.unresolved > 0;
	if (
		identityIncomplete ||
		[
			sources.gates,
			sources.questions,
			sources.founder_review,
			sources.budget,
		].some((cell) => cell.value === null)
	) {
		const reasons = [];
		if (identityIncomplete)
			reasons.push(label("attention.identity_incomplete"));
		if (page.attention_sources.budget.value === null)
			reasons.push(label("attention.budget_incomplete"));
		return (
			label("attention.incomplete", { n: page.attention.length }) +
			(reasons.length ? `（${reasons.join("；")}）` : "")
		);
	}
	return page.attention.length === 0
		? label("attention.empty")
		: label("attention.count", { n: page.attention.length });
}

export function attentionWait(since: Cell<string>, now: Date): string {
	if (since.value === null)
		return label(
			since.missing?.reason === "invalid_since"
				? "attention.wait_invalid"
				: "attention.wait_unknown",
		);
	if (
		!validAttentionSince(since.value) ||
		!Number.isFinite(now.getTime()) ||
		Date.parse(since.value) > now.getTime()
	)
		return label("attention.wait_invalid");
	const hours = Math.floor(
		(now.getTime() - Date.parse(since.value)) / 3_600_000,
	);
	return (
		label("attention.wait_value", {
			time: since.value.slice(11, 16),
			date: since.value.slice(0, 10),
			n: hours,
		}) + (hours === 0 ? label("attention.wait_short") : "")
	);
}

export function attentionRole(source: AttentionSource): string | null {
	if (!source.recipient_role) return null;
	const role = source.recipient_role.value;
	return role === "lead"
		? "Lead"
		: role === "bridge"
			? "Bridge"
			: role === "runner"
				? "runner"
				: label("attention.unknown");
}

export function attentionActionText(item: AttentionItem): string {
	const actions = [
		item.action.value ?? label("attention.unknown"),
		...attentionActions(item.sources).filter(
			(action) => action !== item.action.value,
		),
	];
	const roles = [
		...new Set(
			item.sources
				.map(attentionRole)
				.filter((role): role is string => role !== null),
		),
	];
	const questions = item.sources.filter(
		(source) => source.fact.value?.kind === "question",
	).length;
	const additional =
		questions - (item.kind.value === ATTENTION_V1.kinds.question.kind ? 1 : 0);
	return [
		...actions,
		...roles.map((role) => label("attention.recipient", { role })),
		...(additional > 0
			? [label("attention.more_questions", { n: additional })]
			: []),
	].join(" ");
}

export function attentionSourceText(
	source: AttentionSource,
	now: Date,
): string {
	const rawKind = source.fact.value?.kind;
	const kind =
		rawKind && Object.hasOwn(ATTENTION_V1.kinds, rawKind)
			? ATTENTION_V1.kinds[rawKind as keyof typeof ATTENTION_V1.kinds].kind
			: (rawKind?.slice(0, 256) ?? label("attention.unknown"));
	const role = attentionRole(source);
	return `${kind}；${attentionWait(source.since, now)}${role === null ? "" : `；${label("attention.recipient", { role })}`}`;
}

export function attentionLink(
	page: EpicPageV2,
	item: AttentionItem,
): { url: string | null; reason?: MissingReason } {
	const guild = page.discord.guild_id;
	if (guild.value === null)
		return {
			url: null,
			reason: guild.missing?.reason ?? "no_guild_configured",
		};
	if (!validDiscordId(guild.value))
		return { url: null, reason: "invalid_guild_config" };
	if (item.thread.value === null)
		return {
			url: null,
			reason: item.thread.missing?.reason ?? "no_thread_binding",
		};
	if (
		!validDiscordId(item.thread.value.thread_id) ||
		!validDiscordId(item.thread.value.channel_id)
	)
		return { url: null, reason: "invalid_discord_id" };
	if (item.thread_url.value === null)
		return {
			url: null,
			reason: item.thread_url.missing?.reason ?? "no_thread_binding",
		};
	const expected = `https://discord.com/channels/${guild.value}/${item.thread.value.thread_id}`;
	return item.thread_url.value === expected
		? { url: expected }
		: { url: null, reason: "invalid_discord_id" };
}

export function attentionMissing(reason?: MissingReason): string {
	const labels: Partial<Record<MissingReason, string>> = {
		no_guild_configured: "未配置 Discord 服务器编号",
		invalid_guild_config: "Discord 服务器编号无效",
		no_thread_binding: "没有该单讨论串绑定",
		thread_binding_conflict: "讨论串绑定冲突",
		thread_missing: "讨论串已不可用",
		invalid_discord_id: "Discord 链接或编号无效",
		issue_identity_unknown: "事项身份不知道",
		statestore_error: "讨论串配置读取失败",
	};
	return labels[reason ?? "source_unavailable"] ?? "来源不可用";
}
