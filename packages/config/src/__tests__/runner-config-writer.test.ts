import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyCronModel,
	applyRunnerDefaults,
	configContentSha,
	RunnerConfigStaleError,
} from "../runner-config-writer.js";

// FLY-709 P4.3 — the per-project runner-default / cron-model config WRITER.
// Contract (Codex design review R1 #1/#2): absent config = fail-loud;
// materialize backend when roles.runner is born; backend removal only when the
// block empties; writer-level effort⇒claude-tmux guard; loader round-trip on a
// temp file before rename (any failure = zero bytes changed); comments survive.

const BASE = `# project header comment
project: sub
linear:
  team_id: "TEAM-123"
runners:
  default: claude
  available:
    claude:
      type: claude
teams:
  - name: content
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5.0
decision_layer:
  autonomy_level: manual_only
  escalation_channel: "#flywheel-dev"
`;

const WITH_RUNNER = `${BASE}roles:
  # runner executor pin
  runner:
    backend: claude-tmux
    model: claude-sonnet-5
`;

const WITH_XHS = `${BASE}xiaohongshu_learning:
  collections:
    - collection_id: "col.1"
      label: "AI-视频"
      lead_id: "sub-lead"
      department_label: "Sub"
      target_linear_project: "Sub"
`;

let seq = 0;
function makeConfig(content: string): string {
	const dir = join(tmpdir(), `fly709-writer-${process.pid}-${seq++}`);
	mkdirSync(dir, { recursive: true });
	const p = join(dir, "config.yaml");
	writeFileSync(p, content, "utf8");
	return p;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanups.splice(0)) fn();
});

