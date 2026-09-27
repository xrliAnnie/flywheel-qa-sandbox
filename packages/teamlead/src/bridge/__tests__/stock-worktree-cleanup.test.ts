import { describe, expect, it, vi } from "vitest";
import {
	buildStockCleanupPreview,
	type StockCleanupObservedTarget,
} from "../stock-worktree-cleanup.js";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);

function eligibleTarget(): StockCleanupObservedTarget {
	return {
		projectName: "flywheel",
		repoSlug: "xrliAnnie/flywheel",
		canonicalPath: "/srv/worktrees/flywheel-FLY-3000",
		parentIdentity: { dev: "1", ino: "2" },
		leafIdentity: { dev: "1", ino: "3" },
		generation: "generation-1",
		branch: "flywheel-FLY-3000",
		head: HEAD,
		locked: false,
		detached: false,
		issueId: "issue-3000",
		issueIdentifier: "FLY-3000",
		operationId: "operation-3000",
		pr: {
			number: 3000,
			state: "MERGED",
			headRef: "flywheel-FLY-3000",
			headSha: HEAD,
			baseRef: "main",
			mergeCommitSha: MERGE,
			mergedAt: "2026-09-26T20:00:00.000Z",
		},
		bindings: [
			{
				executionId: "execution-3000",
				activationId: "activation-3000",
				path: "/srv/worktrees/flywheel-FLY-3000",
				branch: "flywheel-FLY-3000",
				generation: "generation-1",
			},
		],
		bodyObservations: [
			{
				identity: {
					executionId: "execution-3000",
					activationId: "activation-3000",
					generation: 1,
					lifecycleRevision: 0,
					adapter: "codex-tmux",
				},
				ownerToken: "owner-3000",
				spawnEpoch: 1,
				verdict: "dead",
				observedAt: "2026-09-26T20:00:00.000Z",
				expiresAt: "2026-09-26T20:01:00.000Z",
				bindingDigest: "c".repeat(64),
				reason: "writers_and_controller_gone",
			},
		],
		clean: true,
		nestedRepository: "clear",
		remoteProof: {
			state: "preserved",
			kind: "merged_exact_head",
			observedHead: HEAD,
			observedAt: "2026-09-26T20:00:00.000Z",
		},
		processCensus: {
			state: "clear",
			observedAt: "2026-09-26T20:00:00.000Z",
		},
		terminalAuthority: {
			state: "valid",
			identity: "land:operation-3000:0",
		},
	};
}

describe("stock worktree cleanup preview", () => {
	it("emits a canonical eligible manifest without invoking destructive effects", () => {
		const remove = vi.fn();
		const signal = vi.fn();
		const archive = vi.fn();
		const preview = buildStockCleanupPreview({
			projectName: "flywheel",
			observedAt: "2026-09-26T20:00:00.000Z",
			targets: [eligibleTarget()],
		});

		expect(preview.manifest.targets).toEqual([
			expect.objectContaining({
				canonicalPath: "/srv/worktrees/flywheel-FLY-3000",
				eligible: true,
				exclusionReasons: [],
			}),
		]);
		expect(preview.manifest.counts).toMatchObject({
			rawMergedClosed: 1,
			eligible: 1,
			dirty: 0,
			live: 0,
			unknown: 0,
			identityConflict: 0,
		});
		expect(preview.manifestJson).toBe(JSON.stringify(preview.manifest));
		expect(preview.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(remove).not.toHaveBeenCalled();
		expect(signal).not.toHaveBeenCalled();
		expect(archive).not.toHaveBeenCalled();
	});

	it("refuses a bindingless never-started target unless every provider proof is present", () => {
		const target = eligibleTarget();
		target.bindings = [];
		target.bodyObservations = [];
		target.bindinglessProviderProof = {
			source: "codex_pre_spawn_failure_receipt",
			ownership: "execution-3000",
			socket: null,
			lock: "launch-claim-fenced",
		};

		const preview = buildStockCleanupPreview({
			projectName: "flywheel",
			observedAt: "2026-09-26T20:00:00.000Z",
			targets: [target],
		});

		expect(preview.manifest.targets[0]).toMatchObject({
			eligible: false,
			exclusionReasons: [
				"untrusted_binding",
				"bindingless_provider_socket_missing",
			],
		});
		expect(preview.manifest.counts).toMatchObject({
			eligible: 0,
			unknown: 1,
			bindinglessCohort: 1,
		});
	});

	it("keeps every negative guard visible and preserves named reproduction samples", () => {
		const target = eligibleTarget();
		target.issueIdentifier = "FLY-2688";
		target.clean = false;
		target.nestedRepository = "present";
		target.remoteProof = { state: "unknown", reason: "compare_timeout" };
		target.bodyObservations[0] = {
			...target.bodyObservations[0]!,
			verdict: "alive",
		};
		target.processCensus = {
			state: "present",
			observedAt: "2026-09-26T20:00:00.000Z",
			pids: [42],
		};

		const result = buildStockCleanupPreview({
			projectName: "flywheel",
			observedAt: "2026-09-26T20:00:00.000Z",
			targets: [target],
		});

		expect(result.manifest.targets[0]?.exclusionReasons).toEqual([
			"preserved_sample",
			"body_alive",
			"dirty",
			"nested_repository",
			"remote_proof_unknown",
			"process_present",
		]);
		expect(result.manifest.counts).toMatchObject({
			dirty: 1,
			unpushed: 1,
			live: 1,
			preserved: 1,
			processPresent: 1,
			nestedRepository: 1,
			eligible: 0,
		});
	});
});
