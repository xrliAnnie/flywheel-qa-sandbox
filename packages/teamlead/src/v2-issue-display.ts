/**
 * FLY-1549: the v2 pure-derivation module for the FLY-907 three display
 * surfaces (title badge / pinned pipeline header / status vocabulary), ported
 * onto the v2 DAG state model. Zero I/O — every input is a plain snapshot the
 * caller read from the v2 kernel; lifecycle events only TRIGGER a refresh,
 * the content is always derived from real state (founder ruling on FLY-907).
 *
 * Surface C (the three-segment status line) is carried by the pinned header
 * per the FLY-907 final form (implementation note §5.3, lead directive
 * `17ab4f53`): status converges into the ONE pinned block, no scattered
 * status-line messages. The vocabulary is the v1 `PHASE_DISPLAY_GLYPHS`
 * export, reused verbatim so both sides speak identical founder language.
 */

import { createHash } from "node:crypto";
import {
	PHASE_THREAD_BADGE,
	PHASE_THREAD_BADGE_PARTS,
	renderRunnerModelDisplay,
} from "flywheel-config";
import {
	PHASE_DISPLAY_GLYPHS,
	type PhaseDisplayState,
} from "./bridge/issue-display.js";

/** One v2 DAG task as the display cares about it (topo-ordered by caller). */
export interface V2TaskDisplayView {
	taskId: string;
	kind: string;
	/** tasks.state: draft|ready|running|blocked|review|done|canceled */
	state: string;
	/** Total attempts ever made — distinguishes fresh `ready` (pending) from a
	 * rework/reap re-queue (active — FLY-543 rollback semantics). */
	attemptCount: number;
	/** The task's most relevant attempt: the active one if present, else the
	 * latest terminal one. */
	attempt?: {
		attemptId: string;
		desiredState: string;
		terminalReason?: string;
		vendor?: string;
		/** attempts.model — rendered via the FLY-1255 vendor-neutral display. */
		model?: string;
		/** The active activation's session_ref — the v2 exec identity and the
		 * tmux attach anchor (FLY-1543). */
		sessionRef?: string;
	};
}

export interface V2ShipGateView {
	/** ship_gate meta state: open|approved|rejected|expired */
	state: string;
	pr?: number;
	repo?: string;
	head?: string;
	/** True once the merge action settled (settled.merged_sha recorded). */
	settled: boolean;
}

export interface V2IssueDisplaySnapshot {
	issueId: string;
	/** Topological order (dependency-first); ties broken by created_at, id. */
	tasks: V2TaskDisplayView[];
	gate?: V2ShipGateView;
	/** issue_closure meta state: running|done|failed */
	closure?: string;
}

const TASK_DONE_STATES: ReadonlySet<string> = new Set(["done"]);
const TASK_BLOCKED_STATES: ReadonlySet<string> = new Set([
	"blocked",
	"canceled",
]);
const TASK_PENDING_STATES: ReadonlySet<string> = new Set(["draft"]);

/**
 * Plan §2a — the v2 analogue of the v1 `derivePhaseDisplayState` mapping
 * table. v2 has no park concept: the rework/wake rollback (FLY-543) shows up
 * as the task being put back to `ready` with prior attempts, which must read
 * as ▶ active — never as a premature ✅ and never as ◾ untouched.
 */
export function deriveV2TaskDisplayState(
	task: Pick<V2TaskDisplayView, "state" | "attemptCount">,
): PhaseDisplayState {
	if (TASK_DONE_STATES.has(task.state)) return "done";
	if (TASK_BLOCKED_STATES.has(task.state)) return "blocked";
	if (TASK_PENDING_STATES.has(task.state)) return "pending";
	if (task.state === "ready" && task.attemptCount === 0) return "pending";
	// ready-with-history, running, review, and any unknown future state: the
	// node has a live claim on the issue — conservative ▶ (mirrors v1).
	return "active";
}

