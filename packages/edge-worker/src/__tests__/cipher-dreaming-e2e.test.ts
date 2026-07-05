import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CipherReader } from "../cipher/CipherReader.js";
import { CipherWriter } from "../cipher/CipherWriter.js";
import { extractDimensions } from "../cipher/dimensions.js";
import { generatePatternKeys } from "../cipher/pattern-keys.js";
import type { SnapshotInputDto } from "../cipher/types.js";

function makeSnapshotInput(
	overrides: Partial<SnapshotInputDto> = {},
): SnapshotInputDto {
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
		} catch {
			/* ignore */
		}
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
		const result = await writer.retirePrinciple(
			"00000000-0000-0000-0000-000000000000",
			"test",
		);
		expect(result).toBe(false);
		writer.close();
	});

	it("retired principle is not re-proposed on subsequent dreaming", async () => {
		setup();
		const writer = await CipherWriter.create(dbPath);

		const input = makeSnapshotInput({ labels: ["bug"] });
		const dims = extractDimensions(input);
		const keys = generatePatternKeys(dims);

		// 55 approves → should produce skill + principle proposal
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

		// Wait for any fire-and-forget dreaming to settle
		await new Promise((r) => setTimeout(r, 100));
		await writer.runDreaming();
		const proposals = writer.getProposedPrinciples();
		expect(proposals.length).toBeGreaterThan(0);

		// CEO retires ALL proposals
		for (const p of proposals) {
			await writer.retirePrinciple(p.id, "CEO rejected");
		}

		// Run dreaming again — should NOT re-propose any of them
		await writer.runDreaming();
		const newProposals = writer.getProposedPrinciples();
		expect(newProposals).toHaveLength(0);

		writer.close();
	});

	it("time decay is idempotent — repeated calls produce same result", async () => {
		setup();
		const writer = await CipherWriter.create(dbPath);

		const input = makeSnapshotInput({ labels: ["bug"] });
		const dims = extractDimensions(input);
		const keys = generatePatternKeys(dims);

		// Create a pattern with 25 samples (established maturity)
		for (let i = 1; i <= 25; i++) {
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

		// Manually backdate last_seen_at to 90 days ago to trigger decay
		const staleDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
			.toISOString()
			.replace("T", " ")
			.replace(/\.\d+Z$/, "");
		writer
			.getDatabase()
			.run(`UPDATE decision_patterns SET last_seen_at = ?`, [staleDate]);

		// Run refreshTemporalWindows 3 times — maturity should NOT keep dropping
		await writer.refreshTemporalWindows();
		const after1 = writer
			.getDatabase()
			.exec(
				`SELECT pattern_key, maturity_level FROM decision_patterns WHERE pattern_key LIKE 'label:%'`,
			);
		const maturity1 = after1[0]?.values[0]?.[1] as string;

		await writer.refreshTemporalWindows();
		const after2 = writer
			.getDatabase()
			.exec(
				`SELECT pattern_key, maturity_level FROM decision_patterns WHERE pattern_key LIKE 'label:%'`,
			);
		const maturity2 = after2[0]?.values[0]?.[1] as string;

		await writer.refreshTemporalWindows();
		const after3 = writer
			.getDatabase()
			.exec(
				`SELECT pattern_key, maturity_level FROM decision_patterns WHERE pattern_key LIKE 'label:%'`,
			);
		const maturity3 = after3[0]?.values[0]?.[1] as string;

		// All three calls should produce the same maturity level (idempotent)
		expect(maturity1).toBe(maturity2);
		expect(maturity2).toBe(maturity3);
		// 90 days stale → should have decayed to exploratory
		expect(maturity1).toBe("exploratory");

		writer.close();
	});

	it("maturity promotion uses last_90d_total — decayed pattern needs recent activity", async () => {
		setup();
		const writer = await CipherWriter.create(dbPath);

		const input = makeSnapshotInput({ labels: ["bug"] });
		const dims = extractDimensions(input);
		const keys = generatePatternKeys(dims);

		// Create pattern with 15 samples → tentative maturity
		for (let i = 1; i <= 15; i++) {
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

		// Backdate everything to 130 days ago → triggers decay to exploratory
		const staleDate = new Date(Date.now() - 130 * 24 * 60 * 60 * 1000)
			.toISOString()
			.replace("T", " ")
			.replace(/\.\d+Z$/, "");
		writer
			.getDatabase()
			.run(`UPDATE decision_patterns SET last_seen_at = ?`, [staleDate]);
		writer
			.getDatabase()
			.run(`UPDATE review_pattern_keys SET created_at = ?`, [staleDate]);

		await writer.refreshTemporalWindows();

		// Verify decayed to exploratory
		const decayed = writer
			.getDatabase()
			.exec(
				`SELECT maturity_level FROM decision_patterns WHERE pattern_key LIKE 'label:%'`,
			);
		expect(decayed[0]?.values[0]?.[0]).toBe("exploratory");

		// Add 1 new review — total_count = 16, but last_90d_total = 1
		// Pattern should stay exploratory (needs 10 recent samples to promote)
		await writer.saveSnapshot({
			executionId: "exec-new",
			issueId: "issue-new",
			issueIdentifier: "GEO-NEW",
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
			executionId: "exec-new",
			ceoAction: "approve",
			ceoActionTimestamp: new Date().toISOString(),
			sourceStatus: "awaiting_review",
		});

		// Should still be exploratory — 1 recent sample < 10 threshold
		const afterNew = writer
			.getDatabase()
			.exec(
				`SELECT maturity_level, total_count, last_90d_total FROM decision_patterns WHERE pattern_key LIKE 'label:%'`,
			);
		const [ml, tc, r90] = afterNew[0]?.values[0]! as [string, number, number];
		expect(tc).toBe(16); // lifetime count increased
		expect(r90).toBe(1); // only 1 recent
		expect(ml).toBe("exploratory"); // NOT promoted back to tentative

		writer.close();
	});

	it("cascade retirement — decayed pattern retires skill and principle", async () => {
		setup();
		const writer = await CipherWriter.create(dbPath);

		const input = makeSnapshotInput({ labels: ["bug"] });
		const dims = extractDimensions(input);
		const keys = generatePatternKeys(dims);

		// 55 approves → skill + principle
		// Note: auto-dreaming fires at outcome 50 (fire-and-forget).
		// We await each recordOutcome, then await explicit runDreaming()
		// which will wait for isDreaming lock to release.
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

		// Wait for any fire-and-forget dreaming to settle
		await new Promise((r) => setTimeout(r, 100));
		await writer.runDreaming();

		// Activate a principle
		const proposals = writer.getProposedPrinciples();
		expect(proposals.length).toBeGreaterThan(0);
		await writer.activatePrinciple(proposals[0]!.id);

		// Verify skill and principle are active
		const activeSkills = writer
			.getDatabase()
			.exec(`SELECT COUNT(*) FROM cipher_skills WHERE status = 'active'`);
		expect(Number(activeSkills[0]?.values[0]?.[0])).toBeGreaterThan(0);

		// Backdate everything to trigger decay
		const staleDate = new Date(Date.now() - 130 * 24 * 60 * 60 * 1000)
			.toISOString()
			.replace("T", " ")
			.replace(/\.\d+Z$/, "");
		writer
			.getDatabase()
			.run(`UPDATE decision_patterns SET last_seen_at = ?`, [staleDate]);
		writer
			.getDatabase()
			.run(`UPDATE review_pattern_keys SET created_at = ?`, [staleDate]);

		// Run dreaming — triggers refreshTemporalWindows → cascade retirement
		await writer.runDreaming();

		// Pattern should be decayed
		const patterns = writer
			.getDatabase()
			.exec(
				`SELECT maturity_level FROM decision_patterns WHERE pattern_key LIKE 'label:%'`,
			);
		expect(patterns[0]?.values[0]?.[0]).toBe("exploratory");

		// Skill should be retired
		const skills = writer
			.getDatabase()
			.exec(`SELECT status FROM cipher_skills WHERE status = 'active'`);
		expect(skills[0]?.values?.length ?? 0).toBe(0);

		// Principle should be retired
		const principles = writer
			.getDatabase()
			.exec(`SELECT status FROM cipher_principles WHERE status = 'active'`);
		expect(principles[0]?.values?.length ?? 0).toBe(0);

		writer.close();
	});
});
