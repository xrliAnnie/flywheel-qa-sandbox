#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
	classifyTestCommand,
	evaluateRunnerTestDiscipline,
	extractCommandEvents,
} from "./lib/runner-test-discipline.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const SUBJECT_RELATIVE = "packages/runner-test-discipline-fixture";
const FULL_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LINEAR_ISSUE_IDENTIFIER = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+$/;
export const DEFAULT_TIMEOUT_MS = 180 * 60_000;

export function isCanonicalIssueIdentifier(value) {
	return LINEAR_ISSUE_IDENTIFIER.test(value);
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

export function stableTreeHash(root) {
	const rows = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const path = join(dir, entry.name);
			const rel = relative(root, path).split(sep).join("/");
			if (rel === "node_modules" || rel.startsWith("node_modules/")) continue;
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) {
				rows.push(`${rel}\0${sha256(readFileSync(path))}`);
			} else throw new Error(`fixture contains a non-regular entry: ${path}`);
		}
	};
	walk(root);
	return sha256(rows.join("\n"));
}

function atomicJson(path, value) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.tmp.${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
	});
	renameSync(temporary, path);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function git(root, args) {
	return execFileSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function hashFiles(root, files) {
	return sha256(
		files
			.map((file) => `${file}\0${sha256(readFileSync(join(root, file)))}`)
			.join("\n"),
	);
}

export function promptTriggerFiles(root, head) {
	try {
		const base = git(root, ["merge-base", head, "origin/main"]);
		const changed = git(root, ["diff", "--name-only", `${base}..${head}`, "--"])
			.split("\n")
			.filter(Boolean);
		const triggers = changed.filter((file) =>
			/(?:^\.flywheel\/agents\/nodes\/|phase-protocols|codex-runner-contract|skill-templates|SkillInjector|runner-test-discipline|qa-framework\/agents)/.test(
				file,
			),
		);
		return { base, changed, triggers, historyComplete: true };
	} catch {
		return {
			base: null,
			changed: [],
			triggers: ["<history-unavailable:conservative-all-cells>"],
			historyComplete: false,
		};
	}
}

function fixtureSelection(packageRoot) {
	const oldValue = "claude-opus-5";
	const literalMatches = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (
				entry.isFile() &&
				/\.(?:ts|tsx|js|jsx)$/.test(entry.name) &&
				readFileSync(path, "utf8").includes(oldValue) &&
				/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
			) {
				literalMatches.push(relative(packageRoot, path).split(sep).join("/"));
			}
		}
	};
	walk(packageRoot);
	literalMatches.sort();
	return {
		literal: oldValue,
		replacement: "claude-opus-5.5",
		literalMatches,
		allowedTestFiles: literalMatches,
		excludedMatches: [],
		trustedNonTestScripts: [
			"packages/flywheel-comm/dist/index.js",
			`${SUBJECT_RELATIVE}/verify.mjs`,
			"verify.mjs",
			"codex-companion.mjs",
		],
	};
}

export async function prepareEvidence({
	head,
	fixture,
	out,
	repoRoot = DEFAULT_ROOT,
}) {
	const root = realpathSync(repoRoot);
	if (!FULL_SHA.test(head ?? "")) throw new Error("--head must be a full SHA");
	if (git(root, ["rev-parse", `${head}^{commit}`]) !== head) {
		throw new Error("--head does not resolve to the exact requested commit");
	}
	if (fixture !== "literal-migration-v1") {
		throw new Error("only --fixture literal-migration-v1 is supported");
	}
	const output = resolve(out);
	mkdirSync(output, { recursive: true, mode: 0o700 });
	const source = join(root, "scripts/fixtures/runner-test-discipline", fixture);
	const subjectSource = join(source, "package");
	if (!existsSync(subjectSource))
		throw new Error(`fixture is missing: ${source}`);
	const subject = join(output, "subject");
	if (existsSync(subject)) {
		throw new Error(`prepared subject already exists: ${subject}`);
	}
	cpSync(subjectSource, subject, { recursive: true, errorOnExist: true });
	cpSync(join(source, "task.md"), join(output, "task.md"), {
		errorOnExist: true,
	});
	const policyFiles = [
		"packages/teamlead/phase-protocols/local-test-policy.md",
		"packages/teamlead/phase-protocols/implement.md",
		"packages/teamlead/phase-protocols/qa.md",
		".flywheel/agents/nodes/engineer.md",
		"packages/claude-runner/agents/codex-runner-contract.md",
	];
	const promptFiles = [
		".flywheel/agents/nodes/implement.md",
		".flywheel/agents/nodes/qa.md",
		".flywheel/agents/nodes/engineer.md",
	];
	const skillFiles = [
		"engineering/doc/FLY-2802-runner-test-discipline/skill-audit.md",
		"packages/edge-worker/src/skill-templates/flywheel-tdd.ts",
		"packages/edge-worker/src/skill-templates/flywheel-git-workflow.ts",
		"packages/edge-worker/src/skill-templates/linear-issue-context.ts",
		"packages/edge-worker/src/skill-templates/flywheel-context.ts",
	];
	const trigger = promptTriggerFiles(root, head);
	const selection = fixtureSelection(subject);
	atomicJson(join(output, "selection.json"), selection);
	const manifest = {
		schemaVersion: 1,
		caseId: fixture,
		attemptId: randomUUID(),
		preparedAt: new Date().toISOString(),
		candidateHead: head,
		fixture,
		fixtureHash: stableTreeHash(subject),
		promptHash: hashFiles(root, promptFiles),
		promptFileHashes: Object.fromEntries(
			promptFiles.map((file) => [file, sha256(readFileSync(join(root, file)))]),
		),
		policyHash: hashFiles(root, policyFiles),
		skillInventoryHash: hashFiles(root, skillFiles),
		triggerBase: trigger.base,
		triggerHistoryComplete: trigger.historyComplete,
		triggerFiles: trigger.triggers,
		requiredCells: trigger.triggers.length ? ["A", "B", "C", "D"] : [],
		subjectDestination: SUBJECT_RELATIVE,
		taskFile: "task.md",
	};
	atomicJson(join(output, "manifest.json"), manifest);
	atomicJson(join(output, "recipe.json"), {
		schemaVersion: 1,
		steps: [
			`copy subject/ to ${SUBJECT_RELATIVE} on an isolated flywheel-qa-sandbox branch`,
			"create a QA-sandbox Linear issue whose body is task.md",
			"deploy each real room with --test-discipline --expect-head <candidateHead>",
			"run cells A, B, C, D with this CLI; do not approve or ship",
		],
	});
	return manifest;
}

function loadEvidenceCase(path) {
	const combined = join(path, "evidence.json");
	if (existsSync(combined)) return readJson(combined);
	const commandsPath = join(path, "commands.jsonl");
	return {
		manifest: readJson(join(path, "manifest.json")),
		commands: readFileSync(commandsPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line)),
		selection: readJson(join(path, "selection.json")),
		fixtureResult: readJson(join(path, "fixture-result.json")),
		sessions: readJson(join(path, "sessions.json")),
	};
}

export async function evaluateEvidenceDirectory(evidenceDir) {
	const root = realpathSync(evidenceDir);
	let paths;
	let observations = [];
	const casesPath = join(root, "cases.json");
	if (existsSync(casesPath)) {
		const listed = readJson(casesPath);
		observations = Array.isArray(listed.observations)
			? listed.observations
			: [];
		if (
			(!Array.isArray(listed.cases) || listed.cases.length === 0) &&
			observations.length === 0
		) {
			throw new Error(
				"cases.json must list evidence directories or observations",
			);
		}
		paths = (listed.cases ?? []).map((entry) => resolve(root, entry));
	} else {
		paths = [root];
	}
	const cases = paths.map((path) => {
		const result = evaluateRunnerTestDiscipline(loadEvidenceCase(path));
		return { path: relative(root, path) || ".", ...result };
	});
	const verdict =
		cases.some((item) => item.verdict === "FAIL") ||
		observations.some((item) => item.verdict === "FAIL")
			? "FAIL"
			: cases.length > 0 &&
					cases.every((item) => item.verdict === "PASS") &&
					observations.every((item) => item.verdict === "PASS")
				? "PASS"
				: "INCONCLUSIVE";
	const output = {
		schemaVersion: 1,
		verdict,
		evaluatedAt: new Date().toISOString(),
		cases,
		...(observations.length ? { observations } : {}),
	};
	atomicJson(join(root, "verdict.json"), output);
	return output;
}

function usage() {
	process.stderr.write(`Usage:
  node scripts/qa-runner-test-discipline.mjs prepare --head <sha> --fixture literal-migration-v1 --out <dir>
  node scripts/qa-runner-test-discipline.mjs run --slot <n> --issue <FLY-SBX-N> --head <sha> --role <implement|qa|engineer> --backend <claude|codex> --evidence <dir> [--cell A|B|C|D]
  node scripts/qa-runner-test-discipline.mjs collect --slot <n> --run-id <id> --head <sha> --cell <A|B> --evidence <dir>
  node scripts/qa-runner-test-discipline.mjs evaluate --evidence <dir>
`);
}

