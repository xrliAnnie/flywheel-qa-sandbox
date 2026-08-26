// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getFleetConsoleHtml } from "../bridge/fleet-console-html.js";

describe("management console visual regression contract", () => {
	afterEach(() => {
		document.documentElement.innerHTML = "";
	});

	it("uses the prototype light window shell and active navigation treatment", () => {
		const html = getFleetConsoleHtml();
		document.open();
		document.write(html.replace(/<script>[\s\S]*?<\/script>/, ""));
		document.close();

		expect(document.querySelector(".window-frame")).not.toBeNull();
		expect(document.querySelector(".window-chrome")).not.toBeNull();
		expect(document.querySelectorAll(".traffic-dot")).toHaveLength(3);
		expect(html).toContain("#eef0f4");
		expect(html).toContain("#f7f8fb");
		expect(html).toContain("#5646d6");
		expect(html).not.toContain("#15233d");

		const side = document.querySelector(".side")!;
		const activeNav = document.querySelector(".nav-button.active")!;
		expect(getComputedStyle(side).backgroundColor).toBe("#f7f8fb");
		expect(getComputedStyle(activeNav).backgroundColor).toBe("#ecebfb");
		expect(getComputedStyle(activeNav).color).toBe("#5646d6");
	});

	it("reserves readable widths for provider, model, and effort controls", () => {
		const html = getFleetConsoleHtml();
		expect(html).toContain('class="model-provider"');
		expect(html).toContain('class="model-model"');
		expect(html).toContain('class="model-effort"');
		expect(html).toMatch(
			/\.three\{display:grid;grid-template-columns:minmax\(0,\.9fr\) minmax\(0,1\.2fr\) minmax\(0,\.65fr\)/,
		);
		expect(html).toMatch(
			/\.lead-row \.three\{grid-template-columns:minmax\(132px,\.9fr\) minmax\(170px,1\.2fr\) minmax\(96px,\.65fr\)/,
		);
		expect(html).toContain(
			".grid .card .three{grid-template-columns:minmax(0,.9fr) minmax(0,1.2fr)}",
		);
		expect(html).toContain(".grid .card .model-effort{grid-column:1/-1}");
		expect(html).toContain(
			"@media(max-width:1050px){.lead-row{grid-template-columns:1fr}.three,.lead-row .three{grid-template-columns:1fr}",
		);
		expect(html).not.toContain(
			".dag-row .three,.cron-grid .three{grid-template-columns:minmax(",
		);
		expect(html).toContain("appearance:none");
		expect(html).toContain("padding-right:28px");
	});

	it("makes the real-browser harness fail on any card or lead-row overflow", () => {
		const capture = readFileSync(
			resolve(
				process.cwd(),
				"../../engineering/doc/FLY-2054-dashboard-visual-alignment/evidence/capture.mjs",
			),
			"utf8",
		);
		expect(capture).toContain(
			'document.querySelectorAll("select[data-model-part]")',
		);
		expect(capture).toContain("controlOverflows");
		expect(capture).toContain("model controls overflow their container");
	});

	it("keeps revision data for CAS without rendering it in the project header", () => {
		const html = getFleetConsoleHtml();
		expect(html).toContain("observedRevision");
		expect(html).not.toContain("真源 revision");
		expect(html).toContain("个可见 Lead");
	});
});
