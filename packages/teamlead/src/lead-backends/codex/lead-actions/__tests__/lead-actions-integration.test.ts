/**
 * Real-MCP integration test for the lead-actions stdio child.
 *
 * Spawns the built entrypoint the same way Codex does and drives it with a real
 * MCP stdio client. The child receives DISCORD_BOT_TOKEN directly in its env,
 * registers exactly discord_send, remains stable across repeated ephemeral
 * spawns, and fails closed when the token is absent or empty.
 *
 * Skips automatically when the package has not been built.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
): Record<string, string> {
	return {
		FLYWHEEL_LEAD_ID: "mufasa-lead",
		FLYWHEEL_PROJECT_NAME: "growth",
		FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "1500600400238084307",
		FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS: "1512578695468941333",
		FLYWHEEL_LEAD_ACTIONS_STATE_DIR: stateDir,
		...(token === undefined ? {} : { DISCORD_BOT_TOKEN: token }),
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
	): Promise<string[]> {
		const { Client } = await import(
			"@modelcontextprotocol/sdk/client/index.js"
		);
		const { StdioClientTransport } = await import(
			"@modelcontextprotocol/sdk/client/stdio.js"
		);
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [distMain],
			env: childEnv(stateDir, token),
		});
		const client = new Client({ name: "fly350-int", version: "0.0.0" });
		await client.connect(transport);
		try {
			const res = await client.listTools();
			return res.tools.map((tool) => tool.name);
		} finally {
			await client.close().catch(() => {});
		}
	}

	run(
		"reads the env token and registers exactly discord_send",
		async () => {
			const tools = await spawnAndListTools(
				join(dir, "state"),
				"test-bot-token-xyz",
			);
			expect(tools).toEqual(["discord_send"]);
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
				expect(tools, `respawn #${i + 1}`).toEqual(["discord_send"]);
			}
		},
		30_000,
	);

	run(
		"fails closed when DISCORD_BOT_TOKEN is missing",
		async () => {
			await expect(
				spawnAndListTools(join(dir, "missing-token"), undefined),
			).rejects.toThrow();
		},
		20_000,
	);

	run(
		"fails closed when DISCORD_BOT_TOKEN is empty",
		async () => {
			await expect(
				spawnAndListTools(join(dir, "empty-token"), ""),
			).rejects.toThrow();
		},
		20_000,
	);
});
