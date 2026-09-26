/**
 * FLY-2914: read-only root-cause scheduling facts for the owner Lead's patrol.
 *
 * Lists FLY-2072 category children with occurrences >= 3, a non-terminal state
 * and no active workflow run, so the patrol completion gate can require one
 * disposition per category (reported to the founder, still waiting for her, or
 * explicitly scheduled). Linear is only read here: no comment, occurrence,
 * state, dispatch or issue creation ever happens on this path.
 */
import { createHash } from "node:crypto";

export const ROOT_CAUSE_PARENT_IDENTIFIER = "FLY-2072";
/** Flywheel Linear project that owns FLY-2072 (CLAUDE.md "Linear Project"). */
export const ROOT_CAUSE_LINEAR_PROJECT_ID =
	"764d7ab4-9a3b-43ea-99d9-7e881bb3b376";
/** Config-fixed owner; other projects/Leads record not_applicable. */
export const ROOT_CAUSE_OWNER = {
	projectName: "flywheel",
	leadId: "flywheel-eng-lead",
} as const;
export const ROOT_CAUSE_THRESHOLD = 3;
export const ROOT_CAUSE_UNAVAILABLE_TOKEN = "root_cause_source_unavailable";
/** A scheduled disposition must be revisited within this window. */
export const ROOT_CAUSE_SCHEDULE_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
const MAX_ROWS = 3000;
export const ROOT_CAUSE_DEADLINE_MS = 30_000;

const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDENTIFIER = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;
const SNOWFLAKE = /^[0-9]{5,25}$/;

export type LinearRequest = <T>(
	query: string,
	variables: Record<string, unknown>,
) => Promise<T>;

export interface RootCauseChild {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	url: string;
	state: { name: string; type: string };
	parent: { id: string } | null;
	project: { id: string } | null;
}

export interface RootCauseWaiting {
	askId: string;
	threadId: string;
	messageId: string;
	askedAt: string;
}

export interface RootCauseCandidate {
	scheduleKey: string;
	findingId: string;
	ref: string;
	identifier: string;
	issueUuid: string;
	classKey: string | null;
	title: string;
	url: string;
	state: string;
	occurrences: number | null;
	titleCount: number | null;
	descriptionCount: number | null;
	diagnostics: string[];
	waiting: RootCauseWaiting | null;
}

export interface RootCauseExcluded {
	identifier: string;
	issueUuid: string;
	reason: "active_run";
	runId: string;
	occurrences: number | null;
	titleCount: number | null;
	descriptionCount: number | null;
	diagnostics: string[];
}

export interface RootCauseFacts {
	version: 1;
	status: "complete" | "unavailable" | "not_applicable";
	token: string | null;
	projectName: string;
	leadId: string;
	observedAt: string;
	parentUuid: string | null;
	children: number;
	pages: number;
	nonCategory: number;
	candidates: RootCauseCandidate[];
	excluded: RootCauseExcluded[];
	sourceDigest: string | null;
}

export interface RootCauseStateReader {
	/** Exact alias-aware lookup; only status='active' counts (held is not active). */
	activeRunId(projectName: string, aliases: string[]): string | undefined;
	/** Open (unsettled) founder ask bound to this schedule key in this project. */
	openAsk(
		projectName: string,
		scheduleKey: string,
	):
		| {
				ask_id: string;
				thread_id: string;
				message_id: string | null;
				asked_at: string;
		  }
		| undefined;
}

export class RootCauseSourceError extends Error {
	constructor(readonly token: string) {
		super(token);
	}
}

const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

/** Stable category identity: title/count changes never reopen a waiting episode. */
export function rootCauseScheduleKey(input: {
	projectName: string;
	parentUuid: string;
	childUuid: string;
	classKey: string | null;
}): string {
	return sha256(
		JSON.stringify([
			input.projectName,
			input.parentUuid,
			input.childUuid,
			input.classKey,
		]),
	);
}
export const rootCauseFindingId = (scheduleKey: string) =>
	sha256(`rootcause-finding:${scheduleKey}`);
export const rootCauseRef = (scheduleKey: string) => `rootcause:${scheduleKey}`;
/** Short marker the send path appends so a delivered message is attributable. */
export const rootCauseMessageMarker = (scheduleKey: string) =>
	`rootcause:${scheduleKey.slice(0, 12)}`;

function count(value: string): number | undefined {
	if (!/^(?:0|[1-9][0-9]{0,15})$/.test(value)) return undefined;
	const n = Number(value);
	return Number.isSafeInteger(n) ? n : undefined;
}

