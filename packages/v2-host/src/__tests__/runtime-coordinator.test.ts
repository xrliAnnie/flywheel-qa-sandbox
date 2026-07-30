import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitIssueDag, type IssueDagDescriptor } from "flywheel-v2-dag";
import {
	initializeEngineDb,
	provisionAgentRecipient,
} from "flywheel-v2-engine";
import { Kernel, migrateDatabase } from "flywheel-v2-kernel";
import { afterEach, describe, expect, it } from "vitest";
import { V2RuntimeCoordinator } from "../coordinator.js";
import {
	createRuntimeDagPorts,
	type RunnerLauncherPort,
	type RuntimeLaunchRequest,
} from "../runtime-ports.js";

const roots: string[] = [];

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "flywheel-v2-runtime-"));
	roots.push(root);
	mkdirSync(join(root, ".flywheel", "agents"), { recursive: true });
	writeFileSync(
		join(root, ".flywheel", "config.yaml"),
		"project: runtime-test\nagents:\n  engineer:\n    agent_file: .flywheel/agents/engineer.md\n",
	);
	writeFileSync(
		join(root, ".flywheel", "agents", "engineer.md"),
		"# Engineer\n\nExecute the issue contract.\n",
	);
	execFileSync("/usr/bin/git", ["-C", root, "init", "-q"]);
	execFileSync("/usr/bin/git", [
		"-C",
		root,
		"-c",
		"user.name=V2 Test",
		"-c",
		"user.email=v2@example.invalid",
		"add",
		".",
	]);
	execFileSync("/usr/bin/git", [
		"-C",
		root,
		"-c",
		"user.name=V2 Test",
		"-c",
		"user.email=v2@example.invalid",
		"commit",
		"-qm",
		"fixture",
	]);
	const dbPath = join(root, "state", "flywheel-v2.db");
	mkdirSync(join(root, "state"), { mode: 0o700 });
	migrateDatabase({ path: dbPath });
	const kernel = Kernel.open({ path: dbPath });
	initializeEngineDb(kernel);
	provisionAgentRecipient(kernel, "lead-runtime", "lead");
	const launched: RuntimeLaunchRequest[] = [];
	const launcher: RunnerLauncherPort = {
		async launch(request) {
			launched.push(request);
			return {
				v: 1,
				hostEpoch: "host-runtime",
				sessionId: request.sessionRef,
				pid: 12_345,
				pidStart: "runtime-test-start",
			};
		},
		async probe() {
			return {
				state: "absent",
				confirmedAt: "2026-07-29T00:00:00.000Z",
			};
		},
		async stop() {},
	};
	const ports = createRuntimeDagPorts({
		kernel,
		hostEpoch: "host-runtime",
		expectedEpoch: 0,
		lockRoot: join(root, "locks"),
		launcher,
		gitBin: "/usr/bin/git",
		ghBin: "/usr/bin/false",
		now: () => new Date("2026-07-29T00:00:00.000Z"),
	});
	const descriptor: IssueDagDescriptor = {
		admissionUid: "runtime-admission",
		projectId: "runtime-test",
		issueId: "FLY-RUNTIME",
		notifyAgentId: "lead-runtime",
		shipWorktreeId: "runtime-worktree",
		worktrees: [
			{
				worktreeId: "runtime-worktree",
				repoIdentity: root,
				worktreePath: root,
				branchRef: "HEAD",
				mergeTargetRef: "HEAD",
			},
		],
		tasks: [
			{
				localId: "implement",
				kindLabel: "implementation",
				contract: [{ kind: "verdict" }],
				writesRepo: true,
				worktreeId: "runtime-worktree",
				executor: {
					logicalAgentId: "engineer",
					family: "codex",
					vendor: "claude-code",
					model: "sonnet",
					effort: "high",
				},
			},
		],
		edges: [],
	};
	return { root, kernel, ports, launched, descriptor };
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("runtime coordinator", () => {
	it("holds before final GO, then dispatches with role-file evidence pinned to the attempt", async () => {
		const current = fixture();
		try {
			await admitIssueDag(current.kernel, current.ports, current.descriptor);
			let authority: "cutover" | "live" = "cutover";
			const coordinator = new V2RuntimeCoordinator({
				kernel: current.kernel,
				ports: current.ports,
				authorityState: () => authority,
			});
			await expect(coordinator.tick()).resolves.toEqual({ status: "held" });
			expect(current.launched).toHaveLength(0);

			authority = "live";
			const result = await coordinator.tick();
			expect(result.status).toBe("ran");
			const auditedErrors = current.kernel.read((tx) =>
				tx
					.all<{ payload: string }>(
						"SELECT payload FROM events WHERE kind='task_dispatch_invalid'",
					)
					.map((row) => JSON.parse(row.payload)),
			);
			expect(result.dispatch?.failures, JSON.stringify(auditedErrors)).toEqual(
				[],
			);
			expect(result.dispatch?.dispatched).toHaveLength(1);
			expect(current.launched).toHaveLength(1);
			const canonicalRoot = realpathSync.native(current.root);
			expect(current.launched[0]?.context).toMatchObject({
				projectId: "runtime-test",
				issueId: "FLY-RUNTIME",
				projectRoot: canonicalRoot,
				instruction: {
					sourcePath: join(canonicalRoot, ".flywheel", "agents", "engineer.md"),
				},
			});
			const attemptId = current.launched[0]?.attemptId;
			expect(attemptId).toBeTruthy();
			const evidence = current.kernel.read(
				(tx) =>
					tx.get<{ value: string }>("SELECT value FROM meta WHERE key=@key", {
						key: `attempt_instruction:${attemptId}`,
					})?.value,
			);
			expect(JSON.parse(evidence as string)).toMatchObject({
				v: 1,
				project_id: "runtime-test",
				issue_id: "FLY-RUNTIME",
				logical_agent_id: "engineer",
				content_digest: current.launched[0]?.context.instruction.contentDigest,
			});
			expect(
				readFileSync(
					current.launched[0]?.context.instruction.sourcePath as string,
					"utf8",
				),
			).toContain("Execute the issue contract");
		} finally {
			current.kernel.close();
		}
	});

	it("audits and refuses dispatch when the exact logical agent is not configured", async () => {
		const current = fixture();
		try {
			current.descriptor.tasks[0]!.executor.logicalAgentId = "missing";
			await admitIssueDag(current.kernel, current.ports, current.descriptor);
			const coordinator = new V2RuntimeCoordinator({
				kernel: current.kernel,
				ports: current.ports,
				authorityState: () => "live",
			});
			const result = await coordinator.tick();
			expect(result.dispatch?.dispatched).toHaveLength(0);
			expect(result.dispatch?.failures).toEqual([
				expect.objectContaining({ stage: "launch", audited: true }),
			]);
			expect(current.launched).toHaveLength(0);
		} finally {
			current.kernel.close();
		}
	});
});
