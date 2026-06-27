/**
 * FLY-598: prevent the flywheel-comm test suite from leaking to PRODUCTION
 * infrastructure when it is run inside a live Flywheel runner session.
 *
 * A running Runner exports `FLYWHEEL_BRIDGE_URL` (the real Bridge, e.g.
 * http://127.0.0.1:9876), `FLYWHEEL_COMM_DB` (the real ~/.flywheel/comm/...
 * comm.db) and `FLYWHEEL_LAND_STATUS_PATH` into the environment. Several tests
 * spawn the real CLI as a subprocess (`cli.test.ts`, `e2e-workflows.test.ts`,
 * `commands.test.ts`) via `execFileSync(..., { env: { ...process.env } })`, so
 * the child inherits those vars and would POST real `runner_question` /
 * `gate_*` events to the live Bridge (→ "notify Annie") and write real rows to
 * the production comm DB.
 *
 * This setup file runs BEFORE every test file (vitest `setupFiles`), in the
 * parent process, so the neutralized values are what any spawned child
 * inherits:
 *   - FLYWHEEL_BRIDGE_URL = ""  → the CLI skips all event POSTs (an empty URL
 *     is an explicitly supported "no Bridge" state — see gate.test.ts
 *     "does NOT POST event when FLYWHEEL_BRIDGE_URL is unset").
 *   - FLYWHEEL_COMM_DB → an isolated temp path, never the real comm DB. Tests
 *     that need a DB pass `--db <tmp>` (which overrides this) anyway.
 *   - privileged tokens / runner identity / land-status are cleared so nothing
 *     authenticates against prod and no inherited land-status pollutes a test.
 *
 * Tests that need any of these set their own values in `beforeEach`, which
 * runs after this file — so this is purely defensive and changes no in-test
 * behaviour on CI (where these vars are absent to begin with).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Empty Bridge URL → CLI (and any spawned CLI child) skips every event POST.
process.env.FLYWHEEL_BRIDGE_URL = "";

// Isolated comm DB → no write can reach the production ~/.flywheel/comm DB.
process.env.FLYWHEEL_COMM_DB = join(
	mkdtempSync(join(tmpdir(), "flywheel-comm-test-isolated-")),
	"comm.db",
);

// Drop prod credentials / runner identity / land-status inherited from a live
// runner session. Each test that needs one re-sets it in its own beforeEach.
for (const key of [
	"FLYWHEEL_INGEST_TOKEN",
	"TEAMLEAD_API_TOKEN",
	"FLYWHEEL_LAND_STATUS_PATH",
]) {
	delete process.env[key];
}
