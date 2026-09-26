// FLY-2886 QA@3 B1: real-host voice parent under a production-length voice root.
// No provider stubs; real codex 0.156.1; subscription auth by realpath to the
// production auth.json. LAYOUT=old keeps the activation root inside the admission
// directory (the QA@3 failure); LAYOUT=new uses the container's short /tmp root.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const WT = "/Users/xiaorongli/Dev/flywheel-FLY-2886";
const { startVoiceCapabilityParent } = await import(`${WT}/packages/teamlead/dist/lead-capabilities/voice-capability-parent.js`);
const dir = (p) => (mkdirSync(p, { recursive: true, mode: 0o700 }), chmodSync(p, 0o700), p);
// Same byte length as production "<HOME>/.flywheel/voice"; never the live voice root.
const voiceRoot = join(homedir(), ".flywheel", "voic3");
if (Buffer.byteLength(voiceRoot) !== Buffer.byteLength(join(homedir(), ".flywheel", "voice"))) throw new Error("length");
const containers = dir(join(voiceRoot, "codex-containers"));
const container = realpathSync(mkdtempSync(join(containers, "container-")));
const admission = dir(join(container, "admission"));
const codexHome = dir(join(admission, "home"));
const layout = process.env.LAYOUT ?? "new";
const activation = layout === "old" ? dir(join(admission, "activation")) : realpathSync(mkdtempSync(join(realpathSync("/tmp"), "fw-vcap-")));
// Fake HOME / project / state outside the measured paths (same as the v12 smoke).
const base = realpathSync(mkdtempSync(join(homedir(), ".flywheel", "fly2886-qa3-")));
const home = dir(join(base, "home"));
dir(join(home, ".flywheel"));
const head = execFileSync("/usr/bin/git", ["-C", WT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
writeFileSync(join(home, ".flywheel", "deployed-sha"), `${head}\n`, { mode: 0o644 });
writeFileSync(join(home, ".flywheel", "summary-config.json"), JSON.stringify({ granularity: "per-lead", setBy: "smoke", setAt: new Date().toISOString() }));
const project = dir(join(base, "project"));
execFileSync("/usr/bin/git", ["init", "-q", project]);
const LEAD = "flywheel-eng-lead";
dir(join(project, ".lead", LEAD));
writeFileSync(join(project, ".lead", LEAD, "identity.md"), "# Smoke Lead\n\nFLY-2886 QA@3 prod-length smoke persona.\n");
for (const name of ["config.yaml", "menus", "agents", "templates"]) cpSync(`${WT}/.flywheel/${name}`, join(project, ".flywheel", name), { recursive: true });
const projectsPath = join(base, "projects.json");
writeFileSync(projectsPath, JSON.stringify([{ projectName: "flywheel", projectRoot: project, projectRepo: "acme/smoke",
	leads: [{ agentId: LEAD, summaryRole: "producer", backend: "claude-code", chatChannel: "12345678901234567", match: { labels: ["Smoke"] }, voiceBackground: { enabled: true, browser: "off" } }] }]));
const state = dir(join(base, "state"));
const realAuth = realpathSync(join(homedir(), ".codex", "auth.json"));
const codexBin = join(homedir(), ".flywheel/codex-standalone/0.156.1/bin/codex");
const env = { PATH: process.env.PATH, HOME: home, LANG: "en_US.UTF-8", FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9", FLYWHEEL_API_TOKEN: "smoke-token" };
const socketBytes = Buffer.byteLength(join(activation, "run-XXXXXX", "broker.sock"));
const t0 = Date.now();
try {
	const parent = await startVoiceCapabilityParent({ projectName: "flywheel", leadId: LEAD, sessionId: "11111111-2222-4333-8444-555555555555",
		leaseFence: "smoke-fence", browserMode: "off", codexHome, codexBin, activationRoot: activation, projectsPath, stateDir: state,
		authSourcePath: realAuth, assertLeaseCurrent: () => {}, env });
	const link = join(codexHome, "auth.json");
	console.log(JSON.stringify({ layout, result: "PARENT_OK", ms: Date.now() - t0, voiceRootBytes: Buffer.byteLength(voiceRoot),
		codexHomeBytes: Buffer.byteLength(codexHome), activationRoot: activation.replace(homedir(), "~"), socketBytes,
		operations: parent.manifest.operationIds.length, unavailableIntegrations: parent.manifest.unavailableIntegrations,
		authInodeMatchesProduction: lstatSync(link).isSymbolicLink() && statSync(link).ino === statSync(realAuth).ino, mcp: parent.mcp.included }));
	const { CodexLeadProcess, spawnCodexAppServer } = await import(`${WT}/packages/teamlead/dist/codex-process.js`);
	const work = dir(join(admission, "work"));
	const proc = new CodexLeadProcess({
		spawnChild: () => spawnCodexAppServer({ codexBin, mcpArgv: [...parent.permissionArgv, ...parent.mcp.argv, "-c", "features.apps=false"], codexHome, cwd: parent.cwd,
			baseEnv: { HOME: codexHome, TMPDIR: work, PATH: process.env.PATH, LANG: "en_US.UTF-8" },
			voiceProfile: { openAiApiKey: "smoke-not-used" }, profile: "voice-capability", capabilityModelEnv: parent.capabilityModelEnv }),
		experimentalApi: true, knownServerMethods: [], requestTimeoutMs: 60000, maxJsonLineBytes: 1024 * 1024,
		shutdownGraceMs: 50, shutdownTermMs: 5000, shutdownKillMs: 5000, clientInfo: { name: "flywheel-voice-codex", version: "0.1.0" } });
	const t1 = Date.now();
	await proc.start();
	const account = await proc.request("account/read", { refreshToken: false });
	const config = await proc.request("config/read", { cwd: parent.cwd, includeLayers: false });
	let configOk = "verified";
	try { await parent.verifyEffectiveConfig(config.result.config); } catch (e) { configOk = `mismatch:${e.message}`; }
	const skills = await proc.request("skills/list", { cwds: [parent.cwd], forceReload: true });
	let skillsOk = "verified";
	try { await parent.verifyEffectiveSkills(skills.result, parent.cwd); } catch (e) { skillsOk = `mismatch:${e.message}`; }
	const status = await proc.request("mcpServerStatus/list", { limit: 100 });
	const servers = (status.result?.data ?? []).map((row) => ({ name: row.name, tools: Array.isArray(row.tools) ? row.tools.length : Object.keys(row.tools ?? {}).length }));
	console.log(JSON.stringify({ layout, appServer: "STARTED", ms: Date.now() - t1, accountType: account.result?.account?.type, configOk, skillsOk, servers }));
	await proc.stop();
	await parent.close();
} catch (error) {
	console.log(JSON.stringify({ layout, result: "PARENT_ERR", ms: Date.now() - t0, socketBytes, message: error?.message }));
} finally {
	rmSync(base, { recursive: true, force: true });
	rmSync(voiceRoot, { recursive: true, force: true });
	if (layout !== "old") rmSync(activation, { recursive: true, force: true });
}
