/**
 * FLY-203: ReportRegistry — local source of truth for the remote report
 * pipeline's hosted set.
 *
 * The hosting model (validated by a real spike, see
 * doc/engineer/research/new/FLY-203-remote-report-pipeline.md §2.2) is a
 * single Vercel project where every report lives at an unguessable
 * `r/<128-bit-token>/index.html` path. Vercel production deploys REPLACE the
 * previous file set — any report omitted from a deploy dies. So the registry
 * keeps every retained report locally and each publish redeploys the full
 * retained set.
 *
 * Transaction contract (Codex design review R1#3 + R2#2 + R3#1):
 *   stagePublish() builds a pure in-memory staged view — token, the Vercel
 *   project name (existing committed value or a freshly generated one), the
 *   prune computation and the full deploy file list. ZERO fs mutation.
 *   - deploy fails  → abort(): disk untouched. On a first publish this means
 *     not even registry.json exists.
 *   - deploy works  → commit() in a FIXED order: ① write the new report file
 *     → ② atomically write registry.json (tmp + rename = the commit point)
 *     → ③ best-effort delete pruned files (failure = warn only).
 *     A failure before ② leaves the old registry + all pruned files intact;
 *     the orphan new file is harmless because deploys are registry-driven.
 *
 * Content hardening (R1#4 + R2#1): every staged report gets `noindex` and a
 * restrictive CSP meta injected into <head> when missing. HTML without a
 * <head> is REJECTED (ReportHtmlInvalidError → route 400) rather than hosted
 * unprotected.
 */

import { randomBytes } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const DEFAULT_RETENTION_MAX = 100;
// Leave headroom for the JSON envelope beneath Vercel's 10 MB body cap.
export const DEFAULT_RETENTION_BYTES = 8.5 * 1024 * 1024; // 8.5 MiB
/** Founder requirement (2026-06-04): report links expire after 7 days. */
export const DEFAULT_RETENTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";
const NOINDEX_META = '<meta name="robots" content="noindex">';
const CSP_META =
	"<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:;\">";

/**
 * Opt-in marker for interactive reports. A report generator that needs its OWN inline
 * `<script>` to run on the hosted page emits `<script nonce="__CSP_NONCE__">…</script>`.
 * injectHeadMeta then mints a real per-report nonce, swaps every placeholder for it, and
 * serves a CSP that allows exactly that nonce (`script-src 'nonce-…'`).
 *
 * SECURITY contract: this only gates the GENERATOR's own scripts. It is safe ONLY because
 * report generators HTML-escape untrusted content — an injected `<script>` in report content
 * is escaped to text and can never execute, regardless of the nonce. Inline event-handler
 * attributes (onclick=…) are NOT covered by a script nonce, so interactive reports must bind
 * handlers via addEventListener inside the nonced <script>.
 */
const NONCE_PLACEHOLDER = "__CSP_NONCE__";

/** CSP for reports that opt into scripts via the nonce placeholder (adds script-src). */
function cspMetaWithScriptNonce(nonce: string): string {
	return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:;">`;
}

/** Thrown when report HTML lacks a <head> — route layer maps this to 400. */
export class ReportHtmlInvalidError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReportHtmlInvalidError";
	}
}

export interface ReportEntry {
	token: string;
	projectName: string;
	title?: string;
	createdAt: string;
	/** Byte size of the hardened HTML — used for the bytes retention cap. */
	bytes: number;
}

interface ReportRegistryData {
	vercelProjectName?: string;
	reports: ReportEntry[];
}

export interface StagedPublish {
	entry: ReportEntry;
	/**
	 * Vercel project name for this deploy (R3#1: part of the transaction).
	 * Existing committed value, or a new in-memory `fw-reports-<6hex>` on a
	 * first publish. Persisted ONLY by commit().
	 */
	vercelProjectName: string;
	/** robots.txt + every retained report (incl. the new one) — pure memory. */
	deployFiles: { file: string; data: string }[];
	/** Call after deploy success. Fixed order: file → registry rename → prune. */
	commit(): void;
	/** Call after deploy failure. Disk stays untouched. */
	abort(): void;
}

export interface ReportRegistryOptions {
	retentionMax?: number;
	retentionBytes?: number;
	/** Max report age in ms (default 7 days). 0 disables age-based expiry. */
	retentionMaxAgeMs?: number;
	/** Clock seam for tests. Defaults to Date.now. */
	now?: () => number;
	/** Test seam — defaults to crypto.randomBytes hex. */
	randomHex?: (bytes: number) => string;
	/** Warn sink (defaults to console.warn) — test seam. */
	warn?: (msg: string) => void;
}

export class ReportRegistry {
	private readonly baseDir: string;
	private readonly filesDir: string;
	private readonly registryPath: string;
	private readonly retentionMax: number;
	private readonly retentionBytes: number;
	private readonly retentionMaxAgeMs: number;
	private readonly now: () => number;
	private readonly randomHex: (bytes: number) => string;
	private readonly warn: (msg: string) => void;

