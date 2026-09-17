import { z } from "zod";
import { createRunnerActionSchemas } from "../lead-backends/codex/runner-action-schemas.js";
import { authorityResponseSchemas } from "../xiaohongshu-write/authority-client.js";
import { WRITE_OPERATIONS } from "../xiaohongshu-write/contracts.js";
import { BROWSER_TOOL_SCHEMAS } from "./browser-schemas.js";
import {
	patrolFindingIdentity,
	patrolMechanismInput,
} from "./patrol-schema2.js";
import { UPSTREAM_TOOL_ROWS } from "./upstream-inputs.js";
import {
	xhsWritePrepareInput,
	xhsWriteProposalInput,
	xhsWriteReceiptInput,
} from "./xiaohongshu-write-input.js";

export type CapabilityClassification = "read" | "write" | "reserved";
export type CredentialConsumer =
	| "bridge"
	| "discord"
	| "linear"
	| "github"
	| "gbrain"
	| "xiaohongshu-mcp"
	| "context7"
	| "browser"
	| "none";
export interface LeadCapabilityDefinition {
	/** Lead ruling e7cc5a18 / 75bd38de: repository reads, bound PR writes, or unconditional denial. */
	readonly githubTier?: "A" | "B" | "C";
	readonly unconditionalDenial?: string;
	readonly operationId: string;
	readonly parityId: string;
	readonly classification: CapabilityClassification;
	readonly inputSchema: z.ZodType<Record<string, unknown>>;
	readonly outputSchema: z.ZodObject<z.ZodRawShape>;
	/** A dispatch key, never an executable provider or an authorization grant. */
	readonly handlerKey: string | null;
	readonly scope: "canonical-project-lead";
	readonly credentialConsumer: CredentialConsumer;
	readonly evidenceRequirements: readonly string[];
}
const id = z
	.string()
	.min(1)
	.max(256)
	.refine(
		(value) =>
			![...value].some(
				(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
			),
		"Control characters are forbidden",
	);
const text = z
	.string()
	.min(1)
	.max(16000)
	.refine(
		(value) =>
			![...value].some(
				(char) =>
					(char.charCodeAt(0) < 32 && !"\n\r\t".includes(char)) ||
					char.charCodeAt(0) === 127,
			),
		"Control characters are forbidden",
	);
const cursor = z.string().max(2048).optional();
const limit = z.number().int().min(1).max(100).optional();
const url = z.string().url().max(4096);
const artifact = z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/);
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const receipt = { receiptId: id, observedAt: z.string().datetime() };
const message = object({
	messageId: id,
	authorId: id,
	text: z.string().max(16000),
	createdAt: z.string().datetime(),
});
const issue = object({
	id,
	identifier: id,
	url,
	title: text,
	state: id,
	assigneeId: id.nullable(),
});
const pr = object({
	number: z.number().int().positive(),
	url,
	title: text,
	head: id,
	base: id,
	draft: z.boolean(),
});
const execution = object({
	executionId: id,
	status: z.enum(["running", "waiting", "completed", "unknown"]),
});
const defs: LeadCapabilityDefinition[] = [];
function add(
	operationId: string,
	parityId: string,
	classification: CapabilityClassification,
	credentialConsumer: CredentialConsumer,
	input: z.ZodRawShape,
	output: z.ZodRawShape,
	inputSchema?: LeadCapabilityDefinition["inputSchema"],
) {
	const unconditionalDenial =
		operationId === "git.feature.push" || operationId === "github.pr.create"
			? "lead_runner_owned_operation"
			: operationId === "github.issue.comment"
				? "lead_github_issue_write_denied"
				: undefined;
	defs.push(
		Object.freeze({
			operationId,
			parityId,
			classification,
			credentialConsumer,
			...(operationId.startsWith("github.") ||
			operationId === "git.feature.push"
				? {
						githubTier: unconditionalDenial
							? ("C" as const)
							: classification === "read"
								? ("A" as const)
								: ("B" as const),
					}
				: {}),
			...(unconditionalDenial ? { unconditionalDenial } : {}),
			inputSchema: inputSchema ?? object(input),
			outputSchema: object(output),
			handlerKey: classification === "reserved" ? null : operationId,
			scope: "canonical-project-lead",
			evidenceRequirements: Object.freeze(
				classification === "reserved"
					? ["denial-receipt"]
					: ["canonical-identity", "provider-receipt", "scope-check"],
			),
		}),
	);
}
const runnerInputs = createRunnerActionSchemas();
const runnerSummary = object({
	executionId: z.string().uuid(),
	issueId: id.nullish(),
	status: id,
	role: id.nullish(),
	backend: id.nullish(),
	updatedAt: id.nullish(),
});
const runnerOutputs: Record<string, z.ZodRawShape> = {
	start_runner: {
		outcome: z.enum(["started", "pending", "unknown", "refused"]),
		idempotencyKey: id,
		httpStatus: z.number().int().min(100).max(599).optional(),
		code: id.optional(),
		executionId: z.string().uuid().optional(),
		workflowRunId: z.string().uuid().optional(),
		workflowNodeId: z.string().uuid().optional(),
		issueId: id.optional(),
		retryAfterSeconds: z.number().int().nonnegative().optional(),
		nextStep: z.string().max(1024).optional(),
		source: id,
		sourceRef: id.nullable(),
	},
	list_runners: {
		sessions: z.array(runnerSummary).max(100),
		truncated: z.boolean(),
	},
	get_runner_status: {
		...runnerSummary.shape,
		lifecycleSource: z.literal("StateStore"),
		paneStatus: z.enum(["executing", "waiting", "idle", "unknown"]),
		paneSource: z.literal("Bridge status detection"),
		checkedAt: z.string().datetime().optional(),
	},
	read_runner_tmux: {
		executionId: z.string().uuid(),
		text: z.string().max(32768),
		truncated: z.boolean(),
	},
	send_runner: {
		outcome: z.literal("queued"),
		instructionId: z.string().uuid(),
		executionId: z.string().uuid(),
	},
	respond_runner: {
		outcome: z.literal("queued"),
		responseId: z.string().uuid(),
	},
};
for (const [name, schema] of Object.entries(runnerInputs))
	add(
		name,
		"P01",
		["start_runner", "send_runner", "respond_runner"].includes(name)
			? "write"
			: "read",
		"bridge",
		schema.shape,
		{ result: object(runnerOutputs[name]!), ...receipt },
	);

