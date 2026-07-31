import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
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
import {
	type TmuxCommandPort,
	TmuxRunnerLauncher,
} from "../tmux-runner-launcher.js";

/**
 * FLY-1556 acceptance — the four dirty-data injections from the 2026-07-30
 * production outage, each asserting the SAME property: only the poisoned unit
 * fails, the engine keeps ticking, everything healthy still runs.
 *
 * (Acceptance 1's host/socket-level half — a failing session activation with
 * the host still answering `health` on its socket — lives in
 * fly1503-host-gaps.test.ts, "boots, records durably, and keeps serving".)
 */

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
	return execFileSync(
		"/usr/bin/git",
		[
			"-C",
			cwd,
			"-c",
			"user.name=V2 Test",
			"-c",
			"user.email=v2@example.invalid",
			...args,
		],
		{ encoding: "utf8" },
	).trim();
}

function makeWorktree(root: string, name: string, kind: string): string {
	const project = join(root, name);
	mkdirSync(join(project, ".flywheel", "agents", "nodes"), {
		recursive: true,
	});
	writeFileSync(
		join(project, ".flywheel", "agents", "nodes", `${kind}.md`),
		`# ${kind} node\n\nExecute the issue contract.\n`,
	);
	git(project, ["init", "-q"]);
	git(project, ["add", "."]);
	git(project, ["commit", "-qm", "fixture"]);
	return project;
}

interface Fixture {
	root: string;
	kernel: Kernel;
	launched: RuntimeLaunchRequest[];
	now: { current: Date };
	makePorts: (
		launcher: RunnerLauncherPort,
	) => ReturnType<typeof createRuntimeDagPorts>;
	fakeLauncher: RunnerLauncherPort;
	worktreeA: string;
	worktreeB: string;
	descriptor: IssueDagDescriptor;
}

function fixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "flywheel-v2-fault-isolation-"));
	roots.push(root);
	const worktreeA = makeWorktree(root, "project-a", "implementation");
	const worktreeB = makeWorktree(root, "project-b", "implementation");
	const dbPath = join(root, "state", "flywheel-v2.db");
	mkdirSync(join(root, "state"), { mode: 0o700 });
	migrateDatabase({ path: dbPath });
	const kernel = Kernel.open({ path: dbPath });
	initializeEngineDb(kernel);
	provisionAgentRecipient(kernel, "lead-isolation", "lead");
	const launched: RuntimeLaunchRequest[] = [];
	const now = { current: new Date("2026-07-30T00:00:00.000Z") };
	const fakeLauncher: RunnerLauncherPort = {
		async launch(request) {
			launched.push(request);
			return {
				v: 1,
				hostEpoch: "host-isolation",
				sessionId: request.sessionRef,
				pid: 12_345,
				pidStart: "isolation-test-start",
			};
		},
		async probe() {
			return {
				state: "absent",
				confirmedAt: now.current.toISOString(),
			};
		},
		async stop() {},
	};
	const makePorts = (launcher: RunnerLauncherPort) =>
		createRuntimeDagPorts({
			kernel,
			hostEpoch: "host-isolation",
			expectedEpoch: 0,
			lockRoot: join(root, "locks"),
			launcher,
			gitBin: "/usr/bin/git",
			ghBin: "/usr/bin/false",
			now: () => now.current,
		});
	const descriptor: IssueDagDescriptor = {
		admissionUid: "isolation-admission",
		projectId: "isolation-test",
		issueId: "FLY-ISOLATION",
		notifyAgentId: "lead-isolation",
		shipWorktreeId: "worktree-a",
		worktrees: [
			{
				worktreeId: "worktree-a",
				repoIdentity: worktreeA,
				worktreePath: worktreeA,
				branchRef: "HEAD",
				mergeTargetRef: "HEAD",
			},
			{
				worktreeId: "worktree-b",
				repoIdentity: worktreeB,
				worktreePath: worktreeB,
				branchRef: "HEAD",
				mergeTargetRef: "HEAD",
			},
		],
		tasks: [
			{
				localId: "node-a",
				kindLabel: "implementation",
				contract: [{ kind: "verdict" }],
				writesRepo: true,
				worktreeId: "worktree-a",
				executor: {
					family: "claude",
					vendor: "claude",
					model: "test-model",
					effort: "high",
				},
			},
			{
				localId: "node-b",
				kindLabel: "implementation",
				contract: [{ kind: "verdict" }],
				writesRepo: true,
				worktreeId: "worktree-b",
				executor: {
					family: "claude",
					vendor: "claude",
					model: "test-model",
					effort: "high",
				},
			},
		],
		edges: [],
	};
	return {
		root,
		kernel,
		launched,
		now,
		makePorts,
		fakeLauncher,
		worktreeA,
		worktreeB,
		descriptor,
	};
}

