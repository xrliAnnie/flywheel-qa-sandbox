import { describe, expect, it } from "vitest";
import { resolveRunnerPrefixSelection } from "../runner-prefix-profile.js";

const workflow = {
	runId: "run-2913",
	snapshotDigest: "a".repeat(64),
	templateId: "tpl_code",
};
const enabled = { FLYWHEEL_RUNNER_PREFIX_PROFILE: "role-v1" };
const runner = {
	actor: "runner" as const,
	backend: "claude-tmux",
	phase: "implement",
	workflow,
	env: enabled,
};

describe("runner prefix selection (FLY-2913)", () => {
	it.each(["design", "implement", "qa"])(
		"selects %s only from the trusted pinned engineering run",
		(phase) => {
			expect(resolveRunnerPrefixSelection({ ...runner, phase })).toEqual({
				mode: "role-v1",
				role: phase,
				taskSetId: "engineering",
				workflow,
			});
		},
	);
	it.each(["design", "code"])(
		"selects persisted %s review type",
		(reviewType) => {
			expect(
				resolveRunnerPrefixSelection({
					...runner,
					actor: "reviewer",
					backend: "claude-print",
					reviewType,
				}),
			).toMatchObject({ mode: "role-v1", role: `review-${reviewType}` });
		},
	);
	it("includes the pinned simple engineering template", () => {
		expect(
			resolveRunnerPrefixSelection({
				...runner,
				workflow: { ...workflow, templateId: "tpl_simple_code" },
			}),
		).toMatchObject({ mode: "role-v1", taskSetId: "engineering" });
	});
	it.each([undefined, "tpl_research", "meeting-notes", "xiaohongshu-learning"])(
		"keeps absent or non-engineering template %s legacy",
		(templateId) => {
			expect(
				resolveRunnerPrefixSelection({
					...runner,
					workflow: templateId ? { ...workflow, templateId } : undefined,
				}),
			).toEqual({ mode: "legacy", reason: "unmapped-trigger" });
		},
	);
	it.each([undefined, "main", "eng_design", "Design", "review-code"])(
		"never guesses runner phase from %s",
		(phase) => {
			expect(resolveRunnerPrefixSelection({ ...runner, phase })).toEqual({
				mode: "legacy",
				reason: "unknown-role",
			});
		},
	);
	it("reviewer cannot borrow the runner phase when its review type is unknown", () => {
		expect(
			resolveRunnerPrefixSelection({
				...runner,
				actor: "reviewer",
				backend: "claude-print",
			}),
		).toEqual({ mode: "legacy", reason: "unknown-role" });
	});
	it("never configures Lead or Codex, even with an invalid switch", () => {
		const env = { FLYWHEEL_RUNNER_PREFIX_PROFILE: "bad" };
		for (const args of [
			{ ...runner, actor: "lead" as const, env },
			{ ...runner, backend: "codex-app-server", env },
			{ ...runner, backend: "claude-sdk", env },
		]) {
			expect(resolveRunnerPrefixSelection(args)).toEqual({
				mode: "legacy",
				reason: "not-applicable",
			});
		}
	});
	it("keeps the legacy switch and full-mcp escape hatch", () => {
		expect(
			resolveRunnerPrefixSelection({
				...runner,
				env: { FLYWHEEL_RUNNER_PREFIX_PROFILE: "legacy" },
			}),
		).toEqual({ mode: "legacy", reason: "operator-legacy" });
		expect(
			resolveRunnerPrefixSelection({ ...runner, issueLabels: ["Full-MCP"] }),
		).toEqual({ mode: "legacy", reason: "full-mcp" });
	});
	it("fails explicitly on an invalid switch for a covered consumer", () => {
		expect(() =>
			resolveRunnerPrefixSelection({
				...runner,
				env: { FLYWHEEL_RUNNER_PREFIX_PROFILE: "ROLE-V1" },
			}),
		).toThrow(/FLYWHEEL_RUNNER_PREFIX_PROFILE/);
	});
	it("does not accept an unbound run identity", () => {
		for (const pinned of [
			{ ...workflow, runId: "" },
			{ ...workflow, snapshotDigest: "not-a-digest" },
		]) {
			expect(() =>
				resolveRunnerPrefixSelection({ ...runner, workflow: pinned }),
			).toThrow(/pinned workflow/);
		}
	});
	it("copies the pinned identity instead of retaining mutable input", () => {
		const pinned = { ...workflow };
		const selected = resolveRunnerPrefixSelection({
			...runner,
			workflow: pinned,
		});
		pinned.templateId = "tpl_research";
		expect(selected).toMatchObject({ workflow: { templateId: "tpl_code" } });
	});
	it("retains only the pinned identity fields, never caller metadata", () => {
		const selected = resolveRunnerPrefixSelection({
			...runner,
			workflow: {
				...workflow,
				credential: "PRIVATE-CALLER-METADATA",
			} as typeof workflow,
		});
		expect(JSON.stringify(selected)).not.toContain("PRIVATE-CALLER-METADATA");
	});
});
