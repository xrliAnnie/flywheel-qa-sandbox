import { describe, expect, it, vi } from "vitest";
import {
	runSummaryCommand,
	type SummaryDelivery,
} from "../commands/summary.js";

const content = `---
project: flywheel
lead: eng-lead
period: 2026-08-21/2026-08-28
---
## Facts
FLY-2030 entered implementation.
## Judgment
The inflow contract is the critical path.
`;

const env = {
	FLYWHEEL_PROJECT_NAME: "flywheel",
	FLYWHEEL_LEAD_ID: "eng-lead",
	FLYWHEEL_LEAD_HAS_SUMMARY_DUTY: "1",
	FLYWHEEL_LEAD_SUMMARY_ROLE: "producer",
	FLYWHEEL_SUMMARY_GRANULARITY: "per-lead",
	FLYWHEEL_SUMMARY_ASSIGNMENT_DIGEST: "a".repeat(64),
};

function deps(delivery: SummaryDelivery) {
	return {
		env,
		readFile: vi.fn(() => content),
		stdout: vi.fn(),
		stderr: vi.fn(),
		delivery,
	};
}

describe("flywheel-comm summary", () => {
	it("verifies a Raya PR at its current head without requiring producer duty", async () => {
		const verifierGitHub = {
			readPullRequest: vi.fn(async () => ({ headSha: "b".repeat(40) })),
			listPullRequestFiles: vi.fn(async () => [
				{
					path: "summaries/flywheel/2026-08-28--eng-lead--01.md",
					status: "added",
				},
			]),
			readTreeModes: vi.fn(
				async () =>
					new Map([
						["summaries/flywheel/2026-08-28--eng-lead--01.md", "100644"],
					]),
			),
			readFileAtRef: vi.fn(async () => content),
		};
		const stdout = vi.fn();
		expect(
			await runSummaryCommand(["verify-pr", "--pr", "7"], {
				env: {
					FLYWHEEL_SUMMARY_GRANULARITY: "per-lead",
					FLYWHEEL_LEAD_HAS_SUMMARY_DUTY: "0",
				},
				stdout,
				stderr: vi.fn(),
				verifierGitHub,
			}),
		).toBe(0);
		expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({
			verifiedHeadSha: "b".repeat(40),
		});
	});

	it("dry-run validates and prints a canonical plan with zero fs/git/gh delivery effects", async () => {
		const delivery = {
			inspect: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
		} satisfies SummaryDelivery;
		const d = deps(delivery);
		expect(
			await runSummaryCommand(
				[
					"--file",
					"summary.md",
					"--project",
					"flywheel",
					"--period",
					"2026-08-21/2026-08-28",
					"--dry-run",
				],
				d,
			),
		).toBe(0);
		expect(delivery.inspect).not.toHaveBeenCalled();
		expect(delivery.create).not.toHaveBeenCalled();
		expect(delivery.update).not.toHaveBeenCalled();
		expect(JSON.parse(d.stdout.mock.calls[0]![0])).toMatchObject({
			ok: true,
			dryRun: true,
			project: "flywheel",
			author: "eng-lead",
			granularity: "per-lead",
		});
	});

	it("creates a new idempotent delivery", async () => {
		const delivery = {
			inspect: vi.fn(async () => ({ state: "none" as const })),
			create: vi.fn(async () => ({ prNumber: 7, url: "https://pr/7" })),
			update: vi.fn(),
		} satisfies SummaryDelivery;
		const d = deps(delivery);
		expect(
			await runSummaryCommand(
				[
					"--file",
					"summary.md",
					"--project",
					"flywheel",
					"--period",
					"2026-08-21/2026-08-28",
				],
				d,
			),
		).toBe(0);
		expect(delivery.create).toHaveBeenCalledOnce();
	});

	it("updates the same open PR", async () => {
		const delivery = {
			inspect: vi.fn(async () => ({
				state: "open" as const,
				prNumber: 7,
				url: "https://pr/7",
				branch: "summary/flywheel/abc",
				path: "summaries/flywheel/2026-08-28--eng-lead--01.md",
			})),
			create: vi.fn(),
			update: vi.fn(async () => ({ prNumber: 7, url: "https://pr/7" })),
		} satisfies SummaryDelivery;
		const d = deps(delivery);
		expect(
			await runSummaryCommand(
				[
					"--file",
					"summary.md",
					"--project",
					"flywheel",
					"--period",
					"2026-08-21/2026-08-28",
				],
				d,
			),
		).toBe(0);
		expect(delivery.update).toHaveBeenCalledOnce();
		expect(delivery.create).not.toHaveBeenCalled();
	});

	it.each(["merged", "closed"] as const)(
		"fails loudly when the stable key PR is %s",
		async (state) => {
			const delivery = {
				inspect: vi.fn(async () => ({
					state,
					prNumber: 7,
					url: "https://pr/7",
				})),
				create: vi.fn(),
				update: vi.fn(),
			} satisfies SummaryDelivery;
			const d = deps(delivery);
			expect(
				await runSummaryCommand(
					[
						"--file",
						"summary.md",
						"--project",
						"flywheel",
						"--period",
						"2026-08-21/2026-08-28",
					],
					d,
				),
			).toBe(1);
			expect(d.stderr.mock.calls[0]![0]).toContain("summary_pr_already_");
		},
	);

	it("fails closed when canonical duty is absent", async () => {
		const delivery = {
			inspect: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
		} satisfies SummaryDelivery;
		const d = deps(delivery);
		d.env = { ...env, FLYWHEEL_LEAD_HAS_SUMMARY_DUTY: "0" };
		expect(
			await runSummaryCommand(
				[
					"--file",
					"summary.md",
					"--project",
					"flywheel",
					"--period",
					"2026-08-21/2026-08-28",
				],
				d,
			),
		).toBe(1);
		expect(delivery.inspect).not.toHaveBeenCalled();
	});

	it("surfaces a concurrent create failure without retrying as an update", async () => {
		const delivery = {
			inspect: vi.fn(async () => ({ state: "none" as const })),
			create: vi.fn(async () => {
				throw new Error("non-fast-forward");
			}),
			update: vi.fn(),
		} satisfies SummaryDelivery;
		const d = deps(delivery);
		expect(
			await runSummaryCommand(
				[
					"--file",
					"summary.md",
					"--project",
					"flywheel",
					"--period",
					"2026-08-21/2026-08-28",
				],
				d,
			),
		).toBe(1);
		expect(delivery.inspect).toHaveBeenCalledOnce();
		expect(delivery.update).not.toHaveBeenCalled();
	});
});
