import { getEncoding } from "js-tiktoken";
import { describe, expect, it } from "vitest";
import { bindAdmittedVoiceCapabilities } from "../voice-capability-brief.js";

const manifest = {
	manifestDigest: "b".repeat(64),
	operationIds: ["linear.issue.read", "github.pr.read", "browser.list_pages"],
	deniedOperationIds: ["bridge.ship", "bridge.merge"],
	browserMode: "off" as const,
};
function snapshot(state = "FLY-2886 正在处理") {
	const snapshotDigest = "a".repeat(64);
	const header = `[voice-context version=1 snapshotDigest=${snapshotDigest} sessionId=voice-test]`;
	const baseInstructions = `${header}\n\nBACKGROUND_DETAIL`;
	const realtimePrompt = `${header}\n\n# Voice opening brief\n## 能做 / 不能做\n后台工具清单现在读不到\n\n## 何时交后台\n要查最新信息才交后台。\n\n## 此刻状态\n${state}\n\n## Memory 索引摘要\n${"memory index ".repeat(500)}\n\n# Realtime voice protocol\nPreserve IDs.`;
	return {
		snapshotDigest,
		baseInstructions,
		realtimePrompt,
		contextGeneration: 8,
		manifest: {
			snapshotDigest,
			rosterDigest: "roster",
			leaseBindingDigest: "lease",
		},
		measurements: {
			baseInstructions: {
				bytes: Buffer.byteLength(baseInstructions),
				estimatedTokens: 100,
			},
			realtimePrompt: {
				bytes: Buffer.byteLength(realtimePrompt),
				estimatedTokens: 100,
			},
		},
	};
}

