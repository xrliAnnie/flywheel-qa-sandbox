/**
 * FLY-795: the shared `progress.md` ledger schema — a LIGHT, agent-agnostic
 * execution-state cursor committed to the issue branch B.
 *
 * OWNERSHIP: FLY-795 owns the schema + location; FLY-793's three-stage
 * PhaseOrchestrator CONSUMES it at each phase handoff; FLY-799 aligns on the
 * same 甲 model. ONE schema, no divergence (do not build two).
 *
 * LIGHT by design (Annie's Q4 decision): the ledger records only the cursor
 * (phase + chunk statuses + next-step + doc pointers). The design rationale
 * (decisions / why / dead-ends) lives in the already-committed
 * plan.md / exploration.md on the same branch — NOT duplicated here.
 *
 * LAYERING: the Bridge StateStore is the sole authority for the pipeline stage;
 * `phase` here only REFERENCES that stage grouping (design/implement/qa), it is
 * never a second scheduler.
 *
 * FORMAT: a YAML frontmatter block (the authoritative, machine-parseable data)
 * followed by a rendered human-readable markdown body. `parseProgress` reads the
 * frontmatter only; the body is regenerated on every write and ignored on read.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ThreeStagePhase } from "./three-stage-phases.js";

/** Per-chunk lifecycle. `qa-pass`/`qa-fail` are set by the QA phase. */
export type ChunkStatus = "todo" | "doing" | "done" | "qa-pass" | "qa-fail";

const CHUNK_STATUSES: ReadonlySet<string> = new Set<ChunkStatus>([
	"todo",
	"doing",
	"done",
	"qa-pass",
	"qa-fail",
]);

const PHASES: ReadonlySet<string> = new Set<ThreeStagePhase>([
	"design",
	"implement",
	"qa",
]);

/**
 * FLY-795: map a fine-grained pipeline stage (the `flywheel-comm stage set`
 * vocabulary: started / onboard / brainstorm / … / ship / completed) to its
 * three-stage phase grouping, or undefined for an unknown stage. Shared so the
 * resume-detect side (teamlead cross-checks the StateStore stage vs the ledger
 * phase) and the write side (the `progress` command rejects a `--phase` that
 * contradicts the session's authoritative stage) use ONE mapping — no drift.
 */
const DESIGN_STAGES: ReadonlySet<string> = new Set([
	"started",
	"onboard",
	"brainstorm",
	"research",
	"plan",
	"design_review",
	"design_done",
	"design",
]);
const IMPLEMENT_STAGES: ReadonlySet<string> = new Set([
	"implement",
	"test",
	"code_review",
	"pr_created",
]);
const QA_STAGES: ReadonlySet<string> = new Set([
	"qa",
	"approve",
	"ship",
	"code_review_qa",
]);

export function stageToPhase(stage: string): ThreeStagePhase | undefined {
	if (DESIGN_STAGES.has(stage)) return "design";
	if (IMPLEMENT_STAGES.has(stage)) return "implement";
	if (QA_STAGES.has(stage)) return "qa";
	return undefined;
}

/** One planned unit of work within a phase. */
export interface ProgressChunk {
	id: string;
	order: number;
	/** ids of chunks this one depends on. */
	deps: string[];
	/** done criteria (short prose). */
	done: string;
	status: ChunkStatus;
}

/** Artifact pointers — where the rationale + outputs live (NOT duplicated here). */
export interface ProgressPointers {
	plan?: string;
	exploration?: string;
	research?: string;
	pr?: string;
	reviewedSha?: string;
}

