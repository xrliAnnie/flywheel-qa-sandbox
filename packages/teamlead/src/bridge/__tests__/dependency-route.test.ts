import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { epicShapeSnapshot } from "../../epic-page/__tests__/fixtures/epic-shape.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import {
	buildLedgerComment,
	parseLedgerComment,
} from "../dependency-ledger-comment.js";
import {
	createDependencyRouter,
	type DependencyRouterDeps,
	masterOnlyAuthMiddleware,
	walkBlockers,
} from "../dependency-route.js";
import type { LinearIssue } from "../linear-query.js";

const OPERATION_ID = "40b90faf-8d07-4a26-8109-145a61819a4f";
const SECOND_OPERATION_ID = "19ba3767-9bd3-433f-b73f-4bf761c08d69";
const projects: ProjectEntry[] = [
	{
		projectName: "example",
		projectRoot: "/tmp/example",
		leads: [],
		linear: { team: "EPX", project: "Example", label: "Scope" },
	},
];

function issue(identifier: string, id: string): LinearIssue {
	return {
		id,
		identifier,
		title: identifier,
		description: null,
		priority: 0,
		priorityLabel: "No priority",
		state: "Todo",
		stateType: "unstarted",
		labels: [],
		assignee: null,
		project: identifier.startsWith("EPX-") ? "Example" : "External",
		url: `https://linear.app/example/issue/${identifier}`,
		createdAt: "2026-09-04T08:00:00.000Z",
		updatedAt: "2026-09-04T08:00:00.000Z",
	};
}

function deps(
	overrides: Partial<DependencyRouterDeps> = {},
): DependencyRouterDeps {
	let relationCreated = false;
	return {
		projects,
		linearApiKey: "linear-key",
		lookup: vi.fn(async (identifier) =>
			identifier === "GEO-9"
				? issue("GEO-9", "blocker-uuid")
				: identifier === "EPX-2"
					? issue("EPX-2", "child-uuid-2")
					: null,
		),
		fetchSnapshot: vi.fn(async () => epicShapeSnapshot()),
		listBlockedBy: vi.fn(async (issueId) => ({
			relations:
				issueId === "child-uuid-2" && relationCreated
					? [
							{
								id: OPERATION_ID,
								type: "blocks",
								issue: { id: "blocker-uuid", identifier: "GEO-9" },
							},
						]
					: [],
			hasNextPage: false,
			endCursor: null,
		})),
		createRelation: vi.fn(async ({ id }) => {
			relationCreated = true;
			return { success: true, relation: { id: id ?? "server-relation" } };
		}),
		deleteRelation: vi.fn(async () => ({ success: true })),
		createComment: vi.fn(async () => ({
			success: true,
			comment: {
				id: "comment-1",
				url: "https://linear.app/example/issue/EPX-2#comment-comment-1",
			},
		})),
		listHistory: vi.fn(async () => ({
			entries: [],
			hasNextPage: false,
			endCursor: null,
		})),
		listComments: vi.fn(async () => ({
			comments: [],
			hasNextPage: false,
			endCursor: null,
		})),
		now: () => new Date("2026-09-04T08:30:00.000Z"),
		logger: vi.fn(),
		relationIdMode: "client",
		...overrides,
	};
}

function app(
	options: {
		masterToken?: string;
		scopedToken?: string;
		deps?: Partial<DependencyRouterDeps>;
	} = {},
): express.Application {
	const application = express();
	application.use(express.json());
	application.use(
		"/api/dependency",
		masterOnlyAuthMiddleware(
			options.masterToken === undefined ? "master" : options.masterToken,
			options.scopedToken ?? "scoped",
		),
		createDependencyRouter(deps(options.deps)),
	);
	return application;
}

