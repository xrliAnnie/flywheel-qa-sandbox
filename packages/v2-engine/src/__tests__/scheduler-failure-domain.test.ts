/**
 * FLY-1501 QA — the scheduler's failure domain is isolated from consumption.
 *
 * Contract (mapping §4.4): "`SchedulerConfig` 的解析/校验只属于短命 scheduler
 * failure domain：配置缺失或矛盾时该轮 scheduler fail-loud/不执行 restart，但不得
 * 阻断、停掉或降级 agent 自己的 mailbox poll/consume loop."
 *
 * Noting that `runSchedulerOnce` validates before doing anything is not a proof.
 * This drives both halves in their real production topology — a live
 * `EngineDriver` consume loop in this process, and the actual `scheduler-once`
 * CLI as a separate short-lived process — against one shared kernel database,
 * and asserts the loop keeps draining while the scheduler dies loudly and
 * leaves nothing behind.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	advanceDatabaseAuthorityStateTx,
	armCutoverAuthority,
	publishLiveCutoverAuthority,
	publishMigrationCompleteMarker,
	seedPreCutoverAuthority,
} from "flywheel-v2-kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineDriver } from "../driver.js";
import type { ConversionResult } from "../types.js";
import {
	type EngineFixture,
	enqueueMailbox,
	makeEngineFixture,
	testSessionBinding,
} from "./helpers.js";

const SCHEDULER_CLI = fileURLToPath(
	new URL("../../../v2-scheduler/dist/cli.js", import.meta.url),
);
const GATE_BIN = fileURLToPath(
	new URL("../../../../scripts/restart-storm-gate.py", import.meta.url),
);

const LEAD_DRAFT = {
	kind: "lead",
	leadId: "lead-a",
	instanceId: "instance-1",
	sessionBinding: testSessionBinding("instance-1"),
} as const;
const SCHEDULER_WINDOW = "scheduler-failure-domain";
const SCHEDULER_EPOCH = 1;

function schedulerContract(fixture: EngineFixture): {
	markerPath: string;
	authorityPath: string;
	armedPath: string;
} {
	const markerPath = join(fixture.dir, "migration-complete.json");
	const authorityPath = join(fixture.dir, "cutover-authority.json");
	const armedPath = join(fixture.dir, "cutover-armed.json");
	if (!existsSync(markerPath)) {
		seedPreCutoverAuthority({
			authorityPath,
			armedPath,
			windowId: SCHEDULER_WINDOW,
			epoch: SCHEDULER_EPOCH,
			nowIso: "2026-07-28T00:00:00.000Z",
		});
		armCutoverAuthority({
			authorityPath,
			armedPath,
			windowId: SCHEDULER_WINDOW,
			epoch: SCHEDULER_EPOCH,
			nowIso: "2026-07-28T00:01:00.000Z",
		});
		fixture.kernel.write("test.scheduler-cutover-window", (tx) => {
			tx.run(
				`INSERT INTO meta(key,value,updated_at)
				 VALUES ('cutover_window_id',@window,@now)
				 ON CONFLICT(key) DO UPDATE SET
				   value=excluded.value,updated_at=excluded.updated_at`,
				{
					window: SCHEDULER_WINDOW,
					now: "2026-07-28T00:01:00.000Z",
				},
			);
		});
		publishMigrationCompleteMarker({
			dbPath: fixture.path,
			markerPath,
			authorityPath,
			armedPath,
			expectedWindowId: SCHEDULER_WINDOW,
			expectedEpoch: SCHEDULER_EPOCH,
			nowIso: "2026-07-28T00:02:00.000Z",
		});
		fixture.kernel.write("test.scheduler-live-authority", (tx) => {
			advanceDatabaseAuthorityStateTx(tx, {
				expected: "cutover",
				next: "live",
				nowIso: "2026-07-28T00:02:01.000Z",
			});
		});
		publishLiveCutoverAuthority({
			authorityPath,
			armedPath,
			windowId: SCHEDULER_WINDOW,
			epoch: SCHEDULER_EPOCH,
			nowIso: "2026-07-28T00:02:02.000Z",
		});
	}
	return { markerPath, authorityPath, armedPath };
}

/**
 * Run the real short-lived scheduler process against the shared database.
 * Missing build output is a loud failure, never a silent skip — a skipped
 * isolation proof is indistinguishable from a passing one.
 */
function runSchedulerCli(
	fixture: EngineFixture,
	env: Record<string, string>,
): { status: number; stderr: string } {
	if (!existsSync(SCHEDULER_CLI)) {
		throw new Error(
			`v2-scheduler CLI not built at ${SCHEDULER_CLI} — run \`pnpm build\` at the workspace root first`,
		);
	}
	const contract = schedulerContract(fixture);
	try {
		execFileSync(
			process.execPath,
			[
				SCHEDULER_CLI,
				"--db",
				fixture.path,
				"--marker",
				contract.markerPath,
				"--authority",
				contract.authorityPath,
				"--armed",
				contract.armedPath,
				"--window",
				SCHEDULER_WINDOW,
				"--epoch",
				String(SCHEDULER_EPOCH),
				"--project",
				"flywheel",
				"--backend",
				"launchd",
				"--gate-bin",
				GATE_BIN,
				"--uid",
				"501",
			],
			{ encoding: "utf8", env: { ...process.env, ...env }, stdio: "pipe" },
		);
		return { status: 0, stderr: "" };
	} catch (error) {
		const err = error as { status?: number; stderr?: string };
		return { status: err.status ?? -1, stderr: String(err.stderr ?? "") };
	}
}

