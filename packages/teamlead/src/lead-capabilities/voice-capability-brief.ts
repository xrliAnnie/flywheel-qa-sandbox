import { createHash } from "node:crypto";
import { getEncoding } from "js-tiktoken";
import { z } from "zod";
import { LEAD_ACTIONS_MCP_SERVER_NAME } from "../lead-backends/codex/lead-actions/mcp-config.js";
import { getLeadCapability } from "./catalog.js";
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
/** Fixed spoken names; raw provider errors never reach the prompt (plan v12 §14.1). */
const UNAVAILABLE_NAMES: Record<string, string> = {
	browser: "浏览器",
	context7: "Context7 文档",
	github: "GitHub",
	linear: "Linear",
	"xiaohongshu-mcp": "小红书",
};
const UNAVAILABLE_REASONS: Record<string, string> = {
	credential_missing: "缺凭据",
	host_config_unverified: "宿主没配置",
	baseline_drift: "工具表跟登记的不一致",
	provider_start_failed: "启动失败",
};
/** Operation families owned by an optional integration. */
const FAMILY_INTEGRATION: Record<string, string> = {
	browser: "browser",
	docs: "context7",
	git: "github",
	github: "github",
	linear: "linear",
	xiaohongshu: "xiaohongshu-mcp",
};
let tokenizer: ReturnType<typeof getEncoding> | undefined;
const countTokens = (text: string) => {
	tokenizer ??= getEncoding("o200k_base");
	return tokenizer.encode(text).length;
};

/** One compact `{field: type, optional?: type}` line from the catalog schema. */
function inputShape(schema: z.ZodType): string {
	let json: Record<string, unknown>;
	try {
		json = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<
			string,
			unknown
		>;
	} catch {
		return "{…}";
	}
	const properties = (json.properties ?? {}) as Record<
		string,
		Record<string, unknown>
	>;
	const required = new Set((json.required as string[] | undefined) ?? []);
	const type = (value: Record<string, unknown>): string => {
		const values = value.enum as unknown[] | undefined;
		if (Array.isArray(values) && values.length <= 8)
			return values.map((entry) => JSON.stringify(entry)).join("|");
		if (value.const !== undefined) return JSON.stringify(value.const);
		if (value.type === "array") {
			const items = value.items as Record<string, unknown> | undefined;
			return `${items ? type(items) : "any"}[]`;
		}
		if (typeof value.type === "string") return value.type;
		return "any";
	};
	return `{${Object.entries(properties)
		.map(
			([name, value]) =>
				`${name}${required.has(name) ? "" : "?"}: ${type(value)}`,
		)
		.join(", ")}}`;
}

/**
 * How the background agent acts (FLY-2886 QA@4 D1). The background model is
 * code-mode-only and Codex defers MCP tools there: `exec` lists lead_operation
 * only as `{name, description}`, never its input schema. Without this contract
 * and catalog the agent finds the tool and still cannot call it.
 */
function leadOperationGuide(operationIds: readonly string[]): string {
	const tool = `mcp__${LEAD_ACTIONS_MCP_SERVER_NAME}__lead_operation`;
	const lines = operationIds.flatMap((id) => {
		const operation = getLeadCapability(id);
		if (!operation || operation.classification === "reserved") return [];
		return [
			`- ${id} [${operation.classification}] ${inputShape(operation.inputSchema)}`,
		];
	});
	return [
		"# Lead operations — how to act",
		`Every read and write goes through lead_operation. In code mode it is a deferred nested tool (listed in ALL_TOOLS as ${tool}); call it inside exec as \`const r = await tools.${tool}({ schemaVersion: 1, operationId: "<id>", requestId: "<a new UUID v4 you write out>", input: { ... } }); text(r);\`. If it is offered as a direct tool, pass the same object. Use one new requestId per request and reuse it only to retry that same request. The result text is JSON {requestId, status, resourceRefs, data?, errorCode?}. Do not tell the founder a capability is missing before trying the matching operation below.`,
		"Admitted operations for this session (id [kind] {input; ? = optional}):",
		...(lines.length > 0 ? lines : ["- none admitted"]),
	].join("\n");
}