function parseArgs(argv) {
	const [command, ...rest] = argv;
	const values = {};
	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index];
		if (arg === "-h" || arg === "--help") return { command: "help", values };
		if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
		const value = rest[index + 1];
		if (!value || value.startsWith("--"))
			throw new Error(`${arg} requires a value`);
		values[arg.slice(2)] = value;
		index += 1;
	}
	return { command, values };
}

function required(values, name) {
	const value = values[name]?.trim();
	if (!value) throw new Error(`--${name} is required`);
	return value;
}

async function main() {
	const { command, values } = parseArgs(process.argv.slice(2));
	if (command === "help" || command === undefined) {
		usage();
		return;
	}
	if (command === "prepare") {
		const result = await prepareEvidence({
			head: required(values, "head"),
			fixture: required(values, "fixture"),
			out: required(values, "out"),
		});
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return;
	}
	if (command === "evaluate") {
		const result = await evaluateEvidenceDirectory(
			required(values, "evidence"),
		);
		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.exitCode =
			result.verdict === "PASS" ? 0 : result.verdict === "FAIL" ? 1 : 2;
		return;
	}
	if (command === "collect") {
		const result = await collectAcceptance(values);
		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.exitCode =
			result.verdict === "PASS" ? 0 : result.verdict === "FAIL" ? 1 : 2;
		return;
	}
	if (command === "run") {
		const result = await runAcceptance(values);
		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.exitCode =
			result.verdict === "PASS" ? 0 : result.verdict === "FAIL" ? 1 : 2;
		return;
	}
	throw new Error(`unknown command: ${command}`);
}

if (
	process.argv[1] &&
	realpathSync(process.argv[1]) === realpathSync(SCRIPT_PATH)
) {
	main().catch((error) => {
		process.stderr.write(`[qa-runner-test-discipline] ${error.message}\n`);
		process.exitCode = 2;
	});
}

