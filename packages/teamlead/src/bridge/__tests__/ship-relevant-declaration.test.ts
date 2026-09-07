import { describe, expect, it, vi } from "vitest";
import {
	parseDeclaredPrEvidence,
	resolveShipRelevantDeclarations,
} from "../ship-relevant-declaration.js";

const HEAD = "a".repeat(40);

describe("ship-relevant declaration admission", () => {
	it("validates shape before I/O and deduplicates only equal path/PR tuples", async () => {
		expect(parseDeclaredPrEvidence({})).toEqual({
			ok: false,
			reason: "invalid_shape",
		});
		expect(
			parseDeclaredPrEvidence(
				Array.from({ length: 9 }, (_, index) => ({
					targetRepoPath: `repo-${index}`,
					prNumber: index + 1,
					headSha: HEAD,
				})),
			),
		).toEqual({ ok: false, reason: "too_many" });

		const parsed = parseDeclaredPrEvidence([
			{ targetRepoPath: "nested", prNumber: 41, headSha: HEAD },
			{ targetRepoPath: "nested", prNumber: 41, headSha: HEAD },
			{ targetRepoPath: "nested", prNumber: 42, headSha: HEAD },
		]);
		expect(parsed).toMatchObject({ ok: true });
		if (!parsed.ok) throw new Error("expected declarations");
		expect(parsed.declarations).toHaveLength(2);
	});

	it.each([
		["main", 41, "__main__", "main_repo_must_use_pr"],
		["nested", 41, "owner/nested", "duplicates_primary"],
	] as const)(
		"rejects %s repository authority",
		async (path, prNumber, identity, reason) => {
			const result = await resolveShipRelevantDeclarations({
				authorityRoot: "/worktree",
				declarations: [{ targetRepoPath: path, prNumber, headSha: HEAD }],
				primary: { repoIdentity: "owner/nested", prNumber: 41 },
				resolveAuthority: async () => ({
					path: `/worktree/${path}`,
					identity,
					probeRepoSlug: "owner/nested",
					headSha: HEAD,
				}),
			});
			expect(result).toEqual({ ok: false, reason });
		},
	);

	it("rejects a declaration whose frozen head no longer matches authority", async () => {
		await expect(
			resolveShipRelevantDeclarations({
				authorityRoot: "/worktree",
				declarations: [
					{ targetRepoPath: "nested", prNumber: 41, headSha: HEAD },
				],
				resolveAuthority: async () => ({
					path: "/worktree/nested",
					identity: "owner/nested",
					probeRepoSlug: "owner/nested",
					headSha: "b".repeat(40),
				}),
			}),
		).resolves.toEqual({ ok: false, reason: "head_mismatch" });
	});

	it("reuses one authority probe for distinct PRs in the same checkout", async () => {
		const resolveAuthority = vi.fn(async () => ({
			path: "/worktree/nested",
			identity: "owner/nested",
			probeRepoSlug: "owner/nested",
			headSha: HEAD,
		}));
		const result = await resolveShipRelevantDeclarations({
			authorityRoot: "/worktree",
			declarations: [
				{ targetRepoPath: "nested", prNumber: 41, headSha: HEAD },
				{ targetRepoPath: "nested", prNumber: 42, headSha: HEAD },
			],
			resolveAuthority,
		});

		expect(result).toMatchObject({ ok: true });
		expect(resolveAuthority).toHaveBeenCalledOnce();
	});

	it("resolves with concurrency four and deduplicates repository aliases after I/O", async () => {
		let active = 0;
		let maxActive = 0;
		const resolveAuthority = vi.fn(
			async (input: { requestedRepoPath?: string }) => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 2));
				active -= 1;
				return {
					path: `/worktree/${input.requestedRepoPath}`,
					identity:
						input.requestedRepoPath === "alias"
							? "owner/nested-0"
							: `owner/${input.requestedRepoPath}`,
					probeRepoSlug:
						input.requestedRepoPath === "alias"
							? "owner/nested-0"
							: `owner/${input.requestedRepoPath}`,
					headSha: HEAD,
				};
			},
		);
		const declarations = [
			...Array.from({ length: 5 }, (_, index) => ({
				targetRepoPath: `nested-${index}`,
				prNumber: 41,
				headSha: HEAD,
			})),
			{ targetRepoPath: "alias", prNumber: 41, headSha: HEAD },
		];

		const result = await resolveShipRelevantDeclarations({
			authorityRoot: "/worktree",
			declarations,
			resolveAuthority: resolveAuthority as never,
		});

		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error("expected declarations");
		expect(result.declarations).toHaveLength(5);
		expect(maxActive).toBe(4);
	});

	it("aborts all authority probes at the shared timeout", async () => {
		let settledAfterAbort = 0;
		const result = await resolveShipRelevantDeclarations({
			authorityRoot: "/worktree",
			declarations: Array.from({ length: 4 }, (_, index) => ({
				targetRepoPath: `nested-${index}`,
				prNumber: 41,
				headSha: HEAD,
			})),
			timeoutMs: 5,
			resolveAuthority: async ({ requestedRepoPath, signal }) => {
				const index = Number(requestedRepoPath?.split("-").at(-1));
				await new Promise<void>((_resolve, reject) => {
					signal?.addEventListener(
						"abort",
						() => {
							setTimeout(() => {
								settledAfterAbort += 1;
								reject(new Error("aborted"));
							}, index * 2);
						},
						{ once: true },
					);
				});
				throw new Error("unreachable");
			},
		});

		expect(result).toEqual({ ok: false, reason: "authority_timeout" });
		expect(settledAfterAbort).toBe(4);
	});
});