/**
 * Node-kind → title badge. The engineering trio reuses the Annie-locked
 * `PHASE_THREAD_BADGE` glyphs verbatim (🎨设计 / 🔨实现 / 🧪QA); the other
 * first-class node kinds (.flywheel/agents/nodes/*.md) get stable extensions
 * from the existing stage-emoji family. Unknown kinds fall back to
 * `🔨<kind>` — the DAG kind set is open, the display must not hard-fail.
 */
export const V2_KIND_BADGE: Readonly<Record<string, string>> = {
	design: PHASE_THREAD_BADGE.design,
	design_iterate: PHASE_THREAD_BADGE.design,
	implement: PHASE_THREAD_BADGE.implement,
	build: PHASE_THREAD_BADGE.implement,
	generic: PHASE_THREAD_BADGE.implement,
	qa: PHASE_THREAD_BADGE.qa,
	research: "🧠调研",
	produce: "📝产出",
	review: "👀审阅",
};

export const V2_COMPLETED_BADGE = "✅完成";
export const V2_BLOCKED_BADGE = "🔴受阻";
export const V2_PR_READY_BADGE = "📬待批";

export function v2KindBadge(kind: string): string {
	return V2_KIND_BADGE[kind] ?? `🔨${kind}`;
}

/** Header row label word (the badge minus its emoji): 设计 / 实现 / QA / … */
export function v2KindLabel(kind: string): string {
	switch (kind) {
		case "design":
		case "design_iterate":
			return PHASE_THREAD_BADGE_PARTS.design.word;
		case "implement":
		case "build":
		case "generic":
			return PHASE_THREAD_BADGE_PARTS.implement.word;
		case "qa":
			return PHASE_THREAD_BADGE_PARTS.qa.word;
		case "research":
			return "调研";
		case "produce":
			return "产出";
		case "review":
			return "审阅";
		default:
			return kind;
	}
}

/**
 * Plan §2b — issue-level title badge, precedence top-down. Returns null when
 * the snapshot has no tasks (nothing to say — face A noops).
 */
export function deriveV2IssueTitleBadge(
	snapshot: V2IssueDisplaySnapshot,
): string | null {
	// Codex design R1 #2: closure runs only AFTER the gate settled
	// (closure.ts) — a failed closure is the LATEST fact and must outrank
	// gate.settled, or `settled + closure.failed` would read ✅完成.
	if (snapshot.closure === "failed") return V2_BLOCKED_BADGE;
	if (snapshot.closure === "done" || snapshot.gate?.settled) {
		return V2_COMPLETED_BADGE;
	}
	if (snapshot.tasks.length === 0) return null;
	const states = snapshot.tasks.map((task) => deriveV2TaskDisplayState(task));
	if (states.includes("blocked")) return V2_BLOCKED_BADGE;
	const allDone = states.every((state) => state === "done");
	if (allDone && snapshot.gate) {
		if (snapshot.gate.state === "open" || snapshot.gate.state === "approved") {
			return V2_PR_READY_BADGE;
		}
		// rejected = the founder said no (pre-rework instant); expired with
		// everything still done = ship retry exhaustion (reconcile.ts) — both
		// are 受阻. A rework-expired gate has tasks back at ready, so it never
		// reaches this branch (Codex design R1 #2).
		if (
			snapshot.gate.state === "rejected" ||
			snapshot.gate.state === "expired"
		) {
			return V2_BLOCKED_BADGE;
		}
	}
	let lastActive = -1;
	for (let index = 0; index < states.length; index += 1) {
		if (states[index] === "active") lastActive = index;
	}
	if (lastActive >= 0) {
		const active = snapshot.tasks[lastActive];
		return active ? v2KindBadge(active.kind) : null;
	}
	// Handoff gap: the node before the first pending; degenerate all-pending
	// → the first node; all-done with no (live) gate → the last node.
	const firstPending = states.indexOf("pending");
	const anchorIndex =
		firstPending === -1
			? snapshot.tasks.length - 1
			: Math.max(firstPending - 1, 0);
	const anchor = snapshot.tasks[anchorIndex];
	return anchor ? v2KindBadge(anchor.kind) : null;
}