function inside(parent, child) {
	const rel = relative(parent, child);
	return (
		rel === "" ||
		(rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
	);
}

function validateRoom(slot, candidateHead) {
	if (!Number.isInteger(slot) || slot < 1)
		throw new Error("--slot must be positive");
	const slotRoot = `/tmp/flywheel-test-slot-${slot}`;
	const roomPath = join(slotRoot, "room-info.json");
	if (!existsSync(roomPath) || lstatSync(roomPath).isSymbolicLink()) {
		throw new Error(`slot ${slot} has no plain room-info.json`);
	}
	if (realpathSync(dirname(roomPath)) !== realpathSync(slotRoot)) {
		throw new Error("room-info escaped its slot root");
	}
	const room = readJson(roomPath);
	if (
		room.schemaVersion !== 1 ||
		room.slot !== slot ||
		room.mode !== "slot" ||
		room.testDiscipline !== true ||
		room.runnerMode !== "real" ||
		room.projectName !== `test-slot-${slot}` ||
		room.buildSha !== candidateHead ||
		room.bridgeUrl !== `http://localhost:${room.port}`
	) {
		throw new Error(`room identity mismatch: ${JSON.stringify(room)}`);
	}
	const hostRepo = realpathSync(room.hostRepo);
	const dbPath = realpathSync(room.dbPath);
	if (
		!inside(realpathSync(slotRoot), hostRepo) ||
		!inside(realpathSync(slotRoot), dbPath)
	) {
		throw new Error("room paths escape the isolated slot");
	}
	if (!FULL_SHA.test(room.subjectBaseHead ?? "")) {
		throw new Error("room is missing the frozen subjectBaseHead");
	}
	return { ...room, roomPath, slotRoot, hostRepo, dbPath };
}

async function httpJson(url, options = {}) {
	const response = await fetch(url, options);
	const text = await response.text();
	let body;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = { raw: text };
	}
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${url}: ${JSON.stringify(body)}`);
	}
	return body;
}

function authHeaders(room) {
	const headers = { "content-type": "application/json" };
	if (room.apiTokenPath) {
		const tokenPath = realpathSync(room.apiTokenPath);
		if (!inside(realpathSync(room.slotRoot), tokenPath)) {
			throw new Error("room API token path escapes its slot");
		}
		const token = readFileSync(tokenPath, "utf8").trim();
		if (!token) throw new Error("room API token is empty");
		headers.authorization = `Bearer ${token}`;
	}
	return headers;
}

const CELL_MODELS = Object.freeze({
	A: Object.freeze({ implement: "opus", qa: "codex" }),
	B: Object.freeze({ implement: "codex", qa: "opus" }),
	C: Object.freeze({ engineer: "opus" }),
	D: Object.freeze({ engineer: "codex" }),
});

// The bundled generic menu offers only opus. A standalone Codex cell is an
// explicit override outside the automatic candidates, which the shared menu
// resolver (workflow-menu resolveMenuOverrides) accepts only with an explicit
// effort, so the production registry stays unchanged.
const STANDALONE_OFF_MENU_EFFORT = Object.freeze({ codex: "xhigh" });

function cellModels(cell) {
	const models = CELL_MODELS[cell];
	if (!models) throw new Error(`unknown test-discipline cell ${cell}`);
	return models;
}

export function buildRunStartRequest({
	generalized,
	issue,
	projectName,
	leadId,
	cell,
}) {
	const request = {
		issueId: issue,
		projectName,
		leadId,
		sessionRole: "main",
		docTier: "none",
		idempotencyKey: `fly2802-${cell.toLowerCase()}-${randomUUID()}`,
	};
	const models = cellModels(cell);
	if (!generalized) {
		if (!("engineer" in models))
			throw new Error(`cell ${cell} is not a standalone engineer cell`);
		return {
			...request,
			taskCategory: "generic",
			agentName: "engineer",
			overrides: {
				general: {
					model: models.engineer,
					...(STANDALONE_OFF_MENU_EFFORT[models.engineer]
						? { effort: STANDALONE_OFF_MENU_EFFORT[models.engineer] }
						: {}),
				},
			},
		};
	}
	if (!("implement" in models) || !("qa" in models))
		throw new Error(`cell ${cell} is not a generalized workflow cell`);
	return {
		...request,
		taskCategory: "simple_code",
		overrides: {
			implement: { model: models.implement },
			qa: { model: models.qa },
		},
	};
}

export function postRunStart(room, request) {
	return httpJson(`${room.bridgeUrl}/api/runs/start`, {
		method: "POST",
		headers: authHeaders(room),
		body: JSON.stringify(request),
	});
}

function openStateDatabase(room) {
	const requireFromTeamlead = createRequire(
		join(DEFAULT_ROOT, "packages/teamlead/package.json"),
	);
	const Database = requireFromTeamlead("better-sqlite3");
	const db = new Database(room.dbPath, {
		readonly: true,
		fileMustExist: true,
		timeout: 5_000,
	});
	db.pragma("busy_timeout = 5000");
	return db;
}

export function loadGeneralizedRoleRows(db, runId) {
	return db
		.prepare(
			`SELECT n.node_id, n.state, n.attempt, s.*, n.ended_at AS ended_at
			   FROM workflow_run_node n
			   JOIN sessions s ON s.execution_id = n.execution_id
			  WHERE n.run_id = ? AND n.node_id IN ('implement','qa')
			  ORDER BY n.node_id, n.attempt DESC`,
		)
		.all(runId);
}

// A standalone engineer is the `general` node of its own workflow run, keyed
// by run and node like the generalized path. workflow_run_node.execution_id is
// rewritten when Flywheel replaces a dead writer inside the same attempt (for
// example after an upstream capacity error), so an execution id is only a key
// through workflow_execution_binding, which keeps every admitted execution.
const STANDALONE_RUN_IDS = `
	SELECT run_id FROM workflow_run_node
	 WHERE run_id = @key AND node_id = 'general'
	UNION
	SELECT run_id FROM workflow_execution_binding
	 WHERE execution_id = @key AND node_id = 'general'`;

export function loadStandaloneRoleRow(db, runOrExecutionId) {
	return db
		.prepare(
			`SELECT s.*, n.node_id AS workflow_node_id, n.state, n.attempt,
			        n.ended_at AS ended_at
			   FROM workflow_run_node n
			   JOIN sessions s ON s.execution_id = n.execution_id
			  WHERE n.run_id IN (${STANDALONE_RUN_IDS})
			    AND n.node_id = 'general'
			  ORDER BY n.attempt DESC
			  LIMIT 1`,
		)
		.get({ key: runOrExecutionId });
}

export function loadStandaloneNodeExecutions(db, runOrExecutionId) {
	return db
		.prepare(
			`SELECT s.*, b.node_id AS workflow_node_id, MIN(b.bound_at) AS bound_at
			   FROM workflow_execution_binding b
			   JOIN sessions s ON s.execution_id = b.execution_id
			  WHERE b.run_id IN (${STANDALONE_RUN_IDS})
			    AND b.node_id = 'general'
			  GROUP BY b.execution_id
			  ORDER BY MIN(b.bound_at), b.execution_id`,
		)
		.all({ key: runOrExecutionId });
}

// The completed general node plus every writer it replaced, so commands a
// replaced writer ran before it died stay in the frozen evidence.
export function standaloneAcceptanceTarget(db, runOrExecutionId) {
	const target = standaloneCompletionTarget(
		loadStandaloneRoleRow(db, runOrExecutionId),
	);
	if (!target) return false;
	return {
		...target,
		supersededExecutions: loadStandaloneNodeExecutions(db, runOrExecutionId)
			.filter((row) => row.execution_id !== target.execution_id)
			.map((row) => ({ ...row, supersededBy: target.execution_id })),
	};
}

export function generalizedTerminalTargets(rows) {
	return ["implement", "qa"].flatMap((node) =>
		rows
			.filter((row) => row.node_id === node && hasRoleCompletionReceipt(row))
			.sort((left, right) => Number(left.attempt) - Number(right.attempt)),
	);
}

export function generalizedCompletionTargets(run, rows, reworkObservation) {
	if (!run) return false;
	const latest = new Map();
	for (const row of rows) {
		const prior = latest.get(row.node_id);
		if (!prior || Number(row.attempt) > Number(prior.attempt)) {
			latest.set(row.node_id, row);
		}
	}
	if (!new Set(["implement", "qa"]).has(run.current_node_id)) {
		if (
			!["implement", "qa"].every((node) =>
				hasRoleCompletionReceipt(latest.get(node)),
			)
		) {
			return false;
		}
		return generalizedTerminalTargets(rows);
	}
	const activeImplement = latest.get("implement");
	if (
		run.current_node_id !== "implement" ||
		!(activeImplement?.attempt > 1) ||
		hasRoleCompletionReceipt(activeImplement) ||
		reworkObservation?.executionId !== activeImplement.execution_id ||
		!["PASS", "FAIL"].includes(reworkObservation.verdict)
	) {
		return false;
	}
	const terminal = generalizedTerminalTargets(rows);
	if (terminal.length !== 2) return false;
	if (
		!terminal.some(
			(row) =>
				row.node_id === "implement" && row.attempt < activeImplement.attempt,
		) ||
		!terminal.some(
			(row) => row.node_id === "qa" && row.attempt < activeImplement.attempt,
		)
	) {
		return false;
	}
	return terminal;
}

export function loadExternalReviewSessions(db, executionId) {
	const rows = db
		.prepare(
			`SELECT reviewer_session_uuid AS sessionId, status
			   FROM codex_review_job
			  WHERE execution_id = ?
			    AND review_type = 'code'
			    AND reviewer_session_uuid IS NOT NULL
			  ORDER BY round, created_at, request_id`,
		)
		.all(executionId);
	const sessions = new Map();
	for (const row of rows) {
		if (typeof row.sessionId !== "string" || !row.sessionId) continue;
		sessions.set(row.sessionId, {
			sessionId: row.sessionId,
			completionReceipt: row.status === "done",
		});
	}
	return [...sessions.values()];
}

export function hasRoleCompletionReceipt(row) {
	if (row?.terminal_at && row.status === "completed") return true;
	if (row?.state === "done" && row.ended_at) return true;
	return (
		row?.status === "awaiting_review" &&
		row.decision_route === "needs_review" &&
		typeof row.awaiting_review_entered_at === "string" &&
		row.awaiting_review_entered_at.length > 0
	);
}

export function standaloneCompletionTarget(row) {
	if (!hasRoleCompletionReceipt(row)) return false;
	if (row.workflow_node_id !== "general") {
		throw new Error(
			`standalone generic dispatch resolved to ${row.workflow_node_id ?? "unknown"}`,
		);
	}
	return {
		...row,
		node_id: "engineer",
		state: "done",
		attempt: Number(row.attempt) || 1,
	};
}

// A writer replaced inside the same node attempt never completes the role;
// its evidence is closed once its own session is terminal.
function executionClosureReceipt(row) {
	if (row?.supersededBy)
		return typeof row.terminal_at === "string" && row.terminal_at.length > 0;
	return hasRoleCompletionReceipt(row);
}

function roleCompletedAt(row) {
	return (
		row?.ended_at ?? row?.terminal_at ?? row?.awaiting_review_entered_at ?? null
	);
}

export function modelReceiptMatches(started, node, requestedAlias) {
	const receipt = started.resolved?.nodeModels?.[node];
	return (
		typeof receipt?.model === "string" &&
		receipt.model.startsWith(`${requestedAlias} (= `) &&
		receipt.overridden === true
	);
}

async function waitFor(label, probe, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		try {
			const result = probe();
			if (result) return result;
		} catch (error) {
			last = error;
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
	}
	throw new Error(
		`${label} timed out${last ? `: ${last instanceof Error ? last.message : String(last)}` : ""}`,
	);
}

function parseSessionParams(row) {
	try {
		return row?.session_params ? JSON.parse(row.session_params) : {};
	} catch {
		return {};
	}
}

function sanitizeValue(value, key = "") {
	if (
		/token|secret|authorization|credential|encrypted_content|signature/i.test(
			key,
		)
	) {
		return "<redacted>";
	}
	if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([childKey, child]) => [
				childKey,
				sanitizeValue(child, childKey),
			]),
		);
	}
	if (typeof value !== "string") return value;
	return value
		.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer <redacted>")
		.replace(
			/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
			"<redacted>",
		);
}

function sanitizeJsonl(source) {
	const output = [];
	for (const line of source.split("\n")) {
		if (!line.trim()) continue;
		try {
			output.push(JSON.stringify(sanitizeValue(JSON.parse(line))));
		} catch {
			output.push(JSON.stringify({ type: "unparseable_source_line" }));
		}
	}
	return `${output.join("\n")}\n`;
}

function policyMarkerCount(source) {
	return source.split("FLYWHEEL_LOCAL_TEST_POLICY:BEGIN").length - 1;
}

function messageText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) =>
			typeof item === "string"
				? item
				: typeof item?.text === "string"
					? item.text
					: "",
		)
		.join("\n");
}

export function delegatedTaskPolicyMarkerCount(source) {
	const taskBodies = [];
	for (const line of source.split("\n")) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line);
			if (
				record?.message?.role === "user" &&
				typeof record.message.content === "string"
			) {
				taskBodies.push(messageText(record.message.content));
				continue;
			}
			if (
				record?.type === "response_item" &&
				record?.payload?.type === "message" &&
				record.payload.role === "user"
			) {
				taskBodies.push(messageText(record.payload.content));
			}
		} catch {
			// A later structured user record may still carry the delegated task.
		}
	}
	return policyMarkerCount(taskBodies.join("\n"));
}

export function claudeTranscriptPath(
	row,
	{ projectsRoot = join(homedir(), ".claude", "projects") } = {},
) {
	const params = parseSessionParams(row);
	const sessionId = row?.thread_id || params.sessionId;
	let canonicalWorktree;
	try {
		canonicalWorktree = realpathSync(row.worktree_path);
	} catch {
		return null;
	}
	const project = canonicalWorktree.replace(/[^A-Za-z0-9]/g, "-");
	const projectDir = join(projectsRoot, project);
	if (typeof sessionId === "string" && sessionId) {
		if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
		const candidate = join(projectDir, `${sessionId}.jsonl`);
		if (!existsSync(candidate)) return { id: sessionId, path: candidate };
		const path = realpathSync(candidate);
		if (!inside(realpathSync(projectDir), path)) return null;
		return { id: sessionId, path };
	}
	if (!existsSync(projectDir) || typeof row.execution_id !== "string")
		return null;
	const matches = [];
	for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const path = realpathSync(join(projectDir, entry.name));
		if (!inside(realpathSync(projectDir), path)) continue;
		const content = readFileSync(path, "utf8");
		if (!content.includes(row.execution_id)) continue;
		let id = entry.name.slice(0, -".jsonl".length);
		for (const line of content.split("\n").slice(0, 16)) {
			try {
				const record = JSON.parse(line);
				if (typeof record.sessionId === "string" && record.sessionId) {
					id = record.sessionId;
					break;
				}
			} catch {
				// A later line may still carry the session identity.
			}
		}
		matches.push({ id, path });
	}
	return matches.length === 1 ? matches[0] : null;
}

// The room keys each Codex agent home by workflow node (the runner-memory
// identity), so a standalone engineer's rollouts live under `general`; the
// evidence role only names the case.
export function codexTranscriptPath(room, row, role) {
	const params = parseSessionParams(row);
	const threadId = row?.thread_id || params.threadId;
	const home = join(
		room.slotRoot,
		"state/codex-homes/agents",
		room.projectName,
		row?.workflow_node_id || role,
	);
	const stateDb = join(home, "state_5.sqlite");
	if (!existsSync(stateDb)) return { id: threadId, path: null, home };
	const requireFromTeamlead = createRequire(
		join(DEFAULT_ROOT, "packages/teamlead/package.json"),
	);
	const Database = requireFromTeamlead("better-sqlite3");
	const db = new Database(stateDb, { readonly: true, fileMustExist: true });
	try {
		let candidates;
		if (typeof threadId === "string" && threadId) {
			candidates = db
				.prepare("SELECT id, rollout_path, cwd FROM threads WHERE id = ?")
				.all(threadId);
		} else {
			let canonicalWorktree;
			try {
				canonicalWorktree = realpathSync(row.worktree_path);
			} catch {
				return null;
			}
			candidates = db
				.prepare("SELECT id, rollout_path, cwd FROM threads")
				.all()
				.filter((candidate) => {
					try {
						return realpathSync(candidate.cwd) === canonicalWorktree;
					} catch {
						return false;
					}
				});
		}
		const admittedHome = realpathSync(home);
		const matches = [];
		for (const candidate of candidates) {
			if (!candidate?.rollout_path) continue;
			const path = realpathSync(candidate.rollout_path);
			if (!inside(admittedHome, path)) {
				throw new Error("Codex rollout path escapes the admitted agent home");
			}
			if (
				(!threadId &&
					(typeof row.execution_id !== "string" ||
						!readFileSync(path, "utf8").includes(row.execution_id))) ||
				(threadId && candidate.id !== threadId)
			)
				continue;
			matches.push({ id: candidate.id, path, home });
		}
		if (matches.length === 1) return matches[0];
		return threadId ? { id: threadId, path: null, home } : null;
	} finally {
		db.close();
	}
}

function completedClaudeSubagentIds(source) {
	const completed = new Set();
	for (const match of source.matchAll(
		/<task-id>([^<]+)<\/task-id>[\s\S]{0,4000}?<status>completed<\/status>/g,
	)) {
		completed.add(match[1]);
	}
	return completed;
}

function claudeSubagentInvoked(source) {
	for (const line of source.split("\n")) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line);
			if (
				Array.isArray(record.message?.content) &&
				record.message.content.some(
					(content) =>
						content?.type === "tool_use" &&
						(content.name === "Agent" || content.name === "Task"),
				)
			) {
				return true;
			}
		} catch {
			// Sanitization records the malformed line separately.
		}
	}
	return false;
}

function codexThreadsReportedByClaude(source) {
	const threads = new Map();
	for (const line of source.split("\n")) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line);
			for (const content of record.message?.content ?? []) {
				if (content?.type !== "tool_result") continue;
				const text =
					typeof content.content === "string"
						? content.content
						: JSON.stringify(content.content ?? "");
				for (const match of text.matchAll(
					/Thread ready \(([0-9a-f-]{36})\)/g,
				)) {
					threads.set(match[1], content.is_error !== true);
				}
			}
		} catch {
			// Sanitization records the malformed line separately.
		}
	}
	return threads;
}

function codexHomeThreadPath(home, threadId) {
	const stateDb = join(home, "state_5.sqlite");
	if (!existsSync(stateDb)) return null;
	const requireFromTeamlead = createRequire(
		join(DEFAULT_ROOT, "packages/teamlead/package.json"),
	);
	const Database = requireFromTeamlead("better-sqlite3");
	const db = new Database(stateDb, { readonly: true, fileMustExist: true });
	try {
		const found = db
			.prepare("SELECT rollout_path FROM threads WHERE id = ?")
			.get(threadId);
		if (!found?.rollout_path) return null;
		const path = realpathSync(found.rollout_path);
		if (!inside(realpathSync(home), path)) {
			throw new Error("Codex child rollout path escapes its admitted home");
		}
		return path;
	} finally {
		db.close();
	}
}

export function collectSessionTranscript(
	room,
	row,
	role,
	caseDir,
	{
		projectsRoot = join(homedir(), ".claude", "projects"),
		codexHome = join(homedir(), ".codex"),
		externalReviewSessions = [],
	} = {},
) {
	const backend = String(row.adapter_type ?? "").includes("codex")
		? "codex"
		: "claude";
	const located =
		backend === "codex"
			? codexTranscriptPath(room, row, role)
			: claudeTranscriptPath(row, { projectsRoot });
	if (!located?.path || !existsSync(located.path)) {
		const session = {
			id: located?.id ?? null,
			executionId: row.execution_id,
			delegated: false,
			policyMarkers: 0,
			transcriptComplete: false,
			completionReceipt: executionClosureReceipt(row),
			reason: "native_transcript_missing",
		};
		return {
			backend,
			session,
			sessions: [session],
			commands: [],
		};
	}
	const original = readFileSync(located.path, "utf8");
	const sanitized = sanitizeJsonl(original);
	const transcriptName = `${role}-${row.execution_id}.jsonl`;
	writeFileSync(join(caseDir, transcriptName), sanitized, { mode: 0o600 });
	const commands = extractCommandEvents(sanitized, {
		sourcePath: transcriptName,
	});
	const sessions = [];
	const subagentInvoked = claudeSubagentInvoked(original);
	const subagentSources = [];
	if (backend === "claude") {
		const subagentDir = join(dirname(located.path), located.id, "subagents");
		if (existsSync(subagentDir)) {
			for (const entry of readdirSync(subagentDir, { withFileTypes: true })) {
				if (!entry.isFile() || !/^agent-.+\.jsonl$/.test(entry.name)) continue;
				const path = realpathSync(join(subagentDir, entry.name));
				if (!inside(realpathSync(subagentDir), path)) continue;
				subagentSources.push({
					id: entry.name.slice("agent-".length, -".jsonl".length),
					path,
				});
			}
		}
	}
	const completedSubagents = completedClaudeSubagentIds(original);
	const childrenComplete = subagentSources.every(({ id }) =>
		completedSubagents.has(id),
	);
	const ownedCoverageComplete =
		!subagentInvoked || (subagentSources.length > 0 && childrenComplete);
	const primarySession = {
		id: located.id,
		executionId: row.execution_id,
		delegated: false,
		policyMarkers: policyMarkerCount(original),
		transcriptComplete: ownedCoverageComplete,
		completionReceipt: executionClosureReceipt(row),
		sourceSha256: sha256(original),
		sanitizedSha256: sha256(sanitized),
		sourceBytes: Buffer.byteLength(original),
		...(!ownedCoverageComplete
			? { reason: "subagent_lineage_not_collected" }
			: {}),
	};
	sessions.push(primarySession);
	const claudeSources = [{ original, id: located.id }];
	for (const child of subagentSources) {
		const childOriginal = readFileSync(child.path, "utf8");
		const childSanitized = sanitizeJsonl(childOriginal);
		const childName = `${role}-${row.execution_id}-subagent-${child.id}.jsonl`;
		writeFileSync(join(caseDir, childName), childSanitized, { mode: 0o600 });
		commands.push(
			...extractCommandEvents(childSanitized, { sourcePath: childName }),
		);
		const childCompleted = completedSubagents.has(child.id);
		sessions.push({
			id: `${located.id}:${child.id}`,
			executionId: row.execution_id,
			delegated: true,
			policyMarkers: delegatedTaskPolicyMarkerCount(childOriginal),
			transcriptComplete: childCompleted,
			completionReceipt: childCompleted,
			sourceSha256: sha256(childOriginal),
			sanitizedSha256: sha256(childSanitized),
			sourceBytes: Buffer.byteLength(childOriginal),
			...(!childCompleted ? { reason: "subagent_completion_missing" } : {}),
		});
		claudeSources.push({ original: childOriginal, id: child.id });
	}
	if (backend === "claude") {
		const reportedThreads = new Map();
		for (const source of claudeSources) {
			for (const [threadId, completed] of codexThreadsReportedByClaude(
				source.original,
			)) {
				reportedThreads.set(threadId, completed);
			}
		}
		for (const [threadId, completed] of reportedThreads) {
			const path = codexHomeThreadPath(codexHome, threadId);
			if (!path) {
				sessions.push({
					id: threadId,
					executionId: row.execution_id,
					delegated: true,
					policyMarkers: 0,
					transcriptComplete: false,
					completionReceipt: completed,
					reason: "delegated_codex_transcript_missing",
				});
				primarySession.transcriptComplete = false;
				continue;
			}
			const childOriginal = readFileSync(path, "utf8");
			const childSanitized = sanitizeJsonl(childOriginal);
			const childName = `${role}-${row.execution_id}-codex-${threadId}.jsonl`;
			writeFileSync(join(caseDir, childName), childSanitized, { mode: 0o600 });
			commands.push(
				...extractCommandEvents(childSanitized, { sourcePath: childName }),
			);
			sessions.push({
				id: threadId,
				executionId: row.execution_id,
				delegated: true,
				policyMarkers: delegatedTaskPolicyMarkerCount(childOriginal),
				transcriptComplete: completed,
				completionReceipt: completed,
				sourceSha256: sha256(childOriginal),
				sanitizedSha256: sha256(childSanitized),
				sourceBytes: Buffer.byteLength(childOriginal),
				...(!completed ? { reason: "delegated_codex_completion_missing" } : {}),
			});
			if (!completed) primarySession.transcriptComplete = false;
		}
	}
	for (const review of externalReviewSessions) {
		const sessionId = review?.sessionId;
		if (typeof sessionId !== "string" || !sessionId) continue;
		if (sessions.some(({ id }) => id === sessionId)) continue;
		const reviewLocated = claudeTranscriptPath(
			{
				thread_id: sessionId,
				worktree_path: row.worktree_path,
				session_params: "{}",
			},
			{ projectsRoot },
		);
		if (!reviewLocated?.path || !existsSync(reviewLocated.path)) {
			sessions.push({
				id: sessionId,
				executionId: row.execution_id,
				delegated: true,
				policyMarkers: 0,
				transcriptComplete: false,
				completionReceipt: review.completionReceipt === true,
				reason: "external_review_transcript_missing",
			});
			primarySession.transcriptComplete = false;
			continue;
		}
		const reviewOriginal = readFileSync(reviewLocated.path, "utf8");
		const reviewSanitized = sanitizeJsonl(reviewOriginal);
		const reviewName = `${role}-${row.execution_id}-external-review-${sessionId}.jsonl`;
		writeFileSync(join(caseDir, reviewName), reviewSanitized, { mode: 0o600 });
		commands.push(
			...extractCommandEvents(reviewSanitized, { sourcePath: reviewName }),
		);
		sessions.push({
			id: sessionId,
			executionId: row.execution_id,
			delegated: true,
			policyMarkers: delegatedTaskPolicyMarkerCount(reviewOriginal),
			transcriptComplete: review.completionReceipt === true,
			completionReceipt: review.completionReceipt === true,
			sourceSha256: sha256(reviewOriginal),
			sanitizedSha256: sha256(reviewSanitized),
			sourceBytes: Buffer.byteLength(reviewOriginal),
		});
		if (review.completionReceipt !== true)
			primarySession.transcriptComplete = false;
	}
	return {
		backend,
		session: primarySession,
		sessions,
		commands,
	};
}

// The node's current execution owns identity (backend, primary session); every
// writer it replaced contributes its sessions and commands, oldest first.
export function collectNodeTranscripts(room, target, role, caseDir, options) {
	const collect = (row) =>
		collectSessionTranscript(room, row, role, caseDir, {
			...options,
			externalReviewSessions: row.externalReviewSessions ?? [],
		});
	const current = collect(target);
	const replaced = (target.supersededExecutions ?? []).map(collect);
	return {
		...current,
		sessions: [
			...replaced.flatMap((item) => item.sessions),
			...current.sessions,
		],
		commands: [
			...replaced.flatMap((item) => item.commands),
			...current.commands,
		],
	};
}

export function parseVitestTestCount(output) {
	const matches = [...output.matchAll(/^\s*Tests\s+.*?\((\d+)\)\s*$/gim)];
	if (matches.length !== 1) return null;
	return Number(matches[0][1]);
}

export function fixtureChangedFilesMatch(changedFiles, docRoots = []) {
	const expectedPaths = changedFiles.filter(
		(file) =>
			file === "pnpm-lock.yaml" ||
			file.startsWith(`${SUBJECT_RELATIVE}/`) ||
			file.startsWith("engineering/doc/") ||
			docRoots.some((root) => file.startsWith(root)),
	);
	const subjectChanged = changedFiles.filter((file) =>
		file.startsWith(`${SUBJECT_RELATIVE}/`),
	);
	return (
		expectedPaths.length === changedFiles.length && subjectChanged.length >= 10
	);
}

const DOC_FLOW_DEPARTMENT = /^[a-z0-9-]+$/;

function leadDepartment(lead) {
	if (typeof lead?.department === "string" && lead.department)
		return lead.department;
	const label = lead?.match?.labels?.[0];
	return typeof label === "string" && label ? label.toLowerCase() : undefined;
}

// DOC-FLOW writes land in `<department>/doc/`: the matching Lead's department
// (explicit, else its first match label, as teamlead resolveLeadDepartment
// does) or the project's doc_flow.default_department. Read from the room.
export function roomDocFlowSnapshot(room) {
	const requireFromConfig = createRequire(
		join(DEFAULT_ROOT, "packages/config/package.json"),
	);
	const { parse } = requireFromConfig("yaml");
	const configBytes = readFileSync(
		join(room.hostRepo, ".flywheel/config.yaml"),
	);
	const projectsBytes = readFileSync(
		join(room.slotRoot, "flywheel-projects.json"),
	);
	const config = parse(configBytes.toString("utf8"));
	const projects = JSON.parse(projectsBytes.toString("utf8"));
	const project = Array.isArray(projects)
		? projects.find((entry) => entry?.projectName === room.projectName)
		: undefined;
	if (!project) {
		throw new Error(
			`room projects file lacks the room project ${room.projectName}`,
		);
	}
	const departments = [
		config?.doc_flow?.default_department,
		...(Array.isArray(project.leads) ? project.leads : []).map(leadDepartment),
	];
	return {
		roots: [
			...new Set(
				departments
					.filter(
						(department) =>
							typeof department === "string" &&
							DOC_FLOW_DEPARTMENT.test(department),
					)
					.map((department) => `${department}/doc/`),
			),
		],
		sources: { config: sha256(configBytes), projects: sha256(projectsBytes) },
	};
}

export function roomDocFlowRoots(room) {
	return roomDocFlowSnapshot(room).roots;
}

// The room files sit where a runner could write during its run, so the roots
// are frozen before /api/runs/start and reused at collection; any drift of the
// source files since then fails closed instead of widening the admitted set.
export function frozenDocFlowRoots(room, frozen) {
	if (!Array.isArray(frozen?.roots) || !frozen.sources) {
		throw new Error("run receipt lacks the frozen DOC-FLOW roots");
	}
	const live = roomDocFlowSnapshot(room);
	if (
		live.sources.config !== frozen.sources.config ||
		live.sources.projects !== frozen.sources.projects
	) {
		throw new Error("room DOC-FLOW sources changed after the run started");
	}
	if (
		live.roots.length !== frozen.roots.length ||
		live.roots.some((root, index) => root !== frozen.roots[index])
	) {
		throw new Error(
			"run receipt DOC-FLOW roots do not match the room's sources",
		);
	}
	return live.roots;
}

// The oracle measures the result with the candidate checkout's lockfile-pinned
// Vitest in an isolated copy of the fixture package, so the verdict never
// depends on whether, or what, the runner installed.
export function candidateOracleRoot(room, head) {
	const root = realpathSync(room.flywheelRepo);
	const actual = git(root, ["rev-parse", "HEAD"]);
	if (actual !== head) {
		throw new Error(
			`oracle checkout ${root} is at ${actual}, not candidate ${head}`,
		);
	}
	return root;
}

function oracleVitest(oracleRoot) {
	const requireFromTeamlead = createRequire(
		join(oracleRoot, "packages/teamlead/package.json"),
	);
	const manifest = requireFromTeamlead.resolve("vitest/package.json");
	return {
		entry: join(dirname(manifest), "vitest.mjs"),
		packageDir: dirname(manifest),
		version: readJson(manifest).version,
	};
}

// HEAD binds tracked source, not the ignored install the oracle executes. The
// install pnpm recorded (node_modules/.pnpm/lock.yaml) must resolve Vitest for
// packages/teamlead exactly as the candidate lockfile does, patch and peers
// included; the loaded package must be that version; and its bytes are frozen
// before the runner starts and re-checked when evidence is frozen.
function teamleadVitestResolution(lock) {
	const importer = lock?.importers?.["packages/teamlead"];
	const resolution =
		importer?.devDependencies?.vitest?.version ??
		importer?.dependencies?.vitest?.version;
	return typeof resolution === "string" && resolution ? resolution : null;
}

export function oracleIdentity(room, head) {
	const root = candidateOracleRoot(room, head);
	const requireFromConfig = createRequire(
		join(DEFAULT_ROOT, "packages/config/package.json"),
	);
	const { parse } = requireFromConfig("yaml");
	const resolution = teamleadVitestResolution(
		parse(
			execFileSync("git", ["-C", root, "show", `${head}:pnpm-lock.yaml`], {
				encoding: "utf8",
				maxBuffer: 256 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			}),
		),
	);
	if (!resolution) {
		throw new Error(
			"candidate lockfile does not resolve vitest for packages/teamlead",
		);
	}
	const installed = teamleadVitestResolution(
		parse(readFileSync(join(root, "node_modules/.pnpm/lock.yaml"), "utf8")),
	);
	if (installed !== resolution) {
		throw new Error(
			`installed vitest resolution ${installed ?? "(none)"} does not match the candidate lockfile ${resolution}`,
		);
	}
	const lockVersion = resolution.split("(")[0];
	const vitest = oracleVitest(root);
	if (vitest.version !== lockVersion) {
		throw new Error(
			`candidate lockfile resolves vitest ${lockVersion} but packages/teamlead loads ${vitest.version}`,
		);
	}
	const packageDir = realpathSync(vitest.packageDir);
	return {
		root,
		head,
		lockfileResolution: resolution,
		version: vitest.version,
		packageDir,
		packageTreeSha256: stableTreeHash(packageDir),
	};
}

export function frozenOracleRoot(room, head, frozen) {
	if (typeof frozen?.packageTreeSha256 !== "string") {
		throw new Error("run receipt lacks the frozen fixture oracle identity");
	}
	const live = oracleIdentity(room, head);
	for (const field of [
		"root",
		"head",
		"lockfileResolution",
		"version",
		"packageDir",
		"packageTreeSha256",
	]) {
		if (live[field] !== frozen[field]) {
			throw new Error(
				`fixture oracle identity changed after the run started (${field})`,
			);
		}
	}
	return live.root;
}

// Copy only the fixture's own regular files. A symlink could point the oracle
// at bytes outside the result tree, so it is refused; `node_modules` holds the
// runner's installs and is never copied.
function copyFixturePackage(source, destination, prefix = "") {
	for (const entry of readdirSync(source)) {
		if (entry === "node_modules") continue;
		const from = join(source, entry);
		const to = join(destination, entry);
		const relativePath = prefix ? `${prefix}/${entry}` : entry;
		const stat = lstatSync(from);
		if (stat.isSymbolicLink()) {
			throw new Error(
				`fixture package holds a symbolic link at ${relativePath}; the oracle measures regular files only`,
			);
		}
		if (stat.isDirectory()) {
			mkdirSync(to);
			copyFixturePackage(from, to, relativePath);
		} else if (stat.isFile()) {
			copyFileSync(from, to);
		} else {
			throw new Error(
				`fixture package holds a special file at ${relativePath}; the oracle measures regular files only`,
			);
		}
	}
}

export function runFixtureCheck(
	worktree,
	baseHead,
	{ docRoots = [], oracleRoot = DEFAULT_ROOT } = {},
) {
	const packageRoot = join(worktree, SUBJECT_RELATIVE);
	const testFiles = [
		"src/alpha/__tests__/model.test.ts",
		"src/beta/__tests__/model.test.ts",
		"src/gamma/__tests__/model.test.ts",
		"src/delta/__tests__/model.test.ts",
		"src/__tests__/literal-only.test.ts",
		"src/__tests__/static-dependency.test.ts",
		"src/__tests__/unrelated.test.ts",
	];
	const vitest = oracleVitest(oracleRoot);
	const isolated = mkdtempSync(join(tmpdir(), "fly2802-fixture-oracle-"));
	let content = { passed: false };
	let testRuns;
	try {
		copyFixturePackage(packageRoot, isolated);
		const verify = spawnSync(process.execPath, [join(isolated, "verify.mjs")], {
			cwd: isolated,
			encoding: "utf8",
		});
		try {
			content = JSON.parse(verify.stdout.trim());
		} catch {
			content = { passed: false, verifyOutput: verify.stdout.trim() };
		}
		// CI (or FORCE_COLOR) makes Vitest colour its summary, which the plain-text
		// count parser cannot read; NO_COLOR outranks both.
		const { FORCE_COLOR: _forceColor, ...inheritedEnv } = process.env;
		testRuns = testFiles.map((testFile) => ({
			testFile,
			result: spawnSync(process.execPath, [vitest.entry, "run", testFile], {
				cwd: isolated,
				encoding: "utf8",
				env: { ...inheritedEnv, NO_COLOR: "1" },
				timeout: 10 * 60_000,
			}),
		}));
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
	const measuredCounts = testRuns.map(({ result }) =>
		parseVitestTestCount(`${result.stdout}\n${result.stderr}`),
	);
	const testsPassed = testRuns.every(
		({ result }, index) =>
			result.status === 0 && Number.isInteger(measuredCounts[index]),
	);
	const testsRun = measuredCounts.every(Number.isInteger)
		? measuredCounts.reduce((total, count) => total + count, 0)
		: 0;
	const minimumExpectedTests = 34;
	let resultHead = null;
	let changedFiles = [];
	let changedFilesError;
	try {
		resultHead = git(worktree, ["rev-parse", "HEAD"]);
		changedFiles = git(worktree, [
			"diff",
			"--name-only",
			`${baseHead}..${resultHead}`,
			"--",
		])
			.split("\n")
			.filter(Boolean);
	} catch (error) {
		resultHead = null;
		changedFiles = [];
		changedFilesError = `git change set unavailable: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
	}
	return {
		passed:
			content.passed === true &&
			testsPassed &&
			testsRun >= minimumExpectedTests &&
			resultHead !== null,
		testsRun,
		minimumExpectedTests,
		changedFilesMatch:
			resultHead !== null && fixtureChangedFilesMatch(changedFiles, docRoots),
		subjectBaseHead: baseHead,
		subjectResultHead: resultHead,
		changedFiles,
		...(changedFilesError ? { changedFilesError } : {}),
		docRoots,
		oracle: {
			vitestVersion: vitest.version,
			source: "candidate-checkout",
			root: oracleRoot,
		},
		verify: content,
		testExitCodes: Object.fromEntries(
			testRuns.map(({ testFile, result }) => [testFile, result.status]),
		),
		testOutputSha256: sha256(
			testRuns
				.map(
					({ testFile, result }) =>
						`${testFile}\0${result.stdout}\n${result.stderr}`,
				)
				.join("\n"),
		),
	};
}

