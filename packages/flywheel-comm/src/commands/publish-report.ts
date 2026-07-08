/**
 * FLY-203 — `flywheel-comm publish-report`.
 *
 * One command any agent can run after generating an HTML report locally:
 *
 *   flywheel-comm publish-report --html /tmp/report.html --project flywheel \
 *     [--title "Ship Review"] [--channel <id>] [--no-screenshot]
 *
 * Orchestrates three steps client-side (Bridge stays thin — it only hosts
 * and posts):
 *   1. POST {bridge}/api/reports/publish   → unguessable hosted URL
 *   2. proofshot screenshot of the PUBLISHED url (degradable — a screenshot
 *      failure must never block link delivery)
 *   3. POST {bridge}/api/reports/deliver   → ONE Discord message
 *      (screenshot attachment + link, or link-only when degraded)
 *
 * stdout contract (Codex design review R1#6): ALWAYS exactly one compact
 * JSON envelope on stdout — agent-facing, like visual-capture. Human
 * diagnostics go to stderr. After a successful publish the envelope carries
 * `url` even when a later step fails, so the agent can hand-forward the link.
 *
 * ProofShot sequence (R1#5): lock → temp output dir → free port →
 * `start --url … --port … --output … --description …` → `exec screenshot` →
 * move PNG into the previews contract dir → `stop` ALWAYS runs in finally
 * once start succeeded (no leaked browser/port).
 */

import { execFileSync } from "node:child_process";
import type { Dirent } from "node:fs";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	DEFAULT_PORT_RANGE_START,
	findFreePort,
} from "../proofshot/free-port.js";
import {
	type AcquiredLock,
	acquireProofShotLockWithRetry,
} from "../proofshot/lock.js";

const MAX_HTML_SIZE = 512 * 1024; // matches Bridge /api/reports/publish cap
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024; // matches Bridge deliver cap
const SCREENSHOT_FILENAME = "report-preview.png";

/**
 * ProofShot subprocess runner seam. `opts.cwd` is REQUIRED semantics, not a
 * nicety: proofshot's exec/stop resolve their session from the process cwd
 * (see captureReportScreenshot contract note).
 */
export type RunProofShot = (args: string[], opts?: { cwd?: string }) => void;

export interface PublishReportArgs {
	htmlPath: string;
	project: string;
	title?: string;
	channelId?: string;
	noScreenshot?: boolean;
	/**
	 * FLY-929 B1: OPTIONAL delivery-receipt fields forwarded verbatim in the
	 * /deliver body. `kind: "token_report"` + `expectedDate` (YYYY-MM-DD, the
	 * report day the token-report CLI computed under TOKEN_USAGE_TIMEZONE) let
	 * the Bridge write the P-expect receipt. Absent ⇒ pre-FLY-929 body,
	 * byte-compat (JSON.stringify drops undefined keys).
	 */
	kind?: string;
	expectedDate?: string;
	/** Test seams. */
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	runProofShot?: RunProofShot;
	findPort?: (preferredPort: number) => number | null;
	acquireLock?: () => Promise<AcquiredLock>;
	makeTempDir?: () => string;
	warn?: (msg: string) => void;
}

/** The one-line stdout JSON envelope. */
export interface PublishReportEnvelope {
	url: string | null;
	reportId: string | null;
	messageId: string | null;
	screenshot: string | null;
	delivered: boolean;
	/** Present when FLYWHEEL_REMOTE_REPORTS=0 short-circuited the run. */
	skipped?: boolean;
	error?: string;
}

export interface PublishReportResult {
	envelope: PublishReportEnvelope;
	exitCode: number;
}

