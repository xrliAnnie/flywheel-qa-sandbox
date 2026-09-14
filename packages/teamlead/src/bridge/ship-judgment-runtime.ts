import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ProjectEntry } from "../ProjectConfig.js";
import { resolveLeadForIssue } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import {
	canonicalDigest,
	type OpinionCandidate,
	repositorySlugSchema,
} from "../ship-judgment/contract.js";
import { discordId } from "../ship-judgment/discord-message.js";
import {
	scanJudgmentMessages,
	scanLearningMessages,
} from "../ship-judgment/discord-scan.js";
import { writeJudgmentMessage } from "../ship-judgment/discord-transport.js";
import { GithubProjectApi } from "../ship-judgment/github-api.js";
import { sendJudgmentHistory } from "../ship-judgment/history-sender.js";
import { sendLearningMessage } from "../ship-judgment/learning-sender.js";
import { writeLearningMessage } from "../ship-judgment/learning-transport.js";
import { collectProductionJudgment } from "../ship-judgment/production-collect.js";
import { SharedProjectRefresh } from "../ship-judgment/project-refresh.js";
import { ShipJudgmentRuntime } from "../ship-judgment/runtime.js";
import { sendJudgmentOpinion } from "../ship-judgment/sender.js";
import { evaluateSubscription } from "../ship-judgment/subscription-evaluator.js";
import type {
	RecordUrlClassificationOptions,
	StrengthTwoReportRegistry,
} from "./strength-two-probes.js";