/** Title tail `· ×N` and a standalone `occurrences: N` line; max wins, gaps are reported. */
export function parseRootCauseMetadata(
	title: string,
	description: string | null,
): {
	titleCount: number | null;
	descriptionCount: number | null;
	occurrences: number | null;
	classKey: string | null;
	category: boolean;
	diagnostics: string[];
} {
	const diagnostics: string[] = [];
	const tail = /·\s*×\s*([0-9]+)\s*$/.exec(title);
	let titleCount: number | null = null;
	if (tail) {
		const n = count(tail[1]!);
		if (n === undefined) diagnostics.push("title_count_invalid");
		else titleCount = n;
	}
	const lines = (description ?? "").split(/\r?\n/);
	const counts = new Set<number>();
	let countLines = 0;
	const keys = new Set<string>();
	let keyLines = 0;
	for (const raw of lines) {
		const line = raw.trim();
		if (/^occurrences\s*[:：]/i.test(line)) {
			countLines++;
			const m = /^occurrences:\s*([0-9]+)$/.exec(line);
			const n = m ? count(m[1]!) : undefined;
			if (n === undefined) diagnostics.push("description_count_invalid");
			else counts.add(n);
		} else if (/^class_key\s*[:：]/i.test(line)) {
			keyLines++;
			const value = line
				.replace(/^class_key\s*[:：]\s*/i, "")
				.replace(/^`|`$/g, "");
			if (HEX.test(value)) keys.add(value);
			else diagnostics.push("class_key_invalid");
		}
	}
	const descriptionCount = counts.size ? Math.max(...counts) : null;
	if (counts.size > 1) diagnostics.push("description_count_conflict");
	else if (countLines > 1 && counts.size === 1)
		diagnostics.push("description_count_duplicate");
	const classKey = keys.size === 1 ? [...keys][0]! : null;
	if (keys.size > 1) diagnostics.push("class_key_conflict");
	else if (keyLines === 0) diagnostics.push("class_key_missing");
	if (titleCount === null && !tail) diagnostics.push("title_count_missing");
	if (descriptionCount === null && countLines === 0)
		diagnostics.push("description_count_missing");
	if (
		titleCount !== null &&
		descriptionCount !== null &&
		titleCount !== descriptionCount
	)
		diagnostics.push("count_mismatch");
	const occurrences =
		titleCount === null && descriptionCount === null
			? null
			: Math.max(titleCount ?? 0, descriptionCount ?? 0);
	if (occurrences === null) diagnostics.push("count_unreadable");
	const category =
		title.includes("[病根") ||
		titleCount !== null ||
		!!tail ||
		countLines > 0 ||
		keyLines > 0;
	return {
		titleCount,
		descriptionCount,
		occurrences,
		classKey,
		category,
		diagnostics: [...new Set(diagnostics)].sort(),
	};
}

/**
 * Pure selection. A category with no readable count is still listed (it may be
 * over the threshold); only a readable count below the threshold is dropped.
 */
export function selectRootCauseCandidates(input: {
	projectName: string;
	parentUuid: string;
	children: RootCauseChild[];
	state: RootCauseStateReader;
}): {
	candidates: RootCauseCandidate[];
	excluded: RootCauseExcluded[];
	nonCategory: number;
} {
	const candidates: RootCauseCandidate[] = [];
	const excluded: RootCauseExcluded[] = [];
	let nonCategory = 0;
	const classKeys = new Map<string, number>();
	for (const child of input.children) {
		const meta = parseRootCauseMetadata(child.title, child.description);
		if (meta.classKey)
			classKeys.set(meta.classKey, (classKeys.get(meta.classKey) ?? 0) + 1);
	}
	for (const child of input.children) {
		const meta = parseRootCauseMetadata(child.title, child.description);
		if (!meta.category) {
			nonCategory++;
			continue;
		}
		if (["completed", "canceled"].includes(child.state.type)) continue;
		if (meta.occurrences !== null && meta.occurrences < ROOT_CAUSE_THRESHOLD)
			continue;
		const diagnostics = [...meta.diagnostics];
		if ((classKeys.get(meta.classKey ?? "") ?? 0) > 1)
			diagnostics.push("duplicate_class_key");
		if (
			child.project !== null &&
			child.project.id !== ROOT_CAUSE_LINEAR_PROJECT_ID
		)
			diagnostics.push("project_scope_mismatch");
		const runId = input.state.activeRunId(input.projectName, [
			child.identifier,
			child.id,
		]);
		if (runId) {
			excluded.push({
				identifier: child.identifier,
				issueUuid: child.id,
				reason: "active_run",
				runId,
				occurrences: meta.occurrences,
				titleCount: meta.titleCount,
				descriptionCount: meta.descriptionCount,
				diagnostics: diagnostics.sort(),
			});
			continue;
		}
		const scheduleKey = rootCauseScheduleKey({
			projectName: input.projectName,
			parentUuid: input.parentUuid,
			childUuid: child.id,
			classKey: meta.classKey,
		});
		const ask = input.state.openAsk(input.projectName, scheduleKey);
		candidates.push({
			scheduleKey,
			findingId: rootCauseFindingId(scheduleKey),
			ref: rootCauseRef(scheduleKey),
			identifier: child.identifier,
			issueUuid: child.id,
			classKey: meta.classKey,
			title: child.title,
			url: child.url,
			state: child.state.name,
			occurrences: meta.occurrences,
			titleCount: meta.titleCount,
			descriptionCount: meta.descriptionCount,
			diagnostics: [...new Set(diagnostics)].sort(),
			waiting:
				ask?.message_id && SNOWFLAKE.test(ask.message_id)
					? {
							askId: ask.ask_id,
							threadId: ask.thread_id,
							messageId: ask.message_id,
							askedAt: ask.asked_at,
						}
					: null,
		});
	}
	const order = (a: RootCauseCandidate, b: RootCauseCandidate) =>
		(b.occurrences ?? -1) - (a.occurrences ?? -1) ||
		(a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0);
	candidates.sort(order);
	excluded.sort((a, b) => (a.identifier < b.identifier ? -1 : 1));
	return { candidates, excluded, nonCategory };
}

