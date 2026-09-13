import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import {
	identityEnvProjection,
	resolveLeadIdentity,
} from "flywheel-comm/lead-identity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunnerActionContext } from "../runner-action-context.js";
import {
	createRunnerActions,
	RUNNER_ACTION_TOOL_NAMES,
	registerRunnerActions,
} from "../runner-actions.js";

const EXEC = "12345678-1234-4234-8234-123456789012";
const FOREIGN = "12345678-1234-4234-8234-123456789013";
const QUESTION = "12345678-1234-4234-8234-123456789014";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
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
