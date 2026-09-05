import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type DependencyCliDeps, runDependency } from "../dependency.js";

const OP = "11111111-1111-4111-8111-111111111111";
const EDGE_1 = "22222222-2222-4222-8222-222222222222";
const EDGE_2 = "33333333-3333-4333-8333-333333333333";

function response(
	body: unknown,
	options: { ok?: boolean; status?: number } = {},
) {
	return {
		ok: options.ok ?? true,
		status: options.status ?? 200,
		json: async () => body,
	};
}

function deps(overrides: Partial<DependencyCliDeps> = {}): DependencyCliDeps {
	return {
		env: {
			FLYWHEEL_PROJECT_NAME: "flywheel",
			FLYWHEEL_BRIDGE_URL: "http://localhost:9876/",
			TEAMLEAD_API_TOKEN: "master",
			FLYWHEEL_LEAD_ID: "eng-lead",
		},
		fetchFn: vi.fn(async () =>
			response({
				ok: true,
				status: "added",
				operation_id: OP,
				ledger: { ok: true, recorded: "now" },
				post_write_check: { cycle: false },
			}),
		),
		randomUuid: vi.fn(() => OP),
		log: vi.fn(),
		errorLog: vi.fn(),
		...overrides,
	};
}

describe("flywheel-comm dependency", () => {
	it("is wired into the CLI dispatcher and help", () => {
		const source = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");
		expect(source).toContain(
			'import { runDependency } from "./commands/dependency.js"',
		);
		expect(source).toContain('case "dependency":');
		expect(source).toContain("dependency  Maintain the live dependency ledger");
	});

	it("adds a missed dependency with a generated operation id", async () => {
		const input = deps();

		expect(
			await runDependency(
				[
					"add",
					"--blocker",
					"FLY-1",
					"--blocked",
					"FLY-2",
					"--reason",
					"missed during split",
				],
				input,
			),
		).toBe(0);
		expect(input.fetchFn).toHaveBeenCalledWith(
			"http://localhost:9876/api/dependency/add",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer master",
				}),
				body: JSON.stringify({
					projectName: "flywheel",
					blocker: "FLY-1",
					blocked: "FLY-2",
					reason: "missed during split",
					operation_id: OP,
					claimed_actor: "eng-lead",
				}),
			}),
		);
		expect(JSON.parse(vi.mocked(input.log!).mock.calls[0]![0])).toMatchObject({
			ok: true,
			command: "add",
			operation_id: OP,
		});
	});

	it("removes a dependency with an explicit operation id", async () => {
		const fetchFn = vi.fn(async () =>
			response({
				ok: true,
				status: "removed",
				operation_id: OP,
				ledger: { ok: true, recorded: "now" },
			}),
		);
		const input = deps({ fetchFn });

		expect(
			await runDependency(
				[
					"remove",
					"--blocker",
					"FLY-1",
					"--blocked",
					"FLY-2",
					"--reason",
					"no longer needed",
					"--operation-id",
					OP,
				],
				input,
			),
		).toBe(0);
		expect(fetchFn).toHaveBeenCalledWith(
			"http://localhost:9876/api/dependency/remove",
			expect.objectContaining({
				body: JSON.stringify({
					projectName: "flywheel",
					blocker: "FLY-1",
					blocked: "FLY-2",
					reason: "no longer needed",
					operation_id: OP,
					claimed_actor: "eng-lead",
				}),
			}),
		);
	});

	it("records an explicit backfill note", async () => {
		const fetchFn = vi.fn(async () =>
			response({
				ok: true,
				status: "recorded",
				operation_id: OP,
				ledger: { ok: true, recorded: "now" },
			}),
		);
		const input = deps({ fetchFn });

		expect(
			await runDependency(
				[
					"note",
					"--blocker",
					"FLY-1",
					"--blocked",
					"FLY-2",
					"--kind",
					"not_needed",
					"--action",
					"removed",
					"--reason",
					"confirmed by Lead",
					"--operation-id",
					OP,
					"--relation-id",
					"relation-1",
					"--backfill",
				],
				input,
			),
		).toBe(0);
		expect(fetchFn).toHaveBeenCalledWith(
			"http://localhost:9876/api/dependency/note",
			expect.objectContaining({
				body: JSON.stringify({
					projectName: "flywheel",
					blocker: "FLY-1",
					blocked: "FLY-2",
					reason: "confirmed by Lead",
					operation_id: OP,
					claimed_actor: "eng-lead",
					kind: "not_needed",
					action: "removed",
					relation_id: "relation-1",
					backfill: true,
				}),
			}),
		);
	});

	it("reads and prints the dependency timeline", async () => {
		const result = {
			issue: "FLY-2",
			entries: [
				{
					at: "2026-09-04T00:00:00.000Z",
					source: "ledger_comment",
					kind: "not_needed",
					blocker: "FLY-1",
					blocked: "FLY-2",
					reason: "not needed",
				},
			],
			truncated: false,
		};
		const fetchFn = vi.fn(async () => response(result));
		const input = deps({ fetchFn });

		expect(
			await runDependency(["log", "--issue", "FLY-2", "--kind-only"], input),
		).toBe(0);
		expect(fetchFn).toHaveBeenCalledWith(
			"http://localhost:9876/api/dependency/log?projectName=flywheel&issue=FLY-2&kindOnly=1",
			expect.objectContaining({ method: "GET" }),
		);
		expect(JSON.parse(vi.mocked(input.log!).mock.calls[0]![0])).toEqual({
			ok: true,
			command: "log",
			result,
		});
		expect(input.errorLog).toHaveBeenCalledWith(
			expect.stringContaining("FLY-1 → FLY-2"),
		);
	});

	it("shows only ready items and dependency review", async () => {
		const document = {
			generated_at: "2026-09-04T00:00:00.000Z",
			ready_items: { value: ["FLY-1"] },
			dependency_review: {
				value: [{ kind: "canceled_blocker", blocked: "FLY-2" }],
			},
			items: [{ identifier: "FLY-2", title: "must not leak" }],
		};
		const fetchFn = vi.fn(async () => response({ receipt: {}, document }));
		const input = deps({ fetchFn });

		expect(await runDependency(["show"], input)).toBe(0);
		expect(fetchFn).toHaveBeenCalledWith(
			"http://localhost:9876/api/epic-page/generate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ projectName: "flywheel" }),
			}),
		);
		expect(JSON.parse(vi.mocked(input.log!).mock.calls[0]![0])).toEqual({
			ok: true,
			command: "show",
			ready: ["FLY-1"],
			review: [{ kind: "canceled_blocker", blocked: "FLY-2" }],
			generated_at: "2026-09-04T00:00:00.000Z",
		});
	});

	it("discovers a child and adds each dependency with its own operation id", async () => {
		const fetchFn = vi.fn(async (url: string, init) => {
			if (url.endsWith("/api/linear/create-issue")) {
				return response({
					ok: true,
					issue: {
						identifier: "FLY-10",
						url: "https://linear.app/test/FLY-10",
					},
				});
			}
			const body = JSON.parse(init.body ?? "{}") as { operation_id: string };
			return response({
				ok: true,
				status: "added",
				operation_id: body.operation_id,
				ledger: { ok: true, recorded: "now" },
				post_write_check: { cycle: false },
			});
		});
		const randomUuid = vi
			.fn()
			.mockReturnValueOnce(EDGE_1)
			.mockReturnValueOnce(EDGE_2);
		const input = deps({ fetchFn, randomUuid });

		expect(
			await runDependency(
				[
					"discover",
					"--parent",
					"FLY-100",
					"--title",
					"New work",
					"--description",
					"Details",
					"--priority",
					"2",
					"--blocks",
					"FLY-20",
					"--blocked-by",
					"FLY-5",
					"--reason",
					"discovered while executing",
					"--operation-id",
					OP,
				],
				input,
			),
		).toBe(0);
		expect(fetchFn.mock.calls[0]).toEqual([
			"http://localhost:9876/api/linear/create-issue",
			expect.objectContaining({
				body: JSON.stringify({
					projectName: "flywheel",
					title: "New work",
					description: "Details",
					priority: 2,
					parentId: "FLY-100",
				}),
			}),
		]);
		expect(JSON.parse(fetchFn.mock.calls[1]![1].body ?? "{}")).toMatchObject({
			blocker: "FLY-10",
			blocked: "FLY-20",
			kind: "discovered",
			operation_id: EDGE_1,
			parent_op: OP,
		});
		expect(JSON.parse(fetchFn.mock.calls[2]![1].body ?? "{}")).toMatchObject({
			blocker: "FLY-5",
			blocked: "FLY-10",
			kind: "discovered",
			operation_id: EDGE_2,
			parent_op: OP,
		});
		expect(JSON.parse(vi.mocked(input.log!).mock.calls[0]![0])).toMatchObject({
			ok: true,
			command: "discover",
			parent_op: OP,
			created: { identifier: "FLY-10" },
			edges: [
				{ ok: true, operation_id: EDGE_1 },
				{ ok: true, operation_id: EDGE_2 },
			],
		});
		const stderr = vi
			.mocked(input.errorLog!)
			.mock.calls.map(([line]) => line)
			.join("\n");
		expect(stderr).toContain(EDGE_1);
		expect(stderr).toContain(EDGE_2);
	});

	it("exits 2 and prints a safely quoted backfill command when the ledger write fails", async () => {
		const reason = `a'b\n"$(id) \`tick\` & #`;
		const input = deps({
			fetchFn: vi.fn(async () =>
				response({
					ok: true,
					status: "added",
					operation_id: OP,
					relation_id: "relation-1",
					ledger: { ok: false, error: "ledger_unrecorded" },
					post_write_check: { cycle: false },
				}),
			),
		});

		expect(
			await runDependency(
				["add", "--blocker", "FLY-1", "--blocked", "FLY-2", "--reason", reason],
				input,
			),
		).toBe(2);
		const stderr = vi
			.mocked(input.errorLog!)
			.mock.calls.map(([line]) => line)
			.join("\n");
		expect(stderr).toContain("flywheel-comm dependency note");
		expect(stderr).toContain(`--reason 'a'"'"'b\n"$(id) \`tick\` & #'`);
		expect(stderr).toContain("--relation-id 'relation-1' --backfill");
		expect(JSON.parse(vi.mocked(input.log!).mock.calls[0]![0])).toMatchObject({
			ok: true,
			command: "add",
			operation_id: OP,
		});
	});

	it("prints a replay command when a removed-state note is not recorded", async () => {
		const input = deps({
			fetchFn: vi.fn(async () =>
				response({
					ok: true,
					operation_id: OP,
					relation_id: null,
					ledger: { ok: false, error: "ledger_unrecorded" },
				}),
			),
		});

		expect(
			await runDependency(
				[
					"note",
					"--blocker",
					"FLY-1",
					"--blocked",
					"FLY-2",
					"--kind",
					"not_needed",
					"--action",
					"removed",
					"--reason",
					"confirmed",
				],
				input,
			),
		).toBe(2);
		const stderr = vi
			.mocked(input.errorLog!)
			.mock.calls.map(([line]) => line)
			.join("\n");
		expect(stderr).toContain("flywheel-comm dependency note");
		expect(stderr).not.toContain("--relation-id");
		expect(stderr).not.toContain("--backfill");
	});

	it("exits 2 when the post-write cycle check finds a cycle", async () => {
		const input = deps({
			fetchFn: vi.fn(async () =>
				response({
					ok: true,
					status: "added",
					operation_id: OP,
					ledger: { ok: true, recorded: "now" },
					post_write_check: { cycle: true, path: ["FLY-2", "FLY-1"] },
				}),
			),
		});

		expect(
			await runDependency(
				["add", "--blocker", "FLY-1", "--blocked", "FLY-2", "--reason", "race"],
				input,
			),
		).toBe(2);
		expect(input.errorLog).toHaveBeenCalledWith(
			expect.stringContaining("cycle"),
		);
		expect(input.errorLog).toHaveBeenCalledWith(
			expect.stringContaining("flywheel-comm dependency remove"),
		);
	});

	it("exits 2 when the post-write cycle check is unbounded", async () => {
		const input = deps({
			fetchFn: vi.fn(async () =>
				response({
					ok: true,
					operation_id: OP,
					ledger: { ok: true, recorded: "now" },
					post_write_check: { cycle: null, reason: "unbounded" },
				}),
			),
		});

		expect(
			await runDependency(
				["add", "--blocker", "FLY-1", "--blocked", "FLY-2", "--reason", "race"],
				input,
			),
		).toBe(2);
		expect(input.errorLog).toHaveBeenCalledWith(
			expect.stringContaining("unbounded"),
		);
		expect(input.errorLog).toHaveBeenCalledWith(
			expect.stringContaining("flywheel-comm dependency show"),
		);
	});

	it("keeps an existing foreign edge successful but tells the Lead how to note it", async () => {
		const input = deps({
			fetchFn: vi.fn(async () =>
				response({
					ok: true,
					status: "already_exists",
					attribution: "foreign",
					operation_id: OP,
					relation_id: "foreign-relation",
					ledger: { ok: false, skipped: "foreign_relation" },
					post_write_check: { cycle: false },
				}),
			),
		});

		expect(
			await runDependency(
				[
					"add",
					"--blocker",
					"FLY-1",
					"--blocked",
					"FLY-2",
					"--reason",
					"known edge",
				],
				input,
			),
		).toBe(0);
		expect(input.errorLog).toHaveBeenCalledWith(
			expect.stringContaining("foreign-relation"),
		);
	});

	it("reports discover partial_failure without deleting the created issue", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(
				response({
					ok: true,
					issue: { identifier: "FLY-10", url: "https://linear/FLY-10" },
				}),
			)
			.mockResolvedValueOnce(
				response({
					ok: true,
					operation_id: EDGE_1,
					relation_id: "relation-1",
					ledger: { ok: false, error: "ledger_unrecorded" },
					post_write_check: { cycle: false },
					detail: "Bearer injected-secret /private/diagnostic",
				}),
			)
			.mockResolvedValueOnce(
				response({
					ok: true,
					operation_id: EDGE_2,
					relation_id: "relation-2",
					ledger: { ok: true, recorded: "now" },
					post_write_check: { cycle: true, path: ["FLY-10", "FLY-5"] },
				}),
			);
		const input = deps({
			fetchFn,
			randomUuid: vi
				.fn()
				.mockReturnValueOnce(EDGE_1)
				.mockReturnValueOnce(EDGE_2),
		});

		expect(
			await runDependency(
				[
					"discover",
					"--parent",
					"FLY-100",
					"--title",
					"New work",
					"--blocks",
					"FLY-20",
					"--blocked-by",
					"FLY-5",
					"--reason",
					"new dependency",
					"--operation-id",
					OP,
				],
				input,
			),
		).toBe(1);
		const envelope = JSON.parse(vi.mocked(input.log!).mock.calls[0]![0]);
		expect(envelope).toMatchObject({
			ok: false,
			error: "partial_failure",
			created: { identifier: "FLY-10" },
			edges: [
				{
					ok: false,
					operation_id: EDGE_1,
					result: { relation_id: "relation-1" },
				},
				{
					ok: false,
					operation_id: EDGE_2,
					result: { post_write_check: { cycle: true } },
				},
			],
		});
		expect(JSON.stringify(envelope)).not.toContain("injected-secret");
		const stderr = vi
			.mocked(input.errorLog!)
			.mock.calls.map(([line]) => line)
			.join("\n");
		expect(stderr).toContain("flywheel-comm dependency note");
		expect(stderr).toContain("--kind 'discovered' --action 'added'");
		expect(stderr).toContain("--relation-id 'relation-1' --backfill");
		expect(stderr).toContain(`--parent-op '${OP}'`);
		expect(stderr).toContain("flywheel-comm dependency remove");
		expect(fetchFn).toHaveBeenCalledTimes(3);
		expect(
			fetchFn.mock.calls.some(([url]) => String(url).includes("delete")),
		).toBe(false);
	});

	it("does not retry an unknown create outcome and prints an encoded lookup URL", async () => {
		const fetchFn = vi.fn(async () => {
			throw new Error("connection reset");
		});
		const input = deps({ fetchFn });

		expect(
			await runDependency(
				[
					"discover",
					"--parent",
					"FLY-100",
					"--title",
					"A & B/#?",
					"--blocks",
					"FLY-20",
					"--reason",
					"new dependency",
					"--operation-id",
					OP,
				],
				input,
			),
		).toBe(1);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		const envelope = JSON.parse(vi.mocked(input.log!).mock.calls[0]![0]);
		expect(envelope).toEqual({
			ok: false,
			error: "outcome_unknown",
			next: "GET /api/linear/issue?query=A+%26+B%2F%23%3F&projectName=flywheel 查重后再决定",
		});
		expect(input.errorLog).toHaveBeenCalledWith(
			expect.stringContaining(
				"/api/linear/issue?query=A+%26+B%2F%23%3F&projectName=flywheel",
			),
		);
	});

	it("treats a 502 create response as an unknown outcome", async () => {
		const fetchFn = vi.fn(async () =>
			response({ error: "linear_unavailable" }, { ok: false, status: 502 }),
		);
		const input = deps({ fetchFn });

		expect(
			await runDependency(
				[
					"discover",
					"--parent",
					"FLY-100",
					"--title",
					"New work",
					"--blocks",
					"FLY-20",
					"--reason",
					"new dependency",
					"--operation-id",
					OP,
				],
				input,
			),
		).toBe(1);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(JSON.parse(vi.mocked(input.log!).mock.calls[0]![0])).toEqual({
			ok: false,
			error: "outcome_unknown",
			next: "GET /api/linear/issue?query=New+work&projectName=flywheel 查重后再决定",
		});
	});

	it("relays the backfill hint for a rejected note", async () => {
		const input = deps({
			fetchFn: vi.fn(async () =>
				response(
					{
						error: "ledger_state_mismatch",
						hint: "若要补记一次已确认发生过的操作,加 --backfill",
					},
					{ ok: false, status: 409 },
				),
			),
		});

		expect(
			await runDependency(
				[
					"note",
					"--blocker",
					"FLY-1",
					"--blocked",
					"FLY-2",
					"--kind",
					"missed",
					"--action",
					"added",
					"--reason",
					"confirmed",
				],
				input,
			),
		).toBe(1);
		expect(input.errorLog).toHaveBeenCalledWith(
			expect.stringContaining("--backfill"),
		);
		expect(JSON.parse(vi.mocked(input.log!).mock.calls[0]![0])).toMatchObject({
			ok: false,
			error: "ledger_state_mismatch",
			status: 409,
			operation_id: OP,
		});
		expect(input.errorLog).toHaveBeenCalledWith(expect.stringContaining(OP));
	});

	it("records a discovered note with its parent operation", async () => {
		const fetchFn = vi.fn(async () =>
			response({
				ok: true,
				operation_id: OP,
				ledger: { ok: true, recorded: "now" },
			}),
		);
		const input = deps({ fetchFn });

		expect(
			await runDependency(
				[
					"note",
					"--blocker",
					"FLY-1",
					"--blocked",
					"FLY-2",
					"--kind",
					"discovered",
					"--action",
					"added",
					"--parent-op",
					EDGE_1,
					"--reason",
					"found while working",
				],
				input,
			),
		).toBe(0);
		expect(JSON.parse(fetchFn.mock.calls[0]![1].body ?? "{}")).toMatchObject({
			kind: "discovered",
			action: "added",
			parent_op: EDGE_1,
		});
	});

	it("returns a one-line invalid_response envelope for malformed Bridge JSON", async () => {
		const input = deps({
			fetchFn: vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () => {
					throw new Error("not json");
				},
			})),
		});

		expect(
			await runDependency(
				["add", "--blocker", "FLY-1", "--blocked", "FLY-2", "--reason", "x"],
				input,
			),
		).toBe(1);
		expect(input.log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(vi.mocked(input.log!).mock.calls[0]![0])).toEqual({
			ok: false,
			error: "invalid_response",
			operation_id: OP,
		});
	});

	it.each([
		[{}, "missing_project"],
		[{ FLYWHEEL_PROJECT_NAME: "flywheel" }, "missing_token"],
	] as const)("fails closed on missing environment %#", async (env, error) => {
		const input = deps({ env });

		expect(await runDependency(["show"], input)).toBe(1);
		expect(input.fetchFn).not.toHaveBeenCalled();
		expect(JSON.parse(vi.mocked(input.log!).mock.calls[0]![0])).toEqual({
			ok: false,
			error,
		});
	});

	it.each([
		[
			"add rejects discover-only flags",
			[
				"add",
				"--blocker",
				"FLY-1",
				"--blocked",
				"FLY-2",
				"--reason",
				"x",
				"--kind",
				"discovered",
			],
		],
		["show rejects log flags", ["show", "--issue", "FLY-1"]],
		["show rejects actor", ["show", "--actor", "eng-lead"]],
		["log requires issue", ["log", "--kind-only"]],
		[
			"discover requires an edge",
			["discover", "--parent", "FLY-1", "--title", "x", "--reason", "x"],
		],
		[
			"note backfill requires relation id",
			[
				"note",
				"--blocker",
				"FLY-1",
				"--blocked",
				"FLY-2",
				"--reason",
				"x",
				"--kind",
				"missed",
				"--action",
				"added",
				"--backfill",
			],
		],
		[
			"note rejects an invalid kind/action pair",
			[
				"note",
				"--blocker",
				"FLY-1",
				"--blocked",
				"FLY-2",
				"--reason",
				"x",
				"--kind",
				"not_needed",
				"--action",
				"added",
			],
		],
		[
			"discovered note requires parent operation",
			[
				"note",
				"--blocker",
				"FLY-1",
				"--blocked",
				"FLY-2",
				"--reason",
				"x",
				"--kind",
				"discovered",
				"--action",
				"added",
			],
		],
		[
			"add requires reason",
			["add", "--blocker", "FLY-1", "--blocked", "FLY-2"],
		],
		[
			"add rejects a non-v4 operation id",
			[
				"add",
				"--blocker",
				"FLY-1",
				"--blocked",
				"FLY-2",
				"--reason",
				"x",
				"--operation-id",
				"11111111-1111-1111-8111-111111111111",
			],
		],
	] as const)("rejects invalid arguments: %s", async (_name, args) => {
		const input = deps();

		expect(await runDependency([...args], input)).toBe(1);
		expect(input.fetchFn).not.toHaveBeenCalled();
		expect(JSON.parse(vi.mocked(input.log!).mock.calls[0]![0])).toEqual({
			ok: false,
			error: "invalid_arguments",
		});
	});
});