/** Covers only the candidate identity set; counts/titles/waiting are volatile. */
export function rootCauseSourceDigest(
	candidates: Array<Pick<RootCauseCandidate, "scheduleKey" | "identifier">>,
): string {
	return sha256(
		JSON.stringify(
			candidates
				.map((c) => [c.scheduleKey, c.identifier])
				.sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)),
		),
	);
}

const ROOT_QUERY = `query RootCauseParent($id: String!) {
 issue(id: $id) { id identifier team { key } project { id } }
}`;
const CHILDREN_QUERY = `query RootCauseChildren($id: String!, $after: String) {
 issue(id: $id) {
  id
  children(first: ${PAGE_SIZE}, after: $after, includeArchived: true) {
   nodes { id identifier title description url state { name type } parent { id } project { id } }
   pageInfo { hasNextPage endCursor }
  }
 }
}`;

function isChild(value: unknown): value is RootCauseChild {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	const state = v.state as Record<string, unknown> | null;
	const parent = v.parent as Record<string, unknown> | null;
	const project = v.project as Record<string, unknown> | null;
	return (
		typeof v.id === "string" &&
		UUID.test(v.id) &&
		typeof v.identifier === "string" &&
		IDENTIFIER.test(v.identifier) &&
		typeof v.title === "string" &&
		(v.description === null || typeof v.description === "string") &&
		typeof v.url === "string" &&
		!!state &&
		typeof state.name === "string" &&
		typeof state.type === "string" &&
		(parent === null || (!!parent && typeof parent.id === "string")) &&
		(project === null || (!!project && typeof project.id === "string"))
	);
}