	constructor(baseDir: string, opts: ReportRegistryOptions = {}) {
		this.baseDir = baseDir;
		this.filesDir = join(baseDir, "files");
		this.registryPath = join(baseDir, "registry.json");
		this.retentionMax = opts.retentionMax ?? DEFAULT_RETENTION_MAX;
		this.retentionBytes = opts.retentionBytes ?? DEFAULT_RETENTION_BYTES;
		this.retentionMaxAgeMs =
			opts.retentionMaxAgeMs ?? DEFAULT_RETENTION_MAX_AGE_MS;
		this.now = opts.now ?? (() => Date.now());
		this.randomHex =
			opts.randomHex ?? ((n: number) => randomBytes(n).toString("hex"));
		this.warn = opts.warn ?? ((msg) => console.warn(msg));
	}

	/** Preview root — the CLI↔Bridge screenshot handoff contract directory. */
	previewsDir(): string {
		return join(this.baseDir, "previews");
	}

	/** Committed Vercel project name (undefined before the first successful publish). */
	vercelProjectName(): string | undefined {
		return this.load().vercelProjectName;
	}

	/** Committed retained entries, oldest first. */
	list(): ReportEntry[] {
		return this.load().reports;
	}

	/**
	 * Build the staged publish view. Pure in-memory — no fs mutation happens
	 * until commit(). Throws ReportHtmlInvalidError on HTML without <head>.
	 */
	stagePublish(
		projectName: string,
		html: string,
		title?: string,
	): StagedPublish {
		const hardened = injectHeadMeta(html);
		const committed = this.load();

		const vercelProjectName =
			committed.vercelProjectName ?? `fw-reports-${this.randomHex(3)}`;

		const entry: ReportEntry = {
			token: this.randomHex(16),
			projectName,
			title,
			createdAt: new Date(this.now()).toISOString(),
			bytes: Buffer.byteLength(hardened, "utf-8"),
		};

		// Prune in two passes; whichever rule hits first wins, they coexist.
		//
		// Pass 1 — TTL (founder requirement: links expire after 7 days).
		// Enforced LAZILY at publish time, hooked on this existing action per
		// the no-new-periodic-timer discipline (FLY-169): an expired link
		// dies at the NEXT publish, which redeploys without it. No publishes
		// → no redeploy → an expired link may outlive its TTL until one
		// happens; with normal report cadence that window is small.
		//
		// Pass 2 — count/bytes caps, oldest-first. The new entry is newest
		// so it always survives (single report ≤512KB ≪ bytes cap).
		const nowMs = this.now();
		const all: ReportEntry[] = [];
		const pruned: ReportEntry[] = [];
		for (const e of [...committed.reports, entry]) {
			const age = nowMs - Date.parse(e.createdAt);
			// >= : the expiry instant itself counts as expired (Codex R1 — with
			// lazy enforcement and an aligned publish cadence, a `>` here would
			// stretch an exactly-7-day-old link a full extra cycle).
			if (
				this.retentionMaxAgeMs > 0 &&
				Number.isFinite(age) &&
				age >= this.retentionMaxAgeMs
			) {
				pruned.push(e);
			} else {
				all.push(e);
			}
		}
		let totalBytes = all.reduce((s, e) => s + e.bytes, 0);
		while (
			all.length > this.retentionMax ||
			(totalBytes > this.retentionBytes && all.length > 1)
		) {
			const oldest = all.shift();
			if (!oldest) break;
			pruned.push(oldest);
			totalBytes -= oldest.bytes;
		}
		const retained = all;

		// Deploy file list: robots.txt + every retained report. The new
		// report's content comes from memory; committed ones from disk.
		const deployFiles: { file: string; data: string }[] = [
			{ file: "robots.txt", data: ROBOTS_TXT },
		];
		const missing: ReportEntry[] = [];
		for (const r of retained) {
			if (r.token === entry.token) {
				deployFiles.push({ file: `r/${r.token}/index.html`, data: hardened });
				continue;
			}
			try {
				const data = readFileSync(
					join(this.filesDir, `${r.token}.html`),
					"utf-8",
				);
				deployFiles.push({ file: `r/${r.token}/index.html`, data });
			} catch {
				// Local file vanished (disk damage). The link is dead at the next
				// deploy regardless — surface it loudly and drop the entry at
				// commit so the registry matches reality.
				this.warn(
					`[report-registry] retained report file missing for token=${r.token} — dropping entry at commit`,
				);
				missing.push(r);
			}
		}
		const finalRetained = retained.filter((r) => !missing.includes(r));

		let done = false;
		const commit = (): void => {
			if (done)
				throw new Error("[report-registry] commit/abort already called");
			done = true;
			// ① new report file
			mkdirSync(this.filesDir, { recursive: true });
			writeFileSync(
				join(this.filesDir, `${entry.token}.html`),
				hardened,
				"utf-8",
			);
			// ② registry.json atomic rename — THE commit point
			this.saveAtomic({
				vercelProjectName,
				reports: finalRetained,
			});
			// ③ best-effort prune deletion (after the rename, warn-only)
			for (const p of pruned) {
				try {
					rmSync(join(this.filesDir, `${p.token}.html`));
				} catch (err) {
					this.warn(
						`[report-registry] failed to delete pruned report file token=${p.token}: ${(err as Error).message}`,
					);
				}
			}
		};

		const abort = (): void => {
			if (done)
				throw new Error("[report-registry] commit/abort already called");
			done = true;
			// Nothing was written — staged view simply gets dropped.
		};

		return { entry, vercelProjectName, deployFiles, commit, abort };
	}

