import { expect, it } from "vitest";
import { getLeadCapability } from "../../../lead-capabilities/catalog.js";
import { createLeadCapabilityManifest } from "../../../lead-capabilities/manifest.js";
import { browserFacadeSchemaDigest } from "../browser-capability-proxy.js";
import { buildCodexLeadMcpArgv } from "../buildCodexLeadMcpArgv.js";

const manifest = createLeadCapabilityManifest({
	projectName: "flywheel",
	leadId: "product",
	identityDigest: "a".repeat(64),
	backend: "codex-app-server",
	profile: "full-access",
	activationId: "activation",
	browserGeneration: "aaaa0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	sourceRevision: "sha",
	operations: [
		getLeadCapability("git.feature.push")!,
		getLeadCapability("browser.list_pages")!,
	],
	ruleSources: [],
	skillSources: [],
	integrations: [
		{
			id: "browser",
			version: "1.9.0",
			toolSchemaDigest: browserFacadeSchemaDigest(["list_pages"]),
		},
	],
});
const capabilityV2 = {
	nodePath: "/usr/local/bin/node",
	proxyEntryPath:
		"/opt/flywheel/dist/lead-backends/codex/capability-mcp-entry.js",
	socketPath: "/tmp/lead/broker.sock",
	manifestPath: "/tmp/lead/manifest.json",
	manifest,
};
it("builds exactly two credential-free v2 facades with manifest-selected tools and Git deadline headroom", () => {
	const result = buildCodexLeadMcpArgv({ capabilityV2 });
	expect(result.included).toEqual(["lead_actions", "chrome_devtools"]);
	expect(result.argv).toContain(
		'mcp_servers.lead_actions.enabled_tools=["lead_operation"]',
	);
	expect(result.argv).toContain(
		'mcp_servers.chrome_devtools.enabled_tools=["list_pages"]',
	);
	expect(result.argv).toContain(
		"mcp_servers.lead_actions.tool_timeout_sec=185",
	);
	expect(result.argv).toContain(
		"mcp_servers.chrome_devtools.tool_timeout_sec=20",
	);
	expect(result.argv).toContain(
		'mcp_servers.chrome_devtools.args=["/opt/flywheel/dist/lead-backends/codex/capability-mcp-entry.js","browser"]',
	);
	expect(result.argv.join(" ")).not.toMatch(
		/npx|browser-url|env_vars|TOKEN|CARRIER/,
	);
	expect(result.argv).toContain(
		'mcp_servers.chrome_devtools.env.FLYWHEEL_LEAD_CAPABILITY_SOCKET="/tmp/lead/broker.sock"',
	);
	expect(result.argv).toContain(
		'mcp_servers.lead_actions.default_tools_approval_mode="approve"',
	);
});
it("rejects any legacy MCP option alongside v2, including disabled Chrome", () => {
	for (const extra of [
		{ chrome: { enabled: false } },
		{ gateway: { command: "node", args: [] } },
		{ leadActions: { command: "node", args: [] } },
	]) {
		expect(() => buildCodexLeadMcpArgv({ capabilityV2, ...extra })).toThrow(
			/v2/,
		);
	}
});
it("rejects tampered manifests, absent browser integration and invalid public coordinates", () => {
	for (const bad of [
		{
			...capabilityV2,
			manifest: { ...manifest, manifestDigest: "b".repeat(64) },
		},
		{
			...capabilityV2,
			manifest: createLeadCapabilityManifest({
				...manifest,
				operations: [getLeadCapability("git.feature.push")!],
				integrations: [],
			}),
		},
		{ ...capabilityV2, socketPath: "relative.sock" },
		{ ...capabilityV2, proxyEntryPath: "npx" },
		{ ...capabilityV2, nodePath: "/bin/node\n" },
	])
		expect(() => buildCodexLeadMcpArgv({ capabilityV2: bad })).toThrow();
});
it("starts both real stdio facade entry modes without provider credentials", async () => {
	const { createRequire } = await import("node:module");
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const { StdioClientTransport } = await import(
		"@modelcontextprotocol/sdk/client/stdio.js"
	);
	const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const root = mkdtempSync(join(tmpdir(), "capability-entry-"));
	const path = join(root, "manifest.json");
	writeFileSync(path, JSON.stringify(manifest));
	try {
		for (const mode of ["actions", "browser"]) {
			const client = new Client({ name: "entry-test", version: "1" });
			const transport = new StdioClientTransport({
				command: process.execPath,
				args: [
					"--import",
					createRequire(import.meta.url).resolve("tsx"),
					fileURLToPath(new URL("../capability-mcp-entry.ts", import.meta.url)),
					mode,
				],
				env: {
					HOME: root,
					PATH: "/usr/bin:/bin",
					FLYWHEEL_LEAD_CAPABILITY_MANIFEST: path,
					FLYWHEEL_LEAD_CAPABILITY_SOCKET: "/tmp/test-broker.sock",
				},
				stderr: "pipe",
			});
			try {
				await client.connect(transport);
				expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
					mode === "actions" ? ["lead_operation"] : ["list_pages"],
				);
			} finally {
				await client.close();
				await transport.close();
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 15000);
it("changes the effective v2 config digest when the native tool allowlist changes", () => {
	const changed = createLeadCapabilityManifest({
		...manifest,
		operations: [
			getLeadCapability("git.feature.push")!,
			getLeadCapability("browser.click")!,
		],
		integrations: [
			{
				id: "browser",
				version: "1.9.0",
				toolSchemaDigest: browserFacadeSchemaDigest(["click"]),
			},
		],
	});
	expect(
		buildCodexLeadMcpArgv({
			capabilityV2: { ...capabilityV2, manifest: changed },
		}).configHash,
	).not.toBe(buildCodexLeadMcpArgv({ capabilityV2 }).configHash);
});
