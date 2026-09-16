import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../qa-codex-lead-parity.mjs", import.meta.url);

test("plugin skill inventory retains each installation provenance without claiming activation", async () => {
	const { collectInventory } = await import("../qa-codex-lead-parity.mjs");
	const home = mkdtempSync(join(tmpdir(), "parity-plugin-skills-"));
	try {
		const installations = ["plugin-v1", "plugin-v2"].map((name) =>
			join(home, name),
		);
		for (const installPath of installations) {
			mkdirSync(join(installPath, "skills/research"), { recursive: true });
			writeFileSync(
				join(installPath, "skills/research/SKILL.md"),
				"PRIVATE_SKILL_BODY",
			);
			mkdirSync(join(installPath, "skills/missing"));
		}
		mkdirSync(join(home, ".claude/plugins"), { recursive: true });
		writeFileSync(
			join(home, ".claude/plugins/installed_plugins.json"),
			JSON.stringify({
				plugins: {
					"research@test": installations.map((installPath) => ({
						installPath,
					})),
				},
			}),
		);
		const result = collectInventory({
			project: "flywheel",
			lead: "flywheel-product-lead",
			home,
			pathEnv: "",
		});
		const plugin = result.claude.plugins[0];
		assert.equal(plugin.evidence, "installed_registry_only");
		assert.deepEqual(
			plugin.sourceSkills.map((skill) => skill.path),
			installations.map((path) => join(path, "skills/research/SKILL.md")),
		);
		assert.ok(
			plugin.sourceSkills.every(
				(skill) =>
					skill.name === "research" &&
					skill.status === "observed" &&
					/^[a-f0-9]{64}$/.test(skill.sha256),
			),
		);
		assert.equal(result.parityVerified, false);
		assert.ok(!JSON.stringify(result).includes("PRIVATE_SKILL_BODY"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("inventory preserves unknown tools and all P01-P17 rows without leaking config values", () => {
	const home = mkdtempSync(join(tmpdir(), "parity-"));
	const put = (path, value) => {
		mkdirSync(join(home, path, ".."), { recursive: true });
		writeFileSync(join(home, path), value);
	};
	try {
		put(
			".flywheel/lead-workspace/flywheel-eng-lead/.mcp.json",
			JSON.stringify({
				mcpServers: {
					"linear-api": {
						url: "https://secret.example/CANARY",
						headers: { Authorization: "CANARY" },
					},
					future: { command: "CANARY", env: { TOKEN: "CANARY" } },
				},
			}),
		);
		put(
			".codex-flywheel-product-lead/config.toml",
			'[mcp_servers.lead_actions]\ncommand = "CANARY"\n',
		);
		put(
			".claude/plugins/installed_plugins.json",
			JSON.stringify({
				plugins: {
					"discord@flywheel-plugins": [
						{ version: "0.0.5", installPath: "/CANARY" },
					],
				},
			}),
		);
		put(".codex-flywheel-product-lead/skills/test-skill/SKILL.md", "CANARY");
		const args = [
			script.pathname,
			"--mode",
			"inventory",
			"--project",
			"flywheel",
			"--lead",
			"flywheel-product-lead",
			"--home",
			home,
		];
		const run = spawnSync(process.execPath, args, { encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		assert.ok(!run.stdout.includes("CANARY"));
		const result = JSON.parse(run.stdout);
		assert.deepEqual(
			result.rows.map((r) => r.id),
			Array.from(
				{ length: 17 },
				(_, i) => `P${String(i + 1).padStart(2, "0")}`,
			),
		);
		assert.ok(result.rows.every((r) => r.status === "unverified"));
		assert.deepEqual(
			result.claude.servers.map((s) => s.name),
			["future", "linear-api"],
		);
		assert.ok(
			result.claude.servers.every(
				(s) => s.toolSchemaDigest === null && s.tools === null,
			),
		);
		assert.equal(result.codex.servers[0].name, "lead_actions");
		assert.equal(result.codex.skills[0].name, "test-skill");
		assert.equal(result.claude.plugins[0].name, "discord@flywheel-plugins");
		assert.equal(result.parityVerified, false);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
test("unsupported mode and unsafe identities fail without reflecting user input", () => {
	for (const args of [
		["--mode", "drill"],
		["--mode", "inventory", "--project", "../CANARY", "--lead", "lead"],
	]) {
		const run = spawnSync(process.execPath, [script.pathname, ...args], {
			encoding: "utf8",
		});
		assert.notEqual(run.status, 0);
		assert.ok(!run.stderr.includes("CANARY"));
	}
});

test("missing installed inputs remain explicitly missing, never empty verified capability", async () => {
	const { collectInventory } = await import("../qa-codex-lead-parity.mjs");
	const home = mkdtempSync(join(tmpdir(), "parity-missing-"));
	try {
		const result = collectInventory({
			project: "flywheel",
			lead: "flywheel-product-lead",
			home,
			pathEnv: "",
		});
		assert.equal(result.claude.configStatus, "missing_or_invalid");
		assert.equal(result.codex.configStatus, "missing_or_unreadable");
		assert.equal(
			result.configuredServerDifference.evidence,
			"incomplete_inputs",
		);
		assert.ok(result.cli.every((c) => c.status === "missing"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("source audit resolves mounted route methods and captures guards without treating reads as runtime proof", async () => {
	const { inventorySource } = await import("../qa-codex-lead-parity.mjs");
	const repo = mkdtempSync(join(tmpdir(), "parity-source-"));
	const put = (p, text) => {
		mkdirSync(join(repo, p, ".."), { recursive: true });
		writeFileSync(join(repo, p), text);
	};
	try {
		put(
			"packages/teamlead/src/bridge/routes.ts",
			`export function createFooRouter(){router.get('/state', authorizeLeadRead, (req,res)=>res.json({}));router.post('/merge', (req,res)=>{requireFounderApproval(req);});router.post('/send', (req,res)=>{authorizeLeadWrite(req);});}`,
		);
		put(
			"packages/teamlead/src/bridge/plugin.ts",
			`app.use('/api/foo', requireApiAuth, createFooRouter(deps));`,
		);
		put(
			"packages/terminal-mcp/src/index.ts",
			`server.tool('runner_terminal_capture','description',{},()=>{});`,
		);
		put(
			"packages/flywheel-comm/src/index.ts",
			`switch(command){case 'publish-report':break;case 'verify-report':break;}`,
		);
		const result = inventorySource(repo);
		assert.equal(result.routes.length, 3);
		assert.equal(
			result.routes.find((r) => r.path === "/api/foo/merge").classification,
			"reserved",
		);
		const send = result.routes.find((r) => r.path === "/api/foo/send");
		assert.equal(send.method, "POST");
		assert.ok(send.guardSymbols.includes("authorizeLeadWrite"));
		assert.ok(send.mountGuardSymbols.includes("requireApiAuth"));
		assert.equal(result.tools[0].name, "runner_terminal_capture");
		assert.deepEqual(
			result.commCommands.map((c) => c.name),
			["publish-report", "verify-report"],
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("installed source tool schema is digested without exporting description or schema literals", async () => {
	const { collectInventory } = await import("../qa-codex-lead-parity.mjs");
	const home = mkdtempSync(join(tmpdir(), "parity-plugin-"));
	try {
		mkdirSync(join(home, ".claude/plugins"), { recursive: true });
		const installPath = join(home, "plugin");
		mkdirSync(installPath);
		writeFileSync(
			join(home, ".claude/plugins/installed_plugins.json"),
			JSON.stringify({ plugins: { "discord@test": [{ installPath }] } }),
		);
		writeFileSync(
			join(installPath, "server.ts"),
			`const result={tools:[{name:'reply',description:'CANARY',inputSchema:{type:'object',description:'CANARY'}}]};`,
		);
		const result = collectInventory({
			project: "flywheel",
			lead: "flywheel-product-lead",
			home,
			repo: home,
			pathEnv: "",
		});
		const tool = result.claude.plugins[0].sourceTools[0];
		assert.equal(tool.name, "reply");
		assert.equal(tool.toolSchemaDigest, null);
		assert.match(tool.schemaSourceDigest, /^[a-f0-9]{64}$/);
		assert.ok(!JSON.stringify(result).includes("CANARY"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
