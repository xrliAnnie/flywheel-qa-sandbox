import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * FLY-1241 read-deny + content-coordination removal sentinel (plan Step 1).
 *
 * A grep-zero guard that fails if any retired read-deny / content-coordination /
 * lead-actions broker-mode vocabulary creeps back into PRODUCTION source, scripts,
 * or contracts. This is the deletion task's regression net: before the removal it
 * is RED; after it, GREEN — and it stays GREEN for good.
 *
 * Scope (Codex design R2 #6 / R3 #3): the candidate set is the union of git-tracked
 * and non-ignored untracked files (so `dist`/`node_modules`/coverage never appear),
 * restricted to source/script/contract roots + extensions, and — crucially —
 * `existsSync`-filtered so a tracked-but-deleted-in-worktree path (this task deletes
 * several before tests run) is skipped rather than ENOENT-ing. This sentinel file
 * itself is excluded (it necessarily names the forbidden tokens).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// __tests__ → codex → lead-backends → src → teamlead → packages → repo root (6 up).
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..", "..");
const SELF = fileURLToPath(import.meta.url);

/** Files that legitimately NAME a retired token to assert its ABSENCE (same
 * exemption category as this sentinel itself). The infra-bot launcher test greps
 * the composed env for `FLYWHEEL_CODEX_LEAD_READ_DENY` to prove the pin is gone. */
const ABSENCE_ASSERTION_FILES: readonly string[] = [
	"packages/teamlead/scripts/__tests__/run-codex-infra-bot-tui.test.sh",
];

/** Forbidden token patterns. The split-JSDoc form (`content-` newline `* coordination`)
 * is caught by allowing whitespace / `*` between the halves. */
const FORBIDDEN: readonly RegExp[] = [
	// read-deny
	/FLYWHEEL_CODEX_LEAD_READ_DENY/,
	/codex_lead_read_deny/,
	/read-deny-profile/,
	/codex-read-deny-profile/,
	/\breadDeny\b/,
	// content-coordination (exact + camelCase + JSDoc split across lines/asterisks)
	/contentCoordination/,
	/content-[\s*]*coordination/i,
	// lead-actions broker-mode (content-coordination-only, deleted)
	/FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET/,
	/buildLeadActionsMcpServerConfig/,
	/assertLeadActionsConfigGate/,
	/toMcpServerToml/,
	// Precise: the deleted broker-mode type — but NOT the KEPT full-access
	// `buildFullAccessLeadActionsMcpServerConfig` (whose name legitimately contains
	// this substring). Negative lookbehind excludes the full-access variant.
	/(?<!FullAccess)LeadActionsMcpServerConfig/,
	/BuildLeadActionsMcpOptions/,
	/assertLeadActionsInventory/,
	/InventoryMismatchError/,
];

const KEEP_EXT = /\.(ts|js|mjs|sh|toml|md|yaml|yml|json|allow)$/;
/** Only production source / scripts / contracts — never history docs or QA scratch. */
const IN_SCOPE = (rel: string): boolean =>
	(rel.startsWith("packages/") ||
		rel.startsWith("scripts/") ||
		rel.startsWith("packages/teamlead/lead-rules-base/")) &&
	!rel.includes("/dist/") &&
	!rel.includes("/node_modules/") &&
	!rel.includes("/coverage/") &&
	!rel.startsWith("doc/") &&
	!rel.startsWith("qa-fly310/") &&
	!rel.startsWith(".claude/") &&
	KEEP_EXT.test(rel);

function gitFilesNul(args: string[]): string[] {
	const out = execFileSync("git", ["-C", REPO_ROOT, ...args], {
		encoding: "utf-8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return out.split("\0").filter((p) => p.length > 0);
}

/** Union of tracked + non-ignored untracked, in-scope, existing regular files. */
function candidateFiles(): string[] {
	const rels = new Set<string>([
		...gitFilesNul(["ls-files", "-z"]),
		...gitFilesNul(["ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	const files: string[] = [];
	for (const rel of rels) {
		if (!IN_SCOPE(rel)) continue;
		if (ABSENCE_ASSERTION_FILES.includes(rel)) continue;
		const full = join(REPO_ROOT, rel);
		if (full === SELF) continue;
		// tracked-but-deleted-in-worktree → skip (no ENOENT).
		if (!existsSync(full) || !statSync(full).isFile()) continue;
		files.push(full);
	}
	return files;
}

function scan(content: string): RegExp[] {
	return FORBIDDEN.filter((re) => re.test(content));
}

describe("FLY-1241 sentinel — read-deny / content-coordination / broker-mode must be gone", () => {
	it("the scanner itself detects each retired form (mutation check — can go RED)", () => {
		expect(
			scan("if (env.FLYWHEEL_CODEX_LEAD_READ_DENY === '1')"),
		).not.toHaveLength(0);
		expect(scan("readDeny: config.readDeny")).not.toHaveLength(0);
		expect(scan('profile === "content-coordination"')).not.toHaveLength(0);
		expect(scan("const contentCoordination = ...")).not.toHaveLength(0);
		// split-JSDoc form across a comment-leader newline must still match:
		expect(scan("full content-\n * coordination profile")).not.toHaveLength(0);
		expect(scan("buildLeadActionsMcpServerConfig({")).not.toHaveLength(0);
		expect(scan("FLYWHEEL_LEAD_ACTIONS_BROKER_SOCKET")).not.toHaveLength(0);
		// clean text stays clean:
		expect(scan("full-access lead-actions MCP env-token path")).toHaveLength(0);
	});

	it("no production source / script / contract file carries a retired token", () => {
		const files = candidateFiles();
		expect(files.length, "candidate set is non-empty").toBeGreaterThan(0);
		const violations: string[] = [];
		for (const file of files) {
			const hits = scan(readFileSync(file, "utf-8"));
			if (hits.length > 0) {
				violations.push(
					`${file.slice(REPO_ROOT.length + 1)} → ${hits.map((r) => r.source).join(", ")}`,
				);
			}
		}
		expect(violations, `\n${violations.join("\n")}`).toHaveLength(0);
	});
});