/** Discord thread-name budget (mirrors v1 DISCORD_THREAD_NAME_MAX). */
export const V2_THREAD_NAME_MAX = 100;

/** Every fixed badge this module can ever stamp. Fallback badges
 * (`🔨<kind>`) are issue-specific — callers pass them via `selfBadges`. */
const V2_FIXED_BADGES: ReadonlySet<string> = new Set([
	...Object.values(V2_KIND_BADGE),
	V2_COMPLETED_BADGE,
	V2_BLOCKED_BADGE,
	V2_PR_READY_BADGE,
]);

/** The set of badges this ISSUE could have self-stamped — the exact tokens
 * the restamp may strip. Codex design R2 #3: matching "any badge emoji plus
 * any glued word" ate founder tokens like `✅P0`; only complete, known
 * self-managed badges may be stripped. */
export function v2SelfBadges(
	snapshot: Pick<V2IssueDisplaySnapshot, "tasks">,
): ReadonlySet<string> {
	const badges = new Set<string>(V2_FIXED_BADGES);
	for (const task of snapshot.tasks) badges.add(v2KindBadge(task.kind));
	return badges;
}

/**
 * Strip-and-restamp for the v2 thread title, v1 contract semantics: strip
 * ONLY a complete self-managed badge token (exact match against the fixed
 * badge set, the issue's own kind badges, and the badge being stamped),
 * preserve every other human-written character, compose within the 100-char
 * thread-name budget. Idempotent for an equal badge.
 */
export function applyV2TitleBadge(
	currentName: string,
	badge: string,
	selfBadges: ReadonlySet<string> = V2_FIXED_BADGES,
): string {
	let base = currentName.trim();
	const firstToken = base.split(/\s+/u, 1)[0] ?? "";
	if (
		firstToken.length > 0 &&
		(V2_FIXED_BADGES.has(firstToken) ||
			selfBadges.has(firstToken) ||
			firstToken === badge)
	) {
		base = base.slice(firstToken.length).replace(/^\s+/u, "");
	}
	const composed = base.length > 0 ? `${badge} ${base}` : badge;
	return Array.from(composed).slice(0, V2_THREAD_NAME_MAX).join("");
}

/* ------------------------------------------------------------------------- *
 * v2 runner tmux naming — the SESSION name is a single source shared with the
 * v2-host launcher (tmux-runner-launcher.ts imports it; drift would render
 * dead attach links, PRD Step 3). The WINDOW name is owned by the launcher's
 * `workspaceWindowName()` (FLY-1550 founder-facing cmux workspace title); the
 * cross-wire guard below keys on the `${issueId}-` prefix that
 * `buildWindowLabel()` (flywheel-core) structurally guarantees and
 * `sanitizeTmuxName()` head-first truncation preserves.
 * ------------------------------------------------------------------------- */

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** `v2-<sha256(sessionRef)[:32]>` — the launcher's tmux session name. */
export function v2RunnerTmuxSessionName(sessionRef: string): string {
	return `v2-${sha256Hex(sessionRef).slice(0, 32)}`;
}

/**
 * Identifier-prefix cross-wire guard (PRD Step 3, v2 form): a resolvable
 * window whose name does not carry this issue's identifier prefix belongs to
 * another issue — the attach command must be withheld. Accepts both the
 * FLY-1550 workspace title form (`<issueId>-<runner>-<title>`) and the
 * pre-FLY-1550 launcher form (`v2-<issueId>-<kind>-<sha8>`) so live windows
 * spawned before the naming cutover keep their links. The trailing dash keeps
 * `FLY-154` from matching a `FLY-1549-…` window. Missing anchors pass (no new
 * false kills).
 */
