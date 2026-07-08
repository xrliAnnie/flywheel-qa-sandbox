// FLY-997 harness common layer — sandbox assertions, per-round driver,
// JSONL evidence writers, budget/quota accounting.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { QuotaError, runAgent } from "./agent-loop.mjs";
import { CONFIG } from "./config.mjs";
import { SCENARIOS, SYSTEM_INSTRUCTION } from "./judge.mjs";
import { startMockBridge } from "./mock-bridge.mjs";
import { assertSandbox, getSeenOrigins } from "./sandbox-guard.mjs";
import { registryFor } from "./tools.mjs";

const MOCK = `http://${CONFIG.mock.host}:${CONFIG.mock.port}`;

/** Guard 3: static import check — harness sources must never import the
 * Linear SDK or flywheel-comm. Scoped to spike *.mjs sources only (Codex
 * R2-3: not lockfiles/README). The exact command is recorded in evidence. */
export function assertNoForbiddenImports() {
	const dir = dirname(new URL(import.meta.url).pathname);
	const cmd = [
		"grep",
		"-l",
		"-E",
		"from ['\"](@linear/sdk|flywheel-comm)",
		"--include=*.mjs",
		"-r",
		dir,
	];
	let hits = "";
	try {
		hits = execFileSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
	} catch (e) {
		if (e.status === 1)
			hits = ""; // grep: no matches
		else throw e;
	}
	if (hits.trim()) {
		console.error(
			`[sandbox-guard] FAIL-CLOSED: forbidden imports found:\n${hits}`,
		);
		process.exit(78);
	}
	return { guard: "static-imports", ok: true, command: cmd.join(" ") };
}

export function initHarness() {
	const g2 = assertSandbox();
	const g3 = assertNoForbiddenImports();
	mkdirSync(CONFIG.paths.outDir, { recursive: true });
	mkdirSync(CONFIG.paths.evidenceDir, { recursive: true });
	const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
	return { ai, guards: [g2, g3] };
}

export async function withMock(fn) {
	const server = await startMockBridge(CONFIG.mock);
	try {
		return await fn();
	} finally {
		server.close();
	}
}

async function mockReset(faults) {
	await fetch(`${MOCK}/__mock/reset`, { method: "POST" });
	if (faults && Object.keys(faults).length) {
		await fetch(`${MOCK}/__mock/config`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ faults }),
		});
	}
}

async function mockState() {
	const res = await fetch(`${MOCK}/__mock/state`);
	return res.json();
}

export function jsonlWriter(file) {
	return (obj) => appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

let sessionCount = 0;
let consecutiveQuota = 0;

/** Run one scenario round: reset mock → run loop → judge → JSONL. */
export async function runRound({
	ai,
	scenarioKey,
	modelTier,
	surface,
	roundIndex,
	rawWriter,
	auditWriter,
}) {
	const scenario = SCENARIOS[scenarioKey];
	if (!scenario) throw new Error(`unknown scenario ${scenarioKey}`);
	if (sessionCount >= CONFIG.budget.maxSessions) {
		throw new Error(
			`budget exceeded: ${sessionCount} sessions (cap ${CONFIG.budget.maxSessions})`,
		);
	}
	sessionCount += 1;
	await mockReset(scenario.faults);

	const model = CONFIG.models[modelTier];
	const base = {
		scenario: scenarioKey,
		modelTier,
		model,
		surface,
		round: roundIndex,
		ts: new Date().toISOString(),
	};
	try {
		const runResult = await runAgent({
			ai,
			model,
			surface,
			systemInstruction: SYSTEM_INSTRUCTION,
			userMessage: scenario.prompt,
			registry: registryFor(scenario.tools),
			maxSteps: CONFIG.loop.maxSteps,
			audit: (line) => auditWriter({ ...base, ...line }),
		});
		consecutiveQuota = 0;
		const mock = await mockState();
		const verdict = scenario.judge(runResult, mock);
		rawWriter({
			...base,
			verdict,
			finalText: runResult.finalText,
			toolCalls: runResult.toolCalls,
			usage: runResult.usage,
			mockGroundTruth: {
				issues: mock.issues,
				runs: mock.runs,
				memories: mock.memories.length,
				shipApprovalRequests: mock.shipApprovalRequests,
			},
		});
		return { ok: true, verdict };
	} catch (err) {
		if (err instanceof QuotaError) {
			consecutiveQuota += 1;
			rawWriter({
				...base,
				error: "quota_429",
				detail: String(err.message).slice(0, 300),
			});
			if (consecutiveQuota >= CONFIG.budget.quotaHaltAfter) {
				console.error(
					`[harness] ${consecutiveQuota} consecutive 429s — halting (plan §4: no retry loops)`,
				);
				throw err;
			}
			// spacing pause before the NEXT round (single pause, not a retry of this one)
			await new Promise((r) => setTimeout(r, 30_000));
			return { ok: false, quota: true };
		}
		rawWriter({
			...base,
			error: "round_error",
			detail: String(err?.stack ?? err).slice(0, 500),
		});
		return { ok: false, error: String(err?.message ?? err) };
	}
}

export function summarize(results) {
	const done = results.filter((r) => r.ok);
	const succ = done.filter((r) => r.verdict.success);
	const agg = {
		rounds: results.length,
		completedRounds: done.length,
		quotaAborted: results.filter((r) => r.quota).length,
		errorRounds: results.filter((r) => !r.ok && !r.quota).length,
		successes: succ.length,
		successRate: done.length ? +(succ.length / done.length).toFixed(3) : null,
		avgParamFirstPass: done.length
			? +(
					done.reduce((s, r) => s + r.verdict.paramFirstPass, 0) / done.length
				).toFixed(3)
			: null,
		hallucinatedToolsTotal: done.reduce(
			(s, r) => s + r.verdict.hallucinatedTools,
			0,
		),
		maxStepsExceeded: done.filter((r) => r.verdict.maxStepsExceeded).length,
		avgSteps: done.length
			? +(done.reduce((s, r) => s + r.verdict.steps, 0) / done.length).toFixed(
					1,
				)
			: null,
		tokens: {
			input: done.reduce((s, r) => s + (r.verdict.tokens?.input ?? 0), 0),
			output: done.reduce((s, r) => s + (r.verdict.tokens?.output ?? 0), 0),
		},
	};
	return agg;
}

export function origins() {
	return getSeenOrigins();
}
export function sessionsUsed() {
	return sessionCount;
}
