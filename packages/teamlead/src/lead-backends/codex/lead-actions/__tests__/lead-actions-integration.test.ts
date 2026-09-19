import { createHash } from "node:crypto";
import { createServer } from "node:http";
/**
 * Real-MCP integration test for the lead-actions stdio child.
 *
 * Spawns the built entrypoint the same way Codex does and drives it with a real
 * MCP stdio client. The child receives Bridge credentials but no Discord token,
 * registers the directory, discord_send, summary_presentation and ack_batch tools, remains stable across repeated ephemeral
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
		FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
		FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "test-carrier-generation",
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
			expect(tools).toEqual([
				"directory",
				"discord_send",
				"summary_presentation",
				"ack_batch",
				"discord_read_attachment",
			]);
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
			expect(tools).toEqual([
				"directory",
				"discord_send",
				"summary_presentation",
				"ack_batch",
				"discord_read_attachment",
			]);
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
					"summary_presentation",
					"ack_batch",
					"discord_read_attachment",
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

	run(
		"forwards summary presentation operations to the canonical Bridge route",
		async () => {
			const { Client } = await import(
				"@modelcontextprotocol/sdk/client/index.js"
			);
			const { StdioClientTransport } = await import(
				"@modelcontextprotocol/sdk/client/stdio.js"
			);
			const requests: Array<{
				authorization: string | undefined;
				url: string | undefined;
				body: Record<string, unknown>;
			}> = [];
			const server = createServer((req, res) => {
				let raw = "";
				req.on("data", (chunk) => {
					raw += chunk;
				});
				req.on("end", () => {
					const body = JSON.parse(raw) as Record<string, unknown>;
					requests.push({
						authorization: req.headers.authorization,
						url: req.url,
						body,
					});
					res.setHeader("content-type", "application/json");
					if (body.probe) {
						res.end(JSON.stringify({ status: "authorized" }));
						return;
					}
					res.end(
						JSON.stringify({
							status: "begun",
							groupId: "opaque-group",
							members: [{ roundId: "opaque-round" }],
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
					...childEnv(join(dir, "summary-state"), "test-summary-token"),
					BRIDGE_URL: `http://127.0.0.1:${address.port}`,
				},
			});
			const client = new Client({ name: "summary-test", version: "1" });
			try {
				await client.connect(transport);
				const result = await client.callTool({
					name: "summary_presentation",
					arguments: { operation: "begin" },
				});
				expect(result.structuredContent).toEqual({
					status: "begun",
					groupId: "opaque-group",
					members: [{ roundId: "opaque-round" }],
				});
				const presentationRequest = requests.find(
					(request) => request.url === "/api/summary-presentation",
				);
				expect(presentationRequest).toEqual({
					authorization: "Bearer test-summary-token",
					url: "/api/summary-presentation",
					body: {
						operation: "begin",
						projectName: "growth",
						leadId: "mufasa-lead",
					},
				});
			} finally {
				await client.close().catch(() => {});
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		},
		20_000,
	);

	run(
		"returns actual TXT and a near-limit native image block through a real MCP child",
		async () => {
			const { Client } = await import(
				"@modelcontextprotocol/sdk/client/index.js"
			);
			const { StdioClientTransport } = await import(
				"@modelcontextprotocol/sdk/client/stdio.js"
			);
			const text = Buffer.from("stdio-marker-中文\nsecond line");
			const image = Buffer.alloc(5 * 1024 * 1024);
			Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(image);
			image.writeUInt32BE(4096, 16);
			image.writeUInt32BE(1024, 20);
			Buffer.from("PRIVATE_IMAGE_MARKER").copy(image, 32);
			const textAttachmentId = "333333333333333333";
			const imageAttachmentId = "555555555555555555";
			const sourceMessageId = "444444444444444444";
			const requests: Array<Record<string, unknown>> = [];
			const server = createServer((req, res) => {
				let raw = "";
				req.on("data", (chunk) => {
					raw += chunk;
				});
				req.on("end", () => {
					const body = JSON.parse(raw) as Record<string, unknown>;
					requests.push(body);
					if (body.mode === "validate") {
						res.statusCode = 204;
						res.end();
						return;
					}
					const isImage = body.attachmentId === imageAttachmentId;
					const data = isImage ? image : text;
					const mimeType = isImage ? "image/png" : "text/plain;charset=utf-8";
					res.setHeader("content-type", mimeType);
					res.setHeader("content-length", String(data.length));
					res.setHeader("x-flywheel-request-id", String(body.requestId));
					res.setHeader("x-flywheel-source-message-id", sourceMessageId);
					res.setHeader("x-flywheel-source-channel-id", "111111111111111111");
					res.setHeader("x-flywheel-attachment-id", String(body.attachmentId));
					res.setHeader("x-flywheel-mime-type", mimeType);
					res.setHeader("x-flywheel-bytes", String(data.length));
					res.setHeader(
						"x-flywheel-sha256",
						createHash("sha256").update(data).digest("hex"),
					);
					res.setHeader("x-flywheel-receipt-digest", "d".repeat(64));
					res.end(data);
				});
			});
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			const address = server.address() as { port: number };
			const transport = new StdioClientTransport({
				command: process.execPath,
				args: [distMain],
				stderr: "pipe",
				env: {
					...childEnv(join(dir, "attachment-state"), "test-api-token"),
					BRIDGE_URL: `http://127.0.0.1:${address.port}`,
				},
			});
			let stderr = "";
			transport.stderr?.on("data", (chunk) => {
				stderr += String(chunk);
			});
			const client = new Client({ name: "attachment-test", version: "1" });
			try {
				await client.connect(transport);
				const read = (attachmentId: string) =>
					client.callTool({
						name: "discord_read_attachment",
						arguments: {
							deliveryId: `chat:mufasa-lead:${sourceMessageId}`,
							attachmentId,
						},
					});
				const textResult = await read(textAttachmentId);
				expect(textResult.isError).not.toBe(true);
				expect(textResult.structuredContent).toBeUndefined();
				expect(textResult.content[1]).toEqual({
					type: "text",
					text: text.toString("utf8"),
				});
				const imageResult = await read(imageAttachmentId);
				expect(imageResult.isError).not.toBe(true);
				expect(imageResult.structuredContent).toBeUndefined();
				expect(imageResult.content[1]).toEqual({
					type: "image",
					data: image.toString("base64"),
					mimeType: "image/png",
				});
				expect(
					createHash("sha256")
						.update(
							Buffer.from(
								(imageResult.content[1] as { data: string }).data,
								"base64",
							),
						)
						.digest("hex"),
				).toBe(createHash("sha256").update(image).digest("hex"));
				expect(
					Buffer.byteLength(JSON.stringify(imageResult)),
				).toBeLessThanOrEqual(7 * 1024 * 1024);
				expect(requests).toHaveLength(4);
				expect(
					requests.every(
						(body) => body.carrierClaim === "test-carrier-generation",
					),
				).toBe(true);
			} finally {
				await client.close().catch(() => {});
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
			expect(stderr).not.toContain("test-api-token");
			expect(stderr).not.toContain("test-carrier-generation");
			expect(stderr).not.toContain(text.toString("utf8"));
			expect(stderr).not.toContain("PRIVATE_IMAGE_MARKER");
		},
		20_000,
	);
});
