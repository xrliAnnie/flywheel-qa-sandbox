import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
	canonicalJsonString,
	canonicalSubmissionDigest,
} from "flywheel-config";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateContinuity } from "../patrol-continuity.js";
import { collectPatrolObservations } from "../patrol-continuity-collector.js";

const executionId = "44432ed1-8968-4cc8-a69d-fa35a468ff6f";
const activationId = `activation:${executionId}:22222222-2222-4222-8222-222222222222:implement:1`;
const runId = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];
function collectorFixture() {
	const root = mkdtempSync(join(tmpdir(), "patrol-collector-"));
	roots.push(root);
	const dbPath = join(root, "state.db"),
		commDbPath = join(root, "comm.db"),
		projectsFile = join(root, "projects.json");
	writeFileSync(
		projectsFile,
		JSON.stringify([{ projectName: "flywheel", projectRepo: "owner/repo" }]),
	);
	const state = new Database(dbPath),
		comm = new Database(commDbPath);
	state.exec(`CREATE TABLE sessions(execution_id TEXT,project_name TEXT,status TEXT,session_stage TEXT,worktree_binding_path TEXT,worktree_binding_branch TEXT,worktree_binding_generation TEXT,repo_baseline_set_json TEXT,repo_baseline_set_digest TEXT);
 CREATE TABLE workflow_run(run_id TEXT,project_name TEXT,issue_id TEXT);
 CREATE TABLE workflow_execution_binding(activation_id TEXT,execution_id TEXT,run_id TEXT,node_id TEXT,attempt INTEGER);
 CREATE TABLE workflow_run_node(run_id TEXT,node_id TEXT,attempt INTEGER,state TEXT,execution_id TEXT);
 CREATE TABLE workflow_activation_turn(activation_id TEXT,execution_id TEXT,issue_id TEXT,epoch INTEGER);
 CREATE TABLE workflow_node_pr_binding(run_id TEXT,node_id TEXT,attempt INTEGER,pr_number INTEGER,target_repo_identity TEXT,probe_repo_slug TEXT,target_repo_path TEXT,worktree_binding_generation TEXT);
 CREATE TABLE session_events(id INTEGER PRIMARY KEY,execution_id TEXT,event_type TEXT,payload TEXT,ts TEXT);
 CREATE TABLE workflow_run_event(seq INTEGER,run_id TEXT,node_id TEXT,execution_id TEXT,kind TEXT,payload TEXT,at TEXT);`);
	comm.exec(`CREATE TABLE sessions(execution_id TEXT,project_name TEXT,lead_id TEXT,status TEXT,issue_id TEXT);
 CREATE TABLE three_stage_turn(issue_id TEXT,holder_exec_id TEXT,epoch INTEGER,activation_id TEXT,target_run_id TEXT,target_node_id TEXT,target_attempt INTEGER);
 CREATE TABLE runner_workflow_activation(execution_id TEXT,epoch INTEGER,activation_id TEXT,run_id TEXT,node_id TEXT,attempt INTEGER);
 CREATE TABLE runner_declared_states(execution_id TEXT,kind TEXT,created_at INTEGER,expires_at INTEGER);
 CREATE TABLE mailbox(id TEXT,from_agent TEXT,type TEXT,kind TEXT,checkpoint TEXT,resolved_at TEXT,superseded_at TEXT,expires_at TEXT,created_at TEXT);`);
	state
		.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)")
		.run(
			executionId,
			"flywheel",
			"running",
			"implement",
			root,
			"feature/1945",
			"generation-1",
			null,
			null,
		);
	state
		.prepare("INSERT INTO workflow_run VALUES(?,?,?)")
		.run(runId, "flywheel", "issue-1945");
	state
		.prepare("INSERT INTO workflow_execution_binding VALUES(?,?,?,?,?)")
		.run(activationId, executionId, runId, "implement", 1);
	state
		.prepare("INSERT INTO workflow_run_node VALUES(?,?,?,?,?)")
		.run(runId, "implement", 1, "running", executionId);
	state
		.prepare("INSERT INTO workflow_activation_turn VALUES(?,?,?,?)")
		.run(activationId, executionId, "issue-1945", 1);
	comm
		.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)")
		.run(executionId, "flywheel", "flywheel-eng-lead", "running", "issue-1945");
	comm
		.prepare("INSERT INTO three_stage_turn VALUES(?,?,?,?,?,?,?)")
		.run("issue-1945", executionId, 1, activationId, runId, "implement", 1);
	comm
		.prepare("INSERT INTO runner_workflow_activation VALUES(?,?,?,?,?,?)")
		.run(executionId, 1, activationId, runId, "implement", 1);
	return {
		state,
		comm,
		input: {
			dbPath,
			commDbPath,
			projectsFile,
			project: "flywheel",
			lead: "flywheel-eng-lead",
			executionIds: [executionId],
			nowMs: 1789400000000,
			gh: async () => JSON.stringify({ object: { sha: "a".repeat(40) } }),
		},
	};
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
describe("read-only patrol collector", () => {
	it.each(["terminated", "completed", "running"])(
		"%s sibling with stale CommDB running row does not impersonate a retired writer",
		async (status) => {
			const f = collectorFixture();
			const sibling = "33333333-3333-4333-8333-333333333333";
			f.state
				.prepare(
					"INSERT INTO sessions SELECT ?,project_name,?,session_stage,worktree_binding_path,worktree_binding_branch,worktree_binding_generation,NULL,NULL FROM sessions WHERE execution_id=?",
				)
				.run(sibling, status, executionId);
			f.comm
				.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)")
				.run(sibling, "flywheel", "flywheel-eng-lead", "running", "old-issue");
			f.state.close();
			f.comm.close();
			const [first] = await collectPatrolObservations(f.input);
			const previous = evaluateContinuity(undefined, first).entry;
			const [next] = await collectPatrolObservations({
				...f.input,
				nowMs: f.input.nowMs + 3600000,
				gh: async () => JSON.stringify({ object: { sha: "b".repeat(40) } }),
			});
			expect(next.canAttributeRemote).toBe(status !== "running");
			if (status !== "running") {
				expect(evaluateContinuity(previous ?? undefined, next)).toMatchObject({
					activity: "ACTIVE",
					reason: "remote_head_changed",
				});
			}
		},
	);
	it("collects running implement without optional baseline or PR", async () => {
		const f = collectorFixture();
		f.state.close();
		f.comm.close();
		const [row] = await collectPatrolObservations(f.input);
		expect(row.sourcesComplete).toBe(true);
		expect(row.ownershipComplete).toBe(true);
		expect(row.identity.repoSourceIdentity).toContain("project_registry_root");
		expect(row.refs[0].fullRef).toBe("refs/heads/feature/1945");
		expect(row.canAttributeRemote).toBe(true);
	});
	it("rejects duplicate project registry and source changes during probe", async () => {
		const f = collectorFixture();
		f.state.close();
		f.comm.close();
		writeFileSync(
			f.input.projectsFile,
			JSON.stringify([
				{ projectName: "flywheel", projectRepo: "owner/repo" },
				{ projectName: "flywheel", projectRepo: "owner/repo" },
			]),
		);
		expect((await collectPatrolObservations(f.input))[0].sourcesComplete).toBe(
			false,
		);
	});
	it("does not attribute current writer pushes to parked old activation", async () => {
		const f = collectorFixture();
		f.comm
			.prepare(
				"UPDATE three_stage_turn SET holder_exec_id=?,epoch=2,activation_id=?",
			)
			.run(
				"33333333-3333-4333-8333-333333333333",
				"44444444-4444-4444-8444-444444444444",
			);
		f.state.close();
		f.comm.close();
		const [row] = await collectPatrolObservations(f.input);
		expect(row.canAttributeRemote).toBe(false);
		expect(row.semanticState.effectiveWait?.kind).toBe("phase");
	});
});

