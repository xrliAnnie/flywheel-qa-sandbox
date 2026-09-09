import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readStore, writeStore } from "../account-heal/account-store.js";
import { makeClaudeProfileSwitchDeps } from "../account-heal/claude-profile-cli.js";
import { sendQuotaMonitorAlert } from "../account-heal/quota-monitor-alert.js";
import { makeQuotaMonitorRuntime } from "../account-heal/quota-monitor-runtime.js";
import {
	emptyQuotaMonitorState,
	writeQuotaMonitorState,
} from "../account-heal/quota-monitor-state.js";
import { writeQuotaWitness } from "../account-heal/quota-witness.js";
import {
	switchAccount as executeAccountSwitch,
	type SwitchInput,
} from "../account-heal/switch-executor.js";
import {
	createAccountSwitchConsumer,
	WAKE_TEXT,
} from "../bridge/account-switch-consumer.js";
import type { ClaudeReviewOutcome } from "../bridge/claude-review-runner.js";
import { ReviewRequestCoordinator } from "../bridge/review-request-coordinator.js";
import { StateStore } from "../StateStore.js";
import { usageResult } from "./quota-monitor-test-helpers.js";

const DISABLED_RAW = JSON.stringify({
	api_error_status: 403,
	result:
		"Your organization has disabled Claude subscription access for Claude Code",
});

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitFor(assertion: () => void): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			assertion();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setImmediate(resolve));
		}
	}
	throw lastError;
}

