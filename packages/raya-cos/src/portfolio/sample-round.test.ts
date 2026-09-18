import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BusinessRound } from "../business-round.js";
import { SnapshotStore } from "./snapshot-store.js";

const roots: string[] = [];
const at = Date.parse("2026-09-15T04:00:00Z");
const projects = [
	{
		projectName: "flywheel",
		projectRoot: "/projects/flywheel",
		projectRepo: "owner/flywheel",
		linear: null,
	},
	{ projectName: "quiet", projectRoot: "/projects/quiet", linear: null },
];
const [activeProject, quietProject] = projects;
if (!activeProject || !quietProject) throw new Error("fixture project missing");
const groups = {
	checkoutHead: [
		"branch",
		"lastCommit",
		"lastNonChoreCommit",
		"commits30d",
		"nonChoreCommits30d",
		"dirtyCount",
		"worktreeCount",
	],
	canonical: ["defaultBranch", "lastCommit"],
	prActivity: ["number", "state", "updatedAt", "mergedAt"],
	openPrs: [
		"returnedCount",
		"truncated",
		"newestUpdatedAt",
		"oldestUpdatedAt",
		"sample",
	],
	linear: ["projectState", "projectUpdatedAt", "activeIssues"],
	deployedCheckoutSummaryFiles: ["count", "latestDate", "checkoutSha"],
	activity: [
		"latestObservedActivityAt",
		"coverage",
		"daysSinceLatestObservedActivity",
	],
};
function reading(project: (typeof projects)[number]) {
	return {
		projectName: project.projectName,
		repo: project.projectRepo ?? null,
		linearBinding: null,
		...Object.fromEntries(
			Object.entries(groups).map(([group, keys]) => [
				group,
				Object.fromEntries(
					keys.map((key) => [key, { ok: false, reason: "unavailable" }]),
				),
			]),
		),
	};
}
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "portfolio-round-"));
	roots.push(root);
	let now = at;
	return {
		root,
		round: new BusinessRound(root, () => now),
		advance: () => {
			now += 100000;
		},
	};
}
const input = {
	schemaVersion: 2,
	kind: "portfolio_sample",
	operationId: "sample:round-1",
	sourceRefs: ["summary-absorption:2026-09-15T04:00:00Z"],
	directory: { projectsDigest: "a".repeat(64), projects },
};
function record(round: BusinessRound, revision: number, readings: unknown[]) {
	return round.record({
		schemaVersion: 2,
		operationId: input.operationId,
		expectedRevision: revision,
		tool: "current_turn",
		callId: "read-tools-1",
		result: { projects: readings },
	});
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("current-turn portfolio sampling", () => {
	it("freezes the complete directory and retains explicit unavailable projects in a durable snapshot", () => {
		const { root, round } = fixture();
		const prepared = round.prepare(input);
		expect(prepared.next?.arguments).toMatchObject({
			projects,
			commandTimeoutMs: 10000,
			sampleDeadlineMs: 90000,
		});
		const complete = record(round, prepared.revision, projects.map(reading));
		expect(complete.stage).toBe("complete");
		expect(complete.material).toMatchObject({
			snapshot: {
				v: 1,
				seq: 1,
				activityAvailable: false,
				projects: [{ projectName: "flywheel" }, { projectName: "quiet" }],
				all: { git: "unavailable", gh: "unavailable", linear: "unavailable" },
			},
		});
		expect(
			new BusinessRound(root, () => at).resume(input.operationId).material,
		).toEqual(complete.material);
	});
	it("rejects omissions, foreign project bindings and incomplete groups", () => {
		const { round } = fixture();
		const prepared = round.prepare(input);
		for (const readings of [
			[reading(activeProject)],
			[
				reading(activeProject),
				{ ...reading(quietProject), repo: "owner/other" },
			],
			[{ ...reading(activeProject), canonical: {} }, reading(quietProject)],
		])
			expect(() => record(round, prepared.revision, readings)).toThrow();
	});
	it("refuses expired rounds and success readings outside the current observation window", () => {
		const { round, advance } = fixture();
		const prepared = round.prepare(input);
		const first = reading(activeProject);
		first.activity = {
			...first.activity,
			daysSinceLatestObservedActivity: {
				ok: true,
				value: 3,
				at: "2026-09-14T04:00:00Z",
			},
		};
		expect(() =>
			record(round, prepared.revision, [first, reading(quietProject)]),
		).toThrow(/fresh/);
		advance();
		expect(() =>
			record(round, prepared.revision, projects.map(reading)),
		).toThrow(/deadline/);
	});
	it("derives aggregate availability from successful readings rather than accepting caller totals", () => {
		const { round } = fixture();
		const prepared = round.prepare(input);
		const first = reading(activeProject);
		first.checkoutHead = {
			...first.checkoutHead,
			branch: { ok: true, value: "feature", at: new Date(at).toISOString() },
		};
		expect(
			record(round, prepared.revision, [first, reading(quietProject)]).material,
		).toMatchObject({
			snapshot: {
				all: { git: "partial", gh: "unavailable", linear: "unavailable" },
			},
		});
	});
	it("closes expired collection on resume with deadline readings and never refreshes its observation time", () => {
		const { root, round, advance } = fixture();
		const prepared = round.prepare(input);
		advance();
		const expired = round.resume(input.operationId);
		expect(expired).toMatchObject({
			stage: "complete",
			next: null,
			material: {
				snapshot: {
					sampledAt: new Date(at + 90000).toISOString(),
					activityAvailable: false,
					projects: [
						{
							projectName: "flywheel",
							checkoutHead: { branch: { ok: false, reason: "deadline" } },
						},
						{
							projectName: "quiet",
							canonical: { lastCommit: { ok: false, reason: "deadline" } },
						},
					],
				},
				receipt: { tool: "business_deadline" },
			},
		});
		expect(() =>
			record(round, expired.revision, projects.map(reading)),
		).toThrow(/stage/);
		expect(new BusinessRound(root, () => at + 500000).prepare(input)).toEqual(
			expired,
		);
		expect(prepared.revision).toBeLessThan(expired.revision);
	});
	it("resumes a failed snapshot projection from the frozen data and continues legacy sequence numbers", () => {
		const { root, round } = fixture();
		const store = new SnapshotStore(join(root, "state"));
		store.write({
			v: 1,
			snapshotId: "legacy",
			seq: 9,
			sampledAt: new Date(at - 1000).toISOString(),
			trigger: "old",
			projects: [],
			activityAvailable: false,
			all: { git: "unavailable", gh: "unavailable", linear: "unavailable" },
		});
		const prepared = round.prepare(input);
		const fault = vi
			.spyOn(SnapshotStore.prototype, "write")
			.mockImplementation(() => {
				throw new Error("injected projection failure");
			});
		try {
			expect(() =>
				record(round, prepared.revision, projects.map(reading)),
			).toThrow(/injected/);
		} finally {
			fault.mockRestore();
		}
		expect(store.readLatest()?.snapshotId).toBe("legacy");
		const complete = new BusinessRound(root, () => at + 1000).resume(
			input.operationId,
		);
		expect(complete.material).toMatchObject({
			snapshotProjected: true,
			snapshot: { seq: 10, sampledAt: new Date(at).toISOString() },
		});
		expect(store.readLatest()?.seq).toBe(10);
		expect(store.readLatest()?.sampledAt).toBe(new Date(at).toISOString());
	});
});
