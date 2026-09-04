/**
 * FLY-203: ReportRegistry — local source of truth for the remote report
 * pipeline's hosted set.
 *
 * Reports are stored as independent private Blob objects and served through a
 * stable Vercel gateway at the existing unguessable
 * `r/<128-bit-token>/index.html` path. Normal publishes never deploy Vercel.
 *
 * Transaction contract (Codex design review R1#3 + R2#2 + R3#1):
 *   stagePublish() builds a pure in-memory staged view — token, hardened HTML,
 *   the stable gateway project name, and the age-only prune computation. ZERO
 *   fs mutation.
 *   - upload fails  → abort(): disk untouched. On a first publish this means
 *     not even registry.json exists.
 *   - upload works  → commit() in a FIXED order: ① write the new report file
 *     → ② atomically write registry.json (tmp + rename = the commit point)
 *     → ③ best-effort delete pruned files (failure = warn only).
 *     A failure before ② leaves the old registry + all pruned files intact;
 *     the route best-effort deletes an orphan uploaded object.
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
import {
	EXTERNAL_SCRIPT_REJECTION_MESSAGE,
	type HtmlOpeningTag,
	type HtmlTagScan,
	htmlAttribute,
	htmlHeadRange,
	htmlMetaHttpEquivContent,
	isCspGovernedInlineScript,
	isExternalScript,
	scanHtmlTags,
} from "flywheel-comm/report-html";
import { isReportExpired, REPORT_RETENTION_MS } from "./report-retention.js";

/** Founder requirement (FLY-2283, 2026-09-02): retain report links for 14 days. */
export const DEFAULT_RETENTION_MAX_AGE_MS = REPORT_RETENTION_MS;
const REPORT_TOKEN_RE = /^[0-9a-f]{32}$/;

const NOINDEX_META = '<meta name="robots" content="noindex">';
const CSP_META =
	"<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:;\">";

/**
 * Compatibility marker for interactive reports. A report generator may emit
 * `<script nonce="__CSP_NONCE__">…</script>`; injectHeadMeta mints a real per-report
 * nonce, swaps every placeholder for it, and serves a CSP that allows that nonce.
 * Reports without their own CSP no longer need this marker: every executable inline
 * script already present at publish time receives the same nonce automatically.
 *
 * SECURITY contract: publish-report accepts a trusted HTML artifact, not untrusted HTML.
 * Automatic nonce injection authorizes every executable inline script already present in
 * that artifact, including a script accidentally interpolated from unescaped input. Every
 * generator MUST HTML-escape untrusted values before composing the document. Inline event
 * handler attributes are not covered by script nonces, so default-CSP reports reject them
 * and require addEventListener inside a nonced script instead.
 */
const NONCE_PLACEHOLDER = "__CSP_NONCE__";

