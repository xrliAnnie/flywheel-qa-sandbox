import type { CodexLaunchSnapshot } from "flywheel-claude-runner";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../StateStore.js";
import {
	buildCodexRecoveryContext,
	resolveCodexRecoveryWindow,
} from "../codex-session-reown.js";

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
	it("FLY-2170 uses the immutable snapshot label without probing tmux", async () => {
		const listWindows = vi.fn(async () => {
			throw new Error("must not probe");
		});

		await expect(
			resolveCodexRecoveryWindow({
				executionId: "exec-1",
				projectName: "flywheel",
				snapshotLabel: "FLY-2170-birth-label",
				listWindows,
				lookupTarget: vi.fn(),
			}),
		).resolves.toEqual({
			founderWindow: "open",
			label: "FLY-2170-birth-label",
		});
		expect(listWindows).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "one live window",
			windows: [
				{
					windowId: "@42",
					windowName: "FLY-2170-birth-label",
					sessions: ["runner-flywheel"],
				},
			],
		},
		{
			name: "multiple live windows with one shared name",
			windows: [
				{
					windowId: "@42",
					windowName: "FLY-2170-birth-label",
					sessions: ["runner-flywheel"],
				},
				{
					windowId: "@43",
					windowName: "FLY-2170-birth-label",
					sessions: ["other-base"],
				},
			],
		},
	])("FLY-2170 recovers the label from $name", async ({ windows }) => {
		const lookupTarget = vi.fn();

		await expect(
			resolveCodexRecoveryWindow({
				executionId: "exec-1",
				projectName: "flywheel",
				listWindows: async () => ({ kind: "ok", windows }),
				lookupTarget,
			}),
		).resolves.toEqual({
			founderWindow: "open",
			label: "FLY-2170-birth-label",
			windowName: "FLY-2170-birth-label",
		});
		expect(lookupTarget).not.toHaveBeenCalled();
	});

	it("FLY-2170 uses the CommDB pointer to disambiguate different live names", async () => {
		await expect(
			resolveCodexRecoveryWindow({
				executionId: "exec-1",
				projectName: "flywheel",
				listWindows: async () => ({
					kind: "ok",
					windows: [
						{
							windowId: "@42",
							windowName: "birth-name",
							sessions: ["runner-flywheel"],
						},
						{
							windowId: "@43",
							windowName: "recovered-name",
							sessions: ["runner-flywheel"],
						},
					],
				}),
				lookupTarget: () => ({
					kind: "found",
					target: {
						tmuxWindow: "runner-flywheel:@43",
						sessionName: "runner-flywheel",
					},
				}),
			}),
		).resolves.toEqual({
			founderWindow: "open",
			label: "recovered-name",
			windowName: "recovered-name",
		});
	});

	it.each([
		{
			name: "indeterminate inventory",
			listWindows: async () => ({
				kind: "indeterminate" as const,
				reason: "tmux_list_failed",
			}),
			lookupTarget: vi.fn(),
			reason: "candidates_indeterminate",
		},
		{
			name: "inventory exception",
			listWindows: async () => {
				throw new Error("tmux exploded");
			},
			lookupTarget: vi.fn(),
			reason: "candidates_indeterminate",
		},
		{
			name: "no candidates",
			listWindows: async () => ({ kind: "ok" as const, windows: [] }),
			lookupTarget: vi.fn(),
			reason: "no_candidates",
		},
		{
			name: "CommDB read error",
			listWindows: async () => ({
				kind: "ok" as const,
				windows: [
					{
						windowId: "@42",
						windowName: "birth-name",
						sessions: ["runner-flywheel"],
					},
					{
						windowId: "@43",
						windowName: "recovered-name",
						sessions: ["runner-flywheel"],
					},
				],
			}),
			lookupTarget: () => ({ kind: "error" as const, error: "locked" }),
			reason: "commdb_lookup_error",
		},
		{
			name: "CommDB exception",
			listWindows: async () => ({
				kind: "ok" as const,
				windows: [
					{
						windowId: "@42",
						windowName: "birth-name",
						sessions: ["runner-flywheel"],
					},
					{
						windowId: "@43",
						windowName: "recovered-name",
						sessions: ["runner-flywheel"],
					},
				],
			}),
			lookupTarget: () => {
				throw new Error("database exploded");
			},
			reason: "commdb_lookup_error",
		},
		{
			name: "CommDB pointer outside candidates",
			listWindows: async () => ({
				kind: "ok" as const,
				windows: [
					{
						windowId: "@42",
						windowName: "birth-name",
						sessions: ["runner-flywheel"],
					},
					{
						windowId: "@43",
						windowName: "recovered-name",
						sessions: ["runner-flywheel"],
					},
				],
			}),
			lookupTarget: () => ({
				kind: "found" as const,
				target: {
					tmuxWindow: "runner-flywheel:@99",
					sessionName: "runner-flywheel",
				},
			}),
			reason: "commdb_pointer_not_in_candidates",
		},
	])("FLY-2170 suppresses the founder window on $name", async (scenario) => {
		await expect(
			resolveCodexRecoveryWindow({
				executionId: "exec-1",
				projectName: "flywheel",
				listWindows: scenario.listWindows,
				lookupTarget: scenario.lookupTarget,
			}),
		).resolves.toEqual({
			founderWindow: "suppressed",
			reason: scenario.reason,
		});
	});

	it("rehydrates the exact non-secret launch capabilities and fresh workflow tokens", () => {
		const heartbeat = vi.fn();
		const context = buildCodexRecoveryContext({
			session,
			snapshot,
			label: "FLY-2211-implement-codex-Restart-isolation",
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
			label: "FLY-2211-implement-codex-Restart-isolation",
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

	it("FLY-2170 does not reconstruct a label when recovery omits one", () => {
		const context = buildCodexRecoveryContext({
			session,
			snapshot,
			capabilities: {
				ok: true,
				enrolled: false,
				workflowSubmissionExpected: true,
				founderReviewRequired: false,
			},
		});

		expect(context).not.toHaveProperty("label");
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
