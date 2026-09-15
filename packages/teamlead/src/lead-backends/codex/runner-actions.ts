import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Database from "better-sqlite3";
import { authorizeLeadWrite } from "flywheel-comm/lead-lease";
import { respond } from "flywheel-comm/respond";
import { deriveRunnerStartKey } from "flywheel-comm/runner-start";
import { send } from "flywheel-comm/send";
import { installSqlTiming } from "flywheel-config";
import { z } from "zod";
import { matchesLead } from "../../bridge/lead-scope.js";
import { parseAndValidateProjects } from "../../ProjectConfig.js";
import type { Session } from "../../StateStore.js";
import { resolveLeadMenus } from "../../workflow-menu.js";
import {
	createRunnerActionContext,
	type RunnerActionContext,
} from "./runner-action-context.js";
import {
	classifyRunnerStart,
	type RunnerBridgeClient,
	requestRunnerBridge,
} from "./runner-action-http.js";

import { RUNNER_ACTION_TOOL_NAMES } from "./runner-action-names.js";

export { RUNNER_ACTION_TOOL_NAMES } from "./runner-action-names.js";

const RESERVED = new Set([
	"approve_to_ship",
	"review_design",
	"review_code",
	"founder_review",
]);
const uuid = z.string().uuid();
const key = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const text = z
	.string()
	.refine(
		(value) =>
			value.trim().length > 0 &&
			!value.includes("\0") &&
			Buffer.byteLength(value, "utf8") <= 8000,
	);
const issue = z
	.string()
	.refine(
		(value) =>
			/^[A-Z][A-Z0-9]*-[0-9]+$/.test(value) || uuid.safeParse(value).success,
	);
