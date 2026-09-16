import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import express from "express";
import { CommDB } from "flywheel-comm/db";
import {
	identityEnvProjection,
	resolveLeadIdentity,
} from "flywheel-comm/lead-identity";
import * as leadLease from "flywheel-comm/lead-lease";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLeadRunnerRouter } from "../../../bridge/lead-capability-runners.js";
import { executeLeadRunnerOperation } from "../../../bridge/lead-runner-operation.js";
import { LeadCapabilityBroker } from "../../../lead-capabilities/broker.js";
import { getLeadCapability } from "../../../lead-capabilities/catalog.js";
import { createRunnerBridgeHandlers } from "../../../lead-capabilities/handlers/bridge-read.js";
import { createLeadCapabilityManifest } from "../../../lead-capabilities/manifest.js";
import { createLeadCapabilityProxy } from "../lead-capability-proxy.js";
import { createRunnerActionContext } from "../runner-action-context.js";
import {
	createRunnerActions,
	RUNNER_ACTION_TOOL_NAMES,
	registerRunnerActions,
} from "../runner-actions.js";
import { SqliteOutboundDedupStore } from "../SqliteOutboundDedupStore.js";

const EXEC = "12345678-1234-4234-8234-123456789012";
const FOREIGN = "12345678-1234-4234-8234-123456789013";
const QUESTION = "12345678-1234-4234-8234-123456789014";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture(v2 = false) {
	const home = mkdtempSync(join(tmpdir(), "fly2459-actions-"));
	dirs.push(home);
	mkdirSync(join(home, ".flywheel"));
	writeFileSync(
		join(home, ".flywheel", "summary-config.json"),
		JSON.stringify({
			granularity: "per-lead",
			setBy: "test",
			setAt: "2026-09-10T00:00:00Z",
		}),
	);
	const projectsPath = join(home, "projects.json");
	writeFileSync(
		projectsPath,
		JSON.stringify([
			{
				projectName: "demo",
				projectRoot: home,
				leads: [
					{
						agentId: "product-lead",
						summaryRole: "producer",
						chatChannel: "11111111111111111",
						match: { labels: ["Product"] },
						backend: "codex-app-server",
						codexProfile: "full-access",
						canSpawnRunners: true,
						codexRunnerActions: true,
						...(v2 ? { codexCapabilityBundleVersion: 2 } : {}),
					},
					{
						agentId: "eng-lead",
						summaryRole: "producer",
						chatChannel: "22222222222222222",
						match: { labels: ["Engineering"] },
						canSpawnRunners: true,
					},
				],
			},
		]),
	);
	const identity = resolveLeadIdentity({
		projectsPath,
		projectName: "demo",
		leadId: "product-lead",
		homeDir: home,
	});
	const env = {
		HOME: home,
		TEAMLEAD_DB_PATH: join(home, "teamlead.db"),
		FLYWHEEL_PROJECTS_FILE: projectsPath,
		FLYWHEEL_CODEX_LEAD_PROFILE: "full-access",
		FLYWHEEL_CODEX_LEAD_RUNNER_ACTIONS: "1",
		FLYWHEEL_LEAD_LEASE_MODE: "off",
		FLYWHEEL_STATE_DIR: join(home, ".flywheel"),
		FLYWHEEL_LEAD_LEASE_MODE_FILE: join(home, "mode.json"),
		...Object.fromEntries(
			identityEnvProjection(identity).map((line) => {
				const i = line.indexOf("=");
				return [line.slice(0, i), line.slice(i + 1)];
			}),
		),
	};
	const context = createRunnerActionContext(env);
	const stateDbPath = join(home, "teamlead.db"),
		commDbPath = join(home, "comm.db");
	const db = new Database(stateDbPath);
	db.exec(
		"CREATE TABLE sessions(execution_id TEXT PRIMARY KEY,project_name TEXT,issue_identifier TEXT,issue_labels TEXT,status TEXT,session_role TEXT,adapter_type TEXT,last_activity_at TEXT)",
	);
	for (const [id, labels] of [
		[EXEC, "Product"],
		[FOREIGN, "Engineering"],
	])
		db.prepare(
			"INSERT INTO sessions VALUES (?, 'demo','FLY-2457',?,'running','main','codex','2026-09-10')",
		).run(id, JSON.stringify([labels]));
	db.close();
	const comm = new CommDB(commDbPath);
	comm.registerSession(
		EXEC,
		"test:runner",
		"demo",
		"FLY-2457",
		"product-lead",
		"codex",
	);
	comm.registerSession(
		FOREIGN,
		"test:foreign",
		"demo",
		"FLY-2457",
		"eng-lead",
		"codex",
	);
	comm.close();
	const fetchImpl = vi.fn().mockResolvedValue(
		new Response(JSON.stringify({ success: true, executionId: EXEC }), {
			status: 200,
		}),
	);
	const menus = vi.fn(() => ["prd"]);
	const options = {
		context,
		stateDbPath,
		commDbPath,
		bridge: {
			bridgeUrl: "http://localhost:9876",
			apiToken: "SECRET",
			fetchImpl,
		},
		resolveMenus: menus,
	};
	const actions = createRunnerActions(options);
	return {
		options,
		actions,
		fetchImpl,
		menus,
		stateDbPath,
		commDbPath,
		projectsPath,
	};
}
describe("shared Codex runner actions", () => {
	it("reports Discord attribution and rejects malformed reserved source keys before HTTP", async () => {
		const f = fixture();
		const args = {
			issueId: "FLY-2457",
			taskCategory: "prd",
			idempotencyKey: "discord:123456789012345678:223456789012345678",
		};
		expect(await f.actions.execute("start_runner", args)).toMatchObject({
			source: "discord",
			sourceRef: "discord:123456789012345678/223456789012345678",
		});
		const before = f.fetchImpl.mock.calls.length;
		expect(
			await f.actions.execute("start_runner", {
				...args,
				idempotencyKey: "discord:fake",
			}),
		).toMatchObject({ outcome: "refused" });
		expect(f.fetchImpl.mock.calls.length).toBe(before);
		expect(
			await f.actions.execute("start_runner", {
				...args,
				idempotencyKey: "manual-1",
			}),
		).toMatchObject({ source: "none", sourceRef: null });
	});

	it("starts through the canonical contract and keeps scoped keys stable", async () => {
		const f = fixture();
		const args = {
			issueId: "FLY-2457",
			taskCategory: "prd",
			idempotencyKey: "request-1",
		};
		expect(await f.actions.execute("start_runner", args)).toMatchObject({
			outcome: "started",
			executionId: EXEC,
		});
		const body = JSON.parse(f.fetchImpl.mock.calls[0]![1].body);
		expect(body).toEqual({
			issueId: "FLY-2457",
			taskCategory: "prd",
			projectName: "demo",
			leadId: "product-lead",
			sessionRole: "main",
			idempotencyKey: expect.stringMatching(/^codex-lead:[a-f0-9]{64}$/),
		});
		f.fetchImpl.mockResolvedValue(
			new Response('{"code":"LAUNCH_PENDING"}', { status: 202 }),
		);
		expect(await f.actions.execute("start_runner", args)).toMatchObject({
			outcome: "pending",
			idempotencyKey: "request-1",
		});
		expect(JSON.parse(f.fetchImpl.mock.calls[1]![1].body).idempotencyKey).toBe(
			body.idempotencyKey,
		);
	});
	it.each([
		{ owner: "foreign" },
		{ model: "gpt-6-astra" },
		{ freshStart: true },
	])("rejects additional start parameters %j", async (extra) => {
		const f = fixture();
		expect(
			await f.actions.execute("start_runner", {
				issueId: "FLY-2457",
				taskCategory: "prd",
				idempotencyKey: "k",
				...extra,
			}),
		).toMatchObject({ outcome: "refused" });
		expect(f.fetchImpl).not.toHaveBeenCalled();
	});
	it("rechecks adopted menus and revocation before HTTP", async () => {
		const f = fixture();
		f.menus.mockReturnValue([]);
		expect(
			await f.actions.execute("start_runner", {
				issueId: "FLY-2457",
				taskCategory: "prd",
				idempotencyKey: "k",
			}),
		).toMatchObject({ outcome: "refused" });
		const raw = JSON.parse(readFileSync(f.projectsPath, "utf8"));
		raw[0].leads[0].codexRunnerActions = false;
		writeFileSync(f.projectsPath, JSON.stringify(raw));
		expect(await f.actions.execute("list_runners", {})).toMatchObject({
			outcome: "refused",
		});
		expect(f.fetchImpl).not.toHaveBeenCalled();
	});
	it.each(["get_runner_status", "read_runner_tmux", "send_runner"])(
		"refuses foreign execution before %s side effects",
		async (name) => {
			const f = fixture();
			expect(
				await f.actions.execute(name, {
					executionId: FOREIGN,
					...(name === "send_runner"
						? { text: "hi", idempotencyKey: "k" }
						: {}),
				}),
			).toMatchObject({ outcome: "refused" });
			expect(f.fetchImpl).not.toHaveBeenCalled();
		},
	);
	it("requires exact UUID and rejects a mismatched status response", async () => {
		const f = fixture();
		expect(
			await f.actions.execute("get_runner_status", { executionId: "FLY-2457" }),
		).toMatchObject({ outcome: "refused" });
		expect(f.fetchImpl).not.toHaveBeenCalled();
		f.fetchImpl.mockResolvedValue(
			new Response(JSON.stringify({ execution_id: FOREIGN, status: "idle" })),
		);
		expect(
			await f.actions.execute("get_runner_status", { executionId: EXEC }),
		).toMatchObject({ outcome: "refused" });
	});
	it("caps capture text and never returns tmux target paths", async () => {
		const f = fixture();
		f.fetchImpl.mockResolvedValue(
			new Response(
				JSON.stringify({
					execution_id: EXEC,
					output: "a".repeat(40000),
					tmux_target: "SECRET",
				}),
			),
		);
		const result = await f.actions.execute("read_runner_tmux", {
			executionId: EXEC,
		});
		expect(result).toMatchObject({ truncated: true });
		expect(Buffer.byteLength(result.text as string)).toBe(32768);
		expect(JSON.stringify(result)).not.toContain("SECRET");
	});
	it("filters foreign project and department rows from list output", async () => {
		const f = fixture();
		f.fetchImpl.mockResolvedValue(
			new Response(
				JSON.stringify({
					sessions: [
						{
							execution_id: EXEC,
							project_name: "demo",
							issue_labels: '["Product"]',
							status: "running",
							worktree_path: "SECRET",
						},
						{
							execution_id: FOREIGN,
							project_name: "demo",
							issue_labels: '["Engineering"]',
						},
						{
							execution_id: FOREIGN,
							project_name: "foreign",
							issue_labels: '["Product"]',
						},
					],
				}),
			),
		);
		const result = await f.actions.execute("list_runners", {});
		expect(result.sessions).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain("SECRET");
	});
	it("sends through the durable mailbox with stable instruction identity", async () => {
		const f = fixture();
		const args = { executionId: EXEC, text: "continue", idempotencyKey: "k" };
		const first = await f.actions.execute("send_runner", args);
		expect(first).toMatchObject({ outcome: "queued" });
		expect(await f.actions.execute("send_runner", args)).toEqual(first);
		const db = new CommDB(f.commDbPath);
		try {
			expect(db.getUnreadInstructions(EXEC)).toHaveLength(1);
		} finally {
			db.close();
		}
	});
	it.each([
		"approve_to_ship",
		"review_design",
		"review_code",
		"founder_review",
	])("cannot answer reserved checkpoint %s", async (checkpoint) => {
		const f = fixture();
		const db = new CommDB(f.commDbPath);
		try {
			db.insertQuestion(EXEC, "product-lead", "ok?", {
				id: QUESTION,
				checkpoint,
			});
		} finally {
			db.close();
		}
		expect(
			await f.actions.execute("respond_runner", {
				questionId: QUESTION,
				answer: "yes",
			}),
		).toMatchObject({ outcome: "refused" });
	});
	it("answers an ordinary scoped question through guardedResponse and replays it", async () => {
		const f = fixture();
		const db = new CommDB(f.commDbPath);
		try {
			db.insertQuestion(EXEC, "product-lead", "which option?", {
				id: QUESTION,
			});
		} finally {
			db.close();
		}
		const first = await f.actions.execute("respond_runner", {
			questionId: QUESTION,
			answer: "option A",
		});
		expect(first).toMatchObject({
			outcome: "queued",
			responseId: expect.any(String),
		});
		expect(
			await f.actions.execute("respond_runner", {
				questionId: QUESTION,
				answer: "option A",
			}),
		).toEqual(first);
		expect(
			await f.actions.execute("respond_runner", {
				questionId: QUESTION,
				answer: "option B",
			}),
		).toMatchObject({ outcome: "refused" });
	});
	it.each(["expired", "foreign-owner", "foreign-lead", "report"])(
		"refuses %s questions without inserting a response",
		async (mutation) => {
			const f = fixture();
			const db = new CommDB(f.commDbPath);
			try {
				db.insertQuestion(
					mutation === "foreign-owner" ? FOREIGN : EXEC,
					mutation === "foreign-lead" ? "eng-lead" : "product-lead",
					"ok?",
					{
						id: QUESTION,
						...(mutation === "report" ? { kind: "report" as const } : {}),
					},
				);
			} finally {
				db.close();
			}
			if (mutation === "expired") {
				const raw = new Database(f.commDbPath);
				raw
					.prepare(
						"UPDATE mailbox SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
					)
					.run(QUESTION);
				raw.close();
			}
			expect(
				await f.actions.execute("respond_runner", {
					questionId: QUESTION,
					answer: "yes",
				}),
			).toMatchObject({ outcome: "refused" });
			const check = new CommDB(f.commDbPath);
			try {
				expect(check.getResponse(QUESTION)).toBeUndefined();
			} finally {
				check.close();
			}
		},
	);
	it("registers exactly six opt-in tools and rejects extra fields through the actual MCP protocol", async () => {
		const { McpServer } = await import(
			"@modelcontextprotocol/sdk/server/mcp.js"
		);
		const { Client } = await import(
			"@modelcontextprotocol/sdk/client/index.js"
		);
		const { InMemoryTransport } = await import(
			"@modelcontextprotocol/sdk/inMemory.js"
		);
		const f = fixture();
		const server = new McpServer({ name: "test", version: "1" });
		registerRunnerActions(server, f.options);
		const client = new Client({ name: "test", version: "1" });
		const [a, b] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(a), client.connect(b)]);
		try {
			expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
				[...RUNNER_ACTION_TOOL_NAMES],
			);
			const result = await client.callTool({
				name: "start_runner",
				arguments: {
					issueId: "FLY-2457",
					taskCategory: "prd",
					idempotencyKey: "key",
					leadId: "foreign",
				},
			});
			expect(result.isError).toBe(true);
			expect(f.fetchImpl).not.toHaveBeenCalled();
		} finally {
			await client.close();
			await server.close();
		}
	});
	it.each([" ", "a\0b", "界".repeat(2667)])(
		"rejects empty, NUL or over-budget text before mailbox insertion",
		async (text) => {
			const f = fixture();
			expect(
				await f.actions.execute("send_runner", {
					executionId: EXEC,
					text,
					idempotencyKey: "k",
				}),
			).toMatchObject({ outcome: "refused" });
			const db = new CommDB(f.commDbPath);
			try {
				expect(db.getUnreadInstructions(EXEC)).toEqual([]);
			} finally {
				db.close();
			}
		},
	);
	it("rejects scope changes during an outstanding capture", async () => {
		const f = fixture();
		f.fetchImpl.mockImplementationOnce(async () => {
			const db = new Database(f.stateDbPath);
			db.prepare(
				"UPDATE sessions SET issue_labels = ? WHERE execution_id = ?",
			).run('["Engineering"]', EXEC);
			db.close();
			return new Response(
				JSON.stringify({ execution_id: EXEC, output: "FOREIGN_OUTPUT" }),
			);
		});
		const result = await f.actions.execute("read_runner_tmux", {
			executionId: EXEC,
		});
		expect(result).toMatchObject({ outcome: "refused" });
		expect(JSON.stringify(result)).not.toContain("FOREIGN_OUTPUT");
	});
	it("leaves the MCP server unchanged when runner actions are not enabled", async () => {
		const { McpServer } = await import(
			"@modelcontextprotocol/sdk/server/mcp.js"
		);
		const { Client } = await import(
			"@modelcontextprotocol/sdk/client/index.js"
		);
		const { InMemoryTransport } = await import(
			"@modelcontextprotocol/sdk/inMemory.js"
		);
		const server = new McpServer({ name: "test", version: "1" });
		server.registerTool("base", {}, async () => ({
			content: [{ type: "text", text: "ok" }],
		}));
		registerRunnerActions(server);
		const client = new Client({ name: "test", version: "1" });
		const [a, b] = InMemoryTransport.createLinkedPair();
		await Promise.all([server.connect(a), client.connect(b)]);
		try {
			expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
				["base"],
			);
			expect(
				(await client.callTool({ name: "start_runner", arguments: {} }))
					.isError,
			).toBe(true);
		} finally {
			await client.close();
			await server.close();
		}
	});
	it("requires the existing Lead write lease before dispatching a start", async () => {
		const f = fixture();
		const context = createRunnerActionContext({
			...f.options.context.env,
			FLYWHEEL_LEAD_LEASE_MODE: "enforce",
			FLYWHEEL_LEAD_LEASE_DB: join(f.options.context.env.HOME!, "lease.db"),
		});
		const actions = createRunnerActions({ ...f.options, context });
		expect(
			await actions.execute("start_runner", {
				issueId: "FLY-2457",
				taskCategory: "prd",
				idempotencyKey: "k",
			}),
		).toMatchObject({ outcome: "refused" });
		expect(f.fetchImpl).not.toHaveBeenCalled();
	});
	it("does not project arbitrary status payloads from Bridge", async () => {
		const f = fixture();
		f.fetchImpl.mockResolvedValue(
			new Response(
				JSON.stringify({
					execution_id: EXEC,
					status: { token: "SECRET" },
					checked_at: { token: "SECRET" },
				}),
			),
		);
		const result = await f.actions.execute("get_runner_status", {
			executionId: EXEC,
		});
		expect(result).toMatchObject({ paneStatus: "unknown" });
		expect(JSON.stringify(result)).not.toContain("SECRET");
	});
});

