import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pruneDeadTerminalCommDbSessions } from "../commdb-session-prune.js";

/**
 * FLY-1329 (A4): the CommDB prune must not delete a park-alive runner's row.
 *
 * The trap here is subtle and is the second half of the FLY-1319 incident (the
 * "CommDB session row disappeared" half). This sweep deletes on a `dead` verdict
 * from `probeTmuxWindowLiveness` — but that probe's `dead` means
 * `isTmuxAbsenceMessage`: tmux could not FIND the window at the name we passed.
 * It does NOT mean the process died; it is exactly the `absent` reading that A1
 * refuses to destroy on. A stale CommDB `tmux_window` mapping produces it on a
 * perfectly healthy runner, and the row for a live runner then vanishes.
 *
 * The runner's own unexpired park declaration contradicts that reading, so it
 * vetoes the delete.
 *
 * Real CommDB (not a mock): the row must genuinely survive.
 */
describe("FLY-1329 A4: CommDB prune respects a park declaration", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1329-commdb-"));
		dbPath = join(dir, "comm.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** A terminal CommDB row whose window name no longer resolves. */
	function seedTerminal(execId: string, parked: boolean): void {
		const db = new CommDB(dbPath);
		try {
			db.registerSession(
				execId,
				`runner-flywheel:${execId}`,
				"flywheel",
				`issue-${execId}`,
				"eng-lead",
			);
			db.markSessionTerminalStatus(execId, "completed");
			if (parked) {
				db.upsertDeclaredState(
					execId,
					"parked",
					"DAG workflow implement parked awaiting QA",
					Date.now(),
					null, // no expiry — an indefinite park
				);
			}
		} finally {
			db.close();
		}
	}

	/** The stale-mapping shape: tmux says "can't find window". */
	const probeDead = vi.fn(async () => "dead" as const);

	it("KEEPS the row of a runner that declares itself parked, even on a dead probe", async () => {
		seedTerminal("parked-alive", true);

		const result = await pruneDeadTerminalCommDbSessions("flywheel", {
			dbPath,
			probe: probeDead,
		});

		expect(result.scanned).toBe(1);
		expect(result.pruned).toBe(0);
		expect(result.parkedVetoed).toBe(1);

		// The real proof: the row is still there.
		const db = new CommDB(dbPath);
		try {
			expect(db.getSession("parked-alive")).toBeTruthy();
		} finally {
			db.close();
		}
	});

	it("still prunes a terminal row with NO park declaration (normal teardown residue)", async () => {
		seedTerminal("real-residue", false);

		const result = await pruneDeadTerminalCommDbSessions("flywheel", {
			dbPath,
			probe: probeDead,
		});

		expect(result.parkedVetoed).toBe(0);
		expect(result.pruned).toBe(1);

		const db = new CommDB(dbPath);
		try {
			expect(db.getSession("real-residue")).toBeFalsy();
		} finally {
			db.close();
		}
	});

	/** An alive probe already kept the row before this change — unchanged. */
	it("an alive probe still keeps the row (existing behavior, unchanged)", async () => {
		seedTerminal("alive-window", false);

		const result = await pruneDeadTerminalCommDbSessions("flywheel", {
			dbPath,
			probe: vi.fn(async () => "alive" as const),
		});

		expect(result.kept).toBe(1);
		expect(result.pruned).toBe(0);
	});
});