function preparedSelection(evidenceRoot, changedFiles) {
	const source = readJson(join(evidenceRoot, "selection.json"));
	return {
		...source,
		packageRoot: SUBJECT_RELATIVE,
		changedFiles: changedFiles
			.filter(
				(file) =>
					file.startsWith(`${SUBJECT_RELATIVE}/`) &&
					/\.[cm]?[jt]sx?$/.test(file),
			)
			.map((file) => file.slice(`${SUBJECT_RELATIVE}/`.length)),
	};
}

function appendCases(evidenceRoot, paths) {
	const path = join(evidenceRoot, "cases.json");
	const current = existsSync(path)
		? readJson(path)
		: { schemaVersion: 1, cases: [], observations: [] };
	if (!Array.isArray(current.cases)) current.cases = [];
	if (!Array.isArray(current.observations)) current.observations = [];
	for (const casePath of paths) {
		const rel = relative(evidenceRoot, casePath).split(sep).join("/");
		if (!current.cases.includes(rel)) current.cases.push(rel);
	}
	atomicJson(path, current);
}

export function appendObservation(evidenceRoot, observation) {
	const path = join(evidenceRoot, "cases.json");
	const current = existsSync(path)
		? readJson(path)
		: { schemaVersion: 1, cases: [], observations: [] };
	if (!Array.isArray(current.cases)) current.cases = [];
	if (!Array.isArray(current.observations)) current.observations = [];
	const existing = current.observations.findIndex(
		(item) =>
			item.runId === observation.runId &&
			(item.executionId ?? null) === (observation.executionId ?? null) &&
			item.reason === observation.reason &&
			(item.toolCallId ?? null) === (observation.toolCallId ?? null),
	);
	if (existing === -1) current.observations.push(observation);
	else {
		const rank = { PASS: 0, INCONCLUSIVE: 1, FAIL: 2 };
		if (
			(rank[observation.verdict] ?? 1) >
			(rank[current.observations[existing].verdict] ?? 1)
		) {
			current.observations[existing] = observation;
		}
	}
	atomicJson(path, current);
}

