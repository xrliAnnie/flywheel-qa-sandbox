// @vitest-environment happy-dom

// FLY-1262 QA regression (independent QA phase).
//
// Real-browser QA (Claude-in-Chrome, isolated Bridge) found a ship-blocking
// page-switch/layout defect that the jsdom/happy-dom *interaction* tests never
// asserted: the two top-level pages (#instancesPage / #flagsPage) are not
// mutually exclusive by computed display.
//
// Root cause in fleet-console-html.ts CSS:
//   .page{height:100%;display:none}          (0,1,0)
//   .page.active{display:grid}               (0,2,0) — shows the active page
//   .detail,.flags-page{...display:flex...}  (0,1,0) but LATER in source order
// `.flags-page{display:flex}` ties `.page{display:none}` on specificity but
// wins on source order, so #flagsPage is NEVER hidden. Because it always
// participates in `.workspace{grid-template-rows:minmax(0,1fr)}`, it takes an
// implicit auto row at full content height and collapses the active
// #instancesPage `1fr` row to height 0. Net effect in a real browser: the
// DEFAULT landing page (实例 — the model cascade / DAG / cron core of the PRD)
// renders invisible and the Feature Flags page shows in its place.
//
// These assertions must hold: exactly the active page is displayed.
import { describe, expect, it } from "vitest";
import { getFleetConsoleHtml } from "../bridge/fleet-console-html.js";

function mountShell(): { instances: HTMLElement; flags: HTMLElement } {
	const html = getFleetConsoleHtml();
	document.open();
	document.write(html.replace(/<script>[\s\S]*?<\/script>/, ""));
	document.close();
	const instances = document.getElementById("instancesPage");
	const flags = document.getElementById("flagsPage");
	if (!instances || !flags) throw new Error("page containers missing");
	return { instances, flags };
}

function activate(page: HTMLElement, other: HTMLElement): void {
	page.classList.add("active");
	other.classList.remove("active");
}

describe("management console page switching (real-CSS mutual exclusion)", () => {
	it("shows only the instances page when 实例 is the active nav (default landing)", () => {
		const { instances, flags } = mountShell();
		// Static shell default: instances active, flags inactive.
		expect(instances.classList.contains("active")).toBe(true);
		expect(flags.classList.contains("active")).toBe(false);
		// The active page must be a visible display value; the inactive page
		// MUST compute to display:none (this is what was broken).
		expect(getComputedStyle(instances).display).not.toBe("none");
		expect(getComputedStyle(flags).display).toBe("none");
	});

	it("shows only the flags page when Feature Flags is the active nav", () => {
		const { instances, flags } = mountShell();
		activate(flags, instances);
		expect(getComputedStyle(flags).display).not.toBe("none");
		expect(getComputedStyle(instances).display).toBe("none");
	});

	it("never displays both pages at once in either nav state", () => {
		const { instances, flags } = mountShell();
		const displayedCount = () =>
			[instances, flags].filter(
				(el) => getComputedStyle(el).display !== "none",
			).length;
		// default (instances active)
		expect(displayedCount()).toBe(1);
		// after switching to flags
		activate(flags, instances);
		expect(displayedCount()).toBe(1);
		// back to instances
		activate(instances, flags);
		expect(displayedCount()).toBe(1);
	});
});