export async function publishReport(
	args: PublishReportArgs,
): Promise<PublishReportResult> {
	const env = args.env ?? process.env;
	const fetchImpl = args.fetchImpl ?? fetch;
	const warn = args.warn ?? ((msg: string) => console.error(msg));

	// Kill switch — zero network calls (Bridge enforces its own 503 too).
	if (env.FLYWHEEL_REMOTE_REPORTS === "0") {
		warn(
			"publish-report: FLYWHEEL_REMOTE_REPORTS=0 — remote report pipeline disabled, skipping (local report untouched)",
		);
		return {
			envelope: {
				url: null,
				reportId: null,
				messageId: null,
				screenshot: null,
				delivered: false,
				skipped: true,
			},
			exitCode: 0,
		};
	}

	const fail = (error: string): PublishReportResult => ({
		envelope: {
			url: null,
			reportId: null,
			messageId: null,
			screenshot: null,
			delivered: false,
			error,
		},
		exitCode: 1,
	});

	// ── input validation ──────────────────────────────────────────────
	const bridgeUrl = (env.FLYWHEEL_BRIDGE_URL ?? env.BRIDGE_URL ?? "").replace(
		/\/+$/,
		"",
	);
	if (!bridgeUrl) {
		return fail(
			"FLYWHEEL_BRIDGE_URL (or BRIDGE_URL) environment variable is required",
		);
	}
	if (!args.project || args.project.trim().length === 0) {
		return fail("--project is required");
	}

	let html: string;
	try {
		html = readFileSync(args.htmlPath, "utf-8");
	} catch (err) {
		return fail(`failed to read --html file: ${(err as Error).message}`);
	}
	if (html.trim().length === 0) {
		return fail("--html file is empty");
	}
	if (Buffer.byteLength(html, "utf-8") > MAX_HTML_SIZE) {
		return fail(`--html file exceeds maximum size of ${MAX_HTML_SIZE} bytes`);
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (env.TEAMLEAD_API_TOKEN) {
		headers.Authorization = `Bearer ${env.TEAMLEAD_API_TOKEN}`;
	}

	// ── 1. publish ────────────────────────────────────────────────────
	let url: string;
	let reportId: string;
	try {
		const res = await fetchImpl(`${bridgeUrl}/api/reports/publish`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				projectName: args.project.trim(),
				html,
				title: args.title,
			}),
		});
		const body = (await res.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		if (!res.ok) {
			return fail(
				`publish failed (${res.status}): ${String(body.error ?? "unknown error")}`,
			);
		}
		if (typeof body.url !== "string" || typeof body.reportId !== "string") {
			return fail("publish response missing url/reportId");
		}
		url = body.url;
		reportId = body.reportId;
	} catch (err) {
		return fail(`publish request failed: ${(err as Error).message}`);
	}

	// ── 2. screenshot (degradable) ────────────────────────────────────
	let screenshot: string | null = null;
	if (!args.noScreenshot) {
		try {
			screenshot = await captureReportScreenshot({
				url,
				reportId,
				title: args.title,
				env,
				runProofShot: args.runProofShot,
				findPort: args.findPort,
				acquireLock: args.acquireLock,
				makeTempDir: args.makeTempDir,
				warn,
			});
		} catch (err) {
			warn(
				`publish-report: screenshot failed (${(err as Error).message}) — delivering link-only message`,
			);
			screenshot = null;
		}
	}

	// ── 3. deliver ────────────────────────────────────────────────────
	try {
		const res = await fetchImpl(`${bridgeUrl}/api/reports/deliver`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				url,
				projectName: args.project.trim(),
				title: args.title,
				channelId: args.channelId,
				screenshotPath: screenshot ?? undefined,
				// FLY-929 B1: receipt fields — undefined keys are dropped by
				// JSON.stringify, so the no-flag body stays byte-identical.
				kind: args.kind,
				expectedDate: args.expectedDate,
			}),
		});
		const body = (await res.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		if (!res.ok) {
			// Report IS published — keep url in the envelope so the agent can
			// forward the link manually.
			return {
				envelope: {
					url,
					reportId,
					messageId: null,
					screenshot,
					delivered: false,
					error: `deliver failed (${res.status}): ${String(body.error ?? "unknown error")}`,
				},
				exitCode: 1,
			};
		}
		return {
			envelope: {
				url,
				reportId,
				messageId: typeof body.messageId === "string" ? body.messageId : null,
				screenshot,
				delivered: true,
			},
			exitCode: 0,
		};
	} catch (err) {
		return {
			envelope: {
				url,
				reportId,
				messageId: null,
				screenshot,
				delivered: false,
				error: `deliver request failed: ${(err as Error).message}`,
			},
			exitCode: 1,
		};
	}
}

