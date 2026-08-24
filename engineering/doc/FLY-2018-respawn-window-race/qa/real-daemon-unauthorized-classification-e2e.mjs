// FLY-2018 independent QA: real Codex daemon, UNPATCHED production path.
// Proves the whole Fix A chain on real inputs: real `codex app-server` emits a
// revoked-token turn failure -> production `runGoalToTerminal` attributes it via
// the real `turn/start` response id -> production `classifyGoalOutcome` yields
// the sanitized reason plus failureClass/failureCode the engine breaker reads.
import { spawnCodexDaemon } from "../../../../packages/claude-runner/dist/codex-daemon-runtime.js";
import { connectDaemonTransport } from "../../../../packages/claude-runner/dist/codex-daemon-transport.js";
import {
	CodexDaemonClient,
	runGoalToTerminal,
} from "../../../../packages/claude-runner/dist/codex-daemon-client.js";
import { classifyGoalOutcome } from "../../../../packages/claude-runner/dist/codex-daemon-adapter-helpers.js";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const codexBin = process.env.FLY2018_CODEX_BIN ?? join(homedir(), ".local", "bin", "codex");
const sourceHome = process.env.FLY2018_CODEX_SOURCE_HOME ?? join(homedir(), ".codex");
const scratch = mkdtempSync(join(tmpdir(), "fly2018-cls-"));
const codexHome = join(scratch, "ch");
const worktree = join(scratch, "w");
const socketDir = join(scratch, "s");
const socketPath = join(socketDir, "c.sock");
const daemonTmp = join(scratch, "t");

mkdirSync(codexHome, { recursive: true, mode: 0o700 });
mkdirSync(worktree, { recursive: true });
mkdirSync(socketDir, { recursive: true, mode: 0o700 });
mkdirSync(daemonTmp, { recursive: true, mode: 0o700 });
copyFileSync(join(sourceHome, "config.toml"), join(codexHome, "config.toml"));

const auth = JSON.parse(readFileSync(join(sourceHome, "auth.json"), "utf8"));
const jwt = auth.tokens.access_token.split(".");
if (jwt.length !== 3) throw new Error("source access token is not a JWT");
const payload = JSON.parse(Buffer.from(jwt[1], "base64url").toString("utf8"));
payload.exp = 1;
payload.iat = 1;
jwt[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
auth.tokens.access_token = jwt.join(".");
auth.tokens.refresh_token = "fly2018-qa-intentionally-revoked";
auth.last_refresh = "1970-01-01T00:00:01.000Z";
writeFileSync(join(codexHome, "auth.json"), `${JSON.stringify(auth)}\n`, { mode: 0o600 });
writeFileSync(join(worktree, "README.md"), "FLY-2018 QA classification probe\n");

let daemon;
let transport;
let result;
try {
	daemon = await spawnCodexDaemon({
		codexBin,
		codexHome,
		socketPath,
		sandboxWritableRoots: [worktree, scratch],
		sandboxNetworkAccess: true,
		env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: daemonTmp },
		logger: () => {},
	});
	transport = await connectDaemonTransport({ socketPath });
	const client = new CodexDaemonClient({ transport, logger: () => {} });
	await client.initialize();
	const threadId = await client.startThread({
		cwd: worktree,
		sandbox: "workspace-write",
		approvalPolicy: "never",
		baseInstructions: "Isolated QA probe. Reply with DONE.",
	});
	// NOTE: startTurn is NOT patched here — this is the exact production seam.
	result = await runGoalToTerminal(client, {
		threadId,
		objective: "Observe one isolated revoked-token turn failure, then stop.",
		kickText: "Reply with DONE.",
		overallTimeoutMs: 90_000,
		pollIntervalMs: 1_000,
	});
} finally {
	try { transport?.close(); } catch {}
	try { daemon?.stop(); await daemon?.ensureDead(); } catch {}
	rmSync(scratch, { recursive: true, force: true });
}

const cls = classifyGoalOutcome({ outcome: { result }, lastMessage: undefined });
console.log("goal status        :", result.status);
console.log("lastTurnError.code :", result.lastTurnError?.code);
console.log("lastTurnError.msg  :", JSON.stringify(result.lastTurnError?.message));
console.log("failureReason      :", JSON.stringify(cls.failureReason));
console.log("failureClass       :", cls.failureClass);
console.log("failureCode        :", cls.failureCode);

const checks = [
	["goal is blocked (real revoked-token failure reproduced)", result.status === "blocked"],
	["turn error attributed via production startTurn seam", result.lastTurnError?.code === "unauthorized"],
	["failureReason carries the real cause (no longer the fixed 'blocked' text only)",
		typeof cls.failureReason === "string" && cls.failureReason.includes("last turn error:") && cls.failureReason.includes("[unauthorized]")],
	["failureReason is single-line + bounded (sanitizer applied)",
		!/[\n\r`]/.test(cls.failureReason ?? "")],
	["failureClass = environment", cls.failureClass === "environment"],
	["failureCode = codex:unauthorized", cls.failureCode === "codex:unauthorized"],
];
console.log("\n=== VERDICT ===");
let ok = true;
for (const [label, pass] of checks) {
	console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
	if (!pass) ok = false;
}
process.exit(ok ? 0 : 1);
