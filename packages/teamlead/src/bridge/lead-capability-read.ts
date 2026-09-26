import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LinearClient } from "@linear/sdk";
import type { Octokit } from "@octokit/rest";
import { type Application, Router } from "express";
import { CommDB } from "flywheel-comm/db";
import { forwardedLeadAuthorizationEnv } from "flywheel-comm/lead-lease";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import type { TerminalSessionCoreOptions } from "flywheel-comm/terminal-observation";
import type { MemoryService } from "flywheel-edge-worker";
import { z } from "zod";
import { DepartmentRegistry } from "../department-registry.js";
import { getLeadCapability } from "../lead-capabilities/catalog.js";
import { PATROL_SNAPSHOT_SERVER_TIMEOUT_MS } from "../lead-capabilities/patrol-timeouts.js";
import type { OperationReceiptStore } from "../lead-capabilities/receipts.js";
import { linearRequestFromClient } from "../patrol-root-causes.js";
import type { Session, StateStore } from "../StateStore.js";
import { commDbPathForProject } from "./commdb-path.js";
import { captureLeadCapabilityScope } from "./lead-capability-scope.js";
import { createLeadTerminalCore } from "./lead-capability-terminal-core.js";
import type { LeadEventDeliveryCoordinator } from "./lead-event-delivery.js";
import { executeLeadGithubWrite } from "./lead-github-write.js";
import { executeLeadInboxBatchAck } from "./lead-inbox-batch-ack.js";
import { executeLeadInboxEventAck } from "./lead-inbox-event-ack.js";
import { executeLeadMemoryAdd } from "./lead-memory.js";
import { recordLeadPatrolJudgment } from "./lead-patrol-judgment.js";
import { registerLeadPatrolSnapshot } from "./lead-patrol-registration.js";
import type { executeLeadPatrolSnapshot } from "./lead-patrol-snapshot.js";
import { executeLeadTerminalInput } from "./lead-terminal-input.js";
import {
	createLeadTerminalInputIo,
	createLeadTerminalReadIo,
} from "./lead-terminal-read-io.js";
import { renderPatrolRootCauses } from "./patrol-root-cause-route.js";

const envelopeSchema = z
	.object({
		schemaVersion: z.literal(1),
		operationId: z.enum([
			"memory.add",
			"memory.search",
			"github.pr.comment",
			"github.pr.edit",
			"github.pr.review",
			"github.pr.ready",
			"github.run.rerun",
			"patrol.snapshot",
			"patrol.judgment.record",
			"bridge.read",
			"terminal.capture",
			"terminal.search",
			"terminal.status",
			"terminal.list",
			"terminal.input",
			"inbox.batch.ack",
			"inbox.event.ack",
		]),
		requestId: z.string().uuid(),
		projectName: z.string().min(1).max(128),
		leadId: z.string().min(1).max(128),
		identityDigest: z.string().regex(/^[a-f0-9]{64}$/),
		carrierClaim: z.string().min(1).max(256),
		activationId: z.string().min(1).max(128),
		input: z.unknown(),
		githubFacts: z.unknown().optional(),
	})
	.strict();
