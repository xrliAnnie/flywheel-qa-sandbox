import { releaseMessageDigest } from "./cards.js";
import type { VerifiedReleaseInteraction } from "./interaction-gateway.js";
import type { ManualReleaseDelivery } from "./manual.js";
import type { CustomerReleaseStore } from "./store.js";

export interface ReleaseInteractionTarget {
	epoch: number;
	founderId: string;
	applicationId: string;
	guildId: string;
	channelId: string;
	botUserId: string;
}
interface Options {
	store: CustomerReleaseStore;
	/** Current canonical owner/config; never taken from the interaction body. */
	target: () => ReleaseInteractionTarget;
	now: () => number;
	/** Read the latest independently verified access/message probe without awaiting network. */
	manualDelivery: (requestId: string) => ManualReleaseDelivery | null;
}
function valid(value: unknown): asserts value {
	if (!value) throw new Error("customer release action binding rejected");
}

/** Only the authenticated Gateway calls this synchronous commit boundary.
 * Candidate actions and activation actions have separate durable authorities. */
export class ReleaseCandidateActions {
	constructor(private readonly options: Options) {}
	commit(event: VerifiedReleaseInteraction): string {
		const target = this.options.target();
		valid(
			event.actorId === target.founderId &&
				event.epoch === target.epoch &&
				event.guildId === target.guildId &&
				event.channelId === target.channelId &&
				event.applicationId === target.applicationId,
		);
		const messageDigest = releaseMessageDigest(event);
		const store = this.options.store,
			now = this.options.now();
		if (event.action === "veto") {
			const cycle = store.cycleForNotice(event.nonce);
			valid(cycle && cycle.activationEpoch === target.epoch);
			const notice = store.notice(cycle.cycleId);
			valid(
				notice &&
					notice.messageDigest === messageDigest &&
					notice.botUserId === target.botUserId,
			);
			const receipt = store.veto(
				cycle.cycleId,
				{
					interactionId: event.interactionId,
					actorId: event.actorId,
					applicationId: event.applicationId,
					channelId: event.channelId,
					messageId: event.messageId,
					noticeId: event.nonce,
					bindingDigest: notice.bindingDigest,
				},
				target.founderId,
				now,
			);
			return receipt.result === "cancelled"
				? "已拦下，本周期不自动发布。"
				: "已记录你的否决。本次已进入发布提交阶段，正在核对结果。";
		}
		if (event.action === "go") {
			const request = store.manual.get(event.nonce);
			valid(
				request &&
					request.card.activationEpoch === target.epoch &&
					request.card.messageDigest === messageDigest &&
					request.card.botUserId === target.botUserId,
			);
			store.manual.go(
				event.nonce,
				{
					interactionId: event.interactionId,
					actorId: event.actorId,
					requestId: event.nonce,
					messageId: event.messageId,
					applicationId: event.applicationId,
					channelId: event.channelId,
				},
				this.options.manualDelivery(event.nonce),
				target.founderId,
				now,
			);
			return "已收到对这个安装包的发布确认；执行前仍会核对技术安全条件。";
		}
		throw new Error("unsupported candidate action");
	}
}