describe("collector negative guards and replay", () => {
	it("rejects source change while gh is running", async () => {
		const f = collectorFixture();
		f.state.close();
		f.comm.close();
		const original = f.input.gh;
		f.input.gh = async () => {
			writeFileSync(
				f.input.projectsFile,
				JSON.stringify([
					{ projectName: "flywheel", projectRepo: "owner/changed" },
				]),
			);
			return original();
		};
		const [row] = await collectPatrolObservations(f.input);
		expect(row.reason).toBe("identity_changed_during_probe");
		expect(row.refs).toEqual([]);
	});
	it.each(["parked", "long_task"])(
		"keeps valid %s episode stable across renewal and observes expiry",
		async (kind) => {
			const f = collectorFixture();
			f.comm
				.prepare("INSERT INTO runner_declared_states VALUES(?,?,?,?)")
				.run(executionId, kind, 100, f.input.nowMs + 10000);
			const [before] = await collectPatrolObservations(f.input);
			expect(before.semanticState.effectiveWait?.kind).toBe(kind);
			f.comm.prepare("UPDATE runner_declared_states SET expires_at=NULL").run();
			expect(
				(await collectPatrolObservations(f.input))[0].semanticState
					.effectiveWait?.kind ?? null,
			).toBe(kind === "parked" ? "parked" : null);

			f.comm
				.prepare("UPDATE runner_declared_states SET expires_at=?")
				.run(f.input.nowMs + 20000);
			expect(
				(await collectPatrolObservations(f.input))[0].semanticState,
			).toEqual(before.semanticState);
			f.comm
				.prepare("UPDATE runner_declared_states SET expires_at=?")
				.run(f.input.nowMs - 1);
			f.state.close();
			f.comm.close();
			expect(
				(await collectPatrolObservations(f.input))[0].semanticState
					.effectiveWait,
			).toBeNull();
		},
	);
	it("uses exact unresolved gate checkpoint and ignores reports", async () => {
		const f = collectorFixture();
		f.comm
			.prepare("INSERT INTO mailbox VALUES(?,?,?,?,?,?,?,?,?)")
			.run(
				activationId,
				executionId,
				"question",
				null,
				"review_code",
				null,
				null,
				new Date(f.input.nowMs + 5000).toISOString(),
				"2026-09-14",
			);
		const [row] = await collectPatrolObservations(f.input);
		expect(row.semanticState.effectiveWait).toEqual({
			kind: "gate",
			id: activationId,
		});
		f.comm.prepare("UPDATE mailbox SET resolved_at=?").run("2026-09-14");
		f.state.close();
		f.comm.close();
		expect(
			(await collectPatrolObservations(f.input))[0].semanticState.effectiveWait,
		).toBeNull();
	});
	it("replays stage A-B-A but duplicate A heartbeat does not count", async () => {
		const f = collectorFixture();
		const [initial] = await collectPatrolObservations(f.input);
		const insert = f.state.prepare(
			"INSERT INTO session_events VALUES(?,?,?,?,?)",
		);
		insert.run(
			1,
			executionId,
			"stage_changed",
			'{"stage":"implement"}',
			"2026-09-14",
		);
		const input = { ...f.input, previous: { [executionId]: initial } };
		expect(
			(await collectPatrolObservations(input))[0].semanticTransitions,
		).toEqual([]);
		insert.run(
			2,
			executionId,
			"stage_changed",
			'{"stage":"test"}',
			"2026-09-14",
		);
		insert.run(
			3,
			executionId,
			"stage_changed",
			'{"stage":"implement"}',
			"2026-09-14",
		);
		f.state.close();
		f.comm.close();
		const [row] = await collectPatrolObservations(input);
		expect(row.eventsComplete).toBe(true);
		expect(row.semanticTransitions?.map((x) => x.state.sessionStage)).toEqual([
			"test",
			"implement",
		]);
	});
	it("marks deleted cursor anchors and malformed related events incomplete", async () => {
		const f = collectorFixture();
		f.state
			.prepare("INSERT INTO session_events VALUES(?,?,?,?,?)")
			.run(
				1,
				executionId,
				"stage_changed",
				'{"stage":"implement"}',
				"2026-09-14",
			);
		const [initial] = await collectPatrolObservations(f.input);
		f.state.exec("DELETE FROM session_events");
		const input = { ...f.input, previous: { [executionId]: initial } };
		expect((await collectPatrolObservations(input))[0].eventsComplete).toBe(
			false,
		);
		f.state
			.prepare("INSERT INTO session_events VALUES(?,?,?,?,?)")
			.run(
				1,
				executionId,
				"stage_changed",
				'{"stage":"implement"}',
				"2026-09-14",
			);
		f.state
			.prepare("INSERT INTO session_events VALUES(?,?,?,?,?)")
			.run(2, executionId, "stage_changed", "invalid", "2026-09-14");
		f.state.close();
		f.comm.close();
		expect((await collectPatrolObservations(input))[0].eventsComplete).toBe(
			false,
		);
	});
	it("probes exact fork PR ref and rejects changing PR heads", async () => {
		const f = collectorFixture();
		f.state
			.prepare("INSERT INTO workflow_node_pr_binding VALUES(?,?,?,?,?,?,?,?)")
			.run(
				runId,
				"implement",
				1,
				891,
				"__main__",
				"owner/repo",
				f.input.dbPath.replace("/state.db", ""),
				"generation-1",
			);
		f.state.close();
		f.comm.close();
		const calls: string[] = [];
		const gh = async (args: string[]) => {
			const endpoint = args.at(-1)!;
			calls.push(endpoint);
			return JSON.stringify(
				endpoint.includes("/pulls/")
					? {
							base: { repo: { full_name: "owner/repo" } },
							head: {
								repo: { full_name: "fork/repo" },
								ref: "feature/fork",
								sha: "b".repeat(40),
							},
						}
					: { object: { sha: "b".repeat(40) } },
			);
		};
		const [row] = await collectPatrolObservations({ ...f.input, gh });
		expect(row.sourcesComplete).toBe(true);
		expect(row.refs[0].repoIdentity).toBe("fork/repo");
		expect(calls).toEqual([
			"/repos/owner/repo/pulls/891",
			"/repos/fork/repo/git/ref/heads/feature%2Ffork",
			"/repos/owner/repo/pulls/891",
		]);
		let n = 0;
		const [raced] = await collectPatrolObservations({
			...f.input,
			gh: async (args) => {
				const result = JSON.parse(await gh(args));
				if (args.at(-1)?.includes("/pulls/") && ++n === 2)
					result.head.sha = "c".repeat(40);
				return JSON.stringify(result);
			},
		});
		expect(raced.sourcesComplete).toBe(false);
		expect(raced.reason).toBe("remote_ref_race");
	});
	it.each(["not-a-sha", "a".repeat(39), "a".repeat(41)])(
		"rejects malformed remote SHA %s",
		async (sha) => {
			const f = collectorFixture();
			f.state.close();
			f.comm.close();
			const [row] = await collectPatrolObservations({
				...f.input,
				gh: async () => JSON.stringify({ object: { sha } }),
			});
			expect(row.sourcesComplete).toBe(false);
		},
	);
	it("does not fallback to registry when an optional seal is corrupt", async () => {
		const f = collectorFixture();
		f.state
			.prepare(
				"UPDATE sessions SET repo_baseline_set_json=?,repo_baseline_set_digest=?",
			)
			.run('{"version":1,"repositories":[]}', "bad");
		f.state.close();
		f.comm.close();
		expect((await collectPatrolObservations(f.input))[0].sourcesComplete).toBe(
			false,
		);
	});
	it("refuses a missing workflow table rather than treating it as legacy", async () => {
		const f = collectorFixture();
		f.state.exec("DROP TABLE workflow_execution_binding");
		f.state.close();
		f.comm.close();
		expect(
			(await collectPatrolObservations(f.input))[0].ownershipComplete,
		).toBe(false);
	});
});

