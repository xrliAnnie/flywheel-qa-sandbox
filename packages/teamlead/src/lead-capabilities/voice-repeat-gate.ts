import { createHash } from "node:crypto";
import type { OperationResult } from "./broker.js";
import type { OperationReceipt, OperationReceiptStore } from "./receipts.js";

/**
 * FLY-2886 Lead ruling (upstream ordering limit): Codex 0.156.1 awaits
 * StartOrSteer before it emits the handoff event, so a background input has no
 * handoff id and upstream ordering cannot prove that her repeated words are not
 * a second write. This gate is the structural write-before check. Rules are
 * fixed by the ruling; do not extend them.
 */
export const VOICE_REPEAT_WINDOW_MS = 10 * 60 * 1000;

/** Per-attempt business retry identities; never a key parameter of the write. */
const IDENTITY_FIELDS = new Set(["idempotencyKey", "requestId"]);

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

function normalizeParam(key: string | undefined, value: unknown): unknown {
	if (typeof value === "string") {
		const text = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
		// Identifier fields compare like target keys do (case-insensitive).
		return key && /(?:^id|Id|Ids)$/u.test(key) ? text.toLowerCase() : text;
	}
	if (Array.isArray(value))
		return value.map((item) => normalizeParam(key, item));
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(
					([name, item]) => !IDENTITY_FIELDS.has(name) && item !== undefined,
				)
				.map(([name, item]) => [name, normalizeParam(name, item)]),
		);
	return value;
}

/** Capability id + canonical target + normalized key parameters. */
export function voiceRepeatFingerprint(input: {
	operationId: string;
	targetKey: string;
	input: unknown;
}): string {
	return createHash("sha256")
		.update(
			canonical({
				operationId: input.operationId,
				targetKey: input.targetKey.toLowerCase(),
				params: normalizeParam(undefined, input.input),
			}),
		)
		.digest("hex");
}

/**
 * Only an explicit "do it again" answers the confirmation. Any negation, an
 * unrelated request, or silence is not a confirmation.
 */
export function isExplicitRepeatConfirmation(text: string): boolean {
	const compact = text
		.normalize("NFKC")
		.replace(/没问题/gu, "好")
		.replace(/[\s\p{P}\p{S}]/gu, "");
	if (!compact) return false;
	if (/(?:不|别|没|算了|等等|等一下|取消|停)/u.test(compact)) return false;
	if (/(?:再|重新|重)(?:做|发|来|弄|派|改|提交|执行|跑)/u.test(compact))
		return true;
	const bare = compact
		.replace(/^(?:嗯|呃|啊|哦|噢)+/u, "")
		.replace(/(?:吧|啊|呀|的|哈)+$/u, "");
	return [
		"要",
		"对",
		"是",
		"好",
		"行",
		"可以",
		"做",
		"发",
		"确定",
		"确认",
	].includes(bare);
}

function targetDisplay(receipt: OperationReceipt): string | undefined {
	const key = receipt.targetKey;
	if (!key) return undefined;
	const [, family, ...rest] = key.split(":");
	const tail = rest.join(":");
	if (/^[a-z][a-z0-9]*-[0-9]+$/iu.test(tail)) return tail.toUpperCase();
	if (family === "github" && /^[0-9]+$/u.test(tail)) return `#${tail}`;
	return undefined;
}

/** The already-recorded receipt result, spoken back without inventing a new fact. */
export function describeRepeatReceipt(receipt: OperationReceipt): string {
	const target = targetDisplay(receipt);
	const id = receipt.operationId;
	if (id === "start_runner")
		return target ? `${target} 已派出 runner` : "已派出 runner";
	if (id === "send_runner") return "已把话发给 runner";
	if (id === "respond_runner") return "已回复 runner 的问题";
	if (id.startsWith("linear.")) {
		const verb = id.endsWith(".create")
			? id.startsWith("linear.comment.")
				? "已评论"
				: "已创建"
			: id.endsWith(".assign")
				? "已分配"
				: "已更新";
		return target ? `Linear 上 ${target} ${verb}` : `Linear ${verb}`;
	}
	if (id.startsWith("github."))
		return target ? `GitHub ${target} 已更新` : "GitHub 已更新";
	if (id.startsWith("discord.")) return "Discord 消息已发出";
	if (id === "memory.add") return "已记进记忆";
	if (id.startsWith("browser.")) return "网页操作已完成";
	if (id.startsWith("report.")) return "报告已发出";
	if (id.startsWith("voice.session.")) return "语音会话已处理";
	return "已完成";
}