/** The light execution-state cursor for one issue branch B. */
export interface ProgressLedger {
	/** issue identifier (e.g. FLY-795). */
	issue: string;
	title?: string;
	/** references the Bridge stage grouping (design/implement/qa); not authoritative. */
	phase: ThreeStagePhase;
	/** cursor within the phase, e.g. "3/5". */
	phaseCursor?: string;
	/** ISO timestamp; injected by the writer at commit time. */
	updated?: string;
	/** the N-chunk plan + per-chunk status. */
	chunks: ProgressChunk[];
	/** the single next concrete action. */
	nextStep?: string;
	pointers: ProgressPointers;
	/** per-boundary handoff payload (one/two lines) for the 793 phase handoff. */
	handoff?: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\s*(?:\n|$)/;

/** Serialize a ledger → `progress.md` string (YAML frontmatter + markdown body). */
export function renderProgress(ledger: ProgressLedger): string {
	const data = normalize(ledger);
	const frontmatter = stringifyYaml(data).trimEnd();
	const body = renderBody(data);
	return `---\n${frontmatter}\n---\n\n${body}\n`;
}

/**
 * Parse a `progress.md` string → ledger, reading the authoritative YAML
 * frontmatter only. Fail-loud (throws) when the blob has no frontmatter or the
 * required fields are missing/invalid — a resumed runner must never continue on
 * a silently-empty ledger.
 */
export function parseProgress(md: string): ProgressLedger {
	const m = FRONTMATTER_RE.exec(md);
	if (!m) {
		throw new Error(
			"progress.md: missing YAML frontmatter block (not a progress ledger)",
		);
	}
	const raw = parseYaml(m[1]!) as Record<string, unknown> | null;
	if (!raw || typeof raw !== "object") {
		throw new Error("progress.md: frontmatter did not parse to an object");
	}
	const issue = str(raw.issue);
	if (!issue) throw new Error("progress.md: missing required field `issue`");
	const phase = str(raw.phase);
	if (!phase || !PHASES.has(phase)) {
		throw new Error(
			`progress.md: invalid \`phase\` ${JSON.stringify(raw.phase)} (want design|implement|qa)`,
		);
	}
	return {
		issue,
		phase: phase as ThreeStagePhase,
		...(str(raw.title) && { title: str(raw.title) }),
		...(str(raw.phaseCursor) && { phaseCursor: str(raw.phaseCursor) }),
		...(str(raw.updated) && { updated: str(raw.updated) }),
		...(str(raw.nextStep) && { nextStep: str(raw.nextStep) }),
		...(str(raw.handoff) && { handoff: str(raw.handoff) }),
		chunks: parseChunks(raw.chunks),
		pointers: parsePointers(raw.pointers),
	};
}

// ── internals ──────────────────────────────────────────────────────

function normalize(ledger: ProgressLedger): Record<string, unknown> {
	const data: Record<string, unknown> = {
		issue: ledger.issue,
		phase: ledger.phase,
	};
	if (ledger.title) data.title = ledger.title;
	if (ledger.phaseCursor) data.phaseCursor = ledger.phaseCursor;
	if (ledger.updated) data.updated = ledger.updated;
	if (ledger.nextStep) data.nextStep = ledger.nextStep;
	data.chunks = ledger.chunks.map((c) => ({
		id: c.id,
		order: c.order,
		deps: c.deps ?? [],
		done: c.done,
		status: c.status,
	}));
	data.pointers = { ...ledger.pointers };
	if (ledger.handoff) data.handoff = ledger.handoff;
	return data;
}

function parseChunks(raw: unknown): ProgressChunk[] {
	if (raw == null) return [];
	if (!Array.isArray(raw)) {
		throw new Error("progress.md: `chunks` must be a list");
	}
	return raw.map((c, i) => {
		const o = (c ?? {}) as Record<string, unknown>;
		const id = str(o.id);
		if (!id) throw new Error(`progress.md: chunk[${i}] missing \`id\``);
		const status = str(o.status);
		if (!status || !CHUNK_STATUSES.has(status)) {
			throw new Error(
				`progress.md: chunk[${i}] invalid \`status\` ${JSON.stringify(o.status)}`,
			);
		}
		return {
			id,
			order: typeof o.order === "number" ? o.order : i + 1,
			deps: Array.isArray(o.deps) ? o.deps.map(String) : [],
			done: str(o.done) ?? "",
			status: status as ChunkStatus,
		};
	});
}

function parsePointers(raw: unknown): ProgressPointers {
	if (raw == null) return {};
	const o = raw as Record<string, unknown>;
	const p: ProgressPointers = {};
	for (const k of [
		"plan",
		"exploration",
		"research",
		"pr",
		"reviewedSha",
	] as const) {
		const v = str(o[k]);
		if (v) p[k] = v;
	}
	return p;
}

function renderBody(data: Record<string, unknown>): string {
	const issue = data.issue as string;
	const title = data.title ? ` — ${data.title as string}` : "";
	const cursor = data.phaseCursor ? ` (${data.phaseCursor as string})` : "";
	const lines: string[] = [`# ${issue} progress${title}`];
	lines.push(`**phase**: ${data.phase as string}${cursor}`);
	if (data.nextStep) lines.push(`**next**: ${data.nextStep as string}`);
	const chunks = (data.chunks as Array<Record<string, unknown>>) ?? [];
	if (chunks.length > 0) {
		lines.push("", "## chunks");
		for (const c of chunks) {
			lines.push(
				`- ${chunkMark(c.status as string)} ${c.id as string} — ${c.done as string}`,
			);
		}
	}
	if (data.handoff) lines.push("", `**handoff**: ${data.handoff as string}`);
	return lines.join("\n");
}

function chunkMark(status: string): string {
	switch (status) {
		case "done":
		case "qa-pass":
			return "✅";
		case "doing":
			return "🔨";
		case "qa-fail":
			return "🔴";
		default:
			return "⬜";
	}
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}
