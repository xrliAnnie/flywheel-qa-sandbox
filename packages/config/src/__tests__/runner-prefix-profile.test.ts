import { describe, expect, it, vi } from "vitest";
import {
	isRunnerPrefixProfile,
	RUNNER_PREFIX_PROFILES,
	resolveRunnerPrefixSelection,
} from "../runner-prefix-profile.js";

const workflow = {
	runId: "run-2913",
	snapshotDigest: "a".repeat(64),
	templateId: "tpl_code",
	templateRevision: 7,
};
const enabled = "role-v1" as const;
const runner = {
	actor: "runner" as const,
	backend: "claude-tmux",
	phase: "implement",
	workflow,
	profile: enabled,
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
	it("never configures Lead or Codex, even when the pinned node declares role-v1", () => {
		for (const args of [
			{ ...runner, actor: "lead" as const },
			{ ...runner, backend: "codex-app-server" },
			{ ...runner, backend: "claude-sdk" },
		]) {
			expect(resolveRunnerPrefixSelection(args)).toEqual({
				mode: "legacy",
				reason: "not-applicable",
			});
		}
	});
	it("keeps a legacy declaration and full-mcp escape hatch", () => {
		expect(
			resolveRunnerPrefixSelection({
				...runner,
				profile: "legacy",
			}),
		).toEqual({ mode: "legacy", reason: "node-legacy" });
		expect(
			resolveRunnerPrefixSelection({ ...runner, issueLabels: ["Full-MCP"] }),
		).toEqual({ mode: "legacy", reason: "full-mcp" });
	});
	it.each([undefined, "legacy"] as const)(
		"defaults missing or legacy node declaration %s to legacy",
		(profile) => {
			expect(resolveRunnerPrefixSelection({ ...runner, profile })).toEqual({
				mode: "legacy",
				reason: "node-legacy",
			});
		},
	);
	it("does not interpret a stale store row as a node declaration", () => {
		expect(
			resolveRunnerPrefixSelection({
				...runner,
				profile: { hasOverride: true, raw: "role-v1" } as never,
			}),
		).toEqual({ mode: "legacy", reason: "node-legacy" });
	});
	it("never reads the registry env name as a production switch", () => {
		vi.stubEnv("FLYWHEEL_RUNNER_PREFIX_PROFILE", "role-v1");
		try {
			expect(
				resolveRunnerPrefixSelection({ ...runner, profile: undefined }),
			).toEqual({ mode: "legacy", reason: "node-legacy" });
		} finally {
			vi.unstubAllEnvs();
		}
	});
	it("exports the node enum with legacy as the only fallback", () => {
		expect(RUNNER_PREFIX_PROFILES).toEqual(["legacy", "role-v1"]);
		expect(isRunnerPrefixProfile("role-v1")).toBe(true);
		expect(isRunnerPrefixProfile("ROLE-V1")).toBe(false);
		expect(isRunnerPrefixProfile(null)).toBe(false);
	});
	it("does not accept an unbound run identity", () => {
		for (const pinned of [
			{ ...workflow, runId: "" },
			{ ...workflow, templateRevision: 0 },
			{ ...workflow, templateRevision: 1.5 },
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