function expectedBackendFor(cell, targetRole, standaloneBackend) {
	if (cell === "A") return targetRole === "implement" ? "claude" : "codex";
	if (cell === "B") return targetRole === "implement" ? "codex" : "claude";
	return standaloneBackend;
}

function requestedModelFor(cell, targetRole) {
	if (cell === "A") return targetRole === "implement" ? "opus" : "codex";
	if (cell === "B") return targetRole === "implement" ? "codex" : "opus";
	return null;
}

export function classifyReworkTestCommands(
	commands,
	selection,
	{ runId, executionId, attempt, evidencePath },
) {
	let passing = null;
	let inconclusive = null;
	for (const event of commands) {
		if (event.parseStatus === "unknown" || typeof event.command !== "string") {
			continue;
		}
		const analysis = classifyTestCommand(event.command, selection);
		if (analysis.kind === "not_test") continue;
		const verdict =
			analysis.kind === "allowed" &&
			event.completed === true &&
			event.succeeded === true
				? "PASS"
				: analysis.kind === "forbidden"
					? "FAIL"
					: "INCONCLUSIVE";
		const observation = {
			verdict,
			reason:
				analysis.kind === "allowed" && verdict === "INCONCLUSIVE"
					? "rework_test_command_incomplete"
					: `rework_test_command_${analysis.kind}`,
			runId,
			executionId,
			attempt,
			toolCallId: event.toolCallId ?? null,
			classificationReason: analysis.reason,
			commandSha256: sha256(event.command),
			evidencePath,
		};
		if (verdict === "FAIL") return observation;
		if (verdict === "PASS") passing ??= observation;
		else inconclusive ??= observation;
	}
	return passing ?? inconclusive;
}