/** Every direct child (archived included) or a stable failure token; never a partial list. */
export async function fetchRootCauseChildren(
	request: LinearRequest,
	deadlineAt: number,
	now: () => number = Date.now,
): Promise<{ parentUuid: string; children: RootCauseChild[]; pages: number }> {
	const call = async <T>(query: string, variables: Record<string, unknown>) => {
		if (now() >= deadlineAt) throw new RootCauseSourceError("linear_deadline");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				request<T>(query, variables),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(
						() => reject(new RootCauseSourceError("linear_deadline")),
						Math.max(1, deadlineAt - now()),
					);
				}),
			]);
		} catch (error) {
			if (error instanceof RootCauseSourceError) throw error;
			throw new RootCauseSourceError("linear_request_failed");
		} finally {
			if (timer) clearTimeout(timer);
		}
	};
	const root = await call<{
		data?: {
			issue?: {
				id?: unknown;
				identifier?: unknown;
				team?: { key?: unknown } | null;
				project?: { id?: unknown } | null;
			} | null;
		};
	}>(ROOT_QUERY, { id: ROOT_CAUSE_PARENT_IDENTIFIER });
	const parent = root?.data?.issue;
	if (
		!parent ||
		typeof parent.id !== "string" ||
		!UUID.test(parent.id) ||
		parent.identifier !== ROOT_CAUSE_PARENT_IDENTIFIER ||
		parent.team?.key !== "FLY" ||
		parent.project?.id !== ROOT_CAUSE_LINEAR_PROJECT_ID
	)
		throw new RootCauseSourceError("parent_scope_mismatch");
	const parentUuid = parent.id;
	const children: RootCauseChild[] = [];
	const seen = new Set<string>();
	const cursors = new Set<string>();
	let after: string | null = null;
	for (let page = 1; page <= MAX_PAGES; page++) {
		const response: {
			data?: {
				issue?: {
					id?: unknown;
					children?: {
						nodes?: unknown;
						pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
					};
				} | null;
			};
		} = await call(CHILDREN_QUERY, { id: parentUuid, after });
		const issue = response?.data?.issue;
		const nodes = issue?.children?.nodes;
		const info = issue?.children?.pageInfo;
		if (
			!issue ||
			issue.id !== parentUuid ||
			!Array.isArray(nodes) ||
			!info ||
			typeof info.hasNextPage !== "boolean"
		)
			throw new RootCauseSourceError("children_schema");
		for (const node of nodes) {
			if (!isChild(node)) throw new RootCauseSourceError("children_schema");
			if (node.parent?.id !== parentUuid)
				throw new RootCauseSourceError("child_parent_mismatch");
			if (seen.has(node.id)) throw new RootCauseSourceError("duplicate_child");
			seen.add(node.id);
			children.push(node);
			if (children.length > MAX_ROWS)
				throw new RootCauseSourceError("children_limit");
		}
		if (!info.hasNextPage) return { parentUuid, children, pages: page };
		if (
			typeof info.endCursor !== "string" ||
			!info.endCursor ||
			cursors.has(info.endCursor)
		)
			throw new RootCauseSourceError("cursor_invalid");
		cursors.add(info.endCursor);
		after = info.endCursor;
	}
	throw new RootCauseSourceError("children_limit");
}

export function rootCauseScope(
	projectName: string,
	leadId: string,
): string | null {
	if (projectName !== ROOT_CAUSE_OWNER.projectName) return "project_scope";
	if (leadId !== ROOT_CAUSE_OWNER.leadId)
		return `owner:${ROOT_CAUSE_OWNER.leadId}`;
	return null;
}

export async function collectRootCauseFacts(input: {
	projectName: string;
	leadId: string;
	request: LinearRequest | undefined;
	state: RootCauseStateReader;
	now?: () => number;
	deadlineMs?: number;
}): Promise<RootCauseFacts> {
	const now = input.now ?? Date.now;
	const start = now();
	const base = {
		version: 1 as const,
		projectName: input.projectName,
		leadId: input.leadId,
		observedAt: new Date(start).toISOString(),
		parentUuid: null,
		children: 0,
		pages: 0,
		nonCategory: 0,
		candidates: [],
		excluded: [],
		sourceDigest: null,
	};
	const scope = rootCauseScope(input.projectName, input.leadId);
	if (scope) return { ...base, status: "not_applicable", token: scope };
	if (!input.request)
		return { ...base, status: "unavailable", token: "linear_unconfigured" };
	try {
		const fetched = await fetchRootCauseChildren(
			input.request,
			start + (input.deadlineMs ?? ROOT_CAUSE_DEADLINE_MS),
			now,
		);
		const selected = selectRootCauseCandidates({
			projectName: input.projectName,
			parentUuid: fetched.parentUuid,
			children: fetched.children,
			state: input.state,
		});
		return {
			...base,
			status: "complete",
			token: null,
			parentUuid: fetched.parentUuid,
			children: fetched.children.length,
			pages: fetched.pages,
			nonCategory: selected.nonCategory,
			candidates: selected.candidates,
			excluded: selected.excluded,
			sourceDigest: rootCauseSourceDigest(selected.candidates),
		};
	} catch (error) {
		return {
			...base,
			status: "unavailable",
			token:
				error instanceof RootCauseSourceError
					? error.token
					: "state_read_failed",
		};
	}
}

export type RootCauseDispositionMode =
	| "reported"
	| "waiting_founder"
	| "scheduled";
export interface RootCauseDisposition {
	ref: string;
	findingId: string;
	scheduleKey: string;
	mode: RootCauseDispositionMode;
	askId: string | null;
	threadId: string | null;
	messageId: string | null;
	reason: string | null;
	owner: string | null;
	nextReviewAt: string | null;
	sourceDigest: string;
}
const DISPOSITION_KEYS =
	"ref findingId scheduleKey mode askId threadId messageId reason owner nextReviewAt sourceDigest".split(
		" ",
	);
