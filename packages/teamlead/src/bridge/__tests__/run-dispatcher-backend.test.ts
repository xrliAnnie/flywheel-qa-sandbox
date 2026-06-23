/**
 * FLY-123: dispatcher → BlueprintContext backend resolution on the real
 * RunDispatcher.start() path (plan §6 — label override row). Stub Blueprint
 * captures the ctx the dispatcher builds.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlueprintContext } from "flywheel-edge-worker/dist/Blueprint.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProjectRuntime, RunDispatcher } from "../run-dispatcher.js";
import { RunnerAdmissionController } from "../runner-admission.js";

describe("RunDispatcher backend resolution (FLY-123)", () => {
	let tmpDir: string;
	let captured: BlueprintContext | undefined;
	let dispatcher: RunDispatcher;

	const origRunnerBackend = process.env.FLYWHEEL_RUNNER_BACKEND;
	const origCommBackend = process.env.FLYWHEEL_COMM_BACKEND;
	// FLY-493: the per-project CommDB is isolated to a fresh temp dir by the
	// package vitest.setup.ts (FLYWHEEL_COMM_DIR), so preRegisterCommDb (start())
	// never writes to the LIVE Bridge comm.db.

	function makeRuntime(
		rolesConfig?: ProjectRuntime["rolesConfig"],
	): ProjectRuntime {
		return {
			blueprint: {
				run: vi.fn(
					async (_node: unknown, _root: string, ctx: BlueprintContext) => {
						captured = ctx;
						return { success: true, sessionId: "s" };
					},
				),
			} as unknown as ProjectRuntime["blueprint"],
			projectRoot: tmpDir,
			tmuxSessionName: "runner-test",
			agentDispatcher: {
				dispatchByName: vi.fn(),
			} as unknown as ProjectRuntime["agentDispatcher"],
			...(rolesConfig && { rolesConfig }),
		};
	}

	function makeDispatcher(
		rolesConfig?: ProjectRuntime["rolesConfig"],
	): RunDispatcher {
		const runtimes = new Map<string, ProjectRuntime>([
			["proj", makeRuntime(rolesConfig)],
		]);
		return new RunDispatcher(
			runtimes,
			[],
			RunnerAdmissionController.alwaysAdmit(),
		);
	}

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly123-dispatcher-"));
		captured = undefined;
		delete process.env.FLYWHEEL_RUNNER_BACKEND;
		delete process.env.FLYWHEEL_COMM_BACKEND;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		if (origRunnerBackend === undefined)
			delete process.env.FLYWHEEL_RUNNER_BACKEND;
		else process.env.FLYWHEEL_RUNNER_BACKEND = origRunnerBackend;
		if (origCommBackend === undefined) delete process.env.FLYWHEEL_COMM_BACKEND;
		else process.env.FLYWHEEL_COMM_BACKEND = origCommBackend;
		vi.restoreAllMocks();
	});

	async function startAndWait(
		d: RunDispatcher,
		labels?: string[],
	): Promise<BlueprintContext> {
		await d.start({
			issueId: "FLY-123",
			projectName: "proj",
			leadId: "product-lead",
			...(labels && { issueLabels: labels }),
		} as Parameters<RunDispatcher["start"]>[0]);
		await d.drain();
		expect(captured).toBeTruthy();
		return captured as BlueprintContext;
	}

	it("reverse-compat: no labels/config/env → claude-tmux + claude-code vendor", async () => {
		dispatcher = makeDispatcher();
		const ctx = await startAndWait(dispatcher);
		expect(ctx.runnerBackend).toBe("claude-tmux");
		expect(ctx.vendor).toBe("claude-code");
		expect(ctx.runnerModel).toBeUndefined();
		// FLY-142 identity fields still present (mailbox default)
		expect(ctx.runnerAgentName).toMatch(/^runner-/);
		expect(ctx.agentTeamName).toBe("product-lead");
	});

	it("[codex] label on the real start() path → codex-tmux + codex vendor", async () => {
		dispatcher = makeDispatcher();
		const ctx = await startAndWait(dispatcher, ["codex"]);
		expect(ctx.runnerBackend).toBe("codex-tmux");
		expect(ctx.vendor).toBe("codex");
	});

	it("project roles config layer applies without labels", async () => {
		dispatcher = makeDispatcher({
			runner: { backend: "codex-tmux", model: "gpt-5.5-codex" },
		});
		const ctx = await startAndWait(dispatcher);
		expect(ctx.runnerBackend).toBe("codex-tmux");
		expect(ctx.runnerModel).toBe("gpt-5.5-codex");
	});

	// FLY-241: per-project Runner model override on the DEFAULT claude backend.
	// A coding-heavy project (GeoForge3D / JoyCon) keeps claude-tmux but pins a
	// stronger/cheaper model (claude-fable-5) via `.flywheel/config.yaml`:
	//   roles: { runner: { backend: claude-tmux, model: claude-fable-5 } }
	// This proves the EXACT deploy shape threads model → ctx.runnerModel WITHOUT
	// flipping the vendor to codex. Downstream links are pre-covered:
	//   ctx.runnerModel → adapter.execute({model})  : Blueprint.ts:961
	//   adapter model   → `--model` CLI arg         : TmuxAdapter.test.ts ("passes --model when specified")
	it("[FLY-241] claude-tmux project roles model override → runnerModel, vendor stays claude-code", async () => {
		dispatcher = makeDispatcher({
			runner: { backend: "claude-tmux", model: "claude-fable-5" },
		});
		const ctx = await startAndWait(dispatcher);
		expect(ctx.runnerBackend).toBe("claude-tmux");
		expect(ctx.runnerModel).toBe("claude-fable-5");
		expect(ctx.vendor).toBe("claude-code");
	});

	it("claude label pins back over codex project config", async () => {
		dispatcher = makeDispatcher({ runner: { backend: "codex-tmux" } });
		const ctx = await startAndWait(dispatcher, ["claude"]);
		expect(ctx.runnerBackend).toBe("claude-tmux");
		expect(ctx.vendor).toBe("claude-code");
	});

	it("FLYWHEEL_RUNNER_BACKEND env layer applies under config-less project", async () => {
		process.env.FLYWHEEL_RUNNER_BACKEND = "codex-tmux";
		dispatcher = makeDispatcher();
		const ctx = await startAndWait(dispatcher);
		expect(ctx.runnerBackend).toBe("codex-tmux");
		expect(ctx.vendor).toBe("codex");
	});

	it("rollback path (FLYWHEEL_COMM_BACKEND=commdb): backend fields set, identity absent", async () => {
		process.env.FLYWHEEL_COMM_BACKEND = "commdb";
		dispatcher = makeDispatcher();
		const ctx = await startAndWait(dispatcher, ["codex"]);
		expect(ctx.runnerBackend).toBe("codex-tmux");
		expect(ctx.runnerAgentName).toBeUndefined();
		expect(ctx.vendor).toBeUndefined();
	});

	// FLY-493: antigravity is a no-transport backend. Even on the mailbox
	// default path WITH a leadId, the dispatcher must NOT wire Agent Team
	// identity / vendor for it (Codex R1 #3 explicit test) — instead it sets the
	// explicit no-transport marker `runnerTransportMode: "none"`.
	it("[antigravity] label → antigravity-tmux, transportMode none, NO transport identity (mailbox+leadId)", async () => {
		// mailbox is the default (no FLYWHEEL_COMM_BACKEND set), leadId present.
		dispatcher = makeDispatcher();
		const ctx = await startAndWait(dispatcher, ["antigravity"]);
		expect(ctx.runnerBackend).toBe("antigravity-tmux");
		expect(ctx.runnerTransportMode).toBe("none");
		// No transport wiring despite mailbox + leadId:
		expect(ctx.vendor).toBeUndefined();
		expect(ctx.runnerAgentName).toBeUndefined();
		expect(ctx.agentTeamName).toBeUndefined();
	});

	it("[antigravity] agy label alias also resolves the no-transport backend", async () => {
		dispatcher = makeDispatcher();
		const ctx = await startAndWait(dispatcher, ["agy"]);
		expect(ctx.runnerBackend).toBe("antigravity-tmux");
		expect(ctx.runnerTransportMode).toBe("none");
	});

	// FLY-494: kimi is also a no-transport backend — same dispatcher contract.
	it("[kimi] label → kimi-tmux, transportMode none, NO transport identity (mailbox+leadId)", async () => {
		dispatcher = makeDispatcher();
		const ctx = await startAndWait(dispatcher, ["kimi"]);
		expect(ctx.runnerBackend).toBe("kimi-tmux");
		expect(ctx.runnerTransportMode).toBe("none");
		// No transport wiring despite mailbox + leadId:
		expect(ctx.vendor).toBeUndefined();
		expect(ctx.runnerAgentName).toBeUndefined();
		expect(ctx.agentTeamName).toBeUndefined();
	});

	it("[kimi] kimi-code label alias also resolves the no-transport backend", async () => {
		dispatcher = makeDispatcher();
		const ctx = await startAndWait(dispatcher, ["kimi-code"]);
		expect(ctx.runnerBackend).toBe("kimi-tmux");
		expect(ctx.runnerTransportMode).toBe("none");
	});
});
