import type { DecisionResult, ExecutionContext } from "flywheel-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackNotifierConfig } from "../SlackNotifier.js";
import { SlackNotifier } from "../SlackNotifier.js";

// Mock SlackMessageService
const mockPostMessage = vi.fn().mockResolvedValue(undefined);
const mockMessageService = { postMessage: mockPostMessage } as any;

function makeConfig(
	overrides?: Partial<SlackNotifierConfig>,
): SlackNotifierConfig {
	return {
		channelId: "C07TEST",
		botToken: "xoxb-test-token",
		projectRepo: "xrliAnnie/GeoForge3D",
		linearTeamKey: "GEO",
		...overrides,
	};
}

function makeCtx(overrides?: Partial<ExecutionContext>): ExecutionContext {
	return {
		executionId: "test-exec-id",
		issueId: "issue-123",
		issueIdentifier: "GEO-95",
		issueTitle: "Add dark mode support",
		labels: [],
		projectId: "proj-1",
		exitReason: "completed",
		baseSha: "abc123",
		commitCount: 3,
		commitMessages: ["feat: add dark mode toggle", "fix: theme persistence"],
		changedFilePaths: ["src/theme.ts", "src/App.tsx"],
		filesChangedCount: 2,
		linesAdded: 45,
		linesRemoved: 10,
		diffSummary: "+45 -10",
		headSha: "def456",
		durationMs: 120000,
		consecutiveFailures: 0,
		partial: false,
		...overrides,
	};
}

function makeDecision(overrides?: Partial<DecisionResult>): DecisionResult {
	return {
		route: "needs_review",
		confidence: 0.75,
		reasoning: "Changes look reasonable but need human review",
		concerns: ["Modified auth module"],
		decisionSource: "haiku_triage",
		...overrides,
	};
}

