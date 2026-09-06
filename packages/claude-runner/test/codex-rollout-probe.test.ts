import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitCodexAgentHome } from "../src/codex-home.js";
import { probeCodexRolloutMtime } from "../src/codex-rollout-probe.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "fly2211-rollout-"));
	roots.push(root);
	const sessionRoot = join(root, "state");
	const homesRoot = join(root, "homes");
	const env = {
		FLYWHEEL_CODEX_SESSION_DIR: sessionRoot,
		FLYWHEEL_CODEX_HOMES_ROOT: homesRoot,
	};
	return { root, sessionRoot, homesRoot, env };
}

describe("probeCodexRolloutMtime", () => {
	it("finds a rollout in the execution's keyed agent home", async () => {
		const f = fixture();
		const admission = await admitCodexAgentHome(
			{
				project: "flywheel",
				role: "implement",
				executionId: "exec-keyed",
				requestedAssemblyArm: "bare",
			},
			f.env,
		);
		mkdirSync(join(f.sessionRoot, "exec-keyed"), { recursive: true });
		writeFileSync(
			join(f.sessionRoot, "exec-keyed", "session.json"),
			JSON.stringify({
				threadId: "thread-keyed",
				codexAgentHome: {
					home: admission.handle.home,
					project: "flywheel",
					role: "implement",
				},
			}),
		);
		const rollout = join(
			admission.handle.home,
			"sessions",
			"rollout-thread-keyed.jsonl",
		);
		mkdirSync(join(admission.handle.home, "sessions"));
		writeFileSync(rollout, "keyed");
		utimesSync(rollout, new Date(3_000), new Date(3_000));

		expect(probeCodexRolloutMtime("exec-keyed", f.env)).toEqual({
			kind: "found",
			mtimeMs: 3_000,
		});
	});

	it("fails closed when the persisted keyed-home record is invalid", () => {
		const f = fixture();
		mkdirSync(join(f.sessionRoot, "exec-invalid"), { recursive: true });
		writeFileSync(
			join(f.sessionRoot, "exec-invalid", "session.json"),
			JSON.stringify({
				threadId: "thread-invalid",
				codexAgentHome: { home: "/tmp/wrong", project: "flywheel", role: "qa" },
			}),
		);
		expect(probeCodexRolloutMtime("exec-invalid", f.env)).toEqual({
			kind: "unknown",
		});
	});

	it("finds the newest rollout for the execution's persisted thread", () => {
		const f = fixture();
		mkdirSync(join(f.sessionRoot, "exec-1"), { recursive: true });
		writeFileSync(
			join(f.sessionRoot, "exec-1", "session.json"),
			JSON.stringify({ threadId: "thread-abc" }),
		);
		const day = join(f.homesRoot, "exec-1", "sessions", "2026", "08", "31");
		mkdirSync(day, { recursive: true });
		const older = join(day, "rollout-thread-abc-old.jsonl");
		const newer = join(day, "rollout-thread-abc-new.jsonl");
		writeFileSync(older, "old");
		writeFileSync(newer, "new");
		utimesSync(older, new Date(1_000), new Date(1_000));
		utimesSync(newer, new Date(2_000), new Date(2_000));

		expect(probeCodexRolloutMtime("exec-1", f.env)).toEqual({
			kind: "found",
			mtimeMs: 2_000,
		});
	});

	it("distinguishes absent state from malformed state", () => {
		const f = fixture();
		expect(probeCodexRolloutMtime("missing", f.env)).toEqual({
			kind: "absent",
		});
		mkdirSync(join(f.sessionRoot, "bad"), { recursive: true });
		writeFileSync(join(f.sessionRoot, "bad", "session.json"), "not-json");
		expect(probeCodexRolloutMtime("bad", f.env)).toEqual({ kind: "unknown" });
	});
});