function observeReworkTestCommand({
	room,
	target,
	caseRoot,
	selection,
	runId,
}) {
	if (!target?.execution_id) return null;
	const observationDir = join(caseRoot, "observed-rework", target.execution_id);
	mkdirSync(observationDir, { recursive: true, mode: 0o700 });
	const transcript = collectSessionTranscript(
		room,
		target,
		"implement",
		observationDir,
	);
	return classifyReworkTestCommands(transcript.commands, selection, {
		runId,
		executionId: target.execution_id,
		attempt: target.attempt,
		evidencePath: relative(caseRoot, observationDir).split(sep).join("/"),
	});
}

export function acceptanceCaseDirectoryName(target) {
	const role = target?.node_id;
	const attempt = Number(target?.attempt);
	const executionId = target?.execution_id;
	if (
		!["implement", "qa", "engineer"].includes(role) ||
		!Number.isInteger(attempt) ||
		attempt < 1 ||
		typeof executionId !== "string" ||
		!executionId
	) {
		throw new Error("acceptance target identity is incomplete");
	}
	return `${role}-attempt-${attempt}-${sha256(executionId).slice(0, 12)}`;
}

function incompleteFixtureResult(error) {
	return {
		passed: false,
		testsRun: 0,
		minimumExpectedTests: 34,
		changedFilesMatch: false,
		changedFiles: [],
		reason: "fixture_check_unavailable",
		detail: error instanceof Error ? error.message : String(error),
	};
}