function coordinatorFor(current: Fixture, launcher?: RunnerLauncherPort) {
	return new V2RuntimeCoordinator({
		kernel: current.kernel,
		ports: current.makePorts(launcher ?? current.fakeLauncher),
		authorityState: () => "live",
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("FLY-1556 acceptance — dirty data stays in its own failure domain", () => {
	it("injection: worktree deleted under a ready task — audited failure, the other task still dispatches", async () => {
		const current = fixture();
		try {
			await admitIssueDag(
				current.kernel,
				current.makePorts(current.fakeLauncher),
				current.descriptor,
			);
			// The 1543-style residue: the task is still ready but its worktree is
			// gone from disk.
			rmSync(current.worktreeA, { recursive: true, force: true });
			const coordinator = coordinatorFor(current);
			const result = await coordinator.tick();
			expect(result.status).toBe("ran");
			expect(result.phaseFailures).toBeUndefined();
			// The poisoned task failed, audited; the healthy one launched.
			expect(result.dispatch?.failures).toEqual([
				expect.objectContaining({ stage: "worktree_head", audited: true }),
			]);
			expect(current.launched).toHaveLength(1);
			expect(current.launched[0]?.context.projectRoot).toContain("project-b");
			const audited = current.kernel.read((tx) =>
				tx.all<{ payload: string }>(
					"SELECT payload FROM events WHERE kind='task_dispatch_invalid'",
				),
			);
			expect(audited).toHaveLength(1);
			// The next tick still runs (no crash-loop, no wedge).
			await expect(coordinator.tick()).resolves.toMatchObject({
				status: "ran",
			});
		} finally {
			current.kernel.close();
		}
	});

	it("injection: canceled task with a started attempt — recovery completes without wedging the tick", async () => {
		const current = fixture();
		try {
			await admitIssueDag(
				current.kernel,
				current.makePorts(current.fakeLauncher),
				current.descriptor,
			);
			const coordinator = coordinatorFor(current);
			const first = await coordinator.tick();
			expect(first.dispatch?.dispatched).toHaveLength(2);
			// The 1547/1548-style zombie: the task is canceled out from under its
			// still-started attempt.
			const zombie = current.launched[0]?.taskId as string;
			current.kernel.write("test.zombie", (tx) => {
				tx.run(
					"UPDATE tasks SET state='canceled',state_version=state_version+1 WHERE id=@taskId",
					{ taskId: zombie },
				);
			});
			// Past the reap grace so recovery actually has to handle the claim.
			current.now.current = new Date("2026-07-30T00:10:00.000Z");
			const second = await coordinator.tick();
			expect(second.status).toBe("ran");
			expect(second.phaseFailures).toBeUndefined();
			// The zombie's attempt is reaped (probe is absent) and the tick keeps
			// serving the healthy session's claim on the same pass.
			expect(second.recovery, JSON.stringify(second.recovery)).toMatchObject({
				reaped: 2,
			});
			await expect(coordinator.tick()).resolves.toMatchObject({
				status: "ran",
			});
		} finally {
			current.kernel.close();
		}
	});

	it("injection: corrupt launch_claim residue — named skip, healthy claims still recovered", async () => {
		const current = fixture();
		try {
			await admitIssueDag(
				current.kernel,
				current.makePorts(current.fakeLauncher),
				current.descriptor,
			);
			const coordinator = coordinatorFor(current);
			const first = await coordinator.tick();
			expect(first.dispatch?.dispatched).toHaveLength(2);
			// The orphan residue: a launch_claim row whose envelope is garbage.
			current.kernel.write("test.corrupt-claim", (tx) => {
				tx.run(
					`INSERT INTO meta(key,value,updated_at)
					 VALUES('launch_claim:v2dag:orphan:1:dead','not-json','2026-07-30T00:00:00.000Z')`,
					{},
				);
			});
			const second = await coordinator.tick();
			expect(second.status).toBe("ran");
			expect(second.phaseFailures).toBeUndefined();
			expect(second.recovery?.skips).toEqual(
				expect.arrayContaining([
					{ taskId: null, reason: "recovery_claim_unreadable" },
				]),
			);
			// The two healthy launched claims were still examined alongside it.
			expect(second.recovery?.examined).toBe(3);
		} finally {
			current.kernel.close();
		}
	});

	it("a phase that throws is contained: later phases still run and the failure is named", async () => {
		const current = fixture();
		try {
			await admitIssueDag(
				current.kernel,
				current.makePorts(current.fakeLauncher),
				current.descriptor,
			);
			const ports = current.makePorts(current.fakeLauncher);
			const coordinator = new V2RuntimeCoordinator({
				kernel: current.kernel,
				ports: {
					...ports,
					faults: {
						hit(point) {
							if (point === "dispatch_after_prepare") {
								throw new Error("injected dispatch fault");
							}
						},
					},
				},
				authorityState: () => "live",
			});
			const result = await coordinator.tick();
			expect(result.status).toBe("ran");
			expect(result.phaseFailures).toEqual([
				{
					phase: "dispatch",
					error: expect.stringContaining("injected dispatch fault"),
				},
			]);
			// Recovery ran before the fault; closure and doorbell ran after it.
			expect(result.recovery).toBeDefined();
			expect(result.closure).toBeDefined();
			expect(result.doorbell).toBeDefined();
		} finally {
			current.kernel.close();
		}
	});

	it("acceptance 4: an issue whose task edits its own node instruction runs the full launch/activate flow", async () => {
		const current = fixture();
		try {
			const sessionRefs = new Map<string, string>();
			let present = false;
			const command: TmuxCommandPort = {
				async run(_file, args) {
					if (args.includes("has-session")) {
						if (!present) {
							const error = new Error("can't find session") as Error & {
								stderr: string;
							};
							error.stderr = "can't find session";
							throw error;
						}
						return { stdout: "", stderr: "" };
					}
					if (args.includes("new-session")) {
						present = true;
						const ref = args
							.find((arg) => arg.startsWith("FLYWHEEL_V2_SESSION_REF="))
							?.slice("FLYWHEEL_V2_SESSION_REF=".length) as string;
						sessionRefs.set("live", ref);
						const session = args[args.indexOf("-s") + 1];
						return { stdout: `${session}:@0\n`, stderr: "" };
					}
					if (args.includes("show-environment")) {
						return {
							stdout: `FLYWHEEL_V2_SESSION_REF=${sessionRefs.get("live")}\n`,
							stderr: "",
						};
					}
					if (args.includes("display-message")) {
						return { stdout: `${process.pid}|0\n`, stderr: "" };
					}
					return { stdout: "", stderr: "" };
				},
			};
			const stateRoot = join(current.root, "launcher-state");
			const launcher = new TmuxRunnerLauncher({
				hostEpoch: "host-isolation",
				tmuxBin: "/usr/local/bin/tmux",
				claudeBin: "/opt/flywheel/bin/claude",
				codexBin: "/opt/flywheel/bin/codex",
				clientCliPath: "/opt/flywheel/v2-cli.js",
				socketPath: join(current.root, "host.sock"),
				secretPath: join(current.root, "host.secret"),
				sessionProofRoot: join(current.root, "proofs"),
				releaseRoot: join(current.root, "release"),
				stateRoot,
				cmuxEventFilePath: join(current.root, "cmux-events"),
				command,
				now: () => current.now.current,
				processStart: () => "isolation-test-start",
			});
			// Single-task descriptor: the issue's ONE node edits its own book.
			current.descriptor.worktrees = [current.descriptor.worktrees[0]!];
			current.descriptor.tasks = [current.descriptor.tasks[0]!];
			await admitIssueDag(
				current.kernel,
				current.makePorts(launcher),
				current.descriptor,
			);
			const pinnedBlob = git(current.worktreeA, [
				"rev-parse",
				"HEAD:.flywheel/agents/nodes/implementation.md",
			]);
			const coordinator = coordinatorFor(current, launcher);
			const first = await coordinator.tick();
			expect(first.phaseFailures).toBeUndefined();
			expect(first.dispatch?.dispatched).toHaveLength(1);
			const sessionRef = first.dispatch?.dispatched[0]?.sessionRef as string;

			// The pin's single source of truth is the kernel row, and it names the
			// immutable blob (acceptance 3).
			const attemptId = first.dispatch?.dispatched[0]?.attemptId as string;
			const evidence = current.kernel.read(
				(tx) =>
					tx.get<{ value: string }>("SELECT value FROM meta WHERE key=@key", {
						key: `attempt_instruction:${attemptId}`,
					})?.value,
			);
			expect(JSON.parse(evidence as string)).toMatchObject({
				source_blob: pinnedBlob,
			});
			// No per-session runner-state file exists anywhere: the only thing the
			// launcher persists is the content-addressed instruction copy.
			expect(readdirSync(stateRoot)).toEqual(["instructions"]);
			expect(readdirSync(join(stateRoot, "instructions"))).toHaveLength(1);

			// The task does its job: edit + commit its own node instruction file.
			writeFileSync(
				join(
					current.worktreeA,
					".flywheel",
					"agents",
					"nodes",
					"implementation.md",
				),
				"# Implementation node\n\nRewritten by the running task (FLY-1547).\n",
			);
			git(current.worktreeA, ["add", "."]);
			git(current.worktreeA, ["commit", "-qm", "task edits its own book"]);

			// Activation — the seam that killed the engine on 2026-07-30 — is
			// unaffected by the edit, and so is every later tick.
			await expect(launcher.activate(sessionRef)).resolves.toBeUndefined();
			expect(
				existsSync(join(current.root, "release")) &&
					readdirSync(join(current.root, "release")).length,
			).toBe(1);
			const second = await coordinator.tick();
			expect(second.status).toBe("ran");
			expect(second.phaseFailures).toBeUndefined();
			expect(second.recovery?.adopted).toBe(1);
			const faults = current.kernel.read((tx) =>
				tx.all(
					"SELECT 1 FROM events WHERE kind IN ('session_activation_failed','coordinator_phase_failed','coordinator_tick_failed')",
				),
			);
			expect(faults).toEqual([]);
		} finally {
			current.kernel.close();
		}
	});
});
