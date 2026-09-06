import { timingSafeEqual } from "node:crypto";
import type { LinearDocument } from "@linear/sdk";
import express from "express";
import {
	canonicalJsonString,
	KIND_ACTION_MATRIX,
	LEDGER_ACTIONS,
	LEDGER_KINDS,
	OPERATION_ID_RE,
} from "flywheel-config";
import type { ProjectEntry, ProjectLinearBinding } from "../ProjectConfig.js";
import {
	buildLedgerComment,
	type DependencyLedgerAction,
	type DependencyLedgerEntry,
	type DependencyLedgerKind,
	normalizeDependencyReason,
	parseLedgerComment,
} from "./dependency-ledger-comment.js";
import {
	fetchLinearActiveScopeSnapshot,
	type LinearActiveScopeSnapshot,
} from "./linear-epic-query.js";
import {
	type LinearIssue,
	lookupLinearIssueByIdentifier,
} from "./linear-query.js";
import { resolveProjectNameParam } from "./linear-scope.js";

const IDENTIFIER_RE = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,6}$/;
const ACTOR_RE = /^[a-z0-9-]{1,64}$/;
const MAX_PAGES = 10;
const MAX_WALK_NODES = 200;
const DEFAULT_WRITE_DEADLINE_MS = 20_000;

export const LINEAR_RELATION_HISTORY_CODES: Record<string, string> = {
	ab: "blocker_added",
	br: "blocker_completed",
	rb: "blocker_removed",
};

export interface DependencyRelation {
	id: string;
	type: string;
	issue: { id: string; identifier: string };
}

export interface DependencyRelationPage {
	relations: DependencyRelation[];
	hasNextPage: boolean;
	endCursor: string | null;
}

export interface DependencyHistoryEntry {
	id: string;
	createdAt: string;
	actor?: { name: string } | null;
	botActor?: { name: string } | null;
	relationChanges: Array<{ identifier: string; type: string }>;
}

export interface DependencyHistoryPage {
	entries: DependencyHistoryEntry[];
	hasNextPage: boolean;
	endCursor: string | null;
}

export interface DependencyComment {
	id: string;
	body: string;
	createdAt: string;
	url?: string | null;
	user?: { name: string } | null;
	botActor?: { name: string } | null;
}

export interface DependencyCommentPage {
	comments: DependencyComment[];
	hasNextPage: boolean;
	endCursor: string | null;
}

type RelationWriteResult = {
	success: boolean;
	relation?: { id: string } | null;
};
type CommentWriteResult = {
	success: boolean;
	comment?: { id: string; url?: string | null } | null;
};

type LedgerWriteState =
	| {
			ok: true;
			comment_id: string;
			comment_url?: string;
			recorded: "now" | "already";
			scan_truncated?: true;
	  }
	| { ok: false; error: "ledger_unrecorded" }
	| { ok: false; skipped: "foreign_relation" };

interface RouteResult {
	status: number;
	body: Record<string, unknown>;
}

export interface DependencyRouterDeps {
	projects: ProjectEntry[];
	linearApiKey?: string;
	lookup?: (idOrIdentifier: string) => Promise<LinearIssue | null>;
	fetchSnapshot?: (
		apiKey: string,
		binding: ProjectLinearBinding,
	) => Promise<LinearActiveScopeSnapshot>;
	listBlockedBy?: (
		issueId: string,
		after?: string,
	) => Promise<DependencyRelationPage>;
	createRelation?: (input: {
		id?: string;
		blockerId: string;
		blockedId: string;
	}) => Promise<RelationWriteResult>;
	deleteRelation?: (relationId: string) => Promise<{ success: boolean }>;
	createComment?: (
		issueId: string,
		body: string,
	) => Promise<CommentWriteResult>;
	listHistory?: (
		issueId: string,
		after?: string,
	) => Promise<DependencyHistoryPage>;
	listComments?: (
		issueId: string,
		after?: string,
	) => Promise<DependencyCommentPage>;
	now?: () => Date;
	logger?: (message: string) => void;
	relationIdMode?: "client" | "server";
	writeDeadlineMs?: number;
	onEpicChange?: (projectName: string, reason: "dependency_changed") => void;
}

async function withDeadline<T>(
	promise: Promise<T>,
	deadlineMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("Linear dependency write deadline exceeded")),
					deadlineMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function bearerMatches(header: string | undefined, token: string): boolean {
	const expected = `Bearer ${token}`;
	return (
		typeof header === "string" &&
		header.length === expected.length &&
		timingSafeEqual(Buffer.from(header), Buffer.from(expected))
	);
}

export function masterOnlyAuthMiddleware(
	masterToken?: string,
	scopedToken?: string,
): express.RequestHandler {
	return (req, res, next) => {
		if (!masterToken) {
			res.status(503).json({ error: "master_token_not_configured" });
			return;
		}
		if (bearerMatches(req.headers.authorization, masterToken)) {
			next();
			return;
		}
		if (scopedToken && bearerMatches(req.headers.authorization, scopedToken)) {
			res.status(403).json({ error: "forbidden for scoped token" });
			return;
		}
		res.status(401).json({ error: "unauthorized" });
	};
}

function projectError(message: string): "unknown_project" | "project_unbound" {
	return message.startsWith("Unknown Flywheel project")
		? "unknown_project"
		: "project_unbound";
}

