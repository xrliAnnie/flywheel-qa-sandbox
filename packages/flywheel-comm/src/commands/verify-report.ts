/**
 * FLY-1828: cheap hosted-report verification with an opt-in, process-group
 * bounded Chrome screenshot. The default path never starts a browser.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	accessSync,
	constants,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
	EXTERNAL_SCRIPT_REJECTION_MESSAGE,
	htmlAttribute,
	htmlHeadRange,
	isCspGovernedInlineScript,
	isExternalScript,
	scanHtmlTags,
} from "../report-html.js";

export const DEFAULT_CHROME_BIN =
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const DEFAULT_VERIFY_TIMEOUT_MS = 15_000;
export const DEFAULT_SHOT_TIMEOUT_MS = 20_000;
export const DEFAULT_SHOT_WINDOW = "1280x2000";
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const MIN_WINDOW_PX = 320;
const MAX_WINDOW_PX = 8_192;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

type CheckResult = "pass" | "fail" | "skipped";

export interface VerifyReportChecks {
	http: CheckResult;
	noncePlaceholder: CheckResult;
	scriptCsp: CheckResult;
	scriptNonce: CheckResult;
	expect: CheckResult;
}

export interface VerifyReportEnvelope {
	ok: boolean;
	url: string;
	status: number | null;
	checks: VerifyReportChecks;
	warnings: string[];
	info: { hasInlineSvg: boolean; imgCount: number };
	screenshot: { path: string; width: number; height: number } | null;
	error?: string;
}

export interface VerifyReportResult {
	envelope: VerifyReportEnvelope;
	exitCode: number;
}

export interface ScreenshotDeps {
	spawnImpl?: typeof spawn;
	killProcess?: typeof process.kill;
	sleep?: (ms: number) => Promise<void>;
	renameFile?: typeof renameSync;
	removePath?: typeof rmSync;
}

export interface VerifyReportArgs {
	url: string;
	expect?: string;
	screenshotPath?: string;
	shotWindow?: string;
	timeoutMs?: number;
	shotTimeoutMs?: number;
	chromeBin?: string;
	fetchImpl?: typeof fetch;
	screenshotDeps?: ScreenshotDeps;
}

const emptyChecks = (): VerifyReportChecks => ({
	http: "skipped",
	noncePlaceholder: "skipped",
	scriptCsp: "skipped",
	scriptNonce: "skipped",
	expect: "skipped",
});

const SCRIPT_CSP_REPAIR =
	"republish with publish-report so it can add matching nonces automatically; if authoring the policy manually, add script-src 'nonce-__CSP_NONCE__' to the CSP and nonce=\"__CSP_NONCE__\" to every inline script";

interface ScriptCspDirective {
	nonces: Set<string>;
	unsafeInline: boolean;
}

function scriptCspDirective(content: string): ScriptCspDirective | undefined {
	const directives = content.split(";").map((directive) => directive.trim());
	const scriptSrc = directives.find((directive) =>
		/^script-src(?:\s|$)/i.test(directive),
	);
	if (!scriptSrc) return undefined;
	const effectiveDirective =
		directives.find((directive) =>
			/^script-src-elem(?:\s|$)/i.test(directive),
		) ?? scriptSrc;
	const nonces = new Set<string>();
	const sources = effectiveDirective.split(/\s+/).slice(1);
	for (const token of sources) {
		const match = /^'nonce-([^']+)'$/i.exec(token);
		const nonce = match?.[1];
		if (nonce) nonces.add(nonce);
	}
	return {
		nonces,
		unsafeInline: sources.some(
			(source) => source.toLowerCase() === "'unsafe-inline'",
		),
	};
}

function result(
	envelope: VerifyReportEnvelope,
	exitCode: 0 | 1,
): VerifyReportResult {
	return { envelope, exitCode };
}

function parseHttpUrl(raw: string): URL | string {
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return "--url must use http(s)";
		}
		return url;
	} catch {
		return "--url must be a valid http(s) URL";
	}
}

function validateTimeout(name: string, value: number): string | null {
	if (
		!Number.isInteger(value) ||
		value < MIN_TIMEOUT_MS ||
		value > MAX_TIMEOUT_MS
	) {
		return `--${name} must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`;
	}
	return null;
}

function parseWindow(raw: string): { width: number; height: number } | string {
	const match = raw.match(/^(\d{2,5})x(\d{2,5})$/);
	if (!match) {
		return `--shot-window must be WxH with each dimension between ${MIN_WINDOW_PX} and ${MAX_WINDOW_PX}`;
	}
	const width = Number(match[1]);
	const height = Number(match[2]);
	if (
		width < MIN_WINDOW_PX ||
		width > MAX_WINDOW_PX ||
		height < MIN_WINDOW_PX ||
		height > MAX_WINDOW_PX
	) {
		return `--shot-window must be WxH with each dimension between ${MIN_WINDOW_PX} and ${MAX_WINDOW_PX}`;
	}
	return { width, height };
}

/** Run hosted-page checks, optionally followed by one bounded Chrome shot. */
export async function verifyReport(
	args: VerifyReportArgs,
): Promise<VerifyReportResult> {
	const checks = emptyChecks();
	const warnings: string[] = [];
	const info = { hasInlineSvg: false, imgCount: 0 };
	let status: number | null = null;
	const fail = (error: string): VerifyReportResult =>
		result(
			{
				ok: false,
				url: args.url,
				status,
				checks,
				warnings,
				info,
				screenshot: null,
				error,
			},
			1,
		);

	const parsedUrl = parseHttpUrl(args.url);
	if (typeof parsedUrl === "string") return fail(parsedUrl);
	const timeoutMs = args.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
	const timeoutError = validateTimeout("timeout-ms", timeoutMs);
	if (timeoutError) return fail(timeoutError);
	const shotTimeoutMs = args.shotTimeoutMs ?? DEFAULT_SHOT_TIMEOUT_MS;
	const shotTimeoutError = validateTimeout("shot-timeout-ms", shotTimeoutMs);
	if (shotTimeoutError) return fail(shotTimeoutError);
	const shotWindow = parseWindow(args.shotWindow ?? DEFAULT_SHOT_WINDOW);
	if (typeof shotWindow === "string") return fail(shotWindow);

	const chromeBin = args.chromeBin ?? DEFAULT_CHROME_BIN;
	if (args.screenshotPath !== undefined) {
		if (!isAbsolute(args.screenshotPath)) {
			return fail("--screenshot must be an absolute path");
		}
		if (!isAbsolute(chromeBin)) {
			return fail("--chrome-bin must be an absolute path");
		}
		try {
			accessSync(dirname(args.screenshotPath), constants.W_OK);
		} catch (error) {
			return fail(
				`--screenshot parent directory is not writable: ${(error as Error).message}`,
			);
		}
		try {
			accessSync(chromeBin, constants.X_OK);
		} catch (error) {
			return fail(
				`--chrome-bin is not executable: ${(error as Error).message}`,
			);
		}
	}

	let body: string;
	try {
		const response = await (args.fetchImpl ?? fetch)(parsedUrl, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		status = response.status;
		if (!response.ok) {
			checks.http = "fail";
			return fail(`HTTP ${response.status}`);
		}
		checks.http = "pass";
		body = await response.text();
	} catch (error) {
		return fail(`request failed: ${(error as Error).message}`);
	}

	if (body.includes("__CSP_NONCE__")) {
		checks.noncePlaceholder = "fail";
		return fail("hosted page still contains __CSP_NONCE__");
	}
	checks.noncePlaceholder = "pass";

	const scan = scanHtmlTags(body);
	const tags = scan.openings;
	const scripts = tags.filter((tag) => tag.name === "script");
	const externalScript = scripts.find(isExternalScript);
	if (externalScript) {
		checks.scriptNonce = "fail";
		return fail(EXTERNAL_SCRIPT_REJECTION_MESSAGE);
	}
	const inlineScripts = scripts.filter(isCspGovernedInlineScript);
	if (inlineScripts.length > 0) {
		const head = htmlHeadRange(scan);
		const policies =
			head === undefined
				? []
				: tags.filter(
						(tag) =>
							tag.name === "meta" &&
							tag.start >= head.start &&
							tag.start < head.end &&
							htmlAttribute(tag, "http-equiv")?.value?.trim().toLowerCase() ===
								"content-security-policy",
					);
		const scriptNonces = inlineScripts
			.map((tag) => htmlAttribute(tag, "nonce")?.value)
			.filter((nonce): nonce is string => nonce !== undefined && nonce !== "");
		if (policies.length === 0) {
			checks.scriptCsp = "fail";
			return fail(
				`hosted page has executable inline script but no CSP meta in <head>; ${SCRIPT_CSP_REPAIR}`,
			);
		}
		for (const policy of policies) {
			const content = htmlAttribute(policy, "content")?.value ?? "";
			const directive = scriptCspDirective(content);
			if (directive === undefined || directive.nonces.size === 0) {
				checks.scriptCsp = "fail";
				return fail(
					`hosted page CSP ${
						directive?.unsafeInline
							? "permits 'unsafe-inline' but has no nonce-isolated script-src"
							: "has no nonce source in script-src"
					}; ${SCRIPT_CSP_REPAIR}`,
				);
			}
			const rejectedNonce = scriptNonces.find(
				(nonce) => !directive.nonces.has(nonce),
			);
			if (rejectedNonce !== undefined) {
				checks.scriptCsp = "fail";
				return fail(
					`hosted page inline script nonce is not authorized by every CSP script-src; ${SCRIPT_CSP_REPAIR}`,
				);
			}
		}
		checks.scriptCsp = "pass";
	} else {
		checks.scriptCsp = "skipped";
	}

	const missingNonce = inlineScripts.find(
		(tag) => (htmlAttribute(tag, "nonce")?.value ?? "") === "",
	);
	if (missingNonce) {
		checks.scriptNonce = "fail";
		return fail("hosted page has an executable inline script without a nonce");
	}
	checks.scriptNonce = inlineScripts.length > 0 ? "pass" : "skipped";

	if (args.expect !== undefined) {
		if (!body.includes(args.expect)) {
			checks.expect = "fail";
			return fail("hosted page is missing the expected substring");
		}
		checks.expect = "pass";
	} else {
		checks.expect = "skipped";
	}

	const braceCount = body.match(/\{\{/g)?.length ?? 0;
	if (braceCount > 0) warnings.push(`braces: found '{{' ${braceCount}x`);
	info.hasInlineSvg = /<svg\b/i.test(body);
	info.imgCount = body.match(/<img\b/gi)?.length ?? 0;

	let screenshot: VerifyReportEnvelope["screenshot"] = null;
	if (args.screenshotPath !== undefined) {
		let capture: CaptureResult;
		try {
			capture = await captureScreenshot({
				url: parsedUrl.href,
				targetPath: args.screenshotPath,
				chromeBin,
				width: shotWindow.width,
				height: shotWindow.height,
				timeoutMs: shotTimeoutMs,
				deps: args.screenshotDeps ?? {},
			});
		} catch (error) {
			return fail(`screenshot setup failed: ${(error as Error).message}`);
		}
		warnings.push(...capture.warnings);
		if (!capture.ok) return fail(capture.error);
		screenshot = {
			path: args.screenshotPath,
			width: capture.width,
			height: capture.height,
		};
	}

	return result(
		{
			ok: true,
			url: parsedUrl.href,
			status,
			checks,
			warnings,
			info,
			screenshot,
		},
		0,
	);
}

type CaptureResult =
	| { ok: true; width: number; height: number; warnings: string[] }
	| { ok: false; error: string; warnings: string[] };

interface CaptureScreenshotArgs {
	url: string;
	targetPath: string;
	chromeBin: string;
	width: number;
	height: number;
	timeoutMs: number;
	deps: ScreenshotDeps;
}

type ChildOutcome =
	| { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
	| { kind: "error"; error: Error }
	| { kind: "timeout" };

async function captureScreenshot(
	args: CaptureScreenshotArgs,
): Promise<CaptureResult> {
	const warnings: string[] = [];
	const spawnImpl = args.deps.spawnImpl ?? spawn;
	const sleep = args.deps.sleep ?? defaultSleep;
	const killProcess = args.deps.killProcess ?? process.kill.bind(process);
	const renameFile = args.deps.renameFile ?? renameSync;
	const removePath = args.deps.removePath ?? rmSync;
	const profileDir = mkdtempSync(join(tmpdir(), "fly1828-shot-"));
	const tempShot = join(
		dirname(args.targetPath),
		`.${basename(args.targetPath)}.fly1828-tmp-${randomUUID()}.png`,
	);
	try {
		let child: ChildProcess;
		try {
			child = spawnImpl(
				args.chromeBin,
				[
					"--headless=new",
					"--disable-gpu",
					"--hide-scrollbars",
					`--window-size=${args.width},${args.height}`,
					`--screenshot=${tempShot}`,
					"--virtual-time-budget=4000",
					`--timeout=${Math.floor(args.timeoutMs * 0.8)}`,
					`--user-data-dir=${profileDir}`,
					args.url,
				],
				{ detached: true, stdio: "ignore" },
			);
		} catch (error) {
			return {
				ok: false,
				error: `failed to start Chrome: ${(error as Error).message}`,
				warnings,
			};
		}

		const outcome = await waitForChild(child, args.timeoutMs);
		const pgid = child.pid;
		if (pgid === undefined) {
			return {
				ok: false,
				error:
					outcome.kind === "error"
						? `failed to start Chrome: ${outcome.error.message}`
						: "failed to start Chrome: child pid unavailable",
				warnings,
			};
		}

		const naturalGraceMs =
			outcome.kind === "exit" && outcome.code === 0 ? 1_000 : 0;
		let groupResult: { gone: boolean; escalated: boolean };
		try {
			groupResult = await ensureProcessGroupGone(
				pgid,
				naturalGraceMs,
				killProcess,
				sleep,
			);
		} catch (error) {
			return {
				ok: false,
				error: `process-group cleanup failed for pgid ${pgid}: ${(error as Error).message}`,
				warnings,
			};
		}
		if (!groupResult.gone) {
			return {
				ok: false,
				error: `pgid ${pgid} survived SIGKILL`,
				warnings,
			};
		}
		if (outcome.kind === "error") {
			return {
				ok: false,
				error: `Chrome process error: ${outcome.error.message}`,
				warnings,
			};
		}
		if (outcome.kind === "exit" && outcome.code !== 0) {
			return {
				ok: false,
				error: `Chrome exited with ${outcome.code ?? outcome.signal ?? "unknown status"}`,
				warnings,
			};
		}
		if (outcome.kind === "exit" && groupResult.escalated) {
			warnings.push(`helper processes outlived main; pgid ${pgid} escalated`);
		}

		const dimensions = validatePng(tempShot);
		if (typeof dimensions === "string") {
			if (outcome.kind === "timeout") {
				return {
					ok: false,
					error: `screenshot timeout (pgid ${pgid} killed)`,
					warnings,
				};
			}
			return { ok: false, error: dimensions, warnings };
		}
		try {
			renameFile(tempShot, args.targetPath);
		} catch (error) {
			return {
				ok: false,
				error: `failed to rename screenshot atomically: ${(error as Error).message}`,
				warnings,
			};
		}
		return { ok: true, ...dimensions, warnings };
	} finally {
		for (const [path, recursive] of [
			[tempShot, false],
			[profileDir, true],
		] as const) {
			try {
				removePath(path, { recursive, force: true });
			} catch (error) {
				warnings.push(
					`cleanup failed for ${path}: ${(error as Error).message}`,
				);
			}
		}
	}
}

function waitForChild(
	child: ChildProcess,
	timeoutMs: number,
): Promise<ChildOutcome> {
	return new Promise((resolveOutcome) => {
		let settled = false;
		const finish = (outcome: ChildOutcome): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveOutcome(outcome);
		};
		const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
		child.once("error", (error) => finish({ kind: "error", error }));
		child.once("exit", (code, signal) =>
			finish({ kind: "exit", code, signal }),
		);
		child.unref();
		if (child.pid === undefined) {
			setImmediate(() =>
				finish({
					kind: "error",
					error: new Error("child pid unavailable"),
				}),
			);
		}
	});
}

async function ensureProcessGroupGone(
	pgid: number,
	naturalGraceMs: number,
	killProcess: typeof process.kill,
	sleep: (ms: number) => Promise<void>,
): Promise<{ gone: boolean; escalated: boolean }> {
	if (
		(await waitForGroupGone(
			pgid,
			naturalGraceMs,
			naturalGraceMs > 0 ? 100 : 0,
			killProcess,
			sleep,
		)) === "gone"
	) {
		return { gone: true, escalated: false };
	}
	if (signalGroup(pgid, "SIGTERM", killProcess)) {
		return { gone: true, escalated: true };
	}
	if (
		(await waitForGroupGone(pgid, 2_000, 200, killProcess, sleep)) === "gone"
	) {
		return { gone: true, escalated: true };
	}
	if (signalGroup(pgid, "SIGKILL", killProcess)) {
		return { gone: true, escalated: true };
	}
	const finalState = await waitForGroupGone(
		pgid,
		5_000,
		200,
		killProcess,
		sleep,
	);
	return { gone: finalState === "gone", escalated: true };
}

function signalGroup(
	pgid: number,
	signal: NodeJS.Signals,
	killProcess: typeof process.kill,
): boolean {
	try {
		killProcess(-pgid, signal);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
		throw error;
	}
}

async function waitForGroupGone(
	pgid: number,
	totalMs: number,
	stepMs: number,
	killProcess: typeof process.kill,
	sleep: (ms: number) => Promise<void>,
): Promise<"gone" | "alive" | "inaccessible"> {
	let state = processGroupState(pgid, killProcess);
	if (state === "gone") return state;
	if (totalMs <= 0 || stepMs <= 0) return state;
	for (let waited = 0; waited < totalMs; waited += stepMs) {
		await sleep(Math.min(stepMs, totalMs - waited));
		state = processGroupState(pgid, killProcess);
		if (state === "gone") return state;
	}
	return state;
}

function processGroupState(
	pgid: number,
	killProcess: typeof process.kill,
): "gone" | "alive" | "inaccessible" {
	try {
		killProcess(-pgid, 0);
		return "alive";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "gone";
		if (code === "EPERM") return "inaccessible";
		throw error;
	}
}

function validatePng(path: string): { width: number; height: number } | string {
	let bytes: Buffer;
	try {
		if (!statSync(path).isFile())
			return "screenshot output is not a regular file";
		bytes = readFileSync(path);
	} catch {
		return "Chrome did not produce a screenshot";
	}
	if (bytes.length < 24) return "screenshot PNG is too short";
	if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
		return "screenshot has an invalid PNG signature";
	}
	if (
		bytes.readUInt32BE(8) !== 13 ||
		bytes.toString("ascii", 12, 16) !== "IHDR"
	) {
		return "screenshot is missing a valid IHDR chunk";
	}
	const width = bytes.readUInt32BE(16);
	const height = bytes.readUInt32BE(20);
	if (width === 0 || height === 0) return "screenshot IHDR has zero dimensions";
	if (
		bytes.length < 36 ||
		bytes.readUInt32BE(bytes.length - 12) !== 0 ||
		bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND"
	) {
		return "screenshot is missing a complete IEND chunk";
	}
	return { width, height };
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