describe("FLY-2452 disabled-account recovery chain", () => {
	let fixture: string | undefined;
	let stateStore: StateStore | undefined;
	let coordinator: ReviewRequestCoordinator | undefined;

	afterEach(() => {
		coordinator?.stop();
		stateStore?.close();
		if (fixture) rmSync(fixture, { recursive: true, force: true });
		fixture = undefined;
		stateStore = undefined;
		coordinator = undefined;
	});

	it("parks a 403 review, switches immediately, redrives it, and wakes only Claude work", async () => {
		fixture = mkdtempSync(join(tmpdir(), "fly2452-account-switch-e2e-"));
		const poolDir = join(fixture, "profiles");
		const accountPath = join(fixture, "accounts.json");
		const lockPath = join(fixture, "accounts.lock");
		const statePath = join(fixture, "quota-monitor-state.json");
		const witnessPath = join(fixture, "quota-monitor-witness.json");
		const configPath = join(fixture, "quota-monitor.json");
		const cachePath = join(fixture, "usage-cache.json");
		const claudeJsonPath = join(fixture, "claude.json");
		const projectsPath = join(fixture, "projects.json");
		const commPath = join(fixture, "comm.db");
		let clock = Date.now();

		mkdirSync(poolDir, { recursive: true });
		writeFileSync(join(poolDir, ".active"), "personal1\n", { mode: 0o600 });
		for (const [name, token] of [
			["personal1", "disabled-token"],
			["business", "healthy-token"],
		] as const) {
			const profileDir = join(poolDir, name);
			mkdirSync(profileDir);
			writeFileSync(
				join(profileDir, ".credentials.json"),
				JSON.stringify({
					claudeAiOauth: {
						accessToken: token,
						refreshToken: `${name}-refresh`,
						expiresAt: clock + 3_600_000,
					},
				}),
				{ mode: 0o600 },
			);
			writeFileSync(
				join(profileDir, "oauthAccount.json"),
				JSON.stringify({ emailAddress: `${name}@example.com` }),
				{ mode: 0o600 },
			);
		}
		writeFileSync(
			claudeJsonPath,
			JSON.stringify({
				oauthAccount: { emailAddress: "personal1@example.com" },
			}),
			{ mode: 0o600 },
		);
		writeStore(
			{
				generation: 1,
				activeAccount: "personal1",
				accounts: [
					{
						name: "personal1",
						quotaExhaustedUntil: null,
						weeklyResetAt: null,
					},
					{
						name: "business",
						quotaExhaustedUntil: null,
						weeklyResetAt: null,
					},
				],
			},
			accountPath,
		);
		writeQuotaMonitorState(emptyQuotaMonitorState(1), statePath);
		writeFileSync(
			configPath,
			JSON.stringify({
				trigger5hPct: 90,
				basePollMinutes: 1,
				acceleratePct: 70,
				acceleratedPollMinutes: 1,
				candidateSweepMinutes: 60,
				minSwitchIntervalMinutes: 15,
				order: ["personal1", "business"],
				writeStatuslineCache: false,
			}),
			{ mode: 0o600 },
		);
		writeFileSync(
			projectsPath,
			JSON.stringify([
				{
					projectName: "flywheel",
					projectRoot: fixture,
					leads: [
						{
							agentId: "flywheel-eng-lead",
							summaryRole: "producer",
							chatChannel: "666666666666666666",
							match: { labels: ["Engineering"] },
							alertChannel: "888888888888888888",
						},
					],
				},
			]),
			{ mode: 0o600 },
		);

		stateStore = await StateStore.create(join(fixture, "teamlead.db"));
		const reviewExecution = "review-exec";
		const claudeExecution = "claude-qa";
		const codexExecution = "codex-implement";
		const startedAt = new Date(clock - 60_000)
			.toISOString()
			.replace("T", " ")
			.replace("Z", "");
		for (const [executionId, vendor] of [
			[reviewExecution, "codex"],
			[claudeExecution, "claude-code"],
			[codexExecution, "codex"],
		] as const) {
			stateStore.upsertSession({
				execution_id: executionId,
				issue_id: `issue-${executionId}`,
				issue_identifier: "FLY-2452",
				project_name: "flywheel",
				status: "running",
				started_at: startedAt,
				adapter_type: executionId === reviewExecution ? "codex-tmux" : vendor,
				worktree_path: fixture,
			});
			stateStore.bindWorktreeOnce(executionId, {
				path: fixture,
				branch: `fixture-${executionId}`,
				generation: `fixture-${executionId}`,
			});
		}

		const comm = new CommDB(commPath);
		for (const [executionId, vendor] of [
			[reviewExecution, "codex"],
			[claudeExecution, "claude-code"],
			[codexExecution, "codex"],
		] as const) {
			comm.registerSession(
				executionId,
				`window:${executionId}`,
				"flywheel",
				`issue-${executionId}`,
				"flywheel-eng-lead",
				vendor,
			);
		}
		const questionId = comm.insertQuestion(
			reviewExecution,
			"flywheel-eng-lead",
			"Review FLY-2452",
			{ checkpoint: "review_design", ttlSeconds: 3_600 },
		);
		comm.close();

		const resumedReview = deferred<ClaudeReviewOutcome>();
		const reviewRound = vi
			.fn<() => Promise<ClaudeReviewOutcome>>()
			.mockResolvedValueOnce({
				kind: "failed",
				reason: "nonzero_exit",
				detail: "claude exited 1",
				exitCode: 1,
				timedOut: false,
				raw: DISABLED_RAW,
			})
			.mockImplementationOnce(async () => resumedReview.promise);
		coordinator = new ReviewRequestCoordinator({
			store: stateStore,
			commDbPathFor: () => commPath,
			openCommDb: (path) => new CommDB(path, false),
			reviewRound,
			now: () => clock,
			writeQuotaWitness: (witness) => writeQuotaWitness(witnessPath, witness),
			wakeQuotaDaemon: vi.fn(() => "signaled"),
			setTimer: vi.fn(),
			quotaAutoRetryEnabled: () => true,
			alertLead: vi.fn(),
			emitReviewAlert: vi.fn(async () => undefined),
			markGateAnswered: vi.fn(),
			logger: vi.fn(),
		});

		await expect(
			coordinator.accept({
				executionId: reviewExecution,
				requestId: "disabled-review-r1",
				reviewType: "design",
				questionId,
			}),
		).resolves.toMatchObject({ accepted: true, duplicate: false });
		await waitFor(() =>
			expect(stateStore?.getCodexReviewJob("disabled-review-r1")).toMatchObject(
				{
					status: "failed",
					retry_trigger: "account_switch",
				},
			),
		);
		expect(existsSync(witnessPath)).toBe(true);

		clock += 1_000;
		const switchAlerts: Array<{ kind: string; body: string }> = [];
		const alertInvocations: Array<{
			args: string[];
			channel: string | undefined;
		}> = [];
		const deliverSwitchAlert = async (alert: {
			kind: string;
			severity: "info" | "warning" | "severe";
			title: string;
			body: string;
			signature: string;
		}) => {
			switchAlerts.push({ kind: alert.kind, body: alert.body });
			return sendQuotaMonitorAlert(alert, {
				binPath: join(fixture!, "fake-lead-alert"),
				env: {
					FLYWHEEL_PROJECTS_FILE: projectsPath,
					FLYWHEEL_NOTIFY_CHANNEL: "777777777777777777",
					FLYWHEEL_QUOTA_ALERT_SEVERE_CHANNEL_ID: "",
				},
				readLeadAlertChannel: (project, leadId) => {
					const projects = JSON.parse(
						readFileSync(projectsPath, "utf8"),
					) as Array<{
						projectName: string;
						leads: Array<{ agentId: string; alertChannel?: string }>;
					}>;
					return projects
						.find((entry) => entry.projectName === project)
						?.leads.find((lead) => lead.agentId === leadId)?.alertChannel;
				},
				execFile: async (_file, args, options) => {
					alertInvocations.push({
						args,
						channel: options.env?.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID,
					});
					return { stdout: "sent\n", stderr: "" };
				},
			});
		};
		const profileDeps = makeClaudeProfileSwitchDeps({
			binPath: join(fixture, "unused-profile-cli"),
			poolDir,
			storePath: accountPath,
			lockPath,
			claudeJsonPath,
			quotaPreverified: true,
			deliverNotification: deliverSwitchAlert,
		});
		const runtime = makeQuotaMonitorRuntime({
			now: () => clock,
			paths: {
				poolDir,
				configPath,
				statePath,
				storePath: accountPath,
				cachePath,
				lockPath,
				claudeJsonPath,
				confirmationEvidenceDir: join(fixture, "confirmations"),
			},
			reconcileMachine: async () => ({
				ok: true,
				outcome: "already_consistent",
				exitCode: 0,
				detail: "",
			}),
			readKeychainCredential: async () => ({
				accessToken: "disabled-token",
				expiresAt: clock + 3_600_000,
			}),
			fetchUsage: async (token) =>
				token === "disabled-token"
					? {
							error: "forbidden" as const,
							errorCode: "oauth_not_allowed_for_organization",
						}
					: usageResult(5, 5),
			fetchIdentity: async () => ({
				email: "personal1@example.com",
				uuid: "uuid-personal1",
				subscription: {
					status: "canceled",
					organizationType: "claude_max",
				},
			}),
			verifyCandidate: async () => ({
				fresh: "refreshed",
				expiresAt: clock + 3_600_000,
			}),
			switchAccount: (input: SwitchInput) =>
				executeAccountSwitch(input, {
					...profileDeps,
					applyProfile: async () => ({
						identitySynced: true,
						identityChecks: [],
					}),
				}),
			tmux: {
				listPanes: async () => [],
				capturePane: async () => "",
				sendContinue: async () => ({ sent: true }),
			},
			alert: deliverSwitchAlert,
		});

		await expect(runtime.tick()).resolves.toMatchObject({
			outcome: "switched",
		});
		const switchedStore = readStore(accountPath);
		expect(switchedStore).toMatchObject({
			generation: 2,
			activeAccount: "business",
			lastSwitch: {
				generation: 2,
				triggerKind: "account_dead",
				from: "personal1",
				to: "business",
			},
		});
		expect(
			switchedStore.accounts.find((account) => account.name === "personal1"),
		).toMatchObject({
			unavailable: {
				reason: "usage_forbidden:oauth_not_allowed_for_organization",
				markedBy: "quota-monitor",
			},
		});
		expect(switchAlerts.map((alert) => alert.kind)).toEqual([
			"account_switched",
			"account_dead",
		]);
		expect(switchAlerts[1]?.body).toMatch(/^account_dead:personal1/);
		expect(alertInvocations[1]).toMatchObject({
			args: expect.arrayContaining([
				"--lead",
				"quota-monitor",
				"--kind",
				"account_dead",
			]),
			channel: "888888888888888888",
		});
		expect(switchedStore.pendingSwitchNotifications).toEqual([]);

		const consumer = createAccountSwitchConsumer({
			store: stateStore,
			readStore: () => readStore(accountPath),
			commDbPathFor: () => commPath,
			coordinator,
			sweepEnabled: () => true,
			now: () => clock,
			log: vi.fn(),
		});
		await consumer.tick();
		await waitFor(() =>
			expect(stateStore?.getCodexReviewJob("disabled-review-r1")?.status).toBe(
				"running",
			),
		);

		const after = new CommDB(commPath, false);
		try {
			expect(after.getUnreadInstructions(claudeExecution)).toEqual([
				expect.objectContaining({
					id: "account-switch-wake:g2:claude-qa",
					content: WAKE_TEXT("personal1", "business"),
				}),
			]);
			expect(after.getUnreadInstructions(codexExecution)).toEqual([]);
			expect(after.getUnreadInstructions(reviewExecution)).toEqual([]);
		} finally {
			after.close();
		}
		expect(
			stateStore.getAccountSwitchActionReceipt(2, "review_redrive"),
		).toMatchObject({ status: "completed", outcome: { requeued: 1 } });
		expect(
			stateStore.getAccountSwitchActionReceipt(2, "wake_sweep"),
		).toMatchObject({ status: "completed", outcome: { sent: 1 } });

		resumedReview.resolve({
			kind: "verdict",
			verdict: "APPROVED",
			findings: [],
			reviewedHeadSha: null,
			raw: "",
		});
		await waitFor(() =>
			expect(stateStore?.getCodexReviewJob("disabled-review-r1")?.status).toBe(
				"done",
			),
		);
		expect(reviewRound).toHaveBeenCalledTimes(2);
	});
});