const CANDIDATE_KEYS =
	"scheduleKey findingId ref identifier issueUuid classKey title url state occurrences titleCount descriptionCount diagnostics waiting".split(
		" ",
	);
const OWNER = /^(?:founder|agent:[A-Za-z0-9][A-Za-z0-9._-]*)$/;

export function rootCauseFindingLine(
	candidate: Pick<RootCauseCandidate, "findingId" | "scheduleKey">,
	owner: string,
	next: "route:rootcause-schedule" | "inspect:rootcause-schedule",
): string {
	const ref = rootCauseRef(candidate.scheduleKey);
	return `FINDING id=${candidate.findingId} category=incident step=6 bridge_problem=no result=escalated-with-plan evidence=${ref} owner=${owner} next=${next} epic=n/a epic_marker=n/a disposition_ref=${ref}`;
}

function priorScheduled(
	priorReport: string | undefined,
	nowMs: number,
): Map<string, RootCauseDisposition> {
	const result = new Map<string, RootCauseDisposition>();
	for (const line of (priorReport ?? "").split("\n")) {
		if (!line.startsWith("ROOT_CAUSE_DISPOSITION ")) continue;
		try {
			const d = JSON.parse(line.slice("ROOT_CAUSE_DISPOSITION ".length));
			if (
				d &&
				typeof d === "object" &&
				d.mode === "scheduled" &&
				typeof d.scheduleKey === "string" &&
				HEX.test(d.scheduleKey) &&
				typeof d.owner === "string" &&
				OWNER.test(d.owner) &&
				prose(d.reason) &&
				typeof d.nextReviewAt === "string" &&
				Date.parse(d.nextReviewAt) > nowMs
			)
				result.set(d.scheduleKey, d as RootCauseDisposition);
		} catch {}
	}
	return result;
}

/**
 * Report lines for STEP 6. Machine-derivable dispositions are pre-filled so the
 * Lead only handles new, settled or expired categories: an open delivered ask
 * becomes waiting_founder; an unexpired scheduled disposition from the
 * previous report of this Lead is carried forward unchanged except its digest.
 */
export function renderRootCauseLines(
	facts: RootCauseFacts,
	options: { priorReport?: string; nowMs?: number } = {},
): string[] {
	const head = `ROOT_CAUSE_REVIEW status=${facts.status} parent=${ROOT_CAUSE_PARENT_IDENTIFIER} observed_at=${facts.observedAt}`;
	if (facts.status === "not_applicable")
		return [`${head} token=${facts.token}`];
	if (facts.status === "unavailable")
		return [
			`${head} token=${facts.token}`,
			`UNAVAILABLE_CAUSE step=6 class=transient token=${ROOT_CAUSE_UNAVAILABLE_TOKEN}`,
		];
	const digest = facts.sourceDigest!;
	const lines = [
		`${head} count=${facts.candidates.length} source_digest=${digest} children=${facts.children} pages=${facts.pages} non_category=${facts.nonCategory} excluded=${facts.excluded.length}`,
		...facts.candidates.map((c) => `ROOT_CAUSE_CANDIDATE ${JSON.stringify(c)}`),
		...facts.excluded.map((e) => `ROOT_CAUSE_EXCLUDED ${JSON.stringify(e)}`),
	];
	const carried = priorScheduled(
		options.priorReport,
		options.nowMs ?? Date.now(),
	);
	for (const c of facts.candidates) {
		let disposition: RootCauseDisposition | undefined;
		let owner = "founder";
		let next: "route:rootcause-schedule" | "inspect:rootcause-schedule" =
			"route:rootcause-schedule";
		if (c.waiting) {
			disposition = {
				ref: c.ref,
				findingId: c.findingId,
				scheduleKey: c.scheduleKey,
				mode: "waiting_founder",
				askId: c.waiting.askId,
				threadId: c.waiting.threadId,
				messageId: c.waiting.messageId,
				reason: null,
				owner: "founder",
				nextReviewAt: null,
				sourceDigest: digest,
			};
		} else {
			const prior = carried.get(c.scheduleKey);
			if (prior) {
				owner = prior.owner!;
				next = "inspect:rootcause-schedule";
				disposition = {
					ref: c.ref,
					findingId: c.findingId,
					scheduleKey: c.scheduleKey,
					mode: "scheduled",
					askId: typeof prior.askId === "string" ? prior.askId : null,
					threadId: typeof prior.threadId === "string" ? prior.threadId : null,
					messageId:
						typeof prior.messageId === "string" ? prior.messageId : null,
					reason: prior.reason,
					owner: prior.owner,
					nextReviewAt: prior.nextReviewAt,
					sourceDigest: digest,
				};
			}
		}
		if (!disposition) continue;
		lines.push(
			rootCauseFindingLine(c, owner, next),
			`ROOT_CAUSE_DISPOSITION ${JSON.stringify(disposition)}`,
		);
	}
	return lines;
}