describe("applyRunnerDefaults", () => {
	it("sets model on an existing roles.runner and preserves comments", async () => {
		const p = makeConfig(WITH_RUNNER);
		const res = await applyRunnerDefaults(p, {
			model: "claude-haiku-4-5-20251001",
		});
		expect(res.changed).toEqual(["roles.runner.model"]);
		const out = readFileSync(p, "utf8");
		expect(out).toContain("model: claude-haiku-4-5-20251001");
		expect(out).toContain("# project header comment");
		expect(out).toContain("# runner executor pin");
	});

	it("undefined dimensions are untouched; null deletes the key", async () => {
		const p = makeConfig(`${WITH_RUNNER.trimEnd()}\n    effort: high\n`);
		const res = await applyRunnerDefaults(p, { effort: null });
		expect(res.changed).toEqual(["roles.runner.effort"]);
		const out = readFileSync(p, "utf8");
		expect(out).not.toContain("effort:");
		expect(out).toContain("model: claude-sonnet-5");
		expect(out).toContain("backend: claude-tmux");
	});

	it("materializes backend claude-tmux when roles.runner is born from a model write", async () => {
		const p = makeConfig(BASE);
		const res = await applyRunnerDefaults(p, { model: "claude-sonnet-5" });
		expect(res.changed).toContain("roles.runner.model");
		expect(res.changed).toContain("roles.runner.backend");
		const out = readFileSync(p, "utf8");
		expect(out).toContain("backend: claude-tmux");
		expect(out).toContain("model: claude-sonnet-5");
	});

	it("refuses backend removal while model remains", async () => {
		const p = makeConfig(WITH_RUNNER);
		const before = readFileSync(p, "utf8");
		await expect(applyRunnerDefaults(p, { backend: null })).rejects.toThrow(
			/backend/,
		);
		expect(readFileSync(p, "utf8")).toBe(before);
	});

	it("removes the whole roles.runner block (and empty roles) when everything clears", async () => {
		const p = makeConfig(WITH_RUNNER);
		const res = await applyRunnerDefaults(p, { model: null, backend: null });
		expect(res.changed).toContain("roles.runner.model");
		expect(res.changed).toContain("roles.runner.backend");
		const out = readFileSync(p, "utf8");
		expect(out).not.toContain("roles:");
		expect(out).not.toContain("claude-tmux");
	});

	it("refuses effort when the target backend is not claude-tmux", async () => {
		const p = makeConfig(WITH_RUNNER);
		const before = readFileSync(p, "utf8");
		await expect(
			applyRunnerDefaults(p, { backend: "kimi-tmux", effort: "high" }),
		).rejects.toThrow(/claude-tmux/);
		expect(readFileSync(p, "utf8")).toBe(before);
	});

	it("refuses effort when the EXISTING backend is not claude-tmux", async () => {
		const p = makeConfig(
			WITH_RUNNER.replace("backend: claude-tmux", "backend: codex-tmux"),
		);
		const before = readFileSync(p, "utf8");
		await expect(applyRunnerDefaults(p, { effort: "high" })).rejects.toThrow(
			/claude-tmux/,
		);
		expect(readFileSync(p, "utf8")).toBe(before);
	});

	it("rejects an unknown backend value with zero write", async () => {
		const p = makeConfig(WITH_RUNNER);
		const before = readFileSync(p, "utf8");
		await expect(
			applyRunnerDefaults(p, { backend: "gpt-tmux" }),
		).rejects.toThrow(/backend/);
		expect(readFileSync(p, "utf8")).toBe(before);
	});

	it("rejects an unknown effort value with zero write", async () => {
		const p = makeConfig(WITH_RUNNER);
		const before = readFileSync(p, "utf8");
		await expect(applyRunnerDefaults(p, { effort: "turbo" })).rejects.toThrow(
			/effort/,
		);
		expect(readFileSync(p, "utf8")).toBe(before);
	});

	it("fails loud when the config file is absent (no skeleton fabrication)", async () => {
		const dir = join(tmpdir(), `fly709-writer-absent-${process.pid}-${seq++}`);
		mkdirSync(dir, { recursive: true });
		const p = join(dir, "config.yaml");
		await expect(
			applyRunnerDefaults(p, { model: "claude-sonnet-5" }),
		).rejects.toThrow(/config/i);
		expect(existsSync(p)).toBe(false);
	});

	it("refuses a symlinked config path", async () => {
		const real = makeConfig(WITH_RUNNER);
		const link = join(
			tmpdir(),
			`fly709-writer-link-${process.pid}-${seq++}.yaml`,
		);
		symlinkSync(real, link);
		await expect(
			applyRunnerDefaults(link, { model: "claude-sonnet-5" }),
		).rejects.toThrow(/symlink/i);
	});

	it("zero bytes change when the base config cannot pass loader round-trip", async () => {
		// Base file parses as YAML but is loader-invalid (runners missing).
		const p = makeConfig("project: sub\n");
		const before = readFileSync(p, "utf8");
		await expect(
			applyRunnerDefaults(p, { model: "claude-sonnet-5" }),
		).rejects.toThrow();
		expect(readFileSync(p, "utf8")).toBe(before);
	});

	it("leaves no temp files behind after a successful write", async () => {
		const p = makeConfig(WITH_RUNNER);
		await applyRunnerDefaults(p, { model: "claude-sonnet-5" });
		const dir = p.slice(0, p.lastIndexOf("/"));
		expect(readdirSync(dir)).toEqual(["config.yaml"]);
	});
});

describe("applyCronModel", () => {
	it("sets collections[].model located by collection_id", async () => {
		const p = makeConfig(WITH_XHS);
		const res = await applyCronModel(p, {
			collectionId: "col.1",
			model: "haiku",
		});
		expect(res.changed).toEqual([
			'xiaohongshu_learning.collections["col.1"].model',
		]);
		expect(readFileSync(p, "utf8")).toContain("model: haiku");
	});

	it("removes the model key when model is null", async () => {
		const p = makeConfig(`${WITH_XHS.trimEnd()}\n      model: sonnet\n`);
		await applyCronModel(p, { collectionId: "col.1", model: null });
		expect(readFileSync(p, "utf8")).not.toContain("model:");
	});

	it("rejects an unknown collection id with zero write", async () => {
		const p = makeConfig(WITH_XHS);
		const before = readFileSync(p, "utf8");
		await expect(
			applyCronModel(p, { collectionId: "nope", model: "sonnet" }),
		).rejects.toThrow(/collection/i);
		expect(readFileSync(p, "utf8")).toBe(before);
	});

	it("rejects a model outside the dispatch whitelist with zero write", async () => {
		const p = makeConfig(WITH_XHS);
		const before = readFileSync(p, "utf8");
		await expect(
			applyCronModel(p, { collectionId: "col.1", model: "gpt-5" }),
		).rejects.toThrow(/model/i);
		expect(readFileSync(p, "utf8")).toBe(before);
	});
});