export function createShipJudgmentBridgeRuntime(deps: {
	store: StateStore;
	projects: ProjectEntry[];
	mode(): string;
	linearApiKey?: string;
	defaultBotToken?: string;
	guildId?: string;
	registry: Pick<StrengthTwoReportRegistry, "readReportHtml">;
	hosting: RecordUrlClassificationOptions;
	token(signal: AbortSignal): Promise<string>;
	modelBin(): string;
	onError(code: string): void;
}): ShipJudgmentRuntime | undefined {
	const project = deps.projects.find(
		(project) => project.projectName === "flywheel",
	);
	if (!project) return undefined;
	const context = (questionId: string) => {
		const holder =
			deps.store.getCurrentWorkflowGateHolderByQuestionId(questionId);
		if (!holder) return undefined;
		const run = deps.store.getWorkflowRun(holder.run_id);
		if (!run || run.project_name !== "flywheel") return undefined;
		const lead = resolveLeadForIssue(
			deps.projects,
			"flywheel",
			deps.store.getSessionLabels(holder.source_execution_id),
		);
		if (lead.matchMethod !== "label") return undefined;
		const channelId = lead.lead.chatChannel;
		const binding = deps.store.readShipJudgmentBinding(questionId, channelId);
		return binding
			? {
					channelId,
					binding,
					botUserId: lead.lead.botUserId,
					botToken: lead.lead.botToken ?? deps.defaultBotToken,
				}
			: undefined;
	};
	const historyContext = (questionId: string) => {
		const holder = deps.store.getWorkflowGateHolderByQuestionId(questionId);
		if (!holder) return undefined;
		const run = deps.store.getWorkflowRun(holder.run_id);
		if (run?.project_name !== "flywheel") return undefined;
		const lead = resolveLeadForIssue(
			deps.projects,
			"flywheel",
			deps.store.getSessionLabels(holder.source_execution_id),
		);
		if (lead.matchMethod !== "label") return undefined;
		const thread = deps.store.getChatThreadByIssue(
			run.issue_id,
			lead.lead.chatChannel,
		);
		const botToken = lead.lead.botToken ?? deps.defaultBotToken,
			botUserId = lead.lead.botUserId;
		return thread && botToken && botUserId
			? { threadId: thread.thread_id, botToken, botUserId }
			: undefined;
	};
	let refresh: SharedProjectRefresh | undefined,
		configurationDigest: string | undefined;
	const latest = new Map<string, OpinionCandidate["mechanical"]>();
	const unknown = (reason: string): OpinionCandidate["mechanical"] => ({
		verdict: "undetermined",
		reason,
		digest: canonicalDigest({ reason }),
		checkedAt: new Date().toISOString(),
		scope: "main合并＋目标分支合并＋同项目在飞文件",
		checkedRepos: 0,
		openPrCount: null,
		overlaps: [],
	});
	const remember = (
		questionId: string,
		mechanical: OpinionCandidate["mechanical"],
	) => {
		latest.delete(questionId);
		latest.set(questionId, mechanical);
		while (latest.size > 200) latest.delete(latest.keys().next().value!);
	};
	const offer = (
		questionId: string,
		inputId: string | null,
		reason: string,
	) => {
		if (deps.mode() !== "dry_run") return;
		const current = context(questionId);
		if (!current) return;
		const mechanical = latest.get(questionId) ?? unknown(reason);
		deps.store.getShipJudgmentOpinions().offer(
			{
				questionId,
				channelId: current.channelId,
				bindingDigest: canonicalDigest(current.binding),
				inputId,
				reason,
				mechanical,
			},
			Date.now(),
		);
	};
	const senderOwner = `sender:${randomUUID()}`;
	return new ShipJudgmentRuntime({
		store: deps.store,
		owner: `bridge:${randomUUID()}`,
		mode: deps.mode,
		onError: deps.onError,
		learningSweep: async (signal) => {
			const delivery = deps.store.getShipJudgmentLearningDelivery(deps.mode);
			let attempted = 0;
			for (const work of delivery.work(Date.now())) {
				if (signal.aborted || attempted >= 2) return;
				const owner = historyContext(work.questionId);
				if (!owner || !discordId.safeParse(deps.guildId).success) {
					delivery.defer(
						work.purpose,
						work.subjectId,
						"learning_owner_or_guild_missing",
						Date.now(),
					);
					continue;
				}
				const result = await sendLearningMessage(
					work.purpose,
					work.subjectId,
					senderOwner,
					{
						delivery,
						guildId: deps.guildId!,
						now: Date.now,
						signal,
						post: (claim, view, signal) =>
							writeLearningMessage({
								botToken: owner.botToken,
								botUserId: owner.botUserId,
								guildId: deps.guildId!,
								threadId: claim.threadId,
								replyTo: view.replyTo,
								content: view.content,
								canPost: () => {
									const current = historyContext(claim.questionId);
									return (
										current?.botUserId === owner.botUserId &&
										current?.botToken === owner.botToken &&
										deps.mode() !== "off" &&
										(claim.purpose === "ack" || deps.mode() === "dry_run")
									);
								},
								signal,
							}),
						scan: (claim, view, signal) =>
							scanLearningMessages({
								botToken: owner.botToken,
								botUserId: owner.botUserId,
								threadId: claim.threadId,
								marker: claim.marker,
								purpose: claim.purpose,
								since: view.since,
								signal,
							}),
					},
				);
				if (
					!["inactive", "busy", "rate_limited", "missing", "settled"].includes(
						result,
					)
				)
					attempted++;
			}
		},
		modeSweep: async (signal) => {
			const mode = deps.mode();
			if (mode !== "dry_run" && mode !== "auto" && mode !== "off") return;
			const delivery = deps.store.getShipJudgmentDelivery();
			delivery.setMode(mode, Date.now());
			if (mode === "dry_run") return;
			let attempted = 0;
			for (const questionId of delivery.historyWork()) {
				if (signal.aborted || deps.mode() !== mode) return;
				const owner = historyContext(questionId),
					since = delivery.scanSince(questionId);
				if (!owner || !since) {
					delivery.deferHistory(questionId, Date.now());
					continue;
				}
				if (attempted++ >= 2) break;
				await sendJudgmentHistory(questionId, senderOwner, {
					delivery,
					signal,
					now: Date.now,
					enabled: () => deps.mode() === mode,
					owns: (view) => {
						const next = historyContext(questionId);
						return (
							!!next &&
							next.threadId === view.threadId &&
							next.botUserId === owner.botUserId &&
							next.botToken === owner.botToken
						);
					},
					patch: (view, messageId, content, signal) =>
						writeJudgmentMessage({
							...owner,
							cardMessageId: view.cardMessageId,
							messageId,
							content,
							signal,
						}),
					scan: (view, signal) =>
						scanJudgmentMessages({
							...owner,
							marker: view.marker,
							since,
							signal,
						}),
				});
			}
		},
		deliver: async (questionId, signal) => {
			const current = context(questionId);
			if (!current?.botToken || !current.botUserId) return;
			const delivery = deps.store.getShipJudgmentDelivery();
			const since = delivery.scanSince(questionId);
			if (!since) return;
			const credentials = {
				botToken: current.botToken,
				botUserId: current.botUserId,
			};
			await sendJudgmentOpinion(questionId, current.channelId, senderOwner, {
				delivery,
				signal,
				enabled: () => deps.mode() === "dry_run",
				current: () => {
					const next = context(questionId);
					return next?.botUserId === credentials.botUserId &&
						next?.botToken === credentials.botToken
						? next.binding
						: undefined;
				},
				now: Date.now,
				legacySummary: () => delivery.legacySummary(questionId),
				post: (view, content, signal) =>
					writeJudgmentMessage({
						...credentials,
						threadId: view.threadId,
						cardMessageId: view.cardMessageId,
						content,
						signal,
					}),
				patch: (view, messageId, content, signal) =>
					writeJudgmentMessage({
						...credentials,
						threadId: view.threadId,
						cardMessageId: view.cardMessageId,
						messageId,
						content,
						signal,
					}),
				scan: (view, signal) =>
					scanJudgmentMessages({
						...credentials,
						threadId: view.threadId,
						marker: view.marker,
						since,
						signal,
					}),
			});
		},
		stopSources: async () => {
			await refresh?.stop();
		},
		collect: async (questionId, signal) => {
			const current = context(questionId);
			if (!current)
				return { status: "undetermined", reason: "binding_missing" };
			const slug = repositorySlugSchema.safeParse(project.projectRepo);
			const repositories = slug.success
				? deps.store.readShipJudgmentRepositories(slug.data)
				: undefined;
			if (!repositories || !deps.linearApiKey) {
				remember(questionId, unknown("project_sources_unavailable"));
				return {
					status: "undetermined",
					reason: "project_sources_unavailable",
				};
			}
			const digest = canonicalDigest(repositories);
			if (!refresh || configurationDigest !== digest) {
				await refresh?.stop();
				if (signal.aborted)
					return { status: "undetermined", reason: "collection_aborted" };
				refresh = new SharedProjectRefresh(
					deps.store.getShipJudgmentProjectRefresh(),
					new GithubProjectApi(
						repositories.map((repo) => repo.repo_slug),
						deps.token,
					),
				);
				configurationDigest = digest;
			}
			const plans = current.binding.targets.filter((target) =>
				deps.store.readShipJudgmentPlanReference(
					current.binding.runId,
					target.repo_identity,
				),
			);
			if (plans.length !== 1) {
				remember(questionId, unknown("reviewed_plan_ambiguous"));
				return { status: "undetermined", reason: "reviewed_plan_ambiguous" };
			}
			const result = await collectProductionJudgment(
				questionId,
				current.channelId,
				{
					source: {
						store: deps.store,
						linearApiKey: deps.linearApiKey,
						planRepoIdentity: plans[0]!.repo_identity,
						registry: deps.registry,
						hosting: deps.hosting,
					},
					repositories,
					refresh,
					mergeCache: deps.store.getShipJudgmentProjectRefresh(),
					currentSnapshot: () =>
						deps.store.getShipJudgmentProjectRefresh().read(Date.now()),
					token: deps.token,
				},
				signal,
			);
			remember(questionId, result.mechanical);
			return result.collection;
		},
		evaluate: (packet, signal) =>
			evaluateSubscription(packet, { bin: deps.modelBin(), signal }),
		material: (inputId) => {
			const input = deps.store.getShipJudgmentInputs().get(inputId);
			if (input) offer(input.questionId, inputId, "three_point_dry_run");
		},
		unavailable: (questionId, reason) => offer(questionId, null, reason),
	});
}

/** Resolve host GitHub authentication without putting credentials in argv or logs. */
export async function readShipJudgmentGithubToken(
	signal: AbortSignal,
): Promise<string> {
	signal.throwIfAborted();
	const configured = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
	if (configured && !/[\r\n]/.test(configured)) return configured;
	return new Promise((resolve, reject) => {
		execFile(
			"gh",
			["auth", "token", "--hostname", "github.com"],
			{
				encoding: "utf8",
				signal,
				timeout: 20_000,
				killSignal: "SIGKILL",
				maxBuffer: 8192,
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
					GH_PROMPT_DISABLED: "1",
				},
			},
			(error, stdout) => {
				const token = stdout?.trim();
				if (error || !token || /[\r\n]/.test(token))
					reject(new Error("github_auth_unavailable"));
				else resolve(token);
			},
		);
	});
}