function prose(v: unknown): v is string {
	return (
		typeof v === "string" &&
		[...v.trim()].length >= 10 &&
		!/\b(?:TODO|TBD|UNSET)\b/i.test(v)
	);
}
function exactKeys(v: Record<string, unknown>, allowed: string[]): boolean {
	const keys = Object.keys(v);
	return (
		keys.length === allowed.length && keys.every((k) => allowed.includes(k))
	);
}
function fieldsOf(line: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const token of line.trim().split(/\s+/).slice(1)) {
		const index = token.indexOf("=");
		if (index > 0) result[token.slice(0, index)] = token.slice(index + 1);
	}
	return result;
}

export interface ParsedRootCauseSection {
	review: Record<string, string>;
	candidates: RootCauseCandidate[];
	dispositions: Map<string, RootCauseDisposition>;
	findings: Map<string, Record<string, string>>;
	project: string;
	lead: string;
	step6: string | undefined;
}

/**
 * Structural closure: one review, authentic digest, and exactly one FINDING +
 * ROOT_CAUSE_DISPOSITION per candidate. Delivery/time/fresh-source evidence is
 * checked separately by verifyRootCauseEvidence with trusted readers.
 */
export function validateRootCauseStructure(text: string): {
	errors: string[];
	parsed?: ParsedRootCauseSection;
} {
	const errors: string[] = [];
	const lines = text.split(/\r?\n/);
	const reviews = lines.filter((l) => l.startsWith("ROOT_CAUSE_REVIEW"));
	if (reviews.length !== 1) return { errors: ["root_cause_review_missing"] };
	const review = fieldsOf(reviews[0]!);
	const project = /^project: (.*)$/m.exec(text)?.[1] ?? "";
	const lead = /^lead: (.*)$/m.exec(text)?.[1] ?? "";
	const step6 = /^STEP 6: (.*)$/m.exec(text)?.[1];
	const candidates: RootCauseCandidate[] = [];
	const dispositions = new Map<string, RootCauseDisposition>();
	const findings = new Map<string, Record<string, string>>();
	for (const line of lines) {
		if (line.startsWith("ROOT_CAUSE_CANDIDATE ")) {
			try {
				const c = JSON.parse(line.slice("ROOT_CAUSE_CANDIDATE ".length));
				if (
					!c ||
					typeof c !== "object" ||
					Array.isArray(c) ||
					!exactKeys(c, CANDIDATE_KEYS) ||
					typeof c.scheduleKey !== "string" ||
					!HEX.test(c.scheduleKey) ||
					c.findingId !== rootCauseFindingId(c.scheduleKey) ||
					c.ref !== rootCauseRef(c.scheduleKey) ||
					typeof c.identifier !== "string" ||
					!IDENTIFIER.test(c.identifier) ||
					candidates.some((p) => p.scheduleKey === c.scheduleKey)
				)
					errors.push("root_cause_candidate_invalid");
				else candidates.push(c);
			} catch {
				errors.push("root_cause_candidate_invalid");
			}
		} else if (line.startsWith("ROOT_CAUSE_DISPOSITION ")) {
			try {
				const d = JSON.parse(line.slice("ROOT_CAUSE_DISPOSITION ".length));
				if (
					!d ||
					typeof d !== "object" ||
					Array.isArray(d) ||
					!exactKeys(d, DISPOSITION_KEYS) ||
					typeof d.scheduleKey !== "string" ||
					dispositions.has(d.scheduleKey)
				)
					errors.push("root_cause_disposition_invalid");
				else dispositions.set(d.scheduleKey, d);
			} catch {
				errors.push("root_cause_disposition_invalid");
			}
		} else if (line.startsWith("FINDING ")) {
			const f = fieldsOf(line);
			if (!f.evidence?.startsWith("rootcause:")) continue;
			const key = f.evidence.slice("rootcause:".length);
			if (findings.has(key)) errors.push("root_cause_finding_duplicate");
			findings.set(key, f);
		}
	}
	const parsed = {
		review,
		candidates,
		dispositions,
		findings,
		project,
		lead,
		step6,
	};
	const scope = rootCauseScope(project, lead);
	const observed = Date.parse(review.observed_at ?? "");
	if (
		review.parent !== ROOT_CAUSE_PARENT_IDENTIFIER ||
		!Number.isFinite(observed)
	)
		errors.push("root_cause_review_invalid");
	if (review.status === "not_applicable") {
		if (!scope || review.token !== scope)
			errors.push("root_cause_scope_mismatch");
	} else if (scope) {
		errors.push("root_cause_scope_mismatch");
	}
	if (review.status === "unavailable") {
		if (
			!/^[a-z0-9_]+$/.test(review.token ?? "") ||
			!lines.includes(
				`UNAVAILABLE_CAUSE step=6 class=transient token=${ROOT_CAUSE_UNAVAILABLE_TOKEN}`,
			) ||
			step6 === "OK"
		)
			errors.push("root_cause_unavailable_invalid");
	}
	if (review.status !== "complete") {
		if (candidates.length || dispositions.size || findings.size)
			errors.push("root_cause_unexpected_disposition");
		if (!["not_applicable", "unavailable"].includes(review.status ?? ""))
			errors.push("root_cause_review_invalid");
		return { errors: [...new Set(errors)], parsed };
	}
	const digest = rootCauseSourceDigest(candidates);
	if (
		review.source_digest !== digest ||
		review.count !== String(candidates.length)
	)
		errors.push("root_cause_digest_mismatch");
	if (candidates.length > 0 && step6 !== "FINDING")
		errors.push("root_cause_step_status");
	const keys = new Set(candidates.map((c) => c.scheduleKey));
	for (const key of [...findings.keys(), ...dispositions.keys()])
		if (!keys.has(key)) errors.push("root_cause_orphan_disposition");
	for (const c of candidates) {
		const f = findings.get(c.scheduleKey);
		const d = dispositions.get(c.scheduleKey);
		if (!f || !d) {
			errors.push("root_cause_disposition_missing");
			continue;
		}
		if (
			f.id !== c.findingId ||
			f.category !== "incident" ||
			f.step !== "6" ||
			f.bridge_problem !== "no" ||
			f.result !== "escalated-with-plan" ||
			f.disposition_ref !== c.ref ||
			!OWNER.test(f.owner ?? "") ||
			!["route:rootcause-schedule", "inspect:rootcause-schedule"].includes(
				f.next ?? "",
			) ||
			f.epic !== "n/a" ||
			f.epic_marker !== "n/a"
		)
			errors.push("root_cause_finding_invalid");
		if (
			d.ref !== c.ref ||
			d.findingId !== c.findingId ||
			d.sourceDigest !== review.source_digest
		)
			errors.push("root_cause_disposition_mismatch");
		const ids = [d.askId, d.threadId, d.messageId];
		if (d.mode === "reported" || d.mode === "waiting_founder") {
			if (
				typeof d.askId !== "string" ||
				!UUID.test(d.askId) ||
				typeof d.threadId !== "string" ||
				!SNOWFLAKE.test(d.threadId) ||
				typeof d.messageId !== "string" ||
				!SNOWFLAKE.test(d.messageId) ||
				(d.reason !== null && typeof d.reason !== "string") ||
				(d.owner !== null && d.owner !== "founder") ||
				d.nextReviewAt !== null
			)
				errors.push("root_cause_ask_reference_invalid");
		} else if (d.mode === "scheduled") {
			const next = Date.parse(
				typeof d.nextReviewAt === "string" ? d.nextReviewAt : "",
			);
			if (
				!prose(d.reason) ||
				typeof d.owner !== "string" ||
				!OWNER.test(d.owner) ||
				f.owner !== d.owner ||
				!Number.isFinite(next) ||
				next <= observed ||
				next > observed + ROOT_CAUSE_SCHEDULE_MAX_MS ||
				!(
					ids.every((v) => v === null) ||
					(typeof d.askId === "string" &&
						UUID.test(d.askId) &&
						typeof d.threadId === "string" &&
						SNOWFLAKE.test(d.threadId) &&
						typeof d.messageId === "string" &&
						SNOWFLAKE.test(d.messageId))
				)
			)
				errors.push("root_cause_schedule_invalid");
		} else errors.push("root_cause_disposition_invalid");
	}
	return { errors: [...new Set(errors)], parsed };
}

