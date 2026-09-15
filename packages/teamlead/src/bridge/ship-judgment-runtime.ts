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
import {
	buildEvidenceLedger,
	type EvidenceLedger,
	type JudgmentMaterials,
} from "../ship-judgment/evidence-ledger.js";
import { GithubProjectApi } from "../ship-judgment/github-api.js";
import { sendJudgmentHistory } from "../ship-judgment/history-sender.js";
import { sendLearningMessage } from "../ship-judgment/learning-sender.js";
import { writeLearningMessage } from "../ship-judgment/learning-transport.js";
import { readAuthorityMaterials } from "../ship-judgment/materials.js";
import { collectProductionJudgment } from "../ship-judgment/production-collect.js";
import { SharedProjectRefresh } from "../ship-judgment/project-refresh.js";
import { ShipJudgmentRuntime } from "../ship-judgment/runtime.js";
import { sendJudgmentOpinion } from "../ship-judgment/sender.js";
import { evaluateSubscription } from "../ship-judgment/subscription-evaluator.js";
import type {
	RecordUrlClassificationOptions,
	StrengthTwoReportRegistry,
} from "./strength-two-probes.js";

type InputPreflight =
	| {
			status: "ready";
			reason: "evidence_complete";
			repositories: { repo_identity: string; repo_slug: string }[];
	  }
	| { status: "unavailable"; reason: string };

/** Read-only checks; never expose credential values or provider error messages. */
export async function preflightShipJudgmentInputs(
	deps: {
		projectRepo?: string;
		linearApiKey?: string;
		repositories(
			slug: string,
		): { repo_identity: string; repo_slug: string }[] | undefined;
		token(signal: AbortSignal): Promise<string>;
	},
	signal: AbortSignal,
): Promise<InputPreflight> {
	const unavailable = (reason: string): InputPreflight => ({
		status: "unavailable",
		reason,
	});
	const slug = repositorySlugSchema.safeParse(deps.projectRepo);
	if (!slug.success) return unavailable("repository_slug_invalid");
	let repositories: { repo_identity: string; repo_slug: string }[] | undefined;
	try {
		repositories = deps.repositories(slug.data.toLowerCase());
	} catch {
		return unavailable("repositories_unavailable");
	}
	if (!repositories?.length) return unavailable("repositories_unavailable");
	if (!deps.linearApiKey?.trim())
		return unavailable("linear_credentials_missing");
	const controller = new AbortController();
	const bound = AbortSignal.any([signal, controller.signal]);
	const timeout = setTimeout(() => controller.abort(), 20_000);
	let onAbort: () => void = () => {};
	try {
		bound.throwIfAborted();
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(new Error("input_preflight_aborted"));
			bound.addEventListener("abort", onAbort, { once: true });
		});
		const token = await Promise.race([deps.token(bound), aborted]);
		if (!token.trim()) return unavailable("github_credentials_unavailable");
		return { status: "ready", reason: "evidence_complete", repositories };
	} catch {
		return unavailable("github_credentials_unavailable");
	} finally {
		clearTimeout(timeout);
		bound.removeEventListener("abort", onAbort);
		controller.abort();
	}
}

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
	const inputAbort = new AbortController();
	let latestInput: InputPreflight | undefined;
	let inputFlight: Promise<InputPreflight> | undefined;
	const checkInputs = (signal: AbortSignal): Promise<InputPreflight> => {
		if (inputFlight) return inputFlight;
		inputFlight = preflightShipJudgmentInputs(
			{
				projectRepo: project.projectRepo,
				linearApiKey: deps.linearApiKey,
				repositories: (slug) => deps.store.readShipJudgmentRepositories(slug),
				token: deps.token,
			},
			AbortSignal.any([signal, inputAbort.signal]),
		)
			.then((result) => {
				if (
					result.status === "unavailable" &&
					(latestInput?.status !== result.status ||
						latestInput.reason !== result.reason)
				) {
					deps.onError(`input_unavailable:${result.reason}`);
				}
				latestInput = result;
				return result;
			})
			.finally(() => {
				inputFlight = undefined;
			});
		return inputFlight;
	};
	// Startup diagnostics run even when there are no cards, but off/auto do no source I/O.
	if (deps.mode() === "dry_run") void checkInputs(inputAbort.signal);
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
	const latest = new Map<
		string,
		{
			mechanical: OpinionCandidate["mechanical"];
			evidence?: EvidenceLedger;
			bindingDigest: string;
		}
	>();
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
		materials?: JudgmentMaterials,
	) => {
		const current = context(questionId);
		if (!current) {
			latest.delete(questionId);
			return;
		}
		let evidence: EvidenceLedger | undefined;
		try {
			const raw =
				materials ??
				readAuthorityMaterials(
					deps.store,
					current.binding,
					mechanical,
					new Date().toISOString(),
				);
			if (!materials)
				raw.input = {
					status: "unavailable",
					reason: mechanical.reason
						.replace(/^input_unavailable:/, "")
						.slice(0, 64),
				};
			evidence = buildEvidenceLedger(raw, current.binding);
		} catch (error) {
			const code =
				error instanceof Error && error.message.includes("ledger_budget")
					? "evidence_budget_exceeded"
					: "evidence_invalid";
			deps.onError(`input_unavailable:${code}`);
			mechanical = unknown(`input_unavailable:${code}`);
		}
		latest.delete(questionId);
		latest.set(questionId, {
			mechanical,
			evidence,
			bindingDigest: canonicalDigest(current.binding),
		});
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
		if (
			latest.get(questionId)?.bindingDigest !== canonicalDigest(current.binding)
		)
			remember(questionId, unknown(reason));
		const record = latest.get(questionId);
		const mechanical = record?.mechanical ?? unknown(reason);
		deps.store.getShipJudgmentOpinions().offer(
			{
				questionId,
				channelId: current.channelId,
				bindingDigest: canonicalDigest(current.binding),
				inputId,
				reason,
				mechanical,
				...(record?.evidence ? { evidence: record.evidence } : {}),
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
			inputAbort.abort();
			await inputFlight;
			await refresh?.stop();
		},
		collect: async (questionId, signal) => {
			const current = context(questionId);
			if (!current)
				return { status: "undetermined", reason: "binding_missing" };
			const input = await checkInputs(signal);
			if (
				input.status === "unavailable" &&
				input.reason !== "linear_credentials_missing"
			) {
				const reason = `input_unavailable:${input.reason}`;
				remember(questionId, unknown(reason));
				return {
					status: "undetermined",
					reason,
				};
			}
			const repositories =
				input.status === "ready"
					? input.repositories
					: deps.store.readShipJudgmentRepositories(project.projectRepo ?? "");
			if (!repositories?.length) {
				remember(
					questionId,
					unknown("input_unavailable:repositories_unavailable"),
				);
				return {
					status: "undetermined",
					reason: "input_unavailable:repositories_unavailable",
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
			const aliases = deps.store.readShipJudgmentIssueAliases(
				current.binding.runId,
			);
			const plans = current.binding.targets.filter(
				(target) =>
					deps.store.readShipJudgmentDesignApproval(
						current.binding.issueId,
						aliases,
						target.repo_identity,
					)?.status === "approved",
			);
			const result = await collectProductionJudgment(
				questionId,
				current.channelId,
				{
					source: {
						store: deps.store,
						linearApiKey: deps.linearApiKey ?? "",
						planRepoIdentity: plans.length === 1 ? plans[0]!.repo_identity : "",
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
			if (input.status === "unavailable")
				result.materials.input = {
					status: "unavailable",
					reason: input.reason,
				};
			remember(questionId, result.mechanical, result.materials);
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
