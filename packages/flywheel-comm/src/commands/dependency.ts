import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { KIND_ACTION_MATRIX, OPERATION_ID_RE } from "flywheel-config";
import { shellQuote } from "../shell-quote.js";

interface DependencyHttpResponse {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

export interface DependencyCliDeps {
	env?: Record<string, string | undefined>;
	fetchFn?: (
		url: string,
		init: {
			method: string;
			headers: Record<string, string>;
			body?: string;
		},
	) => Promise<DependencyHttpResponse>;
	randomUuid?: () => string;
	log?: (message: string) => void;
	errorLog?: (message: string) => void;
}

const USAGE = [
	"usage:",
	"  flywheel-comm dependency add|remove --blocker <ID> --blocked <ID> --reason <text>",
	"  flywheel-comm dependency note --blocker <ID> --blocked <ID> --kind <kind> --action <action> --reason <text>",
	"  flywheel-comm dependency discover --parent <ID> --title <text> (--blocks <ID>|--blocked-by <ID>) --reason <text>",
	"  flywheel-comm dependency log --issue <ID> [--kind-only]",
	"  flywheel-comm dependency show",
].join("\n");

export async function runDependency(
	args: string[],
	deps: DependencyCliDeps = {},
): Promise<number> {
	const log = deps.log ?? console.log;
	const errorLog = deps.errorLog ?? console.error;
	const emit = (value: Record<string, unknown>) => log(JSON.stringify(value));
	const fail = (
		error: string,
		diagnostic?: string,
		status?: number,
		extra: Record<string, unknown> = {},
	) => {
		if (diagnostic) errorLog(diagnostic);
		emit({
			ok: false,
			error,
			...(status === undefined ? {} : { status }),
			...extra,
		});
		return 1;
	};
	const subcommand = args[0];
	if (
		subcommand !== "add" &&
		subcommand !== "remove" &&
		subcommand !== "note" &&
		subcommand !== "log" &&
		subcommand !== "show" &&
		subcommand !== "discover"
	) {
		return fail("invalid_arguments", USAGE);
	}
	let values: Record<string, string | string[] | boolean | undefined>;
	try {
		values = parseArgs({
			args: args.slice(1),
			options: {
				blocker: { type: "string" },
				blocked: { type: "string" },
				reason: { type: "string" },
				"operation-id": { type: "string" },
				project: { type: "string" },
				actor: { type: "string" },
				"bridge-url": { type: "string" },
				kind: { type: "string" },
				action: { type: "string" },
				"parent-op": { type: "string" },
				"relation-id": { type: "string" },
				backfill: { type: "boolean" },
				issue: { type: "string" },
				"kind-only": { type: "boolean" },
				parent: { type: "string" },
				title: { type: "string" },
				description: { type: "string" },
				priority: { type: "string" },
				blocks: { type: "string", multiple: true },
				"blocked-by": { type: "string", multiple: true },
			},
			strict: true,
			allowPositionals: false,
		}).values as typeof values;
	} catch {
		return fail("invalid_arguments", USAGE);
	}
	const allowed: readonly string[] = {
		add: ["blocker", "blocked", "reason", "operation-id", "actor"],
		remove: ["blocker", "blocked", "reason", "operation-id", "actor"],
		note: [
			"blocker",
			"blocked",
			"reason",
			"operation-id",
			"kind",
			"action",
			"parent-op",
			"relation-id",
			"backfill",
			"actor",
		],
		discover: [
			"reason",
			"operation-id",
			"parent",
			"title",
			"description",
			"priority",
			"blocks",
			"blocked-by",
			"actor",
		],
		log: ["issue", "kind-only"],
		show: [],
	}[subcommand];
	if (
		Object.keys(values).some(
			(key) =>
				!allowed.includes(key) && key !== "project" && key !== "bridge-url",
		)
	) {
		return fail("invalid_arguments", USAGE);
	}
	const value = (name: string) => {
		const result = values[name];
		return typeof result === "string" ? result : undefined;
	};
	const env = deps.env ?? process.env;
	const project = value("project") ?? env.FLYWHEEL_PROJECT_NAME;
	const token = env.TEAMLEAD_API_TOKEN;
	if (!project)
		return fail("missing_project", "dependency: project is required");
	if (!token) return fail("missing_token", "dependency: token is required");
	const bridgeUrl = (
		value("bridge-url") ??
		env.FLYWHEEL_BRIDGE_URL ??
		env.BRIDGE_URL ??
		"http://localhost:9876"
	).replace(/\/+$/, "");
	const fetchFn = deps.fetchFn ?? fetch;
	const headers = { Authorization: `Bearer ${token}` };
	const readJson = async (
		response: DependencyHttpResponse,
	): Promise<Record<string, unknown> | undefined> => {
		try {
			const body = await response.json();
			return body !== null && typeof body === "object" && !Array.isArray(body)
				? (body as Record<string, unknown>)
				: undefined;
		} catch {
			return undefined;
		}
	};
	if (subcommand === "show") {
		let response: DependencyHttpResponse;
		try {
			response = await fetchFn(`${bridgeUrl}/api/epic-page/generate`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ projectName: project }),
			});
		} catch {
			return fail("bridge_unreachable", "dependency: cannot reach Bridge");
		}
		const parsed = await readJson(response);
		if (parsed === undefined) {
			return fail("invalid_response", "dependency show: invalid Bridge JSON");
		}
		const result = parsed as {
			error?: unknown;
			document?: {
				generated_at?: unknown;
				ready_items?: { value?: unknown };
				dependency_review?: { value?: unknown };
			};
		};
		if (!response.ok) {
			return fail(
				typeof result.error === "string" ? result.error : "http_error",
				`dependency: Bridge returned ${response.status}`,
				response.status,
			);
		}
		const ready = result.document?.ready_items?.value;
		const review = result.document?.dependency_review?.value;
		if (!Array.isArray(ready) || !Array.isArray(review)) {
			return fail(
				"invalid_response",
				"dependency show: invalid Bridge response",
			);
		}
		emit({
			ok: true,
			command: "show",
			ready,
			review,
			generated_at: result.document?.generated_at,
		});
		return 0;
	}
	if (subcommand === "log") {
		const issue = value("issue");
		if (!issue) return fail("invalid_arguments", USAGE);
		const query = new URLSearchParams({ projectName: project, issue });
		if (values["kind-only"] === true) query.set("kindOnly", "1");
		let response: DependencyHttpResponse;
		try {
			response = await fetchFn(`${bridgeUrl}/api/dependency/log?${query}`, {
				method: "GET",
				headers,
			});
		} catch {
			return fail("bridge_unreachable", "dependency: cannot reach Bridge");
		}
		const result = await readJson(response);
		if (result === undefined) {
			return fail("invalid_response", "dependency log: invalid Bridge JSON");
		}
		if (!response.ok) {
			const body = result as { error?: unknown };
			return fail(
				typeof body?.error === "string" ? body.error : "http_error",
				`dependency: Bridge returned ${response.status}`,
				response.status,
			);
		}
		const entries = (result as { entries?: unknown })?.entries;
		if (Array.isArray(entries)) {
			for (const raw of entries) {
				const entry = raw as Record<string, unknown>;
				errorLog(
					`${String(entry.at ?? "?")} ${String(entry.blocker ?? entry.other ?? "?")} → ${String(entry.blocked ?? issue)} ${String(entry.kind ?? entry.meaning ?? entry.source ?? "")} ${String(entry.reason ?? "")}`.trim(),
				);
			}
		}
		emit({ ok: true, command: "log", result });
		return 0;
	}
	const reason = value("reason");
	const operationId =
		value("operation-id") ?? (deps.randomUuid ?? randomUUID)();
	if (!OPERATION_ID_RE.test(operationId)) {
		return fail("invalid_arguments", USAGE);
	}
	if (subcommand === "discover") {
		const parent = value("parent");
		const title = value("title");
		const description = value("description");
		const priorityRaw = value("priority");
		const priority =
			priorityRaw === undefined ? undefined : Number(priorityRaw);
		const list = (name: string): string[] => {
			const result = values[name];
			return Array.isArray(result)
				? result
				: typeof result === "string"
					? [result]
					: [];
		};
		const blocks = list("blocks");
		const blockedBy = list("blocked-by");
		if (
			!parent ||
			!title ||
			!reason ||
			(blocks.length === 0 && blockedBy.length === 0) ||
			(priority !== undefined &&
				(!Number.isInteger(priority) || priority < 0 || priority > 4))
		) {
			return fail("invalid_arguments", USAGE);
		}
		const unknownCreateOutcome = () => {
			const query = new URLSearchParams({ query: title, projectName: project });
			const next = `GET /api/linear/issue?${query} 查重后再决定`;
			errorLog(`dependency discover: ${next}`);
			emit({ ok: false, error: "outcome_unknown", next });
			return 1;
		};
		let createdResponse: DependencyHttpResponse;
		try {
			createdResponse = await fetchFn(`${bridgeUrl}/api/linear/create-issue`, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({
					projectName: project,
					title,
					...(description === undefined ? {} : { description }),
					...(priority === undefined ? {} : { priority }),
					parentId: parent,
				}),
			});
		} catch {
			return unknownCreateOutcome();
		}
		const createdJson = await readJson(createdResponse);
		if (createdJson === undefined || createdResponse.status >= 500) {
			return unknownCreateOutcome();
		}
		const createdBody = createdJson as {
			error?: unknown;
			issue?: { identifier?: unknown; url?: unknown };
		};
		if (!createdResponse.ok) {
			return fail(
				typeof createdBody.error === "string"
					? createdBody.error
					: "http_error",
				`dependency: Bridge returned ${createdResponse.status}`,
				createdResponse.status,
			);
		}
		if (typeof createdBody.issue?.identifier !== "string") {
			return fail(
				"invalid_response",
				"dependency discover: invalid create response",
			);
		}
		const created = {
			identifier: createdBody.issue.identifier,
			...(typeof createdBody.issue.url === "string"
				? { url: createdBody.issue.url }
				: {}),
		};
		const specifications = [
			...blocks.map((blocked) => ({ blocker: created.identifier, blocked })),
			...blockedBy.map((blocker) => ({ blocker, blocked: created.identifier })),
		];
		const edges: Array<Record<string, unknown>> = [];
		for (const specification of specifications) {
			const edgeOperationId = (deps.randomUuid ?? randomUUID)();
			let edgeResponse: DependencyHttpResponse;
			try {
				edgeResponse = await fetchFn(`${bridgeUrl}/api/dependency/add`, {
					method: "POST",
					headers: { ...headers, "Content-Type": "application/json" },
					body: JSON.stringify({
						projectName: project,
						...specification,
						reason,
						operation_id: edgeOperationId,
						kind: "discovered",
						parent_op: operationId,
						...((value("actor") ?? env.FLYWHEEL_LEAD_ID)
							? { claimed_actor: value("actor") ?? env.FLYWHEEL_LEAD_ID }
							: {}),
					}),
				});
			} catch {
				edges.push({
					...specification,
					operation_id: edgeOperationId,
					ok: false,
					error: "bridge_unreachable",
				});
				continue;
			}
			const edgeJson = await readJson(edgeResponse);
			if (edgeJson === undefined) {
				edges.push({
					...specification,
					operation_id: edgeOperationId,
					ok: false,
					error: "invalid_response",
				});
				continue;
			}
			const edgeBody = edgeJson as {
				error?: unknown;
				ledger?: { ok?: unknown };
				relation_id?: unknown;
				attribution?: unknown;
				post_write_check?: { cycle?: unknown; path?: unknown };
			};
			const edgeError = !edgeResponse.ok
				? typeof edgeBody.error === "string"
					? edgeBody.error
					: "http_error"
				: edgeBody.ledger?.ok === false && edgeBody.attribution !== "foreign"
					? "ledger_unrecorded"
					: edgeBody.post_write_check &&
							edgeBody.post_write_check.cycle !== false
						? "post_write_check"
						: undefined;
			if (
				edgeError === "ledger_unrecorded" &&
				typeof edgeBody.relation_id === "string"
			) {
				const repair = [
					"flywheel-comm dependency note",
					"--blocker",
					shellQuote(specification.blocker),
					"--blocked",
					shellQuote(specification.blocked),
					"--kind 'discovered' --action 'added'",
					"--reason",
					shellQuote(reason),
					"--operation-id",
					shellQuote(edgeOperationId),
					"--relation-id",
					shellQuote(edgeBody.relation_id),
					"--backfill --project",
					shellQuote(project),
					"--parent-op",
					shellQuote(operationId),
				];
				if (value("actor") ?? env.FLYWHEEL_LEAD_ID) {
					repair.push(
						"--actor",
						shellQuote((value("actor") ?? env.FLYWHEEL_LEAD_ID)!),
					);
				}
				errorLog(repair.join(" "));
			} else if (edgeError === "post_write_check") {
				errorLog(
					edgeBody.post_write_check?.cycle === true
						? `dependency discover: post-write cycle detected ${JSON.stringify(edgeBody.post_write_check.path ?? [])}; flywheel-comm dependency remove --blocker ${shellQuote(specification.blocker)} --blocked ${shellQuote(specification.blocked)} --reason ${shellQuote("break post-write cycle")} --project ${shellQuote(project)}`
						: `dependency discover: post-write cycle check was unbounded; flywheel-comm dependency show --project ${shellQuote(project)}`,
				);
			}
			edges.push({
				...specification,
				operation_id: edgeOperationId,
				ok: !edgeError,
				...(!edgeError
					? { result: edgeBody }
					: {
							error: edgeError,
							status: edgeResponse.status,
							result: {
								...(typeof edgeBody.relation_id === "string"
									? { relation_id: edgeBody.relation_id }
									: {}),
								...(edgeBody.post_write_check
									? { post_write_check: edgeBody.post_write_check }
									: {}),
							},
						}),
			});
		}
		errorLog(
			`dependency discover: parent_op=${operationId} edge_operation_ids=${edges.map((edge) => String(edge.operation_id)).join(",")}`,
		);
		const partial = edges.some((edge) => edge.ok === false);
		emit({
			ok: !partial,
			...(partial ? { error: "partial_failure" } : { command: "discover" }),
			parent_op: operationId,
			created,
			edges,
		});
		return partial ? 1 : 0;
	}
	const blocker = value("blocker");
	const blocked = value("blocked");
	if (!blocker || !blocked || !reason) {
		return fail("invalid_arguments", USAGE);
	}
	const body: Record<string, unknown> = {
		projectName: project,
		blocker,
		blocked,
		reason,
		operation_id: operationId,
		...((value("actor") ?? env.FLYWHEEL_LEAD_ID)
			? { claimed_actor: value("actor") ?? env.FLYWHEEL_LEAD_ID }
			: {}),
	};
	if (subcommand === "note") {
		const kind = value("kind");
		const action = value("action");
		const expectedAction =
			kind && Object.hasOwn(KIND_ACTION_MATRIX, kind)
				? KIND_ACTION_MATRIX[kind as keyof typeof KIND_ACTION_MATRIX]
				: undefined;
		if (!kind || !action || expectedAction !== action) {
			return fail("invalid_arguments", USAGE);
		}
		const parentOp = value("parent-op");
		const relationId = value("relation-id");
		if (
			(kind === "discovered" &&
				(!parentOp || !OPERATION_ID_RE.test(parentOp))) ||
			(kind !== "discovered" && parentOp) ||
			(values.backfill === true && !relationId)
		) {
			return fail("invalid_arguments", USAGE);
		}
		Object.assign(body, {
			kind,
			action,
			...(parentOp ? { parent_op: parentOp } : {}),
			...(relationId ? { relation_id: relationId } : {}),
			...(values.backfill === true ? { backfill: true } : {}),
		});
	}
	let response: DependencyHttpResponse;
	try {
		response = await fetchFn(`${bridgeUrl}/api/dependency/${subcommand}`, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch {
		return fail("bridge_unreachable", "dependency: cannot reach Bridge");
	}
	const result = await readJson(response);
	if (result === undefined) {
		return fail(
			"invalid_response",
			`dependency ${subcommand}: invalid Bridge JSON; operation_id=${operationId}`,
			undefined,
			{ operation_id: operationId },
		);
	}
	if (!response.ok) {
		const body = result as { error?: unknown; hint?: unknown };
		const error = typeof body?.error === "string" ? body.error : "http_error";
		return fail(
			error,
			`dependency ${subcommand}: operation_id=${operationId}; Bridge returned ${response.status}${typeof body?.hint === "string" ? `; ${body.hint}` : ""}`,
			response.status,
			{ operation_id: operationId },
		);
	}
	errorLog(`dependency ${subcommand}: operation_id=${operationId}`);
	emit({ ok: true, command: subcommand, operation_id: operationId, result });
	const mutation = result as {
		ledger?: { ok?: unknown };
		relation_id?: unknown;
		post_write_check?: { cycle?: unknown; path?: unknown };
		attribution?: unknown;
	};
	const noteCommand = (
		relationId: string | undefined,
		backfill: boolean,
	): string => {
		const kind =
			subcommand === "note"
				? value("kind")!
				: subcommand === "remove"
					? "not_needed"
					: "missed";
		const action =
			subcommand === "note"
				? value("action")!
				: subcommand === "remove"
					? "removed"
					: "added";
		const command = [
			"flywheel-comm dependency note",
			"--blocker",
			shellQuote(blocker),
			"--blocked",
			shellQuote(blocked),
			"--kind",
			shellQuote(kind),
			"--action",
			shellQuote(action),
			"--reason",
			shellQuote(reason),
			"--operation-id",
			shellQuote(operationId),
		];
		if (relationId) {
			command.push("--relation-id", shellQuote(relationId));
		}
		if (backfill) command.push("--backfill");
		command.push("--project", shellQuote(project));
		if (value("parent-op")) {
			command.push("--parent-op", shellQuote(value("parent-op")!));
		}
		if (value("actor") ?? env.FLYWHEEL_LEAD_ID) {
			command.push(
				"--actor",
				shellQuote((value("actor") ?? env.FLYWHEEL_LEAD_ID)!),
			);
		}
		return command.join(" ");
	};
	const relationId =
		typeof mutation.relation_id === "string" ? mutation.relation_id : undefined;
	if (mutation.attribution === "foreign") {
		if (relationId) errorLog(noteCommand(relationId, false));
	} else if (mutation.ledger?.ok === false) {
		if (subcommand === "note") {
			errorLog(noteCommand(relationId, values.backfill === true));
		} else if (relationId) {
			errorLog(noteCommand(relationId, true));
		}
		return 2;
	}
	if (mutation.post_write_check && mutation.post_write_check.cycle !== false) {
		errorLog(
			mutation.post_write_check.cycle === true
				? `dependency add: post-write cycle detected ${JSON.stringify(mutation.post_write_check.path ?? [])}; flywheel-comm dependency remove --blocker ${shellQuote(blocker)} --blocked ${shellQuote(blocked)} --reason ${shellQuote("break post-write cycle")} --project ${shellQuote(project)}`
				: `dependency add: post-write cycle check was unbounded; flywheel-comm dependency show --project ${shellQuote(project)}`,
		);
		return 2;
	}
	return 0;
}
