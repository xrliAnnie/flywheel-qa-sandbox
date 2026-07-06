import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerConfigStaleError } from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfirmTokenStore } from "../bridge/fleet-admin.js";
import { FleetAdminAudit } from "../bridge/fleet-admin-audit.js";
import {
	handleRunnerApply,
	handleRunnerStage,
	type RunnerCanonical,
	type RunnerRouteDeps,
} from "../bridge/runner-routes.js";
import type { ProjectEntry } from "../ProjectConfig.js";

const ORIGIN = "http://127.0.0.1:9931";
const CONFIG = "project: flywheel\nlinear:\n  team_id: FLY\n";

function projects(...names: string[]): ProjectEntry[] {
	return names.map((projectName, i) => ({
		projectName,
		projectRoot: `/tmp/proj-${projectName}-${i}`,
		leads: [],
	}));
}

/** An audit whose record() returns a fixed value (fail-closed testing). */
function fakeAudit(ok: boolean): FleetAdminAudit {
	return { record: () => ok } as unknown as FleetAdminAudit;
}

describe("FLY-709 P5 — runner-default stage/apply routes", () => {
	let dir: string;
	let realAudit: FleetAdminAudit;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "runner-routes-"));
		realAudit = new FleetAdminAudit(join(dir, "audit.db"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function baseDeps(over: Partial<RunnerRouteDeps> = {}): RunnerRouteDeps {
		return {
			liveProjects: () => projects("flywheel"),
			readFile: () => CONFIG,
			tokens: new ConfirmTokenStore(),
			audit: realAudit,
			apply: async () => ({ changed: ["roles.runner.model"] }),
			...over,
		};
	}

	// ── stage ──────────────────────────────────────────────────────────
	it("stage: happy path issues a confirmToken bound to the canonical", () => {
		const deps = baseDeps();
		const r = handleRunnerStage(
			deps,
			{ project: "flywheel", change: { model: "claude-fable-5" } },
			ORIGIN,
		);
		expect(r.code).toBe(200);
		const body = r.body as { canonical: RunnerCanonical; confirmToken: string };
		expect(body.confirmToken).toBeTruthy();
		expect(body.canonical.project).toBe("flywheel");
		expect(body.canonical.change).toEqual({ model: "claude-fable-5" });
		expect(body.canonical.fileSha).toMatch(/^[0-9a-f]{64}$/);
	});

	it("stage: non-string project → 400", () => {
		const r = handleRunnerStage(baseDeps(), { change: { model: "x" } }, ORIGIN);
		expect(r.code).toBe(400);
	});

	it("stage: unknown project → 400", () => {
		const r = handleRunnerStage(
			baseDeps(),
			{ project: "nope", change: { model: "x" } },
			ORIGIN,
		);
		expect(r.code).toBe(400);
		expect((r.body as { error: string }).error).toMatch(/unknown project/);
	});

	it("stage: ambiguous (duplicate) project → 400", () => {
		const deps = baseDeps({ liveProjects: () => projects("dup", "dup") });
		const r = handleRunnerStage(
			deps,
			{ project: "dup", change: { model: "x" } },
			ORIGIN,
		);
		expect(r.code).toBe(400);
		expect((r.body as { error: string }).error).toMatch(/ambiguous/);
	});

	it("stage: unknown change dimension → 400", () => {
		const r = handleRunnerStage(
			baseDeps(),
			{ project: "flywheel", change: { bogus: "x" } },
			ORIGIN,
		);
		expect(r.code).toBe(400);
	});

	it("stage: unknown backend / effort → 400", () => {
		expect(
			handleRunnerStage(
				baseDeps(),
				{ project: "flywheel", change: { backend: "not-a-backend" } },
				ORIGIN,
			).code,
		).toBe(400);
		expect(
			handleRunnerStage(
				baseDeps(),
				{ project: "flywheel", change: { effort: "turbo" } },
				ORIGIN,
			).code,
		).toBe(400);
	});

	it("stage: empty change → 400", () => {
		const r = handleRunnerStage(
			baseDeps(),
			{ project: "flywheel", change: {} },
			ORIGIN,
		);
		expect(r.code).toBe(400);
	});

	it("stage: unreadable config.yaml → 400 (no token)", () => {
		const deps = baseDeps({
			readFile: () => {
				throw new Error("ENOENT");
			},
		});
		const r = handleRunnerStage(
			deps,
			{ project: "flywheel", change: { model: "x" } },
			ORIGIN,
		);
		expect(r.code).toBe(400);
	});

	it("stage: FAIL-CLOSED — audit unavailable → 503, no token", () => {
		const deps = baseDeps({ audit: fakeAudit(false) });
		const r = handleRunnerStage(
			deps,
			{ project: "flywheel", change: { model: "x" } },
			ORIGIN,
		);
		expect(r.code).toBe(503);
		expect(r.body).not.toHaveProperty("confirmToken");
	});

	// ── apply ──────────────────────────────────────────────────────────
	async function stageThenCanonical(
		deps: RunnerRouteDeps,
	): Promise<{ canonical: RunnerCanonical; confirmToken: string }> {
		const staged = handleRunnerStage(
			deps,
			{ project: "flywheel", change: { model: "claude-fable-5" } },
			ORIGIN,
		);
		return staged.body as { canonical: RunnerCanonical; confirmToken: string };
	}

	it("apply: happy path applies + returns changed", async () => {
		const deps = baseDeps();
		const { canonical, confirmToken } = await stageThenCanonical(deps);
		const r = await handleRunnerApply(deps, canonical, confirmToken, ORIGIN);
		expect(r.code).toBe(200);
		expect((r.body as { changed: string[] }).changed).toEqual([
			"roles.runner.model",
		]);
	});

	it("apply: bad/expired confirmToken → 401", async () => {
		const deps = baseDeps();
		const { canonical } = await stageThenCanonical(deps);
		const r = await handleRunnerApply(deps, canonical, "not-a-token", ORIGIN);
		expect(r.code).toBe(401);
	});

	it("apply: token is single-use (replay → 401)", async () => {
		const deps = baseDeps();
		const { canonical, confirmToken } = await stageThenCanonical(deps);
		await handleRunnerApply(deps, canonical, confirmToken, ORIGIN);
		const replay = await handleRunnerApply(
			deps,
			canonical,
			confirmToken,
			ORIGIN,
		);
		expect(replay.code).toBe(401);
	});

	it("apply: FAIL-CLOSED — pre-write audit unavailable → 503, no write", async () => {
		// stage with a working audit to get a valid token, then apply with a
		// broken audit — the apply must refuse (503) and never call the writer.
		const tokens = new ConfirmTokenStore();
		const staged = handleRunnerStage(
			baseDeps({ tokens }),
			{ project: "flywheel", change: { model: "claude-fable-5" } },
			ORIGIN,
		);
		const { canonical, confirmToken } = staged.body as {
			canonical: RunnerCanonical;
			confirmToken: string;
		};
		let wrote = false;
		const deps = baseDeps({
			tokens,
			audit: fakeAudit(false),
			apply: async () => {
				wrote = true;
				return { changed: [] };
			},
		});
		const r = await handleRunnerApply(deps, canonical, confirmToken, ORIGIN);
		expect(r.code).toBe(503);
		expect(wrote).toBe(false);
	});

	it("apply: RunnerConfigStaleError → 409 (config drift)", async () => {
		const deps = baseDeps({
			apply: async () => {
				throw new RunnerConfigStaleError("/tmp/x/.flywheel/config.yaml");
			},
		});
		const { canonical, confirmToken } = await stageThenCanonical(deps);
		const r = await handleRunnerApply(deps, canonical, confirmToken, ORIGIN);
		expect(r.code).toBe(409);
	});

	it("apply: other writer error → 500", async () => {
		const deps = baseDeps({
			apply: async () => {
				throw new Error("disk full");
			},
		});
		const { canonical, confirmToken } = await stageThenCanonical(deps);
		const r = await handleRunnerApply(deps, canonical, confirmToken, ORIGIN);
		expect(r.code).toBe(500);
	});

	it("apply: passes the reviewed fileSha as expectedSha to the writer", async () => {
		let seenExpected: string | undefined;
		const deps = baseDeps({
			apply: async (_path, _change, opts) => {
				seenExpected = opts.expectedSha;
				return { changed: ["roles.runner.model"] };
			},
		});
		const { canonical, confirmToken } = await stageThenCanonical(deps);
		await handleRunnerApply(deps, canonical, confirmToken, ORIGIN);
		expect(seenExpected).toBe(canonical.fileSha);
	});
});
