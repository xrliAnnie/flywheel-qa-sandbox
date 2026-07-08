/**
 * BriefingEngine (FLY-967) — the "she never has to prime the assistant" piece.
 *
 * A background loop pre-generates a meeting briefing (board snapshot, recent
 * decisions, doc digests) and caches it to disk; `compose()` is memory-only so
 * /gemini opens with ZERO wait. A failing refresh keeps the previous snapshot —
 * data-source trouble must never block a meeting; it only ages the briefing,
 * which `stale` surfaces so the session can post a "briefing may lag" notice.
 *
 * Data source is the Bridge's read-only issues proxy, injected as a plain
 * function so tests mock HTTP without a server. docs[] are repo-relative and
 * validated against projectRoot at construction (path traversal fail-fast).
 */
import {
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";

export interface BriefingConfig {
	/** background refresh cadence (seconds). */
	refreshSec: number;
	/** snapshot older than this is served STALE (still served — never blocks). */
	maxAgeSec: number;
	/** total character budget; each of the 4 sections gets floor(budget/4). */
	charBudget: number;
	/** repo-relative doc paths digested into the briefing. */
	docs: string[];
}

export interface BoardIssue {
	identifier: string;
	title: string;
	state: string;
	updatedAt: string;
}

export interface IssuesPage {
	issues: BoardIssue[];
	truncated: boolean;
}

export interface BriefingEngineOptions {
	projectName: string;
	projectRoot: string;
	config: BriefingConfig;
	/** cache file location (voice-briefing-<project>.cache.json). */
	cachePath: string;
	/** Bridge GET /api/linear/issues proxy; `states` are Linear state TYPES. */
	fetchIssues(params: { states: string[]; limit: number }): Promise<IssuesPage>;
	log?: (line: string) => void;
}

export interface BriefingResult {
	text: string;
	generatedAt: string | null;
	stale: boolean;
}

interface DocDigest {
	name: string;
	excerpt: string;
}

interface BriefingSnapshot {
	generatedAt: string;
	board: BoardIssue[];
	decisions: BoardIssue[];
	decisionsTruncated: boolean;
	docs: DocDigest[];
}

const DECISION_WINDOW_DAYS = 14;
const DECISION_CAP = 15;
const FETCH_LIMIT = 50;
const DOC_EXCERPT_CAP = 1200;

export class BriefingEngine {
	private snapshot: BriefingSnapshot | null = null;
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly docPaths: { rel: string; abs: string }[];
	private readonly docMtimes = new Map<string, number>();
	/** observability: how many actual doc reads happened (mtime-gated). */
	docReadCount = 0;

	constructor(private readonly opts: BriefingEngineOptions) {
		const rootAbs = resolve(opts.projectRoot);
		this.docPaths = opts.config.docs.map((rel) => {
			const abs = resolve(rootAbs, rel);
			if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
				throw new Error(
					`briefing docs[] entry "${rel}" resolves outside projectRoot — refusing (path traversal)`,
				);
			}
			return { rel, abs };
		});
	}

	/** load cache, kick an immediate refresh, then refresh on an interval. */
	start(): void {
		this.loadCache();
		void this.refresh();
		this.timer = setInterval(
			() => void this.refresh(),
			this.opts.config.refreshSec * 1000,
		);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** read the on-disk snapshot (corrupt/missing cache is a non-event). */
	loadCache(): void {
		try {
			const raw = readFileSync(this.opts.cachePath, "utf8");
			const parsed = JSON.parse(raw) as BriefingSnapshot;
			if (parsed && typeof parsed.generatedAt === "string") {
				this.snapshot = parsed;
			}
		} catch {
			// no cache yet (or unreadable) — the immediate refresh will build one.
		}
	}

	/** memory-only assembly — zero IO, zero waiting (the /gemini opening path). */
	compose(topic?: string): BriefingResult {
		const snap = this.snapshot;
		if (!snap) {
			return {
				text: "[简报不可用——尚无缓存,首次刷新完成前请以工具查询为准]",
				generatedAt: null,
				stale: true,
			};
		}
		const perSection = Math.floor(this.opts.config.charBudget / 4);
		const hhmm = toHHMM(snap.generatedAt);
		const parts: string[] = [`[简报生成时间 ${hhmm}]`];

		// ① board snapshot, grouped by state name in first-seen order
		const groups = new Map<string, string[]>();
		for (const i of snap.board) {
			const lines = groups.get(i.state) ?? [];
			lines.push(`- ${i.identifier} ${i.title}`);
			groups.set(i.state, lines);
		}
		const boardBody = [...groups.entries()]
			.map(([state, lines]) => `### ${state}\n${lines.join("\n")}`)
			.join("\n");
		parts.push(`## Board 快照\n${truncate(boardBody, perSection)}`);

		// ② topic hits promoted (v1 就近取材 — substring over title/identifier)
		if (topic?.trim()) {
			const needle = topic.trim().toLowerCase();
			const hits = snap.board.filter(
				(i) =>
					i.title.toLowerCase().includes(needle) ||
					i.identifier.toLowerCase().includes(needle),
			);
			if (hits.length > 0) {
				const body = hits
					.map((i) => `- ${i.identifier} ${i.title}(${i.state})`)
					.join("\n");
				parts.push(`## 相关 issue\n${truncate(body, perSection)}`);
			}
		}

		// ③ recent decisions
		const decisionLines = snap.decisions.map(
			(i) => `- ${i.identifier} ${i.title}`,
		);
		if (snap.decisionsTruncated) decisionLines.push("(决策列表可能不全)");
		parts.push(
			`## 最近决策(近 ${DECISION_WINDOW_DAYS} 天)\n${truncate(decisionLines.join("\n"), perSection)}`,
		);

		// ④ doc digests
		const docsBody = snap.docs
			.map((d) => `### ${d.name}\n${d.excerpt}`)
			.join("\n");
		parts.push(`## 文档要点\n${truncate(docsBody, perSection)}`);

		const ageMs = Date.now() - Date.parse(snap.generatedAt);
		return {
			text: truncate(parts.join("\n"), this.opts.config.charBudget),
			generatedAt: snap.generatedAt,
			stale: ageMs > this.opts.config.maxAgeSec * 1000,
		};
	}

	/** rebuild the snapshot; failures keep the old one and are logged loudly. */
	async refresh(): Promise<void> {
		try {
			const [boardPage, donePage] = await Promise.all([
				this.opts.fetchIssues({
					states: ["started", "unstarted"],
					limit: FETCH_LIMIT,
				}),
				this.opts.fetchIssues({ states: ["completed"], limit: FETCH_LIMIT }),
			]);
			const cutoff = Date.now() - DECISION_WINDOW_DAYS * 24 * 3600 * 1000;
			const inWindow = donePage.issues.filter(
				(i) => Date.parse(i.updatedAt) >= cutoff,
			);
			const snapshot: BriefingSnapshot = {
				generatedAt: new Date().toISOString(),
				board: boardPage.issues,
				decisions: inWindow.slice(0, DECISION_CAP),
				// route-truncated OR window/cap dropped items → the list may be partial
				decisionsTruncated:
					donePage.truncated || inWindow.length > DECISION_CAP,
				docs: this.readDocs(),
			};
			this.writeCache(snapshot);
			this.snapshot = snapshot;
		} catch (err) {
			this.opts.log?.(
				`[briefing] briefing refresh failed (keeping previous snapshot): ${String(
					(err as Error).message ?? err,
				)}`,
			);
		}
	}

	/** mtime-gated doc reads; unchanged files reuse the last digest. */
	private readDocs(): DocDigest[] {
		const prev = new Map(this.snapshot?.docs.map((d) => [d.name, d]) ?? []);
		const out: DocDigest[] = [];
		for (const { rel, abs } of this.docPaths) {
			try {
				const mtime = statSync(abs).mtimeMs;
				const cached = prev.get(rel);
				if (cached && this.docMtimes.get(abs) === mtime) {
					out.push(cached);
					continue;
				}
				const excerpt = readFileSync(abs, "utf8").slice(0, DOC_EXCERPT_CAP);
				this.docReadCount++;
				this.docMtimes.set(abs, mtime);
				out.push({ name: rel, excerpt });
			} catch (err) {
				this.opts.log?.(
					`[briefing] doc "${rel}" unreadable, skipped: ${String((err as Error).message ?? err)}`,
				);
			}
		}
		return out;
	}

	private writeCache(snapshot: BriefingSnapshot): void {
		mkdirSync(dirname(this.opts.cachePath), { recursive: true });
		const tmp = `${this.opts.cachePath}.tmp`;
		writeFileSync(tmp, JSON.stringify(snapshot));
		renameSync(tmp, this.opts.cachePath);
	}
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

function toHHMM(iso: string): string {
	const d = new Date(iso);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
