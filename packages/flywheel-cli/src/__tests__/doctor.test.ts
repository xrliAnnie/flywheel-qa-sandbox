import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor } from "../commands/doctor.js";
import { init } from "../commands/init.js";

describe("flywheel doctor", () => {
	let root: string;

	beforeEach(() => {
		const raw = join(tmpdir(), `fly-doctor-${Date.now()}-${Math.random()}`);
		mkdirSync(raw, { recursive: true });
		// macOS tmpdir is `/var/folders/...` symlinked to `/private/var/folders/...`.
		// Process.cwd() returns the canonical (realpath) form after chdir, so
		// normalize `root` once to match — otherwise walk-up tests compare
		// symlink-prefixed vs canonical paths and fail.
		root = realpathSync(raw);
		execFileSync("git", ["init", "-q"], { cwd: root });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("errors when config.yaml is missing", () => {
		const report = doctor({ projectPath: root });
		expect(report.errors.some((e) => e.includes("Missing"))).toBe(true);
	});

	it("exits clean on a fresh init project", () => {
		init({ projectPath: root, depts: ["product"] });
		const report = doctor({ projectPath: root });
		expect(report.errors).toEqual([]);
	});

	it("detects legacy .claude/agents/ paths BEFORE attempting parse", () => {
		init({ projectPath: root, noDepts: true });
		// Hand-edit config to include the legacy path.
		const cfgPath = join(root, ".flywheel", "config.yaml");
		writeFileSync(
			cfgPath,
			`project:\n  name: "x"\nagents:\n  backend:\n    agent_file: .claude/agents/backend-executor.md\n    match:\n      labels: ["backend"]\n`,
		);
		const report = doctor({ projectPath: root });
		expect(report.errors.length).toBeGreaterThan(0);
		expect(report.errors[0]).toMatch(/migrate-agents-path/);
	});

	it("errors on a broken agent_file path", () => {
		init({ projectPath: root, depts: ["product"] });
		const cfgPath = join(root, ".flywheel", "config.yaml");
		writeFileSync(
			cfgPath,
			`project:\n  name: "x"\nagents:\n  backend:\n    agent_file: .flywheel/agents/product/missing-executor.md\n    department: product\n    match:\n      labels: ["backend"]\n`,
		);
		const report = doctor({ projectPath: root });
		expect(report.errors.some((e) => e.includes("does not exist"))).toBe(true);
	});

	it("warns on duplicate aliases across multiple agents", () => {
		init({ projectPath: root, depts: ["product"] });
		// Create two real agent files.
		mkdirSync(join(root, ".flywheel", "agents", "product"), {
			recursive: true,
		});
		writeFileSync(
			join(root, ".flywheel", "agents", "product", "frontend-executor.md"),
			"# frontend",
		);
		writeFileSync(
			join(root, ".flywheel", "agents", "product", "designer-executor.md"),
			"# designer",
		);
		writeFileSync(
			join(root, ".flywheel", "config.yaml"),
			[
				`project:`,
				`  name: "x"`,
				`agents:`,
				`  frontend:`,
				`    agent_file: .flywheel/agents/product/frontend-executor.md`,
				`    department: product`,
				`    match:`,
				`      labels: ["frontend", "ui"]`,
				`  designer:`,
				`    agent_file: .flywheel/agents/product/designer-executor.md`,
				`    department: product`,
				`    match:`,
				`      labels: ["designer", "ui"]`,
				``,
			].join("\n"),
		);
		const report = doctor({ projectPath: root });
		expect(
			report.warnings.some((w) => w.includes("ui") && w.includes("frontend")),
		).toBe(true);
	});

	it("info-logs orphan dept dirs (no agent declares the dept)", () => {
		init({ projectPath: root, depts: ["product", "marketing"] });
		// Declare only product agents — marketing/ is orphan.
		writeFileSync(
			join(root, ".flywheel", "agents", "product", "backend-executor.md"),
			"# backend",
		);
		writeFileSync(
			join(root, ".flywheel", "config.yaml"),
			[
				`project:`,
				`  name: "x"`,
				`agents:`,
				`  backend:`,
				`    agent_file: .flywheel/agents/product/backend-executor.md`,
				`    department: product`,
				`    match:`,
				`      labels: ["backend"]`,
				``,
			].join("\n"),
		);
		const report = doctor({ projectPath: root });
		expect(report.errors).toEqual([]);
		expect(
			report.info.some(
				(i) => i.includes("'marketing'") && i.includes("orphan"),
			),
		).toBe(true);
	});

	it("walks up from a nested subdir to find .flywheel/", () => {
		init({ projectPath: root, depts: ["product"] });
		const nested = join(root, "packages", "foo");
		mkdirSync(nested, { recursive: true });
		const origCwd = process.cwd();
		try {
			process.chdir(nested);
			const report = doctor();
			expect(report.projectPath).toBe(root);
		} finally {
			process.chdir(origCwd);
		}
	});
});