async function request(
	application: express.Application,
	path: string,
	options: { token?: string; method?: string; body?: unknown } = {},
) {
	const server = createServer(application);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const response = await fetch(
			`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
			{
				method: options.method ?? "POST",
				headers: {
					...(options.token
						? { authorization: `Bearer ${options.token}` }
						: {}),
					...(options.body !== undefined
						? { "content-type": "application/json" }
						: {}),
				},
				...(options.body !== undefined
					? { body: JSON.stringify(options.body) }
					: {}),
			},
		);
		return {
			status: response.status,
			body: (await response.json()) as Record<string, unknown>,
		};
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

function addBody(overrides: Record<string, unknown> = {}) {
	return {
		projectName: "example",
		blocker: "GEO-9",
		blocked: "EPX-2",
		reason: "missed external prerequisite",
		operation_id: OPERATION_ID,
		claimed_actor: "flywheel-eng-lead",
		...overrides,
	};
}

function removeBody(overrides: Record<string, unknown> = {}) {
	return addBody(overrides);
}

function noteBody(overrides: Record<string, unknown> = {}) {
	return {
		...addBody(),
		kind: "missed",
		action: "added",
		...overrides,
	};
}

describe("dependency route", () => {
	it("fails closed without a master token and distinguishes scoped credentials", async () => {
		expect(
			(
				await request(app({ masterToken: "" }), "/api/dependency/add", {
					body: addBody(),
				})
			).status,
		).toBe(503);
		expect(
			(
				await request(app(), "/api/dependency/add", {
					token: "scoped",
					body: addBody(),
				})
			).status,
		).toBe(403);
		expect(
			(await request(app(), "/api/dependency/add", { body: addBody() })).status,
		).toBe(401);
	});

	it("adds an external blocker to a label-less active-scope child", async () => {
		const onEpicChange = vi.fn();
		const routeDeps = deps({ onEpicChange });
		const response = await request(
			app({ deps: routeDeps }),
			"/api/dependency/add",
			{ token: "master", body: addBody() },
		);

		expect(response).toMatchObject({
			status: 200,
			body: {
				ok: true,
				status: "added",
				kind: "missed",
				operation_id: OPERATION_ID,
				relation_id: OPERATION_ID,
				ledger: { ok: true, recorded: "now" },
				post_write_check: { cycle: false },
			},
		});
		expect(routeDeps.createRelation).toHaveBeenCalledWith({
			id: OPERATION_ID,
			blockerId: "blocker-uuid",
			blockedId: "child-uuid-2",
		});
		expect(routeDeps.createComment).toHaveBeenCalledOnce();
		expect(onEpicChange).toHaveBeenCalledOnce();
		expect(onEpicChange).toHaveBeenCalledWith("example", "dependency_changed");
	});

	it("allows dependency writes and log reads for a Backlog descendant", async () => {
		let relationPresent = false;
		const routeDeps = deps({
			lookup: vi.fn(async (identifier) =>
				identifier === "GEO-9"
					? issue("GEO-9", "blocker-uuid")
					: identifier === "EPX-2"
						? {
								...issue("EPX-2", "child-uuid-2"),
								state: "Backlog",
								stateType: "backlog",
							}
						: null,
			),
			fetchSnapshot: vi.fn(async () => ({
				...epicShapeSnapshot(),
				items: [],
				descendantIds: ["child-uuid-2"],
			})),
			listBlockedBy: vi.fn(async (issueId) => ({
				relations:
					issueId === "child-uuid-2" && relationPresent
						? [
								{
									id: OPERATION_ID,
									type: "blocks",
									issue: { id: "blocker-uuid", identifier: "GEO-9" },
								},
							]
						: [],
				hasNextPage: false,
				endCursor: null,
			})),
			createRelation: vi.fn(async ({ id }) => {
				relationPresent = true;
				return { success: true, relation: { id: id ?? "server-relation" } };
			}),
			deleteRelation: vi.fn(async () => {
				relationPresent = false;
				return { success: true };
			}),
		});
		const application = app({ deps: routeDeps });

		expect(
			(
				await request(application, "/api/dependency/add", {
					token: "master",
					body: addBody(),
				})
			).status,
		).toBe(200);
		expect(
			(
				await request(application, "/api/dependency/remove", {
					token: "master",
					body: removeBody({ operation_id: SECOND_OPERATION_ID }),
				})
			).status,
		).toBe(200);
		expect(
			(
				await request(application, "/api/dependency/note", {
					token: "master",
					body: noteBody({
						operation_id: SECOND_OPERATION_ID,
						kind: "not_needed",
						action: "removed",
					}),
				})
			).status,
		).toBe(200);
		expect(
			(
				await request(
					application,
					"/api/dependency/log?projectName=example&issue=EPX-2",
					{ token: "master", method: "GET" },
				)
			).status,
		).toBe(200);
	});

	it("records discovered edges with their parent operation", async () => {
		const parentOperation = "19ba3767-9bd3-433f-b73f-4bf761c08d69";
		const routeDeps = deps();
		const response = await request(
			app({ deps: routeDeps }),
			"/api/dependency/add",
			{
				token: "master",
				body: addBody({ kind: "discovered", parent_op: parentOperation }),
			},
		);
		expect(response).toMatchObject({
			status: 200,
			body: { kind: "discovered", parent_op: parentOperation },
		});
		const comment =
			vi.mocked(routeDeps.createComment!).mock.calls[0]?.[1] ?? "";
		expect(parseLedgerComment(comment)).toMatchObject({
			kind: "discovered",
			action: "added",
			parent_op: parentOperation,
		});
	});

	it.each([
		[{ projectName: undefined }, 400, "project_required"],
		[{ projectName: "missing" }, 404, "unknown_project"],
		[{ blocker: "bad" }, 400, "invalid_identifier"],
		[{ blocked: "bad" }, 400, "invalid_identifier"],
		[{ reason: "" }, 400, "invalid_reason"],
		[{ reason: "bad\u0000reason" }, 400, "invalid_reason"],
		[{ operation_id: "not-a-uuid" }, 400, "invalid_operation_id"],
		[{ claimed_actor: "UPPER" }, 400, "invalid_actor"],
		[{ kind: "missed" }, 400, "invalid_kind"],
		[{ parent_op: OPERATION_ID }, 400, "invalid_parent_op"],
		[{ kind: "discovered" }, 400, "invalid_parent_op"],
		[{ kind: "discovered", parent_op: "not-a-uuid" }, 400, "invalid_parent_op"],
		[{ blocker: "EPX-2" }, 400, "self_dependency"],
		[{ extra: true }, 400, "unsupported_option"],
	] as const)(
		"rejects invalid add input %#",
		async (override, status, error) => {
			const routeDeps = deps();
			const response = await request(
				app({ deps: routeDeps }),
				"/api/dependency/add",
				{ token: "master", body: addBody(override) },
			);
			expect(response).toMatchObject({ status, body: { error } });
			expect(routeDeps.createRelation).not.toHaveBeenCalled();
			expect(routeDeps.deleteRelation).not.toHaveBeenCalled();
			expect(routeDeps.createComment).not.toHaveBeenCalled();
		},
	);

	it("rejects missing Linear configuration before any lookup", async () => {
		const routeDeps = deps({ linearApiKey: undefined });
		const response = await request(
			app({ deps: routeDeps }),
			"/api/dependency/add",
			{ token: "master", body: addBody() },
		);
		expect(response).toMatchObject({
			status: 501,
			body: { error: "linear_not_configured" },
		});
		expect(routeDeps.lookup).not.toHaveBeenCalled();
	});

	it.each([
		["GEO-9", "blocker"],
		["EPX-2", "blocked"],
	] as const)("reports a missing %s issue", async (missing, which) => {
		const routeDeps = deps({
			lookup: vi.fn(async (identifier) =>
				identifier === missing
					? null
					: identifier === "GEO-9"
						? issue("GEO-9", "blocker-uuid")
						: issue("EPX-2", "child-uuid-2"),
			),
		});
		const response = await request(
			app({ deps: routeDeps }),
			"/api/dependency/add",
			{ token: "master", body: addBody() },
		);
		expect(response).toMatchObject({
			status: 404,
			body: { error: "issue_not_found", which },
		});
		expect(routeDeps.createRelation).not.toHaveBeenCalled();
	});

	it("rejects a blocked issue outside the current page scope", async () => {
		const onEpicChange = vi.fn();
		const routeDeps = deps({
			onEpicChange,
			fetchSnapshot: vi.fn(async () => ({
				...epicShapeSnapshot(),
				items: [],
				descendantIds: [],
			})),
		});
		const response = await request(
			app({ deps: routeDeps }),
			"/api/dependency/add",
			{ token: "master", body: addBody() },
		);
		expect(response).toMatchObject({
			status: 403,
			body: { error: "issue_outside_project", which: "blocked" },
		});
		expect(routeDeps.createRelation).not.toHaveBeenCalled();
		expect(onEpicChange).not.toHaveBeenCalled();
	});

	it("rejects a visible cycle and an unbounded traversal without writing", async () => {
		for (const expected of ["dependency_cycle", "cycle_check_unbounded"]) {
			const routeDeps = deps({
				listBlockedBy: vi.fn(async (issueId) => ({
					relations:
						issueId === "blocker-uuid" && expected === "dependency_cycle"
							? [
									{
										id: "reverse-edge",
										type: "blocks",
										issue: {
											id: "child-uuid-2",
											identifier: "EPX-2",
										},
									},
								]
							: [],
					hasNextPage:
						issueId === "blocker-uuid" && expected === "cycle_check_unbounded",
					endCursor: null,
				})),
			});
			const response = await request(
				app({ deps: routeDeps }),
				"/api/dependency/add",
				{ token: "master", body: addBody() },
			);
			expect(response).toMatchObject({
				status: expected === "dependency_cycle" ? 409 : 422,
				body: { error: expected },
			});
			if (expected === "dependency_cycle") {
				expect(response.body.path).toEqual(["EPX-2", "GEO-9"]);
			}
			expect(routeDeps.createRelation).not.toHaveBeenCalled();
			expect(routeDeps.createComment).not.toHaveBeenCalled();
		}
	});

	it("replays this operation idempotently and refuses a conflicting payload", async () => {
		const onEpicChange = vi.fn();
		const recorded = buildLedgerComment({
			v: 1,
			op: OPERATION_ID,
			parent_op: null,
			relation_id: OPERATION_ID,
			evidence: "mutation",
			kind: "missed",
			action: "added",
			blocker: "GEO-9",
			blocked: "EPX-2",
			claimed_actor: "flywheel-eng-lead",
			at: "2026-09-04T08:00:00.000Z",
			reason: "missed external prerequisite",
		});
		const listComments = vi.fn(async () => ({
			comments: [
				{
					id: "comment-1",
					body: recorded,
					createdAt: "2026-09-04T08:00:00.000Z",
				},
			],
			hasNextPage: false,
			endCursor: null,
		}));
		const existingRelation = vi.fn(async (issueId: string) => ({
			relations:
				issueId === "child-uuid-2"
					? [
							{
								id: OPERATION_ID,
								type: "blocks",
								issue: { id: "blocker-uuid", identifier: "GEO-9" },
							},
						]
					: [],
			hasNextPage: false,
			endCursor: null,
		}));
		const routeDeps = deps({
			listComments,
			listBlockedBy: existingRelation,
			onEpicChange,
		});

		const replay = await request(
			app({ deps: routeDeps }),
			"/api/dependency/add",
			{ token: "master", body: addBody() },
		);
		expect(replay).toMatchObject({
			status: 200,
			body: {
				status: "already_exists",
				attribution: "this_operation",
				ledger: { ok: true, recorded: "already" },
			},
		});
		expect(routeDeps.createRelation).not.toHaveBeenCalled();
		expect(onEpicChange).not.toHaveBeenCalled();
		expect(routeDeps.createComment).not.toHaveBeenCalled();

		const conflict = await request(
			app({ deps: routeDeps }),
			"/api/dependency/add",
			{
				token: "master",
				body: addBody({ reason: "different intent" }),
			},
		);
		expect(conflict).toMatchObject({
			status: 409,
			body: { error: "operation_id_conflict" },
		});
		expect(routeDeps.createRelation).not.toHaveBeenCalled();
	});

	it("does not claim a relation created by someone else", async () => {
		const routeDeps = deps({
			listBlockedBy: vi.fn(async (issueId) => ({
				relations:
					issueId === "child-uuid-2"
						? [
								{
									id: "foreign-relation",
									type: "blocks",
									issue: { id: "blocker-uuid", identifier: "GEO-9" },
								},
							]
						: [],
				hasNextPage: false,
				endCursor: null,
			})),
		});
		const response = await request(
			app({ deps: routeDeps }),
			"/api/dependency/add",
			{ token: "master", body: addBody() },
		);
		expect(response).toMatchObject({
			status: 200,
			body: {
				status: "already_exists",
				attribution: "foreign",
				ledger: { ok: false, skipped: "foreign_relation" },
			},
		});
		expect(routeDeps.createComment).not.toHaveBeenCalled();
	});

	it.each([
		[
			"throw",
			vi.fn(async () => {
				throw new Error("secret upstream text");
			}),
		],
		["success false", vi.fn(async () => ({ success: false }))],
		["missing relation", vi.fn(async () => ({ success: true }))],
		[
			"wrong client id",
			vi.fn(async () => ({
				success: true,
				relation: { id: "different-relation" },
			})),
		],
	] as const)(
		"does not record an unconfirmed %s mutation",
		async (_name, create) => {
			const routeDeps = deps({ createRelation: create });
			const response = await request(
				app({ deps: routeDeps }),
				"/api/dependency/add",
				{ token: "master", body: addBody() },
			);
			expect(response).toMatchObject({
				status: 502,
				body: { error: "linear_write_unconfirmed" },
			});
			expect(routeDeps.createComment).not.toHaveBeenCalled();
			expect(JSON.stringify(response)).not.toContain("secret upstream text");
		},
	);

	it("classifies a throwing relation payload getter without leaking it", async () => {
		const createRelation = vi.fn(async () =>
			Object.defineProperty({ success: true }, "relation", {
				get() {
					throw new Error("private getter text");
				},
			}),
		);
		const routeDeps = deps({ createRelation });
		const response = await request(
			app({ deps: routeDeps }),
			"/api/dependency/add",
			{ token: "master", body: addBody() },
		);
		expect(response).toMatchObject({
			status: 502,
			body: { error: "linear_write_unconfirmed" },
		});
		expect(JSON.stringify(response)).not.toContain("private getter text");
		expect(routeDeps.createComment).not.toHaveBeenCalled();
	});

	it("requires a fresh paginated relation read to fit before writing", async () => {
		const routeDeps = deps({
			listBlockedBy: vi.fn(async (issueId) => ({
				relations: [],
				hasNextPage: issueId === "child-uuid-2",
				endCursor: null,
			})),
		});
		const response = await request(
			app({ deps: routeDeps }),
			"/api/dependency/add",
			{ token: "master", body: addBody() },
		);
		expect(response).toMatchObject({
			status: 422,
			body: { error: "relations_truncated" },
		});
		expect(routeDeps.createRelation).not.toHaveBeenCalled();
	});

	it("returns repair-required ledger state after a confirmed relation write", async () => {
		const routeDeps = deps({
			createComment: vi.fn(async () => ({ success: false })),
		});
		const response = await request(
			app({ deps: routeDeps }),
			"/api/dependency/add",
			{ token: "master", body: addBody() },
		);
		expect(response).toMatchObject({
			status: 200,
			body: {
				relation_id: OPERATION_ID,
				ledger: { ok: false, error: "ledger_unrecorded" },
			},
		});
	});

	it("marks a truncated idempotency scan without dropping the ledger write", async () => {
		const listComments = vi.fn(async () => ({
			comments: [],
			hasNextPage: true,
			endCursor: "next",
		}));
		const routeDeps = deps({ listComments });
		const response = await request(
			app({ deps: routeDeps }),
			"/api/dependency/add",
			{ token: "master", body: addBody() },
		);
		expect(listComments).toHaveBeenCalledTimes(10);
		expect(response).toMatchObject({
			status: 200,
			body: {
				ledger: { ok: true, recorded: "now", scan_truncated: true },
			},
		});
	});

	it.each([
		["cycle", { cycle: true }],
		["unbounded", { cycle: null }],
	] as const)(
		"reports a post-write %s without rollback",
		async (_name, expected) => {
			let created = false;
			const createRelation = vi.fn(async () => {
				created = true;
				return { success: true, relation: { id: OPERATION_ID } };
			});
			const listBlockedBy = vi.fn(async (issueId: string) => ({
				relations:
					issueId === "child-uuid-2" && created
						? [
								{
									id: OPERATION_ID,
									type: "blocks",
									issue: { id: "blocker-uuid", identifier: "GEO-9" },
								},
							]
						: issueId === "blocker-uuid" && created && _name === "cycle"
							? [
									{
										id: "raced-reverse",
										type: "blocks",
										issue: {
											id: "child-uuid-2",
											identifier: "EPX-2",
										},
									},
								]
							: [],
				hasNextPage:
					issueId === "blocker-uuid" && created && _name === "unbounded",
				endCursor: null,
			}));
			const routeDeps = deps({ createRelation, listBlockedBy });
			const response = await request(
				app({ deps: routeDeps }),
				"/api/dependency/add",
				{ token: "master", body: addBody() },
			);
			expect(response).toMatchObject({
				status: 200,
				body: { post_write_check: expected },
			});
			expect(routeDeps.deleteRelation).not.toHaveBeenCalled();
		},
	);

	it("supports the server-generated relation id fallback", async () => {
		let created = false;
		const createRelation = vi.fn(async (input) => {
			created = true;
			expect(input).not.toHaveProperty("id");
			return { success: true, relation: { id: "server-relation" } };
		});
		const routeDeps = deps({
			relationIdMode: "server",
			createRelation,
			listBlockedBy: vi.fn(async (issueId) => ({
				relations:
					issueId === "child-uuid-2" && created
						? [
								{
									id: "server-relation",
									type: "blocks",
									issue: { id: "blocker-uuid", identifier: "GEO-9" },
								},
							]
						: [],
				hasNextPage: false,
				endCursor: null,
			})),
		});
		const response = await request(
			app({ deps: routeDeps }),
			"/api/dependency/add",
			{ token: "master", body: addBody() },
		);
		expect(response).toMatchObject({
			status: 200,
			body: { status: "added", relation_id: "server-relation" },
		});
	});

	it("does not claim an edge that appears between preflight and mutation", async () => {
		let blockedReads = 0;
		const routeDeps = deps({
			listBlockedBy: vi.fn(async (issueId) => {
				if (issueId === "child-uuid-2") blockedReads += 1;
				return {
					relations:
						issueId === "child-uuid-2" && blockedReads >= 2
							? [
									{
										id: "foreign-race",
										type: "blocks",
										issue: {
											id: "blocker-uuid",
											identifier: "GEO-9",
										},
									},
								]
							: [],
					hasNextPage: false,
					endCursor: null,
				};
			}),
		});
		const response = await request(
			app({ deps: routeDeps }),
			"/api/dependency/add",
			{ token: "master", body: addBody() },
		);
		expect(response).toMatchObject({
			status: 200,
			body: {
				status: "already_exists",
				attribution: "foreign",
				ledger: { ok: false, skipped: "foreign_relation" },
			},
		});
		expect(routeDeps.createRelation).not.toHaveBeenCalled();
		expect(routeDeps.createComment).not.toHaveBeenCalled();
	});

	it("does not record a relation absent from the post-mutation fresh read", async () => {
		const routeDeps = deps({
			createRelation: vi.fn(async () => ({
				success: true,
				relation: { id: OPERATION_ID },
			})),
			listBlockedBy: vi.fn(async () => ({
				relations: [],
				hasNextPage: false,
				endCursor: null,
			})),
		});
		const response = await request(
			app({ deps: routeDeps }),
			"/api/dependency/add",
			{ token: "master", body: addBody() },
		);
		expect(response).toMatchObject({
			status: 502,
			body: { error: "linear_write_unconfirmed" },
		});
		expect(routeDeps.createComment).not.toHaveBeenCalled();
	});

	it("bounds expanded blocker traversal at 200 workspace issues", async () => {
		const listBlockedBy = vi.fn(async (id: string) => {
			const index = Number(id.slice("node-".length));
			return {
				relations:
					index < 200
						? [
								{
									id: `relation-${index}`,
									type: "blocks",
									issue: {
										id: `node-${index + 1}`,
										identifier: `N-${index + 2}`,
									},
								},
							]
						: [],
				hasNextPage: false,
				endCursor: null,
			};
		});
		expect(
			await walkBlockers(
				listBlockedBy,
				{ id: "node-0", identifier: "N-1" },
				{ id: "target", identifier: "T-1" },
			),
		).toEqual({ cycle: null, reason: "unbounded" });
		expect(listBlockedBy).toHaveBeenCalledTimes(200);
	});

	it("serializes mutations for the same project", async () => {
		const secondOperation = "19ba3767-9bd3-433f-b73f-4bf761c08d69";
		const relationByBlocked = new Map<string, string>();
		let active = 0;
		let maxActive = 0;
		const routeDeps = deps({
			lookup: vi.fn(async (identifier) =>
				identifier === "GEO-9"
					? issue("GEO-9", "blocker-uuid")
					: identifier === "EPX-2"
						? issue("EPX-2", "child-uuid-2")
						: identifier === "EPX-3"
							? issue("EPX-3", "child-uuid-3")
							: null,
			),
			listBlockedBy: vi.fn(async (issueId) => ({
				relations: relationByBlocked.has(issueId)
					? [
							{
								id: relationByBlocked.get(issueId)!,
								type: "blocks",
								issue: { id: "blocker-uuid", identifier: "GEO-9" },
							},
						]
					: [],
				hasNextPage: false,
				endCursor: null,
			})),
			createRelation: vi.fn(async ({ id, blockedId }) => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 10));
				relationByBlocked.set(blockedId, id!);
				active -= 1;
				return { success: true, relation: { id: id! } };
			}),
		});
		const application = app({ deps: routeDeps });
		const responses = await Promise.all([
			request(application, "/api/dependency/add", {
				token: "master",
				body: addBody(),
			}),
			request(application, "/api/dependency/add", {
				token: "master",
				body: addBody({
					blocked: "EPX-3",
					operation_id: secondOperation,
				}),
			}),
		]);
		expect(responses.map(({ status }) => status)).toEqual([200, 200]);
		expect(maxActive).toBe(1);
	});

	it("bounds relation, deletion, and comment writes by the configured deadline", async () => {
		let added = false;
		let addedRelationId = OPERATION_ID;
		const createRelation = vi
			.fn()
			.mockImplementationOnce(async ({ id }) => {
				await new Promise((resolve) => setTimeout(resolve, 40));
				return { success: true, relation: { id: id ?? "server-relation" } };
			})
			.mockImplementationOnce(async ({ id }) => {
				added = true;
				addedRelationId = id ?? "server-relation";
				return { success: true, relation: { id: id ?? "server-relation" } };
			});
		const slowAdd = deps({
			writeDeadlineMs: 5,
			listBlockedBy: vi.fn(async (issueId) => ({
				relations:
					issueId === "child-uuid-2" && added
						? [
								{
									id: addedRelationId,
									type: "blocks",
									issue: { id: "blocker-uuid", identifier: "GEO-9" },
								},
							]
						: [],
				hasNextPage: false,
				endCursor: null,
			})),
			createRelation,
		});
		const slowAddApplication = app({ deps: slowAdd });
		expect(
			(
				await request(slowAddApplication, "/api/dependency/add", {
					token: "master",
					body: addBody(),
				})
			).status,
		).toBe(502);
		expect(
			(
				await request(slowAddApplication, "/api/dependency/add", {
					token: "master",
					body: addBody({ operation_id: SECOND_OPERATION_ID }),
				})
			).status,
		).toBe(200);

		let relationPresent = true;
		const slowRemove = deps({
			writeDeadlineMs: 5,
			listBlockedBy: vi.fn(async (issueId) => ({
				relations:
					issueId === "child-uuid-2" && relationPresent
						? [
								{
									id: OPERATION_ID,
									type: "blocks",
									issue: { id: "blocker-uuid", identifier: "GEO-9" },
								},
							]
						: [],
				hasNextPage: false,
				endCursor: null,
			})),
			deleteRelation: vi.fn(async () => {
				await new Promise((resolve) => setTimeout(resolve, 40));
				relationPresent = false;
				return { success: true };
			}),
		});
		expect(
			(
				await request(app({ deps: slowRemove }), "/api/dependency/remove", {
					token: "master",
					body: removeBody(),
				})
			).status,
		).toBe(502);

		const slowComment = deps({
			writeDeadlineMs: 5,
			listBlockedBy: vi.fn(async (issueId) => ({
				relations:
					issueId === "child-uuid-2"
						? [
								{
									id: OPERATION_ID,
									type: "blocks",
									issue: { id: "blocker-uuid", identifier: "GEO-9" },
								},
							]
						: [],
				hasNextPage: false,
				endCursor: null,
			})),
			createComment: vi.fn(async () => {
				await new Promise((resolve) => setTimeout(resolve, 40));
				return { success: true, comment: { id: "comment-slow" } };
			}),
		});
		const commentResponse = await request(
			app({ deps: slowComment }),
			"/api/dependency/add",
			{ token: "master", body: addBody() },
		);
		expect(commentResponse).toMatchObject({
			status: 200,
			body: { ledger: { ok: false, error: "ledger_unrecorded" } },
		});
	});

	it("removes an external blocker from a visible child and records not_needed", async () => {
		const onEpicChange = vi.fn();
		let exists = true;
		const listBlockedBy = vi.fn(async (issueId: string) => ({
			relations:
				issueId === "child-uuid-2" && exists
					? [
							{
								id: "relation-1",
								type: "blocks",
								issue: { id: "blocker-uuid", identifier: "GEO-9" },
							},
						]
					: [],
			hasNextPage: false,
			endCursor: null,
		}));
		const deleteRelation = vi.fn(async () => {
			exists = false;
			return { success: true };
		});
		const routeDeps = deps({ listBlockedBy, deleteRelation, onEpicChange });
		const response = await request(
			app({ deps: routeDeps }),
			"/api/dependency/remove",
			{ token: "master", body: removeBody() },
		);
		expect(response).toMatchObject({
			status: 200,
			body: {
				ok: true,
				status: "removed",
				kind: "not_needed",
				relation_id: "relation-1",
				ledger: { ok: true, recorded: "now" },
			},
		});
		expect(deleteRelation).toHaveBeenCalledWith("relation-1");
		expect(onEpicChange).toHaveBeenCalledOnce();
		expect(onEpicChange).toHaveBeenCalledWith("example", "dependency_changed");
		const commentBody = vi.mocked(routeDeps.createComment!).mock.calls[0]?.[1];
		expect(parseLedgerComment(commentBody ?? "")).toMatchObject({
			kind: "not_needed",
			action: "removed",
			relation_id: "relation-1",
			evidence: "mutation",
		});
	});

	it("does not write when remove cannot resolve one complete relation snapshot", async () => {
		for (const truncated of [false, true]) {
			const routeDeps = deps({
				listBlockedBy: vi.fn(async (issueId) => ({
					relations: [],
					hasNextPage: issueId === "child-uuid-2" && truncated,
					endCursor: null,
				})),
			});
			const response = await request(
				app({ deps: routeDeps }),
				"/api/dependency/remove",
				{ token: "master", body: removeBody() },
			);
			expect(response).toMatchObject({
				status: truncated ? 422 : 404,
				body: {
					error: truncated ? "relations_truncated" : "relation_not_found",
				},
			});
			if (!truncated) expect(response.body.hint).toContain("note");
			expect(routeDeps.deleteRelation).not.toHaveBeenCalled();
		}
	});

	it.each(["throw", "false", "still-present"] as const)(
		"does not record an unconfirmed remove: %s",
		async (failure) => {
			const exists = true;
			const routeDeps = deps({
				listBlockedBy: vi.fn(async (issueId) => ({
					relations:
						issueId === "child-uuid-2" && exists
							? [
									{
										id: "relation-1",
										type: "blocks",
										issue: {
											id: "blocker-uuid",
											identifier: "GEO-9",
										},
									},
								]
							: [],
					hasNextPage: false,
					endCursor: null,
				})),
				deleteRelation: vi.fn(async () => {
					if (failure === "throw") throw new Error("private path");
					if (failure === "false") return { success: false };
					return { success: true };
				}),
			});
			const response = await request(
				app({ deps: routeDeps }),
				"/api/dependency/remove",
				{ token: "master", body: removeBody() },
			);
			expect(response).toMatchObject({
				status: 502,
				body: { error: "linear_write_unconfirmed" },
			});
			expect(routeDeps.createComment).not.toHaveBeenCalled();
			expect(JSON.stringify(response)).not.toContain("private path");
		},
	);

	it("notes current added and removed state without mutating relations", async () => {
		for (const action of ["added", "removed"] as const) {
			const relationPresent = action === "added";
			const createComment = vi.fn(async () => ({
				success: true,
				comment: { id: `comment-${action}` },
			}));
			const routeDeps = deps({
				createComment,
				listBlockedBy: vi.fn(async (issueId) => ({
					relations:
						issueId === "child-uuid-2" && relationPresent
							? [
									{
										id: "relation-1",
										type: "blocks",
										issue: {
											id: "blocker-uuid",
											identifier: "GEO-9",
										},
									},
								]
							: [],
					hasNextPage: false,
					endCursor: null,
				})),
			});
			const response = await request(
				app({ deps: routeDeps }),
				"/api/dependency/note",
				{
					token: "master",
					body: noteBody({
						action,
						kind: action === "added" ? "missed" : "not_needed",
					}),
				},
			);
			expect(response).toMatchObject({
				status: 200,
				body: { ok: true, status: "recorded" },
			});
			const parsed = parseLedgerComment(createComment.mock.calls[0]?.[1] ?? "");
			expect(parsed).toMatchObject({
				action,
				evidence: "state",
				relation_id: relationPresent ? "relation-1" : null,
			});
			expect(routeDeps.createRelation).not.toHaveBeenCalled();
			expect(routeDeps.deleteRelation).not.toHaveBeenCalled();
		}
	});

	it("checks a current relation id and preserves a removed relation id", async () => {
		const currentRelation = deps({
			listBlockedBy: vi.fn(async (issueId) => ({
				relations:
					issueId === "child-uuid-2"
						? [
								{
									id: "relation-current",
									type: "blocks",
									issue: { id: "blocker-uuid", identifier: "GEO-9" },
								},
							]
						: [],
				hasNextPage: false,
				endCursor: null,
			})),
		});
		const mismatch = await request(
			app({ deps: currentRelation }),
			"/api/dependency/note",
			{
				token: "master",
				body: noteBody({ relation_id: "relation-wrong" }),
			},
		);
		expect(mismatch).toMatchObject({
			status: 409,
			body: {
				error: "relation_id_mismatch",
				current_relation_id: "relation-current",
			},
		});
		expect(currentRelation.createComment).not.toHaveBeenCalled();

		const removedRelation = deps({
			listBlockedBy: vi.fn(async () => ({
				relations: [],
				hasNextPage: false,
				endCursor: null,
			})),
		});
		const recorded = await request(
			app({ deps: removedRelation }),
			"/api/dependency/note",
			{
				token: "master",
				body: noteBody({
					kind: "not_needed",
					action: "removed",
					relation_id: "relation-deleted",
				}),
			},
		);
		expect(recorded.status).toBe(200);
		expect(
			parseLedgerComment(
				vi.mocked(removedRelation.createComment!).mock.calls[0]?.[1] ?? "",
			),
		).toMatchObject({ relation_id: "relation-deleted", evidence: "state" });
	});

	it.each([
		[{ kind: "missed", action: "removed" }, 400, "invalid_kind_action"],
		[{ kind: "not_needed", action: "added" }, 400, "invalid_kind_action"],
		[{ kind: "discovered", action: "added" }, 400, "invalid_parent_op"],
		[{ backfill: true }, 400, "relation_id_required"],
	] as const)(
		"rejects invalid note input %#",
		async (override, status, error) => {
			const routeDeps = deps();
			const response = await request(
				app({ deps: routeDeps }),
				"/api/dependency/note",
				{ token: "master", body: noteBody(override) },
			);
			expect(response).toMatchObject({ status, body: { error } });
			expect(routeDeps.createComment).not.toHaveBeenCalled();
		},
	);

	it("requires default note state to match and permits explicit backfill", async () => {
		const routeDeps = deps({
			listBlockedBy: vi.fn(async () => ({
				relations: [],
				hasNextPage: false,
				endCursor: null,
			})),
		});
		const mismatch = await request(
			app({ deps: routeDeps }),
			"/api/dependency/note",
			{ token: "master", body: noteBody() },
		);
		expect(mismatch).toMatchObject({
			status: 409,
			body: { error: "ledger_state_mismatch", current: "removed" },
		});
		expect(mismatch.body.hint).toContain("--backfill");

		const backfill = await request(
			app({ deps: routeDeps }),
			"/api/dependency/note",
			{
				token: "master",
				body: noteBody({ backfill: true, relation_id: "relation-previous" }),
			},
		);
		expect(backfill).toMatchObject({
			status: 200,
			body: { ok: true, status: "recorded" },
		});
		const body = vi.mocked(routeDeps.createComment!).mock.calls[0]?.[1] ?? "";
		expect(parseLedgerComment(body)).toMatchObject({
			evidence: "lead_ack",
			relation_id: "relation-previous",
		});
	});

	it("merges raw Linear history with parseable and damaged ledger comments", async () => {
		const secondOperation = "19ba3767-9bd3-433f-b73f-4bf761c08d69";
		const valid = buildLedgerComment({
			v: 1,
			op: OPERATION_ID,
			parent_op: null,
			relation_id: "relation-1",
			evidence: "mutation",
			kind: "not_needed",
			action: "removed",
			blocker: "GEO-9",
			blocked: "EPX-2",
			claimed_actor: "flywheel-eng-lead",
			at: "2026-09-04T08:02:00.000Z",
			reason: "dependency no longer needed",
		});
		const mangled = buildLedgerComment({
			v: 1,
			op: secondOperation,
			parent_op: OPERATION_ID,
			relation_id: "relation-2",
			evidence: "state",
			kind: "discovered",
			action: "added",
			blocker: "GEO-9",
			blocked: "EPX-2",
			claimed_actor: "flywheel-eng-lead",
			at: "2026-09-04T08:04:00.000Z",
			reason: "new discovery",
		});
		const routeDeps = deps({
			listHistory: vi.fn(async () => ({
				entries: [
					{
						id: "history-a",
						createdAt: "2026-09-04T08:00:00.000Z",
						actor: { name: "Annie" },
						relationChanges: [
							{ identifier: "GEO-9", type: "ab" },
							{ identifier: "GEO-8", type: "zz" },
						],
					},
					{
						id: "history-b",
						createdAt: "2026-09-04T08:01:00.000Z",
						botActor: { name: "Linear" },
						relationChanges: [
							{ identifier: "GEO-7", type: "br" },
							{ identifier: "GEO-6", type: "rb" },
						],
					},
				],
				hasNextPage: false,
				endCursor: null,
			})),
			listComments: vi.fn(async () => ({
				comments: [
					{
						id: "comment-valid",
						body: valid,
						createdAt: "2026-09-04T08:02:30.000Z",
						user: { name: "Bridge User" },
						url: "https://linear.app/comment-valid",
					},
					{
						id: "comment-bad",
						body: "[dependency-ledger] damaged\ndl1:***",
						createdAt: "2026-09-04T08:03:00.000Z",
						botActor: { name: "Bridge Bot" },
					},
					{
						id: "comment-mangled",
						body: `human line mangled\n${mangled.split("\n")[1]}`,
						createdAt: "2026-09-04T08:04:00.000Z",
						user: { name: "Bridge User" },
					},
					{
						id: "comment-unrelated",
						body: "ordinary comment",
						createdAt: "2026-09-04T08:05:00.000Z",
					},
				],
				hasNextPage: false,
				endCursor: null,
			})),
		});
		const response = await request(
			app({ deps: routeDeps }),
			"/api/dependency/log?projectName=example&issue=EPX-2",
			{ token: "master", method: "GET" },
		);
		expect(response).toMatchObject({
			status: 200,
			body: { issue: "EPX-2", truncated: false },
		});
		const entries = response.body.entries as Array<Record<string, unknown>>;
		expect(entries).toHaveLength(7);
		expect(entries.map((entry) => entry.meaning).filter(Boolean)).toEqual([
			"blocker_added",
			"unknown",
			"blocker_completed",
			"blocker_removed",
		]);
		expect(entries[4]).toMatchObject({
			source: "ledger_comment",
			op: OPERATION_ID,
			at: "2026-09-04T08:02:00.000Z",
			observed_at: "2026-09-04T08:02:30.000Z",
			author: "Bridge User",
			claimed_actor: "flywheel-eng-lead",
		});
		expect(entries[5]).toMatchObject({
			source: "ledger_comment",
			unparseable: true,
			author: "Bridge Bot",
		});
		expect(entries[6]).toMatchObject({
			op: secondOperation,
			parent_op: OPERATION_ID,
		});
		expect(JSON.stringify(entries)).not.toContain("ordinary comment");
	});

	it("supports kind-only log reads and reports pagination truncation", async () => {
		const routeDeps = deps({
			listHistory: vi.fn(async () => ({
				entries: [
					{
						id: "history-a",
						createdAt: "2026-09-04T08:00:00.000Z",
						relationChanges: [{ identifier: "GEO-9", type: "ab" }],
					},
				],
				hasNextPage: true,
				endCursor: null,
			})),
			listComments: vi.fn(async () => ({
				comments: [
					{
						id: "comment-bad",
						body: "[dependency-ledger] damaged",
						createdAt: "2026-09-04T08:01:00.000Z",
					},
				],
				hasNextPage: true,
				endCursor: null,
			})),
		});
		const response = await request(
			app({ deps: routeDeps }),
			"/api/dependency/log?projectName=example&issue=EPX-2&kindOnly=1",
			{ token: "master", method: "GET" },
		);
		expect(response).toMatchObject({
			status: 200,
			body: { truncated: true },
		});
		expect(response.body.entries).toEqual([
			expect.objectContaining({
				source: "ledger_comment",
				unparseable: true,
			}),
		]);
	});
});