describe("admitted capability opening brief", () => {
	it("binds both prompt headers and measured bytes/tokens without mutating the source snapshot", () => {
		const source = snapshot();
		const completed = bindAdmittedVoiceCapabilities(source, manifest);
		expect(completed.realtimePrompt).toContain("后台工具类别：GitHub、Linear");
		expect(completed.realtimePrompt).toContain(
			"不能：bridge.merge、bridge.ship",
		);
		expect(completed.realtimePrompt).not.toContain("清单现在读不到");
		expect(completed.realtimePrompt).toContain("这场没有浏览器工具");
		expect(completed.snapshotDigest).not.toBe(source.snapshotDigest);
		expect(completed.baseInstructions).toContain(
			`snapshotDigest=${completed.snapshotDigest}`,
		);
		expect(completed.manifest).toMatchObject({
			sourceSnapshotDigest: source.snapshotDigest,
			capabilityManifestDigest: manifest.manifestDigest,
			rosterDigest: "roster",
			leaseBindingDigest: "lease",
			snapshotDigest: completed.snapshotDigest,
		});
		expect(completed.contextGeneration).toBe(8);
		expect(source.realtimePrompt).toContain("清单现在读不到");
		for (const key of ["baseInstructions", "realtimePrompt"] as const) {
			expect(completed.measurements[key].bytes).toBe(
				Buffer.byteLength(completed[key]),
			);
			expect(completed.measurements[key].estimatedTokens).toBe(
				getEncoding("o200k_base").encode(completed[key]).length,
			);
		}
	});
	it("keeps the actual 4096-token bound after adding admitted categories and reserved actions", () => {
		const completed = bindAdmittedVoiceCapabilities(
			snapshot("最新状态。".repeat(1200)),
			manifest,
		);
		expect(
			completed.measurements.realtimePrompt.estimatedTokens,
		).toBeLessThanOrEqual(4096);
		expect(completed.realtimePrompt).toContain(
			"不能：bridge.merge、bridge.ship",
		);
		expect(completed.realtimePrompt).toContain("# Realtime voice protocol");
	});
	it("does not promise a configured browser with no admitted browser operations", () => {
		const completed = bindAdmittedVoiceCapabilities(snapshot(), {
			...manifest,
			operationIds: ["linear.issue.read"],
			browserMode: "founder_chrome",
		});
		expect(completed.realtimePrompt).toContain("这场没有浏览器工具");
		expect(completed.realtimePrompt).not.toContain("使用 founder Chrome");
	});
	it("advertises a browser only with both admitted operation and actual browser mode", () => {
		const completed = bindAdmittedVoiceCapabilities(snapshot(), {
			...manifest,
			browserMode: "isolated",
		});
		expect(completed.realtimePrompt).toContain("使用隔离浏览器");
		expect(completed.realtimePrompt).toContain("浏览器。");
	});
	it("rejects a source header that no longer binds both prompt layers", () => {
		const source = snapshot();
		source.baseInstructions = "unbound";
		expect(() => bindAdmittedVoiceCapabilities(source, manifest)).toThrow(
			"voice_capability_context_invalid",
		);
	});
	it("says which integrations this session runs without, in fixed words, and never lists them as usable (FLY-2886 §14.1)", () => {
		const completed = bindAdmittedVoiceCapabilities(snapshot(), {
			...manifest,
			operationIds: [
				"github.pr.read",
				"xiaohongshu.publish_content",
				"docs.lookup",
				"start_runner",
			],
			browserMode: "founder_chrome" as const,
			unavailableIntegrations: [
				{ id: "browser", reason: "provider_start_failed" },
				{ id: "context7", reason: "baseline_drift" },
				{ id: "linear", reason: "credential_missing" },
				{ id: "xiaohongshu-mcp", reason: "host_config_unverified" },
			],
		});
		expect(completed.realtimePrompt).toContain(
			"这场没接上：浏览器（启动失败）、Context7 文档（工具表跟登记的不一致）、Linear（缺凭据）、小红书（宿主没配置）。问到这些我直接说查不了，不去试。",
		);
		expect(completed.realtimePrompt).toContain(
			"后台工具类别：GitHub、Runner。",
		);
		expect(completed.realtimePrompt).toContain("这场没有浏览器工具");
		expect(completed.realtimePrompt).not.toMatch(/founder Chrome/u);
	});
	// FLY-2886 QA@4 D1: the background model (gpt-6-astra) is code-mode-only and
	// Codex defers MCP tools, so `exec` shows lead_operation as a bare
	// {name, description} — no input schema. 3/3 real sessions found the tool and
	// still said "no PR query entry". The call contract and the admitted operation
	// catalog must therefore be in the background instructions themselves.
	it("gives the background agent the lead_operation call contract and the admitted operation catalog", () => {
		const completed = bindAdmittedVoiceCapabilities(snapshot(), {
			...manifest,
			operationIds: [
				"github.pr.view",
				"linear.issue.get",
				"linear.issue.update",
				"bridge.read",
				"browser.list_pages",
			],
			deniedOperationIds: ["bridge.merge", "bridge.ship"],
			unavailableIntegrations: [],
		});
		const background = completed.baseInstructions;
		expect(background).toContain("tools.mcp__lead_actions__lead_operation(");
		expect(background).toContain("schemaVersion: 1");
		expect(background).toMatch(/requestId: "<[^>]*UUID[^>]*>"/u);
		expect(background).toContain("ALL_TOOLS");
		for (const id of [
			"github.pr.view",
			"linear.issue.get",
			"linear.issue.update",
			"bridge.read",
		])
			expect(background).toMatch(
				new RegExp(
					`^- ${id.replaceAll(".", "\\.")} \\[(read|write)\\] \\{`,
					"mu",
				),
			);
		// Input fields come from the catalog schema, required vs optional marked.
		expect(background).toMatch(
			/^- linear\.issue\.get \[read\] \{[^}]*\bissueId\b/mu,
		);
		expect(background).toMatch(/^- linear\.issue\.update \[write\] \{/mu);
		// Browser is off for this session: its operations are not advertised, and
		// reserved/denied actions are never presented as callable.
		expect(background).not.toMatch(/^- browser\./mu);
		expect(background).not.toMatch(/^- bridge\.(merge|ship) /mu);
		// The realtime brief stays within its own budget and carries no catalog.
		expect(completed.realtimePrompt).not.toContain(
			"mcp__lead_actions__lead_operation",
		);
		expect(completed.measurements.baseInstructions.bytes).toBe(
			Buffer.byteLength(background),
		);
	});
	it("adds no line when every integration is connected", () => {
		const completed = bindAdmittedVoiceCapabilities(snapshot(), {
			...manifest,
			unavailableIntegrations: [],
		});
		expect(completed.realtimePrompt).not.toContain("这场没接上");
	});
});
