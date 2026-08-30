import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(
	new URL("../../../../scripts/fly2121-legacy-census.sh", import.meta.url),
);
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function run(dbPath: string) {
	return JSON.parse(
		execFileSync("bash", [SCRIPT, dbPath], { encoding: "utf8" }),
	) as {
		legacyNodeRuns: number;
		unpinnedAgentRuns: number;
		removable: boolean;
	};
}

describe("FLY-2121 legacy execution census", () => {
	it("counts only nonterminal legacy ids and engine pins lacking agent content", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2121-census-"));
		roots.push(root);
		const dbPath = join(root, "teamlead.db");
		const db = new Database(dbPath);
		db.exec(`
			CREATE TABLE workflow_run (
				run_id TEXT PRIMARY KEY,
				status TEXT NOT NULL,
				current_node_id TEXT,
				engine_owned INTEGER NOT NULL,
				snapshot JSON
			);
			CREATE TABLE workflow_run_node (
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL
			);
		`);
		const v1 = JSON.stringify({
			schema_version: 1,
			resolved: {
				nodes: [{ id: "implement", dispatch: { model: "legacy" } }],
			},
		});
		const v2Pinned = JSON.stringify({
			schema_version: 2,
			resolved: {
				nodes: [
					{
						id: "implement",
						dispatch: { model: "current" },
						agent: { content: "pinned", digest: "digest" },
					},
				],
			},
		});
		const v2Missing = JSON.stringify({
			schema_version: 2,
			resolved: {
				nodes: [{ id: "qa", dispatch: { model: "legacy" } }],
			},
		});
		const insert = db.prepare(
			"INSERT INTO workflow_run VALUES (?, ?, ?, ?, ?)",
		);
		insert.run("legacy-active", "active", "design", 0, null);
		insert.run("legacy-done", "completed", "design", 0, null);
		insert.run("v1-engine", "active", "implement", 1, v1);
		insert.run("v2-pinned", "active", "implement", 1, v2Pinned);
		insert.run("v2-missing", "active", "qa", 1, v2Missing);
		insert.run("v2-non-engine", "active", "qa", 0, v2Missing);
		db.prepare("INSERT INTO workflow_run_node VALUES (?, ?)").run(
			"legacy-active",
			"design",
		);

		expect(run(dbPath)).toEqual({
			legacyNodeRuns: 1,
			unpinnedAgentRuns: 2,
			removable: false,
		});

		db.prepare(
			"UPDATE workflow_run SET status = 'completed' WHERE run_id IN ('v1-engine','v2-missing')",
		).run();
		// Founder terminal-state carve-out: census (b)=0 retires only the
		// unpinned-agent fallback; legacy-node cleanup remains gated by (a).
		expect(run(dbPath)).toEqual({
			legacyNodeRuns: 1,
			unpinnedAgentRuns: 0,
			removable: false,
		});

		db.prepare(
			"UPDATE workflow_run SET status = 'completed' WHERE run_id = 'legacy-active'",
		).run();
		expect(run(dbPath)).toEqual({
			legacyNodeRuns: 0,
			unpinnedAgentRuns: 0,
			removable: true,
		});
		db.close();
	});
});
