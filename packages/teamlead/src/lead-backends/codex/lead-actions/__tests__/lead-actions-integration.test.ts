import { createServer } from "node:http";
/**
 * Real-MCP integration test for the lead-actions stdio child.
 *
 * Spawns the built entrypoint the same way Codex does and drives it with a real
 * MCP stdio client. The child receives Bridge credentials but no Discord token,
 * registers the directory, discord_send and ack_batch tools, remains stable across repeated ephemeral
 * spawns, and fails closed when the token is absent or empty.
 *
 * Skips automatically when the package has not been built.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const distMain = join(
	here,
	"..",
	"..",
	"..",
	"..",
	"..",
	"dist",
	"lead-backends",
	"codex",
	"lead-actions",
	"lead-actions-main.js",
);

function childEnv(
	stateDir: string,
	token: string | undefined,
	mode: "bridge" | "direct" = "bridge",
): Record<string, string> {
	return {
		FLYWHEEL_LEAD_ID: "mufasa-lead",
		FLYWHEEL_PROJECT_NAME: "growth",
		FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "1500600400238084307",
		FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: "1512578695468941333",
		FLYWHEEL_LEAD_ACTIONS_STATE_DIR: stateDir,
		FLYWHEEL_COMM_DB: join(stateDir, "comm.db"),
		FLYWHEEL_CODEX_LEAD_OUTBOUND: mode,
		...(mode === "bridge" ? { BRIDGE_URL: "http://127.0.0.1:1" } : {}),
		...(token === undefined
			? {}
			: mode === "bridge"
				? { TEAMLEAD_API_TOKEN: token }
				: { DISCORD_BOT_TOKEN: token }),
	};
}

describe("lead-actions MCP real-spawn integration", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly350-int-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const run = existsSync(distMain) ? it : it.skip;

	async function spawnAndListTools(
		stateDir: string,
		token: string | undefined,
		mode: "bridge" | "direct" = "bridge",
	): Promise<string[]> {
		const { Client } = await import(
			"@modelcontextprotocol/sdk/client/index.js"
		);
		const { StdioClientTransport } = await import(
			"@modelcontextprotocol/sdk/client/stdio.js"
		);
		writeFileSync(
			join(dir, "projects.json"),
			JSON.stringify([{ projectName: "empty", projectRoot: dir, leads: [] }]),
		);
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [distMain],
			env: {
				...childEnv(stateDir, token, mode),
				FLYWHEEL_PROJECTS_FILE: join(dir, "projects.json"),
			},
		});
		const client = new Client({ name: "fly350-int", version: "0.0.0" });
		await client.connect(transport);
		try {
			const res = await client.listTools();
			const result = await client.callTool({
				name: "directory",
				arguments: {},
			});
			expect(result.structuredContent).toMatchObject({
				status: "available",
				projects: [{ projectName: "empty" }],
			});
			return res.tools.map((tool) => tool.name);
		} finally {
			await client.close().catch(() => {});
		}
	}

	run(
		"reads the Bridge API token, registers the exact tools, and reads the directory",
		async () => {
			const tools = await spawnAndListTools(
				join(dir, "state"),
				"test-bot-token-xyz",
			);
			expect(tools).toEqual(["directory", "discord_send", "ack_batch"]);
		},
		20_000,
	);

	run(
		"starts direct mode with only the Discord credential",
		async () => {
			const tools = await spawnAndListTools(
				join(dir, "direct"),
				"direct-discord-token",
				"direct",
			);
			expect(tools).toEqual(["directory", "discord_send", "ack_batch"]);
		},
		20_000,
	);

	run(
		"registers the same exact inventory across repeated ephemeral spawns",
		async () => {
			for (let i = 0; i < 3; i++) {
				const tools = await spawnAndListTools(
					join(dir, `state-${i}`),
					"test-bot-token-xyz",
				);
				expect(tools, `respawn #${i + 1}`).toEqual([
					"directory",
					"discord_send",
					"ack_batch",
				]);
			}
		},
		30_000,
	);

	run(
		"fails closed when TEAMLEAD_API_TOKEN is missing",
		async () => {
			await expect(
				spawnAndListTools(join(dir, "missing-token"), undefined),
			).rejects.toThrow();
		},
		20_000,
	);

	run(
		"fails closed when TEAMLEAD_API_TOKEN is empty",
		async () => {
			await expect(
				spawnAndListTools(join(dir, "empty-token"), ""),
			).rejects.toThrow();
		},
		20_000,
	);
	run(
		"returns structured pending and ready roundtable receipts through a real MCP child",
		async () => {
			const { Client } = await import(
				"@modelcontextprotocol/sdk/client/index.js"
			);
			const { StdioClientTransport } = await import(
				"@modelcontextprotocol/sdk/client/stdio.js"
			);
			const requests: Record<string, unknown>[] = [];
			let sends = 0;
			const server = createServer((req, res) => {
				let raw = "";
				req.on("data", (chunk) => {
					raw += chunk;
				});
				req.on("end", () => {
					const body = JSON.parse(raw);
					requests.push(body);
					res.setHeader("content-type", "application/json");
					if (body.probe) {
						res.end(JSON.stringify({ status: "authorized" }));
						return;
					}
					const ready = ++sends > 1;
					res.statusCode = ready ? 200 : 202;
					res.end(
						JSON.stringify({
							status: ready ? "sent" : "pending",
							sendStatus: "sent",
							messageId: "22222222222222222",
							engagement: ready ? "ready" : "pending",
							...(ready ? { threadId: "22222222222222222" } : {}),
						}),
					);
				});
			});
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			const address = server.address() as { port: number };
			const transport = new StdioClientTransport({
				command: process.execPath,
				args: [distMain],
				env: {
					...childEnv(join(dir, "send-state"), "test"),
					BRIDGE_URL: `http://127.0.0.1:${address.port}`,
					FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE_EFFECTIVE: "1",
				},
			});
			const client = new Client({ name: "proactive-test", version: "1" });
			try {
				await client.connect(transport);
				const args = {
					name: "discord_send",
					arguments: {
						target: "roundtable",
						text: "question",
						eventId: "same-event",
					},
				};
				expect((await client.callTool(args)).structuredContent).toMatchObject({
					status: "pending",
					sendStatus: "sent",
					engagement: "pending",
					eventId: "same-event",
					project: "growth",
					leadId: "mufasa-lead",
					target: "roundtable",
					deduped: false,
				});
				expect((await client.callTool(args)).structuredContent).toMatchObject({
					status: "sent",
					engagement: "ready",
					threadId: "22222222222222222",
					eventId: "same-event",
				});
				expect(requests.every((r) => r.roundtableEngage === true)).toBe(true);
				expect(
					new Set(requests.filter((r) => !r.probe).map((r) => r.idempotencyKey))
						.size,
				).toBe(1);
			} finally {
				await client.close().catch(() => {});
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		},
		20000,
	);
});