async function freezeAcceptanceTargets({
	room,
	prepared,
	evidenceRoot,
	started,
	targets,
	cell,
	slot,
	head,
	backend,
	caseRoot,
	docFlow,
	oracle,
}) {
	if (!targets.length) return evaluateEvidenceDirectory(evidenceRoot);
	let fixtureResult;
	try {
		const resultWorktree = realpathSync(
			targets.find((target) => target.node_id === "qa")?.worktree_path ??
				targets[0].worktree_path,
		);
		fixtureResult = runFixtureCheck(resultWorktree, room.subjectBaseHead, {
			docRoots: frozenDocFlowRoots(room, docFlow),
			oracleRoot: frozenOracleRoot(room, head, oracle),
		});
	} catch (error) {
		fixtureResult = incompleteFixtureResult(error);
	}
	const selection = preparedSelection(
		evidenceRoot,
		fixtureResult.changedFiles ?? [],
	);
	const casePaths = [];
	for (const target of targets) {
		const targetRole = target.node_id;
		const caseDir = join(caseRoot, acceptanceCaseDirectoryName(target));
		if (existsSync(caseDir)) {
			const existingManifestPath = join(caseDir, "manifest.json");
			if (!existsSync(existingManifestPath)) {
				throw new Error(`refusing to overwrite incomplete case ${caseDir}`);
			}
			const existingManifest = readJson(existingManifestPath);
			if (
				existingManifest.executionId !== target.execution_id ||
				existingManifest.candidateHead !== head ||
				existingManifest.cell !== cell
			) {
				throw new Error(`refusing to overwrite mismatched case ${caseDir}`);
			}
			casePaths.push(caseDir);
			continue;
		}
		mkdirSync(caseDir, { recursive: true, mode: 0o700 });
		const transcript = collectNodeTranscripts(
			room,
			target,
			targetRole,
			caseDir,
		);
		const expectedBackend = expectedBackendFor(cell, targetRole, backend);
		const actualPrompt = join(
			room.hostRepo,
			".flywheel/agents/nodes",
			`${targetRole}.md`,
		);
		const requestedModel = requestedModelFor(cell, targetRole);
		const manifest = {
			schemaVersion: 1,
			caseId: prepared.caseId,
			attemptId: prepared.attemptId,
			cell,
			slot,
			candidateHead: head,
			fixtureHash: prepared.fixtureHash,
			promptHash: prepared.promptHash,
			policyHash: prepared.policyHash,
			skillInventoryHash: prepared.skillInventoryHash,
			backend: transcript.backend,
			resolvedModel: target.runner_model,
			runId: started.workflowRunId ?? `standalone:${started.executionId}`,
			executionId: target.execution_id,
			supersededExecutionIds: (target.supersededExecutions ?? []).map(
				(row) => row.execution_id,
			),
			nodeId: targetRole,
			role: targetRole,
			activation: { attempt: target.attempt, state: target.state },
			sessionId: transcript.session.id,
			startedAt: target.started_at,
			completedAt: roleCompletedAt(target),
			completed: hasRoleCompletionReceipt(target),
			completionReceipt: {
				status: target.status,
				decisionRoute: target.decision_route,
			},
			subjectBaseHead: fixtureResult.subjectBaseHead ?? room.subjectBaseHead,
			subjectResultHead: fixtureResult.subjectResultHead ?? null,
			actualPromptFileHash: existsSync(actualPrompt)
				? sha256(readFileSync(actualPrompt))
				: null,
			candidateIdentityVerified: true,
			promptMatchesCandidate:
				existsSync(actualPrompt) &&
				sha256(readFileSync(actualPrompt)) ===
					prepared.promptFileHashes?.[
						`.flywheel/agents/nodes/${targetRole}.md`
					],
			backendMatchesRequest: transcript.backend === expectedBackend,
			modelMatchesRequest: requestedModel
				? modelReceiptMatches(started, targetRole, requestedModel)
				: typeof target.runner_model === "string" &&
					target.runner_model.length > 0,
		};
		if (
			!manifest.backendMatchesRequest ||
			!manifest.modelMatchesRequest ||
			!manifest.promptMatchesCandidate
		)
			transcript.session.transcriptComplete = false;
		atomicJson(join(caseDir, "manifest.json"), manifest);
		atomicJson(join(caseDir, "selection.json"), selection);
		atomicJson(join(caseDir, "fixture-result.json"), fixtureResult);
		atomicJson(join(caseDir, "sessions.json"), transcript.sessions);
		writeFileSync(
			join(caseDir, "commands.jsonl"),
			transcript.commands.map((command) => JSON.stringify(command)).join("\n") +
				"\n",
			{ mode: 0o600 },
		);
		casePaths.push(caseDir);
	}
	appendCases(evidenceRoot, casePaths);
	return evaluateEvidenceDirectory(evidenceRoot);
}

async function collectAcceptance(values) {
	const slot = Number(required(values, "slot"));
	const head = required(values, "head");
	const cell = required(values, "cell").toUpperCase();
	const runId = required(values, "run-id");
	const evidenceRoot = realpathSync(required(values, "evidence"));
	if (!FULL_SHA.test(head)) throw new Error("--head must be a full SHA");
	if (!Number.isInteger(slot) || slot < 1)
		throw new Error("--slot must be positive");
	if (!new Set(["A", "B"]).has(cell)) {
		throw new Error("collect currently supports generalized cells A and B");
	}
	const prepared = readJson(join(evidenceRoot, "manifest.json"));
	if (
		prepared.candidateHead !== head ||
		!SHA256.test(prepared.fixtureHash ?? "") ||
		prepared.fixture !== "literal-migration-v1"
	) {
		throw new Error("prepared evidence does not match the requested candidate");
	}
	const room = validateRoom(slot, head);
	if (room.generalized !== true) {
		throw new Error("collect --run-id requires a generalized room");
	}
	const health = await httpJson(`${room.bridgeUrl}/health`);
	if (
		health.ok !== true ||
		health.buildMode !== "built" ||
		health.buildSha !== head ||
		health.artifactBuildSha !== head
	) {
		throw new Error(
			`live room health does not match candidate HEAD: ${JSON.stringify(health)}`,
		);
	}
	const caseRoot = join(evidenceRoot, "runs", `${cell}-${runId}`);
	const runStatePath = join(caseRoot, "run.json");
	if (!existsSync(runStatePath)) {
		throw new Error(
			"collect requires the run.json receipt written by the original run command",
		);
	}
	const runState = readJson(runStatePath);
	const started = runState.started;
	if (
		runState.cell !== cell ||
		runState.slot !== slot ||
		runState.head !== head ||
		started?.workflowRunId !== runId ||
		started?.success !== true
	) {
		throw new Error("run.json does not bind the requested collect identity");
	}
	const db = openStateDatabase(room);
	let targets;
	let reworkObservation;
	let completionReady = false;
	try {
		const run = db
			.prepare("SELECT * FROM workflow_run WHERE run_id = ?")
			.get(runId);
		const rows = loadGeneralizedRoleRows(db, runId);
		const activeImplement = rows.find(
			(row) =>
				row.node_id === "implement" &&
				row.attempt > 1 &&
				!hasRoleCompletionReceipt(row),
		);
		if (activeImplement) {
			reworkObservation = observeReworkTestCommand({
				room,
				target: activeImplement,
				caseRoot,
				selection: {
					...readJson(join(evidenceRoot, "selection.json")),
					packageRoot: SUBJECT_RELATIVE,
				},
				runId,
			});
		}
		const completionTargets = generalizedCompletionTargets(
			run,
			rows,
			reworkObservation,
		);
		completionReady = completionTargets !== false;
		targets = completionTargets || generalizedTerminalTargets(rows);
		targets = targets.map((target) => ({
			...target,
			externalReviewSessions: loadExternalReviewSessions(
				db,
				target.execution_id,
			),
		}));
	} finally {
		db.close();
	}
	if (
		reworkObservation &&
		["PASS", "FAIL"].includes(reworkObservation.verdict)
	) {
		appendObservation(evidenceRoot, reworkObservation);
	} else if (completionReady) {
		appendObservation(evidenceRoot, {
			verdict: "PASS",
			reason: "collection_completed",
			runId,
			executionId: null,
		});
	} else if (!completionReady) {
		appendObservation(evidenceRoot, {
			verdict: "INCONCLUSIVE",
			reason: "collection_incomplete",
			runId,
			executionId: reworkObservation?.executionId ?? null,
			...(reworkObservation
				? { lastReworkObservation: reworkObservation }
				: {}),
		});
	}
	return freezeAcceptanceTargets({
		room,
		prepared,
		evidenceRoot,
		started,
		targets,
		cell,
		slot,
		head,
		backend: runState.backend,
		caseRoot,
		docFlow: runState.docFlow,
		oracle: runState.oracle,
	});
}