interface PendingConfirmation {
	deliveryId: string | undefined;
	blockedAt: number;
	/** The confirmation can only have been heard after the blocking turn ended. */
	askedAt?: number;
	confirmedAt?: number;
}

export type VoiceRepeatDecision =
	| { kind: "admit"; fingerprint: string }
	| { kind: "duplicate"; result: OperationResult };

/** One per voice capability parent; confirmations never outlive the process. */
export class VoiceRepeatWriteGate {
	private readonly pending = new Map<string, PendingConfirmation>();
	private readonly now: () => number;

	constructor(
		private readonly options: {
			receipts: OperationReceiptStore;
			projectName: string;
			leadId: string;
			activationId: string;
			now?: () => number;
		},
	) {
		this.now = options.now ?? Date.now;
	}

	/** Called by the broker for a new requestId of a write, before any receipt exists. */
	admit(input: {
		operationId: string;
		requestId: string;
		targetKey: string;
		input: unknown;
		deliveryId?: string;
	}): VoiceRepeatDecision {
		const now = this.now();
		this.expire(now);
		const fingerprint = voiceRepeatFingerprint(input);
		const prior = this.options.receipts.findRecentRepeat({
			projectName: this.options.projectName,
			leadId: this.options.leadId,
			activationId: this.options.activationId,
			operationId: input.operationId,
			targetKey: input.targetKey,
			dedupeDigest: fingerprint,
			since: now - VOICE_REPEAT_WINDOW_MS,
			excludeRequestId: input.requestId,
		});
		if (!prior) return { kind: "admit", fingerprint };
		const pending = this.pending.get(fingerprint);
		if (pending?.confirmedAt !== undefined) {
			// Her explicit "again" is a new request: exactly one more write.
			this.pending.delete(fingerprint);
			return { kind: "admit", fingerprint };
		}
		this.pending.set(fingerprint, {
			deliveryId: input.deliveryId,
			blockedAt: now,
			...(input.deliveryId === undefined ? { askedAt: now } : {}),
		});
		const outcome = prior.state === "succeeded" ? "succeeded" : "unknown";
		return {
			kind: "duplicate",
			result: {
				requestId: input.requestId,
				status: "rejected",
				resourceRefs: prior.providerRef ? [prior.providerRef] : [],
				errorCode: "duplicate_recent_write",
				data: {
					spokenText:
						outcome === "succeeded"
							? `这件刚才已经做了：${describeRepeatReceipt(prior)}，要再做一次吗？`
							: "这件刚才已经发出去了，结果还在核对，要再发一次吗？",
					duplicateOf: {
						requestId: prior.requestId,
						outcome,
						providerRef: prior.providerRef,
					},
				},
			},
		};
	}

	/** Parent turn lifecycle: the blocking turn's answer carries the question. */
	turnEnded(deliveryId: string): void {
		const now = this.now();
		for (const pending of this.pending.values())
			if (pending.deliveryId === deliveryId && pending.askedAt === undefined)
				pending.askedAt = now;
	}

	/** Trusted container input: one speaker-attributed final founder transcript. */
	observeFounderUtterance(text: string): void {
		const now = this.now();
		this.expire(now);
		const confirmed = isExplicitRepeatConfirmation(text);
		for (const [fingerprint, pending] of this.pending) {
			if (pending.askedAt === undefined || pending.confirmedAt !== undefined)
				continue;
			// Her first answer after the question decides; anything else is "no".
			if (confirmed) pending.confirmedAt = now;
			else this.pending.delete(fingerprint);
		}
	}

	private expire(now: number): void {
		for (const [fingerprint, pending] of this.pending)
			if (
				now - (pending.confirmedAt ?? pending.blockedAt) >
				VOICE_REPEAT_WINDOW_MS
			)
				this.pending.delete(fingerprint);
	}
}
