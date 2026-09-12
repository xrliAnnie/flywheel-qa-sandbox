// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { getFleetConsoleHtml } from "../bridge/fleet-console-html.js";

afterEach(() => {
	vi.unstubAllGlobals();
	document.documentElement.innerHTML = "";
});
it("renders cached beta cadence as read-only escaped text with safe run links", async () => {
	const betaSchedule = {
		owner: "bridge",
		configuredIntervalHours: 6,
		effectiveIntervalHours: 6,
		nextDueAtMs: 1800000000000,
		observedAtMs: 1799990000000,
		status: "ready",
		label: "<img src=x onerror=alert(1)>",
		reason: null,
		activeRuns: [
			{ id: 3, url: "https://github.com/test/a/actions/runs/3" },
			{ id: 4, url: "javascript:alert(1)" },
		],
		lastPublished: {
			version: "<script>alert(1)</script>",
			sourceCommit: "a".repeat(40),
			publishedAt: "2026-09-11T00:00:00Z",
		},
	};
	const snapshot = {
		schemaVersion: 2,
		snapshotRevision: "r",
		generatedAt: "2026-09-11T00:00:00Z",
		sources: [],
		modelCatalog: {},
		presentationGroups: [],
		flags: [],
		extensions: [],
		unassignedCrons: [],
		projects: [
			{
				id: "a",
				name: "a",
				presentationGroup: "a",
				sourceRevision: "r",
				leads: [],
				roles: [],
				dags: [],
				crons: [],
				betaSchedule,
			},
		],
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify(snapshot))),
	);
	const html = getFleetConsoleHtml();
	const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
	document.open();
	document.write(html.replace(/<script>[\s\S]*?<\/script>/, ""));
	document.close();
	Function(script)();
	await vi.waitFor(() =>
		expect(document.querySelector(".beta-schedule")).not.toBeNull(),
	);
	const panel = document.querySelector(".beta-schedule")!;
	expect(panel.textContent).toContain("6 小时");
	expect(panel.textContent).toContain("<img src=x onerror=alert(1)>");
	expect(panel.querySelector("img")).toBeNull();
	expect(panel.querySelector("script")).toBeNull();
	expect(panel.querySelectorAll("a")).toHaveLength(1);
	expect(panel.querySelector("a")?.getAttribute("href")).toBe(
		"https://github.com/test/a/actions/runs/3",
	);
	expect(panel.querySelector("button,input,select")).toBeNull();
});