export interface LeadCapabilityReadOptions {
	apiToken: string;
	memoryService?: Pick<MemoryService, "addMessages" | "searchLearningMemories">;
	github?:
		| { client: Octokit; secrets: readonly string[] }
		| (() => { client: Octokit; secrets: readonly string[] });
	patrol?: Pick<
		Parameters<typeof executeLeadPatrolSnapshot>[0],
		| "deploymentRoot"
		| "helperPins"
		| "nodePath"
		| "stateDir"
		| "activationRoot"
		| "tmuxSocketPath"
	> & { source: { path: string; sha256: string } };
	eventCoordinator?: () => LeadEventDeliveryCoordinator | undefined;
	terminalReceipts?: OperationReceiptStore;
	terminalIo?: Pick<TerminalSessionCoreOptions, "inspect" | "capture" | "send">;
	store: StateStore;
	projectsPath?: string;
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	linearClient?: LinearClient;
	shutdownStateHolder?: { shuttingDown: boolean };
}
const denied = () => new Error("bridge_read_scope_denied");
/** Narrow server-owned read projection. No model-selected URL, method or headers. */
export function createLeadCapabilityReadRouter(
	options: LeadCapabilityReadOptions,
	inputOnly:
		| boolean
		| "github"
		| "inbox.batch.ack"
		| "inbox.event.ack"
		| "patrol.snapshot"
		| "patrol.judgment.record"
		| "memory.add" = false,
	receiptOnly = false,
): Router {
	const writeOperation =
		inputOnly === true ? "terminal.input" : inputOnly || undefined;
	const router = Router();
	let active = 0;
	router.post("/", async (req, res) => {
		const supplied = Buffer.from(req.headers.authorization ?? ""),
			expected = Buffer.from(`Bearer ${options.apiToken}`);
		if (
			!options.apiToken ||
			supplied.length !== expected.length ||
			!timingSafeEqual(supplied, expected)
		) {
			res.status(401).json({ status: "rejected", errorCode: "unauthorized" });
			return;
		}
		const parsed = envelopeSchema.safeParse(req.body),
			definition = parsed.success
				? getLeadCapability(parsed.data.operationId)
				: undefined;
		if (
			!parsed.success ||
			!definition ||
			(writeOperation
				? writeOperation === "github"
					? definition.githubTier !== "B"
					: parsed.data.operationId !== writeOperation
				: definition.classification === "write" ||
					parsed.data.operationId.startsWith("patrol.")) ||
			(parsed.data.githubFacts !== undefined &&
				parsed.data.operationId !== "patrol.snapshot") ||
			Buffer.byteLength(JSON.stringify(req.body)) > 65536
		) {
			res
				.status(400)
				.json({ status: "rejected", errorCode: "invalid_request" });
			return;
		}
		const body = parsed.data,
			input = definition.inputSchema.safeParse(body.input);
		if (!input.success) {
			res.status(400).json({ status: "rejected", errorCode: "invalid_input" });
			return;
		}
		if (active >= 16) {
			res.status(503).json({
				requestId: body.requestId,
				status: "unknown",
				resourceRefs: [],
				errorCode: "read_capacity",
			});
			return;
		}
		active++;
		const controller = new AbortController(),
			abort = () => controller.abort(),
			onClose = () => {
				if (!res.writableEnded) abort();
			};
		req.once("aborted", abort);
		res.once("close", onClose);
		const timer = setTimeout(
			abort,
			body.operationId === "patrol.snapshot"
				? PATROL_SNAPSHOT_SERVER_TIMEOUT_MS
				: 15_000,
		);
		try {
			const env = options.env ?? process.env,
				home = options.homeDir ?? env.HOME ?? homedir(),
				projectsPath =
					options.projectsPath ??
					env.FLYWHEEL_PROJECTS_FILE ??
					join(home, ".flywheel/projects.json");
			const claimEnv = forwardedLeadAuthorizationEnv(
				{
					claimedLeadId: body.leadId,
					projectName: body.projectName,
					identityDigest: body.identityDigest,
					carrierClaim: body.carrierClaim,
				},
				{ ...env, HOME: home, FLYWHEEL_PROJECTS_FILE: projectsPath },
			);
			const initial = captureLeadCapabilityScope({
				projectsPath,
				homeDir: home,
				projectName: body.projectName,
				leadId: body.leadId,
				identityDigest: body.identityDigest,
				claimEnv,
				denied,
			});
			function current() {
				controller.signal.throwIfAborted();
				if (inputOnly && options.shutdownStateHolder?.shuttingDown)
					throw denied();
				initial.assertSourceCurrent();
				return initial;
			}
			const revision = JSON.stringify([initial.project.linear, initial.lead]);
			async function read<T>(promise: PromiseLike<T>): Promise<T> {
				let rejectAbort = () => {};
				const canceled = new Promise<never>((_resolve, reject) => {
					rejectAbort = () => reject(new Error("read_unavailable"));
					controller.signal.addEventListener("abort", rejectAbort, {
						once: true,
					});
					if (controller.signal.aborted) rejectAbort();
				});
				try {
					return await Promise.race([promise, canceled]);
				} finally {
					controller.signal.removeEventListener("abort", rejectAbort);
				}
			}
			function fresh() {
				const now = current();
				if (JSON.stringify([now.project.linear, now.lead]) !== revision)
					throw denied();
				return now;
			}
			async function inScope(session: Session) {
				const before = fresh();
				if (session.project_name !== body.projectName) return false;
				if (!options.linearClient || !before.project.linear)
					throw new Error("read_unavailable");
				const issue = await read(options.linearClient.issue(session.issue_id));
				fresh();
				if (
					!issue ||
					!session.issue_identifier ||
					issue.identifier !== session.issue_identifier
				)
					throw denied();
				const [team, project, labels] = await read(
					Promise.all([issue.team, issue.project, issue.labels()]),
				);
				const after = fresh();
				if (labels.pageInfo.hasNextPage) throw new Error("read_unavailable");
				if (
					team?.key !== after.project.linear?.team ||
					(after.project.linear?.project &&
						project?.name !== after.project.linear.project)
				)
					return false;
				return new DepartmentRegistry(after.projects).isLeadDepartmentMember(
					body.projectName,
					body.leadId,
					labels.nodes.map((label) => label.name),
				).allowed;
			}
			function projection(session: Session) {
				const latest = options.store.getSession(session.execution_id);
				if (
					!latest ||
					latest.issue_id !== session.issue_id ||
					latest.issue_identifier !== session.issue_identifier ||
					latest.project_name !== body.projectName
				)
					throw denied();
				return {
					executionId: latest.execution_id,
					issueIdentifier: latest.issue_identifier,
					status: latest.status,
					lastActivityAt: latest.last_activity_at ?? null,
				};
			}

			if (
				body.operationId === "memory.add" ||
				body.operationId === "memory.search"
			) {
				if (input.data.project !== body.projectName) throw denied();
				const secrets = [options.apiToken, body.carrierClaim].filter(Boolean);
				if (
					secrets.some((secret) => JSON.stringify(input.data).includes(secret))
				)
					throw denied();
				if (body.operationId === "memory.add") {
					if (!options.terminalReceipts || !options.memoryService)
						throw denied();
					const result = await executeLeadMemoryAdd({
						projectName: body.projectName,
						leadId: body.leadId,
						activationId: body.activationId,
						requestId: body.requestId,
						input: input.data,
						receipts: options.terminalReceipts,
						signal: controller.signal,
						secrets,
						receiptOnly,
						assertCurrent: async () => {
							fresh();
						},
						memory: options.memoryService,
					});
					res.json(result);
					return;
				}
				if (!options.memoryService) throw denied();
				const memories = await read(
					options.memoryService.searchLearningMemories({
						query: input.data.query as string,
						projectName: body.projectName,
						userId: body.projectName,
						limit: (input.data.limit as number | undefined) ?? 10,
					}),
				);
				fresh();
				const data = definition.outputSchema.parse({
					memories,
					receiptId: body.requestId,
					observedAt: new Date().toISOString(),
				});
				const encoded = JSON.stringify(data);
				if (
					Buffer.byteLength(encoded) > 250000 ||
					secrets.some((secret) => encoded.includes(secret))
				)
					throw denied();
				res.json({
					requestId: body.requestId,
					status: "succeeded",
					resourceRefs: [],
					data,
				});
				return;
			}
			if (writeOperation === "github") {
				if ((!receiptOnly && !options.github) || !options.terminalReceipts)
					throw denied();
				const github = receiptOnly
					? undefined
					: typeof options.github === "function"
						? options.github()
						: options.github;
				const comm = CommDB.openReadonly(
					commDbPathForProject(body.projectName, env),
				);
				try {
					const result = await executeLeadGithubWrite({
						store: options.store,
						comm,
						client: github?.client,
						projectName: body.projectName,
						leadId: body.leadId,
						activationId: body.activationId,
						operationId: body.operationId,
						requestId: body.requestId,
						input: input.data,
						receipts: options.terminalReceipts,
						secrets: [
							...(github?.secrets ?? []),
							options.apiToken,
							body.carrierClaim,
						],
						signal: controller.signal,
						receiptOnly,
						assertCurrent: () => {
							fresh();
						},
						repository: () => fresh().project.projectRepo ?? "",
					});
					res.json(result);
					return;
				} finally {
					comm.close();
				}
			}

			if (
				body.operationId === "patrol.snapshot" ||
				body.operationId === "patrol.judgment.record"
			) {
				if (!options.patrol || !options.terminalReceipts) throw denied();
				const scope = {
					projectName: body.projectName,
					leadId: body.leadId,
					activationId: body.activationId,
					requestId: body.requestId,
					receipts: options.terminalReceipts,
					receiptOnly,
					signal: controller.signal,
					secrets: [options.apiToken, body.carrierClaim],
				};
				const outcome =
					body.operationId === "patrol.snapshot"
						? await registerLeadPatrolSnapshot({
								...options.patrol,
								...scope,
								projectsPath,
								stateDbPath: options.store.getDbPath(),
								commDbPath: commDbPathForProject(body.projectName, env),
								tickId: input.data.tickId as string,
								githubFacts: body.githubFacts,
								rootCauses: () =>
									renderPatrolRootCauses(
										{
											store: options.store,
											linearRequest: () =>
												options.linearClient
													? linearRequestFromClient(options.linearClient)
													: undefined,
											stateDir: options.patrol!.stateDir,
										},
										body.projectName,
										body.leadId,
									),
								assertCurrent: async () => {
									fresh();
								},
							})
						: recordLeadPatrolJudgment({
								...options.patrol,
								...scope,
								input: input.data,
								rootCauseAsk: (askId) => options.store.getFounderAsk(askId),
								assertCurrent: () => {
									fresh();
								},
							});
				fresh();
				const json = JSON.stringify(outcome);
				if (
					Buffer.byteLength(json) > 1024 * 1024 + 16384 ||
					json.includes(options.apiToken) ||
					json.includes(body.carrierClaim)
				)
					throw denied();
				if (!res.destroyed && !res.writableEnded)
					res
						.status(
							outcome.status === "succeeded"
								? 200
								: outcome.status === "rejected"
									? 403
									: 503,
						)
						.type("application/json")
						.send(json);
				return;
			}
			if (body.operationId === "inbox.event.ack") {
				const coordinator = options.eventCoordinator?.();
				if (!coordinator || !options.terminalReceipts) throw denied();
				const result = await executeLeadInboxEventAck({
					receiptOnly,
					projectName: body.projectName,
					leadId: body.leadId,
					activationId: body.activationId,
					requestId: body.requestId,
					input: { eventHandle: input.data.eventHandle as string },
					receipts: options.terminalReceipts,
					signal: controller.signal,
					secrets: [options.apiToken, body.carrierClaim],
					assertCurrent: async () => {
						fresh();
					},
					coordinator,
				});
				if (!res.destroyed && !res.writableEnded)
					res
						.status(
							result.status === "succeeded"
								? 200
								: result.status === "rejected"
									? 403
									: 503,
						)
						.json(result);
				return;
			}
			if (body.operationId === "inbox.batch.ack") {
				if (!options.terminalReceipts) throw denied();
				const result = await executeLeadInboxBatchAck({
					receiptOnly,
					projectName: body.projectName,
					leadId: body.leadId,
					activationId: body.activationId,
					requestId: body.requestId,
					input: { batchId: input.data.batchId as string },
					receipts: options.terminalReceipts,
					signal: controller.signal,
					secrets: [options.apiToken, body.carrierClaim],
					assertCurrent: async () => {
						fresh();
					},
					queue: {
						ackBatchByRecipient: (ack) => {
							fresh();
							const queue = new MailboxQueue(
								commDbPathForProject(body.projectName, env),
							);
							try {
								fresh();
								return queue.ackBatchByRecipient(ack);
							} finally {
								queue.close();
							}
						},
					},
				});
				if (!res.destroyed && !res.writableEnded)
					res
						.status(
							result.status === "succeeded"
								? 200
								: result.status === "rejected"
									? 403
									: 503,
						)
						.json(result);
				return;
			}
			const request = input.data.request as {
				resource: string;
				executionId?: string;
				targetRepo?: string;
				headSha?: string;
				cursor?: string;
				limit?: number;
			};
			let result: unknown;
			let terminalOutput: Record<string, unknown> | undefined;
			if (body.operationId.startsWith("terminal.")) {
				const raw = input.data as {
					executionId?: string;
					lines?: number;
					pattern?: string;
					cursor?: string;
					limit?: number;
					expectedSessionId?: string;
					text?: string;
				};
				const dbPath = commDbPathForProject(body.projectName, env);
				if (body.operationId === "terminal.list") {
					const db = CommDB.openReadonly(dbPath);
					let candidates: ReturnType<CommDB["listLeadTerminalSessions"]>;
					try {
						candidates = db.listLeadTerminalSessions(
							body.projectName,
							body.leadId,
							raw.cursor ?? "",
							raw.limit ?? 20,
						);
					} finally {
						db.close();
					}
					const executions = [];
					for (const candidate of candidates) {
						const session = options.store.getSession(candidate.execution_id);
						if (
							!session ||
							(candidate.issue_id !== session.issue_id &&
								candidate.issue_id !== session.issue_identifier)
						)
							continue;
						if (!(await inScope(session))) continue;
						const latest = CommDB.openReadonly(dbPath);
						try {
							const row = latest.getSession(candidate.execution_id);
							if (JSON.stringify(row) !== JSON.stringify(candidate))
								throw denied();
						} finally {
							latest.close();
						}
						const projected = projection(session);
						executions.push({
							executionId: projected.executionId,
							status: candidate.status === "running" ? "running" : "completed",
						});
					}
					terminalOutput = {
						executions,
						nextCursor:
							candidates.length === (raw.limit ?? 20)
								? candidates.at(-1)!.execution_id
								: null,
					};
				} else {
					const executionId = raw.executionId!;
					let sideEffectsPossible = false;
					const io =
						options.terminalIo ??
						(inputOnly
							? createLeadTerminalInputIo(controller.signal, env)
							: createLeadTerminalReadIo(controller.signal, env));
					const core = createLeadTerminalCore({
						projectName: body.projectName,
						leadId: body.leadId,
						commDbPath: dbPath,
						store: options.store,
						assertCurrent: () => {
							fresh();
						},
						authorizeIssue: async (issueId) => {
							const session = options.store.getSession(executionId);
							if (
								!session ||
								session.issue_id !== issueId ||
								!(await inScope(session))
							)
								throw denied();
							return () => {
								fresh();
							};
						},
						...io,
						send: async (target, text, guard) => {
							await io.send(target, text, async () => {
								await guard();
								controller.signal.throwIfAborted();
								sideEffectsPossible = true;
							});
						},
					});
					if (body.operationId === "terminal.input") {
						if (!options.terminalReceipts) throw denied();
						const result = await executeLeadTerminalInput({
							receiptOnly,
							projectName: body.projectName,
							leadId: body.leadId,
							activationId: body.activationId,
							requestId: body.requestId,
							input: {
								executionId,
								expectedSessionId: raw.expectedSessionId!,
								text: raw.text!,
							},
							receipts: options.terminalReceipts,
							signal: controller.signal,
							secrets: [options.apiToken, body.carrierClaim],
							assertCurrent: async () => {
								fresh();
							},
							authorize: async () => {
								const session = options.store.getSession(executionId);
								if (!session || !(await inScope(session))) throw denied();
							},
							inputTerminal: () =>
								core.input(executionId, raw.expectedSessionId!, raw.text!),
							sideEffectsPossible: () => sideEffectsPossible,
						});
						if (!res.destroyed && !res.writableEnded)
							res
								.status(
									result.status === "succeeded"
										? 200
										: result.status === "rejected"
											? 403
											: 503,
								)
								.json(result);
						return;
					} else if (body.operationId === "terminal.status") {
						const observed = await core.status(executionId);
						terminalOutput = {
							execution: {
								executionId,
								status:
									observed.status === "waiting"
										? "waiting"
										: observed.status === "executing"
											? "running"
											: "unknown",
							},
							observedSessionId: observed.observedSessionId,
						};
					} else {
						const captured =
							body.operationId === "terminal.search"
								? await core.search(executionId, raw.lines!, raw.pattern!)
								: await core.capture(executionId, raw.lines!);
						terminalOutput = { executionId, ...captured };
					}
				}
			} else if (request.resource === "health")
				result = {
					resource: "health",
					status: options.shutdownStateHolder
						? options.shutdownStateHolder.shuttingDown
							? "draining"
							: "ready"
						: "unknown",
				};
			else if (request.resource === "admission.status") {
				const pause = options.store.getAdmissionPause();
				result = {
					resource: "admission.status",
					active: pause?.active ?? false,
					remainingSeconds: pause?.remainingSeconds ?? 0,
				};
			} else if (request.resource === "session.status") {
				const session = options.store.getSession(request.executionId!);
				if (!session || !(await inScope(session))) throw denied();
				fresh();
				result = { resource: request.resource, session: projection(session) };
			} else if (request.resource === "session.code-review") {
				const session = options.store.getSession(request.executionId!);
				if (!session || !(await inScope(session))) throw denied();
				fresh();
				const scoped = projection(session);
				const record = options.store.getCodexReviewRecord(
					scoped.executionId,
					request.targetRepo!,
					request.headSha!,
				);
				if (
					record &&
					(record.execution_id !== scoped.executionId ||
						record.issue_id !== session.issue_id ||
						record.project_name !== body.projectName ||
						record.target_repo_identity !== request.targetRepo ||
						record.target_pr_head_sha !== request.headSha)
				)
					throw denied();
				// A durable record is evidence, not the effective review/ship gate verdict.
				result = {
					resource: request.resource,
					executionId: scoped.executionId,
					targetRepo: request.targetRepo,
					headSha: request.headSha,
					record: record
						? {
								status: record.status,
								authorFamily: record.author_family ?? null,
								reviewerFamily: record.reviewer_family ?? null,
								rounds: record.rounds ?? null,
								approvedAt: record.approved_at ?? null,
							}
						: null,
				};
			} else if (request.resource === "session.resident-hold") {
				const session = options.store.getSession(request.executionId!);
				if (!session || !(await inScope(session))) throw denied();
				fresh();
				const scopedSession = projection(session);
				const hold = options.store.getResidentHold(scopedSession.executionId);
				result = {
					resource: request.resource,
					executionId: session.execution_id,
					hold: hold
						? {
								nodeId: hold.node_id,
								state: hold.state,
								revision: hold.revision,
								graceStartedAt: hold.grace_started_at,
								graceExpiresAt: hold.grace_expires_at,
								releaseCause: hold.release_cause,
							}
						: null,
				};
			} else if (request.resource === "sessions.list") {
				const candidates = options.store
					.getActiveSessions()
					.filter((session) => session.project_name === body.projectName)
					.sort((a, b) => a.execution_id.localeCompare(b.execution_id));
				if (candidates.length > 1000) throw new Error("read_unavailable");
				const offset = Number(request.cursor ?? 0),
					limit = request.limit ?? 20;
				if (offset > candidates.length) throw denied();
				const sessions = [];
				let index = offset;
				while (index < candidates.length && sessions.length < limit) {
					const session = candidates[index++]!;
					if (await inScope(session)) sessions.push(projection(session));
				}
				fresh();
				result = {
					resource: request.resource,
					sessions,
					nextCursor: index < candidates.length ? String(index) : null,
				};
			} else throw denied();
			current();
			const output = definition.outputSchema.parse({
				...(terminalOutput ?? { result }),
				receiptId: body.requestId,
				observedAt: new Date().toISOString(),
			});
			const response = {
				requestId: body.requestId,
				status: "succeeded",
				resourceRefs: [],
				data: output,
			};
			const json = JSON.stringify(response);
			if (
				Buffer.byteLength(json) > 262144 ||
				json.includes(options.apiToken) ||
				json.includes(body.carrierClaim)
			)
				throw denied();
			res.type("application/json").send(json);
		} catch (error) {
			const githubBindingDenied =
				writeOperation === "github" &&
				error instanceof Error &&
				error.message === "pr_not_bound_to_lead";
			const rejected =
				error instanceof Error &&
				(githubBindingDenied ||
					["bridge_read_scope_denied", "inbox_event_scope_denied"].includes(
						error.message,
					)) &&
				!controller.signal.aborted;
			if (!res.destroyed && !res.writableEnded)
				res.status(rejected ? 403 : 503).json({
					requestId: body.requestId,
					status: rejected ? "rejected" : "unknown",
					resourceRefs: [],
					errorCode: rejected
						? githubBindingDenied
							? "pr_not_bound_to_lead"
							: writeOperation === "terminal.input"
								? "terminal_scope_denied"
								: "scope_denied"
						: "read_unavailable",
				});
		} finally {
			clearTimeout(timer);
			req.off("aborted", abort);
			res.off("close", onClose);
			active--;
		}
	});
	return router;
}
export function mountLeadCapabilityReadProvider(
	app: Application,
	options: LeadCapabilityReadOptions,
): void {
	if (options.apiToken) {
		app.use(
			"/api/lead-capabilities/github-receipt",
			createLeadCapabilityReadRouter(options, "github", true),
		);
		app.use(
			"/api/lead-capabilities/github",
			createLeadCapabilityReadRouter(options, "github"),
		);
		for (const [route, operation] of [
			["memory-add", "memory.add"],
			["patrol-snapshot", "patrol.snapshot"],
			["patrol-judgment", "patrol.judgment.record"],
		] as const) {
			app.use(
				`/api/lead-capabilities/${route}-receipt`,
				createLeadCapabilityReadRouter(options, operation, true),
			);
			app.use(
				`/api/lead-capabilities/${route}`,
				createLeadCapabilityReadRouter(options, operation),
			);
		}
		app.use(
			"/api/lead-capabilities/inbox-event-ack-receipt",
			createLeadCapabilityReadRouter(options, "inbox.event.ack", true),
		);
		app.use(
			"/api/lead-capabilities/inbox-event-ack",
			createLeadCapabilityReadRouter(options, "inbox.event.ack"),
		);

		app.use(
			"/api/lead-capabilities/inbox-batch-ack-receipt",
			createLeadCapabilityReadRouter(options, "inbox.batch.ack", true),
		);
		app.use(
			"/api/lead-capabilities/inbox-batch-ack",
			createLeadCapabilityReadRouter(options, "inbox.batch.ack"),
		);

		app.use(
			"/api/lead-capabilities/terminal-input-receipt",
			createLeadCapabilityReadRouter(options, true, true),
		);
		app.use(
			"/api/lead-capabilities/terminal-input",
			createLeadCapabilityReadRouter(options, true),
		);
		app.use(
			"/api/lead-capabilities/read",
			createLeadCapabilityReadRouter(options),
		);
	}
}