describe("SlackNotifier", () => {
	let notifier: SlackNotifier;

	beforeEach(() => {
		vi.clearAllMocks();
		notifier = new SlackNotifier(makeConfig(), mockMessageService);
	});

	describe("needs_review", () => {
		it("builds correct header block", async () => {
			await notifier.notify(makeCtx(), makeDecision());

			expect(mockPostMessage).toHaveBeenCalledTimes(1);
			const { blocks } = mockPostMessage.mock.calls[0][0];
			const header = blocks.find((b: any) => b.type === "header");
			expect(header).toBeDefined();
			expect(header.text.text).toBe("Review Required: GEO-95");
		});

		it("includes issue info section with all fields", async () => {
			await notifier.notify(makeCtx(), makeDecision());

			const { blocks } = mockPostMessage.mock.calls[0][0];
			const sections = blocks.filter((b: any) => b.type === "section");
			// First section should have fields with issue info
			const infoSection = sections.find((s: any) => s.fields);
			expect(infoSection).toBeDefined();
			const fieldTexts = infoSection.fields.map((f: any) => f.text);
			// Check key info is present
			expect(fieldTexts.some((t: string) => t.includes("GEO-95"))).toBe(true);
			expect(fieldTexts.some((t: string) => t.includes("3"))).toBe(true); // commits
			expect(fieldTexts.some((t: string) => t.includes("2 files"))).toBe(true);
			expect(fieldTexts.some((t: string) => t.includes("+45/-10"))).toBe(true);
		});

		it("includes reasoning section", async () => {
			await notifier.notify(makeCtx(), makeDecision());

			const { blocks } = mockPostMessage.mock.calls[0][0];
			const sections = blocks.filter(
				(b: any) => b.type === "section" && b.text,
			);
			const reasoningSection = sections.find((s: any) =>
				s.text.text.includes("Reasoning"),
			);
			expect(reasoningSection).toBeDefined();
			expect(reasoningSection.text.text).toContain("Changes look reasonable");
			expect(reasoningSection.text.text).toContain("75%");
		});

		it("includes concerns when present", async () => {
			await notifier.notify(
				makeCtx(),
				makeDecision({ concerns: ["Modified auth module", "Large diff"] }),
			);

			const { blocks } = mockPostMessage.mock.calls[0][0];
			const sections = blocks.filter(
				(b: any) => b.type === "section" && b.text,
			);
			const concernSection = sections.find((s: any) =>
				s.text.text.includes("Concerns"),
			);
			expect(concernSection).toBeDefined();
			expect(concernSection.text.text).toContain("Modified auth module");
			expect(concernSection.text.text).toContain("Large diff");
		});

		it("omits concerns when empty", async () => {
			await notifier.notify(makeCtx(), makeDecision({ concerns: [] }));

			const { blocks } = mockPostMessage.mock.calls[0][0];
			const sections = blocks.filter(
				(b: any) => b.type === "section" && b.text,
			);
			const concernSection = sections.find((s: any) =>
				s.text.text.includes("Concerns"),
			);
			expect(concernSection).toBeUndefined();
		});

		it("includes 4 action buttons", async () => {
			await notifier.notify(makeCtx(), makeDecision());

			const { blocks } = mockPostMessage.mock.calls[0][0];
			const actions = blocks.find((b: any) => b.type === "actions");
			expect(actions).toBeDefined();
			expect(actions.elements).toHaveLength(4);

			const buttonTexts = actions.elements.map((e: any) => e.text.text);
			expect(buttonTexts).toContain("Approve & Merge");
			expect(buttonTexts).toContain("Reject");
			expect(buttonTexts).toContain("Defer");
			expect(buttonTexts).toContain("View PR");
		});

		it("action_id includes issueId", async () => {
			await notifier.notify(makeCtx(), makeDecision());

			const { blocks } = mockPostMessage.mock.calls[0][0];
			const actions = blocks.find((b: any) => b.type === "actions");
			const actionIds = actions.elements.map((e: any) => e.action_id);
			expect(actionIds).toContain("flywheel_approve_issue-123");
			expect(actionIds).toContain("flywheel_reject_issue-123");
			expect(actionIds).toContain("flywheel_defer_issue-123");
			expect(actionIds).toContain("flywheel_view_pr_issue-123");
		});
	});

	describe("blocked", () => {
		it("builds correct header block", async () => {
			await notifier.notify(
				makeCtx(),
				makeDecision({ route: "blocked", reasoning: "Zero commits" }),
			);

			const { blocks } = mockPostMessage.mock.calls[0][0];
			const header = blocks.find((b: any) => b.type === "header");
			expect(header.text.text).toBe("Blocked: GEO-95");
		});

		it("includes retry + shelve buttons", async () => {
			await notifier.notify(makeCtx(), makeDecision({ route: "blocked" }));

			const { blocks } = mockPostMessage.mock.calls[0][0];
			const actions = blocks.find((b: any) => b.type === "actions");
			expect(actions).toBeDefined();
			const buttonTexts = actions.elements.map((e: any) => e.text.text);
			expect(buttonTexts).toContain("Retry");
			expect(buttonTexts).toContain("Shelve");
		});
	});

	describe("auto_approve", () => {
		it("HR-LANDED auto_approve sends nothing", async () => {
			const result = await notifier.notify(
				makeCtx(),
				makeDecision({ route: "auto_approve", hardRuleId: "HR-LANDED" }),
			);

			expect(mockPostMessage).not.toHaveBeenCalled();
			expect(result.sent).toBe(false);
		});

		it("non-HR-LANDED auto_approve normalizes to needs_review and sends", async () => {
			const result = await notifier.notify(
				makeCtx(),
				makeDecision({ route: "auto_approve", hardRuleId: undefined }),
			);

			expect(mockPostMessage).toHaveBeenCalledTimes(1);
			expect(result.sent).toBe(true);
			const { text, blocks } = mockPostMessage.mock.calls[0][0];
			expect(text).toContain("Review Required");
			const header = blocks.find((b: any) => b.type === "header");
			expect(header.text.text).toBe("Review Required: GEO-95");
		});
	});
});