describe("sealed inventories and probe bounds", () => {
	it("accepts sealed root and refuses unbound nested targets without hiding root evidence", async () => {
		const f = collectorFixture();
		const baseline = {
			version: 1,
			repositories: [
				{
					relative_path: ".",
					remote_identity: "github.com/owner/repo",
					baseline_head: "a".repeat(40),
				},
			],
		};
		const seal = () =>
			f.state
				.prepare(
					"UPDATE sessions SET repo_baseline_set_json=?,repo_baseline_set_digest=?",
				)
				.run(
					canonicalJsonString(baseline),
					canonicalSubmissionDigest(baseline),
				);
		seal();
		expect((await collectPatrolObservations(f.input))[0].sourcesComplete).toBe(
			true,
		);
		baseline.repositories.push({
			relative_path: "nested",
			remote_identity: "github.com/owner/nested",
			baseline_head: "b".repeat(40),
		});
		seal();
		f.state.close();
		f.comm.close();
		const [row] = await collectPatrolObservations(f.input);
		expect(row.sourcesComplete).toBe(false);
		expect(row.reason).toBe("ref_binding_incomplete");
		expect(row.refs).toHaveLength(1);
	});
	it("uses nested exact PR without substituting registry root and rebases changed fork refs", async () => {
		const f = collectorFixture();
		f.state
			.prepare("INSERT INTO workflow_node_pr_binding VALUES(?,?,?,?,?,?,?,?)")
			.run(
				runId,
				"implement",
				1,
				12,
				"owner/nested",
				"owner/nested",
				join(f.input.dbPath.replace("/state.db", ""), "nested"),
				"generation-1",
			);
		f.state.close();
		f.comm.close();
		let headBranch = "first";
		const gh = async (args: string[]) =>
			JSON.stringify(
				args.at(-1)?.includes("/pulls/")
					? {
							base: { repo: { full_name: "owner/nested" } },
							head: {
								repo: { full_name: "fork/nested" },
								ref: headBranch,
								sha: "b".repeat(40),
							},
						}
					: { object: { sha: "b".repeat(40) } },
			);
		const [first] = await collectPatrolObservations({ ...f.input, gh });
		expect(first.sourcesComplete).toBe(true);
		expect(first.refs.map((x) => x.repoIdentity).sort()).toEqual([
			"fork/nested",
			"owner/repo",
		]);
		headBranch = "second";
		const [second] = await collectPatrolObservations({
			...f.input,
			gh,
			previous: { [executionId]: first },
		});
		expect(second.identity.repoSourceIdentity).not.toBe(
			first.identity.repoSourceIdentity,
		);
	});
	it("runs at most four remote calls and fixes host/method/argv/limits", async () => {
		const f = collectorFixture();
		const ids = [executionId];
		for (let i = 1; i < 9; i++) {
			const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
			ids.push(id);
			f.state
				.prepare(
					"INSERT INTO sessions SELECT ?,project_name,status,session_stage,worktree_binding_path,worktree_binding_branch,worktree_binding_generation,NULL,NULL FROM sessions WHERE execution_id=?",
				)
				.run(id, executionId);
			f.comm
				.prepare(
					"INSERT INTO sessions SELECT ?,project_name,lead_id,status,issue_id FROM sessions WHERE execution_id=?",
				)
				.run(id, executionId);
		}
		f.state.close();
		f.comm.close();
		let active = 0,
			max = 0;
		const rows = await collectPatrolObservations({
			...f.input,
			executionIds: ids,
			gh: async (args, opts) => {
				expect(args.slice(0, 5)).toEqual([
					"api",
					"--hostname",
					"github.com",
					"--method",
					"GET",
				]);
				expect(opts.timeout).toBeLessThanOrEqual(5000);
				expect(opts.maxBuffer).toBe(1048576);
				active++;
				max = Math.max(max, active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active--;
				return JSON.stringify({ object: { sha: "a".repeat(40) } });
			},
		});
		expect(max).toBe(4);
		expect(rows).toHaveLength(9);
		expect(rows.every((x) => x.sourcesComplete)).toBe(true);
	});
	it("fails closed on remote error and oversized output", async () => {
		const f = collectorFixture();
		f.state.close();
		f.comm.close();
		expect(
			(
				await collectPatrolObservations({
					...f.input,
					gh: async () => {
						throw new Error("HTTP 404 token must not leak");
					},
				})
			)[0].reason,
		).toBe("source_unavailable");
		expect(
			(
				await collectPatrolObservations({
					...f.input,
					gh: async () => "x".repeat(1048577),
				})
			)[0].reason,
		).toBe("remote_output_limit");
	});
});

describe("collector identity confinement", () => {
	it("rejects a bound workflow from another project", async () => {
		const f = collectorFixture();
		f.state.exec("UPDATE workflow_run SET project_name='another'");
		f.state.close();
		f.comm.close();
		expect((await collectPatrolObservations(f.input))[0].reason).toBe(
			"workflow_project_mismatch",
		);
	});
	it("rejects malformed branch paths before starting any probe", async () => {
		const f = collectorFixture();
		f.state.exec("UPDATE sessions SET worktree_binding_branch='--evil'");
		f.state.close();
		f.comm.close();
		let calls = 0;
		const [row] = await collectPatrolObservations({
			...f.input,
			gh: async () => {
				calls++;
				return "{}";
			},
		});
		expect(calls).toBe(0);
		expect(row.sourcesComplete).toBe(false);
	});
	it("checks activation/TURN changes again after all remote operations", async () => {
		const f = collectorFixture();
		const original = f.input.gh;
		const gh = async () => {
			f.comm.exec("UPDATE three_stage_turn SET epoch=2");
			return original();
		};
		const [row] = await collectPatrolObservations({ ...f.input, gh });
		f.state.close();
		f.comm.close();
		expect(row.ownershipComplete).toBe(false);
		expect(row.canAttributeRemote).toBe(false);
		expect(row.refs).toEqual([]);
	});
});

describe("workflow event coverage", () => {
	it.each(["node_reuse", "node_future_transition"])(
		"rejects unknown exact node transition %s even when endpoints match",
		async (kind) => {
			const f = collectorFixture();
			const [previous] = await collectPatrolObservations(f.input);
			f.state
				.prepare("INSERT INTO workflow_run_event VALUES(?,?,?,?,?,?,?)")
				.run(
					1,
					runId,
					"implement",
					executionId,
					kind,
					'{"attempt":1}',
					"2026-09-14",
				);
			const [row] = await collectPatrolObservations({
				...f.input,
				previous: { [executionId]: previous },
			});
			f.state.close();
			f.comm.close();
			expect(row.eventsComplete).toBe(false);
			expect(row.reason).toBe("node_event_transition_unavailable");
		},
	);
	it("retains node_output_written as verified neutral evidence", async () => {
		const f = collectorFixture();
		const [previous] = await collectPatrolObservations(f.input);
		f.state
			.prepare("INSERT INTO workflow_run_event VALUES(?,?,?,?,?,?,?)")
			.run(
				1,
				runId,
				"implement",
				executionId,
				"node_output_written",
				'{"attempt":1,"outputId":7}',
				"2026-09-14",
			);
		const [row] = await collectPatrolObservations({
			...f.input,
			previous: { [executionId]: previous },
		});
		f.state.close();
		f.comm.close();
		expect(row.eventsComplete).toBe(true);
		expect(row.semanticTransitions).toEqual([]);
		expect(row.sourceCursors.workflowEventSeq).toBe(1);
	});
	it.each(["loop_iteration", "run_reopened", "run_completed"])(
		"invalidates run-level %s without exact node identity",
		async (kind) => {
			const f = collectorFixture();
			const [previous] = await collectPatrolObservations(f.input);
			f.state
				.prepare("INSERT INTO workflow_run_event VALUES(?,?,?,?,?,?,?)")
				.run(1, runId, null, null, kind, "{}", "2026-09-14");
			const [row] = await collectPatrolObservations({
				...f.input,
				previous: { [executionId]: previous },
			});
			f.state.close();
			f.comm.close();
			expect(row.eventsComplete).toBe(false);
			expect(row.reason).toBe("run_event_transition_unavailable");
		},
	);
	it("does not treat another exact node output as this runner state evidence", async () => {
		const f = collectorFixture();
		const [previous] = await collectPatrolObservations(f.input);
		f.state
			.prepare("INSERT INTO workflow_run_event VALUES(?,?,?,?,?,?,?)")
			.run(
				1,
				runId,
				"qa",
				"33333333-3333-4333-8333-333333333333",
				"node_output_written",
				'{"attempt":1,"outputId":7}',
				"2026-09-14",
			);
		const [row] = await collectPatrolObservations({
			...f.input,
			previous: { [executionId]: previous },
		});
		f.state.close();
		f.comm.close();
		expect(row.eventsComplete).toBe(true);
		expect(row.semanticTransitions).toEqual([]);
	});
});

it("refuses undecodable relevant node output instead of using event sequence as progress", async () => {
	const f = collectorFixture();
	const [previous] = await collectPatrolObservations(f.input);
	f.state
		.prepare("INSERT INTO workflow_run_event VALUES(?,?,?,?,?,?,?)")
		.run(
			1,
			runId,
			"implement",
			executionId,
			"node_output_written",
			'{"attempt":1}',
			"2026-09-14",
		);
	const [row] = await collectPatrolObservations({
		...f.input,
		previous: { [executionId]: previous },
	});
	f.state.close();
	f.comm.close();
	expect(row.eventsComplete).toBe(false);
	expect(row.semanticTransitions).toEqual([]);
});