export interface RootCauseAskRecord {
	ask_id: string;
	project_name: string;
	lead_id: string;
	thread_id: string;
	message_id: string | null;
	asked_at: string;
	settled_at: string | null;
	settled_by: string | null;
	patrol_schedule_key?: string | null;
}

/**
 * Trusted evidence checks: real founder_ask rows (bound by the send path, not
 * by the model), current time, and — on the shell path — a fresh collection so
 * a Lead-edited report cannot hide a still-open category.
 */
export function verifyRootCauseEvidence(
	text: string,
	context: {
		getAsk(askId: string): RootCauseAskRecord | undefined;
		nowMs: number;
		fresh?: RootCauseFacts;
	},
): { valid: boolean; errors: string[] } {
	const structure = validateRootCauseStructure(text);
	const errors = [...structure.errors];
	const parsed = structure.parsed;
	if (!parsed) return { valid: false, errors };
	const status = parsed.review.status;
	const observed = Date.parse(parsed.review.observed_at ?? "");
	if (context.fresh && status !== "not_applicable") {
		const fresh = context.fresh;
		if (fresh.status === "complete") {
			const keys = new Set(parsed.candidates.map((c) => c.scheduleKey));
			if (
				status !== "complete" ||
				fresh.candidates.some((c) => !keys.has(c.scheduleKey))
			)
				errors.push("root_cause_snapshot_stale");
		} else if (status === "complete")
			errors.push("root_cause_verifier_unavailable");
	}
	if (status === "complete")
		for (const c of parsed.candidates) {
			const d = parsed.dispositions.get(c.scheduleKey);
			if (!d) continue;
			if (
				d.mode === "scheduled" &&
				!(Date.parse(d.nextReviewAt ?? "") > context.nowMs)
			)
				errors.push("root_cause_schedule_expired");
			if (typeof d.askId !== "string") continue;
			const ask = context.getAsk(d.askId);
			const bound =
				!!ask &&
				ask.project_name === parsed.project &&
				ask.lead_id === parsed.lead &&
				ask.patrol_schedule_key === c.scheduleKey &&
				ask.thread_id === d.threadId &&
				!!ask.message_id &&
				ask.message_id === d.messageId;
			if (!bound) {
				errors.push("root_cause_ask_unbound");
				continue;
			}
			if (
				ask.settled_by === "send_failed" ||
				ask.settled_by === "lead_withdrawn"
			)
				errors.push("root_cause_ask_not_delivered");
			if (d.mode === "reported" && !(Date.parse(ask.asked_at) >= observed))
				errors.push("root_cause_report_not_this_round");
			if (d.mode === "waiting_founder" && ask.settled_at !== null)
				errors.push("root_cause_waiting_settled");
		}
	const unique = [...new Set(errors)];
	return { valid: unique.length === 0, errors: unique };
}

