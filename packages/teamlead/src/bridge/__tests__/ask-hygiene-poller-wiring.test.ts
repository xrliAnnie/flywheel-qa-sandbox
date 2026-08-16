/**
 * QA·FLY-1328 — the A2 sweep's PRODUCTION WIRING, through the real GatePoller.
 *
 * Why this file exists (QA finding, added by the QA phase):
 * `ask-hygiene.test.ts` calls `runZombieGateHygiene` directly with a hand-built
 * `pendingGateQuestions` array. That proves the sweep FUNCTION works — but in
 * production nothing hands it a candidate list. `GatePoller.zombieGateHygienePass`
 * builds it, and that seam had NO coverage: two mutations of it survived the
 * entire suite (90/90 still green):
 *
 *   1. Reverting the candidate filter to the pre-FLY-1328 `q.checkpoint != null`
 *      — which makes the ask sweep DEAD IN PRODUCTION (it never sees an ask).
 *   2. Deleting the `sweepBookkeeping` guard — which makes an ASK-only
 *      configuration clear the reconcile's unreachable episodes, the exact
 *      behavior plan §4.1 (Codex R2 #4) forbids.
 *
 * Both are silent failures: the feature simply stops working, or the reconcile
 * silently loses state. Neither shows up as a red test. These cases pin that
 * seam. Each negative assertion is paired with a positive control in the same
 * test — asserting a thing did NOT happen passes just as happily when the
 * harness never wired it up (FLY-1281/1285).
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { GatePoller } from "../gate-poller.js";
import { RuntimeRegistry } from "../runtime-registry.js";
import { defaultGetCommDbPath } from "../session-capture.js";

const PROJECT_NAME = "fly-1328-wiring";
const LEAD = "product-lead";
/** A torn-down runner: UUID-shaped (the sweep's fail-closed identity guard). */
const DEAD_RUNNER = "11111111-2222-3333-4444-555555555555";

const projects: ProjectEntry[] = [
	{
		projectName: PROJECT_NAME,
		projectRoot: "/tmp/fly-1328-wiring-root",
		leads: [
			{ agentId: LEAD, chatChannel: "chat-product", match: { labels: [] } },
		],
	},
];

