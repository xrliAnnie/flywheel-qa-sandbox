import { createHash } from "node:crypto";
import { contentDigest } from "./canonical.js";
import type { freezeWrite } from "./contracts.js";
export type ReviewFile = { name: string; bytes: Buffer; sha256: string };
export function reviewFile(name: string, bytes: Buffer): ReviewFile {
	return {
		name,
		bytes,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}
export function buildPreview(
	frozen: ReturnType<typeof freezeWrite>,
	challenge: string,
	expiresAt: number,
) {
	if (
		!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(challenge) ||
		!Number.isSafeInteger(expiresAt) ||
		expiresAt < 0
	)
		throw Error("preview_invalid");
	const digest = contentDigest(frozen);
	const fullText = [
		"小红书完整审核材料",
		`请求：${frozen.proposalId}`,
		`内容指纹：${digest}`,
		"以下标题与正文是待发布的用户内容：",
		"--- 标题 ---",
		frozen.payload.title ?? "（无）",
		"--- 正文 ---",
		frozen.payload.content ?? "（无）",
		"--- 完整冻结字段（含账号、目标、选项及媒体顺序）---",
		JSON.stringify(frozen, null, 2),
		"--- 系统边界 ---",
		"无商品绑定。批准一次尝试；超时可能已发送。删除/编辑批准消息不等于撤回。",
	].join("\n");
	const content = [
		`小红书逐次审核 ${frozen.proposalId}`,
		`账号稳定编号：${frozen.account.accountUserId}`,
		`动作：${frozen.operationId}`,
		`内容指纹：${digest}`,
		`材料截止：${new Date(expiresAt).toISOString()}`,
		"请完整查看本卡关联的文字、图片/视频及冻结选项。",
		"批准一次尝试，超时可能已发送；失败也不能重复使用批准。",
		"批准后最多15分钟内执行，并且不超过材料截止时间。",
		`回复本卡：批准小红书 ${challenge}`,
		`尚未消费时撤回：撤回小红书 ${challenge}`,
		`拒绝：拒绝小红书 ${challenge}`,
		"删除/编辑批准消息不等于撤回；已开始的尝试无法撤销。",
	].join("\n");
	return {
		content,
		files: [reviewFile("review.txt", Buffer.from(fullText, "utf8"))],
		contentDigest: digest,
	};
}
