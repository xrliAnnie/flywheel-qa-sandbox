/**
 * FLY-493: isolate the per-project CommDB for ALL teamlead tests.
 *
 * `commDbPathForProject` / `defaultGetCommDbPath` default to the LIVE Bridge
 * comm.db root (`~/.flywheel/comm/<project>/comm.db`). On the dev machine the
 * production Bridge gate-watcher reads that path, so tests that exercise gate /
 * session-completion / pre-register paths leak rows into the live comm.db —
 * leaked gate questions then time out and spam the Lead.
 *
 * `FLYWHEEL_COMM_DIR` (honored by `commDbRootDir()`) is the narrow override that
 * redirects ONLY the comm.db root (not HOME / templates / static assets). A
 * FRESH temp dir PER TEST keeps each test's comm.db clean — no cross-test
 * contamination and no writes to the live Bridge comm.db. Prod (real run, not
 * vitest) is byte-compatible (env unset → default path).
 *
 * Tests that need a specific comm.db path must compute it via
 * `commDbPathForProject(project)` (the shared helper), NOT a hardcoded
 * `~/.flywheel/comm/...`, so they resolve to the same isolated root.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";

// A fresh comm.db root per test → clean db, no cross-test contamination, no live
// writes. We deliberately do NOT rmSync in an afterEach: some tests have async
// work (Promise.all notifier / archive) still in-flight when afterEach runs, and
// deleting the dir under them would inject a spurious failure. The dirs live in
// the OS tmpdir and are reclaimed by the OS — leaking a few KB per test is fine.
beforeEach(() => {
	process.env.FLYWHEEL_COMM_DIR = mkdtempSync(
		join(tmpdir(), "flywheel-tl-test-comm-"),
	);
	// FLY-827: the legacy teamlead suite was written for pre-hard-gate behavior —
	// it drives sessions to awaiting_review and asserts founder surfacing / QA
	// spawn / heartbeat escalation, which the DEFAULT-ON codex hard gate would now
	// hold. Default the suite to gate-OFF (byte-compat = original behavior). The
	// FLY-827 codex-gate tests inject an explicit env (coordinator `env`, isReviewHeld
	// `env` arg, verify-approval `env`/`.env`) so they are unaffected by this default.
	process.env.FLYWHEEL_CODEX_HARD_GATE = "0";
});