// HTML event-handler content attributes. Keep this explicit: treating every
// `on*` attribute as executable rejects ordinary attributes such as `once` and
// `only`, while the browser only executes the standardized handler names.
const INLINE_EVENT_HANDLER_ATTRIBUTES = new Set([
	"onabort",
	"onafterprint",
	"onanimationcancel",
	"onanimationend",
	"onanimationiteration",
	"onanimationstart",
	"onauxclick",
	"onbeforeinput",
	"onbeforematch",
	"onbeforeprint",
	"onbeforetoggle",
	"onbeforeunload",
	"onblur",
	"oncancel",
	"oncanplay",
	"oncanplaythrough",
	"onchange",
	"onclick",
	"onclose",
	"oncommand",
	"oncontextlost",
	"oncontextmenu",
	"oncontextrestored",
	"oncopy",
	"oncuechange",
	"oncut",
	"ondblclick",
	"ondrag",
	"ondragend",
	"ondragenter",
	"ondragleave",
	"ondragover",
	"ondragstart",
	"ondrop",
	"ondurationchange",
	"onemptied",
	"onended",
	"onerror",
	"onfocus",
	"onfocusin",
	"onfocusout",
	"onformdata",
	"onfullscreenchange",
	"onfullscreenerror",
	"ongotpointercapture",
	"onhashchange",
	"oninput",
	"oninvalid",
	"onkeydown",
	"onkeypress",
	"onkeyup",
	"onlanguagechange",
	"onload",
	"onloadeddata",
	"onloadedmetadata",
	"onloadstart",
	"onlostpointercapture",
	"onmessage",
	"onmessageerror",
	"onmousedown",
	"onmouseenter",
	"onmouseleave",
	"onmousemove",
	"onmouseout",
	"onmouseover",
	"onmouseup",
	"onoffline",
	"ononline",
	"onpagehide",
	"onpagereveal",
	"onpageshow",
	"onpageswap",
	"onpaste",
	"onpause",
	"onplay",
	"onplaying",
	"onpointercancel",
	"onpointerdown",
	"onpointerenter",
	"onpointerleave",
	"onpointermove",
	"onpointerout",
	"onpointerover",
	"onpointerrawupdate",
	"onpointerup",
	"onpopstate",
	"onprogress",
	"onratechange",
	"onrejectionhandled",
	"onreset",
	"onresize",
	"onscroll",
	"onscrollend",
	"onsecuritypolicyviolation",
	"onseeked",
	"onseeking",
	"onselect",
	"onselectionchange",
	"onselectstart",
	"onslotchange",
	"onstalled",
	"onstorage",
	"onsubmit",
	"onsuspend",
	"ontimeupdate",
	"ontoggle",
	"ontouchcancel",
	"ontouchend",
	"ontouchmove",
	"ontouchstart",
	"ontransitioncancel",
	"ontransitionend",
	"ontransitionrun",
	"ontransitionstart",
	"onunhandledrejection",
	"onunload",
	"onvolumechange",
	"onwaiting",
	"onwebkitanimationend",
	"onwebkitanimationiteration",
	"onwebkitanimationstart",
	"onwebkittransitionend",
	"onwheel",
]);

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

function openingTagWithNonce(
	html: string,
	tag: HtmlOpeningTag,
	nonce: string,
): string {
	const opening = html.slice(tag.start, tag.end + 1);
	const nonceAttribute = htmlAttribute(tag, "nonce");
	if (
		nonceAttribute?.valueStart !== undefined &&
		nonceAttribute.valueEnd !== undefined
	) {
		return `${html.slice(tag.start, nonceAttribute.valueStart)}${nonce}${html.slice(nonceAttribute.valueEnd, tag.end + 1)}`;
	}
	if (nonceAttribute) {
		const relativeNameEnd = nonceAttribute.nameEnd - tag.start;
		return `${opening.slice(0, relativeNameEnd)}="${nonce}"${opening.slice(relativeNameEnd)}`;
	}
	return `${opening.slice(0, -1)} nonce="${nonce}">`;
}

function replaceOpeningTags(
	html: string,
	replacements: Array<{ tag: HtmlOpeningTag; value: string }>,
): string {
	let working = html;
	for (const replacement of replacements.sort(
		(a, b) => b.tag.start - a.tag.start,
	)) {
		working = `${working.slice(0, replacement.tag.start)}${replacement.value}${working.slice(replacement.tag.end + 1)}`;
	}
	return working;
}

function headBounds(scan: HtmlTagScan): { start: number; end: number } {
	const bounds = htmlHeadRange(scan);
	if (!bounds) {
		throw new ReportHtmlInvalidError(
			"report HTML must be a complete document with a <head> element",
		);
	}
	return bounds;
}

function hasMetaAttribute(
	tags: HtmlOpeningTag[],
	head: { start: number; end: number },
	name: string,
	value: string,
): boolean {
	return tags.some((tag) => {
		if (
			tag.name !== "meta" ||
			tag.start < head.start ||
			tag.start >= head.end
		) {
			return false;
		}
		return htmlAttribute(tag, name)?.value?.trim().toLowerCase() === value;
	});
}

export interface ReportEntry {
	token: string;
	projectName: string;
	title?: string;
	createdAt: string;
	/** Byte size of the hardened HTML — retained for audit/observability. */
	bytes: number;
}

export interface ReportHostingState {
	provider: "vercel-blob";
	migratedAt: string;
	gatewayDeploymentId: string;
}