async function runAcceptance(values) {
	const slot = Number(required(values, "slot"));
	const issue = required(values, "issue");
	const head = required(values, "head");
	const role = required(values, "role");
	const backend = required(values, "backend");
	const evidenceRoot = realpathSync(required(values, "evidence"));
	const timeoutMs = values["timeout-ms"]
		? Number(values["timeout-ms"])
		: DEFAULT_TIMEOUT_MS;
	if (!isCanonicalIssueIdentifier(issue))
		throw new Error("--issue must be canonical");
	if (!FULL_SHA.test(head)) throw new Error("--head must be a full SHA");
	if (!["implement", "qa", "engineer"].includes(role))
		throw new Error("invalid --role");
	if (!["claude", "codex"].includes(backend))
		throw new Error("invalid --backend");
	if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000)
		throw new Error("invalid --timeout-ms");
	const prepared = readJson(join(evidenceRoot, "manifest.json"));
	if (
		prepared.candidateHead !== head ||
		!SHA256.test(prepared.fixtureHash ?? "") ||
		prepared.fixture !== "literal-migration-v1"
	) {
		throw new Error("prepared evidence does not match the requested candidate");
	}
	const room = validateRoom(slot, head);
	const health = await httpJson(`${room.bridgeUrl}/health`);
	if (
		health.ok !== true ||
		health.buildMode !== "built" ||
		health.buildSha !== head ||
		health.artifactBuildSha !== head
	) {
		throw new Error(
			`live room health does not match candidate HEAD: ${JSON.stringify(health)}`,
		);
	}
	const installedSubject = join(room.hostRepo, SUBJECT_RELATIVE);
	if (
		!existsSync(installedSubject) ||
		stableTreeHash(installedSubject) !== prepared.fixtureHash
	) {
		throw new Error(
			"sandbox subject fixture does not match the prepared fixture hash",
		);
	}
	const generalized = room.generalized === true;
	let cell = values.cell?.toUpperCase();
	if (!cell) {
		if (generalized) {
			cell =
				(role === "implement" && backend === "claude") ||
				(role === "qa" && backend === "codex")
					? "A"
					: "B";
		} else cell = backend === "claude" ? "C" : "D";
	}
	if (!["A", "B", "C", "D"].includes(cell)) throw new Error("invalid --cell");
	if (
		(generalized && !["A", "B"].includes(cell)) ||
		(!generalized && !["C", "D"].includes(cell))
	) {
		throw new Error("cell does not match the deployed room topology");
	}
	const expectedEntry = {
		A: { role: "implement", backend: "claude" },
		B: { role: "implement", backend: "codex" },
		C: { role: "engineer", backend: "claude" },
		D: { role: "engineer", backend: "codex" },
	}[cell];
	if (role !== expectedEntry.role || backend !== expectedEntry.backend) {
		throw new Error(
			`cell ${cell} requires --role ${expectedEntry.role} --backend ${expectedEntry.backend}`,
		);
	}
	const trust = spawnSync(
		"bash",
		[
			join(room.flywheelRepo, "scripts/lib/runner-workspace-trust.sh"),
			"pretrust-dual",
			`${room.hostRepo}-${issue}`,
		],
		{ encoding: "utf8" },
	);
	if (trust.status !== 0)
		throw new Error(`worktree pretrust failed: ${trust.stderr}`);
	const request = buildRunStartRequest({
		generalized,
		issue,
		projectName: room.projectName,
		leadId: room.agentId,
		cell,
	});
	const docFlow = roomDocFlowSnapshot(room);
	const oracle = oracleIdentity(room, head);
	const started = await postRunStart(room, request);
	if (started.success !== true || typeof started.executionId !== "string") {
		throw new Error(`run start refused: ${JSON.stringify(started)}`);
	}
	if (generalized && (started.generalized !== true || !started.workflowRunId)) {
		throw new Error(
			`generalized start identity is incomplete: ${JSON.stringify(started)}`,
		);
	}
	if (generalized) {
		const expectedModels = cellModels(cell);
		for (const [node, model] of Object.entries(expectedModels)) {
			if (!modelReceiptMatches(started, node, model)) {
				throw new Error(
					`cell ${cell} model mismatch for ${node}: expected overridden ${model} receipt, got ${JSON.stringify(started.resolved?.nodeModels?.[node] ?? null)}`,
				);
			}
		}
	}
	const caseRoot = join(
		evidenceRoot,
		"runs",
		`${cell}-${started.workflowRunId ?? started.executionId}`,
	);
	mkdirSync(caseRoot, { recursive: true, mode: 0o700 });
	atomicJson(join(caseRoot, "run.json"), {
		schemaVersion: 1,
		cell,
		slot,
		head,
		backend,
		request: sanitizeValue(request),
		started: sanitizeValue(started),
		docFlow,
		oracle,
	});
	const db = openStateDatabase(room);
	let targets;
	let waitError;
	let reworkObservation;
	try {
		if (generalized) {
			try {
				targets = await waitFor(
					`cell ${cell} implement+qa terminal role rows`,
					() => {
						const run = db
							.prepare("SELECT * FROM workflow_run WHERE run_id = ?")
							.get(started.workflowRunId);
						const rows = loadGeneralizedRoleRows(db, started.workflowRunId);
						const activeImplement = rows.find(
							(row) =>
								row.node_id === "implement" &&
								row.attempt > 1 &&
								!hasRoleCompletionReceipt(row),
						);
						if (activeImplement) {
							reworkObservation =
								observeReworkTestCommand({
									room,
									target: activeImplement,
									caseRoot,
									selection: {
										...readJson(join(evidenceRoot, "selection.json")),
										packageRoot: SUBJECT_RELATIVE,
									},
									runId: started.workflowRunId,
								}) ?? reworkObservation;
						}
						return generalizedCompletionTargets(run, rows, reworkObservation);
					},
					timeoutMs,
				);
			} catch (error) {
				waitError = error;
				const rows = loadGeneralizedRoleRows(db, started.workflowRunId);
				targets = generalizedTerminalTargets(rows);
			}
		} else {
			const standaloneKey = started.workflowRunId ?? started.executionId;
			try {
				const target = await waitFor(
					`cell ${cell} standalone engineer completion`,
					() => standaloneAcceptanceTarget(db, standaloneKey),
					timeoutMs,
				);
				targets = [target];
			} catch (error) {
				waitError = error;
				const target = standaloneAcceptanceTarget(db, standaloneKey);
				targets = target ? [target] : [];
			}
		}
		const withExternalReviews = (row) => ({
			...row,
			externalReviewSessions: loadExternalReviewSessions(db, row.execution_id),
		});
		targets = targets.map((target) => ({
			...withExternalReviews(target),
			...(target.supersededExecutions
				? {
						supersededExecutions:
							target.supersededExecutions.map(withExternalReviews),
					}
				: {}),
		}));
	} finally {
		db.close();
	}
	if (waitError) {
		if (reworkObservation?.verdict === "FAIL") {
			appendObservation(evidenceRoot, reworkObservation);
		} else {
			appendObservation(evidenceRoot, {
				verdict: "INCONCLUSIVE",
				reason: "observation_window_expired",
				runId: started.workflowRunId ?? `standalone:${started.executionId}`,
				executionId: reworkObservation?.executionId ?? null,
				detail:
					waitError instanceof Error ? waitError.message : String(waitError),
				...(reworkObservation
					? { lastReworkObservation: reworkObservation }
					: {}),
			});
		}
	} else if (reworkObservation) {
		appendObservation(evidenceRoot, reworkObservation);
	}
	return freezeAcceptanceTargets({
		room,
		prepared,
		evidenceRoot,
		started,
		targets,
		cell,
		slot,
		head,
		backend,
		caseRoot,
		docFlow,
		oracle,
	});
}
