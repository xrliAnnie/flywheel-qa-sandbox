import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { CustomerReleaseAccountingPump } from "../customer-release/accounting-pump.js";
import { CustomerReleaseStore } from "../customer-release/store.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanups.splice(0)) close();
});
function fixture(probe = false) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "release-accounting-")));
	mkdirSync(join(root, "mapping"));
	const directory = join(root, "mapping");
	const db = new Database(":memory:");
	cleanups.push(() => {
		db.close();
		rmSync(root, { recursive: true, force: true });
	});
	const store = new CustomerReleaseStore(db);
	store.migrate();
	const env: Record<string, string | undefined> = {};
	const fetcher = vi.fn(
		async (
			_url: string | URL | Request,
			_init?: RequestInit,
		): Promise<Response> => {
			throw new Error("unexpected network");
		},
	);
	const health = vi.fn();
	const onError = vi.fn();
	const pump = new CustomerReleaseAccountingPump({
		...(probe
			? { recordBugSourceHealth: health, bugLabel: () => "Bug", onError }
			: {}),
		store: () => store,
		projects: () => [{ projectName: "flywheel", projectRepo: "owner/repo" }],
		env,
		fetch: fetcher,
		now: () => 1000,
	});
	db.prepare(
		"INSERT INTO customer_release_activation_events VALUES (?,?,?,?,?,?)",
	).run(
		"slot:flywheel:2026-09-14",
		"flywheel",
		1,
		"cycle_slot_missed",
		JSON.stringify({ weekStart: "2026-09-14", reason: "unknown" }),
		100,
	);
	return { root, directory, db, store, env, fetcher, pump, health, onError };
}
it("keeps missing activation mapping pending without making network calls or enabling release", async () => {
	const f = fixture();
	await f.pump.tick();
	expect(f.store.accounting.pending(1000)).toHaveLength(2);
	expect(f.fetcher).not.toHaveBeenCalled();
	expect(f.store.activation.get()).toBeNull();
});
it("rejects an invalid mapping before any remote write", async () => {
	const f = fixture();
	Object.assign(f.env, {
		GH: "github-test",
		LIN: "linear-test",
		FW_CUSTOMER_RELEASE_ACCOUNTING_JSON: JSON.stringify({
			directory: f.directory,
			repositoryId: 1,
			githubWriterId: 2,
			linearWriterId: "11111111-1111-4111-8111-111111111111",
			githubTokenEnv: "GH",
			linearTokenEnv: "LIN",
		}),
	});
	writeFileSync(
		join(f.directory, "accounting.json"),
		JSON.stringify({
			schemaVersion: 1,
			activations: {
				"flywheel:epoch:1": {
					linearIssueId: "not-a-uuid",
					githubIssueNumber: 3,
					linearTeamId: "33333333-3333-4333-8333-333333333333",
					linearProjectId: "44444444-4444-4444-8444-444444444444",
				},
			},
		}),
	);
	await f.pump.tick();
	expect(f.fetcher).not.toHaveBeenCalled();
	expect(f.store.accounting.pending(31000)).toHaveLength(2);
});