it("provides read-only scope authorization without sending or answering", () => {
	const f = fixture();
	expect(() =>
		f.actions.authorize("send_runner", {
			executionId: EXEC,
			text: "hi",
			idempotencyKey: "same",
		}),
	).not.toThrow();
	expect(() =>
		f.actions.authorize("send_runner", {
			executionId: FOREIGN,
			text: "hi",
			idempotencyKey: "same",
		}),
	).toThrow();
	expect(() =>
		f.actions.authorize("respond_runner", {
			questionId: QUESTION,
			answer: "yes",
		}),
	).toThrow();
	expect(f.fetchImpl).not.toHaveBeenCalled();
	const db = new Database(f.commDbPath, { readonly: true });
	try {
		expect(
			db
				.prepare(
					"SELECT count(*) AS n FROM mailbox_message_projection WHERE type = ?",
				)
				.get("response"),
		).toEqual({ n: 0 });
	} finally {
		db.close();
	}
});
it("retains nullable sourceRef in the v2 start result contract", async () => {
	const f = fixture();
	const result = await f.actions.execute("start_runner", {
		issueId: "FLY-1",
		taskCategory: "prd",
		idempotencyKey: "manual-1",
	});
	expect(result.sourceRef).toBeNull();
	expect(
		getLeadCapability("start_runner")!.outputSchema.safeParse({
			result,
			receiptId: QUESTION,
			observedAt: new Date().toISOString(),
		}).success,
	).toBe(true);
});

