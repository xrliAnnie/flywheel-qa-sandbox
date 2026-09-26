import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileRunnerPrefixProfile } from "flywheel-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowPrefixFixture } from "../../__tests__/fixtures/workflow-prefix.js";
import { resolveReviewPrefixProfile } from "../review-prefix-profile.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function harness(
	templateId = "tpl_code",
	profiles: {
		prefix_profile?: "legacy" | "role-v1";
		review_prefix_profile?: "legacy" | "role-v1";
	} = { review_prefix_profile: "role-v1" },
) {
	const root = mkdtempSync(join(tmpdir(), "fly2913-review-prefix-"));
	roots.push(root);
	const pinned = createWorkflowPrefixFixture(root, 3, templateId, profiles);
	const store = {
		getWorkflowExecutionRuntime: vi.fn((executionId: string) => ({
			execution_id: executionId,
			run_id: pinned.run.run_id,
			node_id: pinned.nodeId,
			attempt: 1,
			vendor: "codex",
			model: "gpt-5.6-sol",
			effort: "high",
			resolved_family: "codex",
			capabilities_digest: "a".repeat(64),
			created_at: new Date(0).toISOString(),
		})),
		getWorkflowRun: vi.fn(() => pinned.run),
	};
	return { store, pinned };
}
const home = "/Users/fixture";

describe("reviewer prefix resolution (FLY-2913)", () => {
	it.each([
		["code", "review-code"],
		["design", "review-design"],
	])(
		"maps persisted review type %s to %s from the pinned run",
		(reviewType, role) => {
			const { store, pinned } = harness();
			const resolved = resolveReviewPrefixProfile({
				store,
				executionId: "exec-author",
				reviewType,
				home,
				claudeConfigDir: `${home}/.claude`,
			});
			expect(resolved?.profile?.stamp).toMatchObject({
				role,
				workflow: {
					runId: pinned.run.run_id,
					snapshotDigest: pinned.snapshot.snapshot_digest,
				},
				// The author's pinned skills never widen the reviewer's profile.
				pinnedSkills: [],
			});
			expect(resolved?.stampDir).toBe(
				`${home}/.flywheel/runner-state/exec-author`,
			);
			expect(resolved?.profile).toEqual(
				compileRunnerPrefixProfile({
					request: {
						selection: {
							mode: "role-v1",
							role: role as "review-code",
							taskSetId: "engineering",
							workflow: {
								runId: pinned.run.run_id,
								snapshotDigest: pinned.snapshot.snapshot_digest,
								templateId: "tpl_code",
								templateRevision: 2,
							},
						},
						context: {
							workflow: {
								runId: pinned.run.run_id,
								snapshotDigest: pinned.snapshot.snapshot_digest,
								templateId: "tpl_code",
								templateRevision: 2,
							},
							nodeId: pinned.nodeId,
							phase: "implement",
							agent: null,
						},
					},
					claudeConfigDir: `${home}/.claude`,
					skillArm: "superpowers",
				}),
			);
		},
	);

	it.each([
		{},
		{ prefix_profile: "role-v1" as const },
		{ review_prefix_profile: "legacy" as const },
	])(
		"keeps the independent missing/legacy review declaration on legacy",
		(profiles) => {
			const { store } = harness("tpl_code", profiles);
			expect(
				resolveReviewPrefixProfile({
					store,
					executionId: "exec-author",
					reviewType: "code",
					home,
				}),
			).toMatchObject({
				audit: { effectiveProfile: "legacy", fallbackReason: "node-legacy" },
			});
			expect(store.getWorkflowExecutionRuntime).toHaveBeenCalledOnce();
		},
	);
	it("uses reviewer intent when the author runner is explicitly legacy", () => {
		const { store } = harness("tpl_code", {
			prefix_profile: "legacy",
			review_prefix_profile: "role-v1",
		});
		expect(
			resolveReviewPrefixProfile({
				store,
				executionId: "exec-author",
				reviewType: "code",
				home,
			})?.profile?.stamp.mode,
		).toBe("role-v1");
	});
	it("keeps unknown review types, non-engineering and unbound executions legacy", () => {
		const { store } = harness();
		expect(
			resolveReviewPrefixProfile({
				store,
				executionId: "exec-author",
				reviewType: "security",
				home,
			}),
		).toBeUndefined();
		const research = harness("tpl_research");
		expect(
			resolveReviewPrefixProfile({
				store: research.store,
				executionId: "exec-author",
				reviewType: "code",
				home,
			}),
		).toMatchObject({
			audit: { effectiveProfile: "legacy", fallbackReason: "unmapped-trigger" },
		});
		const unbound = harness();
		unbound.store.getWorkflowExecutionRuntime.mockReturnValue(
			undefined as never,
		);
		expect(
			resolveReviewPrefixProfile({
				store: unbound.store,
				executionId: "adhoc",
				reviewType: "code",
				home,
			}),
		).toMatchObject({
			audit: { effectiveProfile: "legacy", fallbackReason: "unmapped-trigger" },
		});
	});

	it("keeps user and reviewed-project skills that are hidden further", () => {
		const { store } = harness();
		const configDir = mkdtempSync(join(tmpdir(), "fly2913-review-config-"));
		const checkout = mkdtempSync(join(tmpdir(), "fly2913-review-cwd-"));
		roots.push(configDir, checkout);
		writeFileSync(
			join(configDir, "settings.json"),
			JSON.stringify({ skillOverrides: { gws: "off" } }),
		);
		mkdirSync(join(checkout, ".claude"));
		writeFileSync(
			join(checkout, ".claude", "settings.json"),
			JSON.stringify({ skillOverrides: { notion: "user-invocable-only" } }),
		);
		const resolved = resolveReviewPrefixProfile({
			store,
			executionId: "exec-author",
			reviewType: "code",
			home,
			claudeConfigDir: configDir,
			cwd: checkout,
		});
		expect(resolved?.profile?.settings.skillOverrides).not.toHaveProperty(
			"gws",
		);
		expect(resolved?.profile?.settings.skillOverrides).not.toHaveProperty(
			"notion",
		);
		expect(resolved?.profile?.stamp.keptLowerRestrictions).toEqual([
			"gws",
			"notion",
		]);
	});

	it("rejects an execution id that could escape the runner-state root", () => {
		const { store } = harness();
		expect(() =>
			resolveReviewPrefixProfile({
				store,
				executionId: "../escape",
				reviewType: "code",
				home,
			}),
		).toThrow(/review_prefix_profile/);
	});
});