	// ── internals ─────────────────────────────────────────────────────────

	private load(): ReportRegistryData {
		let raw: string;
		try {
			raw = readFileSync(this.registryPath, "utf-8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return { reports: [] };
			}
			throw err;
		}
		// A corrupted registry must NOT be silently rebuilt — that would make
		// the next deploy omit (= kill) every retained report. Fail loudly.
		let data: unknown;
		try {
			data = JSON.parse(raw);
		} catch (err) {
			throw new Error(
				`[report-registry] registry.json is corrupted (${(err as Error).message}) — refusing to silently rebuild; fix or remove ${this.registryPath} manually`,
			);
		}
		const d = data as ReportRegistryData;
		if (!Array.isArray(d.reports)) {
			throw new Error(
				`[report-registry] registry.json has invalid shape — refusing to silently rebuild; fix or remove ${this.registryPath} manually`,
			);
		}
		return { vercelProjectName: d.vercelProjectName, reports: d.reports };
	}

	private saveAtomic(data: ReportRegistryData): void {
		mkdirSync(this.baseDir, { recursive: true });
		const tmp = `${this.registryPath}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`, "utf-8");
		renameSync(tmp, this.registryPath);
	}
}

/**
 * Harden report HTML: inject `noindex` + restrictive CSP meta into <head>
 * when the equivalent meta is absent. HTML without a <head> is rejected —
 * all real report-generation paths emit complete documents, and hosting an
 * unprotected fragment is worse than a 400 (Codex R2#1).
 *
 * "Already present" detection is scoped to the ACTUAL <head> content
 * (code review R1#1): reports embed issue/PR/user-controlled text, and a
 * body/pre/code snippet that merely *shows* a `<meta http-equiv=
 * "Content-Security-Policy">` tag must not suppress the real protective
 * injection — browsers don't apply body text as head policy.
 */
export function injectHeadMeta(
	html: string,
	nonceGen: () => string = () => randomBytes(16).toString("hex"),
): string {
	// Opt-in script execution (interactive reports): if the report embedded the nonce
	// placeholder, mint a real per-report nonce, stamp it onto the report's own
	// `<script nonce="…">` tags, and pick a CSP that allows exactly that nonce. Reports
	// WITHOUT the placeholder keep the strict no-script CSP — byte-for-byte unchanged.
	let working = html;
	let cspMeta = CSP_META;
	if (working.includes(NONCE_PLACEHOLDER)) {
		const nonce = nonceGen();
		working = working.split(NONCE_PLACEHOLDER).join(nonce);
		cspMeta = cspMetaWithScriptNonce(nonce);
	}

	const headMatch = /<head[^>]*>/i.exec(working);
	if (!headMatch) {
		throw new ReportHtmlInvalidError(
			"report HTML must be a complete document with a <head> element",
		);
	}
	const headStart = headMatch.index + headMatch[0].length;
	// Head content ends at </head>; for malformed docs fall back to <body>
	// (head implicitly ends there), else treat the head as empty — injecting
	// a duplicate meta is harmless, skipping a needed one is not.
	const headClose = /<\/head>/i.exec(working.slice(headStart));
	const bodyOpen = /<body[\s>]/i.exec(working.slice(headStart));
	const headEnd =
		headClose !== null
			? headStart + headClose.index
			: bodyOpen !== null
				? headStart + bodyOpen.index
				: headStart;
	const headContent = working.slice(headStart, headEnd);

	// Attribute-order/whitespace-insensitive: match any <meta …> tag inside
	// the head whose attributes include the marker, wherever it appears.
	const hasRobots = /<meta[^>]*\bname\s*=\s*["']?robots["'\s>]/i.test(
		headContent,
	);
	const hasCsp =
		/<meta[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy["'\s>]/i.test(
			headContent,
		);

	const inject: string[] = [];
	if (!hasRobots) inject.push(NOINDEX_META);
	if (!hasCsp) inject.push(cspMeta);
	if (inject.length === 0) return working;
	return `${working.slice(0, headStart)}\n${inject.join("\n")}${working.slice(headStart)}`;
}

/** Exposed for tests/docs. */
export const REPORT_REGISTRY_INTERNALS = {
	ROBOTS_TXT,
	NOINDEX_META,
	CSP_META,
	NONCE_PLACEHOLDER,
	cspMetaWithScriptNonce,
};