interface ReportRegistryData {
	vercelProjectName?: string;
	hosting?: ReportHostingState;
	reports: ReportEntry[];
}

export interface StagedPublish {
	entry: ReportEntry;
	/** Hardened HTML for the single-object hosting upload. */
	html: string;
	/**
	 * Stable Vercel gateway project name (R3#1: part of the transaction).
	 * Existing committed value, or a new in-memory `fw-reports-<6hex>` on a
	 * first publish. Persisted ONLY by commit().
	 */
	vercelProjectName: string;
	/** Reports that reached the fixed 14-day boundary in this staged view. */
	expired: readonly ReportEntry[];
	/** Call after Blob upload success. Fixed order: file → registry rename → prune. */
	commit(): void;
	/** Call after Blob upload failure. Disk stays untouched. */
	abort(): void;
}

export interface ReportRegistryOptions {
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
	private readonly now: () => number;
	private readonly randomHex: (bytes: number) => string;
	private readonly warn: (msg: string) => void;

	constructor(baseDir: string, opts: ReportRegistryOptions = {}) {
		this.baseDir = baseDir;
		this.filesDir = join(baseDir, "files");
		this.registryPath = join(baseDir, "registry.json");
		this.now = opts.now ?? (() => Date.now());
		this.randomHex =
			opts.randomHex ?? ((n: number) => randomBytes(n).toString("hex"));
		this.warn = opts.warn ?? ((msg) => console.warn(msg));
	}

	/** Preview root — the CLI↔Bridge screenshot handoff contract directory. */
	previewsDir(): string {
		return join(this.baseDir, "previews");
	}

	/** Committed Vercel project name (undefined before publish/migration bootstrap). */
	vercelProjectName(): string | undefined {
		return this.load().vercelProjectName;
	}

	/** Persist a stable gateway name so an empty reports directory can migrate. */
	ensureVercelProjectName(): string {
		const committed = this.load();
		if (committed.vercelProjectName) return committed.vercelProjectName;
		const vercelProjectName = `fw-reports-${this.randomHex(3)}`;
		this.saveAtomic({ ...committed, vercelProjectName });
		return vercelProjectName;
	}

	/** Committed retained entries, oldest first. */
	list(): ReportEntry[] {
		return this.load().reports;
	}

	/** Durable cutover marker written only after the gateway deployment is ready. */
	hosting(): ReportHostingState | undefined {
		return this.load().hosting;
	}

	/** Read a committed hardened report for the one-time Blob migration. */
	readReportHtml(token: string): string {
		if (!REPORT_TOKEN_RE.test(token)) {
			throw new Error("[report-registry] invalid report token");
		}
		if (!this.load().reports.some((entry) => entry.token === token)) {
			throw new Error(`[report-registry] unknown report token=${token}`);
		}
		return readFileSync(join(this.filesDir, `${token}.html`), "utf8");
	}

