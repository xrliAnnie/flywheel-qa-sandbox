import type { CodexLaunchSnapshot } from "flywheel-claude-runner";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../StateStore.js";
import { buildCodexRecoveryContext } from "../codex-session-reown.js";

const session: Session = {
	execution_id: "exec-1",
	issue_id: "issue-1",
	issue_identifier: "FLY-2211",
	issue_title: "Restart isolation",
	project_name: "flywheel",
	status: "awaiting_review",
	adapter_type: "codex-tmux",
};

const snapshot: CodexLaunchSnapshot = {
	schemaVersion: 1,
	executionId: "exec-1",
	cwd: "/repo/worktree",
	objective: "immutable objective",
	kickText: "immutable kick",
	launchContext: {
		sandboxWritableRoots: ["/repo/worktree"],
		model: "gpt-5.6-sol",
		effort: "high",
		appsApprovalMode: "never",
		skillFrameworkMode: "bare",
		phaseRole: "implement",
		capabilityDigest: "a".repeat(64),
	},
	rehydrationContext: {
		allowedTools: ["Bash", "Read(**)"],
		enablePonytail: true,
		codexSkillDisableNames: ["superpowers:using-superpowers"],
		codexMattSkillsSourceDir: null,
		workflowSubmissionExpected: true,
		founderReviewRequired: false,
	},
};

describe("FLY-2211 recovery context", () => {
	it("rehydrates the exact non-secret launch capabilities and fresh workflow tokens", () => {
		const heartbeat = vi.fn();
		const context = buildCodexRecoveryContext({
			session,
			snapshot,
			capabilities: {
				ok: true,
				enrolled: true,
				workflowSubmissionExpected: true,
				founderReviewRequired: false,
				workflowOutputCredential: "fresh-output",
			},
			leadId: "flywheel-eng-lead",
			agentName: "runner-exec-1",
			teamName: "flywheel-eng-lead",
			commDbPath: "/state/comm.db",
			stateDbPath: "/state/teamlead.db",
			bridgeUrl: "http://127.0.0.1:4100",
			bridgeIngestToken: "runner-visible-ingest",
			progressPath: "/repo/engineering/doc/FLY-2211/progress.md",
			onHeartbeat: heartbeat,
		});

		expect(context).toMatchObject({
			executionId: "exec-1",
			issueId: "issue-1",
			prompt: "immutable kick",
			cwd: "/repo/worktree",
			model: "gpt-5.6-sol",
			effort: "high",
			allowedTools: ["Bash", "Read(**)"],
			enablePonytail: true,
			skillFrameworkMode: "bare",
			codexSkillDisableNames: ["superpowers:using-superpowers"],
			phaseKeepAlive: { role: "implement" },
			workflowSubmissionExpected: true,
			workflowOutputCredential: "fresh-output",
			founderReviewRequired: false,
			agentName: "runner-exec-1",
			teamName: "flywheel-eng-lead",
			vendor: "codex",
		});
		expect(context.onHeartbeat).toBe(heartbeat);
	});

	it("refuses legacy snapshots that lack the raw rehydration contract", () => {
		expect(() =>
			buildCodexRecoveryContext({
				session,
				snapshot: { ...snapshot, rehydrationContext: undefined },
				capabilities: {
					ok: true,
					enrolled: false,
					workflowSubmissionExpected: false,
					founderReviewRequired: false,
				},
			}),
		).toThrow(/lacks rehydration context/);
	});

	it("refuses workflow authority that does not match the immutable launch", () => {
		expect(() =>
			buildCodexRecoveryContext({
				session,
				snapshot,
				capabilities: {
					ok: true,
					enrolled: false,
					workflowSubmissionExpected: false,
					founderReviewRequired: false,
				},
			}),
		).toThrow(/workflow capability drift/);
	});
});
