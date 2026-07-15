#!/usr/bin/env node
/**
 * FLY-1255 — INDEPENDENT QA harness (written fresh by QA session 212eca7e).
 *
 * Drives the REAL compiled dist chain end-to-end, exactly as the Bridge would:
 *   dispatch {vendor, model} → renderRunnerModelDisplay
 *                            → sessionModelDisplay (session-shaped resolution)
 *                            → applyModelMarker    (founder-visible thread title)
 *                            → runnerDisplayName + buildWindowLabel (cmux window)
 *
 * Asserts on the exact founder-visible strings, then hands every produced window
 * name to the REAL production `is_managed_runner_title` gate (separate script).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = "/Users/xiaorongli/Dev/flywheel-FLY-1255";

const cfg = require(`${ROOT}/packages/config/dist/index.js`);
const su = require(`${ROOT}/packages/teamlead/dist/bridge/stage-utils.js`);
const rd = require(`${ROOT}/packages/teamlead/dist/bridge/run-dispatcher.js`);
const rmd = require(
	`${ROOT}/packages/teamlead/dist/bridge/runner-model-display.js`,
);
const core = require(`${ROOT}/packages/core/dist/index.js`);

let pass = 0;
const failures = [];
const windowNames = [];

function check(name, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		failures.push(`${name}\n      expected: ${e}\n      actual:   ${a}`);
		console.log(`  ✗ ${name}\n      expected: ${e}\n      actual:   ${a}`);
	}
}

/** Full founder-visible thread title, as ChatThreadCreator composes it. */
function threadTitle(badge, issueKey, title, marker) {
	const prefix = badge ? `${badge} ` : "";
	const base = `[${issueKey}] ${title}`;
	const marked = su.applyModelMarker(base, marker ?? undefined);
	return `${prefix}${marked.slice(0, Math.max(0, 100 - prefix.length))}`;
}

/** Full cmux window name, as run-dispatcher + core compose it. */
function windowName(session, issueKey, title) {
	const display = rmd.sessionModelDisplay(session, {});
	const runner = rd.runnerDisplayName(
		session.chat_thread_role,
		session.shareParentBranch,
		display,
	);
	// TmuxAdapter.sanitizeWindowName() = sanitizeTmuxName(name) — the real final
	// step before `tmux new-window`, i.e. the exact name the founder sees in cmux.
	const w = core.sanitizeTmuxName(
		core.buildWindowLabel(issueKey, runner, title),
	);
	windowNames.push(w);
	return w;
}

const LONG =
	"Fix a deliberately long founder visible issue title that will truncate";

console.log(
	"\n=== 1. Codex backend (the actual FLY-1255 bug: GPT-5.6 must show) ===",
);
{
	const s = {
		adapter_type: "codex-tmux",
		runner_model: "gpt-5.6-sol",
		chat_thread_role: "implement",
		shareParentBranch: true,
	};
	const d = rmd.sessionModelDisplay(s, {});
	check("codex thread marker", d.threadMarker, "G");
	check(
		"codex window label (dots→dashes: tmux-legal)",
		d.windowLabel,
		"codex-G",
	);
	check(
		"codex founder thread title",
		threadTitle(
			"🔨实现",
			"FLY-1255",
			"Vendor-neutral model display",
			d.threadMarker,
		),
		"🔨实现 [G] [FLY-1255] Vendor-neutral model display",
	);
	const w = windowName(s, "FLY-1255", LONG);
	check(
		"codex cmux window keeps vendor+model+phase",
		w.startsWith("FLY-1255-implement-codex-G"),
		true,
	);
	check("codex window ≤50 chars", w.length <= 50, true);
}

console.log(
	"\n=== 2. Kimi backend (must not be swallowed by Claude logic) ===",
);
{
	const s = {
		adapter_type: "kimi-tmux",
		runner_model: "kimi-for-coding",
		chat_thread_role: null,
	};
	const d = rmd.sessionModelDisplay(s, {});
	check("kimi thread marker", d.threadMarker, "K");
	check("kimi window label", d.windowLabel, "kimi-K");
	check(
		"kimi founder thread title",
		threadTitle("", "FLY-9", "Kimi backend", d.threadMarker),
		"[K] [FLY-9] Kimi backend",
	);
	check(
		"kimi window is managed namespace",
		windowName(s, "FLY-9", LONG).includes("runner-kimi-K"),
		true,
	);
}

console.log(
	"\n=== 3. Claude backward-compat (FLY-755 F/O/S/H must not regress) ===",
);
{
	const s = {
		adapter_type: "claude-tmux",
		runner_model: "claude-fable-5",
		chat_thread_role: null,
	};
	const d = rmd.sessionModelDisplay(s, {});
	check(
		"claude keeps bare short code (not 'Model Fable')",
		d.threadMarker,
		"F",
	);
	check(
		"claude founder thread title unchanged shape",
		threadTitle("", "LEARN-143", "Claude run", d.threadMarker),
		"[F] [LEARN-143] Claude run",
	);
}
{
	// model absent → must stay byte-compatible `claude` window, no marker.
	const s = {
		adapter_type: "claude-tmux",
		runner_model: null,
		chat_thread_role: null,
	};
	check(
		"model-absent → no display descriptor",
		rmd.sessionModelDisplay(s, {}),
		undefined,
	);
	check(
		"model-absent window stays 'claude'",
		windowName(s, "FLY-1", LONG).startsWith("FLY-1-claude-"),
		true,
	);
	check(
		"model-absent title carries no marker",
		threadTitle("", "FLY-1", "Legacy", undefined),
		"[FLY-1] Legacy",
	);
}

