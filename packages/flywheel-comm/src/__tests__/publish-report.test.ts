/**
 * FLY-203: publish-report CLI orchestration tests — all seams injected.
 *
 * The contracts under test:
 *   - kill switch: zero network calls, exit 0
 *   - always-one-JSON-envelope semantics (url survives deliver failure)
 *   - screenshot degradation: failure → link-only delivery, exit 0
 *   - proofshot stop ALWAYS runs once start succeeded (R1#5)
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type PublishReportArgs,
	publishReport,
} from "../commands/publish-report.js";
import type { AcquiredLock } from "../proofshot/lock.js";

const HTML = "<!doctype html><html><head></head><body>r</body></html>";

describe("publishReport", () => {
	let dir: string;
	let htmlPath: string;
	let reportsDir: string;
	let fetchMock: ReturnType<typeof vi.fn>;
	let proofShotCalls: string[][];
	let proofShotCwds: (string | undefined)[];
	let releaseMock: ReturnType<typeof vi.fn>;
	let warns: string[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly203-cli-"));
		htmlPath = join(dir, "report.html");
		writeFileSync(htmlPath, HTML);
		reportsDir = join(dir, "reports");
		fetchMock = vi.fn();
		proofShotCalls = [];
		proofShotCwds = [];
		releaseMock = vi.fn();
		warns = [];
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function makeArgs(
		overrides: Partial<PublishReportArgs> = {},
	): PublishReportArgs {
		return {
			htmlPath,
			project: "flywheel",
			title: "T",
			env: {
				FLYWHEEL_BRIDGE_URL: "http://bridge:9876",
				TEAMLEAD_API_TOKEN: "tok",
				FLYWHEEL_REPORTS_DIR: reportsDir,
				HOME: dir,
			} as NodeJS.ProcessEnv,
			fetchImpl: fetchMock as unknown as typeof fetch,
			runProofShot: (a: string[], opts?: { cwd?: string }) => {
				proofShotCalls.push(a);
				proofShotCwds.push(opts?.cwd);
				if (a[0] === "exec" && a[1] === "screenshot") {
					// Real ProofShot contract (spike-verified): PNG lands in a
					// TIMESTAMPED session subdir under {cwd}/proofshot-artifacts/.
					const sessionDir = join(
						opts?.cwd ?? "",
						"proofshot-artifacts",
						"2026-06-04_05-12-14_test-session",
					);
					mkdirSync(sessionDir, { recursive: true });
					writeFileSync(join(sessionDir, "report-preview.png"), "png-bytes");
				}
			},
			findPort: () => 3005,
			acquireLock: async () =>
				({ release: releaseMock }) as unknown as AcquiredLock,
			makeTempDir: () => mkdtempSync(join(dir, "shot-")),
			warn: (m: string) => warns.push(m),
			...overrides,
		};
	}

	function publishOk(): void {
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					url: "https://fw-reports-abc123.vercel.app/r/tok123/",
					reportId: "tok123",
				}),
				{ status: 200 },
			),
		);
	}

	function deliverOk(): void {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ ok: true, messageId: "msg_1" }), {
				status: 200,
			}),
		);
	}

	// ── input validation ────────────────────────────────────────────────

	it("missing bridge url env → exit 1", async () => {
		const args = makeArgs({ env: { HOME: dir } as NodeJS.ProcessEnv });
		const { envelope, exitCode } = await publishReport(args);
		expect(exitCode).toBe(1);
		expect(envelope.error).toContain("FLYWHEEL_BRIDGE_URL");
	});

	it("missing html file → exit 1, no network", async () => {
		const { envelope, exitCode } = await publishReport(
			makeArgs({ htmlPath: join(dir, "ghost.html") }),
		);
		expect(exitCode).toBe(1);
		expect(envelope.error).toContain("failed to read");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("oversized html → exit 1", async () => {
		writeFileSync(
			htmlPath,
			`<html><head></head>${"x".repeat(513 * 1024)}</html>`,
		);
		const { exitCode, envelope } = await publishReport(makeArgs());
		expect(exitCode).toBe(1);
		expect(envelope.error).toContain("maximum size");
	});

	// ── happy path ──────────────────────────────────────────────────────

	it("happy path: publish → screenshot → deliver, envelope complete", async () => {
		publishOk();
		deliverOk();
		const { envelope, exitCode } = await publishReport(makeArgs());

		expect(exitCode).toBe(0);
		expect(envelope).toMatchObject({
			url: "https://fw-reports-abc123.vercel.app/r/tok123/",
			reportId: "tok123",
			messageId: "msg_1",
			delivered: true,
		});
		expect(envelope.screenshot).toBe(
			join(reportsDir, "previews", "tok123.png"),
		);
		expect(existsSync(envelope.screenshot as string)).toBe(true);

		// publish call carried auth + payload
		const [publishUrl, publishInit] = fetchMock.mock.calls[0] as [
			string,
			RequestInit,
		];
		expect(publishUrl).toBe("http://bridge:9876/api/reports/publish");
		expect((publishInit.headers as Record<string, string>).Authorization).toBe(
			"Bearer tok",
		);

		// deliver call carried the screenshot path
		const deliverBody = JSON.parse(
			(fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
		);
		expect(deliverBody.screenshotPath).toBe(envelope.screenshot);
		expect(deliverBody.projectName).toBe("flywheel");

		// proofshot sequence: start --url → set viewport → screenshot --full → stop
		expect(proofShotCalls[0]?.[0]).toBe("start");
		expect(proofShotCalls[0]?.[proofShotCalls[0].indexOf("--url") + 1]).toBe(
			"https://fw-reports-abc123.vercel.app/r/tok123/",
		);
		// ProofShot v1.3.1 contract (QA R1 Bug A): NO --output — exec/stop
		// resolve the session from cwd, so all calls share cwd instead.
		expect(proofShotCalls[0]).not.toContain("--output");
		// content-width viewport @ deviceScaleFactor 2 before the capture
		expect(proofShotCalls[1]).toEqual([
			"exec",
			"set",
			"viewport",
			"860",
			"720",
			"2",
		]);
		// FULL-PAGE capture (founder acceptance), --full BEFORE the path —
		// agent-browser would parse a trailing flag's preceding arg as a
		// selector (spike-pinned ordering).
		expect(proofShotCalls[2]).toEqual([
			"exec",
			"screenshot",
			"--full",
			"report-preview.png",
		]);
		expect(proofShotCalls[3]).toEqual(["stop"]);
		expect(proofShotCwds).toHaveLength(4);
		expect(new Set(proofShotCwds).size).toBe(1); // same cwd for all calls
		expect(proofShotCwds[0]).toBeTruthy();
		expect(releaseMock).toHaveBeenCalledTimes(1);
	});

	it("--no-screenshot skips proofshot entirely", async () => {
		publishOk();
		deliverOk();
		const { envelope, exitCode } = await publishReport(
			makeArgs({ noScreenshot: true }),
		);
		expect(exitCode).toBe(0);
		expect(envelope.screenshot).toBeNull();
		expect(proofShotCalls).toEqual([]);
		const deliverBody = JSON.parse(
			(fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
		);
		expect(deliverBody.screenshotPath).toBeUndefined();
	});

	it("FLY-1404: publish-only returns the hosted URL without screenshot or Discord delivery", async () => {
		publishOk();
		const { envelope, exitCode } = await publishReport(
			makeArgs({ publishOnly: true }),
		);

		expect(exitCode).toBe(0);
		expect(envelope).toMatchObject({
			url: "https://fw-reports-abc123.vercel.app/r/tok123/",
			reportId: "tok123",
			messageId: null,
			screenshot: null,
			delivered: false,
			publishOnly: true,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(proofShotCalls).toEqual([]);
	});

	it.each([
		["default", {}],
		["channel", { channelId: "chan" }],
		["issue", { issueIdentifier: "FLY-1715" }],
	])(
		"FLY-1715: ingest-only %s delivery fails before file read, screenshot, or fetch",
		async (_name, deliveryArgs) => {
			const readHtmlFile = vi.fn(() => HTML);
			const result = await publishReport(
				makeArgs({
					...deliveryArgs,
					env: {
						FLYWHEEL_BRIDGE_URL: "http://bridge:9876",
						FLYWHEEL_INGEST_TOKEN: " ingest-token ",
					} as NodeJS.ProcessEnv,
					readHtmlFile,
				}),
			);
			expect(result.exitCode).toBe(1);
			expect(result.envelope.error).toMatch(/runner.*publish-only/i);
			expect(readHtmlFile).not.toHaveBeenCalled();
			expect(fetchMock).not.toHaveBeenCalled();
			expect(proofShotCalls).toEqual([]);
		},
	);

	it("FLY-1715: ingest-only publish-only succeeds with a normalized bearer", async () => {
		publishOk();
		const result = await publishReport(
			makeArgs({
				publishOnly: true,
				env: {
					FLYWHEEL_BRIDGE_URL: "http://bridge:9876",
					FLYWHEEL_INGEST_TOKEN: "  ingest-token  ",
				} as NodeJS.ProcessEnv,
			}),
		);
		expect(result.exitCode).toBe(0);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(
			(fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)
				.Authorization,
		).toBe("Bearer ingest-token");
	});

	it("FLY-1715: master is preferred over ingest and both blank values are treated as absent", async () => {
		publishOk();
		deliverOk();
		await publishReport(
			makeArgs({
				noScreenshot: true,
				env: {
					FLYWHEEL_BRIDGE_URL: "http://bridge:9876",
					TEAMLEAD_API_TOKEN: " master-token ",
					FLYWHEEL_INGEST_TOKEN: "ingest-token",
				} as NodeJS.ProcessEnv,
			}),
		);
		expect(
			(fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)
				.Authorization,
		).toBe("Bearer master-token");

		fetchMock.mockReset().mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "unauthorized" }), {
				status: 401,
			}),
		);
		await publishReport(
			makeArgs({
				publishOnly: true,
				env: {
					FLYWHEEL_BRIDGE_URL: "http://bridge:9876",
					TEAMLEAD_API_TOKEN: " ",
					FLYWHEEL_INGEST_TOKEN: "",
				} as NodeJS.ProcessEnv,
			}),
		);
		expect(
			(fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)
				.Authorization,
		).toBeUndefined();
	});

	// ── FLY-929 B1: receipt fields ride the deliver body ────────────────

	it("kind + expectedDate are forwarded verbatim in the deliver body", async () => {
		publishOk();
		deliverOk();
		const { exitCode } = await publishReport(
			makeArgs({
				noScreenshot: true,
				kind: "token_report",
				expectedDate: "2026-07-06",
			}),
		);
		expect(exitCode).toBe(0);
		const deliverBody = JSON.parse(
			(fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
		);
		expect(deliverBody.kind).toBe("token_report");
		expect(deliverBody.expectedDate).toBe("2026-07-06");
	});

	it("absent optional delivery fields stay byte-compatible", async () => {
		publishOk();
		deliverOk();
		await publishReport(makeArgs({ noScreenshot: true }));
		const deliverBody = JSON.parse(
			(fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
		);
		expect("kind" in deliverBody).toBe(false);
		expect("expectedDate" in deliverBody).toBe(false);
		expect("issueIdentifier" in deliverBody).toBe(false);
	});

	it("issueIdentifier targets delivery by issue without adding channelId", async () => {
		publishOk();
		deliverOk();
		const { exitCode } = await publishReport(
			makeArgs({
				noScreenshot: true,
				issueIdentifier: "FLY-1463",
			}),
		);
		expect(exitCode).toBe(0);
		const deliverBody = JSON.parse(
			(fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
		);
		expect(deliverBody.issueIdentifier).toBe("FLY-1463");
		expect("channelId" in deliverBody).toBe(false);
	});

	it("channelId plus issueIdentifier fails before publishing", async () => {
		const { envelope, exitCode } = await publishReport(
			makeArgs({
				channelId: "chan-explicit",
				issueIdentifier: "FLY-1463",
			}),
		);
		expect(exitCode).toBe(1);
		expect(envelope.error).toContain("mutually exclusive");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("invalid issueIdentifier fails before publishing", async () => {
		const { envelope, exitCode } = await publishReport(
			makeArgs({ issueIdentifier: "not-an-issue" }),
		);
		expect(exitCode).toBe(1);
		expect(envelope.error).toContain("--issue");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// ── failure paths ───────────────────────────────────────────────────

	it("publish failure → exit 1, no screenshot/deliver attempted", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "boom" }), { status: 502 }),
		);
		const { envelope, exitCode } = await publishReport(makeArgs());
		expect(exitCode).toBe(1);
		expect(envelope.error).toContain("publish failed (502)");
		expect(envelope.url).toBeNull();
		expect(proofShotCalls).toEqual([]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("screenshot failure degrades to link-only delivery, exit 0", async () => {
		publishOk();
		deliverOk();
		const { envelope, exitCode } = await publishReport(
			makeArgs({
				runProofShot: (a: string[]) => {
					proofShotCalls.push(a);
					if (a[0] === "start") throw new Error("browser exploded");
				},
			}),
		);
		expect(exitCode).toBe(0);
		expect(envelope.delivered).toBe(true);
		expect(envelope.screenshot).toBeNull();
		expect(warns.some((w) => w.includes("screenshot failed"))).toBe(true);
		// lock released even on start failure
		expect(releaseMock).toHaveBeenCalledTimes(1);
		const deliverBody = JSON.parse(
			(fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
		);
		expect(deliverBody.screenshotPath).toBeUndefined();
	});

	it("screenshot failure AFTER successful start → stop still runs (R1#5)", async () => {
		publishOk();
		deliverOk();
		const { exitCode } = await publishReport(
			makeArgs({
				runProofShot: (a: string[]) => {
					proofShotCalls.push(a);
					if (a[0] === "exec") throw new Error("screenshot exploded");
				},
			}),
		);
		expect(exitCode).toBe(0);
		// every exec throws → ladder runs both scales (set+screenshot ×2),
		// then degrades — stop still runs in finally
		expect(proofShotCalls.map((c) => c[0])).toEqual([
			"start",
			"exec",
			"exec",
			"exec",
			"exec",
			"stop",
		]);
		expect(releaseMock).toHaveBeenCalledTimes(1);
	});

	it("FLYWHEEL_REPORT_SHOT_WIDTH env overrides viewport width", async () => {
		publishOk();
		deliverOk();
		const args = makeArgs();
		(args.env as Record<string, string>).FLYWHEEL_REPORT_SHOT_WIDTH = "1280";
		await publishReport(args);
		expect(proofShotCalls[1]).toEqual([
			"exec",
			"set",
			"viewport",
			"1280",
			"720",
			"2",
		]);
	});

	it("invalid width env falls back to default 860", async () => {
		publishOk();
		deliverOk();
		const args = makeArgs();
		(args.env as Record<string, string>).FLYWHEEL_REPORT_SHOT_WIDTH = "huge";
		await publishReport(args);
		expect(proofShotCalls[1]?.[3]).toBe("860");
	});

	it("set-viewport failure is warned but screenshot still captured", async () => {
		publishOk();
		deliverOk();
		const { envelope, exitCode } = await publishReport(
			makeArgs({
				runProofShot: (a: string[], opts?: { cwd?: string }) => {
					proofShotCalls.push(a);
					if (a[1] === "set") throw new Error("viewport refused");
					if (a[0] === "exec" && a[1] === "screenshot") {
						const sessionDir = join(
							opts?.cwd ?? "",
							"proofshot-artifacts",
							"s2",
						);
						mkdirSync(sessionDir, { recursive: true });
						writeFileSync(join(sessionDir, "report-preview.png"), "p");
					}
				},
			}),
		);
		expect(exitCode).toBe(0);
		expect(envelope.screenshot).not.toBeNull();
		expect(warns.some((w) => w.includes("viewport set failed"))).toBe(true);
	});

	it("2x capture failure retries at 1x and still delivers a screenshot", async () => {
		publishOk();
		deliverOk();
		let screenshotAttempts = 0;
		const { envelope, exitCode } = await publishReport(
			makeArgs({
				runProofShot: (a: string[], opts?: { cwd?: string }) => {
					proofShotCalls.push(a);
					if (a[1] === "screenshot") {
						screenshotAttempts += 1;
						if (screenshotAttempts === 1) throw new Error("2x too big");
						const sessionDir = join(
							opts?.cwd ?? "",
							"proofshot-artifacts",
							"retry",
						);
						mkdirSync(sessionDir, { recursive: true });
						writeFileSync(join(sessionDir, "report-preview.png"), "p");
					}
				},
			}),
		);
		expect(exitCode).toBe(0);
		expect(envelope.screenshot).not.toBeNull();
		// ladder: viewport scale 2 → fail → viewport scale 1 → success
		const viewportScales = proofShotCalls
			.filter((c) => c[1] === "set")
			.map((c) => c[5]);
		expect(viewportScales).toEqual(["2", "1"]);
		expect(warns.some((w) => w.includes("retrying at 1x"))).toBe(true);
	});

	it("oversized 2x capture (>25MB) retries at 1x", async () => {
		publishOk();
		deliverOk();
		let attempt = 0;
		const { envelope, exitCode } = await publishReport(
			makeArgs({
				runProofShot: (a: string[], opts?: { cwd?: string }) => {
					proofShotCalls.push(a);
					if (a[1] === "screenshot") {
						attempt += 1;
						const sessionDir = join(
							opts?.cwd ?? "",
							"proofshot-artifacts",
							`big-${attempt}`,
						);
						mkdirSync(sessionDir, { recursive: true });
						const f = join(sessionDir, "report-preview.png");
						writeFileSync(f, "p");
						if (attempt === 1) truncateSync(f, 26 * 1024 * 1024); // sparse >25MB
					}
				},
			}),
		);
		expect(exitCode).toBe(0);
		expect(envelope.screenshot).not.toBeNull();
		expect(warns.some((w) => w.includes("Discord cap"))).toBe(true);
	});

	it("both scales failing degrades to link-only", async () => {
		publishOk();
		deliverOk();
		const { envelope, exitCode } = await publishReport(
			makeArgs({
				runProofShot: (a: string[]) => {
					proofShotCalls.push(a);
					if (a[1] === "screenshot") throw new Error("boom");
				},
			}),
		);
		expect(exitCode).toBe(0);
		expect(envelope.delivered).toBe(true);
		expect(envelope.screenshot).toBeNull();
		expect(warns.some((w) => w.includes("failed at both 2x and 1x"))).toBe(
			true,
		);
	});

	it("stop failure is warned, does not mask a successful screenshot", async () => {
		publishOk();
		deliverOk();
		const { envelope, exitCode } = await publishReport(
			makeArgs({
				runProofShot: (a: string[], opts?: { cwd?: string }) => {
					proofShotCalls.push(a);
					if (a[0] === "exec" && a[1] === "screenshot") {
						const sessionDir = join(
							opts?.cwd ?? "",
							"proofshot-artifacts",
							"s1",
						);
						mkdirSync(sessionDir, { recursive: true });
						writeFileSync(join(sessionDir, "report-preview.png"), "p");
					}
					if (a[0] === "stop") throw new Error("stop exploded");
				},
			}),
		);
		expect(exitCode).toBe(0);
		expect(envelope.screenshot).not.toBeNull();
		expect(warns.some((w) => w.includes("stop failed"))).toBe(true);
	});

	it("deliver failure → exit 1 but envelope still carries url", async () => {
		publishOk();
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "channel gone" }), { status: 502 }),
		);
		const { envelope, exitCode } = await publishReport(makeArgs());
		expect(exitCode).toBe(1);
		expect(envelope.url).toBe("https://fw-reports-abc123.vercel.app/r/tok123/");
		expect(envelope.delivered).toBe(false);
		expect(envelope.error).toContain("deliver failed (502)");
	});
});

// ── subprocess-level CLI wrapper contract (code review R1#3) ──────────────
// EVERY exit path of `flywheel-comm publish-report` must print exactly one
// JSON envelope to stdout, including flag/parse errors. Runs the BUILT CLI
// (dist/index.js) like cli.test.ts does.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname2, "../../dist/index.js");

function runCliSafe(args: string[]): {
	stdout: string;
	stderr: string;
	exitCode: number;
} {
	try {
		const stdout = execFileSync("node", [CLI_PATH, ...args], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { stdout: stdout.trim(), stderr: "", exitCode: 0 };
	} catch (err: unknown) {
		const e = err as { stdout?: string; stderr?: string; status?: number };
		return {
			stdout: (e.stdout ?? "").toString().trim(),
			stderr: (e.stderr ?? "").toString().trim(),
			exitCode: e.status ?? 1,
		};
	}
}

describe("publish-report CLI wrapper (subprocess, built dist)", () => {
	it("missing --html → exit 1 with one JSON envelope on stdout", () => {
		const r = runCliSafe(["publish-report", "--project", "p"]);
		expect(r.exitCode).toBe(1);
		const envelope = JSON.parse(r.stdout);
		expect(envelope.delivered).toBe(false);
		expect(envelope.error).toContain("--html");
		expect(r.stderr).toContain("--html");
	});

	it("missing --project → exit 1 with one JSON envelope on stdout", () => {
		const r = runCliSafe(["publish-report", "--html", "/tmp/x.html"]);
		expect(r.exitCode).toBe(1);
		const envelope = JSON.parse(r.stdout);
		expect(envelope.error).toContain("--project");
	});

	it("unknown flag → exit 1 with one JSON envelope on stdout", () => {
		const r = runCliSafe(["publish-report", "--bogus", "x"]);
		expect(r.exitCode).toBe(1);
		const envelope = JSON.parse(r.stdout);
		expect(envelope.error).toContain("invalid arguments");
	});

	it("--channel plus --issue → exit 1 with one JSON envelope", () => {
		const r = runCliSafe([
			"publish-report",
			"--html",
			"/tmp/x.html",
			"--project",
			"p",
			"--channel",
			"chan",
			"--issue",
			"FLY-1463",
		]);
		expect(r.exitCode).toBe(1);
		const envelope = JSON.parse(r.stdout);
		expect(envelope.error).toContain("mutually exclusive");
	});

	it("stdout is EXACTLY one JSON object (no extra lines)", () => {
		const r = runCliSafe(["publish-report", "--project", "p"]);
		expect(r.stdout.split("\n")).toHaveLength(1);
		expect(() => JSON.parse(r.stdout)).not.toThrow();
	});
});