it("runs a v2 Bridge start once and replays only a scoped durable receipt", async () => {
	const f = fixture(true),
		receipts = new SqliteOutboundDedupStore(
			join(dirs[dirs.length - 1]!, "runner-receipts.db"),
		);
	const requestId = QUESTION,
		input = {
			issueId: "FLY-2457",
			taskCategory: "prd",
			idempotencyKey: "manual-1",
		};
	const options = {
		actions: f.options,
		projectName: "demo",
		leadId: "product-lead",
		activationId: "activation-1",
		operationId: "start_runner",
		requestId,
		input,
		receipts: receipts.operationReceipts,
		signal: new AbortController().signal,
		secrets: ["SECRET"],
		assertCurrent: () => {},
	};
	try {
		expect(
			await executeLeadRunnerOperation({ ...options, receiptOnly: true }),
		).toMatchObject({ status: "unknown" });
		expect(f.fetchImpl).not.toHaveBeenCalled();
		expect(await executeLeadRunnerOperation(options)).toMatchObject({
			status: "succeeded",
			data: { result: { executionId: EXEC, sourceRef: null } },
		});
		expect(
			await executeLeadRunnerOperation({
				...options,
				activationId: "activation-2",
				receiptOnly: true,
			}),
		).toMatchObject({
			status: "succeeded",
			data: { result: { executionId: EXEC } },
		});
		expect(
			await executeLeadRunnerOperation({
				...options,
				input: { ...input, idempotencyKey: "changed" },
			}),
		).toMatchObject({ status: "rejected", errorCode: "input_digest_conflict" });
		expect(f.fetchImpl).toHaveBeenCalledOnce();
		const db = new Database(f.stateDbPath);
		db.prepare("UPDATE sessions SET project_name=? WHERE execution_id=?").run(
			"foreign",
			EXEC,
		);
		db.close();
		expect(
			(await executeLeadRunnerOperation({ ...options, receiptOnly: true }))
				.status,
		).not.toBe("succeeded");
		expect(f.fetchImpl).toHaveBeenCalledOnce();
	} finally {
		receipts.close();
	}
});