function resolveProject(
	projects: ProjectEntry[],
	raw: unknown,
):
	| { ok: true; projectName: string; binding: ProjectLinearBinding }
	| { ok: false; status: number; error: string } {
	if (typeof raw !== "string" || raw.trim().length === 0) {
		return { ok: false, status: 400, error: "project_required" };
	}
	const resolved = resolveProjectNameParam(projects, raw);
	if (!resolved.ok) {
		return {
			ok: false,
			status: resolved.status,
			error: projectError(resolved.error),
		};
	}
	if (!resolved.binding) {
		return { ok: false, status: 404, error: "project_unbound" };
	}
	return { ok: true, projectName: raw, binding: resolved.binding };
}

function intentPayload(entry: DependencyLedgerEntry): string {
	const {
		at: _at,
		relation_id: _relationId,
		evidence: _evidence,
		...intent
	} = entry;
	return canonicalJsonString(intent);
}

function logStage(
	logger: (message: string) => void,
	op: string,
	stage: "validate" | "mutate" | "verify" | "ledger",
	result: string,
): void {
	logger(`[dependency] op=${op} stage=${stage} result=${result}`);
}

async function collectBlockedBy(
	listBlockedBy: NonNullable<DependencyRouterDeps["listBlockedBy"]>,
	issueId: string,
): Promise<{ relations: DependencyRelation[]; truncated: boolean }> {
	const relations: DependencyRelation[] = [];
	let after: string | undefined;
	for (let page = 1; page <= MAX_PAGES; page += 1) {
		const result = await listBlockedBy(issueId, after);
		relations.push(...result.relations);
		if (!result.hasNextPage) return { relations, truncated: false };
		if (page === MAX_PAGES || !result.endCursor) {
			return { relations, truncated: true };
		}
		after = result.endCursor;
	}
	return { relations, truncated: true };
}

export type BlockerWalkResult =
	| { cycle: false }
	| { cycle: true; path: string[] }
	| { cycle: null; reason: "unbounded" };

export async function walkBlockers(
	listBlockedBy: NonNullable<DependencyRouterDeps["listBlockedBy"]>,
	start: { id: string; identifier: string },
	target: { id: string; identifier: string },
): Promise<BlockerWalkResult> {
	const queue = [{ ...start, path: [start.identifier] }];
	const visited = new Set<string>();
	while (queue.length > 0) {
		const current = queue.shift()!;
		if (visited.has(current.id)) continue;
		if (visited.size >= MAX_WALK_NODES) {
			return { cycle: null, reason: "unbounded" };
		}
		visited.add(current.id);
		const page = await listBlockedBy(current.id);
		if (page.hasNextPage) return { cycle: null, reason: "unbounded" };
		for (const relation of page.relations
			.filter((entry) => entry.type === "blocks")
			.sort((left, right) =>
				left.issue.identifier.localeCompare(right.issue.identifier),
			)) {
			const path = [...current.path, relation.issue.identifier];
			if (relation.issue.id === target.id) {
				return { cycle: true, path: path.reverse() };
			}
			if (!visited.has(relation.issue.id)) {
				queue.push({ ...relation.issue, path });
			}
		}
	}
	return { cycle: false };
}

async function scanLedgerComments(
	listComments: NonNullable<DependencyRouterDeps["listComments"]>,
	issueId: string,
	op: string,
): Promise<{
	entry?: DependencyLedgerEntry;
	comment?: DependencyComment;
	truncated: boolean;
}> {
	let after: string | undefined;
	for (let page = 1; page <= MAX_PAGES; page += 1) {
		const result = await listComments(issueId, after);
		for (const comment of result.comments) {
			const parsed = parseLedgerComment(comment.body);
			if (parsed && !("unparseable" in parsed) && parsed.op === op) {
				return { entry: parsed, comment, truncated: false };
			}
		}
		if (!result.hasNextPage) return { truncated: false };
		if (page === MAX_PAGES || !result.endCursor) {
			return { truncated: true };
		}
		after = result.endCursor;
	}
	return { truncated: true };
}

async function collectHistory(
	listHistory: NonNullable<DependencyRouterDeps["listHistory"]>,
	issueId: string,
): Promise<{ entries: DependencyHistoryEntry[]; truncated: boolean }> {
	const entries: DependencyHistoryEntry[] = [];
	let after: string | undefined;
	for (let page = 1; page <= MAX_PAGES; page += 1) {
		const result = await listHistory(issueId, after);
		entries.push(...result.entries);
		if (!result.hasNextPage) return { entries, truncated: false };
		if (page === MAX_PAGES || !result.endCursor) {
			return { entries, truncated: true };
		}
		after = result.endCursor;
	}
	return { entries, truncated: true };
}

async function collectComments(
	listComments: NonNullable<DependencyRouterDeps["listComments"]>,
	issueId: string,
): Promise<{ comments: DependencyComment[]; truncated: boolean }> {
	const comments: DependencyComment[] = [];
	let after: string | undefined;
	for (let page = 1; page <= MAX_PAGES; page += 1) {
		const result = await listComments(issueId, after);
		comments.push(...result.comments);
		if (!result.hasNextPage) return { comments, truncated: false };
		if (page === MAX_PAGES || !result.endCursor) {
			return { comments, truncated: true };
		}
		after = result.endCursor;
	}
	return { comments, truncated: true };
}

interface CommonInput {
	projectName: string;
	binding: ProjectLinearBinding;
	blocker: string;
	blocked: string;
	reason: string;
	operationId: string;
	claimedActor: string;
}

interface AddInput extends CommonInput {
	kind: "missed" | "discovered";
	parentOp: string | null;
}