it("freezes one activation target before sending and rejects a later mapping change for new events", async () => {
	const f = fixture();
	const issue = "11111111-1111-4111-8111-111111111111",
		writer = "22222222-2222-4222-8222-222222222222",
		comment = "33333333-3333-4333-8333-333333333333";
	Object.assign(f.env, {
		GH: "github-test",
		LIN: "linear-test",
		FW_CUSTOMER_RELEASE_ACCOUNTING_JSON: JSON.stringify({
			directory: f.directory,
			repositoryId: 1,
			githubWriterId: 2,
			linearWriterId: writer,
			githubTokenEnv: "GH",
			linearTokenEnv: "LIN",
		}),
	});
	const mapping = (n: number) =>
		writeFileSync(
			join(f.directory, "accounting.json"),
			JSON.stringify({
				schemaVersion: 1,
				activations: {
					"flywheel:epoch:1": {
						linearIssueId: issue,
						githubIssueNumber: n,
						linearTeamId: "33333333-3333-4333-8333-333333333333",
						linearProjectId: "44444444-4444-4444-8444-444444444444",
					},
				},
			}),
		);
	mapping(3);
	let githubBody = "",
		linearBody = "";
	f.fetcher.mockImplementation(async (url, init) => {
		const u = String(url);
		if (u === "https://api.linear.app/graphql") {
			const { query, variables } = JSON.parse(String(init?.body));
			if (query.includes("ReleaseAuditComments"))
				return Response.json({
					data: {
						issue: {
							id: issue,
							comments: {
								nodes: linearBody ? [{ id: comment, body: linearBody }] : [],
								pageInfo: { hasNextPage: false, endCursor: null },
							},
						},
					},
				});
			if (query.includes("ReleaseAuditIssue"))
				return Response.json({ data: { issue: { id: issue } } });
			if (query.includes("ReleaseAuditWriter"))
				return Response.json({ data: { viewer: { id: writer } } });
			if (query.includes("ReleaseAuditCreate")) {
				linearBody = variables.input.body;
				return Response.json({
					data: { commentCreate: { success: true, comment: { id: comment } } },
				});
			}
			if (query.includes("ReleaseAuditComment"))
				return Response.json({
					data: {
						comment: {
							id: comment,
							body: linearBody,
							issue: { id: issue },
							user: { id: writer },
						},
					},
				});
		}
		if (u.endsWith("/repos/owner/repo")) return Response.json({ id: 1 });
		if (u.endsWith("/issues/3")) return Response.json({ number: 3 });
		if (u.endsWith("/user")) return Response.json({ id: 2 });
		if (u.includes("comments?"))
			return Response.json(githubBody ? [{ id: 9, body: githubBody }] : []);
		if (u.endsWith("/issues/3/comments")) {
			githubBody = JSON.parse(String(init?.body)).body;
			return Response.json({ id: 9 });
		}
		if (u.endsWith("/issues/comments/9"))
			return Response.json({
				id: 9,
				body: githubBody,
				user: { id: 2 },
				issue_url: "https://api.github.com/repos/owner/repo/issues/3",
			});
		throw new Error("unexpected request");
	});
	await f.pump.tick();
	expect(
		f.store.accounting.status("activation:slot:flywheel:2026-09-14", "linear")
			?.state,
	).toBe("delivered");
	expect(
		f.store.accounting.status("activation:slot:flywheel:2026-09-14", "github")
			?.state,
	).toBe("delivered");
	const before = f.fetcher.mock.calls.length;
	mapping(4);
	await f.pump.tick();
	expect(f.fetcher).toHaveBeenCalledTimes(before);
	const row = f.db
		.prepare(
			"SELECT payload_json AS payload FROM customer_release_activation_events WHERE kind='accounting_target_bound'",
		)
		.get() as { payload: string };
	expect(JSON.parse(row.payload).githubIssueNumber).toBe(3);
	expect(row.payload).not.toContain("github-test");
	expect(
		f.store.accounting.status("activation:accounting-target:1", "github")
			?.state,
	).toBe("pending");
});

it("shutdown aborts outstanding reads before any external create and leaves the source pending", async () => {
	const f = fixture();
	Object.assign(f.env, {
		GH: "github-test",
		LIN: "linear-test",
		FW_CUSTOMER_RELEASE_ACCOUNTING_JSON: JSON.stringify({
			directory: f.directory,
			repositoryId: 1,
			githubWriterId: 2,
			linearWriterId: "22222222-2222-4222-8222-222222222222",
			githubTokenEnv: "GH",
			linearTokenEnv: "LIN",
		}),
	});
	writeFileSync(
		join(f.directory, "accounting.json"),
		JSON.stringify({
			schemaVersion: 1,
			activations: {
				"flywheel:epoch:1": {
					linearIssueId: "11111111-1111-4111-8111-111111111111",
					githubIssueNumber: 3,
					linearTeamId: "33333333-3333-4333-8333-333333333333",
					linearProjectId: "44444444-4444-4444-8444-444444444444",
				},
			},
		}),
	);
	f.fetcher.mockImplementation(
		async (_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				init!.signal!.addEventListener(
					"abort",
					() => reject(new Error("aborted")),
					{ once: true },
				);
			}),
	);
	const flight = f.pump.tick();
	expect(f.fetcher).toHaveBeenCalledTimes(2);
	await f.pump.stop();
	await flight;
	expect(f.fetcher.mock.calls.every(([, init]) => init!.signal!.aborted)).toBe(
		true,
	);
	expect(
		f.store.accounting.status("activation:slot:flywheel:2026-09-14", "github")
			?.createStarted,
	).toBe(0);
	expect(
		f.store.accounting.status("activation:slot:flywheel:2026-09-14", "linear")
			?.state,
	).toBe("pending");
});

