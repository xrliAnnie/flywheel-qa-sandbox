import { describe, expect, it } from "vitest";
import { getFleetConsoleHtml } from "../bridge/fleet-console-html.js";

describe("fleet-console-html (WI-4)", () => {
	const html = getFleetConsoleHtml();

	it("is a complete HTML document", () => {
		expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
		expect(html).toContain("Flywheel Fleet");
		expect(html.trimEnd().endsWith("</html>")).toBe(true);
	});

	it("wires the four real backend endpoints", () => {
		expect(html).toContain("/api/fleet/snapshot");
		expect(html).toContain("/api/fleet/stage");
		expect(html).toContain("/api/fleet/apply");
		expect(html).toContain("/api/fleet/progress");
	});

	it("did not leak an unevaluated TS template placeholder", () => {
		// The embedded JS uses string concat, not ${} — so no `${` must survive.
		expect(html).not.toContain("${");
	});

	it("sends toModel keyed by the exact engine key (stage payload shape)", () => {
		expect(html).toContain("toModel");
		expect(html).toContain("confirmToken");
		expect(html).toContain("canonicalRequest");
	});

	// ── FLY-709 P5: three interaction models collapse into ONE batch ──

	it("FLY-709 P5: ONE unified draft + counter + apply across lead/runner/flag", () => {
		// A single change-set (allChanges) feeds one counter (updateApplyBar) and
		// one submit (runApplyUnified). Per-source drafts exist for all three.
		expect(html).toContain("allChanges");
		expect(html).toContain("updateApplyBar");
		expect(html).toContain("runApplyUnified");
		expect(html).toContain("runnerChanges");
		expect(html).toContain("flagChanges");
		expect(html).toContain("draftRunner");
		expect(html).toContain("draftFlag");
		// the shared counter copy
		expect(html).toContain("项修改");
	});

	it("FLY-709 P5: flags are DRAFTED into the batch, never instant-toggled", () => {
		// Direct-toggle flags now feed draftFlag (data-ff-draft) and apply through
		// the same-origin stage/apply routes as part of the batch — the old
		// instant-apply control (data-ff-apply) is gone.
		expect(html).toContain("data-ff-draft");
		expect(html).toContain("draftFlag");
		expect(html).toContain("/api/fleet/flag/stage");
		expect(html).toContain("/api/fleet/flag/apply");
		expect(html).not.toContain("data-ff-apply");
	});

	it("FLY-709 P5: governance-gate readonly flags render disabled (uneditable)", () => {
		// Readonly (conversational / governance) flags stay uneditable but display
		// consistently as a disabled "只读" control instead of a toggle.
		expect(html).toContain("只读");
	});

	it("FLY-709 P5: lead-backend cutover stays a manual note inside the unified flow (no Path C copy button)", () => {
		// Backend diffs never reach stage/apply; they surface as a durable
		// manual-cutover note (FLY-264 unbuilt). The separate P4 lead copy-command
		// button (copyCmdBtn) is removed — the batch now carries the cutover note.
		// (FleetCmd itself stays: the cron section keeps its copy-command path.)
		expect(html).toContain("draftBackend");
		expect(html).toContain("需人工 cutover");
		expect(html).toContain("st-note"); // cutover result-row styling
		expect(html).toContain("FLY-264");
		expect(html).toContain("Antigravity / Kimi");
		expect(html).not.toContain('id="copyCmdBtn"');
	});

	it("FLY-709: renders the feature-flag cards NATIVELY (Apple cards, no iframe)", () => {
		expect(html).toContain('id="ffSection"');
		expect(html).toContain("Feature Flags");
		// native client-side card rendering from the snapshot (no iframe, no dark)
		expect(html).not.toContain("<iframe");
		expect(html).toContain("renderFlagCards");
		expect(html).toContain("featureFlags");
	});

	it("is Apple-light (no dark theme) with left-border category cards", () => {
		expect(html).toContain("#f5f5f7"); // light page background
		expect(html).toContain("border-left:4px solid"); // card category color coding
		expect(html).not.toContain("#0d1117"); // never the old GitHub-dark bg
	});

	it("FLY-709 P5: runner-default rows drive the batch via the runner route (no copy command)", () => {
		expect(html).toContain('id="runnerDefaults"');
		expect(html).toContain("projectRunnerDefaults");
		expect(html).toContain("renderRunnerDefaults");
		expect(html).toContain("runnerCapabilities");
		// dropdowns feed draftRunner and apply through the new runner route
		expect(html).toContain("/api/fleet/runner/stage");
		expect(html).toContain("/api/fleet/runner/apply");
		// the old per-row copy-command button is gone
		expect(html).not.toContain("data-rd-copy");
	});

	it("FLY-709 P4.4: cron model rows keep their --cron copy commands", () => {
		// Cron stays a copy-command path (gate-agreed: unify runner-defaults +
		// flags; cron copy-command is acceptable for this increment).
		expect(html).toContain('id="cronSection"');
		expect(html).toContain("cronModels");
		expect(html).toContain("data-cron-copy");
	});

	it("FLY-709 P5: overflow fix — long flag keys/state wrap instead of breaking", () => {
		expect(html).toContain("overflow-wrap");
	});
});