add(
	"discord.thread.resolve",
	"P02",
	"read",
	"discord",
	{ issueId: id },
	{ threadId: id, parentId: id, ...receipt },
);
add(
	"discord.thread.create",
	"P02",
	"write",
	"discord",
	{ issueId: id, parentId: id, name: z.string().min(1).max(100) },
	{ threadId: id, parentId: id, ...receipt },
);
add(
	"discord.thread.read",
	"P03",
	"read",
	"discord",
	{ threadId: id, cursor, limit },
	{
		threadId: id,
		messages: z.array(message).max(100),
		nextCursor: z.string().max(2048).nullable(),
		...receipt,
	},
);
add(
	"discord.thread.reply",
	"P02",
	"write",
	"discord",
	{ threadId: id, text, replyTo: id.optional(), eventId: id.optional() },
	{ threadId: id, messageId: id, ...receipt },
);
add(
	"discord.message.edit",
	"P04",
	"write",
	"discord",
	{ threadId: id, messageId: id, text },
	{ messageId: id, ...receipt },
);
add(
	"discord.message.react",
	"P04",
	"write",
	"discord",
	{ threadId: id, messageId: id, emoji: z.string().min(1).max(128) },
	{ messageId: id, ...receipt },
);
add(
	"discord.message.attachments.get",
	"P04",
	"read",
	"discord",
	{ threadId: id, messageId: id, attachmentId: id },
	{
		artifactHandle: artifact,
		bytes: z
			.number()
			.int()
			.min(0)
			.max(25 * 1024 * 1024),
		...receipt,
	},
);
add(
	"discord.message.attachments.send",
	"P04",
	"write",
	"discord",
	{
		threadId: id,
		artifactHandles: z.array(artifact).min(1).max(10),
		text: text.optional(),
	},
	{ messageId: id, ...receipt },
);
add(
	"linear.issue.get",
	"P05",
	"read",
	"linear",
	{ issueId: id },
	{ issue, ...receipt },
);
add(
	"linear.issue.search",
	"P05",
	"read",
	"linear",
	{ query: text, cursor, limit },
	{
		issues: z.array(issue).max(100),
		nextCursor: z.string().max(2048).nullable(),
		...receipt,
	},
);
add(
	"linear.issue.create",
	"P05",
	"write",
	"linear",
	{ teamId: id, projectId: id, title: text, description: text.optional() },
	{ issue, ...receipt },
);
add(
	"linear.issue.update",
	"P05",
	"write",
	"linear",
	{
		issueId: id,
		title: text.optional(),
		description: text.optional(),
		stateId: id.optional(),
		labelIds: z.array(id).max(50).optional(),
	},
	{ issue, ...receipt },
);
add(
	"linear.issue.assign",
	"P05",
	"write",
	"linear",
	{ issueId: id, assigneeId: id.nullable() },
	{ issue, ...receipt },
);
add(
	"linear.issue.relations.set",
	"P05",
	"write",
	"linear",
	{
		issueId: id,
		relatedIssueId: id,
		type: z.enum(["blocks", "blocked_by", "related", "duplicate"]),
	},
	{ relationId: id, ...receipt },
);
add(
	"linear.comment.create",
	"P05",
	"write",
	"linear",
	{ issueId: id, body: text },
	{ commentId: id, url, ...receipt },
);
add(
	"github.pr.list",
	"P06",
	"read",
	"github",
	{ state: z.enum(["open", "closed", "all"]).optional(), cursor, limit },
	{
		pullRequests: z.array(pr).max(100),
		nextCursor: z.string().max(2048).nullable(),
		...receipt,
	},
);
add(
	"github.pr.view",
	"P06",
	"read",
	"github",
	{ number: z.number().int().positive() },
	{ pullRequest: pr, ...receipt },
);
add(
	"github.pr.diff",
	"P06",
	"read",
	"github",
	{ number: z.number().int().positive(), cursor },
	{
		diff: z.string().max(262144),
		truncated: z.boolean(),
		nextCursor: z.string().max(2048).nullable(),
		...receipt,
	},
);
add(
	"github.pr.checks",
	"P06",
	"read",
	"github",
	{ number: z.number().int().positive() },
	{
		checks: z
			.array(object({ name: id, status: id, conclusion: id.nullable(), url }))
			.max(100),
		...receipt,
	},
);
add(
	"github.pr.create",
	"P06",
	"write",
	"github",
	{ head: id, base: id, title: text, body: text, draft: z.boolean() },
	{ pullRequest: pr, ...receipt },
);
add(
	"github.pr.edit",
	"P06",
	"write",
	"github",
	{
		number: z.number().int().positive(),
		title: text.optional(),
		body: text.optional(),
		labels: z.array(id).max(100).optional(),
	},
	{ pullRequest: pr, ...receipt },
);
for (const kind of ["pr", "issue"] as const)
	add(
		`github.${kind}.comment`,
		"P06",
		"write",
		"github",
		{ number: z.number().int().positive(), body: text },
		{ commentId: id, url, ...receipt },
	);
