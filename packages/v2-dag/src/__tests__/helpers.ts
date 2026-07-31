import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	initializeEngineDb,
	provisionAgentRecipient,
} from "flywheel-v2-engine";
import { Kernel, migrateDatabase } from "flywheel-v2-kernel";
import type {
	DagClock,
	GitHubMergePort,
	GitHubObservationPort,
	GitPort,
	HostPort,
	LaunchLockPort,
	ProcessProbePort,
	RunnerControlPort,
	SpawnPort,
	WorktreeRefPort,
} from "../index.js";

export class TestClock implements DagClock {
	#now = Date.parse("2026-07-28T20:00:00.000Z");

	nowMs(): number {
		return this.#now;
	}

	nowIso(): string {
		return new Date(this.#now).toISOString();
	}

	advance(ms: number): void {
		this.#now += ms;
	}

	/** FLY-1545 ①: sleeping advances virtual time; nothing really waits. */
	async sleep(ms: number): Promise<void> {
		this.#now += ms;
	}
}

export function makeFixture() {
	const dir = mkdtempSync(join(tmpdir(), "flywheel-v2-dag-"));
	const path = join(dir, "flywheel-v2.db");
	migrateDatabase({ path });
	const kernel = Kernel.open({ path });
	initializeEngineDb(kernel);
	const clock = new TestClock();
	return {
		kernel,
		clock,
		provision(agentId: string, kind: "lead" | "runner") {
			if (kind === "lead") {
				return provisionAgentRecipient(kernel, agentId, kind);
			}
		},
		cleanup() {
			kernel.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

export function makePorts(
	clock: DagClock,
	overrides: Partial<{
		git: GitPort;
		worktreeRef: WorktreeRefPort;
		spawn: SpawnPort;
		process: ProcessProbePort;
		runnerControl: RunnerControlPort;
		locks: LaunchLockPort;
		host: HostPort;
		githubObservation: GitHubObservationPort;
		githubMerge: GitHubMergePort;
	}> = {},
) {
	const git: GitPort =
		overrides.git ??
		({
			async readHead() {
				return "head-a";
			},
			async mergeBase() {
				return "head-a";
			},
			async isAncestor() {
				return true;
			},
			async rawDiff() {
				return "";
			},
			async readRef() {
				return "head-a";
			},
		} satisfies GitPort);
	const spawned: unknown[] = [];
	const spawn: SpawnPort =
		overrides.spawn ??
		({
			async spawn(request) {
				spawned.push(request);
				return {
					v: 1,
					hostEpoch: "host-1",
					sessionId: request.sessionRef,
					pid: 10_001,
					pidStart: `test-start:${request.sessionRef}`,
				};
			},
		} satisfies SpawnPort);
	return {
		ports: {
			clock,
			git,
			worktreeRef:
				overrides.worktreeRef ??
				({
					async worktreePresent(worktreePath) {
						try {
							await git.readHead(worktreePath);
							return true;
						} catch {
							return false;
						}
					},
					async readExactRef(repoIdentity, ref) {
						return await git.readRef(repoIdentity, ref);
					},
				} satisfies WorktreeRefPort),
			spawn,
			process:
				overrides.process ??
				({
					async probe() {
						return {
							state: "absent" as const,
							confirmedAt: clock.nowIso(),
						};
					},
				} satisfies ProcessProbePort),
			runnerControl:
				overrides.runnerControl ??
				({
					async requestStop() {},
				} satisfies RunnerControlPort),
			locks:
				overrides.locks ??
				({
					async withSessionLock(_sessionRef, fn) {
						return await fn();
					},
				} satisfies LaunchLockPort),
			host:
				overrides.host ??
				({
					hostEpoch() {
						return "host-1";
					},
				} satisfies HostPort),
			githubObservation: overrides.githubObservation,
			githubMerge: overrides.githubMerge,
		},
		spawned,
	};
}
