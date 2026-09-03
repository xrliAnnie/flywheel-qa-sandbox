/**
 * FLY-1356 — QA-authored coverage (DAG workflow QA phase, independent of the
 * implement phase's own tests).
 *
 * Two gaps the implement-phase suite left open, both named by plan §验收标准 4:
 *
 *  A) KILL WITH A STALE SUCCESSOR OVERRIDE, at the Blueprint layer.
 *     `skill-framework-mode.test.ts` pins the R1#1 total-function semantics at
 *     the RESOLVER layer, and `Blueprint.fly1356-skill-framework.test.ts` has a
 *     "forced superpowers (kill position)" case — but never with an override
 *     actually present on the context. That combination is exactly the
 *     production kill scenario (operator sets the flag back to `superpowers`
 *     while a 529 pipeline is in flight carrying `skillFrameworkMode=matt`),
 *     so it deserves an integration-level assertion: the run must spawn as A,
 *     contribute zero plugin fields, and never throw.
 *
 *  B) CHARACTERIZATION of the sticky-stamp × fallback interaction (QA finding
 *     QA-1). A matt-bucket issue whose readiness probe fails once is recorded
 *     as `superpowers`; the R1#4 sticky lookup (`getSkillFrameworkStamp`, which
 *     filters on nothing but NOT NULL) then replays that value FOREVER — the
 *     issue can never enter the B arm again even after the plugin is installed,
 *     and later rows carry via=`sticky`, which reads like a legitimate A-arm
 *     assignment rather than a degraded one. These tests DOCUMENT the current
 *     behavior so a future intentional change is a visible diff, not a silent
 *     one. See the QA report for the eval-integrity discussion.
 */

import { hashModeBucket, SKILL_FRAMEWORK_MODE_ENV } from "flywheel-config";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { DagNode } from "../dag-node.js";
import type { EventEnvelope } from "../ExecutionEventEmitter.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";

/**
 * Find a B-arm fixture using the current split cardinality. A fixed identifier
 * is brittle: FLY-1299 selected matt under %3 but moved to bare under %4.
 */
function findMattBucketId(): string {
	for (let sequence = 1; sequence <= 10_000; sequence += 1) {
		const candidate = `FLY-QA-MATT-${sequence}`;
		if (hashModeBucket(candidate) === "matt") return candidate;
	}
	throw new Error("unable to derive a matt-bucket fixture");
}

const MATT_BUCKET_ID = findMattBucketId();

function makeMockGitChecker() {
	return {
		assertCleanTree: vi.fn(async () => {}),
		captureBaseline: vi.fn(async () => "abc123"),
		check: vi.fn(async () => ({
			hasNewCommits: true,
			commitCount: 1,
			filesChanged: 1,
			commitMessages: ["feat: x"],
		})),
	} as unknown as GitResultChecker;
}

function makeMockAdapter(): IAdapter {
	return {
		type: "mock",
		supportsStreaming: false,
		checkEnvironment: async () => ({ healthy: true, message: "mock" }),
		execute: vi.fn(
			async (
				_ctx: AdapterExecutionContext,
			): Promise<AdapterExecutionResult> => ({
				success: true,
				sessionId: "sess-uuid",
				tmuxWindow: "flywheel:@1",
				durationMs: 1,
			}),
		),
	};
}

interface RunOpts {
	envValue?: string;
	issueIdentifier?: string;
	ctxExtra?: Partial<BlueprintContext>;
	readiness?: (backend: string) => boolean;
}

async function runBlueprint(opts: RunOpts = {}): Promise<{
	envelope: EventEnvelope;
	execArgs: AdapterExecutionContext;
}> {
	if (opts.envValue === undefined) {
		delete process.env[SKILL_FRAMEWORK_MODE_ENV];
	} else {
		process.env[SKILL_FRAMEWORK_MODE_ENV] = opts.envValue;
	}
	const adapter = makeMockAdapter();
	const envelopes: EventEnvelope[] = [];
	const id = opts.issueIdentifier ?? MATT_BUCKET_ID;
	const blueprint = new Blueprint(
		new PreHydrator(async (nodeId) => ({
			title: `Issue ${nodeId}`,
			description: "d",
			labels: [],
		})),
		makeMockGitChecker(),
		() => adapter,
		{
			execFile: vi.fn(async () => ({ stdout: "", exitCode: 0 })),
		} as ShellRunner,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			emitStarted: vi.fn(async (env: EventEnvelope) => {
				envelopes.push(env);
			}),
			emitHeartbeat: vi.fn(async () => {}),
			emitCompleted: vi.fn(async () => {}),
			emitFailed: vi.fn(async () => {}),
		} as unknown as ConstructorParameters<typeof Blueprint>[9],
		undefined, // agentDispatcher
		undefined, // checkpointConfig
		undefined, // flywheelRepoRoot
		undefined, // docFlowConfig
		undefined, // ponytailConfig
		undefined, // ponytailReadiness (default)
		undefined, // participation reader (absent ⇒ participate)
		opts.readiness ?? (() => true), // matt readiness
		undefined, // codexSkillAssemblyProbe
		() => ({
			hasOverride: opts.envValue !== undefined,
			raw: opts.envValue ?? null,
		}),
	);
	const node: DagNode = { id, blockedBy: [] };
	const ctx: BlueprintContext = {
		teamName: "eng",
		runnerName: "claude",
		projectName: "testproj",
		issueIdentifier: id,
		...opts.ctxExtra,
	};
	await blueprint.run(node, "/tmp/fly1356-qa-test", ctx);
	return {
		envelope: envelopes[0] as EventEnvelope,
		execArgs: (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext,
	};
}

