/**
 * FLY-350 (Z) unit 6 / R4-2 — workflow-permission scanner: synthetic-fixture
 * unit tests + a REGRESSION guard that runs the scanner against the repo's real
 * `.github/workflows/*` (zero violations = the R3-2 invariant holds, and a future
 * unpinned pull_request workflow fails CI here).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanWorkflowPermissions } from "../ci/workflow-permissions.js";

describe("scanWorkflowPermissions (R4-2 synthetic)", () => {
	it("clean: a pull_request workflow pinned to contents: read", () => {
		const v = scanWorkflowPermissions([
			{
				name: "ci.yml",
				content:
					"on:\n  pull_request:\n    branches: [main]\npermissions:\n  contents: read\njobs: {}\n",
			},
		]);
		expect(v).toEqual([]);
	});

	it("FLAGS a pull_request workflow with NO permissions block (repo-default token)", () => {
		const v = scanWorkflowPermissions([
			{ name: "ci.yml", content: "on:\n  pull_request:\njobs: {}\n" },
		]);
		expect(v).toHaveLength(1);
		expect(v[0]?.reason).toMatch(/no top-level `permissions:`/);
	});

	it("FLAGS a write scope on a pull_request workflow", () => {
		const v = scanWorkflowPermissions([
			{
				name: "ci.yml",
				content:
					"on: [pull_request]\npermissions:\n  contents: read\n  pull-requests: write\njobs: {}\n",
			},
		]);
		expect(v).toHaveLength(1);
		expect(v[0]?.reason).toMatch(/write.*pull-requests|pull-requests.*write/i);
	});

	it("FLAGS write-all", () => {
		const v = scanWorkflowPermissions([
			{
				name: "ci.yml",
				content: "on:\n  pull_request:\npermissions: write-all\njobs: {}\n",
			},
		]);
		expect(v[0]?.reason).toMatch(/write-all/);
	});

	it("FLAGS pull_request_target always (even pinned)", () => {
		const v = scanWorkflowPermissions([
			{
				name: "prt.yml",
				content:
					"on:\n  pull_request_target:\npermissions:\n  contents: read\njobs: {}\n",
			},
		]);
		expect(v.some((x) => /pull_request_target/.test(x.reason))).toBe(true);
	});

	it("IGNORES a push-only workflow (no pull_request trigger)", () => {
		const v = scanWorkflowPermissions([
			{
				name: "deploy.yml",
				content: "on:\n  push:\n    branches: [main]\njobs: {}\n",
			},
		]);
		expect(v).toEqual([]);
	});

	it("FLAGS a job-level permissions override that re-grants write (Codex MEDIUM)", () => {
		const v = scanWorkflowPermissions([
			{
				name: "ci.yml",
				content:
					"on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  build:\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n",
			},
		]);
		expect(v).toHaveLength(1);
		expect(v[0]?.reason).toMatch(
			/job "build".*contents.*write|job "build".*write.*contents/i,
		);
	});

	it("a job that OMITS permissions inherits the validated top-level (no false positive)", () => {
		const v = scanWorkflowPermissions([
			{
				name: "ci.yml",
				content:
					"on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n",
			},
		]);
		expect(v).toEqual([]);
	});

	it("read-all is acceptable (no write)", () => {
		const v = scanWorkflowPermissions([
			{
				name: "ci.yml",
				content: "on: [pull_request]\npermissions: read-all\njobs: {}\n",
			},
		]);
		expect(v).toEqual([]);
	});
});

describe("R4-2 regression — the repo's real workflows are least-privilege", () => {
	/** Walk up from this test file to the repo root (the dir holding .github). */
	function findRepoRoot(): string | undefined {
		let dir = dirname(fileURLToPath(import.meta.url));
		for (let i = 0; i < 8; i++) {
			if (existsSync(join(dir, ".github", "workflows"))) return dir;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		return undefined;
	}

	it("every pull_request workflow in .github/workflows is pinned (no write, no unreviewed pull_request_target)", () => {
		const root = findRepoRoot();
		// In a sparse/standalone checkout the workflows dir may be absent; skip
		// rather than false-fail (the synthetic tests cover the logic).
		if (!root) {
			expect(true).toBe(true);
			return;
		}
		const wfDir = join(root, ".github", "workflows");
		const files = readdirSync(wfDir)
			.filter((f) => /\.ya?ml$/.test(f))
			.map((f) => ({ name: f, content: readFileSync(join(wfDir, f), "utf8") }));
		const violations = scanWorkflowPermissions(files);
		expect(
			violations,
			`R4-2: unpinned/over-privileged PR workflow(s):\n${violations
				.map((v) => `  - ${v.file}: ${v.reason}`)
				.join("\n")}`,
		).toEqual([]);
	});
});