/** Call only after the actual child config, skills and tools have been admitted. */
export function bindAdmittedVoiceCapabilities<T extends VoiceBriefSnapshot>(
	snapshot: T,
	manifest: Pick<
		LeadCapabilityManifest,
		| "manifestDigest"
		| "operationIds"
		| "deniedOperationIds"
		| "browserMode"
		| "unavailableIntegrations"
	>,
): T {
	const unavailable = manifest.unavailableIntegrations ?? [];
	const unavailableIds = new Set<string>(unavailable.map((row) => row.id));
	const browser =
		manifest.browserMode !== "off" &&
		manifest.browserMode !== undefined &&
		manifest.operationIds.some((id) => id.startsWith("browser."));
	const labels: Record<string, string> = {
		linear: "Linear",
		github: "GitHub",
		git: "Git",
		discord: "Discord",
		bridge: "Bridge",
		voice: "语音会话",
		memory: "记忆",
		docs: "文档查询",
		web: "网页检索",
		browser: "浏览器",
		report: "报告",
		artifact: "文件材料",
		terminal: "终端状态",
		inbox: "收件箱",
		patrol: "巡检",
		xiaohongshu: "小红书",
	};
	const categories = [
		...new Set(
			manifest.operationIds.flatMap((id) => {
				const family = id.split(".")[0]!;
				if (family === "browser" && !browser) return [];
				const owner = FAMILY_INTEGRATION[family];
				if (owner && unavailableIds.has(owner)) return [];
				return [id.includes("runner") ? "Runner" : (labels[family] ?? family)];
			}),
		),
	].sort();
	const capabilityText = categories.length
		? `后台工具类别：${categories.join("、")}。`
		: "后台当前没有已接通的业务工具。";
	const browserText = browser
		? manifest.browserMode === "founder_chrome"
			? "网页操作可交后台使用 founder Chrome；我不能直接看到你的整块屏幕。"
			: "网页操作可交后台使用隔离浏览器；我不能直接看到你的屏幕。"
		: "这场没有浏览器工具；我不能直接看到你的屏幕。";
	const unavailableText = unavailable.length
		? `这场没接上：${unavailable
				.map(
					(row) =>
						`${UNAVAILABLE_NAMES[row.id] ?? row.id}（${UNAVAILABLE_REASONS[row.reason] ?? "启动失败"}）`,
				)
				.join("、")}。问到这些我直接说查不了，不去试。\n`
		: "";
	const section = `## 能做 / 不能做\n我自己聊天、回答简报里已有的信息；${capabilityText}${browserText}\n${unavailableText}不能：${[...manifest.deniedOperationIds].sort().join("、") || "当前清单未列出；不能据此视为授权"}。不确定能不能做时先让后台查，不夸口；需要给链接时发到文字 thread。`;
	const originalHeader = snapshot.realtimePrompt.split("\n", 1)[0]!;
	if (
		!originalHeader.includes(`snapshotDigest=${snapshot.snapshotDigest} `) ||
		!snapshot.baseInstructions.startsWith(originalHeader + "\n")
	)
		throw new Error("voice_capability_context_invalid");
	let realtimeBody = snapshot.realtimePrompt.slice(originalHeader.length);
	const placeholder = /## 能做 \/ 不能做\n[\s\S]*?(?=\n\n## 何时交后台)/u;
	realtimeBody = placeholder.test(realtimeBody)
		? realtimeBody.replace(placeholder, section)
		: `${realtimeBody}\n\n${section}`;
	const callable = manifest.operationIds.filter((id) => {
		const family = id.split(".")[0]!;
		if (family === "browser" && !browser) return false;
		const owner = FAMILY_INTEGRATION[family];
		return !(owner && unavailableIds.has(owner));
	});
	const baseBody = `${snapshot.baseInstructions.slice(originalHeader.length)}\n\n${leadOperationGuide(callable)}`;
	const digest = () =>
		createHash("sha256")
			.update(
				JSON.stringify({
					sourceSnapshotDigest: snapshot.snapshotDigest,
					capabilityManifestDigest: manifest.manifestDigest,
					baseBody,
					realtimeBody,
				}),
			)
			.digest("hex");
	const render = () => {
		const snapshotDigest = digest();
		const header = originalHeader.replace(
			snapshot.snapshotDigest,
			snapshotDigest,
		);
		return {
			snapshotDigest,
			baseInstructions: header + baseBody,
			realtimePrompt: header + realtimeBody,
		};
	};
	if (countTokens(render().realtimePrompt) > 4096)
		realtimeBody = realtimeBody.replace(
			/\n\n## Memory 索引摘要[\s\S]*?(?=\n\n# Realtime voice protocol|$)/u,
			"",
		);
	if (countTokens(render().realtimePrompt) > 4096)
		realtimeBody = realtimeBody.replace(
			/## 此刻状态[\s\S]*?(?=\n\n# Realtime voice protocol|$)/u,
			"## 此刻状态\n状态我让后台去查。",
		);
	const completed = render();
	if (countTokens(completed.realtimePrompt) > 4096)
		throw new Error("voice_capability_context_too_large");
	return {
		...snapshot,
		...completed,
		manifest: {
			...snapshot.manifest,
			snapshotDigest: completed.snapshotDigest,
			sourceSnapshotDigest: snapshot.snapshotDigest,
			capabilityManifestDigest: manifest.manifestDigest,
		},
		measurements: {
			baseInstructions: {
				bytes: Buffer.byteLength(completed.baseInstructions),
				estimatedTokens: countTokens(completed.baseInstructions),
			},
			realtimePrompt: {
				bytes: Buffer.byteLength(completed.realtimePrompt),
				estimatedTokens: countTokens(completed.realtimePrompt),
			},
		},
	};
}