class RunnerActionRefused extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}
const refuse = (code: string): never => {
	throw new RunnerActionRefused(code);
};
export interface RunnerActionsOptions {
	context: RunnerActionContext;
	bridge: RunnerBridgeClient;
	stateDbPath: string;
	commDbPath: string;
	/** Test seam. Production always uses the project's adopted menu resolver. */
	resolveMenus?: () => string[];
}
function readOnly<T>(path: string, read: (db: Database.Database) => T): T {
	const db = installSqlTiming(
		new Database(path, { readonly: true, fileMustExist: true }),
		"teamlead",
	);
	try {
		return read(db);
	} finally {
		db.close();
	}
}
function stableId(parts: string[]): string {
	const hash = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
	return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
function summary(session: Session): Record<string, unknown> {
	return {
		executionId: session.execution_id,
		issueId: session.issue_identifier,
		status: session.status,
		role: session.session_role,
		backend: session.adapter_type,
		updatedAt: session.last_activity_at,
	};
}
export function createRunnerActions(options: RunnerActionsOptions) {
	const { context, bridge, stateDbPath, commDbPath } = options;
	const initial = context.assertCurrent();
	const menus =
		options.resolveMenus ??
		(() =>
			resolveLeadMenus({
				projectRoot: context.projectRoot,
				leadId: initial.identity.leadId,
			}).map((menu) => menu.shape));
	const adopted = menus();
	if (adopted.length === 0)
		throw new Error("runner actions require at least one adopted menu");
	const schemas: Record<string, z.ZodObject> = {
		start_runner: z
			.object({
				issueId: issue,
				taskCategory: z.enum(adopted as [string, ...string[]]),
				idempotencyKey: key,
			})
			.strict(),
		list_runners: z
			.object({
				mode: z
					.enum(["active", "live", "recent_terminal", "recent", "stuck"])
					.default("active"),
			})
			.strict(),
		get_runner_status: z.object({ executionId: uuid }).strict(),
		read_runner_tmux: z
			.object({
				executionId: uuid,
				lines: z.number().int().min(1).max(200).default(80),
			})
			.strict(),
		send_runner: z
			.object({ executionId: uuid, text, idempotencyKey: key })
			.strict(),
		respond_runner: z.object({ questionId: uuid, answer: text }).strict(),
	};
	const inScope = (session: Session): boolean => {
		const current = context.assertCurrent();
		if (session.project_name !== current.identity.projectName) return false;
		const projects = parseAndValidateProjects(
			JSON.parse(readFileSync(context.projectsPath, "utf8")),
		);
		return matchesLead(session, current.identity.leadId, projects);
	};
	const resolveScopedRunner = (executionId: string): Session => {
		context.assertCurrent();
		const session = readOnly(
			stateDbPath,
			(db) =>
				db
					.prepare("SELECT * FROM sessions WHERE execution_id = ?")
					.get(executionId) as Session | undefined,
		);
		if (!session || session.execution_id !== executionId || !inScope(session))
			return refuse("RUNNER_OUT_OF_SCOPE");
		return session;
	};
	const readExecution = async (executionId: string, suffix: string) => {
		resolveScopedRunner(executionId);
		const response = await requestRunnerBridge(
			bridge,
			`/api/sessions/${executionId}${suffix}`,
		);
		resolveScopedRunner(executionId);
		if (
			response.httpStatus !== 200 ||
			response.body?.execution_id !== executionId
		)
			return refuse("RUNNER_READ_UNVERIFIED");
		return response.body;
	};
	const execute = async (
		name: string,
		raw: unknown,
	): Promise<Record<string, unknown>> => {
		try {
			const current = context.assertCurrent();
			const schema = schemas[name];
			if (!schema) return refuse("RUNNER_ACTION_UNKNOWN");
			const parsed = schema.safeParse(raw);
			if (!parsed.success) return refuse("RUNNER_ARGUMENTS_INVALID");
			const args = parsed.data as {
				issueId: string;
				taskCategory: string;
				idempotencyKey: string;
				mode: string;
				executionId: string;
				lines: number;
				text: string;
				questionId: string;
				answer: string;
			};
			const projectName = current.identity.projectName,
				leadId = current.identity.leadId;
			switch (name) {
				case "start_runner": {
					if (!menus().includes(args.taskCategory))
						return refuse("RUNNER_MENU_NOT_ADOPTED");
					context.assertCurrent();
					authorizeLeadWrite({ claimedLeadId: leadId, env: context.env });
					const attribution = deriveRunnerStartKey({
						projectName,
						leadId,
						issueId: args.issueId,
						idempotencyKey: args.idempotencyKey,
					});
					const scopedKey = attribution.key;
					const result = classifyRunnerStart(
						await requestRunnerBridge(bridge, "/api/runs/start", {
							issueId: args.issueId,
							projectName,
							leadId,
							sessionRole: "main",
							taskCategory: args.taskCategory,
							idempotencyKey: scopedKey,
						}),
						args.idempotencyKey,
					);
					if (result.outcome === "pending" || result.outcome === "unknown")
						result.nextStep =
							"Reconcile with list_runners/get_runner_status. Preserve this idempotencyKey; do not start a replacement while outcome is unknown.";
					return {
						...result,
						source: attribution.source,
						sourceRef: attribution.sourceRef,
					};
				}
				case "list_runners": {
					const response = await requestRunnerBridge(
						bridge,
						`/api/sessions?mode=${args.mode}&leadId=${encodeURIComponent(leadId)}`,
					);
					context.assertCurrent();
					if (
						response.httpStatus !== 200 ||
						!Array.isArray(response.body?.sessions)
					)
						return refuse("RUNNER_READ_UNVERIFIED");
					const sessions = response.body.sessions.filter(
						(row): row is Session =>
							!!row &&
							typeof row === "object" &&
							uuid.safeParse(row.execution_id).success &&
							inScope(row as Session),
					);
					return {
						sessions: sessions.slice(0, 100).map(summary),
						truncated: sessions.length > 100,
					};
				}
				case "get_runner_status": {
					const body = await readExecution(args.executionId, "/status");
					const session = resolveScopedRunner(args.executionId);
					return {
						...summary(session),
						lifecycleSource: "StateStore",
						paneStatus:
							typeof body.status === "string" &&
							["executing", "waiting", "idle", "unknown"].includes(body.status)
								? body.status
								: "unknown",
						paneSource: "Bridge status detection",
						checkedAt:
							typeof body.checked_at === "string" &&
							Number.isFinite(Date.parse(body.checked_at))
								? body.checked_at
								: undefined,
					};
				}
				case "read_runner_tmux": {
					const body = await readExecution(
						args.executionId,
						`/capture?lines=${args.lines}`,
					);
					if (typeof body.output !== "string")
						return refuse("RUNNER_READ_UNVERIFIED");
					const bytes = Buffer.from(body.output);
					const cut = bytes.subarray(0, 32768);
					// Decode without adding replacement bytes beyond the stated byte ceiling.
					let output = cut.toString("utf8");
					while (Buffer.byteLength(output) > 32768)
						output = output.slice(0, -1);
					return {
						executionId: args.executionId,
						text: output,
						truncated: bytes.length > 32768,
					};
				}
				case "send_runner": {
					resolveScopedRunner(args.executionId);
					const instructionId = stableId([
						projectName,
						leadId,
						args.executionId,
						args.idempotencyKey,
					]);
					await send({
						fromAgent: leadId,
						toAgent: args.executionId,
						content: args.text,
						instructionId,
						dbPath: commDbPath,
						env: context.env,
					});
					return {
						outcome: "queued",
						instructionId,
						executionId: args.executionId,
					};
				}
				case "respond_runner": {
					const question = readOnly(
						commDbPath,
						(db) =>
							db
								.prepare(
									"SELECT * FROM mailbox WHERE id = ? AND type = 'question'",
								)
								.get(args.questionId) as
								| {
										from_agent: string;
										to_agent: string;
										kind: string | null;
										checkpoint: string | null;
										expires_at: string | null;
										resolved_at: string | null;
										superseded_at: string | null;
										relay_state: string;
								  }
								| undefined,
					);
					if (
						!question ||
						question.to_agent !== leadId ||
						question.kind === "report" ||
						RESERVED.has(question.checkpoint ?? "")
					)
						return refuse("RUNNER_QUESTION_NOT_ROUTABLE");
					if (!uuid.safeParse(question.from_agent).success)
						return refuse("RUNNER_OUT_OF_SCOPE");
					resolveScopedRunner(question.from_agent);
					const existingResponse = readOnly(commDbPath, (db) =>
						db
							.prepare(
								"SELECT id FROM mailbox_message_projection WHERE parent_id = ? AND type = 'response'",
							)
							.get(args.questionId),
					);
					if (
						question.superseded_at ||
						(!existingResponse &&
							(question.resolved_at ||
								question.relay_state === "terminal_disposed")) ||
						(question.expires_at &&
							(!Number.isFinite(Date.parse(question.expires_at)) ||
								Date.parse(question.expires_at) <= Date.now()))
					)
						return refuse("RUNNER_QUESTION_CLOSED");
					await respond({
						questionId: args.questionId,
						fromAgent: leadId,
						answer: args.answer,
						dbPath: commDbPath,
						expectedOwner: question.from_agent,
						expectedCheckpoint: question.checkpoint,
						env: context.env,
					});
					const response = readOnly(
						commDbPath,
						(db) =>
							db
								.prepare(
									"SELECT id FROM mailbox_message_projection WHERE parent_id = ? AND type = 'response'",
								)
								.get(args.questionId) as { id: string } | undefined,
					);
					if (!response) return refuse("RUNNER_RESPONSE_UNVERIFIED");
					return { outcome: "queued", responseId: response.id };
				}
				default:
					return refuse("RUNNER_ACTION_UNKNOWN");
			}
		} catch (error) {
			return {
				outcome: "refused",
				code:
					error instanceof RunnerActionRefused
						? error.code
						: "RUNNER_ACTION_REJECTED",
			};
		}
	};
	return { schemas, execute };
}
export function registerRunnerActions(
	server: McpServer,
	options?: RunnerActionsOptions,
): void {
	if (!options) return;
	const actions = createRunnerActions(options);
	const descriptions: Record<string, string> = {
		start_runner:
			"Start an issue using one of your adopted task categories. For a Discord request, use idempotencyKey discord:<channelId>:<messageId> from the actual source message; issue and owner are bound automatically. Without a source message use a stable manual key (source=none). Preserve the same idempotencyKey for the same request. Pending/unknown requires read-only reconciliation, not another start.",
		list_runners: "List only your project's department runners (up to 100).",
		get_runner_status:
			"Read exact runner execution lifecycle and separate pane status.",
		read_runner_tmux:
			"Read a scoped runner's recent output, at most 200 lines and 32 KiB.",
		send_runner:
			"Queue an ordinary instruction to your runner. Reuse the key for replay. Queued does not prove consumption.",
		respond_runner:
			"Answer an ordinary question from your runner. Founder/review/ship gates cannot be answered here.",
	};
	for (const name of RUNNER_ACTION_TOOL_NAMES)
		server.registerTool(
			name,
			{ description: descriptions[name], inputSchema: actions.schemas[name] },
			async (args: unknown) => {
				const result = await actions.execute(name, args);
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
					...(result.outcome === "refused" ? { isError: true } : {}),
				};
			},
		);
}

