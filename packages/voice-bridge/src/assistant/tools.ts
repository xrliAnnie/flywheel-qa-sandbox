/**
 * FLY-967 P5 — the /gemini assistant's read-only Live tools, riding the
 * FLY-545 extraTools dispatch contract (LiveToolSpec, voice-core):
 *
 *   lookup_issue   → GET /api/linear/issue?query=   (identifier exact first)
 *   board_snapshot → GET /api/linear/issues?slim=1  (grouped by state name)
 *
 * D3 boundary: read-only, always projectName-scoped (Codex R1 #4), bearer
 * token in headers only. Sync function calling means a silent tool hangs the
 * Live turn — every failure path injects explicit spoken-friendly text.
 * Caller aborts (barge-in / tool-call-cancellation) propagate to the fetch
 * and rethrow: the session layer drops aborted results by contract.
 */
import type { LiveToolSpec } from "flywheel-voice-core";

export interface AssistantToolDeps {
	bridgeUrl: string;
	apiToken: string;
	projectName: string;
	/** per-call HTTP deadline; a timed-out call answers "查询超时". */
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 5000;
const BOARD_TEXT_CAP = 2000;

interface IssueSummary {
	identifier: string;
	title: string;
	state?: string;
	assignee?: string | null;
	url?: string;
}

export function buildAssistantTools(deps: AssistantToolDeps): LiveToolSpec[] {
	return [lookupIssueTool(deps), boardSnapshotTool(deps)];
}

export function lookupIssueTool(deps: AssistantToolDeps): LiveToolSpec {
	return {
		declaration: {
			name: "lookup_issue",
			description:
				"Query a Linear issue by identifier (FLY-123) or keyword. Read-only.",
			parameters: {
				type: "OBJECT",
				properties: {
					query: {
						type: "STRING",
						description: "issue identifier or keyword",
					},
				},
				required: ["query"],
			},
		},
		handler: async (args, opts) => {
			const query = stringArg(args, "query");
			if (!query) return "缺少 query 参数——请告诉我 issue 号或关键词。";
			const r = await getJson(
				deps,
				"/api/linear/issue",
				{ query },
				opts.signal,
			);
			if (r.kind === "timeout") return "查询超时了,稍后再试。";
			if (r.status === 404) return `没找到「${query}」对应的 issue。`;
			if (r.status !== 200 || !r.body) {
				return `查询失败(Bridge 返回 ${r.status}),稍后再试或换个问法。`;
			}
			const body = r.body as {
				matchType: string;
				issue?: IssueSummary;
				issues?: IssueSummary[];
			};
			if (body.matchType === "identifier" && body.issue) {
				return formatIssue(body.issue);
			}
			const list = body.issues ?? [];
			if (list.length === 0) return `没找到「${query}」对应的 issue。`;
			const lines = list.map(
				(i) => `- ${i.identifier}「${i.title}」(${i.state ?? "?"})`,
			);
			return `找到 ${list.length} 条相关 issue:\n${lines.join("\n")}`;
		},
	};
}

export function boardSnapshotTool(deps: AssistantToolDeps): LiveToolSpec {
	return {
		declaration: {
			name: "board_snapshot",
			description: "Current project board: issues grouped by state. Read-only.",
			parameters: {
				type: "OBJECT",
				properties: {
					state: {
						type: "STRING",
						description: "optional state filter (e.g. In Progress)",
					},
				},
				required: [],
			},
		},
		handler: async (args, opts) => {
			// the Bridge route's `state` param filters by Linear state TYPE
			// (started/unstarted/...), not by display name — so the name-level
			// filter the model speaks ("In Progress") is applied client-side.
			const stateFilter = stringArg(args, "state");
			const r = await getJson(
				deps,
				"/api/linear/issues",
				{ slim: "1", limit: "50" },
				opts.signal,
			);
			if (r.kind === "timeout") return "查询超时了,稍后再试。";
			if (r.status !== 200 || !r.body) {
				return `查询失败(Bridge 返回 ${r.status}),稍后再试或换个问法。`;
			}
			const issues = (
				(r.body as { issues?: IssueSummary[] }).issues ?? []
			).filter(
				(i) =>
					!stateFilter ||
					(i.state ?? "").toLowerCase() === stateFilter.toLowerCase(),
			);
			if (issues.length === 0) {
				return stateFilter
					? `board 上没有处于「${stateFilter}」状态的 issue。`
					: "board 上现在没有 issue。";
			}
			const groups = new Map<string, string[]>();
			for (const i of issues) {
				const state = i.state ?? "?";
				const lines = groups.get(state) ?? [];
				lines.push(`- ${i.identifier} ${i.title}`);
				groups.set(state, lines);
			}
			const text = [...groups.entries()]
				.map(([state, lines]) => `${state}:\n${lines.join("\n")}`)
				.join("\n");
			return text.length <= BOARD_TEXT_CAP
				? text
				: `${text.slice(0, BOARD_TEXT_CAP - 1)}…`;
		},
	};
}

function formatIssue(i: IssueSummary): string {
	const who = i.assignee ? `,负责人 ${i.assignee}` : "";
	const link = i.url ? `\n${i.url}` : "";
	return `${i.identifier}「${i.title}」— ${i.state ?? "?"}${who}。${link}`;
}

function stringArg(args: unknown, key: string): string | undefined {
	if (args && typeof args === "object") {
		const v = (args as Record<string, unknown>)[key];
		if (typeof v === "string" && v.trim()) return v.trim();
	}
	return undefined;
}

type GetJsonResult =
	| { kind: "ok"; status: number; body: unknown }
	| { kind: "timeout"; status: 0; body: null };

/** GET with mandatory projectName scope, bearer header, deadline, and
 * caller-abort propagation. Caller aborts RETHROW; deadlines return
 * kind:"timeout" so the turn still gets an explicit answer. */
async function getJson(
	deps: AssistantToolDeps,
	path: string,
	params: Record<string, string>,
	callerSignal: AbortSignal,
): Promise<GetJsonResult> {
	const url = new URL(path, deps.bridgeUrl);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	url.searchParams.set("projectName", deps.projectName);

	const ac = new AbortController();
	const onCallerAbort = () => ac.abort();
	callerSignal.addEventListener("abort", onCallerAbort, { once: true });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		ac.abort();
	}, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);

	const fetchImpl = deps.fetchImpl ?? fetch;
	try {
		const res = await fetchImpl(url.toString(), {
			headers: { Authorization: `Bearer ${deps.apiToken}` },
			signal: ac.signal,
		});
		const body = await res.json().catch(() => null);
		return { kind: "ok", status: res.status, body };
	} catch (err) {
		if (callerSignal.aborted) throw err; // cancelled turn — session drops it
		if (timedOut) return { kind: "timeout", status: 0, body: null };
		throw err;
	} finally {
		clearTimeout(timer);
		callerSignal.removeEventListener("abort", onCallerAbort);
	}
}