console.log(
	"\n=== 4. Honesty: missing backend metadata must NOT claim claude ===",
);
{
	const s = {
		adapter_type: null,
		runner_model: "gpt-5.6-sol",
		chat_thread_role: null,
	};
	const d = rmd.sessionModelDisplay(s, {});
	check(
		"missing adapter + gpt model → codex, never claude-*",
		d.windowLabel,
		"codex-G",
	);
	check("missing adapter marker", d.threadMarker, "G");
}
{
	// vendor/model disagree → must not misrepresent a gpt model as a Claude tier.
	const d = cfg.renderRunnerModelDisplay({
		vendor: "claude",
		model: "gpt-5.6",
	});
	check(
		"vendor/model mismatch → no fake Claude short code",
		d.threadMarker,
		"Model gpt-5.6",
	);
}

console.log(
	"\n=== 5. Pending phase truth (no runner_model yet → planned dispatch) ===",
);
{
	const s = {
		adapter_type: null,
		runner_model: null,
		chat_thread_role: "implement",
	};
	const planned = cfg.resolvePhaseDispatch("implement", {});
	const d = rmd.sessionModelDisplay(s, {});
	check(
		"pending implement resolves planned dispatch",
		d.threadMarker,
		cfg.renderRunnerModelDisplay(planned).threadMarker,
	);
	check(
		"pending implement is not blank",
		typeof d.threadMarker === "string" && d.threadMarker.length > 0,
		true,
	);
	// kill-switch honored
	const off = rmd.sessionModelDisplay(s, {
		FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT: "0",
	});
	check(
		"implement kill-switch → claude heavy tier (fable=F)",
		off.threadMarker,
		"F",
	);
	const designOn = rmd.sessionModelDisplay(
		{ adapter_type: null, runner_model: null, chat_thread_role: "design" },
		{ FLYWHEEL_THREE_STAGE_CODEX_DESIGN: "1" },
	);
	check(
		"design kill-switch on → codex marker",
		designOn.threadMarker,
		"G",
	);
}

console.log("\n=== 6. Marker safety: injection + round-trip idempotency ===");
{
	check(
		"injection ']' payload rejected",
		su.applyModelMarker("[FLY-1] T", "Model bad]value"),
		"[FLY-1] T",
	);
	check(
		"injection bracket payload rejected",
		su.applyModelMarker("[FLY-1] T", "[evil]"),
		"[FLY-1] T",
	);
	check(
		"arbitrary unnamespaced marker rejected",
		su.applyModelMarker("[FLY-1] T", "GPT-5.6"),
		"[FLY-1] T",
	);
	check(
		"keyless base never stamped",
		su.applyModelMarker("no key here", "G"),
		"no key here",
	);

	// idempotency: re-stamping must not churn or stack markers.
	const once = su.applyModelMarker("[FLY-1255] T", "G");
	const twice = su.applyModelMarker(once, "G");
	check("re-stamp is idempotent (no marker stacking)", twice, once);
	check(
		"marker round-trips through parser",
		su.modelMarkerLabel(once),
		"G",
	);
	check("strip returns bare base", su.stripModelMarker(once), "[FLY-1255] T");

	// model switch: codex → claude must replace, not append.
	check(
		"switching model replaces marker",
		su.applyModelMarker(once, "F"),
		"[F] [FLY-1255] T",
	);
	// clear
	check(
		"clear removes marker",
		su.applyModelMarker(once, undefined),
		"[FLY-1255] T",
	);
	// legacy FLY-728 tail migrates to front marker
	check("legacy tail ·F recognized", su.modelMarkerLabel("[FLY-1] T ·F"), "F");
	check(
		"legacy tail migrates to front",
		su.applyModelMarker("[FLY-1] T ·F", "G"),
		"[G] [FLY-1] T",
	);
}

console.log("\n=== 7. Opaque / hostile model ids stay bounded ===");
{
	const d = cfg.renderRunnerModelDisplay({
		vendor: "weird",
		model: "a".repeat(80),
	});
	check("payload capped at 24", d.threadMarker, `Model ${"a".repeat(24)}`);
	check(
		"capped marker still round-trips",
		su.modelMarkerLabel(su.applyModelMarker("[FLY-1] T", d.threadMarker)),
		d.threadMarker,
	);
	const s = cfg.renderRunnerModelDisplay({
		vendor: "x/../../etc",
		model: "m;rm -rf /",
	});
	check(
		"shell/path metachars sanitized out of window label",
		/^[A-Za-z0-9-]+$/.test(s.windowLabel),
		true,
	);
	check(
		"empty model → undefined",
		cfg.renderRunnerModelDisplay({ vendor: "codex", model: "  " }),
		undefined,
	);
}

console.log("\n=== window names produced (fed to the real shell gate) ===");
for (const w of windowNames) console.log(`  ${w}`);
require("node:fs").writeFileSync(
	"/tmp/fly1255-window-names.txt",
	`${windowNames.join("\n")}\n`,
);

console.log(`\n${"=".repeat(60)}`);
console.log(`RESULT: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
	console.log("\nFAILURES:");
	for (const f of failures) console.log(`  ✗ ${f}`);
	process.exit(1);
}
