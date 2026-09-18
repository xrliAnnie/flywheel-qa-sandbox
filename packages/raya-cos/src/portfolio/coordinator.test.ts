import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RegisteredProject } from "../directory.js";
import type { ProjectReading, Reading } from "./types.js";

function ok<T>(value: T): Reading<T> {
	return { ok: true, value, at: "2026-09-06T12:00:00Z" };
}

function reading(projectName: string): ProjectReading {
	return {
		projectName,
		repo: `owner/${projectName}`,
		linearBinding: null,
		checkoutHead: {
			branch: ok("main"),
			lastCommit: ok({
				sha7: "aaaaaaa",
				committedAt: "2026-09-06T10:00:00Z",
				authoredAt: "2026-09-06T10:00:00Z",
				author: "Annie",
				subject: "feat: work",
			}),
			lastNonChoreCommit: ok({
				sha7: "aaaaaaa",
				committedAt: "2026-09-06T10:00:00Z",
				authoredAt: "2026-09-06T10:00:00Z",
				author: "Annie",
				subject: "feat: work",
			}),
			commits30d: ok(1),
			nonChoreCommits30d: ok(1),
			dirtyCount: ok(0),
			worktreeCount: ok(1),
		},
		canonical: {
			defaultBranch: ok("main"),
			lastCommit: ok({
				sha7: "aaaaaaa",
				committedAt: "2026-09-06T10:00:00Z",
				subject: "feat: work",
			}),
		},
		prActivity: {
			number: ok(null),
			state: ok(null),
			updatedAt: ok(null),
			mergedAt: ok(null),
		},
		openPrs: {
			returnedCount: ok(0),
			truncated: ok(false),
			newestUpdatedAt: ok(null),
			oldestUpdatedAt: ok(null),
			sample: ok([]),
		},
		linear: {
			projectState: { ok: false, reason: "not_configured" },
			projectUpdatedAt: { ok: false, reason: "not_configured" },
			activeIssues: { ok: false, reason: "not_configured" },
		},
		deployedCheckoutSummaryFiles: {
			count: ok(0),
			latestDate: ok(null),
			checkoutSha: ok("bbbbbbb"),
		},
		activity: {
			latestObservedActivityAt: ok("2026-09-06T10:00:00Z"),
			coverage: ok(["checkout_non_chore", "canonical_commit"]),
			daysSinceLatestObservedActivity: ok(0),
		},
	};
}