export function v2WindowMatchesIssue(
	issueId: string,
	windowName: string | null | undefined,
): boolean {
	if (!issueId || !windowName) return true;
	return (
		windowName.startsWith(`${issueId}-`) ||
		windowName.startsWith(`v2-${issueId}-`)
	);
}

/** The rendered attach command for a v2 runner session. */
export function v2AttachCommand(sessionRef: string): string {
	return `env -u TMUX tmux attach -t '=${v2RunnerTmuxSessionName(sessionRef)}'`;
}

/* ------------------------------------------------------------------------- *
 * Face B — pinned pipeline header
 * ------------------------------------------------------------------------- */

export interface V2HeaderRow {
	view: V2TaskDisplayView;
	state: PhaseDisplayState;
	/** Attach rendering for active rows: a resolved command, or unresolved
	 * (no live tmux session yet / cross-wire withheld). */
	attach?: { command?: string; unresolved?: boolean };
}

const HEADER_FOOTER = "_自动更新:各节点状态与终端入口,置顶一条看全。_";

/** Repo-wide single-Discord-message budget (mirrors discord-utils). A legal
 * DAG admits up to 500 tasks; the header must stay one editable pinned
 * message for EVERY legal DAG or face B fails forever and the fingerprint
 * never lands (Codex design R1 #5). */
export const V2_HEADER_BUDGET_CHARS = 1900;

/** Kind labels are unbounded strings from the DAG — clamp for display. */
const HEADER_LABEL_MAX = 24;

function renderHeaderRowBlock(row: V2HeaderRow): string[] {
	const rawLabel = v2KindLabel(row.view.kind);
	const label =
		rawLabel.length > HEADER_LABEL_MAX
			? `${rawLabel.slice(0, HEADER_LABEL_MAX - 1)}…`
			: rawLabel;
	const glyph = PHASE_DISPLAY_GLYPHS[row.state];
	let head = `**[${label}]** ${glyph}`;
	const attempt = row.view.attempt;
	if (row.state !== "pending" && attempt) {
		head += ` · attempt \`${attempt.attemptId.slice(0, 8)}\``;
		// FLY-1255 vendor-neutral model display (lead pointer, Annie: "看不到
		// 底下的模型是什么"): reuse the shared pure renderer — Claude keeps its
		// F/O/S/H tier codes, curated non-Claude families fold to G/K, anything
		// else shows the honest `Model <id>`. Vendor alone is the fallback.
		const modelDisplay = renderRunnerModelDisplay({
			vendor: attempt.vendor,
			model: attempt.model,
		});
		if (modelDisplay) head += ` · ${modelDisplay.threadMarker}`;
		else if (attempt.vendor) head += ` · ${attempt.vendor}`;
	}
	const block = [head];
	if (row.state === "active" && row.attach) {
		if (row.attach.command && !row.attach.unresolved) {
			block.push(`\`${row.attach.command}\``);
		} else {
			block.push("_(终端待解析)_");
		}
	}
	return block;
}

const GLYPH_SYMBOL: Record<PhaseDisplayState, string> = {
	done: "✅",
	active: "▶",
	pending: "◾",
	blocked: "🔴",
};

/**
 * Deterministic render within the single-message budget. Fast path: every
 * row verbatim. Over budget, the display contract (Codex design R2 #2) is:
 * rows are kept as FULL blocks in priority order blocked → active →
 * done/pending (topo order within each class) for as long as they fit; every
 * row that does not fit folds into ONE counted summary line (`▶×N` etc.), so
 * the header is always total and truthful — counts are never silently
 * dropped — even for a 500-active legal DAG, where only the topo-first
 * blocked/active blocks carry visible attach commands.
 */
