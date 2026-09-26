/**
 * FLY-1041 Chunk 9 (Fix D) — `ask --report` questions are excluded from the
 * founder-reply binding candidate set.
 *
 * A runner's DONE report is transport-wise still a question (the Lead relay,
 * pending CLI, liveness all see it), but the founder-reply deliverer must
 * never bind a founder thread message to it — reports were the biggest
 * `founder_reply_ambiguous` denominator inflator in the FLY-910 incident.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const emitSpy = vi.fn(async () => {});
vi.mock("../founder-reply-deliverer.js", async () => {
	const actual = await vi.importActual<
		typeof import("../founder-reply-deliverer.js")
	>("../founder-reply-deliverer.js");
	return {
		...actual,
		emitFounderReplyDeliveryForThread: (...args: unknown[]) =>
			emitSpy(...(args as [])),
	};
});

import { GatePoller, type GatePollerConfig } from "../gate-poller.js";

const OWNER = "123456789012345678";

describe("founderReplyDeliverPass excludes kind='report' questions", () => {
	let tmp: string;

	type Priv = { founderReplyDeliverPass(): Promise<void> };

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "fly1041-report-excl-"));
		process.env.FLYWHEEL_COMM_DIR = tmp;
		// Freshly-inserted questions must count as scan-mature this tick.
		process.env.FLYWHEEL_SHIP_GATE_GRACE_MS = "0";
		emitSpy.mockClear();
	});

	afterEach(() => {
		delete process.env.FLYWHEEL_SHIP_GATE_GRACE_MS;
		rmSync(tmp, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("a DONE report never joins the thread candidate set; real questions still do", async () => {
		const db = new CommDB(join(tmp, "flywheel", "comm.db"));
		const reportQid = db.insertQuestion(
			"exec-1",
			"test-lead",
			"DONE: merged | commits: abc",
			{ kind: "report" },
		);
		const shipQid = db.insertQuestion("exec-1", "test-lead", "PR ready", {
			checkpoint: "approve_to_ship",
		});
		const plainQid = db.insertQuestion(
			"exec-1",
			"test-lead",
			"which db should I use?",
		);
		db.close();

		const store = {
			getSession: vi.fn(() => ({
				execution_id: "exec-1",
				issue_id: "FLY-1041",
				project_name: "flywheel",
			})),
			getChatThreadByIssue: vi.fn(() => ({ thread_id: "T1" })),
		} as unknown as GatePollerConfig["store"];

		const poller = new GatePoller({
			pollIntervalMs: 3_000,
			projects: [
				{
					projectName: "flywheel",
					leads: [{ agentId: "test-lead", botToken: "bot", chatChannel: "C1" }],
				},
			] as unknown as GatePollerConfig["projects"],
			store,
			runtimeRegistry: {} as unknown as GatePollerConfig["runtimeRegistry"],
			chatThreadsEnabled: true,
			discordOwnerUserId: OWNER,
		}) as unknown as Priv;

		await poller.founderReplyDeliverPass();

		expect(emitSpy).toHaveBeenCalledTimes(1);
		const questions = emitSpy.mock.calls[0]?.[1] as Array<{
			questionId: string;
		}>;
		const qids = questions.map((q) => q.questionId);
		expect(qids).toContain(shipQid);
		expect(qids).toContain(plainQid);
		expect(qids).not.toContain(reportQid);
	});
});
