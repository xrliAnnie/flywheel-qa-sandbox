import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, it } from "vitest";
import { RUNNER_ACTION_TOOL_NAMES } from "../runner-action-names.js";
import { SecretBroker } from "../secret-broker.js";
import { runnerActionEnv } from "./helpers/runner-action-env.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
it.each(["full-access", "write-capable"])(
	"%s MCP child advertises and dispatches runner actions using canonical identity",
	async (profile) => {
		const home = mkdtempSync(join(tmpdir(), "fly2459-mcp-child-"));
		dirs.push(home);
		const env = runnerActionEnv(home, resolve(process.cwd(), "../.."));
		let received: unknown;
		const server = createServer(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk);
			received = JSON.parse(Buffer.concat(chunks).toString());
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					success: true,
					executionId: "12345678-1234-4234-8234-123456789012",
				}),
			);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no address");
		env.BRIDGE_URL = `http://127.0.0.1:${address.port}`;
		let broker: SecretBroker | undefined;
		if (profile === "write-capable") {
			const path = env.FLYWHEEL_PROJECTS_FILE!;
			const projects = JSON.parse(readFileSync(path, "utf8"));
			projects[0].leads[0].codexProfile = profile;
			writeFileSync(path, JSON.stringify(projects));
			env.FLYWHEEL_CODEX_LEAD_PROFILE = profile;
			env.FLYWHEEL_LEAD_ACTIONS_MAIN_JS = join(
				process.cwd(),
				"dist/lead-backends/codex/gateway/gateway-main.js",
			);
			env.FLYWHEEL_BRIDGE_URL = env.BRIDGE_URL;
			env.FLYWHEEL_GATEWAY_STATE_DIR = join(home, "gateway");
			mkdirSync(env.FLYWHEEL_GATEWAY_STATE_DIR);
			env.FLYWHEEL_GATEWAY_COMM_DB = join(home, "comm.db");
			env.FLYWHEEL_GATEWAY_STATE_DB = join(home, "state.db");
			env.FLYWHEEL_GATEWAY_BROKER_SOCKET = join(home, "broker.sock");
			env.FLYWHEEL_GATEWAY_CONFIRM_CHANNEL_ID = "11111111111111111";
			env.FLYWHEEL_FOUNDER_DISCORD_USER_ID = "22222222222222222";
			broker = new SecretBroker({
				socketPath: env.FLYWHEEL_GATEWAY_BROKER_SOCKET,
				secrets: {
					DISCORD_BOT_TOKEN: env.DISCORD_BOT_TOKEN!,
					FLYWHEEL_API_TOKEN: env.TEAMLEAD_API_TOKEN!,
				},
			});
			broker.setRunnerCarrierClaim("test-current-carrier");
			await broker.listen();
			delete env.DISCORD_BOT_TOKEN;
			delete env.TEAMLEAD_API_TOKEN;
		}
		const client = new Client({ name: "test", version: "1" });
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [env.FLYWHEEL_LEAD_ACTIONS_MAIN_JS!],
			env: Object.fromEntries(
				Object.entries(env).filter(
					(entry): entry is [string, string] => entry[1] !== undefined,
				),
			),
			stderr: "pipe",
		});
		let childError = "";
		transport.stderr?.on("data", (data) => {
			childError += data.toString();
		});
		try {
			try {
				await client.connect(transport);
			} catch (error) {
				throw new Error(`MCP child failed: ${childError}`, { cause: error });
			}
			expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
				expect.arrayContaining([
					...RUNNER_ACTION_TOOL_NAMES,
					"discord_send",
					...(profile === "full-access"
						? ["ack_batch"]
						: ["request_runner_lifecycle"]),
				]),
			);
			const result = await client.callTool({
				name: "start_runner",
				arguments: {
					issueId: "FLY-2457",
					taskCategory: "prd",
					idempotencyKey: "test-request",
				},
			});
			expect(result.isError).not.toBe(true);
			expect(received).toMatchObject({
				projectName: "flywheel",
				leadId: "flywheel-product-lead",
				sessionRole: "main",
				taskCategory: "prd",
			});
		} finally {
			await client.close();
			await transport.close();
			await broker?.close();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	},
	20000,
);
