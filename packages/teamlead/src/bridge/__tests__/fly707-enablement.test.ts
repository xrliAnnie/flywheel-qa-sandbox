/**
 * FLY-707: regression guard for the auto-QA + doc_flow ENABLEMENT.
 *
 * The FLY-579 auto-QA pipeline and FLY-205 doc_flow were BUILT and merged but
 * never turned ON for the flywheel project itself (both are per-project opt-in,
 * default OFF for byte-compat). This is the FLY-698 "build done, never enabled"
 * disease.
 *
 * This test loads flywheel's CANONICAL `.flywheel/config.yaml` — the exact file
 * the Bridge reads at boot (auto-qa-config-source.ts → ConfigLoader → cfg.qa) —
 * and proves the switches are actually flipped. Crucially it also drives the
 * real config through the AutoQaCoordinator to prove it SPAWNS an independent QA
 * runner ("verify it really fires, don't just merge the config" — the lesson).
 *
 * If a future edit silently drops these blocks, auto-QA / doc-flow go dark for
 * flywheel again and this test fails loudly.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigLoader, type FlywheelConfig } from "flywheel-config";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import type { QaConfigResult } from "../auto-qa-config-source.js";
import {
	AutoQaCoordinator,
	type AutoQaSideEffects,
	type QaIssueRef,
} from "../auto-qa-coordinator.js";
import { resolveAutoQaPolicy } from "../auto-qa-policy.js";
import type { StartRequest } from "../retry-dispatcher.js";
import { resolveRoleAdapter } from "../role-adapter-resolver.js";

/** FLY-752: wrap a loaded `cfg.qa` into the policy's tri-state input. */
function qaTri(qa: FlywheelConfig["qa"]): QaConfigResult {
	return qa ? { kind: "config", ...qa } : { kind: "absent" };
}

// packages/teamlead/src/bridge/__tests__ → repo root is five levels up.
const REPO_ROOT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../..",
);
const CONFIG_PATH = resolve(REPO_ROOT, ".flywheel/config.yaml");

describe("FLY-707: flywheel auto-QA + doc_flow enablement (canonical config)", () => {
	let cfg: FlywheelConfig;
	beforeAll(async () => {
		const loader = new ConfigLoader(async (p) => readFileSync(p, "utf-8"));
		cfg = await loader.load(CONFIG_PATH);
	});

	it("qa.auto is enabled with docs/chore skip_labels", () => {
		expect(cfg.qa?.auto).toBe(true);
		const skip = (cfg.qa?.skip_labels ?? []).map((l) => l.toLowerCase());
		expect(skip).toContain("docs");
		expect(skip).toContain("chore");
	});

	it("doc_flow is enabled with the engineering department", () => {
		expect(cfg.doc_flow?.enabled).toBe(true);
		expect(cfg.doc_flow?.default_department).toBe("engineering");
	});

	it("auto-QA policy is ENABLED for a normal (engineer) issue", () => {
		expect(
			resolveAutoQaPolicy({
				qaConfig: qaTri(cfg.qa),
				issueLabels: ["engineer"],
				env: {},
			}).enabled,
		).toBe(true);
	});

	it("auto-QA policy SKIPS a docs-labelled issue (skip_labels)", () => {
		const d = resolveAutoQaPolicy({
			qaConfig: qaTri(cfg.qa),
			issueLabels: ["docs"],
			env: {},
		});
		expect(d.enabled).toBe(false);
		expect(d.reason).toContain("docs");
	});

	it("the canonical config DRIVES the coordinator to spawn an independent QA runner (真 fire)", async () => {
		const store = await StateStore.create(":memory:");
		const startCalls: StartRequest[] = [];
		const start = vi.fn(async (req: StartRequest) => {
			startCalls.push(req);
			return { executionId: "qa-1", issueId: req.issueId };
		});
		const qaIssue: QaIssueRef = {
			issueId: "qa-issue-uuid",
			issueIdentifier: "QA·FLY-707",
			issueTitle: "QA · FLY-1",
			issueUrl: "https://linear.app/x/issue/qa",
		};
		const effects: AutoQaSideEffects = {
			postThread: () => {},
			createQaIssue: () => qaIssue,
			notifyShipReady: () => {},
			feedbackWakeMain: () => {},
			alertLeadPipelineError: () => {},
			stampIssueStage: () => {},
			retestWakeQa: () => ({ ok: true }),
			closeQaRunner: () => {},
		};
		const coord = new AutoQaCoordinator({
			store,
			startDispatcher: { start },
			// Policy resolved from the REAL canonical config — NOT a hand-built stub.
			resolveQaPolicy: (session) =>
				resolveAutoQaPolicy({
					qaConfig: qaTri(cfg.qa),
					issueLabels: JSON.parse(session.issue_labels ?? "[]"),
					env: {},
				}),
			effects,
		});

		const SHA = "a".repeat(40);
		store.upsertSession({
			execution_id: "main-707",
			issue_id: "FLY-1",
			project_name: "flywheel",
			status: "awaiting_review",
			session_role: "main",
			issue_title: "Test issue",
			issue_identifier: "FLY-1",
			issue_labels: JSON.stringify(["engineer"]),
			branch: "fly-1",
			pr_number: 42,
		});
		store.setReviewBinding("main-707", { questionId: "q1", prHeadSha: SHA });
		const session = store.getSession("main-707");
		if (!session) throw new Error("session missing");

		await coord.onMainAwaitingReview(session);

		expect(start).toHaveBeenCalledTimes(1);
		expect(startCalls[0].sessionRole).toBe("qa");
		expect(startCalls[0].startPoint).toBe(SHA);
	});

	// FLY-788: roles.runner.model used to default to Fable 5 (FLY-728), so ANY
	// spawn with no vendor/model label and no dispatch `model` param — most
	// notably the auto-QA spawn above, which has neither — silently inherited
	// Fable and burned tokens. Pin the real canonical config + the real
	// resolver (not a hand-built projectRoles fixture) so a future edit that
	// silently reverts this to Fable fails loudly here.
	it("roles.runner defaults to Opus 4.8 (1M), not Fable (FLY-788)", () => {
		expect(cfg.roles?.runner?.backend).toBe("claude-tmux");
		expect(cfg.roles?.runner?.model).toBe("claude-opus-4-8[1m]");
		expect(
			resolveRoleAdapter({ role: "runner", projectRoles: cfg.roles, env: {} })
				.model,
		).toBe("claude-opus-4-8[1m]");
	});
});
