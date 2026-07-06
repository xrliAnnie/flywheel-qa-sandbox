/**
 * FLY-350 race-fix — real-MCP integration test (design review MED-3).
 *
 * Unit tests run OUTSIDE a real MCP spawn and could not catch the cutover race
 * (codex 0.141 ephemerally re-spawns the MCP per built_tools call; a respawn
 * racing the broker read an empty payload → `Unexpected end of JSON input`). This
 * test spawns the REAL lead-actions MCP child the SAME way codex does — `node
 * lead-actions-main.js` over stdio with the config.toml `env` coordinates — against
 * a REAL parent SecretBroker, and drives it with a REAL MCP stdio CLIENT.
 *
 * It proves the load-bearing properties the unit tests cannot:
 *  - the config.toml env coords actually reach the MCP child (it parses + starts);
 *  - the broker delivers the token NON-EMPTY across REPEATED (ephemeral) spawns
 *    (the race fix) — no `Unexpected end of JSON input`;
 *  - the live tool surface is EXACTLY `discord_send`;
 *  - a down broker fails the child closed (no half-started action surface).
 *
 * SCOPE (code-review MED-3): this exercises the REAL MCP server + broker + MCP
 * stdio client, but NOT the real codex remote-control daemon (its ephemeral
 * built_tools spawn/list/terminate cycle, app-server tool sourcing). That last
 * mile is covered by the §10 real-machine negative tests at the founder-gated
 * re-cutover (broker-socket connect must fail from the model shell / read-deny
 * blocks secrets / non-allowlist send refused / proactive discord_send works) —
 * see the v1.49.1 plan §4. This test + the shell→gate regression (home-script
 * test) + the config-gate unit tests are the automated guard; the daemon-level
 * proof is the in-person re-cutover QA.
 *
 * Skips automatically if the built dist / MCP SDK client / AF_UNIX isn't available.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretBroker } from "../../secret-broker.js";
import { buildLeadActionsMcpServerConfig } from "../mcp-config.js";

// LOW-5: skip cleanly where AF_UNIX listen() is denied (managed sandbox).
const afUnixAvailable = await new Promise<boolean>((resolve) => {
	const probePath = join(tmpdir(), `fly350-int-afunix-${process.pid}.sock`);
	const s = createServer();
	s.once("error", () => resolve(false));
	try {
		s.listen(probePath, () => {
			s.close(() => {
				try {
					rmSync(probePath, { force: true });
				} catch {}
				resolve(true);
			});
		});
	} catch {
		resolve(false);
	}
});

// The BUILT entrypoint (the MCP runs from dist, like in production). If the
// package hasn't been built, skip (CI builds before testing).
const here = dirname(fileURLToPath(import.meta.url));
// src/lead-backends/codex/lead-actions/__tests__ → dist/.../lead-actions-main.js
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

const SECRETS = { DISCORD_BOT_TOKEN: "test-bot-token-xyz" };

function expectedEnv(socketPath: string, stateDir: string) {
	const cfg = buildLeadActionsMcpServerConfig({
		nodeBin: process.execPath,
		mainJsPath: distMain,
		brokerSocketPath: socketPath,
		leadId: "mufasa-lead",
		projectName: "growth",
		chatChannelId: "1500600400238084307",
		crossDeptChannelIds: ["1512578695468941333"],
		stateDir,
	});
	return cfg.env;
}

describe("lead-actions MCP real-spawn integration (FLY-350 MED-3)", () => {
	let dir: string;
	let broker: SecretBroker | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly350-int-"));
	});
	afterEach(async () => {
		await broker?.close().catch(() => {});
		broker = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	const run = existsSync(distMain) && afUnixAvailable ? it : it.skip;

	// One spawn helper: spawn the real MCP child over stdio (as codex does), list
	// tools, return them. Closes the client/transport.
	async function spawnAndListTools(
		socketPath: string,
		stateDir: string,
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
			env: expectedEnv(socketPath, stateDir),
			// stderr inherited would pollute; capture is fine via default.
		});
		const client = new Client({ name: "fly350-int", version: "0.0.0" });
		await client.connect(transport);
		try {
			const res = await client.listTools();
			return res.tools.map((t) => t.name);
		} finally {
			await client.close().catch(() => {});
		}
	}

	run(
		"the real MCP child fetches the token over the broker and registers exactly discord_send",
		async () => {
			const socketPath = join(dir, "lead-actions.sock");
			broker = new SecretBroker({ socketPath, secrets: SECRETS });
			await broker.listen();
			const tools = await spawnAndListTools(socketPath, join(dir, "state"));
			expect(tools).toEqual(["discord_send"]);
		},
		20_000,
	);

	run(
		"delivers the token NON-EMPTY across REPEATED ephemeral respawns (the race fix)",
		async () => {
			const socketPath = join(dir, "lead-actions.sock");
			broker = new SecretBroker({ socketPath, secrets: SECRETS });
			await broker.listen();
			// 3 sequential spawns = codex's ephemeral spawn/list/terminate per turn.
			// Each must succeed (non-empty token fetch → tool list), proving the broker
			// serves every respawn and no `Unexpected end of JSON input` occurs.
			for (let i = 0; i < 3; i++) {
				const tools = await spawnAndListTools(socketPath, join(dir, "state"));
				expect(tools, `respawn #${i + 1}`).toEqual(["discord_send"]);
			}
		},
		30_000,
	);

	run(
		"a down broker fails the child closed (no half-started surface)",
		async () => {
			// No broker listening → the child's fetchSecretsFromBroker exhausts retries
			// and exits non-zero → the MCP client connect/listTools rejects.
			const socketPath = join(dir, "absent.sock");
			await expect(
				spawnAndListTools(socketPath, join(dir, "state")),
			).rejects.toThrow();
		},
		20_000,
	);
});