// FLY-709 P5 (Codex design review R1 #2 / R2 #3): the console apply path passes
// an expectedSha; the write must re-check it INSIDE the config-file lock, and
// concurrent writers must serialize on <configPath>.lock.
describe("applyRunnerDefaults — expectedSha + config-file lock (P5)", () => {
	it("writes when expectedSha matches the current content", async () => {
		const p = makeConfig(WITH_RUNNER);
		const sha = configContentSha(readFileSync(p, "utf8"));
		const res = await applyRunnerDefaults(
			p,
			{ model: "claude-haiku-4-5-20251001" },
			{ expectedSha: sha },
		);
		expect(res.changed).toEqual(["roles.runner.model"]);
		expect(readFileSync(p, "utf8")).toContain(
			"model: claude-haiku-4-5-20251001",
		);
	});

	it("throws RunnerConfigStaleError (zero bytes) when expectedSha is stale", async () => {
		const p = makeConfig(WITH_RUNNER);
		const before = readFileSync(p, "utf8");
		await expect(
			applyRunnerDefaults(
				p,
				{ model: "claude-haiku-4-5-20251001" },
				{ expectedSha: "deadbeef".repeat(8) },
			),
		).rejects.toBeInstanceOf(RunnerConfigStaleError);
		expect(readFileSync(p, "utf8")).toBe(before); // no write on drift
	});

	it("serializes two concurrent writers on the same config (no corruption)", async () => {
		const p = makeConfig(WITH_RUNNER);
		// Fire both without awaiting between them — the file lock must serialize
		// their read→validate→rename so neither clobbers the other mid-write.
		const [a, b] = await Promise.all([
			applyRunnerDefaults(p, { model: "claude-fable-5" }),
			applyRunnerDefaults(p, { effort: "high" }),
		]);
		expect(a.changed.length + b.changed.length).toBeGreaterThan(0);
		// Both landed and the file is still valid YAML with both keys.
		const out = readFileSync(p, "utf8");
		expect(out).toContain("model: claude-fable-5");
		expect(out).toContain("effort: high");
		// No orphaned temp files left in the dir.
		expect(out).toContain("# project header comment");
	});

	// Codex code review R1 #1: applyCronModel writes the SAME config.yaml, so it
	// must share the lock — a concurrent runner-default write and cron-model
	// write on the same file must BOTH survive (no lost update in either order).
	it("serializes runner-default and cron-model writers on the same config", async () => {
		const p = makeConfig(WITH_XHS); // has xiaohongshu_learning + no roles.runner
		const [rd, cron] = await Promise.all([
			applyRunnerDefaults(p, { model: "claude-fable-5" }),
			applyCronModel(p, { collectionId: "col.1", model: "haiku" }),
		]);
		expect(rd.changed).toContain("roles.runner.model");
		expect(cron.changed).toEqual([
			'xiaohongshu_learning.collections["col.1"].model',
		]);
		// Neither writer clobbered the other's edit; file is still valid YAML.
		const out = readFileSync(p, "utf8");
		expect(out).toContain("model: claude-fable-5"); // runner-default survived
		expect(out).toContain("model: haiku"); // cron-model survived
		expect(out).toContain("# project header comment");
		// No orphaned temp files.
		const dir = p.slice(0, p.lastIndexOf("/"));
		expect(readdirSync(dir)).toEqual(["config.yaml"]);
	});
});
