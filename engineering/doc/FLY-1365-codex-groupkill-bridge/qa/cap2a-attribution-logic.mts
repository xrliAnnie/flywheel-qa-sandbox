/**
 * QA·FLY-1365 — Capability ② part A: attribution CORRECTNESS (real functions).
 *
 * Drives the REAL boot-attribution functions (imported from source):
 *   findWatchdogStallForExit + buildAbnormalExitAlertContent + abnormalExitTicketEventId
 *
 * Proves the boot code turns "previous Bridge was watchdog-SIGKILLed" into the
 * right attributed alert content — AND refuses to mis-attribute a shared / QA /
 * pid-reused watchdog log (falls back to generic). Mutation-controlled: flip any
 * one of the 3 match conditions → attribution must drop to generic.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	abnormalExitTicketEventId,
	buildAbnormalExitAlertContent,
	findWatchdogStallForExit,
} from "../../../../packages/teamlead/src/bridge/bridge-exit-marker.js";

const PREV = { pid: 30576, bootTs: 1_000_000, state: "running" as const };
const CURRENT_BOOT = 2_000_000; // this generation booted here; prev boot window = [1_000_000, 2_000_000)

function stallLine(over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		event: "bridge_event_loop_stall",
		stall_age_ms: 64298,
		threshold_ms: 60000,
		at: new Date(1_500_000).toISOString(), // inside the prev boot window
		pid: PREV.pid,
		bootTs: PREV.bootTs,
		last_sync_op: "codex-tui:tmux-exec",
		...over,
	});
}

function writeLog(lines: string[]): { path: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "fly1365-attr-"));
	const path = join(dir, "bridge-watchdog.log");
	writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
	return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

let pass = true;
const check = (name: string, ok: boolean, detail = "") => {
	console.log(
		`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`,
	);
	if (!ok) pass = false;
};

console.log("── Capability ② part A: attribution correctness ──\n");

// 1. Exact match → attributed alert with stall age + last sync op.
{
	const { path, cleanup } = writeLog([stallLine()]);
	const rec = findWatchdogStallForExit(path, PREV, CURRENT_BOOT);
	const content = buildAbnormalExitAlertContent(PREV, rec);
	const ok =
		rec !== null &&
		rec.stall_age_ms === 64298 &&
		content.title.includes("卡死自杀") &&
		content.body.includes("64298") &&
		content.body.includes("codex-tui:tmux-exec");
	check(
		"exact pid+generation+in-window match → watchdog-attributed content",
		ok,
		`title="${content.title}"`,
	);
	cleanup();
}

// 2. MUTATION: pid mismatch (another Bridge / pid reuse) → generic fallback.
{
	const { path, cleanup } = writeLog([stallLine({ pid: 99999 })]);
	const rec = findWatchdogStallForExit(path, PREV, CURRENT_BOOT);
	const content = buildAbnormalExitAlertContent(PREV, rec);
	check(
		"pid mismatch → NOT attributed (generic fallback)",
		rec === null &&
			content.title.includes("非正常退出") &&
			!content.title.includes("卡死自杀"),
	);
	cleanup();
}

// 3. MUTATION: generation (bootTs) mismatch → generic fallback.
{
	const { path, cleanup } = writeLog([stallLine({ bootTs: 1_234_567 })]);
	const rec = findWatchdogStallForExit(path, PREV, CURRENT_BOOT);
	check("bootTs (generation) mismatch → NOT attributed", rec === null);
	cleanup();
}

// 4. MUTATION: stall `at` BEFORE the prev boot window (stale prior-generation line) → reject.
{
	const { path, cleanup } = writeLog([
		stallLine({ at: new Date(500_000).toISOString() }),
	]);
	const rec = findWatchdogStallForExit(path, PREV, CURRENT_BOOT);
	check(
		"stall timestamp before prev boot window → NOT attributed",
		rec === null,
	);
	cleanup();
}

// 4b. MUTATION: stall `at` AT/AFTER current boot → reject (must be strictly < currentBootTs).
{
	const { path, cleanup } = writeLog([
		stallLine({ at: new Date(CURRENT_BOOT).toISOString() }),
	]);
	const rec = findWatchdogStallForExit(path, PREV, CURRENT_BOOT);
	check("stall timestamp >= current boot → NOT attributed", rec === null);
	cleanup();
}

// 5. Picks the NEWEST matching record when several generations are present.
{
	const { path, cleanup } = writeLog([
		stallLine({ pid: 111, bootTs: 111 }), // other gen
		stallLine({ stall_age_ms: 61000, at: new Date(1_200_000).toISOString() }), // older match
		stallLine({ stall_age_ms: 64298, at: new Date(1_800_000).toISOString() }), // newest match
	]);
	const rec = findWatchdogStallForExit(path, PREV, CURRENT_BOOT);
	check(
		"selects the newest in-window matching record",
		rec?.stall_age_ms === 64298,
		`got ${rec?.stall_age_ms}`,
	);
	cleanup();
}

// 6. Defensive read: garbage / oversized / missing → generic fallback, never throws.
{
	const { path, cleanup } = writeLog(["not json", "{}", '{"event":"other"}']);
	const rec = findWatchdogStallForExit(path, PREV, CURRENT_BOOT);
	check("garbage log lines → NOT attributed, no throw", rec === null);
	cleanup();
	// non-existent path
	const rec2 = findWatchdogStallForExit(
		"/no/such/fly1365/path.log",
		PREV,
		CURRENT_BOOT,
	);
	check("missing log file → NOT attributed, no throw", rec2 === null);
}

// 7. Idempotency: the ticket eventId is stable (pid+bootTs) → dedup across restarts.
{
	const id1 = abnormalExitTicketEventId(PREV);
	const id2 = abnormalExitTicketEventId(PREV);
	const idOther = abnormalExitTicketEventId({ ...PREV, bootTs: 1_000_001 });
	check(
		"ticket eventId stable per generation + distinct across generations",
		id1 === id2 && id1 !== idOther,
		`id=${id1}`,
	);
}

console.log(`\nRESULT: ${pass ? "PASS ✅" : "FAIL ❌"}`);
process.exit(pass ? 0 : 1);