/** Both MCP entrypoints use this exact startup admission; off adds no tools. */
export function runnerActionsOptionsFromEnv(
	env: NodeJS.ProcessEnv,
): RunnerActionsOptions | undefined {
	const marker = env.FLYWHEEL_CODEX_LEAD_RUNNER_ACTIONS;
	if (marker === undefined || marker === "0") return undefined;
	const context = createRunnerActionContext(env);
	const bridgeUrl = (env.BRIDGE_URL ?? env.FLYWHEEL_BRIDGE_URL)?.trim();
	const apiToken = (env.TEAMLEAD_API_TOKEN ?? env.FLYWHEEL_API_TOKEN)?.trim();
	if (!bridgeUrl || !apiToken)
		throw new Error(
			"runner actions require Bridge URL and API credential; no fallback",
		);
	const url = new URL(bridgeUrl);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	)
		throw new Error("runner Bridge URL invalid");
	const commDbPath =
		env.FLYWHEEL_COMM_DB ??
		env.FLYWHEEL_GATEWAY_COMM_DB ??
		join(
			env.HOME!,
			".flywheel",
			"comm",
			context.assertCurrent().identity.projectName,
			"comm.db",
		);
	const stateDbPath =
		env.FLYWHEEL_GATEWAY_STATE_DB ??
		join(env.HOME!, ".flywheel", "state", "teamlead.db");
	if (!isAbsolute(commDbPath) || !isAbsolute(stateDbPath))
		throw new Error("runner database paths must be absolute");
	return { context, commDbPath, stateDbPath, bridge: { bridgeUrl, apiToken } };
}