	markHostingMigrated(hosting: ReportHostingState): void {
		const committed = this.load();
		if (!committed.vercelProjectName) {
			throw new Error(
				"[report-registry] cannot mark Blob hosting before a gateway project exists",
			);
		}
		this.saveAtomic({ ...committed, hosting });
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

		// TTL is the only retention rule (founder requirement: links expire after
		// 14 days). Aggregate count and byte limits would evict valid reports
		// early and are intentionally absent with per-report object storage.
		// The public gateway enforces the same boundary from Blob metadata on
		// every request. This local pass only compacts registry/files after the
		// boundary; the fixed background Blob sweep reclaims remote objects.
		//
		const nowMs = this.now();
		const all: ReportEntry[] = [];
		const pruned: ReportEntry[] = [];
		const expired: ReportEntry[] = [];
		for (const e of [...committed.reports, entry]) {
			// >= : the expiry instant itself counts as expired (Codex R1 — with
			// lazy enforcement and an aligned publish cadence, a `>` here would
			// stretch an exactly-14-day-old link a full extra cycle).
			const createdAt = Date.parse(e.createdAt);
			if (!Number.isFinite(createdAt)) {
				pruned.push(e);
			} else if (isReportExpired(nowMs, createdAt)) {
				pruned.push(e);
				expired.push(e);
			} else {
				all.push(e);
			}
		}
		const retained = all;
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
				hosting: committed.hosting,
				reports: retained,
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

		return {
			entry,
			html: hardened,
			vercelProjectName,
			expired,
			commit,
			abort,
		};
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
		// A corrupted registry must NOT be silently rebuilt because it carries
		// the stable gateway name and the durable hosting-cutover marker.
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
		return {
			vercelProjectName: d.vercelProjectName,
			hosting: d.hosting,
			reports: d.reports,
		};
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
	const originalScan = scanHtmlTags(html);
	const originalTags = originalScan.openings;
	if (originalTags.some(isExternalScript)) {
		throw new ReportHtmlInvalidError(EXTERNAL_SCRIPT_REJECTION_MESSAGE);
	}
	const originalHead = headBounds(originalScan);
	const hasOriginalCsp = hasMetaAttribute(
		originalTags,
		originalHead,
		"http-equiv",
		"content-security-policy",
	);

	if (!hasOriginalCsp) {
		const eventHandler = originalTags
			.flatMap((tag) => tag.attributes)
			.find((candidate) => INLINE_EVENT_HANDLER_ATTRIBUTES.has(candidate.name));
		if (eventHandler) {
			throw new ReportHtmlInvalidError(
				`report HTML contains inline event handler "${eventHandler.name}"; move it into a nonced script and bind it with addEventListener`,
			);
		}
	}

	let working = html;
	let cspMeta = CSP_META;
	const hadNoncePlaceholder = html.includes(NONCE_PLACEHOLDER);
	let nonce: string | undefined;
	if (hadNoncePlaceholder) {
		nonce = nonceGen();
		working = working.split(NONCE_PLACEHOLDER).join(nonce);
		cspMeta = cspMetaWithScriptNonce(nonce);
	}
	if (!hasOriginalCsp) {
		const scriptScan = hadNoncePlaceholder
			? scanHtmlTags(working)
			: originalScan;
		const replacements: Array<{ tag: HtmlOpeningTag; value: string }> = [];
		for (const tag of scriptScan.openings) {
			if (!isCspGovernedInlineScript(tag)) continue;
			if (
				hadNoncePlaceholder &&
				(htmlAttribute(tag, "nonce")?.value ?? "") !== ""
			) {
				continue;
			}
			nonce ??= nonceGen();
			replacements.push({
				tag,
				value: openingTagWithNonce(working, tag, nonce),
			});
		}
		if (nonce !== undefined) {
			working = replaceOpeningTags(working, replacements);
			cspMeta = cspMetaWithScriptNonce(nonce);
		}
	}

	// Nonce insertion shifts offsets, so rescan before injecting into <head>.
	const scan = scanHtmlTags(working);
	const tags = scan.openings;
	const head = headBounds(scan);
	const hasRobots = hasMetaAttribute(tags, head, "name", "robots");
	const hasCsp = hasMetaAttribute(
		tags,
		head,
		"http-equiv",
		"content-security-policy",
	);

	const inject: string[] = [];
	if (!hasRobots) inject.push(NOINDEX_META);
	if (!hasCsp) inject.push(cspMeta);
	const hardened =
		inject.length === 0
			? working
			: `${working.slice(0, head.start)}\n${inject.join("\n")}${working.slice(head.start)}`;
	const csp = htmlMetaHttpEquivContent(hardened, "content-security-policy");
	if (!csp?.trim()) {
		throw new ReportHtmlInvalidError(
			"report HTML must contain a non-empty Content-Security-Policy in a complete <head>",
		);
	}
	if (/[\r\n]/.test(csp)) {
		throw new ReportHtmlInvalidError(
			"report HTML Content-Security-Policy must be a single line without CR or LF characters",
		);
	}
	return hardened;
}

/** Exposed for tests/docs. */
export const REPORT_REGISTRY_INTERNALS = {
	NOINDEX_META,
	CSP_META,
	NONCE_PLACEHOLDER,
	cspMetaWithScriptNonce,
};