add(
	"github.pr.review",
	"P06",
	"write",
	"github",
	{ number: z.number().int().positive(), body: text, commitId: id },
	{ reviewId: id, url, ...receipt },
);
add(
	"github.pr.ready",
	"P06",
	"write",
	"github",
	{ number: z.number().int().positive() },
	{ number: z.number().int().positive(), ready: z.literal(true), ...receipt },
);
add(
	"github.run.rerun",
	"P06",
	"write",
	"github",
	{ number: z.number().int().positive(), runId: id },
	{ runId: id, requested: z.literal(true), ...receipt },
);

add(
	"github.issue.view",
	"P06",
	"read",
	"github",
	{ number: z.number().int().positive() },
	{
		number: z.number().int().positive(),
		title: text,
		body: z.string().max(16000),
		url,
		...receipt,
	},
);
add(
	"github.run.view",
	"P06",
	"read",
	"github",
	{ runId: id },
	{ runId: id, status: id, conclusion: id.nullable(), url, ...receipt },
);
add(
	"github.run.log",
	"P06",
	"read",
	"github",
	{ runId: id, cursor },
	{
		log: z.string().max(262144),
		truncated: z.boolean(),
		nextCursor: z.string().max(2048).nullable(),
		...receipt,
	},
);
add(
	"git.feature.push",
	"P06",
	"write",
	"github",
	{
		branch: z
			.string()
			.regex(
				/^(?!main$|master$|refs\/|[-.])(?!.*(?:\.\.|[ ~^:?*[\\]))[a-zA-Z0-9_./-]+$/,
			),
		expectedHead: z.string().regex(/^[a-f0-9]{40}$/),
	},
	{ head: z.string().regex(/^[a-f0-9]{40}$/), ...receipt },
);
const bridgeSession = object({
	executionId: id,
	issueIdentifier: id,
	status: id,
	lastActivityAt: z.string().max(128).nullable(),
});
add(
	"bridge.read",
	"P07",
	"read",
	"bridge",
	{
		request: z.discriminatedUnion("resource", [
			object({ resource: z.literal("health") }),
			object({ resource: z.literal("admission.status") }),
			object({
				resource: z.literal("sessions.list"),
				cursor: z
					.string()
					.regex(/^(0|[1-9][0-9]{0,5})$/)
					.optional(),
				limit,
			}),
			object({ resource: z.literal("session.status"), executionId: id }),
			object({ resource: z.literal("session.resident-hold"), executionId: id }),
			object({
				resource: z.literal("session.code-review"),
				executionId: id,
				targetRepo: z
					.string()
					.regex(/^(?:__main__|[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})$/),
				headSha: z.string().regex(/^[a-f0-9]{40}$/),
			}),
		]),
	},
	{
		result: z.discriminatedUnion("resource", [
			object({
				resource: z.literal("health"),
				status: z.enum(["ready", "draining", "unknown"]),
			}),
			object({
				resource: z.literal("admission.status"),
				active: z.boolean(),
				remainingSeconds: z.number().int().nonnegative(),
			}),
			object({
				resource: z.literal("sessions.list"),
				sessions: z.array(bridgeSession).max(100),
				nextCursor: z
					.string()
					.regex(/^(0|[1-9][0-9]{0,5})$/)
					.nullable(),
			}),
			object({ resource: z.literal("session.status"), session: bridgeSession }),
			object({
				resource: z.literal("session.code-review"),
				executionId: id,
				targetRepo: z
					.string()
					.regex(/^(?:__main__|[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})$/),
				headSha: z.string().regex(/^[a-f0-9]{40}$/),
				record: object({
					status: z.enum(["pending", "approved", "skipped"]),
					authorFamily: z.enum(["claude", "codex"]).nullable(),
					reviewerFamily: z.enum(["claude", "codex"]).nullable(),
					rounds: z.number().int().nonnegative().nullable(),
					approvedAt: z.string().max(100).nullable(),
				}).nullable(),
			}),
			object({
				resource: z.literal("session.resident-hold"),
				executionId: id,
				hold: object({
					nodeId: id,
					state: z.enum(["resident", "woken", "expired", "closed"]),
					revision: z.number().int().positive(),
					graceStartedAt: z.string().datetime({ offset: true }),
					graceExpiresAt: z.string().datetime({ offset: true }),
					releaseCause: z.literal("verdict_pass").nullable(),
				}).nullable(),
			}),
		]),
		...receipt,
	},
);
for (const action of ["capture", "search"] as const)
	add(
		`terminal.${action}`,
		"P08",
		"read",
		"bridge",
		{
			executionId: id,
			lines: z.number().int().min(1).max(1000),
			...(action === "search" ? { pattern: z.string().min(1).max(256) } : {}),
		},
		{
			executionId: id,
			text: z.string().max(262144),
			truncated: z.boolean(),
			...receipt,
		},
	);
add(
	"terminal.list",
	"P08",
	"read",
	"bridge",
	{ cursor, limit },
	{
		executions: z.array(execution).max(100),
		nextCursor: z.string().max(2048).nullable(),
		...receipt,
	},
);
add(
	"terminal.status",
	"P08",
	"read",
	"bridge",
	{ executionId: id },
	{
		execution,
		observedSessionId: z.string().regex(/^\$\d+:%\d+$/),
		...receipt,
	},
);
add(
	"terminal.input",
	"P08",
	"write",
	"bridge",
	{
		executionId: id,
		expectedSessionId: id,
		text: text
			.max(2000)
			.refine(
				(value) => !/[\r\n]/.test(value),
				"Terminal input must be one submission",
			),
	},
	{ executionId: id, ...receipt },
);
add(
	"inbox.batch.ack",
	"P09",
	"write",
	"bridge",
	{ batchId: id },
	{ batchId: id, ...receipt },
);
add(
	"inbox.event.ack",
	"P09",
	"write",
	"bridge",
	{
		eventHandle: artifact.describe(
			"Event reference event_<event_seq>, using the delivered event sequence. Bridge checks ownership; this identifier is not an authorization token.",
		),
	},
	{ eventId: id, ...receipt },
);
for (const row of UPSTREAM_TOOL_ROWS)
	add(
		row.operationId,
		row.serverId === "gbrain" ? "P15" : "P16",
		row.classification,
		row.serverId,
		row.input.shape,
		{ result: z.unknown(), untrusted: z.literal(true), ...receipt },
		WRITE_OPERATIONS.some((operationId) => operationId === row.operationId)
			? z.union([xhsWriteReceiptInput, row.input])
			: undefined,
	);
for (const action of ["prepare", "status", "cancel"] as const)
	add(
		`xiaohongshu.write.${action}`,
		"P16",
		action === "status" ? "read" : "write",
		"xiaohongshu-mcp",
		(action === "prepare" ? xhsWritePrepareInput : xhsWriteProposalInput).shape,
		authorityResponseSchemas[action].shape,
	);
add(
	"docs.library.resolve",
	"P17",
	"read",
	"context7",
	{ libraryName: text, query: text },
	{ text: z.string().max(131072), untrusted: z.literal(true), ...receipt },
);
add(
	"docs.lookup",
	"P17",
	"read",
	"context7",
	{
		libraryId: z
			.string()
			.regex(/^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/)
			.max(512),
		query: text,
	},
	{ text: z.string().max(131072), untrusted: z.literal(true), ...receipt },
);
add(
	"patrol.snapshot",
	"P10",
	"read",
	"bridge",
	{ tickId: id },
	{
		artifactHandle: artifact,
		artifactPath: z.string().min(1).max(1024),
		steps: z
			.array(
				object({
					step: z.number().int().min(1).max(6),
					status: z.enum(["healthy", "unhealthy", "unknown"]),
					evidenceHandle: artifact.nullable(),
				}),
			)
			.length(6),
		...receipt,
	},
);
add(
	"patrol.judgment.record",
	"P10",
	"write",
	"bridge",
	{
		...patrolMechanismInput,
		tickId: id,
		executionId: id,
		judgment: z.enum(["healthy", "unhealthy", "unknown"]),
		evidenceHandle: artifact,

		step: z.union([z.number().int().min(1).max(6), z.literal("DWELL")]),
		unavailable: object({
			class: z.enum(["transient", "structural"]),
			token: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
		}).optional(),
		findings: z
			.array(
				object({
					...patrolFindingIdentity,
					bridgeProblem: z.boolean(),
					result: z.enum(["fixed", "advanced", "escalated-with-plan"]),
					evidence: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
					owner: z
						.string()
						.regex(/^(?:n\/a|founder|agent:[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/),
					next: z
						.string()
						.regex(
							/^(?:n\/a|(?:inspect|repair|authorize|route|file|retry):[A-Za-z0-9][A-Za-z0-9._:-]{0,255})$/,
						),
					epic: z
						.string()
						.regex(/^(?:n\/a|unavailable|FLY-2072#[a-f0-9-]{36})$/),
					epicMarker: z.string().regex(/^(?:n\/a|[a-f0-9]{64})$/),
				}),
			)
			.max(100)
			.optional(),
		paneResults: z
			.array(
				object({
					pane: z.string().regex(/^%[0-9]{1,16}$/),
					action: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
					result: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
				}),
			)
			.max(100)
			.optional(),
	},
	{
		judgmentId: id,
		complete: z.boolean(),
		gates: z
			.array(
				object({
					gate: z.number().int().min(1).max(3),
					passed: z.boolean(),
					exitCode: z.number().int().nullable(),
				}),
			)
			.length(3),
		reportSha256: z.string().regex(/^[a-f0-9]{64}$/),
		...receipt,
	},
);
add(
	"memory.add",
	"P15",
	"write",
	"bridge",
	{ project: id, text, collection: id, noteId: id, opId: id, runKey: id },
	{ opId: id, ...receipt },
);
add(
	"memory.search",
	"P15",
	"read",
	"bridge",
	{
		project: id,
		query: text,
		limit: z.number().int().min(1).max(50).optional(),
	},
	{
		memories: z
			.array(
				object({
					text,
					opId: id.nullable(),
					runKey: id.nullable(),
					noteId: id.nullable(),
					collection: id.nullable(),
				}),
			)
			.max(50),
		...receipt,
	},
);
add(
	"artifact.text.create",
	"P11",
	"write",
	"none",
	{
		mimeType: z.enum([
			"text/html",
			"text/plain",
			"text/markdown",
			"application/json",
		]),
		text: z
			.string()
			.min(1)
			.max(512 * 1024)
			.refine((value) => Buffer.byteLength(value, "utf8") <= 512 * 1024),
	},
	{ artifactHandle: artifact },
);
add(
	"report.publish",
	"P11",
	"write",
	"bridge",
	{ artifactHandle: artifact, title: text, issueId: id },
	{ reportId: id, url, ...receipt },
);
add(
	"report.deliver",
	"P11",
	"write",
	"bridge",
	{ reportId: id, issueId: id },
	{
		reportId: id,
		channelId: id,
		messageId: id,
		delivery: z.enum(["image-and-link", "link-only"]),
		...receipt,
	},
);
add(
	"report.verify",
	"P11",
	"read",
	"bridge",
	{ reportId: id },
	{
		reportId: id,
		httpStatus: z.number().int().min(100).max(599),
		cspValid: z.boolean(),
		nonceValid: z.boolean(),
		...receipt,
	},
);
for (const op of [
	"terminal.close",
	"bridge.ship",
	"bridge.merge",
	"bridge.terminate",
	"bridge.restart",
	"bridge.park",
	"bridge.unpark",
	"bridge.approve_to_ship",
])
	add(
		op,
		op.startsWith("terminal") ? "P08" : "P07",
		"reserved",
		"none",
		{ resourceId: id },
		{
			denied: z.literal(true),
			reason: z.literal("founder-workflow-required"),
			...receipt,
		},
	);
const browserReads = new Set([
	"list_pages",
	"take_snapshot",
	"list_console_messages",
	"get_console_message",
	"list_network_requests",
	"get_network_request",
	"wait_for",
]);
for (const [name, schema] of Object.entries(BROWSER_TOOL_SCHEMAS)) {
	add(
		`browser.${name}`,
		"P12",
		browserReads.has(name) ? "read" : "write",
		"browser",
		{ generation: z.string().uuid(), arguments: schema },
		{
			content: z
				.array(
					object({ type: z.literal("text"), text: z.string().max(262144) }),
				)
				.max(64),
			isError: z.boolean().optional(),
		},
	);
}
export const LEAD_CAPABILITY_CATALOG: readonly LeadCapabilityDefinition[] =
	Object.freeze(defs);
export function getLeadCapability(
	operationId: string,
): LeadCapabilityDefinition | undefined {
	return LEAD_CAPABILITY_CATALOG.find((op) => op.operationId === operationId);
}
/** Coverage is an inventory obligation, never a claim of runtime parity. */
export const LEAD_PARITY_COVERAGE = Object.freeze(
	[
		["P01", "existing-runner-actions"],
		["P02", "catalog"],
		["P03", "catalog"],
		["P04", "catalog"],
		["P05", "catalog"],
		["P06", "catalog"],
		["P07", "pending-route-adapter-inventory"],
		["P08", "catalog"],
		["P09", "catalog"],
		["P10", "catalog"],
		["P11", "catalog"],
		["P12", "native-browser-worker"],
		["P13", "rule-sources"],
		["P14", "skill-sources"],
		["P15", "schema-pinned-handlers-pending"],
		["P16", "schema-pinned-handlers-pending"],
		["P17", "catalog-context7-pending-other-applicable"],
	].map(([parityId, coverage]) =>
		Object.freeze({ parityId: parityId!, coverage: coverage! }),
	),
);