function validateCommon(
	req: express.Request,
	projects: ProjectEntry[],
	allowed: Set<string>,
):
	| { ok: true; body: Record<string, unknown>; value: CommonInput }
	| { ok: false; status: number; body: Record<string, unknown> } {
	const body =
		req.body !== null &&
		typeof req.body === "object" &&
		!Array.isArray(req.body)
			? (req.body as Record<string, unknown>)
			: {};
	if (Object.keys(body).some((key) => !allowed.has(key))) {
		return { ok: false, status: 400, body: { error: "unsupported_option" } };
	}
	const project = resolveProject(projects, body.projectName);
	if (!project.ok) {
		return {
			ok: false,
			status: project.status,
			body: { error: project.error },
		};
	}
	if (
		typeof body.blocker !== "string" ||
		typeof body.blocked !== "string" ||
		!IDENTIFIER_RE.test(body.blocker) ||
		!IDENTIFIER_RE.test(body.blocked)
	) {
		return { ok: false, status: 400, body: { error: "invalid_identifier" } };
	}
	const reason = normalizeDependencyReason(body.reason);
	if (!reason) {
		return { ok: false, status: 400, body: { error: "invalid_reason" } };
	}
	if (
		typeof body.operation_id !== "string" ||
		!OPERATION_ID_RE.test(body.operation_id)
	) {
		return {
			ok: false,
			status: 400,
			body: { error: "invalid_operation_id" },
		};
	}
	const claimedActor = body.claimed_actor ?? "unspecified";
	if (typeof claimedActor !== "string" || !ACTOR_RE.test(claimedActor)) {
		return { ok: false, status: 400, body: { error: "invalid_actor" } };
	}
	if (body.blocker === body.blocked) {
		return { ok: false, status: 400, body: { error: "self_dependency" } };
	}
	return {
		ok: true,
		body,
		value: {
			projectName: project.projectName,
			binding: project.binding,
			blocker: body.blocker,
			blocked: body.blocked,
			reason,
			operationId: body.operation_id,
			claimedActor,
		},
	};
}

function validateAdd(
	req: express.Request,
	projects: ProjectEntry[],
):
	| { ok: true; value: AddInput }
	| { ok: false; status: number; body: Record<string, unknown> } {
	const common = validateCommon(
		req,
		projects,
		new Set([
			"projectName",
			"blocker",
			"blocked",
			"reason",
			"operation_id",
			"claimed_actor",
			"kind",
			"parent_op",
		]),
	);
	if (!common.ok) return common;
	if (common.body.kind !== undefined && common.body.kind !== "discovered") {
		return { ok: false, status: 400, body: { error: "invalid_kind" } };
	}
	if (
		(common.body.kind === "discovered" &&
			(typeof common.body.parent_op !== "string" ||
				!OPERATION_ID_RE.test(common.body.parent_op))) ||
		(common.body.kind === undefined && common.body.parent_op !== undefined)
	) {
		return {
			ok: false,
			status: 400,
			body: { error: "invalid_parent_op" },
		};
	}
	return {
		ok: true,
		value: {
			...common.value,
			kind: common.body.kind === "discovered" ? "discovered" : "missed",
			parentOp:
				common.body.kind === "discovered"
					? (common.body.parent_op as string)
					: null,
		},
	};
}

function validateRemove(
	req: express.Request,
	projects: ProjectEntry[],
):
	| { ok: true; value: CommonInput }
	| { ok: false; status: number; body: Record<string, unknown> } {
	const common = validateCommon(
		req,
		projects,
		new Set([
			"projectName",
			"blocker",
			"blocked",
			"reason",
			"operation_id",
			"claimed_actor",
		]),
	);
	return common.ok ? { ok: true, value: common.value } : common;
}

interface NoteInput extends CommonInput {
	kind: DependencyLedgerKind;
	action: DependencyLedgerAction;
	parentOp: string | null;
	backfill: boolean;
	relationId: string | null;
}

function validateNote(
	req: express.Request,
	projects: ProjectEntry[],
):
	| { ok: true; value: NoteInput }
	| { ok: false; status: number; body: Record<string, unknown> } {
	const common = validateCommon(
		req,
		projects,
		new Set([
			"projectName",
			"blocker",
			"blocked",
			"reason",
			"operation_id",
			"claimed_actor",
			"kind",
			"action",
			"parent_op",
			"relation_id",
			"backfill",
		]),
	);
	if (!common.ok) return common;
	const { body } = common;
	if (
		typeof body.kind !== "string" ||
		!LEDGER_KINDS.includes(body.kind as DependencyLedgerKind) ||
		typeof body.action !== "string" ||
		!LEDGER_ACTIONS.includes(body.action as DependencyLedgerAction) ||
		KIND_ACTION_MATRIX[body.kind as DependencyLedgerKind] !== body.action
	) {
		return {
			ok: false,
			status: 400,
			body: { error: "invalid_kind_action" },
		};
	}
	if (
		(body.kind === "discovered" &&
			(typeof body.parent_op !== "string" ||
				!OPERATION_ID_RE.test(body.parent_op))) ||
		(body.kind !== "discovered" && body.parent_op !== undefined)
	) {
		return {
			ok: false,
			status: 400,
			body: { error: "invalid_parent_op" },
		};
	}
	if (body.backfill !== undefined && body.backfill !== true) {
		return { ok: false, status: 400, body: { error: "invalid_backfill" } };
	}
	if (
		body.relation_id !== undefined &&
		(typeof body.relation_id !== "string" || body.relation_id.length === 0)
	) {
		return { ok: false, status: 400, body: { error: "invalid_relation_id" } };
	}
	if (body.backfill === true && typeof body.relation_id !== "string") {
		return {
			ok: false,
			status: 400,
			body: { error: "relation_id_required" },
		};
	}
	return {
		ok: true,
		value: {
			...common.value,
			kind: body.kind as DependencyLedgerKind,
			action: body.action as DependencyLedgerAction,
			parentOp: body.kind === "discovered" ? (body.parent_op as string) : null,
			backfill: body.backfill === true,
			relationId:
				typeof body.relation_id === "string" ? body.relation_id : null,
		},
	};
}