it("composes all remaining runner actions with typed output and durable write replay", async () => {
	const f = fixture(true),
		receipts = new SqliteOutboundDedupStore(
			join(dirs[dirs.length - 1]!, "runner-receipts.db"),
		);
	const comm = new CommDB(f.commDbPath);
	comm.insertQuestion(EXEC, "product-lead", "which?", { id: QUESTION });
	comm.close();
	f.fetchImpl.mockImplementation(async (url: string) => {
		if (url.includes("/capture"))
			return Response.json({ execution_id: EXEC, output: "pane" });
		if (url.includes("/status"))
			return Response.json({
				execution_id: EXEC,
				status: "waiting",
				checked_at: "2026-09-14T00:00:00.000Z",
			});
		const db = new Database(f.stateDbPath, { readonly: true });
		try {
			return Response.json({
				sessions: db.prepare("SELECT * FROM sessions").all(),
			});
		} finally {
			db.close();
		}
	});
	const cases: [string, Record<string, unknown>][] = [
		["list_runners", {}],
		["get_runner_status", { executionId: EXEC }],
		["read_runner_tmux", { executionId: EXEC }],
		[
			"send_runner",
			{
				executionId: EXEC,
				text: "instruction",
				idempotencyKey: "instruction-1",
			},
		],
		["respond_runner", { questionId: QUESTION, answer: "A" }],
	];
	try {
		for (const [operationId, input] of cases) {
			const options = {
				actions: f.options,
				projectName: "demo",
				leadId: "product-lead",
				activationId: "activation-1",
				operationId,
				requestId: QUESTION,
				input,
				receipts: receipts.operationReceipts,
				signal: new AbortController().signal,
				secrets: ["SECRET"],
				assertCurrent: () => {},
			};
			const result = await executeLeadRunnerOperation(options);
			expect(result.status, operationId).toBe("succeeded");
			expect(
				getLeadCapability(operationId)!.outputSchema.safeParse(result.data)
					.success,
			).toBe(true);
			if (["send_runner", "respond_runner"].includes(operationId))
				expect(
					await executeLeadRunnerOperation({ ...options, receiptOnly: true }),
				).toMatchObject({
					status: "succeeded",
					resourceRefs: result.resourceRefs,
				});
		}
	} finally {
		receipts.close();
	}
});
it("never redispatches an interrupted or concurrent runner start", async () => {
	const f = fixture(true),
		receipts = new SqliteOutboundDedupStore(
			join(dirs[dirs.length - 1]!, "runner-receipts.db"),
		),
		controller = new AbortController();
	f.fetchImpl.mockImplementation(() => new Promise(() => {}));
	const options = {
		actions: f.options,
		projectName: "demo",
		leadId: "product-lead",
		activationId: "activation-1",
		operationId: "start_runner",
		requestId: QUESTION,
		input: {
			issueId: "FLY-2457",
			taskCategory: "prd",
			idempotencyKey: "manual-1",
		},
		receipts: receipts.operationReceipts,
		signal: controller.signal,
		secrets: [],
		assertCurrent: () => {},
	};
	try {
		const pending = executeLeadRunnerOperation(options);
		await vi.waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce());
		expect((await executeLeadRunnerOperation(options)).status).toBe("unknown");
		controller.abort();
		expect((await pending).status).toBe("unknown");
		expect(
			(
				await executeLeadRunnerOperation({
					...options,
					signal: new AbortController().signal,
					activationId: "activation-2",
				})
			).status,
		).toBe("unknown");
		expect(f.fetchImpl).toHaveBeenCalledOnce();
	} finally {
		receipts.close();
	}
});

