/**
 * ReportRegistry tests use a real temporary filesystem. The registry is local
 * transaction metadata; hosted bytes live as independent private Blob objects.
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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyReport } from "../../../flywheel-comm/src/commands/verify-report.js";
import {
	DEFAULT_RETENTION_MAX_AGE_MS,
	injectHeadMeta,
	REPORT_REGISTRY_INTERNALS,
	ReportHtmlInvalidError,
	ReportRegistry,
} from "../bridge/report-registry.js";

const HTML =
	"<!doctype html><html><head><title>t</title></head><body>r</body></html>";
const DAY_MS = 24 * 60 * 60 * 1000;
const REPO_ROOT = resolve(
	fileURLToPath(new URL("../../../..", import.meta.url)),
);

function seqRandomHex(): (bytes: number) => string {
	let sequence = 0;
	return (bytes) => String(++sequence).padStart(bytes * 2, "0");
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

	function makeRegistry(now: () => number = () => Date.now()): ReportRegistry {
		return new ReportRegistry(dir, {
			now,
			randomHex: seqRandomHex(),
			warn: (message) => warns.push(message),
		});
	}

	function diskSnapshot(): string[] {
		if (!existsSync(dir)) return [];
		const walk = (path: string): string[] =>
			readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
				entry.isDirectory()
					? walk(join(path, entry.name))
					: [join(path, entry.name)],
			);
		return walk(dir).sort();
	}

	// ── transaction boundaries ──────────────────────────────────────────

	it("publishes and verifies the two interactive design templates", async () => {
		const templates = [
			"engineering/doc/FLY-2190-rosetta-tmux-arm64/design-report.template.html",
			"engineering/doc/FLY-2204-calendar-cred-isolation/founder-design.template.html",
		];

		for (const template of templates) {
			const source = readFileSync(join(REPO_ROOT, template), "utf-8");
			const staged = makeRegistry().stagePublish("flywheel", source, template);
			const verification = await verifyReport({
				url: `https://reports.example/r/${staged.entry.token}/`,
				fetchImpl: async () =>
					new Response(staged.html, {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			});
			expect(verification.exitCode, template).toBe(0);
			expect(verification.envelope.checks.scriptCsp, template).toBe("pass");
			expect(verification.envelope.checks.scriptNonce, template).toBe("pass");
			staged.abort();
		}
	});

	it("stagePublish performs zero filesystem mutation", () => {
		const registry = makeRegistry();
		const before = diskSnapshot();
		const staged = registry.stagePublish("flywheel", HTML, "Title");

		expect(diskSnapshot()).toEqual(before);
		expect(staged.entry.token).toHaveLength(32);
		expect(staged.html).toContain("Content-Security-Policy");
		staged.abort();
	});

	it("rejects a multiline Content-Security-Policy before staging a report", () => {
		const registry = makeRegistry();
		const before = diskSnapshot();
		const html =
			"<html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none';\r\nstyle-src 'unsafe-inline'\"></head><body></body></html>";

		expect(() =>
			registry.stagePublish("flywheel", html, "multiline CSP"),
		).toThrow(
			/Content-Security-Policy must be a single line without CR or LF characters/,
		);
		expect(diskSnapshot()).toEqual(before);
	});

	it("upload failure followed by abort leaves no registry or report file", () => {
		const registry = makeRegistry();
		registry.stagePublish("flywheel", HTML).abort();

		expect(diskSnapshot()).toEqual([]);
		expect(registry.vercelProjectName()).toBeUndefined();
		expect(registry.list()).toEqual([]);
	});

	it("commit writes the hardened report, registry entry, and stable gateway name", () => {
		const registry = makeRegistry();
		const staged = registry.stagePublish("flywheel", HTML, "T1");
		staged.commit();

		expect(
			readFileSync(join(dir, "files", `${staged.entry.token}.html`), "utf8"),
		).toContain("<body>r</body>");
		expect(registry.vercelProjectName()).toBe(staged.vercelProjectName);
		expect(registry.list().map((entry) => entry.token)).toEqual([
			staged.entry.token,
		]);
	});

	it("rejects a malformed registry token before resolving a local migration path", () => {
		writeFileSync(
			join(dir, "registry.json"),
			JSON.stringify({
				vercelProjectName: "fw-reports-seeded",
				reports: [
					{
						token: "../outside",
						projectName: "flywheel",
						createdAt: "2026-09-03T16:00:00.000Z",
						bytes: 1,
					},
				],
			}),
			"utf8",
		);
		writeFileSync(join(dir, "outside.html"), "must-not-be-read", "utf8");
		const registry = makeRegistry();

		expect(() => registry.readReportHtml("../outside")).toThrow(
			"invalid report token",
		);
	});

	it("second publish stages one object and preserves the prior registry entry", () => {
		const registry = makeRegistry();
		const first = registry.stagePublish("flywheel", HTML, "first");
		first.commit();
		const second = registry.stagePublish("flywheel", HTML, "second");

		expect(second).not.toHaveProperty("deployFiles");
		expect(second.vercelProjectName).toBe(first.vercelProjectName);
		second.commit();
		expect(registry.list().map((entry) => entry.token)).toEqual([
			first.entry.token,
			second.entry.token,
		]);
	});

	it("commit and abort are single-shot", () => {
		const registry = makeRegistry();
		const committed = registry.stagePublish("flywheel", HTML);
		committed.commit();
		expect(() => committed.commit()).toThrow(/already called/);
		const aborted = registry.stagePublish("flywheel", HTML);
		aborted.abort();
		expect(() => aborted.commit()).toThrow(/already called/);
	});

	it("FLY-2283: aggregate count and bytes never evict a report before 14 days", () => {
		const now = Date.parse("2026-09-03T16:00:00.000Z");
		const reports = Array.from({ length: 2500 }, (_, index) => ({
			token: index.toString(16).padStart(32, "0"),
			projectName: "flywheel",
			createdAt: new Date(now - (2500 - index) * 1000).toISOString(),
			bytes: 512 * 1024,
		}));
		writeFileSync(
			join(dir, "registry.json"),
			JSON.stringify({
				vercelProjectName: "fw-reports-seeded",
				reports,
			}),
			"utf8",
		);

		const registry = makeRegistry(() => now);
		const staged = registry.stagePublish(
			"personal-assistant",
			HTML,
			"weekly-menu",
		);
		staged.commit();

		expect(registry.list()).toHaveLength(2501);
		expect(registry.list()[0]?.token).toBe(reports[0]?.token);
		expect(registry.list().at(-1)?.token).toBe(staged.entry.token);
	});

	it("uses one fixed 14-day TTL even when the retired env is present", () => {
		const previous = process.env.FLYWHEEL_REPORTS_TTL_DAYS;
		process.env.FLYWHEEL_REPORTS_TTL_DAYS = "0";
		try {
			let now = Date.parse("2026-06-04T00:00:00.000Z");
			const registry = makeRegistry(() => now);
			const old = registry.stagePublish("p", HTML, "old");
			old.commit();
			now += 13 * DAY_MS;
			expect(registry.stagePublish("p", HTML).expired).toEqual([]);
			now += DAY_MS;
			expect(
				registry.stagePublish("p", HTML).expired.map((entry) => entry.token),
			).toContain(old.entry.token);
			expect(DEFAULT_RETENTION_MAX_AGE_MS).toBe(14 * DAY_MS);
		} finally {
			if (previous === undefined) delete process.env.FLYWHEEL_REPORTS_TTL_DAYS;
			else process.env.FLYWHEEL_REPORTS_TTL_DAYS = previous;
		}
	});

	it("expires a report at the exact 14-day boundary and deletes its local copy on commit", () => {
		let now = Date.parse("2026-06-04T00:00:00.000Z");
		const registry = makeRegistry(() => now);
		const old = registry.stagePublish("p", HTML, "old");
		old.commit();
		now += 14 * DAY_MS;
		const next = registry.stagePublish("p", HTML, "new");

		expect(next.expired.map((entry) => entry.token)).toEqual([old.entry.token]);
		next.commit();
		expect(registry.list().map((entry) => entry.token)).toEqual([
			next.entry.token,
		]);
		expect(existsSync(join(dir, "files", `${old.entry.token}.html`))).toBe(
			false,
		);
	});

	it("keeps a report for the complete interval before 14 days", () => {
		let now = Date.parse("2026-06-04T00:00:00.000Z");
		const registry = makeRegistry(() => now);
		const old = registry.stagePublish("p", HTML, "young");
		old.commit();
		now += 14 * DAY_MS - 1;

		const staged = registry.stagePublish("p", HTML, "new");
		expect(staged.expired).toEqual([]);
		staged.abort();
	});

	it("prunes malformed timestamps from accounting without marking them safe for remote deletion", () => {
		let now = Date.parse("2026-06-04T00:00:00.000Z");
		const registry = makeRegistry(() => now);
		const old = registry.stagePublish("p", HTML);
		old.commit();
		const registryPath = join(dir, "registry.json");
		const data = JSON.parse(readFileSync(registryPath, "utf8"));
		data.reports[0].createdAt = "not-a-date";
		writeFileSync(registryPath, JSON.stringify(data), "utf8");
		now += 30 * DAY_MS;

		const staged = registry.stagePublish("p", HTML);
		expect(staged.expired).toEqual([]);
		staged.commit();
		expect(registry.list().map((entry) => entry.token)).toEqual([
			staged.entry.token,
		]);
	});

	it("abort after expiry staging leaves the prior registry and file untouched", () => {
		let now = Date.parse("2026-06-04T00:00:00.000Z");
		const registry = makeRegistry(() => now);
		const old = registry.stagePublish("p", HTML);
		old.commit();
		now += 15 * DAY_MS;
		registry.stagePublish("p", HTML).abort();

		expect(registry.list().map((entry) => entry.token)).toEqual([
			old.entry.token,
		]);
		expect(existsSync(join(dir, "files", `${old.entry.token}.html`))).toBe(
			true,
		);
	});

	it("commit failure before registry rename preserves the old entry and file", () => {
		let now = Date.parse("2026-06-04T00:00:00.000Z");
		const registry = makeRegistry(() => now);
		const old = registry.stagePublish("p", HTML, "old");
		old.commit();
		const registryBefore = readFileSync(join(dir, "registry.json"), "utf8");
		mkdirSync(join(dir, "registry.json.tmp"));
		now += 15 * DAY_MS;

		expect(() => registry.stagePublish("p", HTML, "new").commit()).toThrow();
		expect(readFileSync(join(dir, "registry.json"), "utf8")).toBe(
			registryBefore,
		);
		expect(existsSync(join(dir, "files", `${old.entry.token}.html`))).toBe(
			true,
		);
	});

	it("local expired-file deletion failure is warn-only after the registry commit", () => {
		let now = Date.parse("2026-06-04T00:00:00.000Z");
		const registry = makeRegistry(() => now);
		const old = registry.stagePublish("p", HTML, "old");
		old.commit();
		const oldPath = join(dir, "files", `${old.entry.token}.html`);
		rmSync(oldPath);
		mkdirSync(oldPath);
		writeFileSync(join(oldPath, "block"), "x");
		now += 15 * DAY_MS;
		const next = registry.stagePublish("p", HTML, "new");

		expect(() => next.commit()).not.toThrow();
		expect(warns.some((message) => message.includes("failed to delete"))).toBe(
			true,
		);
		expect(registry.list().map((entry) => entry.token)).toEqual([
			next.entry.token,
		]);
	});

	it("preserves the durable Blob-hosting cutover marker across publishes", () => {
		const registry = makeRegistry();
		registry.stagePublish("p", HTML).commit();
		const hosting = {
			provider: "vercel-blob" as const,
			migratedAt: "2026-09-03T16:00:00.000Z",
			gatewayDeploymentId: "dpl_gateway",
		};
		registry.markHostingMigrated(hosting);
		registry.stagePublish("p", HTML).commit();

		expect(registry.hosting()).toEqual(hosting);
	});

	it("corrupted or invalid registry data fails loudly", () => {
		const registry = makeRegistry();
		registry.stagePublish("p", HTML).commit();
		writeFileSync(join(dir, "registry.json"), "{not json", "utf8");
		expect(() => registry.list()).toThrow(/refusing to silently rebuild/);
		writeFileSync(join(dir, "registry.json"), '{"reports":"nope"}', "utf8");
		expect(() => registry.list()).toThrow(/invalid shape/);
	});

	it("atomic writes leave no temporary residue", () => {
		const registry = makeRegistry();
		registry.stagePublish("p", HTML).commit();
		expect(existsSync(join(dir, "registry.json.tmp"))).toBe(false);
		expect(registry.previewsDir()).toBe(join(dir, "previews"));
	});

	it("rejects external scripts consistently at publish and verification", async () => {
		const expectedError =
			"hosted reports must not contain external script src tags; bundle the code into an inline script and republish so publish-report can add matching nonces automatically, or use the __CSP_NONCE__ inline-script convention";
		const externalHtmlDocuments = [
			'<html><head></head><body><script data-x="foo>" src="external.js"></script></body></html>',
			'<html><head></head><body><script / src="external.js"></script></body></html>',
			'<html><body><script src="external.js"></script></body></html>',
		];

		for (const html of externalHtmlDocuments) {
			let publishError: string | undefined;
			try {
				makeRegistry().stagePublish("flywheel", html).abort();
			} catch (error) {
				publishError = (error as Error).message;
			}
			const verification = await verifyReport({
				url: "https://reports.example/external-script/",
				fetchImpl: async () =>
					new Response(html, {
						status: 200,
						headers: { "content-type": "text/html" },
					}),
			});

			expect({
				publishError,
				verifyExitCode: verification.exitCode,
				verifyError: verification.envelope.error,
			}).toEqual({
				publishError: expectedError,
				verifyExitCode: 1,
				verifyError: expectedError,
			});
		}
	});
});

describe("injectHeadMeta", () => {
	it("injects noindex and strict CSP into a complete document", () => {
		const output = injectHeadMeta(HTML);
		expect(output).toContain('name="robots" content="noindex"');
		expect(output).toContain("default-src 'none'");
		expect(output.indexOf("noindex")).toBeGreaterThan(output.indexOf("<head>"));
		expect(output.indexOf("noindex")).toBeLessThan(output.indexOf("<title>"));
	});

	it("keeps existing head policies and injects only a missing policy", () => {
		const complete =
			'<html><head><meta name="robots" content="all"><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body></body></html>';
		expect(injectHeadMeta(complete)).toBe(complete);
		const robotsOnly =
			'<html><head><meta name="robots" content="noindex"></head><body></body></html>';
		const output = injectHeadMeta(robotsOnly);
		expect(output.match(/name=["']?robots/gi)).toHaveLength(1);
		expect(output).toContain("Content-Security-Policy");
	});

	it("rejects HTML without a head", () => {
		expect(() => injectHeadMeta("<p>fragment</p>")).toThrow(
			ReportHtmlInvalidError,
		);
	});

	it.each([
		'<html><head><meta http-equiv="Content-Security-Policy"></head><body></body></html>',
		'<html><head><meta http-equiv="Content-Security-Policy" content=""></head><body></body></html>',
		"<html><head><title>unterminated head",
	])("rejects HTML that the fixed gateway cannot serve: %s", (html) => {
		expect(() => injectHeadMeta(html)).toThrow(ReportHtmlInvalidError);
	});

	it("body text that looks like policy metadata cannot suppress head injection", () => {
		const html =
			'<html><head><title>t</title></head><body><pre><meta http-equiv="Content-Security-Policy" content="default-src *"><meta name="robots" content="all"></pre></body></html>';
		const head = injectHeadMeta(html).split("</head>")[0];
		expect(head).toContain('name="robots" content="noindex"');
		expect(head).toContain("default-src 'none'");
	});

	it("detects reversed attribute order and accepts head attributes", () => {
		const complete =
			'<html><head><meta content="default-src *" http-equiv="Content-Security-Policy"><meta content="all" name="robots"></head><body></body></html>';
		expect(injectHeadMeta(complete)).toBe(complete);
		expect(
			injectHeadMeta('<html><head lang="en"></head><body></body></html>'),
		).toContain("noindex");
	});

	it("does not treat a raw-text </head> string as the head boundary", () => {
		const html =
			'<html><head><script type="application/json">{"sample":"</head>"}</script>' +
			'<meta http-equiv="Content-Security-Policy" content="default-src *">' +
			'<meta name="robots" content="all"></head><body></body></html>';

		expect(injectHeadMeta(html)).toBe(html);
	});

	it("malformed document body metadata still cannot suppress injection", () => {
		const output = injectHeadMeta(
			'<html><head><body><meta name="robots" content="all"></body></html>',
		);
		expect(output).toContain("noindex");
		expect(output).toContain("Content-Security-Policy");
	});

	const NONCE = REPORT_REGISTRY_INTERNALS.NONCE_PLACEHOLDER;

	it("non-interactive reports retain the no-script policy", () => {
		const output = injectHeadMeta(HTML, () => "deadbeef");
		expect(output).toContain("default-src 'none'");
		expect(output).not.toContain("script-src");
		expect(output).not.toContain("nonce-");
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

	it("auto-nonces executable inline scripts when the default CSP is injected", () => {
		const html =
			"<html><head><title>t</title></head><body>" +
			"<pre>&lt;script&gt;injected()&lt;/script&gt;</pre>" +
			"<script>first()</script>" +
			'<script data-x="foo>" type="module" nonce="old">second()</script>' +
			"</body></html>";
		let generated = 0;

		const out = injectHeadMeta(html, () => {
			generated += 1;
			return "AUTO123";
		});

		expect(generated).toBe(1);
		expect(out).toContain('<script nonce="AUTO123">first()</script>');
		expect(out).toContain(
			'<script data-x="foo>" type="module" nonce="AUTO123">second()</script>',
		);
		expect(out).toContain("script-src 'nonce-AUTO123'");
		expect(out).toContain("default-src 'none'");
		expect(out).toContain("&lt;script&gt;injected()&lt;/script&gt;");
		expect(out.match(/<script\b/gi)).toHaveLength(2);
	});

	it.each([
		"application/ecmascript",
		"application/javascript",
		"application/x-ecmascript",
		"application/x-javascript",
		"text/ecmascript",
		"text/javascript",
		"text/javascript1.0",
		"text/javascript1.1",
		"text/javascript1.2",
		"text/javascript1.3",
		"text/javascript1.4",
		"text/javascript1.5",
		"text/jscript",
		"text/livescript",
		"text/x-ecmascript",
		"text/x-javascript",
		"APPLICATION/JAVASCRIPT; charset=utf-8",
		"importmap",
		"speculationrules",
	])("auto-nonces every CSP-governed inline script type: %s", (type) => {
		const html =
			`<html><head></head><body><script type="${type}">` +
			"governed()</script></body></html>";
		const out = injectHeadMeta(html, () => "TYPE123");

		expect(out).toContain(`type="${type}" nonce="TYPE123"`);
		expect(out).toContain("script-src 'nonce-TYPE123'");
	});

	it("rejects inline event handlers before injecting the default CSP", () => {
		const html =
			'<html><head></head><body><button onClick="go()">Go</button></body></html>';

		expect(() => injectHeadMeta(html)).toThrow(
			/inline event handler.*addEventListener/i,
		);
	});

	it("does not mistake ordinary once/only attributes for event handlers", () => {
		const html =
			'<html><head></head><body><section once only="yes">Safe</section></body></html>';

		expect(() => injectHeadMeta(html)).not.toThrow();
	});

	it("preserves an author CSP, its inline script, and its event-handler policy", () => {
		const html =
			'<html><head><meta content="default-src *" http-equiv="Content-Security-Policy"></head>' +
			'<body onload="boot()"><script nonce="author">boot()</script></body></html>';

		expect(injectHeadMeta(html, () => "unused")).toBe(
			html.replace("<head>", '<head>\n<meta name="robots" content="noindex">'),
		);
	});

	it("ignores script-like text in raw elements, comments, and script bodies", () => {
		const html =
			"<html><head></head><body><!-- <script>comment()</script> -->" +
			"<noscript><script>fallback()</script></noscript>" +
			'<script>const sample = "<script>fake()</script>";</script></body></html>';
		const out = injectHeadMeta(html, () => "RAW123");

		expect(out).toContain(
			'<script nonce="RAW123">const sample = "<script>fake()</script>";</script>',
		);
		expect(out.match(/nonce="RAW123"/g)).toHaveLength(1);
	});

	it("treats slash-ended script openings as raw text until their closing tag", () => {
		const html =
			"<html><head></head><body><script/>const sample = \"<button onclick='fake()'>\";</script></body></html>";
		const out = injectHeadMeta(html, () => "SLASH123");

		expect(out).toContain('<script/ nonce="SLASH123">');
		expect(out).toContain("<button onclick='fake()'>");
	});

	it("nonces data-src scripts but leaves data blocks non-executable", () => {
		const html =
			'<html><head></head><body><script data-src="not-external.js">run()</script>' +
			'<script type="application/ld+json">{"name":"report"}</script>' +
			'<script type="text/template"><button onclick="shown-as-text()"></button></script>' +
			"</body></html>";
		const out = injectHeadMeta(html, () => "DATA123");

		expect(out).toContain(
			'<script data-src="not-external.js" nonce="DATA123">run()</script>',
		);
		expect(out).toContain(
			'<script type="application/ld+json">{"name":"report"}</script>',
		);
		expect(out).toContain("script-src 'nonce-DATA123'");
		expect(out.match(/nonce="DATA123"/g)).toHaveLength(1);
	});

	it("each publish mints a fresh nonce (CSP + script tag agree)", () => {
		const html = `<html><head></head><body><script nonce="${NONCE}">1;</script></body></html>`;
		const output = injectHeadMeta(html, () => "N0NCE123");
		expect(output).not.toContain(NONCE);
		expect(output).toContain('<script nonce="N0NCE123">');
		expect(output).toContain("script-src 'nonce-N0NCE123'");
		expect(output).toContain("style-src 'unsafe-inline'");
	});

	it("a placeholder in escaped text cannot create executable script", () => {
		const html = `<html><head></head><body><pre>${NONCE}</pre></body></html>`;
		const output = injectHeadMeta(html, () => "XYZ");
		expect(output).not.toContain(NONCE);
		expect(output).not.toContain("<script");
	});

	it("text mentioning the placeholder does not leave real inline scripts nonce-less", () => {
		const html =
			`<html><head></head><body><pre>docs mention ${NONCE}</pre>` +
			"<script>interactive()</script></body></html>";
		const out = injectHeadMeta(html, () => "TEXT123");

		expect(out).not.toContain(NONCE);
		expect(out).toContain('<script nonce="TEXT123">interactive()</script>');
		expect(out).toContain("script-src 'nonce-TEXT123'");
	});

	it("trims http-equiv values when preserving an author CSP", () => {
		const html =
			'<html><head><meta http-equiv=" Content-Security-Policy " content="default-src *"></head><body></body></html>';
		const out = injectHeadMeta(html);

		expect(out.match(/Content-Security-Policy/gi)).toHaveLength(1);
		expect(out).toContain('content="default-src *"');
	});
});