function defaultAdapters(apiKey: string) {
	const rawRequest = async <T>(
		query: string,
		variables: Record<string, unknown>,
	): Promise<T> => {
		const { LinearClient } = await import("@linear/sdk");
		const client = new LinearClient({ apiKey });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return (await Promise.race([
				client.client.rawRequest(query, variables),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new Error("Linear dependency deadline exceeded")),
						20_000,
					);
				}),
			])) as T;
		} finally {
			if (timer) clearTimeout(timer);
		}
	};
	return {
		lookup: (identifier: string) =>
			lookupLinearIssueByIdentifier(apiKey, identifier),
		listBlockedBy: async (
			issueId: string,
			after?: string,
		): Promise<DependencyRelationPage> => {
			const response = await rawRequest<{
				data?: {
					issue: {
						inverseRelations: {
							nodes: DependencyRelation[];
							pageInfo: { hasNextPage: boolean; endCursor?: string | null };
						};
					} | null;
				};
			}>(
				`query BlockedByRelations($id: String!, $after: String) {
					issue(id: $id) { inverseRelations(first: 50, after: $after) {
						nodes { id type issue { id identifier } }
						pageInfo { hasNextPage endCursor }
					} }
				}`,
				{ id: issueId, after: after ?? null },
			);
			const connection = response.data?.issue?.inverseRelations;
			if (!connection) throw new Error("Linear relation response missing");
			return {
				relations: connection.nodes,
				hasNextPage: connection.pageInfo.hasNextPage,
				endCursor: connection.pageInfo.endCursor ?? null,
			};
		},
		createRelation: async (input: {
			id?: string;
			blockerId: string;
			blockedId: string;
		}): Promise<RelationWriteResult> => {
			const { LinearClient } = await import("@linear/sdk");
			const client = new LinearClient({ apiKey });
			const payload = await client.createIssueRelation({
				...(input.id ? { id: input.id } : {}),
				issueId: input.blockerId,
				relatedIssueId: input.blockedId,
				type: "blocks" as LinearDocument.IssueRelationType,
			});
			const relation = await payload.issueRelation;
			return {
				success: payload.success,
				relation: relation ? { id: relation.id } : null,
			};
		},
		deleteRelation: async (relationId: string) => {
			const { LinearClient } = await import("@linear/sdk");
			const client = new LinearClient({ apiKey });
			const payload = await client.deleteIssueRelation(relationId);
			return { success: payload.success };
		},
		createComment: async (
			issueId: string,
			body: string,
		): Promise<CommentWriteResult> => {
			const { LinearClient } = await import("@linear/sdk");
			const client = new LinearClient({ apiKey });
			const payload = await client.createComment({ issueId, body });
			const comment = await payload.comment;
			return {
				success: payload.success,
				comment: comment ? { id: comment.id, url: comment.url } : null,
			};
		},
		listHistory: async (
			issueId: string,
			after?: string,
		): Promise<DependencyHistoryPage> => {
			const response = await rawRequest<{
				data?: {
					issue: {
						history: {
							nodes: DependencyHistoryEntry[];
							pageInfo: { hasNextPage: boolean; endCursor?: string | null };
						};
					} | null;
				};
			}>(
				`query DependencyLog($id: String!, $after: String) {
					issue(id: $id) { history(first: 50, after: $after) {
						nodes { id createdAt actor { name } botActor { name } relationChanges { identifier type } }
						pageInfo { hasNextPage endCursor }
					} }
				}`,
				{ id: issueId, after: after ?? null },
			);
			const connection = response.data?.issue?.history;
			if (!connection) throw new Error("Linear history response missing");
			return {
				entries: connection.nodes,
				hasNextPage: connection.pageInfo.hasNextPage,
				endCursor: connection.pageInfo.endCursor ?? null,
			};
		},
		listComments: async (
			issueId: string,
			after?: string,
		): Promise<DependencyCommentPage> => {
			const response = await rawRequest<{
				data?: {
					issue: {
						comments: {
							nodes: DependencyComment[];
							pageInfo: { hasNextPage: boolean; endCursor?: string | null };
						};
					} | null;
				};
			}>(
				`query DependencyLedgerComments($id: String!, $after: String) {
					issue(id: $id) { comments(first: 100, after: $after) {
						nodes { id body createdAt url user { name } botActor { name } }
						pageInfo { hasNextPage endCursor }
					} }
				}`,
				{ id: issueId, after: after ?? null },
			);
			const connection = response.data?.issue?.comments;
			if (!connection) throw new Error("Linear comment response missing");
			return {
				comments: connection.nodes,
				hasNextPage: connection.pageInfo.hasNextPage,
				endCursor: connection.pageInfo.endCursor ?? null,
			};
		},
	};
}

