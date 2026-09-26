// FLY-2886 QA@4 D1: does a real-host background turn reach lead_operation?
// No provider stubs; real codex 0.156.1; subscription auth by realpath to the
// production auth.json; production-length voice root; the capability process
// is started with the container's exact argv and thread/start parameters.
// GUIDE=off reproduces the QA@4 head (no lead-operation guide in the brief).
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const WT = "/Users/xiaorongli/Dev/flywheel-FLY-2886";
const { startVoiceCapabilityParent } = await import(`${WT}/packages/teamlead/dist/lead-capabilities/voice-capability-parent.js`);
const { bindAdmittedVoiceCapabilities } = await import(`${WT}/packages/teamlead/dist/lead-capabilities/voice-capability-brief.js`);
const { CAPABILITY_FEATURE_ARGV } = await import(`${WT}/packages/voice-codex/dist/codex/CodexVoiceContainer.js`);
const dir = (p) => (mkdirSync(p, { recursive: true, mode: 0o700 }), chmodSync(p, 0o700), p);
const voiceRoot = join(homedir(), ".flywheel", "voic4");
const containers = dir(join(voiceRoot, "codex-containers"));
const container = realpathSync(mkdtempSync(join(containers, "container-")));
const admission = dir(join(container, "admission"));
const codexHome = dir(join(admission, "home"));
const activation = realpathSync(mkdtempSync(join(realpathSync("/tmp"), "fw-vcap-")));
const base = realpathSync(mkdtempSync(join(homedir(), ".flywheel", "fly2886-qa4-")));
const home = dir(join(base, "home"));
dir(join(home, ".flywheel"));
const head = execFileSync("/usr/bin/git", ["-C", WT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
writeFileSync(join(home, ".flywheel", "deployed-sha"), `${head}\n`, { mode: 0o644 });
writeFileSync(join(home, ".flywheel", "summary-config.json"), JSON.stringify({ granularity: "per-lead", setBy: "smoke", setAt: new Date().toISOString() }));
const project = dir(join(base, "project"));
execFileSync("/usr/bin/git", ["init", "-q", project]);
const LEAD = "flywheel-eng-lead";
dir(join(project, ".lead", LEAD));
writeFileSync(join(project, ".lead", LEAD, "identity.md"), "# Smoke Lead\n\nFLY-2886 QA@4 probe persona.\n");
for (const name of ["config.yaml", "menus", "agents", "templates"]) cpSync(`${WT}/.flywheel/${name}`, join(project, ".flywheel", name), { recursive: true });
const projectsPath = join(base, "projects.json");
writeFileSync(projectsPath, JSON.stringify([{ projectName: "flywheel", projectRoot: project, projectRepo: "acme/smoke",
	leads: [{ agentId: LEAD, summaryRole: "producer", backend: "claude-code", chatChannel: "12345678901234567", match: { labels: ["Smoke"] }, voiceBackground: { enabled: true, browser: "off" } }] }]));
const state = dir(join(base, "state"));
const realAuth = realpathSync(join(homedir(), ".codex", "auth.json"));
const codexBin = join(homedir(), ".flywheel/codex-standalone/0.156.1/bin/codex");
const env = { PATH: process.env.PATH, HOME: home, LANG: "en_US.UTF-8", FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:9", FLYWHEEL_API_TOKEN: "smoke-token" };
const out = (o) => console.log(JSON.stringify(o));
const guide = process.env.GUIDE ?? "on";
const prompt = process.env.PROMPT ?? "查一下 Bridge 上 FLY-2886 这张单现在的状态，用一句话告诉我。";
let parent;
let proc;
try {
	parent = await startVoiceCapabilityParent({ projectName: "flywheel", leadId: LEAD, sessionId: "11111111-2222-4333-8444-555555555555",
		leaseFence: "smoke-fence", browserMode: "off", codexHome, codexBin, activationRoot: activation, projectsPath, stateDir: state,
		authSourcePath: realAuth, assertLeaseCurrent: () => {}, env });
	out({ parent: "OK", operations: parent.manifest.operationIds.length, unavailable: parent.manifest.unavailableIntegrations });
	const header = "[voice-context version=1 snapshotDigest=probe sessionId=11111111-2222-4333-8444-555555555555]";
	const snapshot = { snapshotDigest: "probe", manifest: { snapshotDigest: "probe" }, baseInstructions: `${header}\n你是语音会话的后台 agent，替 Lead 查事和动手。`, realtimePrompt: `${header}\nfront`,
		measurements: { baseInstructions: { bytes: 0, estimatedTokens: 0 }, realtimePrompt: { bytes: 0, estimatedTokens: 0 } } };
	let developer = snapshot.baseInstructions;
	if (guide === "on") developer = bindAdmittedVoiceCapabilities(snapshot, parent.manifest).baseInstructions;
	const { CodexLeadProcess, spawnCodexAppServer } = await import(`${WT}/packages/teamlead/dist/codex-process.js`);
	const work = dir(join(admission, "work"));
	proc = new CodexLeadProcess({
		spawnChild: () => spawnCodexAppServer({ codexBin, mcpArgv: [...parent.permissionArgv, ...parent.mcp.argv, ...(process.env.PLUGIN_FLAGS === "off" ? ["-c", "features.apps=false"] : CAPABILITY_FEATURE_ARGV)], codexHome, cwd: parent.cwd,
			baseEnv: { HOME: codexHome, TMPDIR: work, PATH: process.env.PATH, LANG: "en_US.UTF-8" },
			voiceProfile: { openAiApiKey: "smoke-not-used" }, profile: "voice-capability", capabilityModelEnv: parent.capabilityModelEnv }),
		experimentalApi: true, knownServerMethods: [], requestTimeoutMs: 120000, maxJsonLineBytes: 1024 * 1024,
		shutdownGraceMs: 50, shutdownTermMs: 5000, shutdownKillMs: 5000, clientInfo: { name: "flywheel-voice-codex", version: "0.1.0" } });
	const items = [];
	let done;
	const finished = new Promise((r) => (done = r));
	proc.on("notification", (method, params) => {
		if (method === "turn/started") { try { parent.beginTurn(params.threadId, params.turn?.id ?? params.turnId); } catch (e) { out({ beginTurn: e.message }); } }
		if (method === "item/completed") {
			const it = params.item ?? {};
			const brief = { type: it.type };
			for (const k of ["server", "input", "status", "tool", "status", "text", "code", "output", "arguments", "result", "error", "aggregatedOutput", "exitCode"]) if (it[k] !== undefined) brief[k] = typeof it[k] === "string" ? it[k].slice(0, 600) : JSON.stringify(it[k]).slice(0, 600);
			items.push(brief);
			out({ item: brief });
		}
		if (method === "turn/completed") { try { parent.endTurn(params.turn?.id ?? params.turnId, "completed"); } catch {} done(params); }
	});
	await proc.start();
	const cfg = await proc.request("config/read", { cwd: parent.cwd, includeLayers: false });
	const feats = cfg.result?.config?.features ?? {};
	out({ pluginFlags: process.env.PLUGIN_FLAGS ?? "on", features: { apps: feats.apps, plugins: feats.plugins, remote_plugin: feats.remote_plugin } });
	const sk = await proc.request("skills/list", { cwds: [parent.cwd], forceReload: true });
	try { await parent.verifyEffectiveSkills(sk.result, parent.cwd); out({ skillsAtStart: "verified" }); } catch (e) { out({ skillsAtStart: e.message }); }
	const opened = await proc.startThreadWithResult({ cwd: parent.cwd, approvalPolicy: "never", permissions: "flywheel-lead-v2", ephemeral: true,
		environments: process.env.ENVS === "omit" ? undefined : [], baseInstructions: parent.baseInstructions, developerInstructions: developer,
		config: { "features.realtime_conversation": true, ...(process.env.CODE_MODE ? { "features.code_mode": true, "features.code_mode_only": process.env.CODE_MODE === "only" } : {}) } });
	out({ thread: opened.id, guide });
	const t0 = Date.now();
	await proc.startTurn({ threadId: opened.id, input: [{ type: "text", text: prompt, text_elements: [] }] });
	const turn = await Promise.race([finished, new Promise((r) => setTimeout(() => r({ timeout: true }), 240000))]);
	out({ turnDone: turn?.turn?.status ?? turn, ms: Date.now() - t0, itemTypes: items.map((i) => i.type) });
	const dbs = execFileSync("/usr/bin/find", [activation, state, codexHome, "-name", "*.db"], { encoding: "utf8" }).split("\n").filter(Boolean);
	const receipts = dbs.map((db) => { try { return `${db.replace(homedir(), "~")}=${execFileSync("/usr/bin/sqlite3", [db, "select operation_id||':'||state from lead_operation_receipts"], { encoding: "utf8" }).trim().replace(/\n/g, ",")}`; } catch { return null; } }).filter(Boolean);
	out({ leadOperationReceipts: receipts });
	out({ pluginsDirPresent: existsSync(join(codexHome, "plugins")), pluginCache: existsSync(join(codexHome, "plugins", "cache")) ? readdirSync(join(codexHome, "plugins", "cache")) : [] });
	const sk2 = await proc.request("skills/list", { cwds: [parent.cwd], forceReload: true });
	try { await parent.verifyEffectiveSkills(sk2.result, parent.cwd); out({ skillsAfterTurn: "verified" }); } catch (e) { out({ skillsAfterTurn: e.message }); }
} catch (error) {
	out({ error: error?.message, stack: error?.stack?.split("\n").slice(0, 4) });
} finally {
	await proc?.stop().catch(() => {});
	await parent?.close().catch(() => {});
	rmSync(base, { recursive: true, force: true });
	rmSync(voiceRoot, { recursive: true, force: true });
	rmSync(activation, { recursive: true, force: true });
}
