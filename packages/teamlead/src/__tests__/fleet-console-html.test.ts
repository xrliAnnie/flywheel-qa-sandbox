import { describe, expect, it } from "vitest";
import { getFleetConsoleHtml } from "../bridge/fleet-console-html.js";

describe("management console HTML", () => {
	const html = getFleetConsoleHtml();

	it("is a complete full-window Flywheel management console", () => {
		expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
		expect(html).toContain("<title>Flywheel 管理台</title>");
		expect(html.trimEnd().endsWith("</html>")).toBe(true);
		expect(html).toContain("height:100vh");
		expect(html).toContain("position:sticky");
		expect(html).toContain("bottom:0");
	});

	it("has exactly the two prototype-level home pages and the instance tabs", () => {
		expect(html.match(/data-nav=/g)).toHaveLength(2);
		expect(html).toContain("实例</button>");
		expect(html).toContain("Feature Flags</button>");
		expect(html).toContain("搜索项目");
		expect(html).toContain("模型");
		expect(html).toContain("DAG 模板");
		expect(html).toContain("Cron");
	});

	it("uses only the aggregate read and unified write/progress endpoints", () => {
		for (const path of [
			"/api/fleet/snapshot",
			"/api/fleet/changes/stage",
			"/api/fleet/changes/apply",
			"/api/fleet/progress",
		]) {
			expect(html).toContain(path);
		}
		expect(html).not.toMatch(/\/api\/fleet\/(flag|runner)\/(stage|apply)/);
		expect(html).not.toContain('fetch("/api/fleet/stage"');
		expect(html).not.toContain('fetch("/api/fleet/apply"');
		expect(html).not.toContain("data-cron-copy");
	});

	it("contains one pending draft map and a server-canonical old-to-new confirmation flow", () => {
		expect(html).toContain("var drafts={}");
		expect(html).toContain("server canonical");
		expect(html).toContain("oldValue");
		expect(html).toContain("newValue");
		expect(html).toContain("consequence");
		expect(html).toContain("放弃");
		expect(html).toContain("部分成功");
	});

	it("does not expose controls for the retired workflow rollout flags", () => {
		expect(html).not.toContain("snapshot.dagPanel");
		expect(html).not.toContain("DAG 控制 · 五杆三事实");
		expect(html).not.toContain("data-dag-command");
	});

	it("ships syntactically valid dependency-free browser JavaScript", () => {
		const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
		expect(scripts).toHaveLength(1);
		expect(() => Function(scripts[0]![1]!)).not.toThrow();
	});

	it("is source-driven, secret-safe, dependency-free, and link-safe", () => {
		for (const forbidden of [
			"PROJECTS",
			"VENDORS",
			"FLAG_GROUPS",
			"com.xiaorongli.weee-weekly",
			"codex-infra-bot-lead",
			"<iframe",
			"<script src=",
			"<link rel=",
			"${",
		]) {
			expect(html).not.toContain(forbidden);
		}
		expect(html).toContain("snapshot.modelCatalog");
		expect(html).toContain("snapshot.presentationGroups");
		expect(html).toContain("snapshot.extensions");
		expect(html).toContain('rel="noopener noreferrer"');
	});
});
