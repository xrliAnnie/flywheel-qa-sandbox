import type { ReleaseInteractionTarget } from "./actions.js";
import type { ReleaseControlNotice } from "./activation-store.js";
import { releaseMessageDigest } from "./cards.js";
import type { VerifiedReleaseInteraction } from "./interaction-gateway.js";
import type { CustomerReleaseStore } from "./store.js";

function valid(value: unknown): asserts value {
	if (!value) throw new Error("customer release activation card rejected");
}
type CardInput = Pick<
	ReleaseControlNotice,
	| "action"
	| "noticeId"
	| "epoch"
	| "identityDigest"
	| "evidenceBundleDigest"
	| "expiresAt"
	| "policyRevision"
>;
export function activationCard(input: CardInput) {
	valid(input.action === "enable" || input.action === "disable");
	valid(/^[a-f0-9]{32}$/.test(input.noticeId));
	valid(Number.isSafeInteger(input.epoch) && input.epoch > 0);
	valid(
		[
			input.policyRevision,
			input.identityDigest,
			input.evidenceBundleDigest,
		].every(
			(value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
		),
	);
	valid(
		Number.isSafeInteger(input.expiresAt) &&
			input.expiresAt > 0 &&
			input.expiresAt <= 8.64e15,
	);
	const enabling = input.action === "enable";
	return {
		content: [
			enabling
				? "启用默认发布：之后每个合格周期会通知你，你可以在窗口内一键否决。"
				: "关闭默认发布：立即停止新的自动发布；已开始的提交需要继续核对结果。",
			"项目：flywheel",
			`策略 SHA-256：${input.policyRevision}`,
			`环境身份 SHA-256：${input.identityDigest}`,
			`验收证据 SHA-256：${input.evidenceBundleDigest}`,
			`授权代次：${input.epoch}`,
			enabling
				? `确认截止：${new Date(input.expiresAt).toISOString()}`
				: "关闭动作不会回滚已发布版本。",
			"请核对对应的验收记录；此按钮只授权上面这份配置。",
		].join("\n"),
		components: [
			{
				type: 1,
				components: [
					{
						type: 2,
						style: enabling ? 3 : 4,
						label: enabling ? "启用默认发布" : "关闭默认发布",
						custom_id: `fwrel:${input.action}:${input.epoch}:${input.noticeId}`,
					},
				],
			},
		],
		allowed_mentions: { parse: [] },
	};
}
export class ReleaseActivationActions {
	constructor(
		private readonly options: {
			store: CustomerReleaseStore;
			target: () => ReleaseInteractionTarget;
			/** Trusted currently validated A0-A5 bundle, null on missing/invalid evidence. */
			evidenceDigest: () => string | null;
			now: () => number;
		},
	) {}
	commit(event: VerifiedReleaseInteraction): string {
		const target = this.options.target(),
			store = this.options.store,
			state = store.activation.get();
		valid(event.action === "enable" || event.action === "disable");
		valid(
			state &&
				event.actorId === target.founderId &&
				state.identity.founderId === target.founderId &&
				event.epoch === target.epoch &&
				state.epoch === target.epoch &&
				event.applicationId === target.applicationId &&
				event.guildId === target.guildId &&
				event.channelId === target.channelId,
		);
		const notice = store.activation.controlNotice(event.nonce);
		valid(
			notice &&
				notice.action === event.action &&
				notice.epoch === state.epoch &&
				notice.identityDigest === state.identity.identityDigest &&
				notice.policyRevision === state.identity.policyRevision &&
				notice.botUserId === target.botUserId &&
				notice.applicationId === event.applicationId &&
				notice.channelId === event.channelId &&
				notice.messageId === event.messageId &&
				notice.messageDigest === releaseMessageDigest(event),
		);
		if (event.action === "enable") {
			valid(this.options.evidenceDigest() === notice.evidenceBundleDigest);
			store.activation.enable(
				{
					interactionId: event.interactionId,
					noticeId: event.nonce,
					actorId: event.actorId,
					applicationId: event.applicationId,
					channelId: event.channelId,
					messageId: event.messageId,
				},
				this.options.now(),
			);
			return "已记录你对这份配置的启用授权；实际发布仍需全部安全条件成立。";
		}
		store.activation.disable(
			event.interactionId,
			event.actorId,
			event.epoch,
			this.options.now(),
		);
		return store.unresolvedDecision("flywheel")
			? "已停止新的自动发布；已有提交尚未核对完成，正在继续确认结果。"
			: "已停止新的自动发布。";
	}
}
