import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderAccountQuotaPageHtml } from "../../bridge/account-quota-page.js";
import type { CodexQuotaStandbyRow } from "../../bridge/codex-quota-store.js";
import {
	buildCodexStandbyPageSection,
	formatCodexStandbyStepLine,
	writeCodexStandbySummary,
} from "../standby-page.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const NOW = Date.parse("2026-09-25T12:00:00.000Z");

function row(overrides: Partial<CodexQuotaStandbyRow>): CodexQuotaStandbyRow {
	return {
		execution_id: "exec-1",
		run_id: "run-1",
		node_id: "implement",
		attempt: 1,
		activation_id: null,
		entry_seq: 1,
		trigger_signal_seq: 1,
		source_event_id: "wall",
		root_key: null,
		generation: null,
		binding_id: null,
		state: "standby",
		resume_phase: null,
		continue_attempt_id: null,
		continue_turn_id: null,
		permit_id: null,
		resume_attempt: 0,
		mechanical_failures: 0,
		capacity_rejections: 0,
		reconcile_failures: 0,
		owner_claim_id: null,
		lease_expires_at: null,
		fallback_attempt: 0,
		fallback_execution_id: null,
		fallback_vendor: null,
		fallback_reason: null,
		checkpoint_commit: null,
		release_reason: null,
		last_error_code: null,
		entered_at: "2026-09-25T10:47:00.000Z",
		updated_at: "2026-09-25T10:47:00.000Z",
		...overrides,
	};
}

const base = {
	issueOf: (id: string) => (id === "exec-x" ? "<b>FLY-1</b>" : "FLY-2900"),
	loop: null,
	claudeFallbackEnabled: true,
	readings: null,
	pool: [],
	nowMs: NOW,
};

describe("FLY-2900 C8 — account page standby section and STEP 2", () => {
	it("labels each parked node and counts resumes and fallbacks", () => {
		const section = buildCodexStandbyPageSection({
			...base,
			rows: [
				row({}),
				row({
					execution_id: "exec-2",
					state: "resuming",
					resume_phase: "launching",
				}),
				row({ execution_id: "exec-3", state: "fallback_prepared" }),
				row({ execution_id: "exec-4", entry_seq: 2 }),
			],
			audit: [
				{
					event_uid: "exec-4:2:fallback_blocked:1",
					action: "fallback_blocked",
					detail_code: "same_vendor_review",
					at: "2026-09-25T11:00:00.000Z",
				},
				{
					event_uid: "e:1:resumed:1",
					action: "resumed",
					at: "2026-09-25T11:30:00.000Z",
				},
				{
					event_uid: "f:1:fallback_committed:1",
					action: "fallback_committed",
					vendor: "claude",
					at: "2026-09-20T11:30:00.000Z",
				},
			],
		});
		expect(section.rows.map((r) => r.status)).toEqual([
			"等额度",
			"恢复中",
			"兜底准备中",
			"等 Codex（同厂商评审禁止改派）",
		]);
		expect(section).toMatchObject({
			claudeFallbacks14d: 1,
			resumed24h: 1,
			fallbacks24h: { codex: 0, claude: 0 },
		});
		expect(formatCodexStandbyStepLine(section, NOW)).toBe(
			"CODEX_STANDBY count=4 oldest=73m resumed_24h=1 fallback_24h=0/0",
		);
	});

	it("marks a queued node when the pool is walled and the Claude switch is off", () => {
		const walled = {
			version: 1 as const,
			generatedAt: "2026-09-25T11:59:00.000Z",
			activeAccount: "business",
			accounts: [
				{
					name: "business",
					registeredProfile: "business",
					identityKey: "a".repeat(64),
					observedAt: "2026-09-25T11:59:00.000Z",
					authHealth: "valid" as const,
					note: null,
					planType: "plus",
					fiveH: null,
					weekly: {
						usedPercent: 100,
						windowMinutes: 10080,
						resetAt: "2026-09-25T15:00:00.000Z",
					},
					credits: {
						known: false,
						hasCredits: null,
						unlimited: null,
						balance: null,
					},
					resetCredits: {
						known: false,
						value: null,
						availableCount: null,
						credits: null,
					},
					unclassifiedWindows: 0,
				},
			],
		};
		const section = buildCodexStandbyPageSection({
			...base,
			rows: [row({})],
			audit: [],
			claudeFallbackEnabled: false,
			readings: walled,
			pool: [{ profile: "business", accountKey: "a".repeat(64) }],
		});
		expect(section.rows[0]).toMatchObject({
			status: "全池满 · Claude 兜底开关关闭（排队中）",
			earliestResetAt: "2026-09-25T15:00:00.000Z",
		});
	});

	it("escapes every rendered string on the account page", () => {
		const section = buildCodexStandbyPageSection({
			...base,
			rows: [row({ execution_id: "exec-x", node_id: "<img src=x>" })],
			audit: [],
		});
		const html = renderAccountQuotaPageHtml(
			{
				generatedAt: "2026-09-25T12:00:00.000Z",
				staleAfterMinutes: 120,
				claude: [],
				codex: [],
				codexSourceLabel: "无数值源",
				discrepancies: [],
				warnings: [],
				claudeUnavailable: [],
				codexUnavailable: [],
			},
			undefined,
			{ codexStandby: section },
		);
		expect(html).toContain("额度待命中的节点");
		expect(html).toContain("近 14 天因额度改派 Claude：0 次");
		expect(html).not.toContain("<b>FLY-1</b>");
		expect(html).toContain("&lt;b&gt;FLY-1&lt;/b&gt;");
		expect(html).not.toContain("<img src=x>");
	});

	it("projects the STEP 2 counts atomically", () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2900-step2-"));
		roots.push(dir);
		const path = join(dir, "codex-quota", "standby-summary.json");
		writeCodexStandbySummary(
			path,
			buildCodexStandbyPageSection({ ...base, rows: [row({})], audit: [] }),
			NOW,
		);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			schemaVersion: 1,
			generatedAt: "2026-09-25T12:00:00.000Z",
			count: 1,
			oldestMinutes: 73,
			resumed24h: 0,
			fallback24hCodex: 0,
			fallback24hClaude: 0,
		});
	});
});