// ── screenshot helper ────────────────────────────────────────────────

interface CaptureArgs {
	url: string;
	reportId: string;
	title?: string;
	env: NodeJS.ProcessEnv;
	runProofShot?: RunProofShot;
	findPort?: (preferredPort: number) => number | null;
	acquireLock?: () => Promise<AcquiredLock>;
	makeTempDir?: () => string;
	warn: (msg: string) => void;
}

/**
 * Screenshot the published report URL via ProofShot. Returns the absolute
 * path of the PNG inside the previews contract directory
 * (`{FLYWHEEL_REPORTS_DIR ?? ~/.flywheel/reports}/previews/<reportId>.png`).
 * Throws on failure — the caller degrades to link-only delivery.
 *
 * ProofShot v1.3.1 invocation contract — pinned by a REAL spike on
 * 2026-06-04 after QA Round 1 caught two wiring bugs the mocked unit tests
 * encoded around (same lesson as FLY-169: mocks can assume a false external
 * tool contract):
 *   - `exec`/`stop` do NOT accept `--output`; they resolve the session via
 *     loadConfig() from the process CWD. Passing `--output` to start while
 *     exec/stop run from another cwd splits the session → screenshots land
 *     in the caller's cwd and `stop` errors out, leaking the headless
 *     browser (and breaking the NEXT proofshot user with "Recording is
 *     required").
 *   - Fix: run ALL THREE commands with `cwd: outputDir` and NO `--output` —
 *     start/exec/stop then share `{outputDir}/proofshot-artifacts/`.
 *   - The screenshot is saved into a TIMESTAMPED session subdir
 *     (`proofshot-artifacts/<ts>_<description-slug>/report-preview.png`),
 *     so we locate it by recursive filename search, not a fixed path.
 *   - Spike-verified: stop exits cleanly and the browser process tree is
 *     gone afterwards.
 */
