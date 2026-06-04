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
		opts: { retentionMax?: number; retentionBytes?: number } = {},
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
});
