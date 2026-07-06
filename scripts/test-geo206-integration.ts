#!/usr/bin/env npx tsx
/**
 * GEO-206 Integration Test
 *
 * Verifies the full chain:
 *   projects.json → leadId resolution → Blueprint prompt injection → TmuxAdapter env
 *
 * Does NOT launch a real Claude session — uses a spy adapter to capture what
 * would be passed to tmux.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "../packages/core/dist/adapter-types.js";
import { Blueprint } from "../packages/edge-worker/dist/Blueprint.js";
import type { GitResultChecker } from "../packages/edge-worker/dist/GitResultChecker.js";
import { PreHydrator } from "../packages/edge-worker/dist/PreHydrator.js";
import {
	loadProjects,
	resolveLeadForIssue,
} from "../packages/teamlead/dist/ProjectConfig.js";

// ── Colors ──
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string) {
	if (condition) {
		console.log(`  ${green("✓")} ${label}`);
		passed++;
	} else {
		console.log(`  ${red("✗")} ${label}${detail ? ` — ${detail}` : ""}`);
		failed++;
	}
}

// ── Test 1: Projects Config + leadId Resolution ──
console.log(bold("\n=== Test 1: Projects Config + leadId Resolution ===\n"));

const projects = loadProjects();
assert(projects.length > 0, "loadProjects() returns at least one project");

const geoforge = projects.find((p) => p.projectName === "geoforge3d");
assert(geoforge !== undefined, 'Found "geoforge3d" in projects config');

if (geoforge) {
	const result = resolveLeadForIssue(projects, "geoforge3d", ["Product"]);
	assert(
		result.lead.agentId === "product-lead",
		`Product label → product-lead (got: ${result.lead.agentId})`,
	);
	assert(
		result.matchMethod === "label",
		`Match method is "label" (got: ${result.matchMethod})`,
	);

	const opsResult = resolveLeadForIssue(projects, "geoforge3d", ["Operations"]);
	assert(
		opsResult.lead.agentId === "ops-lead",
		`Operations label → ops-lead (got: ${opsResult.lead.agentId})`,
	);

	const noLabelResult = resolveLeadForIssue(projects, "geoforge3d", []);
	assert(
		noLabelResult.matchMethod === "general",
		`No label → general match (got: ${noLabelResult.matchMethod})`,
	);
}

// ── Test 2: Blueprint System Prompt Injection ──
console.log(bold("\n=== Test 2: Blueprint System Prompt Injection ===\n"));

let capturedCtx: AdapterExecutionContext | undefined;

const spyAdapter: IAdapter = {
	type: "spy",
	supportsStreaming: false,
	checkEnvironment: async () => ({ healthy: true, message: "spy" }),
	execute: async (
		ctx: AdapterExecutionContext,
	): Promise<AdapterExecutionResult> => {
		capturedCtx = ctx;
		return { success: true, sessionId: "spy-session", durationMs: 100 };
	},
};

const mockGitChecker = {
	assertCleanTree: async () => {},
	captureBaseline: async () => "abc123",
	check: async () => ({
		commitCount: 1,
		filesChanged: 1,
		commitMessages: ["test"],
	}),
} as unknown as GitResultChecker;

const hydrator = new PreHydrator(async (id: string) => ({
	title: `Test issue ${id}`,
	description: "Integration test for GEO-206",
	labels: ["Product"],
	identifier: id,
}));

const blueprint = new Blueprint(hydrator, mockGitChecker, () => spyAdapter, {
	execFile: async () => ({ stdout: "", exitCode: 0 }),
});

const executionId = randomUUID();
const ctx = {
	teamName: "eng",
	runnerName: "claude",
	projectName: "geoforge3d",
	executionId,
	leadId: "product-lead",
};

// Set up a temp git repo for Blueprint
const testDir = "/tmp/flywheel-geo206-integration-test";
rmSync(testDir, { recursive: true, force: true });
mkdirSync(testDir, { recursive: true });
execFileSync("git", ["init"], { cwd: testDir, stdio: "pipe" });
execFileSync("git", ["config", "user.email", "test@test.com"], {
	cwd: testDir,
	stdio: "pipe",
});
execFileSync("git", ["config", "user.name", "test"], {
	cwd: testDir,
	stdio: "pipe",
});
execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
	cwd: testDir,
	stdio: "pipe",
});

try {
	await blueprint.run({ id: "GEO-TEST", blockedBy: [] }, testDir, ctx);
} catch {
	// May fail on git checks — that's OK, we just need the adapter call
}

if (capturedCtx) {
	const prompt = capturedCtx.appendSystemPrompt ?? "";

	assert(
		prompt.includes("flywheel-comm"),
		"System prompt contains 'flywheel-comm'",
	);
	assert(
		prompt.includes("product-lead"),
		"System prompt contains 'product-lead'",
	);
	assert(prompt.includes("ask"), "System prompt contains 'ask' command");
	assert(prompt.includes("check"), "System prompt contains 'check' command");
	assert(
		!prompt.includes("Do not ask questions"),
		"System prompt does NOT contain 'Do not ask questions'",
	);

	assert(capturedCtx.commDbPath !== undefined, "commDbPath is set");
	if (capturedCtx.commDbPath) {
		assert(
			capturedCtx.commDbPath.includes(".flywheel/comm/geoforge3d/comm.db"),
			`commDbPath contains correct project path (got: ${capturedCtx.commDbPath})`,
		);
	}

	// Verify CLI path is absolute and points to flywheel-comm
	const cliPathMatch = prompt.match(/node\s+(\S+flywheel-comm\S+)/);
	if (cliPathMatch) {
		const cliPath = cliPathMatch[1]!;
		assert(cliPath.startsWith("/"), `CLI path is absolute (got: ${cliPath})`);
		assert(
			cliPath.includes("flywheel-comm/dist/index.js"),
			"CLI path points to flywheel-comm dist",
		);
		assert(existsSync(cliPath), `CLI binary exists at ${cliPath}`);
	} else {
		assert(false, "Could not extract CLI path from prompt");
	}
} else {
	assert(
		false,
		"Adapter was never called — Blueprint may have failed before reaching adapter",
	);
}

// Save the leadId context for Phase 2 tests (Test 11, 12)
const capturedCtxWithLead = capturedCtx;

// ── Test 3: Without leadId (backward compat) ──
console.log(bold("\n=== Test 3: Without leadId (backward compat) ===\n"));

capturedCtx = undefined;
const ctxNoLead = {
	teamName: "eng",
	runnerName: "claude",
	projectName: "geoforge3d",
	executionId: randomUUID(),
};

try {
	await blueprint.run({ id: "GEO-TEST-2", blockedBy: [] }, testDir, ctxNoLead);
} catch {
	// OK
}

if (capturedCtx) {
	const prompt = capturedCtx.appendSystemPrompt ?? "";
	assert(
		prompt.includes("Do not ask questions"),
		"Without leadId: keeps 'Do not ask questions'",
	);
	assert(
		!prompt.includes("flywheel-comm"),
		"Without leadId: no flywheel-comm in prompt",
	);
	assert(
		capturedCtx.commDbPath === undefined,
		"Without leadId: commDbPath is undefined",
	);
} else {
	assert(false, "Adapter was never called for no-leadId case");
}

// ── Test 4: flywheel-comm CLI binary ──
console.log(bold("\n=== Test 4: flywheel-comm CLI binary ===\n"));

const commCliPath = join(process.cwd(), "packages/flywheel-comm/dist/index.js");
assert(existsSync(commCliPath), `flywheel-comm CLI exists at ${commCliPath}`);

try {
	const helpOutput = execFileSync("node", [commCliPath, "--help"], {
		encoding: "utf-8",
	});
	assert(helpOutput.includes("ask"), "CLI --help shows 'ask' command");
	assert(helpOutput.includes("check"), "CLI --help shows 'check' command");
	assert(helpOutput.includes("pending"), "CLI --help shows 'pending' command");
	assert(helpOutput.includes("respond"), "CLI --help shows 'respond' command");
} catch (e) {
	assert(false, `CLI --help failed: ${(e as Error).message}`);
}

// ── Test 5: claude-lead.sh project name resolution ──
console.log(bold("\n=== Test 5: claude-lead.sh project name resolution ===\n"));

try {
	const resolved = execFileSync(
		"node",
		[
			"-e",
			`import('file://${join(process.cwd(), "packages/teamlead/dist/ProjectConfig.js")}').then(({loadProjects}) => { const m = loadProjects().find(e => e.projectRoot === '/Users/xiaorongli/Dev/geoforge3d'); if (m) process.stdout.write(m.projectName); }).catch(() => {});`,
		],
		{ encoding: "utf-8" },
	);
	assert(
		resolved === "geoforge3d",
		`claude-lead.sh resolves to "geoforge3d" (got: "${resolved}")`,
	);
} catch (e) {
	assert(false, `claude-lead.sh resolution failed: ${(e as Error).message}`);
}

// ══════════════════════════════════════════════════════════
// Phase 2 Tests
// ══════════════════════════════════════════════════════════

// ── Test 6: Schema migration (read_at + sessions table) ──
console.log(bold("\n=== Test 6: Schema Migration ===\n"));

const { CommDB } = await import("../packages/flywheel-comm/dist/db.js");

const migrationDbPath = join(testDir, "migration-test.db");
const migDb = new CommDB(migrationDbPath);

try {
	const cols = (migDb as any).db
		.prepare("PRAGMA table_info(messages)")
		.all() as Array<{ name: string }>;
	assert(
		cols.some((c: { name: string }) => c.name === "read_at"),
		"messages table has read_at column",
	);
} catch (e) {
	assert(false, `read_at column check failed: ${(e as Error).message}`);
}

try {
	const tables = (migDb as any).db
		.prepare("SELECT name FROM sqlite_master WHERE type='table'")
		.all() as Array<{ name: string }>;
	assert(
		tables.some((t: { name: string }) => t.name === "sessions"),
		"sessions table exists",
	);
} catch (e) {
	assert(false, `sessions table check failed: ${(e as Error).message}`);
}
migDb.close();

// ── Test 7: Instruction round-trip ──
console.log(bold("\n=== Test 7: Instruction Round-trip ===\n"));

const instrDbPath = join(testDir, "instruction-test.db");
const instrDb = new CommDB(instrDbPath);

const instId = instrDb.insertInstruction(
	"product-lead",
	"exec-abc",
	"先改 B 文件",
);
assert(
	typeof instId === "string" && instId.length > 0,
	"insertInstruction returns ID",
);

const unread = instrDb.getUnreadInstructions("exec-abc");
assert(
	unread.length === 1,
	`getUnreadInstructions returns 1 (got ${unread.length})`,
);
assert(unread[0]!.content === "先改 B 文件", "Instruction content matches");
assert(unread[0]!.type === "instruction", "Message type is 'instruction'");

instrDb.markInstructionRead(instId);
assert(
	instrDb.getUnreadInstructions("exec-abc").length === 0,
	"After markRead, no unread instructions",
);

instrDb.insertInstruction("ops-lead", "exec-abc", "Check logs");
instrDb.insertInstruction("product-lead", "exec-def", "For another runner");
assert(
	instrDb.getUnreadInstructions("exec-abc").length === 1,
	"exec-abc sees only its instruction",
);
assert(
	instrDb.getUnreadInstructions("exec-def").length === 1,
	"exec-def sees only its instruction",
);
instrDb.close();

// ── Test 8: Session registration ──
console.log(bold("\n=== Test 8: Session Registration ===\n"));

const sessDbPath = join(testDir, "session-test.db");
const sessDb = new CommDB(sessDbPath);

sessDb.registerSession(
	"exec-1",
	"flywheel:@42",
	"geoforge3d",
	"GEO-208",
	"product-lead",
);
sessDb.registerSession("exec-2", "flywheel:@43", "geoforge3d", "GEO-209");

const sess1 = sessDb.getSession("exec-1");
assert(sess1 !== undefined, "getSession returns session");
assert(sess1!.tmux_window === "flywheel:@42", `tmux_window stores full target`);
assert(sess1!.status === "running", "Initial status is 'running'");
assert(sess1!.project_name === "geoforge3d", "project_name correct");
assert(sess1!.issue_id === "GEO-208", "issue_id correct");
assert(sess1!.lead_id === "product-lead", "lead_id correct");

assert(
	sessDb.getActiveSessions("geoforge3d").length === 2,
	"2 active sessions",
);

sessDb.updateSessionStatus("exec-1", "completed");
assert(sessDb.getSession("exec-1")!.status === "completed", "Status updated");
assert(sessDb.getSession("exec-1")!.ended_at !== null, "ended_at set");
assert(
	sessDb.getActiveSessions("geoforge3d").length === 1,
	"1 active after completion",
);

const allSess = sessDb.listSessions("geoforge3d");
assert(allSess.length === 2, "listSessions returns all statuses");

const runOnly = sessDb.listSessions(undefined, ["running"]);
assert(runOnly.length === 1, "listSessions filter by running");
sessDb.close();

// ── Test 9: hasPendingQuestionsFrom ──
console.log(bold("\n=== Test 9: hasPendingQuestionsFrom ===\n"));

const pendDbPath = join(testDir, "pending-from-test.db");
const pendDb = new CommDB(pendDbPath);

const qId = pendDb.insertQuestion("exec-xyz", "product-lead", "Which API?");
assert(pendDb.hasPendingQuestionsFrom("exec-xyz"), "true for asking runner");
assert(!pendDb.hasPendingQuestionsFrom("other-exec"), "false for other runner");

pendDb.insertResponse(qId, "product-lead", "Use v3");
assert(!pendDb.hasPendingQuestionsFrom("exec-xyz"), "false after response");
pendDb.close();

// ── Test 10: openReadonly ──
console.log(bold("\n=== Test 10: CommDB.openReadonly ===\n"));

const roDbPath = join(testDir, "readonly-test.db");
const roWriter = new CommDB(roDbPath);
roWriter.insertQuestion("runner-1", "lead", "Q?");

const roReader = CommDB.openReadonly(roDbPath);
assert(
	roReader.hasPendingQuestionsFrom("runner-1"),
	"openReadonly reads pending",
);

const roQid = roWriter.getPendingQuestions("lead")[0]!.id;
roWriter.insertResponse(roQid, "lead", "A");
assert(
	!roReader.hasPendingQuestionsFrom("runner-1"),
	"openReadonly sees response",
);
roReader.close();
roWriter.close();

// ── Test 11: Blueprint prompt contains inbox ──
console.log(bold("\n=== Test 11: Blueprint Prompt — inbox ===\n"));

if (capturedCtxWithLead) {
	const prompt = capturedCtxWithLead.appendSystemPrompt ?? "";
	assert(prompt.includes("inbox"), "System prompt contains 'inbox'");
	assert(
		prompt.includes("proactive instructions"),
		"System prompt mentions proactive instructions",
	);
	assert(
		prompt.includes("task boundaries"),
		"System prompt mentions task boundaries",
	);
} else {
	assert(false, "No captured context for inbox test");
}

// ── Test 12: Adapter context Phase 2 fields ──
console.log(bold("\n=== Test 12: Adapter Context — Phase 2 ===\n"));

if (capturedCtxWithLead) {
	assert(
		capturedCtxWithLead.waitingTimeoutMs === 14_400_000,
		`waitingTimeoutMs is 4h (got: ${capturedCtxWithLead.waitingTimeoutMs})`,
	);
	assert(
		capturedCtxWithLead.leadId === "product-lead",
		`leadId passed (got: ${capturedCtxWithLead.leadId})`,
	);
	assert(
		capturedCtxWithLead.projectName === "geoforge3d",
		`projectName passed (got: ${capturedCtxWithLead.projectName})`,
	);
} else {
	assert(false, "No captured context for Phase 2 fields test");
}

// ── Test 13: CLI --help Phase 2 commands ──
console.log(bold("\n=== Test 13: CLI --help Phase 2 ===\n"));

try {
	const helpOutput = execFileSync("node", [commCliPath, "--help"], {
		encoding: "utf-8",
	});
	assert(helpOutput.includes("send"), "CLI --help shows 'send'");
	assert(helpOutput.includes("inbox"), "CLI --help shows 'inbox'");
	assert(helpOutput.includes("sessions"), "CLI --help shows 'sessions'");
	assert(helpOutput.includes("capture"), "CLI --help shows 'capture'");
} catch (e) {
	assert(false, `CLI --help Phase 2 failed: ${(e as Error).message}`);
}

// ── Summary ──
console.log(bold("\n=== Summary ===\n"));
console.log(
	`  ${green(`${passed} passed`)}, ${failed > 0 ? red(`${failed} failed`) : "0 failed"}`,
);
console.log();

// Cleanup
rmSync(testDir, { recursive: true, force: true });

process.exit(failed > 0 ? 1 : 0);