function countRows(fixture: EngineFixture, table: string): number {
	return (
		fixture.kernel.read((tx) =>
			tx.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`),
		)?.n ?? -1
	);
}

function leadLastPollAt(fixture: EngineFixture): string | null {
	return (
		fixture.kernel.read((tx) =>
			tx.get<{ last_poll_at: string | null }>(
				"SELECT last_poll_at FROM agents WHERE agent_id='lead-a'",
			),
		)?.last_poll_at ?? null
	);
}

function mailboxStates(fixture: EngineFixture): string[] {
	return fixture.kernel
		.read((tx) =>
			tx.all<{ state: string }>("SELECT state FROM mailbox ORDER BY seq"),
		)
		.map((row) => row.state);
}

describe("a broken scheduler config never degrades the consume loop", () => {
	let fixture: EngineFixture | undefined;
	let driver: EngineDriver | undefined;

	afterEach(() => {
		driver?.stop();
		fixture?.cleanup();
		driver = undefined;
		fixture = undefined;
	});

	it.each([
		["non-canonical zero", "0"],
		["non-numeric", "not-a-number"],
		["padded integer", "04"],
	])(
		"fails the scheduler process loudly on a %s knob and writes no scheduler state",
		(_label, value) => {
			fixture = makeEngineFixture();
			enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });

			const run = runSchedulerCli(fixture, {
				FLYWHEEL_V2_RESTART_CONCURRENCY_MAX: value,
			});

			expect(run.status).not.toBe(0);
			expect(run.stderr).toMatch(/FLYWHEEL_V2_RESTART_CONCURRENCY_MAX/);
			// Fail-loud must also be fail-clean: nothing for a later tick to reconcile.
			expect(countRows(fixture, "scheduler_runs")).toBe(0);
			expect(countRows(fixture, "scheduler_leases")).toBe(0);
			expect(countRows(fixture, "scheduler_repair_leases")).toBe(0);
			// And the pending message it never looked at is untouched.
			expect(mailboxStates(fixture)).toEqual(["pending"]);
		},
		60_000,
	);

	it("keeps a live consume loop draining across a failed scheduler tick", async () => {
		fixture = makeEngineFixture();
		// Fastest cadence the engine config allows, so the heartbeat is observable
		// within the test budget without weakening the assertion.
		fixture.kernel.write("test.fast-heartbeat", (tx) => {
			tx.run(
				`UPDATE config SET value='1000' WHERE key='mailbox.heartbeat_write_interval_ms'`,
			);
		});
		enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });
		enqueueMailbox(fixture, { uid: "m2", agent: "lead-a" });

		const seen: string[] = [];
		const converter = vi.fn(
			async (message: { messageUid: string }): Promise<ConversionResult> => {
				seen.push(message.messageUid);
				return { ok: true, effects: [] };
			},
		);
		driver = new EngineDriver(fixture.kernel, fixture.runtime);
		await driver.registerLead("lead-a", LEAD_DRAFT, converter);
		await driver.drain("lead-a");
		expect(seen).toEqual(["m1", "m2"]);

		// Break the scheduler while the loop's registration is still live, and put
		// the same poisoned knob in *this* process's environment too — a consumer
		// must not care about a variable that kills the scheduler.
		const previous = process.env.FLYWHEEL_V2_RESTART_CONCURRENCY_MAX;
		process.env.FLYWHEEL_V2_RESTART_CONCURRENCY_MAX = "not-a-number";
		try {
			const run = runSchedulerCli(fixture, {
				FLYWHEEL_V2_RESTART_CONCURRENCY_MAX: "not-a-number",
			});
			expect(run.status).not.toBe(0);

			// Same registration, new mail: the loop is neither stopped nor degraded.
			enqueueMailbox(fixture, { uid: "m3", agent: "lead-a" });
			await driver.drain("lead-a");
		} finally {
			if (previous === undefined) {
				delete process.env.FLYWHEEL_V2_RESTART_CONCURRENCY_MAX;
			} else {
				process.env.FLYWHEEL_V2_RESTART_CONCURRENCY_MAX = previous;
			}
		}

		expect(seen).toEqual(["m1", "m2", "m3"]);
		expect(mailboxStates(fixture)).toEqual(["applied", "applied", "applied"]);
		expect(countRows(fixture, "scheduler_runs")).toBe(0);

		// Liveness, not just usability: the consumer's independent fenced heartbeat
		// timer — the very signal the guard uses to decide a Lead is dead — is still
		// firing after the scheduler died. The fixture clock is frozen, so move it
		// and wait for a beat to stamp the new time; a stopped timer would leave
		// `last_poll_at` at the old value forever.
		const beforeBeat = leadLastPollAt(fixture);
		fixture.clock.advance(60_000);
		const expected = fixture.clock.nowIso();
		expect(expected).not.toBe(beforeBeat);
		await vi.waitFor(() => expect(leadLastPollAt(fixture)).toBe(expected), {
			timeout: 15_000,
			interval: 100,
		});
	}, 60_000);

	it("still completes a healthy scheduler tick against the same database", () => {
		// Positive control. Without it, "zero scheduler_runs" above would also be
		// satisfied by a CLI that can never reach the database at all.
		fixture = makeEngineFixture();
		enqueueMailbox(fixture, { uid: "m1", agent: "lead-a" });

		const run = runSchedulerCli(fixture, {
			FLYWHEEL_V2_RESTART_CONCURRENCY_MAX: "1",
		});

		expect(run.status).toBe(0);
		expect(countRows(fixture, "scheduler_runs")).toBe(1);
		// No stale Lead heartbeat exists, so it must not have repaired anything.
		expect(countRows(fixture, "scheduler_repair_leases")).toBe(0);
		expect(mailboxStates(fixture)).toEqual(["pending"]);
	}, 60_000);
});
