import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commDbPathForProject } from "../bridge/commdb-path.js";
import {
	deliverDesignReviewManifest,
	isCurrentDesignReviewManifestInstruction,
	reconcileDesignReviewInstructions,
	snapshotDesignReviewPlan,
} from "../bridge/design-review-manifest.js";
import { StateStore } from "../StateStore.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("FLY-1718 design review manifest delivery", () => {
	let root: string;
	let oldHome: string | undefined;
	let store: StateStore;
	const planPath = "engineering/doc/FLY-1718-test/plan.md";

	beforeEach(async () => {
		root = join(tmpdir(), `fly1718-manifest-${Date.now()}-${Math.random()}`);
		mkdirSync(join(root, dirname(planPath)), { recursive: true });
		oldHome = process.env.HOME;
		process.env.HOME = join(root, "home");
		mkdirSync(process.env.HOME, { recursive: true });

		git(root, ["init", "-q"]);
		git(root, ["config", "user.email", "test@example.com"]);
		git(root, ["config", "user.name", "Test"]);
		writeFileSync(join(root, planPath), "# approved plan\n");
		git(root, ["add", planPath]);
		git(root, ["commit", "-q", "-m", "plan"]);

		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "flywheel-test",
			status: "running",
			worktree_path: root,
			branch: git(root, ["branch", "--show-current"]),
		});
	});

	afterEach(() => {
		store.close();
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		rmSync(root, { recursive: true, force: true });
	});

	it("snapshots only a clean committed plan blob", () => {
		const session = store.getSession("exec-1")!;
		const clean = snapshotDesignReviewPlan(session, planPath);
		expect(clean).toEqual({
			ok: true,
			blobSha: git(root, ["rev-parse", `HEAD:${planPath}`]),
		});

		writeFileSync(join(root, planPath), "# dirty plan\n");
		expect(snapshotDesignReviewPlan(session, planPath)).toMatchObject({
			ok: false,
			reason: "dirty",
		});
		expect(snapshotDesignReviewPlan(session, planPath)).toMatchObject({
			message: expect.stringContaining("commit plan current contents"),
		});

		git(root, ["checkout", "--", planPath]);
		const untracked = "engineering/doc/FLY-1718-test/untracked.md";
		writeFileSync(join(root, untracked), "draft\n");
		expect(snapshotDesignReviewPlan(session, untracked)).toMatchObject({
			ok: false,
			reason: "dirty",
		});
	});

	it("rejects a missing plan instead of creating a placeholder target", () => {
		expect(
			snapshotDesignReviewPlan(
				store.getSession("exec-1")!,
				"engineering/doc/FLY-1718-test/missing.md",
			),
		).toMatchObject({ ok: false, reason: "missing" });
	});

	it("rejects a clean worktree whose HEAD is not the persisted session branch", () => {
		git(root, ["branch", "persisted-branch"]);
		writeFileSync(join(root, "after-branch.txt"), "new head\n");
		git(root, ["add", "after-branch.txt"]);
		git(root, ["commit", "-q", "-m", "advance worktree head"]);

		expect(
			snapshotDesignReviewPlan(
				{ worktree_path: root, branch: "persisted-branch" },
				planPath,
			),
		).toMatchObject({ ok: false, reason: "dirty" });
	});

	it("uses plumbing checks that do not execute repo-configured filters or fsmonitor", () => {
		const marker = join(root, "config-hook-ran");
		const trap = join(root, "config-trap.sh");
		writeFileSync(
			trap,
			`#!/bin/sh\nprintf ran >> ${JSON.stringify(marker)}\ncat\n`,
		);
		chmodSync(trap, 0o700);
		writeFileSync(join(root, ".gitattributes"), `${planPath} filter=trap\n`);
		git(root, ["add", ".gitattributes"]);
		git(root, ["commit", "-q", "-m", "declare plan attribute"]);
		git(root, ["config", "filter.trap.clean", trap]);
		git(root, ["config", "core.fsmonitor", trap]);

		expect(
			snapshotDesignReviewPlan(store.getSession("exec-1")!, planPath),
		).toMatchObject({ ok: true });
		expect(existsSync(marker)).toBe(false);
	});

	it("uses a stable instruction id and reconciles a manifest-to-inbox crash window", () => {
		const snapshot = snapshotDesignReviewPlan(
			store.getSession("exec-1")!,
			planPath,
		);
		if (!snapshot.ok) throw new Error(snapshot.message);
		const first = store.advanceDesignReviewManifest({
			executionId: "exec-1",
			projectName: "flywheel-test",
			sourceEventId: "evt-1",
			expectedPlanPath: planPath,
			expectedBlobSha: snapshot.blobSha,
		});

		expect(deliverDesignReviewManifest(store, first)).toEqual({
			queued: true,
			deduped: false,
			consumed: false,
		});
		expect(store.listUndeliveredDesignReviewManifests()).toEqual([first]);

		const second = store.advanceDesignReviewManifest({
			executionId: "exec-1",
			projectName: "flywheel-test",
			sourceEventId: "evt-2",
			expectedPlanPath: planPath,
			expectedBlobSha: snapshot.blobSha,
		});
		expect(second.delivered_at).toBeUndefined();
		expect(reconcileDesignReviewInstructions(store)).toEqual({
			attempted: 1,
			delivered: 0,
			failed: 0,
		});
		expect(reconcileDesignReviewInstructions(store)).toEqual({
			attempted: 1,
			delivered: 0,
			failed: 0,
		});

		const db = new CommDB(commDbPathForProject("flywheel-test"));
		try {
			const instructions = db.getUnreadInstructions("exec-1");
			expect(instructions).toHaveLength(2);
			expect(instructions.map((row) => row.id)).toEqual([
				"design-review-manifest:exec-1:1",
				"design-review-manifest:exec-1:2",
			]);
			expect(instructions[1]!.content).toContain(second.request_id);
			expect(instructions[1]!.content).toContain(snapshot.blobSha);
			expect(
				isCurrentDesignReviewManifestInstruction(store, {
					id: instructions[1]!.id,
					to_agent: instructions[1]!.to_agent,
				}),
			).toBe(true);
			db.markInstructionRead(instructions[1]!.id);
		} finally {
			db.close();
		}
		expect(reconcileDesignReviewInstructions(store)).toEqual({
			attempted: 1,
			delivered: 1,
			failed: 0,
		});
		expect(store.listUndeliveredDesignReviewManifests()).toEqual([]);
	});
});