describe("SampleCoordinator", () => {
	it("single-flights bounded project sampling and persists a monotonic snapshot", async () => {
		const module = await import("./coordinator.js").catch(() => ({}));
		const SampleCoordinator = (module as { SampleCoordinator?: unknown })
			.SampleCoordinator;
		expect(SampleCoordinator).toBeTypeOf("function");
		if (typeof SampleCoordinator !== "function") return;

		const projects: RegisteredProject[] = ["a", "b", "c"].map(
			(projectName) => ({
				projectName,
				projectRoot: `/srv/${projectName}`,
				projectRepo: `owner/${projectName}`,
				linear: null,
			}),
		);
		let active = 0;
		let maximum = 0;
		const sampler = {
			sampleProject: vi.fn(async (project: RegisteredProject) => {
				active += 1;
				maximum = Math.max(maximum, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				active -= 1;
				return reading(project.projectName);
			}),
		};
		const stateDir = mkdtempSync(join(tmpdir(), "raya-coordinator-"));
		const coordinator = new (
			SampleCoordinator as new (
				options: Record<string, unknown>,
			) => {
				sample: (trigger: string) => Promise<Record<string, unknown>>;
			}
		)({
			projects,
			sampler,
			stateDir,
			sampleDeadlineMs: 1_000,
			sampleConcurrency: 2,
			now: () => new Date("2026-09-06T12:00:00Z"),
			random: () => "abcdef",
		});

		const first = coordinator.sample("startup_probe");
		const joined = coordinator.sample("patrol");
		expect(joined).toBe(first);
		const snapshot = await first;
		expect(maximum).toBe(2);
		expect(sampler.sampleProject).toHaveBeenCalledTimes(3);
		expect(snapshot).toMatchObject({
			v: 1,
			seq: 1,
			trigger: "startup_probe",
			projects: [
				{ projectName: "a" },
				{ projectName: "b" },
				{ projectName: "c" },
			],
			activityAvailable: true,
			all: { git: "ok", gh: "ok", linear: "unavailable" },
		});
		const latestPath = join(stateDir, "portfolio", "latest.json");
		expect(JSON.parse(readFileSync(latestPath, "utf8"))).toEqual(snapshot);
		expect(statSync(latestPath).mode & 0o777).toBe(0o600);
	});

	it("marks unfinished and unstarted projects deadline while still persisting a snapshot", async () => {
		const { SampleCoordinator } = await import("./coordinator.js");
		const projects: RegisteredProject[] = ["slow", "queued"].map(
			(projectName) => ({
				projectName,
				projectRoot: `/srv/${projectName}`,
				projectRepo: `owner/${projectName}`,
				linear: null,
			}),
		);
		const sampler = {
			sampleProject: vi.fn(
				async (_project: RegisteredProject, signal: AbortSignal) =>
					new Promise<ProjectReading>((_resolve, reject) => {
						signal.addEventListener(
							"abort",
							() =>
								reject(
									Object.assign(new Error("aborted"), { name: "AbortError" }),
								),
							{ once: true },
						);
					}),
			),
		};
		const stateDir = mkdtempSync(join(tmpdir(), "raya-coordinator-deadline-"));
		const coordinator = new SampleCoordinator({
			projects,
			sampler,
			stateDir,
			sampleDeadlineMs: 10,
			sampleConcurrency: 1,
			now: () => new Date("2026-09-06T12:00:00Z"),
			random: () => "abcdef",
		});

		const snapshot = await coordinator.sample("patrol");

		expect(sampler.sampleProject).toHaveBeenCalledTimes(1);
		expect(snapshot.activityAvailable).toBe(false);
		expect(snapshot.projects).toHaveLength(2);
		for (const project of snapshot.projects) {
			expect(project.checkoutHead.branch).toEqual({
				ok: false,
				reason: "deadline",
			});
			expect(project.activity.daysSinceLatestObservedActivity).toEqual({
				ok: false,
				reason: "deadline",
			});
		}
		expect(existsSync(join(stateDir, "portfolio", "latest.json"))).toBe(true);
	});

	it("aborts an active sample and writes no snapshot after stop", async () => {
		const { SampleCoordinator } = await import("./coordinator.js");
		const stateDir = mkdtempSync(join(tmpdir(), "raya-coordinator-stop-"));
		const sampler = {
			sampleProject: vi.fn(
				async (_project: RegisteredProject, signal: AbortSignal) =>
					new Promise<ProjectReading>((_resolve, reject) => {
						signal.addEventListener(
							"abort",
							() =>
								reject(
									Object.assign(new Error("aborted"), { name: "AbortError" }),
								),
							{ once: true },
						);
					}),
			),
		};
		const coordinator = new SampleCoordinator({
			projects: [
				{
					projectName: "slow",
					projectRoot: "/srv/slow",
					projectRepo: "owner/slow",
					linear: null,
				},
			],
			sampler,
			stateDir,
			sampleDeadlineMs: 10_000,
			sampleConcurrency: 1,
		});

		const sample = coordinator.sample("patrol");
		await coordinator.stop();

		await expect(sample).rejects.toThrow("sample coordinator stopped");
		expect(existsSync(join(stateDir, "portfolio", "latest.json"))).toBe(false);
		await expect(coordinator.sample("patrol")).rejects.toThrow(
			"sample coordinator stopped",
		);
	});

	it("does not mislabel an unexpected project failure as a global deadline", async () => {
		const { SampleCoordinator } = await import("./coordinator.js");
		const stateDir = mkdtempSync(join(tmpdir(), "raya-coordinator-error-"));
		const coordinator = new SampleCoordinator({
			projects: [
				{
					projectName: "broken",
					projectRoot: "/srv/broken",
					projectRepo: "owner/broken",
					linear: null,
				},
			],
			sampler: {
				sampleProject: vi.fn(async () => {
					throw new Error("unexpected implementation failure");
				}),
			},
			stateDir,
			sampleDeadlineMs: 1_000,
			sampleConcurrency: 1,
		});

		const snapshot = await coordinator.sample("patrol");

		expect(snapshot.projects[0]?.checkoutHead.branch).toEqual({
			ok: false,
			reason: "parse_error",
		});
	});
});
