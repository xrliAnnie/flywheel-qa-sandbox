import { createHash } from "node:crypto";
import { baseOf, isBetaSemver, isCleanSemver } from "flywheel-release-contract";

interface ReleaseCardInput {
	kind: "veto" | "go";
	nonce: string;
	epoch: number;
	timezone: string;
	betaVersion: string;
	releaseVersion: string;
	sourceCommit: string;
	payloadSha256: string;
	deadlineAt: number;
}

function valid(value: unknown): asserts value {
	if (!value) throw new Error("invalid customer release card");
}

/** Artifact text and action reference are frozen before the first send. */
export function releaseCard(input: ReleaseCardInput) {
	valid(input && (input.kind === "veto" || input.kind === "go"));
	valid(typeof input.nonce === "string" && /^[a-f0-9]{32}$/.test(input.nonce));
	valid(Number.isSafeInteger(input.epoch) && input.epoch > 0);
	valid(
		isCleanSemver(input.releaseVersion) && input.releaseVersion.length <= 128,
	);
	valid(
		isBetaSemver(input.betaVersion) &&
			input.betaVersion.length <= 128 &&
			baseOf(input.betaVersion) === input.releaseVersion,
	);
	valid(
		typeof input.timezone === "string" &&
			input.timezone.length <= 100 &&
			/^[A-Za-z0-9_+/-]+$/.test(input.timezone),
	);
	valid(
		typeof input.sourceCommit === "string" &&
			/^[a-f0-9]{40}$/.test(input.sourceCommit),
	);
	valid(
		typeof input.payloadSha256 === "string" &&
			/^[a-f0-9]{64}$/.test(input.payloadSha256),
	);
	valid(
		Number.isSafeInteger(input.deadlineAt) &&
			input.deadlineAt > 0 &&
			input.deadlineAt <= 8.64e15,
	);
	const deadline = new Intl.DateTimeFormat("en-CA", {
		timeZone: input.timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZoneName: "shortOffset",
	}).format(new Date(input.deadlineAt));
	return {
		content: [
			input.kind === "veto"
				? "本次默认发布；想拦下请点「否决本次发布」。"
				: "手动发布确认：只发布下面这个安装包。",
			`版本：${input.releaseVersion}`,
			`内部候选：${input.betaVersion}`,
			`源码：${input.sourceCommit}`,
			`安装包 SHA-256：${input.payloadSha256}`,
			`截止：${deadline}（${input.timezone}）`,
			input.kind === "veto"
				? "收到「已拦下」回执才表示否决已生效。"
				: "此操作需要你的明确确认，不开启默认发布窗口。",
		].join("\n"),
		components: [
			{
				type: 1,
				components: [
					{
						type: 2,
						style: input.kind === "veto" ? 4 : 3,
						label: input.kind === "veto" ? "否决本次发布" : "发布这个版本",
						custom_id: `fwrel:${input.kind}:${input.epoch}:${input.nonce}`,
					},
				],
			},
		],
		allowed_mentions: { parse: [] },
	};
}

function record(value: unknown): Record<string, unknown> {
	valid(value && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
	valid(Object.keys(value).every((key) => allowed.includes(key)));
	if (value.id !== undefined)
		valid(Number.isSafeInteger(value.id) && (value.id as number) >= 0);
}

/** Both Gateway and independent REST readback reject visible content outside
 * the frozen card before projecting a message into an action DTO. */
export function assertReleaseMessageExtras(value: unknown): void {
	const message = record(value);
	for (const key of [
		"embeds",
		"attachments",
		"stickers",
		"sticker_items",
		"message_snapshots",
	]) {
		valid(
			message[key] === undefined ||
				(Array.isArray(message[key]) && message[key].length === 0),
		);
	}
	for (const key of [
		"poll",
		"message_reference",
		"referenced_message",
		"shared_client_theme",
		"activity",
		"call",
	]) {
		valid(message[key] === undefined || message[key] === null);
	}
}

/** Normalize only wire defaults; reject unsupported visible content, never hash a partial card. */
export function releaseMessageDigest(value: unknown): string {
	const message = record(value);
	valid(
		typeof message.content === "string" &&
			message.content.length > 0 &&
			message.content.length <= 2000,
	);
	assertReleaseMessageExtras(message);
	valid(Array.isArray(message.components) && message.components.length === 1);
	const row = record(message.components[0]);
	keys(row, ["type", "id", "components"]);
	valid(
		row.type === 1 &&
			Array.isArray(row.components) &&
			row.components.length === 1,
	);
	const button = record(row.components[0]);
	keys(button, ["type", "id", "style", "label", "custom_id", "disabled"]);
	valid(button.type === 2 && (button.style === 3 || button.style === 4));
	valid(
		typeof button.label === "string" &&
			button.label.length > 0 &&
			button.label.length <= 80,
	);
	valid(
		typeof button.custom_id === "string" &&
			/^fwrel:(veto|go|enable|disable):[1-9]\d{0,15}:[a-f0-9]{32}$/.test(
				button.custom_id,
			),
	);
	valid(button.disabled === undefined || typeof button.disabled === "boolean");
	return createHash("sha256")
		.update(
			JSON.stringify({
				content: message.content,
				components: [
					{
						type: 1,
						components: [
							{
								type: 2,
								style: button.style,
								label: button.label,
								custom_id: button.custom_id,
								disabled: button.disabled ?? false,
							},
						],
					},
				],
			}),
		)
		.digest("hex");
}