it("serves result-only runner writes on a real isolated Bridge HTTP route", async () => {
	const f = fixture(true),
		receipts = new SqliteOutboundDedupStore(
			join(dirs[dirs.length - 1]!, "runner-http-receipts.db"),
		);
	const identity = f.options.context.assertCurrent().identity;
	const carrierProbe = vi
		.spyOn(leadLease, "validateLeadCarrierAuthorization")
		.mockImplementation((input) =>
			input.env?.FLYWHEEL_LEAD_CARRIER_INSTANCE_ID === "fixture-claim"
				? {
						valid: true,
						disposition: "carrier_passthrough",
						leadKey: identity.leadKey,
						carrier: {
							leadKey: identity.leadKey,
							backend: "codex-app-server",
							identityDigest: identity.identityDigest,
							pid: process.pid,
							lstart: "fixture",
							instanceDigest: "a".repeat(64),
						},
					}
				: { valid: false, reason: "carrier_claim_wrong" },
		);
	const app = express();
	app.use(express.json());
	app.use(
		"/api/lead-capabilities/runners",
		createLeadRunnerRouter({
			apiToken: "SECRET",
			bridgeUrl: f.options.bridge.bridgeUrl,
			stateDbPath: f.stateDbPath,
			receipts: receipts.operationReceipts,
			homeDir: f.options.context.env.HOME,
			projectsPath: f.projectsPath,
			env: f.options.context.env,
			commDbPath: () => f.commDbPath,
			fetchImpl: f.fetchImpl,
			resolveMenus: f.menus,
		}),
	);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/lead-capabilities/runners`;
	const body = {
		schemaVersion: 1,
		operationId: "start_runner",
		requestId: QUESTION,
		projectName: "demo",
		leadId: "product-lead",
		identityDigest: f.options.context.env.FLYWHEEL_LEAD_IDENTITY_DIGEST,
		carrierClaim: "fixture-claim",
		activationId: "activation-1",
		input: {
			issueId: "FLY-2457",
			taskCategory: "prd",
			idempotencyKey: "http-start",
		},
	};
	const post = (value: unknown, token = "SECRET") =>
		fetch(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(value),
		});
	try {
		expect((await post(body, "wrong")).status).toBe(401);
		expect(
			await (await post({ ...body, receiptOnly: true })).json(),
		).toMatchObject({ status: "unknown" });
		expect(f.fetchImpl).not.toHaveBeenCalled();
		expect(await (await post(body)).json()).toMatchObject({
			status: "succeeded",
		});
		expect(
			await (await post({ ...body, receiptOnly: true })).json(),
		).toMatchObject({ status: "succeeded" });
		expect(f.fetchImpl).toHaveBeenCalledOnce();
		expect(
			(await post({ ...body, identityDigest: "f".repeat(64) })).status,
		).toBe(403);
		expect(f.fetchImpl).toHaveBeenCalledOnce();
		f.fetchImpl.mockImplementation(async () =>
			Response.json({ success: true, executionId: EXEC }),
		);
		const parentReceipts = new SqliteOutboundDedupStore(
			join(dirs[dirs.length - 1]!, "parent-receipts.db"),
		);
		const parentEnv = {
			...f.options.context.env,
			FLYWHEEL_CODEX_CAPABILITY_BUNDLE_VERSION: "2",
			FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "fixture-claim",
			FLYWHEEL_API_TOKEN: "SECRET",
			FLYWHEEL_BRIDGE_URL: new URL(url).origin,
		};
		const handlers = createRunnerBridgeHandlers({
			env: parentEnv,
			activationId: "activation-parent",
		});
		const parent = new LeadCapabilityBroker({
			projectName: "demo",
			leadId: "product-lead",
			activationId: "activation-parent",
			receipts: parentReceipts.operationReceipts,
			secrets: ["SECRET", "fixture-claim"],
			allowedOperationIds: () => new Set(handlers.keys()),
			assertCurrent: async () => {},
			handlers,
		});
		const proxy = createLeadCapabilityProxy({
			manifest: createLeadCapabilityManifest({
				projectName: "demo",
				leadId: "product-lead",
				identityDigest: identity.identityDigest,
				backend: "codex-app-server",
				profile: "full-access",
				activationId: "activation-parent",
				sourceRevision: "fixture",
				operations: RUNNER_ACTION_TOOL_NAMES.map(
					(name) => getLeadCapability(name)!,
				),
				ruleSources: [],
				skillSources: [],
				integrations: [],
			}),
			socketPath: "/tmp/fixture-broker.sock",
			requestClient: async (_path, request) => parent.execute(request),
		});
		const client = new Client({ name: "composed-runner-test", version: "1" });
		const [a, b] = InMemoryTransport.createLinkedPair();
		try {
			await Promise.all([proxy.connect(a), client.connect(b)]);
			const args = {
				requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				issueId: "FLY-2457",
				taskCategory: "prd",
				idempotencyKey: "parent-start",
			};
			for (let i = 0; i < 2; i++) {
				const reply = await client.callTool({
					name: "start_runner",
					arguments: args,
				});
				expect(reply.content).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							type: "text",
							text: expect.stringContaining('"status":"succeeded"'),
						}),
					]),
				);
			}
			expect(f.fetchImpl).toHaveBeenCalledTimes(2);
			const receipt = parentReceipts.operationReceipts.get({
				projectName: "demo",
				leadId: "product-lead",
				operationId: "start_runner",
				requestId: args.requestId,
			})!;
			expect(
				await handlers.get("start_runner")!.reconcile!(
					receipt,
					{
						issueId: args.issueId,
						taskCategory: args.taskCategory,
						idempotencyKey: args.idempotencyKey,
					},
					{
						projectName: "demo",
						leadId: "product-lead",
						activationId: "activation-parent",
						requestId: args.requestId,
						signal: new AbortController().signal,
						assertCurrent: async () => {},
					},
				),
			).toMatchObject({ status: "succeeded" });
			expect(f.fetchImpl).toHaveBeenCalledTimes(2);
		} finally {
			await client.close();
			await proxy.close();
			await parent.close();
			parentReceipts.close();
		}
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		carrierProbe.mockRestore();
		receipts.close();
	}
});
