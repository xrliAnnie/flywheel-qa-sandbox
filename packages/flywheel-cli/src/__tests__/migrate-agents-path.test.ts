import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { init } from "../commands/init.js";
import { migrate } from "../commands/migrate-agents-path.js";

const GEOFORGE_README = `# Executor Files

| Executor file | Linear label |
|---|---|
| backend-executor.md | Product |
| frontend-executor.md | Product |
| designer-executor.md | Product |
| operations-executor.md | Operations |
| marketing-executor.md | Marketing |
| general-executor.md | any |
`;

function gitCommitAll(repoRoot: string): void {
	execFileSync("git", ["config", "user.email", "test@example.com"], {
		cwd: repoRoot,
	});
	execFileSync("git", ["config", "user.name", "test"], { cwd: repoRoot });
	execFileSync("git", ["add", "-A"], { cwd: repoRoot });
	execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repoRoot });
}

describe("flywheel migrate-agents-path", () => {
	let root: string;
	let claudeDir: string;

	beforeEach(() => {
		root = join(tmpdir(), `fly-migrate-${Date.now()}-${Math.random()}`);
		mkdirSync(root, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["checkout", "-q", "-b", "main"], { cwd: root });

		// Seed init project.
		init({ projectPath: root, depts: ["product", "operations", "marketing"] });

		// Seed legacy .claude/agents.
		claudeDir = join(root, ".claude", "agents");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(join(claudeDir, "README.md"), GEOFORGE_README);
		writeFileSync(join(claudeDir, "backend-executor.md"), "# backend\n");
		writeFileSync(join(claudeDir, "frontend-executor.md"), "# frontend\n");
		writeFileSync(join(claudeDir, "operations-executor.md"), "# ops\n");
		writeFileSync(join(claudeDir, "general-executor.md"), "# generic\n");

		// Add a config that already references the legacy paths so we can
		// verify the rewrite path.
		writeFileSync(
			join(root, ".flywheel", "config.yaml"),
			[
				`project:`,
				`  name: "x"`,
				`agents:`,
				`  backend:`,
				`    agent_file: .claude/agents/backend-executor.md`,
				`    match:`,
				`      labels: ["backend"]`,
				`  frontend:`,
				`    agent_file: .claude/agents/frontend-executor.md`,
				`    match:`,
				`      labels: ["frontend"]`,
				`  operations:`,
				`    agent_file: .claude/agents/operations-executor.md`,
				`    match:`,
				`      labels: ["ops"]`,
				`  general:`,
				`    agent_file: .claude/agents/general-executor.md`,
				`    match:`,
				`      labels: []`,
				``,
			].join("\n"),
		);
		gitCommitAll(root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("relocates README-mapped files to dept dirs + top-level for general", () => {
		const result = migrate({ projectPath: root });

		const movedMap = Object.fromEntries(
			result.moved.map((m) => [m.from, { to: m.to, dept: m.dept }]),
		);
		expect(movedMap[".claude/agents/backend-executor.md"]).toEqual({
			to: ".flywheel/agents/product/backend-executor.md",
			dept: "product",
		});
		expect(movedMap[".claude/agents/frontend-executor.md"]).toEqual({
			to: ".flywheel/agents/product/frontend-executor.md",
			dept: "product",
		});
		expect(movedMap[".claude/agents/operations-executor.md"]).toEqual({
			to: ".flywheel/agents/operations/operations-executor.md",
			dept: "operations",
		});
		// general-executor → top-level (no dept dir prefix)
		expect(movedMap[".claude/agents/general-executor.md"]).toEqual({
			to: ".flywheel/agents/general-executor.md",
			dept: "__top__",
		});

		// Files moved physically.
		expect(
			existsSync(
				join(root, ".flywheel", "agents", "product", "backend-executor.md"),
			),
		).toBe(true);
		expect(
			existsSync(join(root, ".claude", "agents", "backend-executor.md")),
		).toBe(false);

		// Config rewritten with new paths.
		const cfg = readFileSync(join(root, ".flywheel", "config.yaml"), "utf-8");
		expect(cfg).toContain(
			"agent_file: .flywheel/agents/product/backend-executor.md",
		);
		expect(cfg).toContain("agent_file: .flywheel/agents/general-executor.md");
		expect(cfg).not.toContain(".claude/agents/");

		// `department:` field inserted for dept-owned agents at the same
		// indent as agent_file (per plan §Phase 6 acceptance criteria).
		expect(cfg).toMatch(
			/agent_file: \.flywheel\/agents\/product\/backend-executor\.md\n\s+department: product/,
		);
		expect(cfg).toMatch(
			/agent_file: \.flywheel\/agents\/product\/frontend-executor\.md\n\s+department: product/,
		);
		expect(cfg).toMatch(
			/agent_file: \.flywheel\/agents\/operations\/operations-executor\.md\n\s+department: operations/,
		);
		// general-executor → top-level: NO department field on that agent.
		const cfgLines = cfg.split("\n");
		const generalIdx = cfgLines.findIndex((l) => l.trim() === "general:");
		const generalBlock = cfgLines.slice(generalIdx, generalIdx + 6).join("\n");
		expect(generalBlock).not.toMatch(/department:/);
	});

	it("handles quoted agent_file values + trailing comments when inserting department:", () => {
		// Rewrite config to use quoted values + trailing comments before
		// migrating. The path-rewrite pass operates on the literal string
		// so we have to keep the same surface.
		writeFileSync(
			join(root, ".flywheel", "config.yaml"),
			[
				`project:`,
				`  name: "x"`,
				`agents:`,
				`  backend:`,
				`    agent_file: ".claude/agents/backend-executor.md"  # primary`,
				`    match:`,
				`      labels: ["backend"]`,
				`  frontend:`,
				`    agent_file: '.claude/agents/frontend-executor.md'`,
				`    match:`,
				`      labels: ["frontend"]`,
				`  general:`,
				`    agent_file: .claude/agents/general-executor.md`,
				`    match:`,
				`      labels: []`,
				``,
			].join("\n"),
		);
		gitCommitAll(root);

		migrate({ projectPath: root });
		const cfg = readFileSync(join(root, ".flywheel", "config.yaml"), "utf-8");
		// `department:` inserted for the quoted + commented backend block
		// AND for the single-quoted frontend block, but NOT for the bare
		// top-level general entry.
		expect(cfg).toMatch(/backend:[\s\S]*?department: product/);
		expect(cfg).toMatch(/frontend:[\s\S]*?department: product/);
		const lines = cfg.split("\n");
		const generalIdx = lines.findIndex((l) => l.trim() === "general:");
		const generalBlock = lines.slice(generalIdx, generalIdx + 6).join("\n");
		expect(generalBlock).not.toMatch(/department:/);
	});

	it("throws when agent_file is inline-flow / cannot be located as a block scalar", () => {
		// Inline-flow agents block — line-scan helper can't locate it.
		writeFileSync(
			join(root, ".flywheel", "config.yaml"),
			[
				`project: { name: "x" }`,
				`agents: { backend: { agent_file: .claude/agents/backend-executor.md, match: { labels: ["backend"] } }, general: { agent_file: .claude/agents/general-executor.md, match: { labels: [] } } }`,
				``,
			].join("\n"),
		);
		gitCommitAll(root);

		expect(() => migrate({ projectPath: root })).toThrow(
			/Could not locate `agent_file: \.flywheel\/agents\/product\/backend-executor\.md` as a block-style YAML scalar/,
		);
	});

	it("inserts department: field idempotently — second migrate does not duplicate", () => {
		migrate({ projectPath: root });
		const cfgAfterFirst = readFileSync(
			join(root, ".flywheel", "config.yaml"),
			"utf-8",
		);
		const linesFirst = cfgAfterFirst.split("\n");
		const backendIdx1 = linesFirst.findIndex((l) => l.trim() === "backend:");
		const backendBlock1 = linesFirst
			.slice(backendIdx1, backendIdx1 + 6)
			.join("\n");
		expect(backendBlock1.match(/department: product/g)?.length).toBe(1);

		// Second run (force, since the worktree is now dirty from the first
		// move). Migration is a no-op for already-relocated files, so config
		// should not be re-rewritten — but if the helper runs anyway it must
		// not duplicate the field.
		migrate({ projectPath: root, force: true });
		const cfgAfterSecond = readFileSync(
			join(root, ".flywheel", "config.yaml"),
			"utf-8",
		);
		const linesSecond = cfgAfterSecond.split("\n");
		const backendIdx2 = linesSecond.findIndex((l) => l.trim() === "backend:");
		const backendBlock2 = linesSecond
			.slice(backendIdx2, backendIdx2 + 6)
			.join("\n");
		expect(backendBlock2.match(/department: product/g)?.length).toBe(1);
	});

	it("--dept-map overrides README mapping", () => {
		const mapPath = join(root, "dept-map.json");
		writeFileSync(
			mapPath,
			JSON.stringify({
				"backend-executor.md": "operations", // override
				"frontend-executor.md": "operations",
				"operations-executor.md": "marketing",
				"general-executor.md": "__top__",
			}),
		);
		const result = migrate({ projectPath: root, deptMap: mapPath });
		const movedMap = Object.fromEntries(
			result.moved.map((m) => [m.from, m.to]),
		);
		expect(movedMap[".claude/agents/backend-executor.md"]).toBe(
			".flywheel/agents/operations/backend-executor.md",
		);
	});

	it("refuses to migrate when worktree is dirty", () => {
		writeFileSync(join(claudeDir, "backend-executor.md"), "# modified\n");
		// Working tree is dirty now.
		expect(() => migrate({ projectPath: root })).toThrow(
			/uncommitted changes|Refusing/i,
		);
	});

	it("accepts --force when dirty", () => {
		writeFileSync(join(claudeDir, "backend-executor.md"), "# modified\n");
		expect(() => migrate({ projectPath: root, force: true })).not.toThrow();
	});

	it("idempotent: second run is a no-op", () => {
		migrate({ projectPath: root });
		// Re-seed legacy dir (simulating a stale partial migration). Real
		// idempotent re-run on the same starting state has nothing to move
		// since files were already relocated.
		const result2 = migrate({
			projectPath: root,
			// dirty after move because no fresh commit
			force: true,
		});
		expect(result2.moved).toHaveLength(0);
	});

	it("QA Finding 1: parser handles bolded labels (**Marketing**) + em-dash rows", () => {
		// Re-seed the README with GeoForge3D-style markdown bolding + em-
		// dash rows. The previous parser missed `**Operations**` /
		// `**Marketing**` (silently dropped → required --dept-map) and
		// `—` rows (also silently dropped). Confirm both flow correctly.
		writeFileSync(
			join(claudeDir, "README.md"),
			[
				`# Executor Files`,
				``,
				`| Executor file | Linear label |`,
				`|---|---|`,
				`| **\`backend-executor.md\`** | **Product** |`,
				`| frontend-executor.md | Product |`,
				`| **\`operations-executor.md\`** | **Operations** |`,
				`| **\`marketing-executor.md\`** | **Marketing** |`,
				`| plan-generator-executor.md | — |`,
				`| general-executor.md | any |`,
				``,
			].join("\n"),
		);
		// Also seed the additional executor files so migrate moves them.
		writeFileSync(join(claudeDir, "marketing-executor.md"), "# mkt\n");
		writeFileSync(
			join(claudeDir, "plan-generator-executor.md"),
			"# plan-gen\n",
		);
		execFileSync("git", ["add", "-A"], { cwd: root });
		execFileSync("git", ["commit", "-q", "-m", "seed bolded readme"], {
			cwd: root,
		});

		const result = migrate({ projectPath: root });
		const movedMap = Object.fromEntries(
			result.moved.map((m) => [m.from, m.dept]),
		);
		// Bolded Operations / Marketing rows routed correctly.
		expect(movedMap[".claude/agents/operations-executor.md"]).toBe(
			"operations",
		);
		expect(movedMap[".claude/agents/marketing-executor.md"]).toBe("marketing");
		// Em-dash row routed to top-level (no Linear label = catch-all).
		expect(movedMap[".claude/agents/plan-generator-executor.md"]).toBe(
			"__top__",
		);
	});

	it("QA Finding 2: atomic — throws BEFORE any git mv when a mapping is missing", () => {
		// Seed an unmapped executor; no README entry for it, no --dept-map.
		writeFileSync(join(claudeDir, "unmapped-executor.md"), "# unmapped\n");
		gitCommitAll(root);

		// Pre-migration snapshot: every original file lives at its
		// .claude/agents/ path.
		const originals = [
			"backend-executor.md",
			"frontend-executor.md",
			"operations-executor.md",
			"general-executor.md",
			"unmapped-executor.md",
		];
		for (const f of originals) {
			expect(existsSync(join(claudeDir, f))).toBe(true);
		}

		expect(() => migrate({ projectPath: root })).toThrow(
			/No dept mapping for unmapped-executor\.md/,
		);

		// Atomicity invariant: no file was relocated, and the dept dirs
		// in `.flywheel/agents/` should still be empty (init only put a
		// .gitkeep there). The pre-flight pass throws before touching
		// disk, so users can re-run migrate after fixing the README
		// without `git reset --hard` first.
		for (const f of originals) {
			expect(existsSync(join(claudeDir, f))).toBe(true);
		}
		expect(
			existsSync(
				join(root, ".flywheel", "agents", "product", "backend-executor.md"),
			),
		).toBe(false);
		expect(
			existsSync(
				join(
					root,
					".flywheel",
					"agents",
					"operations",
					"operations-executor.md",
				),
			),
		).toBe(false);
		expect(
			existsSync(join(root, ".flywheel", "agents", "general-executor.md")),
		).toBe(false);
	});

	it("rejects unmapped files without --dept-map and no askDept callback", () => {
		writeFileSync(join(claudeDir, "unknown-executor.md"), "# unknown\n");
		gitCommitAll(root);
		expect(() => migrate({ projectPath: root })).toThrow(/No dept mapping/);
	});

	it("uses askDept callback for files not in mapping", () => {
		writeFileSync(join(claudeDir, "qa-executor.md"), "# qa\n");
		gitCommitAll(root);
		const result = migrate({
			projectPath: root,
			askDept: (name) => (name === "qa-executor.md" ? "product" : null),
		});
		const qa = result.moved.find(
			(m) => m.from === ".claude/agents/qa-executor.md",
		);
		expect(qa).toBeDefined();
		expect(qa!.dept).toBe("product");
	});
});
