import { describe, expect, it, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { CipherWriter } from "../cipher/CipherWriter.js";
import { CipherReader } from "../cipher/CipherReader.js";
import { extractDimensions } from "../cipher/dimensions.js";
import { generatePatternKeys } from "../cipher/pattern-keys.js";
import type { SnapshotInputDto } from "../cipher/types.js";

function makeSnapshotInput(overrides: Partial<SnapshotInputDto> = {}): SnapshotInputDto {
	return {
		labels: ["bug"],
		exitReason: "completed",
		changedFilePaths: ["src/foo.ts"],
		commitCount: 2,
		filesChangedCount: 1,
		linesAdded: 30,
		linesRemoved: 10,
		consecutiveFailures: 0,
		...overrides,
	};
}

describe("CIPHER dreaming E2E — full pipeline", () => {
	let tmpDir: string;
	let dbPath: string;

	function setup() {
		tmpDir = mkdtempSync(join(tmpdir(), "cipher-dream-"));
		dbPath = join(tmpDir, "cipher.db");
	}

	afterEach(() => {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch { /* ignore */ }
	});

	it("55 approves on same pattern → skill extraction + principle graduation", async () => {
		setup();
		const writer = await CipherWriter.create(dbPath);
		const notifications: unknown[] = [];
		writer.setNotifyFn(async (payload) => {
			notifications.push(payload);
		});

		const input = makeSnapshotInput({ labels: ["bug"] });
		const dims = extractDimensions(input);
		const keys = generatePatternKeys(dims);

		// Simulate 55 approved bug-fix executions
		for (let i = 1; i <= 55; i++) {
			await writer.saveSnapshot({
				executionId: `exec-${i}`,
				issueId: `issue-${i}`,
				issueIdentifier: `GEO-${i}`,
				issueTitle: "Fix bug",
				projectId: "proj-1",
				issueLabels: ["bug"],
				dimensions: dims,
				patternKeys: keys,
				systemRoute: "needs_review",
				systemConfidence: 0.7,
				decisionSource: "haiku_triage",
				commitCount: 2,
				filesChanged: 1,
				linesAdded: 30,
				linesRemoved: 10,
				exitReason: "completed",
				durationMs: 120000,
				consecutiveFailures: 0,
				changedFilePaths: ["src/foo.ts"],
				commitMessages: ["fix: bug"],
			});

			await writer.recordOutcome({
				executionId: `exec-${i}`,
				ceoAction: "approve",
				ceoActionTimestamp: new Date().toISOString(),
				sourceStatus: "awaiting_review",
			});
		}

		// Run dreaming — should detect questions, extract skills, graduate principles
		await writer.runDreaming();

		// Check skills were extracted with 'active' status
		const skills = writer.db.exec(
			`SELECT id, name, source_pattern_key, recommended_action, status, sample_count
			 FROM cipher_skills WHERE status = 'active'`,
		);
		expect(skills.length).toBeGreaterThan(0);
		expect(skills[0]!.values.length).toBeGreaterThan(0);

		// At least one skill should be for 'likely_approve' (55 approves, 0 rejects = 100% rate)
		const skillActions = skills[0]!.values.map((r) => r[3]);
		expect(skillActions).toContain("likely_approve");

		// Check principles were proposed (graduated from active skills with 90%+ confidence, 50+ samples)
		const principles = writer.getProposedPrinciples();
		expect(principles.length).toBeGreaterThan(0);

		// Verify notification was sent for the proposal
		expect(notifications.length).toBeGreaterThan(0);
		const firstNotif = notifications[0] as Record<string, unknown>;
		expect(firstNotif.event_type).toBe("cipher_principle_proposed");

		// Activate the first principle
		const activated = await writer.activatePrinciple(principles[0]!.id);
		expect(activated).toBe(true);

		writer.close();

		// Reader should find the active principle
		const reader = new CipherReader(dbPath);
		const activePrinciples = await reader.loadActivePrinciples();
		expect(activePrinciples.length).toBeGreaterThan(0);
		expect(activePrinciples[0]!.ruleType).toBe("escalate");

		// With 100% uniform approves, no pattern deviates from global rate
		// so buildPromptContext correctly returns null (nothing "interesting" to report)
		const context = await reader.buildPromptContext(input);
		expect(context).toBeNull();
	});

	it("mixed labels → buildPromptContext shows deviating pattern", async () => {
		setup();
		const writer = await CipherWriter.create(dbPath);

		const bugInput = makeSnapshotInput({ labels: ["bug"] });
		const bugDims = extractDimensions(bugInput);
		const bugKeys = generatePatternKeys(bugDims);

		const featureInput = makeSnapshotInput({
			labels: ["feature"],
			changedFilePaths: ["src/components/App.tsx"],
			linesAdded: 200,
			linesRemoved: 50,
			filesChangedCount: 5,
			commitCount: 4,
		});
		const featureDims = extractDimensions(featureInput);
		const featureKeys = generatePatternKeys(featureDims);

		// 30 bug fixes — all approved (100% approve)
		for (let i = 1; i <= 30; i++) {
			await writer.saveSnapshot({
				executionId: `bug-${i}`,
				issueId: `issue-bug-${i}`,
				issueIdentifier: `GEO-B${i}`,
				issueTitle: "Fix bug",
				projectId: "proj-1",
				issueLabels: ["bug"],
				dimensions: bugDims,
				patternKeys: bugKeys,
				systemRoute: "needs_review",
				systemConfidence: 0.7,
				decisionSource: "haiku_triage",
				commitCount: 2,
				filesChanged: 1,
				linesAdded: 30,
				linesRemoved: 10,
				exitReason: "completed",
				durationMs: 120000,
				consecutiveFailures: 0,
				changedFilePaths: ["src/foo.ts"],
				commitMessages: ["fix: bug"],
			});
			await writer.recordOutcome({
				executionId: `bug-${i}`,
				ceoAction: "approve",
				ceoActionTimestamp: new Date().toISOString(),
				sourceStatus: "awaiting_review",
			});
		}

		// 20 features — all rejected (0% approve)
		for (let i = 1; i <= 20; i++) {
			await writer.saveSnapshot({
				executionId: `feat-${i}`,
				issueId: `issue-feat-${i}`,
				issueIdentifier: `GEO-F${i}`,
				issueTitle: "Add feature",
				projectId: "proj-1",
				issueLabels: ["feature"],
				dimensions: featureDims,
				patternKeys: featureKeys,
				systemRoute: "needs_review",
				systemConfidence: 0.5,
				decisionSource: "haiku_triage",
				commitCount: 4,
				filesChanged: 5,
				linesAdded: 200,
				linesRemoved: 50,
				exitReason: "completed",
				durationMs: 180000,
				consecutiveFailures: 0,
				changedFilePaths: ["src/components/App.tsx"],
				commitMessages: ["feat: feature"],
			});
			await writer.recordOutcome({
				executionId: `feat-${i}`,
				ceoAction: "reject",
				ceoActionTimestamp: new Date().toISOString(),
				sourceStatus: "awaiting_review",
			});
		}

		writer.close();

		// Global rate = 30/50 = 60%. Bug label = 100% approve → HIGH_APPROVE deviation
		const reader = new CipherReader(dbPath);
		const bugContext = await reader.buildPromptContext(bugInput);
		expect(bugContext).not.toBeNull();
		expect(bugContext!.promptText).toContain("CIPHER");
		expect(bugContext!.promptText).toContain("HIGH_APPROVE");
		expect(bugContext!.globalApproveRate).toBeCloseTo(0.6, 1);

		// Feature label = 0% approve → LOW_APPROVE deviation
		const featureContext = await reader.buildPromptContext(featureInput);
		expect(featureContext).not.toBeNull();
		expect(featureContext!.promptText).toContain("LOW_APPROVE");
	});

	it("mixed approve/reject → no principle graduation (low confidence)", async () => {
		setup();
		const writer = await CipherWriter.create(dbPath);

		const input = makeSnapshotInput({ labels: ["feature"] });
		const dims = extractDimensions(input);
		const keys = generatePatternKeys(dims);

		// 30 approves + 25 rejects = ~55% approve rate (below 70% threshold for skill extraction)
		for (let i = 1; i <= 55; i++) {
			await writer.saveSnapshot({
				executionId: `exec-${i}`,
				issueId: `issue-${i}`,
				issueIdentifier: `GEO-${i}`,
				issueTitle: "Add feature",
				projectId: "proj-1",
				issueLabels: ["feature"],
				dimensions: dims,
				patternKeys: keys,
				systemRoute: "needs_review",
				systemConfidence: 0.5,
				decisionSource: "haiku_triage",
				commitCount: 3,
				filesChanged: 2,
				linesAdded: 100,
				linesRemoved: 20,
				exitReason: "completed",
				durationMs: 180000,
				consecutiveFailures: 0,
				changedFilePaths: ["src/feature.ts"],
				commitMessages: ["feat: add feature"],
			});

			await writer.recordOutcome({
				executionId: `exec-${i}`,
				ceoAction: i <= 30 ? "approve" : "reject",
				ceoActionTimestamp: new Date().toISOString(),
				sourceStatus: "awaiting_review",
			});
		}

		await writer.runDreaming();

		// With ~55% rate, skills should NOT be extracted (threshold is 70% approve or 70% reject)
		const principles = writer.getProposedPrinciples();
		expect(principles).toHaveLength(0);

		writer.close();
	});

	it("55 rejects → skill extracted with likely_reject + block rule type", async () => {
		setup();
		const writer = await CipherWriter.create(dbPath);
		const notifications: unknown[] = [];
		writer.setNotifyFn(async (payload) => {
			notifications.push(payload);
		});

		const input = makeSnapshotInput({
			labels: ["experiment"],
			changedFilePaths: ["src/auth/login.ts"],
			linesAdded: 500,
			linesRemoved: 200,
		});
		const dims = extractDimensions(input);
		const keys = generatePatternKeys(dims);

		for (let i = 1; i <= 55; i++) {
			await writer.saveSnapshot({
				executionId: `exec-${i}`,
				issueId: `issue-${i}`,
				issueIdentifier: `GEO-${i}`,
				issueTitle: "Experiment",
				projectId: "proj-1",
				issueLabels: ["experiment"],
				dimensions: dims,
				patternKeys: keys,
				systemRoute: "needs_review",
				systemConfidence: 0.5,
				decisionSource: "haiku_triage",
				commitCount: 5,
				filesChanged: 3,
				linesAdded: 500,
				linesRemoved: 200,
				exitReason: "completed",
				durationMs: 300000,
				consecutiveFailures: 0,
				changedFilePaths: ["src/auth/login.ts"],
				commitMessages: ["feat: experiment"],
			});

			await writer.recordOutcome({
				executionId: `exec-${i}`,
				ceoAction: "reject",
				ceoActionTimestamp: new Date().toISOString(),
				sourceStatus: "awaiting_review",
			});
		}

		await writer.runDreaming();

		// Should extract skills with 'likely_reject'
		const skills = writer.db.exec(
			`SELECT recommended_action FROM cipher_skills WHERE status = 'active'`,
		);
		expect(skills.length).toBeGreaterThan(0);
		const actions = skills[0]!.values.map((r) => r[0]);
		expect(actions).toContain("likely_reject");

		// Should graduate to principle with 'block' rule type
		const principles = writer.getProposedPrinciples();
		expect(principles.length).toBeGreaterThan(0);
		const blockPrinciples = principles.filter((p) => p.rule_type === "block");
		expect(blockPrinciples.length).toBeGreaterThan(0);

		writer.close();
	});

	it("retirePrinciple returns false for nonexistent ID", async () => {
		setup();
		const writer = await CipherWriter.create(dbPath);
		const result = await writer.retirePrinciple("00000000-0000-0000-0000-000000000000", "test");
		expect(result).toBe(false);
		writer.close();
	});
});
