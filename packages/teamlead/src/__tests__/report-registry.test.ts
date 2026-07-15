/**
 * FLY-203: ReportRegistry unit tests — real fs in a tmp dir.
 *
 * The critical properties under test are the transaction boundaries
 * (Codex design review R1#3 + R2#2 + R3#1):
 *   - stagePublish() never touches disk
 *   - abort() leaves disk untouched (first publish: not even registry.json)
 *   - commit() order: new file → atomic registry rename → best-effort prune
 *   - prune deletion failure after the rename is warn-only
 *   - vercelProjectName persists only via commit
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_RETENTION_BYTES,
	DEFAULT_RETENTION_MAX,
	DEFAULT_RETENTION_MAX_AGE_MS,
	injectHeadMeta,
	REPORT_REGISTRY_INTERNALS,
	ReportHtmlInvalidError,
	ReportRegistry,
} from "../bridge/report-registry.js";

const HTML =
	"<!doctype html><html><head><title>t</title></head><body>r</body></html>";

function seqRandomHex(): (n: number) => string {
	let i = 0;
	return (n: number) => {
		i += 1;
		return String(i).padStart(n * 2, "0");
	};
}

describe("ReportRegistry", () => {
	let dir: string;
	let warns: string[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly203-registry-"));
		warns = [];
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function makeRegistry(
		opts: {
			retentionMax?: number;
			retentionBytes?: number;
			retentionMaxAgeMs?: number;
			now?: () => number;
		} = {},
	) {
		return new ReportRegistry(dir, {
			...opts,
			randomHex: seqRandomHex(),
			warn: (m) => warns.push(m),
		});
	}

	function diskSnapshot(): string[] {
		if (!existsSync(dir)) return [];
		const walk = (d: string): string[] =>
			readdirSync(d, { withFileTypes: true }).flatMap((e) =>
				e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
			);
		return walk(dir).sort();
	}

	// ── transaction boundaries ──────────────────────────────────────────

	it("stagePublish performs zero fs mutation", () => {
		const reg = makeRegistry();
		const before = diskSnapshot();
		const staged = reg.stagePublish("flywheel", HTML, "Title");
		expect(diskSnapshot()).toEqual(before);
		expect(staged.entry.token).toHaveLength(32);
		staged.abort();
	});

	it("first-publish deploy failure → abort → no registry.json, zero files", () => {
		const reg = makeRegistry();
		const staged = reg.stagePublish("flywheel", HTML);
		staged.abort();
		expect(existsSync(join(dir, "registry.json"))).toBe(false);
		expect(diskSnapshot()).toEqual([]);
		expect(reg.vercelProjectName()).toBeUndefined();
		expect(reg.list()).toEqual([]);
	});

	it("commit writes report file, registry, and the project name", () => {
		const reg = makeRegistry();
		const staged = reg.stagePublish("flywheel", HTML, "T1");
		staged.commit();
		expect(
			readFileSync(join(dir, "files", `${staged.entry.token}.html`), "utf-8"),
		).toContain("<body>r</body>");
		expect(reg.vercelProjectName()).toBe(staged.vercelProjectName);
		expect(reg.list()).toHaveLength(1);
		expect(reg.list()[0]?.token).toBe(staged.entry.token);
	});

	it("vercelProjectName: new in-memory on first stage, reused after commit", () => {
		const reg = makeRegistry();
		const s1 = reg.stagePublish("flywheel", HTML);
		expect(s1.vercelProjectName).toMatch(/^fw-reports-[0-9a-f]{6}$/);
		// not persisted before commit
		expect(reg.vercelProjectName()).toBeUndefined();
		s1.commit();
		const s2 = reg.stagePublish("flywheel", HTML);
		expect(s2.vercelProjectName).toBe(s1.vercelProjectName);
		s2.abort();
	});

	it("second publish keeps prior report in deployFiles (persistence)", () => {
		const reg = makeRegistry();
		const s1 = reg.stagePublish("flywheel", HTML, "first");
		s1.commit();
		const s2 = reg.stagePublish("flywheel", HTML, "second");
		const paths = s2.deployFiles.map((f) => f.file);
		expect(paths).toContain("robots.txt");
		expect(paths).toContain(`r/${s1.entry.token}/index.html`);
		expect(paths).toContain(`r/${s2.entry.token}/index.html`);
		s2.commit();
	});

	it("commit/abort are single-shot", () => {
		const reg = makeRegistry();
		const s = reg.stagePublish("flywheel", HTML);
		s.commit();
		expect(() => s.commit()).toThrow(/already called/);
		const s2 = reg.stagePublish("flywheel", HTML);
		s2.abort();
		expect(() => s2.commit()).toThrow(/already called/);
	});

	// ── retention ───────────────────────────────────────────────────────

	it("count cap prunes oldest; pruned file deleted at commit", () => {
		const reg = makeRegistry({ retentionMax: 2 });
		const s1 = reg.stagePublish("p", HTML, "a");
		s1.commit();
		const s2 = reg.stagePublish("p", HTML, "b");
		s2.commit();
		const s3 = reg.stagePublish("p", HTML, "c");
		// staged view already excludes the pruned oldest
		const paths = s3.deployFiles.map((f) => f.file);
		expect(paths).not.toContain(`r/${s1.entry.token}/index.html`);
		expect(paths).toContain(`r/${s2.entry.token}/index.html`);
		s3.commit();
		expect(existsSync(join(dir, "files", `${s1.entry.token}.html`))).toBe(
			false,
		);
		expect(reg.list().map((e) => e.token)).toEqual([
			s2.entry.token,
			s3.entry.token,
		]);
	});

	it("bytes cap prunes oldest until total fits", () => {
		// hardened size per report ≈ 815 B (655 B doc + injected noindex/CSP
		// metas) → two fit under 2000 B, a third pushes past → oldest pruned.
		const bigHtml = `<!doctype html><html><head></head><body>${"x".repeat(600)}</body></html>`;
		const reg = makeRegistry({ retentionBytes: 2000 });
		const s1 = reg.stagePublish("p", bigHtml);
		s1.commit();
		const s2 = reg.stagePublish("p", bigHtml);
		s2.commit();
		expect(reg.list()).toHaveLength(2); // two fit
		const s3 = reg.stagePublish("p", bigHtml);
		const paths = s3.deployFiles.map((f) => f.file);
		expect(paths).not.toContain(`r/${s1.entry.token}/index.html`);
		s3.commit();
		expect(reg.list()).toHaveLength(2);
	});

	it("default caps are 100 entries / 10MB", () => {
		expect(DEFAULT_RETENTION_MAX).toBe(100);
		expect(DEFAULT_RETENTION_BYTES).toBe(10 * 1024 * 1024);
	});

	// ── TTL expiry (founder requirement: links die after 7 days) ────────

	it("default TTL is 7 days", () => {
		expect(DEFAULT_RETENTION_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
	});

	it("entries older than the TTL are pruned at the next publish", () => {
		let clock = Date.parse("2026-06-04T00:00:00Z");
		const reg = makeRegistry({ now: () => clock });
		const s1 = reg.stagePublish("p", HTML, "old");
		s1.commit();
		// 8 days later: a new publish must drop the expired entry
		clock += 8 * 24 * 60 * 60 * 1000;
		const s2 = reg.stagePublish("p", HTML, "new");
		expect(s2.deployFiles.map((f) => f.file)).not.toContain(
			`r/${s1.entry.token}/index.html`,
		);
		s2.commit();
		expect(reg.list().map((e) => e.token)).toEqual([s2.entry.token]);
		expect(existsSync(join(dir, "files", `${s1.entry.token}.html`))).toBe(
			false,
		);
	});

	it("entries younger than the TTL survive (boundary)", () => {
		let clock = Date.parse("2026-06-04T00:00:00Z");
		const reg = makeRegistry({ now: () => clock });
		const s1 = reg.stagePublish("p", HTML, "young");
		s1.commit();
		clock += 6 * 24 * 60 * 60 * 1000; // 6 days — inside TTL
		const s2 = reg.stagePublish("p", HTML, "new");
		expect(s2.deployFiles.map((f) => f.file)).toContain(
			`r/${s1.entry.token}/index.html`,
		);
		s2.abort();
	});

	it("an entry EXACTLY at the TTL boundary is pruned (>= semantics)", () => {
		let clock = Date.parse("2026-06-04T00:00:00Z");
		const reg = makeRegistry({ now: () => clock });
		const s1 = reg.stagePublish("p", HTML, "boundary");
		s1.commit();
		clock += 7 * 24 * 60 * 60 * 1000; // exactly 7 days
		const s2 = reg.stagePublish("p", HTML, "new");
		expect(s2.deployFiles.map((f) => f.file)).not.toContain(
			`r/${s1.entry.token}/index.html`,
		);
		s2.abort();
	});

	it("malformed createdAt is never TTL-pruned (NaN age guard)", () => {
		let clock = Date.parse("2026-06-04T00:00:00Z");
		const reg = makeRegistry({ now: () => clock });
		const s1 = reg.stagePublish("p", HTML);
		s1.commit();
		// corrupt the committed createdAt
		const regPath = join(dir, "registry.json");
		const data = JSON.parse(readFileSync(regPath, "utf-8"));
		data.reports[0].createdAt = "not-a-date";
		writeFileSync(regPath, JSON.stringify(data), "utf-8");
		clock += 30 * 24 * 60 * 60 * 1000;
		const s2 = reg.stagePublish("p", HTML);
		// guard keeps it (conservative: unknown age ≠ expired)
		expect(s2.deployFiles.map((f) => f.file)).toContain(
			`r/${s1.entry.token}/index.html`,
		);
		s2.abort();
	});

	it("retentionMaxAgeMs: 0 disables age-based expiry", () => {
		let clock = Date.parse("2026-06-04T00:00:00Z");
		const reg = makeRegistry({ retentionMaxAgeMs: 0, now: () => clock });
		const s1 = reg.stagePublish("p", HTML);
		s1.commit();
		clock += 365 * 24 * 60 * 60 * 1000; // a year
		const s2 = reg.stagePublish("p", HTML);
		expect(s2.deployFiles.map((f) => f.file)).toContain(
			`r/${s1.entry.token}/index.html`,
		);
		s2.abort();
	});

	it("an extremely large TTL behaves as never-expiring without overflow surprises", () => {
		let clock = Date.parse("2026-06-04T00:00:00Z");
		const reg = makeRegistry({
			retentionMaxAgeMs: 99999999 * 24 * 60 * 60 * 1000,
			now: () => clock,
		});
		const s1 = reg.stagePublish("p", HTML);
		s1.commit();
		clock += 3650 * 24 * 60 * 60 * 1000; // 10 years
		const s2 = reg.stagePublish("p", HTML);
		expect(s2.deployFiles.map((f) => f.file)).toContain(
			`r/${s1.entry.token}/index.html`,
		);
		s2.abort();
	});

	it("TTL coexists with count cap — whichever hits first wins", () => {
		let clock = Date.parse("2026-06-04T00:00:00Z");
		const reg = makeRegistry({ retentionMax: 2, now: () => clock });
		const s1 = reg.stagePublish("p", HTML, "a");
		s1.commit();
		clock += 1000;
		const s2 = reg.stagePublish("p", HTML, "b");
		s2.commit();
		// count cap prunes s1 (TTL not reached)
		clock += 1000;
		const s3 = reg.stagePublish("p", HTML, "c");
		expect(s3.deployFiles.map((f) => f.file)).not.toContain(
			`r/${s1.entry.token}/index.html`,
		);
		s3.commit();
		// TTL prunes everything older than 7d regardless of count
		clock += 8 * 24 * 60 * 60 * 1000;
		const s4 = reg.stagePublish("p", HTML, "d");
		const paths = s4.deployFiles.map((f) => f.file);
		expect(paths).not.toContain(`r/${s2.entry.token}/index.html`);
		expect(paths).not.toContain(`r/${s3.entry.token}/index.html`);
		expect(paths).toContain(`r/${s4.entry.token}/index.html`);
		s4.abort();
	});

	it("abort after TTL staging leaves expired entries on disk untouched", () => {
		let clock = Date.parse("2026-06-04T00:00:00Z");
		const reg = makeRegistry({ now: () => clock });
		const s1 = reg.stagePublish("p", HTML);
		s1.commit();
		clock += 8 * 24 * 60 * 60 * 1000;
		const s2 = reg.stagePublish("p", HTML);
		s2.abort();
		// abort = zero fs change: the expired entry is still committed state
		expect(reg.list().map((e) => e.token)).toEqual([s1.entry.token]);
		expect(existsSync(join(dir, "files", `${s1.entry.token}.html`))).toBe(true);
	});

	// ── commit failure boundaries (R2#2) ────────────────────────────────

	it("commit failure before registry rename leaves old registry + pruned files intact", () => {
		const reg = makeRegistry({ retentionMax: 1 });
		const s1 = reg.stagePublish("p", HTML, "old");
		s1.commit();
		const registryBefore = readFileSync(join(dir, "registry.json"), "utf-8");

		// Sabotage the rename step: make registry.json.tmp unwritable by
		// turning baseDir's registry.json.tmp path into a directory.
		mkdirSync(join(dir, "registry.json.tmp"), { recursive: true });

		const s2 = reg.stagePublish("p", HTML, "new");
		expect(() => s2.commit()).toThrow();
		// registry unchanged (= old state), pruned old report file still there
		expect(readFileSync(join(dir, "registry.json"), "utf-8")).toBe(
			registryBefore,
		);
		expect(existsSync(join(dir, "files", `${s1.entry.token}.html`))).toBe(true);
		// orphan new file may exist — acceptable; registry-driven deploys ignore it
	});

	it("prune deletion failure after rename warns but commit succeeds", () => {
		const reg = makeRegistry({ retentionMax: 1 });
		const s1 = reg.stagePublish("p", HTML, "old");
		s1.commit();
		// Replace the old report file with a non-empty directory so rmSync
		// (non-recursive) fails for it.
		const oldPath = join(dir, "files", `${s1.entry.token}.html`);
		rmSync(oldPath);
		mkdirSync(oldPath);
		writeFileSync(join(oldPath, "block"), "x");

		const s2 = reg.stagePublish("p", HTML, "new");
		expect(() => s2.commit()).not.toThrow();
		expect(warns.some((w) => w.includes("failed to delete pruned"))).toBe(true);
		// registry IS the new state (rename happened)
		expect(reg.list().map((e) => e.token)).toEqual([s2.entry.token]);
	});

	// ── deployFiles content ─────────────────────────────────────────────

	it("deployFiles include robots.txt with Disallow all", () => {
		const reg = makeRegistry();
		const s = reg.stagePublish("p", HTML);
		const robots = s.deployFiles.find((f) => f.file === "robots.txt");
		expect(robots?.data).toBe(REPORT_REGISTRY_INTERNALS.ROBOTS_TXT);
		expect(robots?.data).toContain("Disallow: /");
		s.abort();
	});

	it("retained entry with a missing local file is warned + dropped at commit", () => {
		const reg = makeRegistry();
		const s1 = reg.stagePublish("p", HTML);
		s1.commit();
		rmSync(join(dir, "files", `${s1.entry.token}.html`));
		const s2 = reg.stagePublish("p", HTML);
		expect(warns.some((w) => w.includes("file missing"))).toBe(true);
		expect(s2.deployFiles.map((f) => f.file)).not.toContain(
			`r/${s1.entry.token}/index.html`,
		);
		s2.commit();
		expect(reg.list().map((e) => e.token)).toEqual([s2.entry.token]);
	});

	// ── registry corruption ─────────────────────────────────────────────

	it("corrupted registry.json → loud error, no silent rebuild", () => {
		const reg = makeRegistry();
		reg.stagePublish("p", HTML).commit();
		writeFileSync(join(dir, "registry.json"), "{not json", "utf-8");
		expect(() => reg.list()).toThrow(/refusing to silently rebuild/);
		expect(() => reg.stagePublish("p", HTML)).toThrow(
			/refusing to silently rebuild/,
		);
	});

	it("invalid-shape registry.json → loud error", () => {
		writeFileSync(join(dir, "registry.json"), '{"reports": "nope"}', "utf-8");
		const reg = makeRegistry();
		expect(() => reg.list()).toThrow(/invalid shape/);
	});

	it("atomic write leaves no .tmp residue after commit", () => {
		const reg = makeRegistry();
		reg.stagePublish("p", HTML).commit();
		expect(existsSync(join(dir, "registry.json.tmp"))).toBe(false);
	});

	it("previewsDir is under baseDir", () => {
		const reg = makeRegistry();
		expect(reg.previewsDir()).toBe(join(dir, "previews"));
	});
});

describe("injectHeadMeta", () => {
	it("injects noindex + CSP when absent", () => {
		const out = injectHeadMeta(HTML);
		expect(out).toContain('name="robots" content="noindex"');
		expect(out).toContain("Content-Security-Policy");
		expect(out).toContain("default-src 'none'");
		// injected right after <head>
		expect(out.indexOf("noindex")).toBeGreaterThan(out.indexOf("<head>"));
		expect(out.indexOf("noindex")).toBeLessThan(out.indexOf("<title>"));
	});

	it("leaves existing robots meta and CSP untouched", () => {
		const html =
			'<html><head><meta name="robots" content="all"><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body></body></html>';
		expect(injectHeadMeta(html)).toBe(html);
	});

	it("injects only the missing one", () => {
		const html =
			'<html><head><meta name="robots" content="noindex"></head><body></body></html>';
		const out = injectHeadMeta(html);
		expect(out.match(/name=["']?robots/gi)).toHaveLength(1);
		expect(out).toContain("Content-Security-Policy");
	});

	it("rejects HTML without <head> (ReportHtmlInvalidError)", () => {
		expect(() => injectHeadMeta("<p>fragment</p>")).toThrow(
			ReportHtmlInvalidError,
		);
	});

	it("body fake meta must NOT suppress injection (code review R1#1)", () => {
		// A report that merely SHOWS a CSP/robots meta tag in its body (e.g.
		// a <pre> code sample) still needs the real head injection.
		const html =
			'<html><head><title>t</title></head><body><pre>&lt;example&gt;<meta http-equiv="Content-Security-Policy" content="default-src *"><meta name="robots" content="all"></pre></body></html>';
		const out = injectHeadMeta(html);
		// injected INTO the head, before <title>
		const headPart = out.slice(0, out.indexOf("</head>"));
		expect(headPart).toContain('name="robots" content="noindex"');
		expect(headPart).toContain("default-src 'none'");
	});

	it("reversed attribute order inside head is detected", () => {
		const html =
			'<html><head><meta content="default-src *" http-equiv="Content-Security-Policy"><meta content="all" name="robots"></head><body></body></html>';
		expect(injectHeadMeta(html)).toBe(html);
	});

	it("malformed doc without </head>: body fake meta still does not count as head", () => {
		const html =
			'<html><head><body><meta name="robots" content="all"></body></html>';
		const out = injectHeadMeta(html);
		expect(out).toContain("noindex");
		expect(out).toContain("Content-Security-Policy");
	});

	it("accepts <head> with attributes", () => {
		const out = injectHeadMeta(
			'<html><head lang="en"></head><body></body></html>',
		);
		expect(out).toContain("noindex");
	});

	// --- interactive reports: opt-in script nonce (P1 hosted copy-button fix) ---
	const NONCE = REPORT_REGISTRY_INTERNALS.NONCE_PLACEHOLDER;

	it("non-interactive report keeps the strict no-script CSP (byte-compat)", () => {
		const out = injectHeadMeta(HTML, () => "deadbeef");
		expect(out).toContain("default-src 'none'");
		expect(out).not.toContain("script-src");
		expect(out).not.toContain("nonce-");
	});

	it("opt-in placeholder → mints nonce, stamps <script>, relaxes CSP to script-src nonce", () => {
		const html = `<html><head><title>t</title></head><body><button id="b">x</button><script nonce="${NONCE}">var x=1;</script></body></html>`;
		const out = injectHeadMeta(html, () => "N0NCE123");
		// placeholder replaced everywhere with the real nonce
		expect(out).not.toContain(NONCE);
		expect(out).toContain('<script nonce="N0NCE123">');
		// CSP now allows exactly that nonce; default-src still 'none'
		expect(out).toContain("script-src 'nonce-N0NCE123'");
		expect(out).toContain("default-src 'none'");
		expect(out).toContain("style-src 'unsafe-inline'");
	});

	it("each publish mints a fresh nonce (CSP + script tag agree)", () => {
		const html = `<html><head></head><body><script nonce="${NONCE}">1;</script></body></html>`;
		let n = 0;
		const out = injectHeadMeta(html, () => `nonce${n++}`);
		expect(out).toContain('<script nonce="nonce0">');
		expect(out).toContain("script-src 'nonce-nonce0'");
	});

	it("placeholder appearing in (escaped) report TEXT cannot create an executable script", () => {
		// Untrusted content is HTML-escaped by generators, so a literal placeholder in text is
		// just text. It may flip the CSP to nonce mode, but there is no real <script> to run.
		const html = `<html><head></head><body><pre>note text mentions ${NONCE} here</pre></body></html>`;
		const out = injectHeadMeta(html, () => "XYZ");
		expect(out).not.toContain(NONCE); // replaced as text
		expect(out).not.toContain("<script"); // no real script tag exists → nothing executes
	});
});
