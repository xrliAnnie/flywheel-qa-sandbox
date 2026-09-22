import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { BusinessRound } from "./business-round.js";
import { parseGoalsFile, renderGoalsFile } from "./contracts/goals.js";
import {
	applyDailyReportMigration,
	planDailyReportMigration,
} from "./daily-report/migration.js";
import { applyLegacyMeetings, planLegacyMeetings } from "./legacy-meetings.js";
import {
	applyLegacyQuestions,
	planLegacyQuestions,
} from "./legacy-questions.js";
import { SnapshotStore } from "./portfolio/snapshot-store.js";

it("retains original goals, snapshots, summary receipts, historical patrol and memory Git history across migration and replay", () => {
	const root = mkdtempSync(join(tmpdir(), "raya-migration-compatibility-"));
	try {
		const goals = renderGoalsFile([
			{
				id: "g-20260906-01",
				operationId: "1414000000000000000:record:0",
				recordedAt: "2026-09-06T23:40:12-07:00",
				sourceUrl: "https://discord.com/channels/1/2/1414000000000000000",
				status: "active",
				text: "保留原话",
			},
		]);
		const snapshot = {
			v: 1,
			snapshotId: "original-snapshot",
			seq: 7,
			sampledAt: "2026-09-06T12:00:00Z",
			trigger: "legacy",
			projects: [],
			activityAvailable: false,
			all: { git: "unavailable", gh: "unavailable", linear: "unavailable" },
		};
		const files: Record<string, string> = {
			"memory/goals.md": goals,
			"state/portfolio/latest.json": JSON.stringify(snapshot),
			"state/portfolio/snapshots/original-snapshot.json":
				JSON.stringify(snapshot),
			"state/portfolio/patrol-state.json": JSON.stringify({
				v: 1,
				injected: {
					threadId: "historical-thread",
					snapshotId: "original-snapshot",
				},
				attempt: {
					attemptId: "original-attempt",
					snapshotId: "original-snapshot",
					status: "posting",
					at: "2026-09-06T12:00:00Z",
				},
			}),
			"state/summary-merge-receipts.jsonl": `${JSON.stringify({
				type: "round",
				roundId: "summary-absorption:2026-09-06T12:00:00Z",
				reviewedPrs: [],
				report_line: "original report",
			})}\n`,
			"state/lead-questions/questions.json": JSON.stringify({
				v: 1,
				questions: [
					{
						askId: "original",
						status: "expired",
						to: { project: "flywheel", leadId: "eng" },
						recipientUserId: "333333333333333333",
						displayName: "Engineering",
						question: "原问题",
						sourceMessageId: "111111111111111111",
						createdAt: "2026-09-06T00:00:00Z",
					},
				],
			}),
		};
		for (const [path, raw] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), raw);
		}
		const memory = join(root, "memory");
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: memory, encoding: "utf8" }).trim();
		git("init", "-q", "-b", "main");
		git("config", "user.name", "Compatibility Test");
		git("config", "user.email", "test@example.invalid");
		git("add", "goals.md");
		git("commit", "-q", "-m", "original goals");
		const head = git("rev-parse", "HEAD");
		const identity = { flywheelSha: "a".repeat(40), rayaSha: "b".repeat(40) };
		for (let pass = 0; pass < 2; pass++) {
			applyLegacyQuestions(root, planLegacyQuestions(root).digest, identity);
			applyLegacyMeetings(root, planLegacyMeetings(root).digest, identity);
			applyDailyReportMigration(
				root,
				planDailyReportMigration(root).digest,
				identity,
			);
			new BusinessRound(root).status();
			expect(new SnapshotStore(join(root, "state")).readLatest()).toEqual(
				snapshot,
			);
			expect(
				parseGoalsFile(readFileSync(join(memory, "goals.md"), "utf8"))[0],
			).toMatchObject({
				id: "g-20260906-01",
				operationId: "1414000000000000000:record:0",
			});
			for (const [path, raw] of Object.entries(files))
				expect(readFileSync(join(root, path), "utf8")).toBe(raw);
			expect(git("rev-parse", "HEAD")).toBe(head);
			expect(git("status", "--porcelain")).toBe("");
		}
		// A code rollback can still read the retained v1 artifacts; new operation state
		// stays separate and must never be copied over those historical facts.
		expect(
			JSON.parse(
				readFileSync(join(root, "state/lead-questions/questions.json"), "utf8"),
			).questions[0].askId,
		).toBe("original");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
