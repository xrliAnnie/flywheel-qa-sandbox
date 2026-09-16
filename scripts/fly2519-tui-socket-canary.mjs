#!/usr/bin/env node
import { createHash } from "node:crypto";
// Isolated transport canary only; no auth copy, model turn, browser or provider call.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexLeadProcess } from "../packages/teamlead/dist/lead-backends/codex/CodexLeadProcess.js";
import { startCapabilityAppServer } from "../packages/teamlead/dist/lead-backends/codex/capability-app-server.js";
import { connectDaemonWs } from "../packages/teamlead/dist/lead-backends/codex/daemon-ws.js";
import { WsTransport } from "../packages/teamlead/dist/lead-backends/codex/WsTransport.js";
import {
	assertLeadPermissionProfile,
	renderLeadPermissionProfile,
} from "../packages/teamlead/dist/lead-capabilities/permission-profile.js";

const codexPath = realpathSync(join(homedir(), ".local/bin/codex"));
if (
	createHash("sha256").update(readFileSync(codexPath)).digest("hex") !==
	"195ace4100a634a9df39147f493e730e666b5bd87795f3c9f3251d8542400424"
)
	throw new Error("pinned_codex_binary_drift");
const root = realpathSync(mkdtempSync("/tmp/fw-tui-proof-"));
for (const name of [
	"home",
	"project",
	"deployment",
	"artifacts",
	"tmp",
	"credentials",
])
	mkdirSync(join(root, name), { mode: 0o700 });
const pins = {
	codexHome: join(root, "home"),
	brokerSocket: join(root, "broker.sock"),
	manifestPath: join(root, "manifest.json"),
	artifactRoot: join(root, "artifacts"),
	modelTempRoot: join(root, "tmp"),
	projectName: "fixture",
	leadId: "fixture",
	activationId: "native-tui-check",
};
const spec = {
	deploymentRoot: join(root, "deployment"),
	projectRoot: join(root, "project"),
	artifactRoot: pins.artifactRoot,
	readPaths: [codexPath],
	credentialPaths: [join(root, "credentials")],
	brokerSocket: pins.brokerSocket,
	proxyPort: 32767,
};
writeFileSync(
	join(pins.codexHome, "config.toml"),
	renderLeadPermissionProfile(spec),
	{ mode: 0o600 },
);
let server, proc;
const result = {
	transport: "app_server_socket",
	isolatedHome: true,
	authCopied: false,
	modelTurnStarted: false,
	providerWrites: false,
	parentAuthorityMock: true,
	fullRuntimeAcceptance: false,
};
try {
	server = await startCapabilityAppServer({
		parent: {
			codexPath,
			pins,
			permissionArgv: ["-c", 'default_permissions="flywheel-lead-v2"'],
			mcp: { argv: ["-c", "mcp_servers={}"] },
			assertCurrent: async () => {},
		},
		env: { HOME: root, PATH: "/usr/bin:/bin" },
	});
	const ws = await connectDaemonWs({
		codexHome: pins.codexHome,
		socketPath: server.socketPath,
	});
	proc = new CodexLeadProcess({
		spawnChild: () => new WsTransport(ws),
		experimentalApi: true,
	});
	await proc.start();
	result.initialized = true;
	const config = await proc.request("config/read", {
		cwd: spec.projectRoot,
		includeLayers: false,
	});
	if (!config.result?.config) throw new Error("config_read_failed");
	assertLeadPermissionProfile(config.result.config, spec);
	result.effectivePermissionsVerified = true;
	const skills = await proc.request("skills/list", {
		cwds: [spec.projectRoot],
		forceReload: true,
	});
	if (skills.error || !skills.result) throw new Error("skills_read_failed");
	result.skillsListAvailable = true;
	result.processReceipt = server.receipt;
} catch (error) {
	result.error = error.message;
	process.exitCode = 1;
} finally {
	await proc?.stop();
	await server?.close();
	result.socketRemoved = server ? !existsSync(server.socketPath) : null;
	rmSync(root, { recursive: true, force: true });
	writeFileSync(
		`/tmp/fly2519-native-tui-socket-${process.pid}.json`,
		`${JSON.stringify(result, null, 2)}\n`,
	);
	console.log(JSON.stringify(result));
}
