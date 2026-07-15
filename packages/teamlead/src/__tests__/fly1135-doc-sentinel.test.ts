import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * FLY-1135 doc-consistency sentinel (plan preamble, Codex design R2 #1).
 *
 * Rejects regressions of retired design vocabulary:
 *   1. old `edge_token` / `edge-token` terminology — the contract is a
 *      DECISION CAPABILITY bound to a node attempt, never a pre-selected edge;
 *   2. describing a template field-value edit as live-mutating an IN-FLIGHT
 *      run ("即时改在跑") — edits produce a NEW revision for the NEXT run.
 *
 * Scoped exclusions (the sentinel must not match its own declaration):
 *   - the plan.md blockquote that DECLARES this sentinel;
 *   - negations of (2) ("不是「即时改在跑…" is the correct statement);
 *   - the archived Codex review rounds + DR report (historical records that
 *     legitimately quote the old term);
 *   - this test file itself.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const DOC_DIR = join(
	REPO_ROOT,
	"engineering",
	"doc",
	"FLY-1135-layer1-dag-templates",
);

const EDGE_TOKEN_RE = /edge[_-]token/i;
const LIVE_MUTATE_RE = /即时改在跑/;
const SENTINEL_DECLARATION_MARKER = "doc 一致性 sentinel";

/** Strip the blockquote run (consecutive `>` lines) declaring the sentinel. */
function stripSentinelDeclaration(content: string): string[] {
	const lines = content.split("\n");
	const kept: string[] = [];
	let i = 0;
	while (i < lines.length) {
		if (lines[i]?.startsWith(">")) {
			const run: string[] = [];
			while (i < lines.length && lines[i]?.startsWith(">")) {
				run.push(lines[i] as string);
				i++;
			}
			if (!run.some((l) => l.includes(SENTINEL_DECLARATION_MARKER))) {
				kept.push(...run);
			}
			continue;
		}
		kept.push(lines[i] as string);
		i++;
	}
	return kept;
}

/** Scan lines for forbidden vocabulary; returns "line#: text" violations. */
function findDocViolations(lines: string[]): string[] {
	const violations: string[] = [];
	lines.forEach((line, idx) => {
		if (EDGE_TOKEN_RE.test(line)) {
			violations.push(`${idx + 1}: ${line.trim()}`);
		}
		if (LIVE_MUTATE_RE.test(line) && !line.includes("不是「即时改在跑")) {
			violations.push(`${idx + 1}: ${line.trim()}`);
		}
	});
	return violations;
}

function walkSourceFiles(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			walkSourceFiles(full, out);
		} else if (/\.(ts|js|mjs|yaml|yml)$/.test(entry)) {
			out.push(full);
		}
	}
}

describe("FLY-1135 doc sentinel — retired vocabulary must not creep back", () => {
	it("the scanner itself detects violations (mutation check — this sentinel can go red)", () => {
		expect(findDocViolations(["the edge_token is issued here"])).toHaveLength(
			1,
		);
		expect(findDocViolations(["an edge-token bound to the edge"])).toHaveLength(
			1,
		);
		expect(findDocViolations(["字段值改即时改在跑的 run"])).toHaveLength(1);
		// …and the scoped exclusions genuinely exclude:
		expect(
			findDocViolations(["下一个新 run(不是「即时改在跑的 run」)"]),
		).toHaveLength(0);
		expect(
			stripSentinelDeclaration(
				"> **doc 一致性 sentinel**:\n> 拒回潮:旧 edge-token 术语\nbody",
			),
		).toEqual(["body"]);
	});

	it("the design trio (exploration/research/plan) carries no retired vocabulary", () => {
		for (const doc of ["exploration.md", "research.md", "plan.md"]) {
			const content = readFileSync(join(DOC_DIR, doc), "utf-8");
			const lines = stripSentinelDeclaration(content);
			const violations = findDocViolations(lines);
			expect(violations, `${doc} → ${violations.join(" | ")}`).toHaveLength(0);
		}
	});

	it("engine source trees carry no edge-token terminology", () => {
		const files: string[] = [];
		for (const pkg of ["teamlead", "config", "flywheel-comm"]) {
			walkSourceFiles(join(REPO_ROOT, "packages", pkg, "src"), files);
		}
		const self = fileURLToPath(import.meta.url);
		const violations: string[] = [];
		for (const file of files) {
			if (file === self) continue;
			const content = readFileSync(file, "utf-8");
			if (EDGE_TOKEN_RE.test(content)) {
				violations.push(relative(REPO_ROOT, file));
			}
		}
		expect(violations, violations.join(", ")).toHaveLength(0);
	});
});
