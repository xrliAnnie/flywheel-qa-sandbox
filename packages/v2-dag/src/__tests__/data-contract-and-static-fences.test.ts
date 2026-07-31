import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	admitIssueDag,
	dispatchOnce,
	parseDeclaredContractConfig,
	recordEvidence,
	type SpawnRequest,
	submitNodeCompletion,
} from "../index.js";
import { makeFixture, makePorts } from "./helpers.js";

function sourceFiles(root: string): string[] {
	return readdirSync(root).flatMap((entry) => {
		const path = join(root, entry);
		if (entry === "__tests__" || entry === "dist") return [];
		return statSync(path).isDirectory()
			? sourceFiles(path)
			: path.endsWith(".ts")
				? [path]
				: [];
	});
}

describe("data-owned contracts and semantic fences", () => {
	const fixtures: ReturnType<typeof makeFixture>[] = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it("applies two consecutive runtime contract configurations without recompilation", async () => {
		const fixture = makeFixture();
		fixtures.push(fixture);
		fixture.provision("lead-a", "lead");
		fixture.provision("runtime-agent", "runner");
		const { ports } = makePorts(fixture.clock);
		const executor = {
			family: "family-a",
			vendor: "vendor",
			model: "model",
			effort: "high",
		};
		const admit = async (suffix: string, source: string) =>
			await admitIssueDag(fixture.kernel, ports, {
				admissionUid: `runtime-contract-${suffix}`,
				projectId: "project-a",
				issueId: `issue-runtime-contract-${suffix}`,
				notifyAgentId: "lead-a",
				shipWorktreeId: `wt-${suffix}`,
				worktrees: [
					{
						worktreeId: `wt-${suffix}`,
						repoIdentity: "owner/repo",
						worktreePath: `/tmp/wt-${suffix}`,
						branchRef: `refs/heads/${suffix}`,
						mergeTargetRef: "refs/heads/main",
					},
				],
				tasks: [
					{
						localId: "node",
						kindLabel: "opaque",
						contract: parseDeclaredContractConfig(source),
						writesRepo: false,
						worktreeId: null,
						executor,
					},
				],
				edges: [],
			});

		const verdictAdmission = await admit("verdict", '[{"kind":"verdict"}]');
		const verdictSpawn = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		recordEvidence(fixture.kernel, ports, {
			eventUid: "runtime-contract-verdict-evidence",
			kind: "verdict",
			taskId: verdictAdmission.taskIds.node as string,
			attemptId: verdictSpawn.attemptId,
			head: "head-a",
			verdict: "pass",
			producer: verdictSpawn.agent,
		});
		expect(
			await submitNodeCompletion(fixture.kernel, ports, {
				taskId: verdictAdmission.taskIds.node as string,
				attemptId: verdictSpawn.attemptId,
				activationId: verdictSpawn.activationId,
				agent: verdictSpawn.agent,
				completionUid: "runtime-contract-verdict-complete",
			}),
		).toMatchObject({ status: "completed" });

		const artifactAdmission = await admit(
			"artifact",
			'[{"kind":"artifact","path":"brief.md","cardinality":"one"}]',
		);
		const artifactSpawn = (await dispatchOnce(fixture.kernel, ports))
			.dispatched[0] as SpawnRequest;
		recordEvidence(fixture.kernel, ports, {
			eventUid: "runtime-contract-artifact-evidence",
			kind: "artifact",
			taskId: artifactAdmission.taskIds.node as string,
			attemptId: artifactSpawn.attemptId,
			path: "brief.md",
			digest: "d".repeat(64),
			producer: artifactSpawn.agent,
		});
		expect(
			await submitNodeCompletion(fixture.kernel, ports, {
				taskId: artifactAdmission.taskIds.node as string,
				attemptId: artifactSpawn.attemptId,
				activationId: artifactSpawn.activationId,
				agent: artifactSpawn.agent,
				completionUid: "runtime-contract-artifact-complete",
			}),
		).toMatchObject({ status: "completed" });

		const satisfied = fixture.kernel.read((tx) =>
			tx
				.all<{ payload: string }>(
					`SELECT payload FROM events
					  WHERE event_uid IN
					    ('node_completed:runtime-contract-verdict-complete',
					     'node_completed:runtime-contract-artifact-complete')
					  ORDER BY event_uid`,
				)
				.map(
					(row) =>
						(JSON.parse(row.payload) as { satisfied_items: unknown[] })
							.satisfied_items,
				),
		);
		expect(satisfied).toEqual([
			[{ cardinality: "one", kind: "artifact", path: "brief.md" }],
			[{ kind: "verdict" }],
		]);
	});

	it("contains no scenario, node-name, or role-contract vocabulary in production sources", () => {
		const root = join(import.meta.dirname, "..");
		const production = sourceFiles(root)
			.map((path) => readFileSync(path, "utf8"))
			.join("\n")
			.toLowerCase();
		for (const forbidden of [
			"prd",
			"quality-assurance",
			"design-node",
			"implement-node",
			"coding-session",
			"three-stage",
			"role-contract",
		]) {
			expect(production).not.toContain(forbidden);
		}
	});

	it("keeps the external action module free of evidence-category predicates", () => {
		const source = readFileSync(
			join(import.meta.dirname, "..", "ship.ts"),
			"utf8",
		).toLowerCase();
		// FLY-1545 ①: "ci" left this list on purpose. The fence guards against
		// ship gating on ledger evidence categories; the CI-green wait is a live
		// world observation through GitHubObservationPort at the merge authority
		// point (founder-mandated), not an evidence-row predicate.
		for (const forbidden of ["review", "verdict", "artifact", "docs", "role"]) {
			expect(source).not.toContain(forbidden);
		}
	});

	it("keeps the reconcile path free of CI observation", () => {
		// FLY-1545 ①: reconcile faces already-intended actions; after a merge
		// GitHub reports mergeStateStatus=UNKNOWN, so re-probing CI there would
		// kill legitimate settlements (the v1 merge-ship-gate lesson). The single
		// authoritative CI observation lives in executeShip, before the intent tx.
		const source = readFileSync(
			join(import.meta.dirname, "..", "reconcile.ts"),
			"utf8",
		);
		expect(source).not.toContain("readCiState");
	});

	it("keeps the package boundary and canonical task writer singular", () => {
		const packageJson = JSON.parse(
			readFileSync(
				join(import.meta.dirname, "..", "..", "package.json"),
				"utf8",
			),
		) as { dependencies: Record<string, string> };
		expect(Object.keys(packageJson.dependencies).sort()).toEqual([
			"flywheel-v2-engine",
			"flywheel-v2-kernel",
		]);
		const sources = sourceFiles(join(import.meta.dirname, "..")).map(
			(path) => ({
				path,
				source: readFileSync(path, "utf8"),
			}),
		);
		expect(
			sources
				.filter(({ source }) => /INSERT INTO tasks/i.test(source))
				.map(({ path }) => path.split("/").at(-1)),
		).toEqual(["admission.ts"]);
		for (const { source } of sources) {
			expect(source).not.toMatch(/flywheel-v2-engine\//);
			expect(source).not.toMatch(/observed_(state|at)|observation_kind/);
		}
	});

	it("routes every production attempt-terminal write through one primitive", () => {
		const terminalWriters = sourceFiles(join(import.meta.dirname, ".."))
			.filter((path) =>
				/FENCE\.attemptCasActiveTerminal|SET\s+desired_state\s*=\s*['"]terminal['"]/i.test(
					readFileSync(path, "utf8"),
				),
			)
			.map((path) => path.split("/").at(-1));

		expect(terminalWriters).toEqual(["attempt-terminal.ts"]);
	});
});
