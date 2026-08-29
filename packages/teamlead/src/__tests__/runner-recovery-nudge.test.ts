/**
 * FLY-368: the shared, audited runner recovery-nudge operation. The HTTP route
 * already exercises the gate matrix via stuck-remanage-routes.test.ts; here we
 * verify the contract points that matter for the auto-repair-bot reuse:
 *  - audit-before-send is FAIL-CLOSED (audit store down → no keystroke),
 *  - the `actor` is recorded in the audit payload,
 *  - a clean pass sends exactly once and records handled_remanaged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	attemptRunnerRecoveryNudge,
	type RunnerNudgeDeps,
} from "../bridge/runner-recovery-nudge.js";
import { fingerprintOutput } from "../bridge/stuck-candidate.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";

const projects: ProjectEntry[] = [
	{
		projectName: "geo",
		projectRoot: "/tmp/geo",
		leads: [
			{
				agentId: "product-lead",
				chatChannel: "c",
				match: { labels: ["Product"] },
			},
		],
	},
] as unknown as ProjectEntry[];

const STUCK_FRAME = [
	"⎿ API Error: Stream idle timeout - partial response received",
	"────────────────────────────────────── @runner ──",
	"❯ ",
	"──────────────────────────────────────────────────",
	"  Opus 4.8 | runner | ctx 40%",
	"  ⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");
const STUCK_FP = fingerprintOutput(STUCK_FRAME);

describe("attemptRunnerRecoveryNudge (FLY-368 shared audited op)", () => {
	let store: StateStore;
	let sendKeys: ReturnType<typeof vi.fn>;
	let seq: number;

	function deps(over: Partial<RunnerNudgeDeps> = {}): RunnerNudgeDeps {
		return {
			store,
			projects,
			captureSessionFn: async () => ({
				output: STUCK_FRAME,
				tmux_target: "geo:@1",
				lines: 100,
				captured_at: "now",
			}),
			hasPendingGate: () => false,
			sendKeys: sendKeys as unknown as RunnerNudgeDeps["sendKeys"],
			getTmuxTarget: () => ({ tmuxWindow: "geo:@1", sessionName: "geo" }),
			now: () => 1000,
			nextAuditSeq: () => ++seq,
			...over,
		};
	}

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "FLY-1",
			project_name: "geo",
			status: "running",
			issue_labels: JSON.stringify(["Product"]),
		});
		sendKeys = vi.fn(async () => ({ sent: true }));
		seq = 0;
	});

	it("clean pass: sends once, returns nudged, records handled_remanaged + audit with actor", async () => {
		const out = await attemptRunnerRecoveryNudge(
			{
				actor: "auto-repair-bot",
				executionId: "exec-1",
				leadId: "product-lead",
				fingerprint: STUCK_FP,
				phrase: "continue",
			},
			deps(),
		);
		expect(out.status).toBe(200);
		expect(out.body.nudged).toBe(true);
		expect(sendKeys).toHaveBeenCalledTimes(1);
		expect(sendKeys).toHaveBeenCalledWith("geo:@1", "continue");
		// implicit disposition recorded
		expect(store.getStuckDisposition("exec-1", STUCK_FP)?.disposition).toBe(
			"handled_remanaged",
		);
		// audit rows carry the actor
		const audits = store
			.getEventsByExecution("exec-1")
			.filter((e) => e.event_type === "runner_recovery_nudge");
		expect(audits.length).toBeGreaterThanOrEqual(2); // attempt + sent
		expect((audits[0]!.payload as { actor: string }).actor).toBe(
			"auto-repair-bot",
		);
	});

	it("FAIL-CLOSED: if the audit 'attempt' write fails, NO keystroke is sent", async () => {
		// The audit-before-send contract fails CLOSED when the audit WRITE throws
		// (Codex R1 PR MEDIUM-1). Throw only on the pre-send "attempt" row.
		const realInsert = store.insertEvent.bind(store);
		vi.spyOn(store, "insertEvent").mockImplementation((ev) => {
			const payload = ev.payload as { result?: string } | undefined;
			if (payload?.result === "attempt") throw new Error("audit store down");
			return realInsert(ev);
		});
		const out = await attemptRunnerRecoveryNudge(
			{
				actor: "auto-repair-bot",
				executionId: "exec-1",
				leadId: "product-lead",
				fingerprint: STUCK_FP,
				phrase: "continue",
			},
			deps(),
		);
		expect(out.status).toBe(503);
		expect(out.body.nudged).toBe(false);
		expect(sendKeys).not.toHaveBeenCalled();
	});

	it("refuses a phrase outside the allowlist (no send)", async () => {
		const out = await attemptRunnerRecoveryNudge(
			{
				actor: "auto-repair-bot",
				executionId: "exec-1",
				leadId: "product-lead",
				fingerprint: STUCK_FP,
				phrase: "rm -rf /",
			},
			deps(),
		);
		expect(out.status).toBe(400);
		expect(out.body.nudged).toBe(false);
		expect(sendKeys).not.toHaveBeenCalled();
	});

	it("refuses when fingerprint no longer matches the live terminal", async () => {
		const out = await attemptRunnerRecoveryNudge(
			{
				actor: "auto-repair-bot",
				executionId: "exec-1",
				leadId: "product-lead",
				fingerprint: "0000000000000000",
				phrase: "continue",
			},
			deps(),
		);
		expect(out.status).toBe(409);
		expect(sendKeys).not.toHaveBeenCalled();
	});
});