describe("FLY-1328 A2 sweep — real GatePoller wiring", () => {
	let store: StateStore;
	let tmpHome: string;
	let originalHome: string | undefined;
	let originalCommDir: string | undefined;
	let dbPath: string;
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		// vitest.setup.ts (FLY-493) points FLYWHEEL_COMM_DIR at a fresh temp root
		// before every test and it WINS over HOME — clear it so this suite's HOME
		// redirect is what defaultGetCommDbPath() actually resolves against.
		originalCommDir = process.env.FLYWHEEL_COMM_DIR;
		delete process.env.FLYWHEEL_COMM_DIR;
		tmpHome = join(tmpdir(), `fly1328-wiring-${Date.now()}-${Math.random()}`);
		mkdirSync(tmpHome, { recursive: true });
		process.env.HOME = tmpHome;
		dbPath = defaultGetCommDbPath(PROJECT_NAME);
		mkdirSync(join(dbPath, ".."), { recursive: true });
		new CommDB(dbPath).close();
		store = await StateStore.create(":memory:");
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		store.close();
		if (originalHome !== undefined) process.env.HOME = originalHome;
		else delete process.env.HOME;
		if (originalCommDir !== undefined)
			process.env.FLYWHEEL_COMM_DIR = originalCommDir;
		else delete process.env.FLYWHEEL_COMM_DIR;
		rmSync(tmpHome, { recursive: true, force: true });
		warnSpy.mockRestore();
	});

	function makePoller(): GatePoller {
		return new GatePoller({
			pollIntervalMs: 60_000,
			projects,
			store,
			runtimeRegistry: new RuntimeRegistry(),
		});
	}

	async function runPass(poller: GatePoller): Promise<void> {
		await (
			poller as unknown as { zombieGateHygienePass: () => Promise<void> }
		).zombieGateHygienePass();
	}

	/**
	 * A sweepable ask: owner torn down (registry row deleted), aged past the
	 * 30-min guard, StateStore terminal. Returns the question id.
	 */
	function seedOwnerlessAsk(): string {
		const db = new CommDB(dbPath);
		db.registerSession(DEAD_RUNNER, "w1", PROJECT_NAME, "FLY-1328", LEAD);
		const qid = db.insertQuestion(DEAD_RUNNER, LEAD, "DONE report nobody read");
		db.close();
		// Backdate past ASK_SWEEP_MIN_AGE_MS, then prove the teardown.
		const raw = new CommDB(dbPath) as unknown as {
			db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
			close(): void;
		};
		raw.db
			.prepare(
				"UPDATE mailbox SET created_at = datetime('now','-45 minutes') WHERE id = ?",
			)
			.run(qid);
		raw.close();
		const db3 = new CommDB(dbPath);
		db3.deleteSession(DEAD_RUNNER); // teardown evidence the sweep keys on
		db3.close();
		store.upsertSession({
			execution_id: DEAD_RUNNER,
			issue_id: "issue-1328",
			issue_identifier: "FLY-1328",
			project_name: PROJECT_NAME,
			status: "terminated",
		});
		return qid;
	}

	function isPending(qid: string): boolean {
		const db = new CommDB(dbPath);
		try {
			return db.isQuestionPending(qid);
		} finally {
			db.close();
		}
	}

	it("retires an ownerless ask THROUGH the poller — the candidate filter must pass asks to the sweep", async () => {
		const qid = seedOwnerlessAsk();
		expect(isPending(qid)).toBe(true); // positive control: it starts pending

		await runPass(makePoller());

		// Revert the poller's filter to `q.checkpoint != null` (pre-FLY-1328) and
		// this goes red — that filter is the only thing feeding the ask branch.
		expect(isPending(qid)).toBe(false);
		const db = new CommDB(dbPath);
		const row = db.getMessageById(qid) as unknown as {
			resolved_via?: string | null;
			relay_state?: string;
		};
		db.close();
		expect(row.resolved_via).toBe("owner_closed_sweep");
		expect(row.relay_state).toBe("terminal_disposed");
	});

	it("runs founder-reply reconciliation bookkeeping on the same pass", async () => {
		seedOwnerlessAsk();
		const poller = makePoller();
		const reconcile = (
			poller as unknown as { founderReplyUnreachable: Record<string, unknown> }
		).founderReplyUnreachable;
		const begin = vi.spyOn(
			reconcile as unknown as { beginUnreachableSweep: () => void },
			"beginUnreachableSweep",
		);
		const end = vi.spyOn(
			reconcile as unknown as { endUnreachableSweep: () => void },
			"endUnreachableSweep",
		);

		await runPass(poller);

		expect(begin).toHaveBeenCalledTimes(1);
		expect(end).toHaveBeenCalledTimes(1);
	});

	it("spares an ask whose CommDB registry row still exists (FLY-161 completed-alive), through the poller", async () => {
		const db = new CommDB(dbPath);
		db.registerSession(DEAD_RUNNER, "w1", PROJECT_NAME, "FLY-1328", LEAD);
		const qid = db.insertQuestion(
			DEAD_RUNNER,
			LEAD,
			"live runner still waiting",
		);
		db.close();
		const raw = new CommDB(dbPath) as unknown as {
			db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
			close(): void;
		};
		raw.db
			.prepare(
				"UPDATE mailbox SET created_at = datetime('now','-45 minutes') WHERE id = ?",
			)
			.run(qid);
		raw.close();
		// Registry row deliberately KEPT — the runner can still read an answer.
		store.upsertSession({
			execution_id: DEAD_RUNNER,
			issue_id: "issue-1328",
			issue_identifier: "FLY-1328",
			project_name: PROJECT_NAME,
			status: "completed",
		});

		await runPass(makePoller());

		expect(isPending(qid)).toBe(true);
	});
});