afterEach(() => {
	delete process.env[SKILL_FRAMEWORK_MODE_ENV];
	vi.restoreAllMocks();
});

describe("FLY-1356 QA — kill-switch with a stale in-flight override (§验收标准 4)", () => {
	it("flag killed back to superpowers while a successor still carries override=matt → spawns as A, zero plugin effect, no throw", async () => {
		const { envelope, execArgs } = await runBlueprint({
			envValue: "superpowers",
			ctxExtra: { skillFrameworkModeOverride: "matt" },
			// A ready probe would let a mis-resolved matt through unnoticed; keep
			// it ready so the assertion below proves the RESOLVER ignored the
			// override, not that the probe rescued us.
			readiness: () => true,
		});
		expect(envelope.skillFrameworkMode).toBe("superpowers");
		expect(envelope.skillFrameworkModeVia).toBe("forced");
		expect("disabledPlugins" in execArgs).toBe(false);
		expect("enabledPluginsExtra" in execArgs).toBe(false);
	});

	it("kill also ignores a stale override that would have selected bare", async () => {
		const { envelope, execArgs } = await runBlueprint({
			envValue: "superpowers",
			ctxExtra: { skillFrameworkModeOverride: "bare" },
		});
		expect(envelope.skillFrameworkMode).toBe("superpowers");
		expect(envelope.skillFrameworkModeVia).toBe("forced");
		expect("disabledPlugins" in execArgs).toBe(false);
	});

	it("a stale override survives a kill to a DIFFERENT forced arm without leaking through", async () => {
		const { envelope, execArgs } = await runBlueprint({
			envValue: "bare",
			ctxExtra: { skillFrameworkModeOverride: "matt" },
		});
		expect(envelope.skillFrameworkMode).toBe("bare");
		expect(envelope.skillFrameworkModeVia).toBe("forced");
		// bare must NOT enable matt-skills — the ignored override must not bleed
		// into the plugin layer.
		expect(execArgs.enabledPluginsExtra ?? []).toEqual([]);
	});
});

describe("FLY-1356 QA — sticky × fallback characterization (finding QA-1)", () => {
	it("precondition: the fixture identifier really is a B-arm (matt) bucket", () => {
		const bucket = hashModeBucket(MATT_BUCKET_ID);
		expect(bucket).not.toBe("superpowers");
		expect(bucket).toBe("matt");
	});

	it("run 1 — matt bucket + failing readiness probe records superpowers/fallback_superpowers", async () => {
		const { envelope, execArgs } = await runBlueprint({
			envValue: "split",
			readiness: () => false,
		});
		expect(envelope.skillFrameworkMode).toBe("superpowers");
		expect(envelope.skillFrameworkModeVia).toBe("fallback_superpowers");
		// Red line #2 holds: a crippled B never runs.
		expect("disabledPlugins" in execArgs).toBe(false);
	});

	it("run 2 — that recorded A value is what getSkillFrameworkStamp replays, so the issue stays in A even once the probe is green (via reads as `sticky`, not `fallback_superpowers`)", async () => {
		// Exactly what StateStore.getSkillFrameworkStamp returns after run 1:
		// the persisted `skill_framework_mode` column, with no via filter.
		const { envelope } = await runBlueprint({
			envValue: "split",
			readiness: () => true, // operator has since run setup-matt-skills.sh
			ctxExtra: { skillFrameworkModePrior: "superpowers" },
		});
		// CURRENT BEHAVIOR (documented, not endorsed): the B-bucket issue is
		// permanently pinned to A, and the attribution row now says `sticky` —
		// indistinguishable from an issue legitimately assigned to A.
		expect(envelope.skillFrameworkMode).toBe("superpowers");
		expect(envelope.skillFrameworkModeVia).toBe("sticky");
	});

	it("same replay path pins a project_opt_out issue to A after the project opts back in", async () => {
		const { envelope } = await runBlueprint({
			envValue: "split",
			ctxExtra: { skillFrameworkModePrior: "superpowers" },
			// participation reader absent ⇒ the project participates again
		});
		expect(envelope.skillFrameworkMode).toBe("superpowers");
		expect(envelope.skillFrameworkModeVia).toBe("sticky");
	});

	it("control: without a prior stamp the same issue DOES take its matt bucket (proves the pin above comes from the stamp, not the fixture)", async () => {
		const { envelope } = await runBlueprint({
			envValue: "split",
			readiness: () => true,
		});
		expect(envelope.skillFrameworkMode).toBe("matt");
		expect(envelope.skillFrameworkModeVia).toBe("hash");
	});
});