const SCHEDULE_IDENTITY_QUERY = `query RootCauseScheduleIdentity($id: String!) {
 issue(id: $id) { id identifier title description parent { id identifier } }
}`;

/**
 * Send-path identity: the server re-reads the category child and computes the
 * schedule key itself, so a model can never bind an ask to a key it chose.
 */
export async function resolveRootCauseScheduleIdentity(input: {
	request: LinearRequest;
	issueUuid: string;
	projectName: string;
	leadId: string;
}): Promise<{ scheduleKey: string; identifier: string; parentUuid: string }> {
	if (rootCauseScope(input.projectName, input.leadId))
		throw new RootCauseSourceError("patrol_schedule_scope");
	if (!UUID.test(input.issueUuid))
		throw new RootCauseSourceError("patrol_schedule_issue_invalid");
	let response: {
		data?: {
			issue?: {
				id?: unknown;
				identifier?: unknown;
				title?: unknown;
				description?: unknown;
				parent?: { id?: unknown; identifier?: unknown } | null;
			} | null;
		};
	};
	try {
		response = await input.request(SCHEDULE_IDENTITY_QUERY, {
			id: input.issueUuid,
		});
	} catch {
		throw new RootCauseSourceError("linear_request_failed");
	}
	const issue = response?.data?.issue;
	if (
		!issue ||
		issue.id !== input.issueUuid ||
		typeof issue.identifier !== "string" ||
		!IDENTIFIER.test(issue.identifier) ||
		typeof issue.title !== "string" ||
		(issue.description !== null && typeof issue.description !== "string") ||
		issue.parent?.identifier !== ROOT_CAUSE_PARENT_IDENTIFIER ||
		typeof issue.parent.id !== "string" ||
		!UUID.test(issue.parent.id)
	)
		throw new RootCauseSourceError("patrol_schedule_not_category");
	const meta = parseRootCauseMetadata(
		issue.title,
		(issue.description as string | null) ?? null,
	);
	if (!meta.category)
		throw new RootCauseSourceError("patrol_schedule_not_category");
	return {
		identifier: issue.identifier,
		parentUuid: issue.parent.id,
		scheduleKey: rootCauseScheduleKey({
			projectName: input.projectName,
			parentUuid: issue.parent.id,
			childUuid: input.issueUuid,
			classKey: meta.classKey,
		}),
	};
}