it.each([
	"ok",
	"null",
	"error",
	"wrong-team",
	"wrong-project",
	"no-label",
	"epoch-changed",
	"mapping-changed",
])(
	"only the activation-bound probe records Bug-source health: %s",
	async (outcome) => {
		const f = fixture(true);
		vi.spyOn(f.store.activation, "get").mockReturnValue({
			epoch: 1,
		} as ReturnType<typeof f.store.activation.get>);
		Object.assign(f.env, {
			GH: "github-test",
			LIN: "linear-test",
			FW_CUSTOMER_RELEASE_ACCOUNTING_JSON: JSON.stringify({
				directory: f.directory,
				repositoryId: 1,
				githubWriterId: 2,
				linearWriterId: "11111111-1111-4111-8111-111111111111",
				githubTokenEnv: "GH",
				linearTokenEnv: "LIN",
			}),
		});
		const mapping = {
			linearIssueId: "22222222-2222-4222-8222-222222222222",
			githubIssueNumber: 3,
			linearTeamId: "33333333-3333-4333-8333-333333333333",
			linearProjectId: "44444444-4444-4444-8444-444444444444",
		};
		writeFileSync(
			join(f.directory, "accounting.json"),
			JSON.stringify({
				schemaVersion: 1,
				activations: { "flywheel:epoch:1": mapping },
			}),
		);
		f.fetcher.mockImplementation(async (_url, init) => {
			const { query, variables } = JSON.parse(String(init?.body));
			if (!query.includes("ReleaseBugSourceProbe"))
				throw Error("audit transport offline");
			expect(variables.id).toBe(mapping.linearIssueId);
			expect(variables.filter.team.id.eq).toBe(mapping.linearTeamId);
			if (outcome === "error") throw Error("probe offline");
			if (outcome === "epoch-changed")
				vi.mocked(f.store.activation.get).mockReturnValue({
					epoch: 2,
				} as ReturnType<typeof f.store.activation.get>);
			if (outcome === "mapping-changed")
				writeFileSync(
					join(f.directory, "accounting.json"),
					JSON.stringify({
						schemaVersion: 1,
						activations: {
							"flywheel:epoch:1": {
								...mapping,
								linearProjectId: "55555555-5555-4555-8555-555555555555",
							},
						},
					}),
				);
			return Response.json({
				data: {
					issue:
						outcome === "null"
							? null
							: {
									id: mapping.linearIssueId,
									team: {
										id:
											outcome === "wrong-team" ? "other" : mapping.linearTeamId,
									},
									project: {
										id:
											outcome === "wrong-project"
												? "other"
												: mapping.linearProjectId,
									},
								},
					issueLabels: {
						nodes:
							outcome === "no-label"
								? []
								: [
										{
											id: "label",
											name: "Bug",
											team: { id: mapping.linearTeamId },
										},
									],
					},
				},
			});
		});
		await f.pump.tick();
		if (outcome.endsWith("-changed")) {
			expect(f.health).not.toHaveBeenCalled();
			return;
		}
		expect(f.health).toHaveBeenCalledOnce();
		expect(f.health).toHaveBeenCalledWith(
			expect.objectContaining({
				activationEpoch: 1,
				label: "Bug",
				ok: outcome === "ok",
			}),
		);
	},
);
it("missing canonical team/project mapping is accounting_pending and health-neutral", async () => {
	const f = fixture(true);
	vi.spyOn(f.store.activation, "get").mockReturnValue({
		epoch: 1,
	} as ReturnType<typeof f.store.activation.get>);
	await f.pump.tick();
	expect(f.health).not.toHaveBeenCalled();
	expect(f.fetcher).not.toHaveBeenCalled();
	expect(f.onError).toHaveBeenCalledWith("accounting_pending");
});
