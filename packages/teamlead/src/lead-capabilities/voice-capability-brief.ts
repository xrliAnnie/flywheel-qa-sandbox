import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import type { LeadCapabilityManifest } from "./manifest.js";

interface VoiceBriefSnapshot {
	baseInstructions: string;
	realtimePrompt: string;
	snapshotDigest: string;
	manifest: { snapshotDigest: string; [key: string]: unknown };
	measurements: {
		baseInstructions: { bytes: number; estimatedTokens: number };
		realtimePrompt: { bytes: number; estimatedTokens: number };
	};
}
let tokenizer: ReturnType<typeof getEncoding> | undefined;
const countTokens = (text: string) => {
	tokenizer ??= getEncoding("o200k_base");
	return tokenizer.encode(text).length;
};

/** Call only after the actual child config, skills and tools have been admitted. */
export function bindAdmittedVoiceCapabilities<T extends VoiceBriefSnapshot>(
	snapshot: T,
	manifest: Pick<LeadCapabilityManifest, "manifestDigest" | "operationIds" | "deniedOperationIds" | "browserMode">,
): T {
	const browser = manifest.browserMode !== "off" &&
		manifest.browserMode !== undefined &&
		manifest.operationIds.some((id) => id.startsWith("browser."));
	const labels: Record<string, string> = {
		linear: "Linear", github: "GitHub", git: "Git", discord: "Discord",
		bridge: "Bridge", voice: "语音会话", memory: "记忆", docs: "文档查询",
		web: "网页检索", browser: "浏览器", report: "报告", artifact: "文件材料",
		terminal: "终端状态", inbox: "收件箱", patrol: "巡检", xiaohongshu: "小红书",
	};
	const categories = [...new Set(manifest.operationIds.flatMap((id) => {
		const family = id.split(".")[0]!;
		if (family === "browser" && !browser) return [];
		return [id.includes("runner") ? "Runner" : (labels[family] ?? family)];
	}))].sort();
	const capabilityText = categories.length
		? `后台工具类别：${categories.join("、")}。`
		: "后台当前没有已接通的业务工具。";
	const browserText = browser
		? manifest.browserMode === "founder_chrome"
			? "网页操作可交后台使用 founder Chrome；我不能直接看到你的整块屏幕。"
			: "网页操作可交后台使用隔离浏览器；我不能直接看到你的屏幕。"
		: "这场没有浏览器工具；我不能直接看到你的屏幕。";
	const section = `## 能做 / 不能做\n我自己聊天、回答简报里已有的信息；${capabilityText}${browserText}\n不能：${[...manifest.deniedOperationIds].sort().join("、") || "当前清单未列出；不能据此视为授权"}。不确定能不能做时先让后台查，不夸口；需要给链接时发到文字 thread。`;
	const originalHeader = snapshot.realtimePrompt.split("\n", 1)[0]!;
	if (!originalHeader.includes(`snapshotDigest=${snapshot.snapshotDigest} `) ||
		!snapshot.baseInstructions.startsWith(originalHeader + "\n"))
		throw new Error("voice_capability_context_invalid");
	let realtimeBody = snapshot.realtimePrompt.slice(originalHeader.length);
	const placeholder = /## 能做 \/ 不能做\n[\s\S]*?(?=\n\n## 何时交后台)/u;
	realtimeBody = placeholder.test(realtimeBody)
		? realtimeBody.replace(placeholder, section)
		: `${realtimeBody}\n\n${section}`;
	const baseBody = snapshot.baseInstructions.slice(originalHeader.length);
	const digest = () => createHash("sha256").update(JSON.stringify({
		sourceSnapshotDigest: snapshot.snapshotDigest,
		capabilityManifestDigest: manifest.manifestDigest,
		baseBody, realtimeBody,
	})).digest("hex");
	const render = () => {
		const snapshotDigest = digest();
		const header = originalHeader.replace(snapshot.snapshotDigest, snapshotDigest);
		return { snapshotDigest, baseInstructions: header + baseBody, realtimePrompt: header + realtimeBody };
	};
	if (countTokens(render().realtimePrompt) > 4096)
		realtimeBody = realtimeBody.replace(/\n\n## Memory 索引摘要[\s\S]*?(?=\n\n# Realtime voice protocol|$)/u, "");
	if (countTokens(render().realtimePrompt) > 4096)
		realtimeBody = realtimeBody.replace(/## 此刻状态[\s\S]*?(?=\n\n# Realtime voice protocol|$)/u, "## 此刻状态\n状态我让后台去查。");
	const completed = render();
	if (countTokens(completed.realtimePrompt) > 4096)
		throw new Error("voice_capability_context_too_large");
	return {
		...snapshot, ...completed,
		manifest: { ...snapshot.manifest, snapshotDigest: completed.snapshotDigest,
			sourceSnapshotDigest: snapshot.snapshotDigest, capabilityManifestDigest: manifest.manifestDigest },
		measurements: {
			baseInstructions: { bytes: Buffer.byteLength(completed.baseInstructions), estimatedTokens: countTokens(completed.baseInstructions) },
			realtimePrompt: { bytes: Buffer.byteLength(completed.realtimePrompt), estimatedTokens: countTokens(completed.realtimePrompt) },
		},
	};
}