async function captureReportScreenshot(args: CaptureArgs): Promise<string> {
	const runProofShot = args.runProofShot ?? defaultRunProofShot;
	const findPort = args.findPort ?? findFreePort;
	const acquireLock = args.acquireLock ?? acquireProofShotLockWithRetry;
	const makeTempDir =
		args.makeTempDir ??
		(() => mkdtempSync(join(tmpdir(), "fly203-report-shot-")));

	const previewsRoot = join(
		args.env.FLYWHEEL_REPORTS_DIR ??
			resolve(homeDir(args.env), ".flywheel", "reports"),
		"previews",
	);

	const lock = await acquireLock();
	let outputDir: string | undefined;
	let started = false;
	try {
		outputDir = makeTempDir();
		const port = findPort(DEFAULT_PORT_RANGE_START);
		if (port == null) {
			throw new Error("no free port for ProofShot");
		}
		const proofShotOpts = { cwd: outputDir };

		runProofShot(
			[
				"start",
				"--url",
				args.url,
				"--port",
				String(port),
				"--description",
				args.title ?? "report preview",
			],
			proofShotOpts,
		);
		started = true;

		// Final form (founder-decided after the demo rounds, 2026-06-04):
		// FULL-PAGE capture at deviceScaleFactor 2 — "图管扫结构,链接管细读".
		// 2x keeps the Discord-side downscaled rendition legible enough to
		// scan; the accepted cost is zoom softness on very tall reports.
		//
		// Degrade ladder for extreme reports (Chromium caps capture surfaces
		// around ~16k px and Discord caps attachments at 25MB):
		//   scale 2 → on capture failure or >25MB PNG, retry at scale 1 →
		//   on failure again, throw (caller delivers link-only).
		const width = resolveShotWidth(args.env);
		let captured: string | undefined;
		for (const scale of [2, 1]) {
			// Best-effort viewport set: a viewport-set failure must not cost
			// the capture (ProofShot's 1280@1x default is still valid).
			try {
				runProofShot(
					["exec", "set", "viewport", String(width), "720", String(scale)],
					proofShotOpts,
				);
			} catch (err) {
				args.warn(
					`publish-report: viewport set failed (${(err as Error).message}) — capturing at ProofShot default viewport`,
				);
			}

			// agent-browser parses `screenshot [selector] [path]` — the --full
			// flag MUST come before the path or the path is treated as a
			// selector (spike-pinned).
			try {
				runProofShot(
					["exec", "screenshot", "--full", SCREENSHOT_FILENAME],
					proofShotOpts,
				);
			} catch (err) {
				args.warn(
					`publish-report: full-page capture at ${scale}x failed (${(err as Error).message})${scale === 2 ? " — retrying at 1x" : ""}`,
				);
				continue;
			}

			// ProofShot saves into a timestamped session subdir — find the PNG.
			const found = findFileByName(outputDir, SCREENSHOT_FILENAME);
			if (!found) {
				args.warn(
					`publish-report: no ${SCREENSHOT_FILENAME} produced at ${scale}x${scale === 2 ? " — retrying at 1x" : ""}`,
				);
				continue;
			}
			const bytes = statSync(found).size;
			if (bytes > MAX_SCREENSHOT_BYTES) {
				args.warn(
					`publish-report: ${scale}x capture is ${bytes} bytes (> ${MAX_SCREENSHOT_BYTES} Discord cap)${scale === 2 ? " — retrying at 1x" : ""}`,
				);
				rmSync(found, { force: true });
				continue;
			}
			captured = found;
			break;
		}
		if (!captured) {
			throw new Error(
				"full-page capture failed at both 2x and 1x (see warnings)",
			);
		}

		mkdirSync(previewsRoot, { recursive: true });
		const dest = join(previewsRoot, `${args.reportId}.png`);
		// copy+rm instead of rename — tmpdir may sit on another volume.
		copyFileSync(captured, dest);
		if (!isAbsolute(dest)) {
			throw new Error(`preview destination is not absolute: ${dest}`);
		}
		return dest;
	} finally {
		// stop MUST run once start succeeded — never leak the browser/port
		// (Codex R1#5). A stop failure is warned, not thrown: it must not
		// mask the actual screenshot result. Same cwd as start — that is
		// where the session lives (QA Round 1 Bug B).
		if (started) {
			try {
				runProofShot(["stop"], { cwd: outputDir });
			} catch (err) {
				args.warn(
					`publish-report: proofshot stop failed: ${(err as Error).message}`,
				);
			}
		}
		if (outputDir) {
			try {
				rmSync(outputDir, { recursive: true, force: true });
			} catch {
				// best-effort temp cleanup
			}
		}
		lock.release();
	}
}

function homeDir(env: NodeJS.ProcessEnv): string {
	return env.HOME ?? "~";
}

export const DEFAULT_REPORT_SHOT_WIDTH = 860;

/** FLYWHEEL_REPORT_SHOT_WIDTH env knob (px). Invalid/absent → default 860. */
function resolveShotWidth(env: NodeJS.ProcessEnv): number {
	const raw = env.FLYWHEEL_REPORT_SHOT_WIDTH;
	if (raw && /^\d+$/.test(raw)) {
		const n = Number(raw);
		if (n >= 320 && n <= 3840) return n;
	}
	return DEFAULT_REPORT_SHOT_WIDTH;
}

function defaultRunProofShot(
	args: string[],
	opts: { cwd?: string } = {},
): void {
	execFileSync("proofshot", args, {
		stdio: ["pipe", "inherit", "inherit"],
		cwd: opts.cwd,
	});
}

/** Recursively locate the first file named `name` under `dir` (depth-first). */
function findFileByName(dir: string, name: string): string | undefined {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isFile() && e.name === name) return p;
		if (e.isDirectory()) {
			const found = findFileByName(p, name);
			if (found) return found;
		}
	}
	return undefined;
}