export function createDependencyRouter(
	deps: DependencyRouterDeps,
): express.Router {
	const router = express.Router();
	const defaults = deps.linearApiKey
		? defaultAdapters(deps.linearApiKey)
		: null;
	const lookup = deps.lookup ?? defaults?.lookup;
	const fetchSnapshot = deps.fetchSnapshot ?? fetchLinearActiveScopeSnapshot;
	const listBlockedBy = deps.listBlockedBy ?? defaults?.listBlockedBy;
	const createRelation = deps.createRelation ?? defaults?.createRelation;
	const createComment = deps.createComment ?? defaults?.createComment;
	const listHistory = deps.listHistory ?? defaults?.listHistory;
	const listComments = deps.listComments ?? defaults?.listComments;
	const now = deps.now ?? (() => new Date());
	const logger = deps.logger ?? console.info;
	const relationIdMode = deps.relationIdMode ?? "client";
	const writeDeadlineMs = deps.writeDeadlineMs ?? DEFAULT_WRITE_DEADLINE_MS;
	const mutationTails = new Map<string, Promise<void>>();
	const notifyEpicChanged = (projectName: string): void => {
		try {
			deps.onEpicChange?.(projectName, "dependency_changed");
		} catch {
			// Epic refresh is best-effort and must not perturb dependency writes.
		}
	};

	const resolveIssues = async (
		input: CommonInput,
	): Promise<
		| { ok: true; blocker: LinearIssue; blocked: LinearIssue }
		| { ok: false; result: RouteResult }
	> => {
		const blocker = await lookup!(input.blocker);
		if (!blocker) {
			return {
				ok: false,
				result: {
					status: 404,
					body: { error: "issue_not_found", which: "blocker" },
				},
			};
		}
		const blocked = await lookup!(input.blocked);
		if (!blocked) {
			return {
				ok: false,
				result: {
					status: 404,
					body: { error: "issue_not_found", which: "blocked" },
				},
			};
		}
		const snapshot = await fetchSnapshot(deps.linearApiKey!, input.binding);
		if (!snapshot.descendantIds.includes(blocked.id)) {
			return {
				ok: false,
				result: {
					status: 403,
					body: { error: "issue_outside_project", which: "blocked" },
				},
			};
		}
		return { ok: true, blocker, blocked };
	};

	const writeLedger = async (
		issueId: string,
		entry: DependencyLedgerEntry,
		scan: Awaited<ReturnType<typeof scanLedgerComments>>,
	): Promise<LedgerWriteState> => {
		if (scan.entry && scan.comment) {
			return {
				ok: true,
				comment_id: scan.comment.id,
				...(scan.comment.url ? { comment_url: scan.comment.url } : {}),
				recorded: "already",
			};
		}
		try {
			const written = await withDeadline(
				createComment!(issueId, buildLedgerComment(entry)),
				writeDeadlineMs,
			);
			if (written.success !== true || !written.comment?.id) {
				return { ok: false, error: "ledger_unrecorded" };
			}
			return {
				ok: true,
				comment_id: written.comment.id,
				...(written.comment.url ? { comment_url: written.comment.url } : {}),
				recorded: "now",
				...(scan.truncated ? { scan_truncated: true } : {}),
			};
		} catch {
			return { ok: false, error: "ledger_unrecorded" };
		}
	};

	const serialized = async (
		projectName: string,
		operation: () => Promise<RouteResult>,
	): Promise<RouteResult> => {
		const prior = mutationTails.get(projectName) ?? Promise.resolve();
		const result = prior.then(operation);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		mutationTails.set(projectName, tail);
		void tail.then(() => {
			if (mutationTails.get(projectName) === tail) {
				mutationTails.delete(projectName);
			}
		});
		return result;
	};

	router.post("/add", async (req, res) => {
		const validated = validateAdd(req, deps.projects);
		if (!validated.ok) {
			res.status(validated.status).json(validated.body);
			return;
		}
		const input = validated.value;
		if (
			!deps.linearApiKey ||
			!lookup ||
			!listBlockedBy ||
			!createRelation ||
			!createComment ||
			!listComments
		) {
			res.status(501).json({ error: "linear_not_configured" });
			return;
		}
		const prior = mutationTails.get(input.projectName) ?? Promise.resolve();
		const operation = prior.then(async () => {
			logStage(logger, input.operationId, "validate", "started");
			const blocker = await lookup(input.blocker);
			if (!blocker) {
				return {
					status: 404,
					body: { error: "issue_not_found", which: "blocker" },
				};
			}
			const blocked = await lookup(input.blocked);
			if (!blocked) {
				return {
					status: 404,
					body: { error: "issue_not_found", which: "blocked" },
				};
			}
			const snapshot = await fetchSnapshot(deps.linearApiKey!, input.binding);
			if (!snapshot.descendantIds.includes(blocked.id)) {
				return {
					status: 403,
					body: { error: "issue_outside_project", which: "blocked" },
				};
			}
			const desired: DependencyLedgerEntry = {
				v: 1,
				op: input.operationId,
				parent_op: input.parentOp,
				relation_id: null,
				evidence: "mutation",
				kind: input.kind,
				action: KIND_ACTION_MATRIX[input.kind],
				blocker: blocker.identifier,
				blocked: blocked.identifier,
				claimed_actor: input.claimedActor,
				at: now().toISOString(),
				reason: input.reason,
			};
			const ledgerScan = await scanLedgerComments(
				listComments,
				blocked.id,
				input.operationId,
			);
			if (
				ledgerScan.entry &&
				intentPayload(ledgerScan.entry) !== intentPayload(desired)
			) {
				return {
					status: 409,
					body: {
						error: "operation_id_conflict",
						existing: ledgerScan.entry,
					},
				};
			}
			const before = await collectBlockedBy(listBlockedBy, blocked.id);
			if (before.truncated) {
				return { status: 422, body: { error: "relations_truncated" } };
			}
			let relation = before.relations.find(
				(entry) => entry.type === "blocks" && entry.issue.id === blocker.id,
			);
			let status: "added" | "already_exists" = "added";
			let attribution: "this_operation" | "foreign" | undefined;
			if (relation) {
				status = "already_exists";
				attribution =
					relationIdMode === "client" && relation.id === input.operationId
						? "this_operation"
						: relationIdMode === "server" &&
								ledgerScan.entry?.relation_id === relation.id
							? "this_operation"
							: "foreign";
			} else {
				const preflight = await walkBlockers(listBlockedBy, blocker, blocked);
				if (preflight.cycle === true) {
					return {
						status: 409,
						body: { error: "dependency_cycle", path: preflight.path },
					};
				}
				if (preflight.cycle === null) {
					return {
						status: 422,
						body: { error: "cycle_check_unbounded" },
					};
				}
				const fresh = await collectBlockedBy(listBlockedBy, blocked.id);
				if (fresh.truncated) {
					return { status: 422, body: { error: "relations_truncated" } };
				}
				relation = fresh.relations.find(
					(entry) => entry.type === "blocks" && entry.issue.id === blocker.id,
				);
				if (!relation) {
					logStage(logger, input.operationId, "mutate", "started");
					let written: RelationWriteResult;
					let writtenId: string | undefined;
					try {
						written = await withDeadline(
							createRelation({
								...(relationIdMode === "client"
									? { id: input.operationId }
									: {}),
								blockerId: blocker.id,
								blockedId: blocked.id,
							}),
							writeDeadlineMs,
						);
						writtenId = written.relation?.id;
					} catch {
						logStage(logger, input.operationId, "mutate", "threw");
						return {
							status: 502,
							body: { error: "linear_write_unconfirmed" },
						};
					}
					if (
						written.success !== true ||
						!writtenId ||
						(relationIdMode === "client" && writtenId !== input.operationId)
					) {
						logStage(
							logger,
							input.operationId,
							"verify",
							"payload_unconfirmed",
						);
						return {
							status: 502,
							body: { error: "linear_write_unconfirmed" },
						};
					}
					let verified: Awaited<ReturnType<typeof collectBlockedBy>>;
					try {
						verified = await collectBlockedBy(listBlockedBy, blocked.id);
					} catch {
						return {
							status: 502,
							body: { error: "linear_write_unconfirmed" },
						};
					}
					if (verified.truncated) {
						return {
							status: 502,
							body: { error: "linear_write_unconfirmed" },
						};
					}
					relation = verified.relations.find(
						(entry) =>
							entry.type === "blocks" &&
							entry.issue.id === blocker.id &&
							entry.id === writtenId,
					);
					if (!relation) {
						logStage(
							logger,
							input.operationId,
							"verify",
							"fresh_read_mismatch",
						);
						return {
							status: 502,
							body: { error: "linear_write_unconfirmed" },
						};
					}
				} else {
					status = "already_exists";
					attribution =
						relationIdMode === "client" && relation.id === input.operationId
							? "this_operation"
							: relationIdMode === "server" &&
									ledgerScan.entry?.relation_id === relation.id
								? "this_operation"
								: "foreign";
				}
			}

			const relationId = relation.id;
			const ledger: LedgerWriteState =
				status === "already_exists" && attribution === "foreign"
					? { ok: false, skipped: "foreign_relation" }
					: await writeLedger(
							blocked.id,
							{ ...desired, relation_id: relationId },
							ledgerScan,
						);
			logStage(
				logger,
				input.operationId,
				"ledger",
				ledger.ok ? ledger.recorded : "unrecorded",
			);
			let postWriteCheck: BlockerWalkResult;
			try {
				postWriteCheck = await walkBlockers(listBlockedBy, blocker, blocked);
			} catch {
				postWriteCheck = { cycle: null, reason: "unbounded" };
			}
			return {
				status: 200,
				body: {
					ok: true,
					status,
					...(attribution ? { attribution } : {}),
					kind: input.kind,
					operation_id: input.operationId,
					parent_op: input.parentOp,
					relation_id: relationId,
					blocker: { identifier: blocker.identifier, url: blocker.url },
					blocked: { identifier: blocked.identifier, url: blocked.url },
					ledger,
					post_write_check: postWriteCheck,
					observed_at: now().toISOString(),
				},
			};
		});
		const tail = operation.then(
			() => undefined,
			() => undefined,
		);
		mutationTails.set(input.projectName, tail);
		void tail.then(() => {
			if (mutationTails.get(input.projectName) === tail) {
				mutationTails.delete(input.projectName);
			}
		});
		try {
			const result = await operation;
			if (
				result.status >= 200 &&
				result.status < 300 &&
				"status" in result.body &&
				result.body.status === "added"
			) {
				notifyEpicChanged(input.projectName);
			}
			res.status(result.status).json(result.body);
		} catch {
			logStage(logger, input.operationId, "validate", "upstream_error");
			res.status(502).json({ error: "linear_unavailable" });
		}
	});

	router.post("/remove", async (req, res) => {
		const validated = validateRemove(req, deps.projects);
		if (!validated.ok) {
			res.status(validated.status).json(validated.body);
			return;
		}
		const input = validated.value;
		const deleteRelation = deps.deleteRelation ?? defaults?.deleteRelation;
		if (
			!deps.linearApiKey ||
			!lookup ||
			!listBlockedBy ||
			!deleteRelation ||
			!createComment ||
			!listComments
		) {
			res.status(501).json({ error: "linear_not_configured" });
			return;
		}
		try {
			const result = await serialized(input.projectName, async () => {
				logStage(logger, input.operationId, "validate", "started");
				const issues = await resolveIssues(input);
				if (!issues.ok) return issues.result;
				const { blocker, blocked } = issues;
				const desired: DependencyLedgerEntry = {
					v: 1,
					op: input.operationId,
					parent_op: null,
					relation_id: null,
					evidence: "mutation",
					kind: "not_needed",
					action: "removed",
					blocker: blocker.identifier,
					blocked: blocked.identifier,
					claimed_actor: input.claimedActor,
					at: now().toISOString(),
					reason: input.reason,
				};
				const scan = await scanLedgerComments(
					listComments,
					blocked.id,
					input.operationId,
				);
				if (
					scan.entry &&
					intentPayload(scan.entry) !== intentPayload(desired)
				) {
					return {
						status: 409,
						body: { error: "operation_id_conflict", existing: scan.entry },
					};
				}
				const before = await collectBlockedBy(listBlockedBy, blocked.id);
				if (before.truncated) {
					return { status: 422, body: { error: "relations_truncated" } };
				}
				const relation = before.relations.find(
					(entry) => entry.type === "blocks" && entry.issue.id === blocker.id,
				);
				if (!relation) {
					return {
						status: 404,
						body: {
							error: "relation_not_found",
							hint: "若上一次 remove 已提交但响应丢失,用 note 补记",
						},
					};
				}
				logStage(logger, input.operationId, "mutate", "started");
				let deleted = false;
				try {
					deleted =
						(await withDeadline(deleteRelation(relation.id), writeDeadlineMs))
							.success === true;
				} catch {
					logStage(logger, input.operationId, "mutate", "threw");
					return {
						status: 502,
						body: { error: "linear_write_unconfirmed" },
					};
				}
				if (!deleted) {
					return {
						status: 502,
						body: { error: "linear_write_unconfirmed" },
					};
				}
				let after: Awaited<ReturnType<typeof collectBlockedBy>>;
				try {
					after = await collectBlockedBy(listBlockedBy, blocked.id);
				} catch {
					return {
						status: 502,
						body: { error: "linear_write_unconfirmed" },
					};
				}
				if (
					after.truncated ||
					after.relations.some(
						(entry) => entry.type === "blocks" && entry.issue.id === blocker.id,
					)
				) {
					return {
						status: 502,
						body: { error: "linear_write_unconfirmed" },
					};
				}
				const ledger = await writeLedger(
					blocked.id,
					{ ...desired, relation_id: relation.id },
					scan,
				);
				logStage(
					logger,
					input.operationId,
					"ledger",
					ledger.ok ? ledger.recorded : "unrecorded",
				);
				return {
					status: 200,
					body: {
						ok: true,
						status: "removed",
						kind: "not_needed",
						operation_id: input.operationId,
						parent_op: null,
						relation_id: relation.id,
						blocker: { identifier: blocker.identifier, url: blocker.url },
						blocked: { identifier: blocked.identifier, url: blocked.url },
						ledger,
						observed_at: now().toISOString(),
					},
				};
			});
			if (
				result.status >= 200 &&
				result.status < 300 &&
				result.body.status === "removed"
			) {
				notifyEpicChanged(input.projectName);
			}
			res.status(result.status).json(result.body);
		} catch {
			logStage(logger, input.operationId, "validate", "upstream_error");
			res.status(502).json({ error: "linear_unavailable" });
		}
	});

	router.post("/note", async (req, res) => {
		const validated = validateNote(req, deps.projects);
		if (!validated.ok) {
			res.status(validated.status).json(validated.body);
			return;
		}
		const input = validated.value;
		if (
			!deps.linearApiKey ||
			!lookup ||
			!listBlockedBy ||
			!createComment ||
			!listComments
		) {
			res.status(501).json({ error: "linear_not_configured" });
			return;
		}
		try {
			const result = await serialized(input.projectName, async () => {
				logStage(logger, input.operationId, "validate", "started");
				const issues = await resolveIssues(input);
				if (!issues.ok) return issues.result;
				const { blocker, blocked } = issues;
				let relationId = input.relationId;
				if (!input.backfill) {
					const current = await collectBlockedBy(listBlockedBy, blocked.id);
					if (current.truncated) {
						return { status: 422, body: { error: "relations_truncated" } };
					}
					const relation = current.relations.find(
						(entry) => entry.type === "blocks" && entry.issue.id === blocker.id,
					);
					const currentAction = relation ? "added" : "removed";
					if (currentAction !== input.action) {
						return {
							status: 409,
							body: {
								error: "ledger_state_mismatch",
								current: currentAction,
								hint: "若要补记一次已确认发生过的操作,加 --backfill",
							},
						};
					}
					if (
						relation &&
						input.relationId !== null &&
						input.relationId !== relation.id
					) {
						return {
							status: 409,
							body: {
								error: "relation_id_mismatch",
								current_relation_id: relation.id,
							},
						};
					}
					relationId = input.relationId ?? relation?.id ?? null;
				}
				const entry: DependencyLedgerEntry = {
					v: 1,
					op: input.operationId,
					parent_op: input.parentOp,
					relation_id: relationId,
					evidence: input.backfill ? "lead_ack" : "state",
					kind: input.kind,
					action: input.action,
					blocker: blocker.identifier,
					blocked: blocked.identifier,
					claimed_actor: input.claimedActor,
					at: now().toISOString(),
					reason: input.reason,
				};
				const scan = await scanLedgerComments(
					listComments,
					blocked.id,
					input.operationId,
				);
				if (scan.entry && intentPayload(scan.entry) !== intentPayload(entry)) {
					return {
						status: 409,
						body: { error: "operation_id_conflict", existing: scan.entry },
					};
				}
				const ledger = await writeLedger(blocked.id, entry, scan);
				logStage(
					logger,
					input.operationId,
					"ledger",
					ledger.ok ? ledger.recorded : "unrecorded",
				);
				return {
					status: 200,
					body: {
						ok: true,
						status: "recorded",
						operation_id: input.operationId,
						parent_op: input.parentOp,
						relation_id: relationId,
						kind: input.kind,
						action: input.action,
						ledger,
						observed_at: now().toISOString(),
					},
				};
			});
			res.status(result.status).json(result.body);
		} catch {
			logStage(logger, input.operationId, "validate", "upstream_error");
			res.status(502).json({ error: "linear_unavailable" });
		}
	});

	router.get("/log", async (req, res) => {
		const allowed = new Set(["projectName", "issue", "kindOnly"]);
		if (Object.keys(req.query).some((key) => !allowed.has(key))) {
			res.status(400).json({ error: "unsupported_option" });
			return;
		}
		const project = resolveProject(deps.projects, req.query.projectName);
		if (!project.ok) {
			res.status(project.status).json({ error: project.error });
			return;
		}
		const rawIssue = Array.isArray(req.query.issue)
			? req.query.issue[0]
			: req.query.issue;
		if (typeof rawIssue !== "string" || !IDENTIFIER_RE.test(rawIssue)) {
			res.status(400).json({ error: "invalid_identifier" });
			return;
		}
		const rawKindOnly = Array.isArray(req.query.kindOnly)
			? req.query.kindOnly[0]
			: req.query.kindOnly;
		if (rawKindOnly !== undefined && rawKindOnly !== "1") {
			res.status(400).json({ error: "invalid_kind_only" });
			return;
		}
		if (!deps.linearApiKey || !lookup || !listHistory || !listComments) {
			res.status(501).json({ error: "linear_not_configured" });
			return;
		}
		try {
			const issue = await lookup(rawIssue);
			if (!issue) {
				res.status(404).json({ error: "issue_not_found", which: "blocked" });
				return;
			}
			const snapshot = await fetchSnapshot(deps.linearApiKey, project.binding);
			if (!snapshot.descendantIds.includes(issue.id)) {
				res
					.status(403)
					.json({ error: "issue_outside_project", which: "blocked" });
				return;
			}
			const [history, comments] = await Promise.all([
				rawKindOnly === "1"
					? Promise.resolve({ entries: [], truncated: false })
					: collectHistory(listHistory, issue.id),
				collectComments(listComments, issue.id),
			]);
			const sortable: Array<
				Record<string, unknown> & {
					_sort_at: string;
					_sort_source: string;
					_sort_id: string;
					_sort_index: number;
				}
			> = [];
			let sortIndex = 0;
			for (const historyEntry of history.entries) {
				for (const change of historyEntry.relationChanges) {
					sortable.push({
						_sort_at: historyEntry.createdAt,
						_sort_source: "linear_history",
						_sort_id: historyEntry.id,
						_sort_index: sortIndex++,
						at: historyEntry.createdAt,
						source: "linear_history",
						id: historyEntry.id,
						code: change.type,
						meaning: LINEAR_RELATION_HISTORY_CODES[change.type] ?? "unknown",
						other: change.identifier,
						author:
							historyEntry.actor?.name ??
							historyEntry.botActor?.name ??
							"unknown",
					});
				}
			}
			for (const comment of comments.comments) {
				const parsed = parseLedgerComment(comment.body);
				if (parsed === null) continue;
				const base = {
					_sort_at: comment.createdAt,
					_sort_source: "ledger_comment",
					_sort_id: comment.id,
					_sort_index: sortIndex++,
					source: "ledger_comment",
					id: comment.id,
					observed_at: comment.createdAt,
					author: comment.user?.name ?? comment.botActor?.name ?? "unknown",
					...(comment.url ? { comment_url: comment.url } : {}),
				};
				if ("unparseable" in parsed) {
					sortable.push({
						...base,
						at: comment.createdAt,
						unparseable: true,
					});
				} else {
					sortable.push({ ...base, ...parsed });
				}
			}
			const entries = sortable
				.sort(
					(left, right) =>
						left._sort_at.localeCompare(right._sort_at) ||
						left._sort_source.localeCompare(right._sort_source) ||
						left._sort_id.localeCompare(right._sort_id) ||
						left._sort_index - right._sort_index,
				)
				.map(
					({ _sort_at, _sort_source, _sort_id, _sort_index, ...entry }) =>
						entry,
				);
			res.json({
				issue: issue.identifier,
				entries,
				truncated: history.truncated || comments.truncated,
			});
		} catch {
			res.status(502).json({ error: "linear_unavailable" });
		}
	});

	return router;
}