export function renderV2PipelineHeader(
	issueId: string,
	rows: readonly V2HeaderRow[],
): string {
	const title = `📌 **[${issueId}] v2 流水线**`;
	const full = [
		title,
		...rows.flatMap((row) => renderHeaderRowBlock(row)),
		HEADER_FOOTER,
	].join("\n");
	if (full.length <= V2_HEADER_BUDGET_CHARS) return full;

	const summarized = new Map<PhaseDisplayState, number>();
	const addToSummary = (row: V2HeaderRow): void => {
		summarized.set(row.state, (summarized.get(row.state) ?? 0) + 1);
	};
	const summaryLine = (): string => {
		const parts = [...summarized.entries()].map(
			([state, count]) => `${GLYPH_SYMBOL[state]}×${count}`,
		);
		return `_…另 ${[...summarized.values()].reduce((a, b) => a + b, 0)} 节点:${parts.join(" · ")}_`;
	};
	const priority = (row: V2HeaderRow): number =>
		row.state === "blocked" ? 0 : row.state === "active" ? 1 : 2;
	// Collapse done/pending first; keep blocked/active in topo order.
	const keepOrder = rows
		.map((row, index) => ({ row, index }))
		.sort((a, b) => priority(a.row) - priority(b.row) || a.index - b.index);
	const overhead = `${title}\n${HEADER_FOOTER}`.length + 1;
	let used = overhead;
	const keptBlocks = new Map<number, string>();
	for (const entry of keepOrder) {
		const block = renderHeaderRowBlock(entry.row).join("\n");
		// +1 newline; assume worst-case summary line of ~64 chars stays fitted.
		if (used + block.length + 1 + 72 <= V2_HEADER_BUDGET_CHARS) {
			keptBlocks.set(entry.index, block);
			used += block.length + 1;
		} else {
			addToSummary(entry.row);
		}
	}
	const lines = [title];
	for (let index = 0; index < rows.length; index += 1) {
		const block = keptBlocks.get(index);
		if (block !== undefined) lines.push(block);
	}
	if (summarized.size > 0) lines.push(summaryLine());
	lines.push(HEADER_FOOTER);
	return lines.join("\n");
}

/* ------------------------------------------------------------------------- *
 * Fingerprint — derived-input hash; persisted ONLY after every enabled face
 * confirmed changed|noop (FLY-907 Codex R2 #2 write-confirmation contract).
 * ------------------------------------------------------------------------- */

/** Bump to force a one-time refresh of every issue on renderer changes.
 * v2: invalidates every pre-R3 fingerprint — R1-era code could persist an
 * fp with a posted-but-unpinned header (Codex design R3 #2). */
export const V2_DISPLAY_RENDER_VERSION = 2;

export function computeV2DisplayFingerprint(
	snapshot: V2IssueDisplaySnapshot,
	/** tmux probe outcomes keyed by session name; null = session absent. The
	 * probe is part of the derived input so CommDB-invisible drift (late
	 * window registration, corrected targets) re-triggers a write (v1 sweep
	 * layer-2 equivalent). */
	probes: Record<string, string | null>,
): string {
	return JSON.stringify({
		v: V2_DISPLAY_RENDER_VERSION,
		t: snapshot.tasks.map((task) => [
			task.taskId,
			task.kind,
			task.state,
			task.attemptCount,
			task.attempt?.attemptId ?? null,
			task.attempt?.desiredState ?? null,
			task.attempt?.terminalReason ?? null,
			task.attempt?.vendor ?? null,
			task.attempt?.model ?? null,
			task.attempt?.sessionRef ?? null,
		]),
		g: snapshot.gate
			? [
					snapshot.gate.state,
					snapshot.gate.repo ?? null,
					snapshot.gate.pr ?? null,
					snapshot.gate.head ?? null,
					snapshot.gate.settled,
				]
			: null,
		c: snapshot.closure ?? null,
		p: Object.keys(probes)
			.sort()
			.map((key) => [key, probes[key] ?? null]),
	});
}

/** True when the snapshot is terminal for display purposes: the sweep can
 * fully skip an issue whose fingerprint is current, terminal, and archived. */
export function isV2DisplayTerminal(snapshot: V2IssueDisplaySnapshot): boolean {
	return snapshot.closure === "done" || snapshot.closure === "failed";
}
