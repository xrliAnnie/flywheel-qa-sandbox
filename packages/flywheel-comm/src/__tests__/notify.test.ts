/**
 * GEO-151 A5 — notify command tests.
 *
 * Covers AC6 (POST wire shape with dedup_key/attempt + CommDB audit row with
 * content_type='artifact' + attachments JSON) + ordering (POST primary; DB
 * fail-open) + identity resolution + parseAttempt + path allowlist +
 * symlink-escape reject.
 *
 * fetch is injected; CommDB writes to :memory: per test.
 */

import {
	mkdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_NOTIFY_PATH_ALLOWLIST,
	notify,
	parseAttempt,
	resolveNotifyIdentity,
} from "../commands/notify.js";
import { CommDB } from "../db.js";

function makeFetchOk(): {
	fetch: typeof fetch;
	calls: Array<{ url: string; body: Record<string, unknown> }>;
} {
	const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
	const fetchFn = vi.fn(
		async (url: string | URL | Request, init?: RequestInit) => {
			const body =
				typeof init?.body === "string"
					? (JSON.parse(init.body) as Record<string, unknown>)
					: {};
			calls.push({ url: String(url), body });
			return new Response("", { status: 200 });
		},
	) as unknown as typeof fetch;
	return { fetch: fetchFn, calls };
}

function makeFetchErr(status = 500): typeof fetch {
	return vi.fn(
		async () => new Response("server error", { status }),
	) as unknown as typeof fetch;
}

describe("parseAttempt (GEO-151 A5)", () => {
	it("accepts positive integers", () => {
		expect(parseAttempt(1)).toBe(1);
		expect(parseAttempt(42)).toBe(42);
	});

	it("accepts numeric strings", () => {
		expect(parseAttempt("1")).toBe(1);
		expect(parseAttempt("100")).toBe(100);
	});

	it("rejects zero / negative", () => {
		expect(parseAttempt(0)).toBeNull();
		expect(parseAttempt(-1)).toBeNull();
		expect(parseAttempt("0")).toBeNull();
	});

	it("rejects floats", () => {
		expect(parseAttempt(1.5)).toBeNull();
		expect(parseAttempt(Number.NaN)).toBeNull();
		expect(parseAttempt(Number.POSITIVE_INFINITY)).toBeNull();
	});

	it("rejects non-numeric strings", () => {
		expect(parseAttempt("1.5")).toBeNull();
		expect(parseAttempt("foo")).toBeNull();
		expect(parseAttempt("")).toBeNull();
	});

	it("rejects null / undefined / objects", () => {
		expect(parseAttempt(null)).toBeNull();
		expect(parseAttempt(undefined)).toBeNull();
		expect(parseAttempt({})).toBeNull();
		expect(parseAttempt([])).toBeNull();
	});
});

describe("resolveNotifyIdentity (GEO-151 A5)", () => {
	const baseArgs = {
		kind: "artifact" as const,
		dbPath: ":memory:",
	};

	beforeEach(() => {
		delete process.env.FLYWHEEL_EXEC_ID;
		delete process.env.FLYWHEEL_ISSUE_ID;
		delete process.env.FLYWHEEL_PROJECT_NAME;
	});

	it("CLI flags win over manifest and env", () => {
		process.env.FLYWHEEL_EXEC_ID = "env-exec";
		const manifest = {
			execId: "manifest-exec",
			issue_id: "manifest-issue",
			project_name: "manifest-proj",
			dedup_key: "manifest-dk",
			attempt: 1,
		};
		const result = resolveNotifyIdentity(
			{
				...baseArgs,
				execId: "cli-exec",
				issueId: "cli-issue",
				projectName: "cli-proj",
				dedupKey: "cli-dk",
				attempt: 5,
			},
			manifest,
		);
		expect(result.execId).toBe("cli-exec");
		expect(result.issueId).toBe("cli-issue");
		expect(result.projectName).toBe("cli-proj");
		expect(result.dedupKey).toBe("cli-dk");
		expect(result.attempt).toBe(5);
	});

	it("manifest fills in missing CLI flags", () => {
		const manifest = {
			execId: "manifest-exec",
			issue_id: "manifest-issue",
			project_name: "manifest-proj",
			dedup_key: "manifest-dk",
			attempt: 3,
		};
		const result = resolveNotifyIdentity(baseArgs, manifest);
		expect(result.execId).toBe("manifest-exec");
		expect(result.dedupKey).toBe("manifest-dk");
		expect(result.attempt).toBe(3);
	});

	it("env fills in when neither CLI nor manifest provide", () => {
		process.env.FLYWHEEL_EXEC_ID = "env-exec";
		process.env.FLYWHEEL_ISSUE_ID = "env-issue";
		process.env.FLYWHEEL_PROJECT_NAME = "env-proj";
		const result = resolveNotifyIdentity(
			{
				...baseArgs,
				kind: "status",
				dedupKey: "x", // status doesn't require dedup but provide anyway
				attempt: 1,
			},
			null,
		);
		expect(result.execId).toBe("env-exec");
		expect(result.issueId).toBe("env-issue");
		expect(result.projectName).toBe("env-proj");
	});

	it("fail-closed: missing execId throws", () => {
		expect(() =>
			resolveNotifyIdentity(
				{
					...baseArgs,
					issueId: "x",
					projectName: "y",
					dedupKey: "z",
					attempt: 1,
				},
				null,
			),
		).toThrow(/missing identity/);
	});

	it("kind=artifact + missing dedup_key throws", () => {
		expect(() =>
			resolveNotifyIdentity(
				{
					...baseArgs,
					execId: "e",
					issueId: "i",
					projectName: "p",
					attempt: 1,
				},
				null,
			),
		).toThrow(/requires --dedup-key/);
	});

	it("kind=artifact + invalid attempt throws", () => {
		expect(() =>
			resolveNotifyIdentity(
				{
					...baseArgs,
					execId: "e",
					issueId: "i",
					projectName: "p",
					dedupKey: "dk",
					attempt: "abc",
				},
				null,
			),
		).toThrow(/requires positive integer --attempt/);
	});

	it("kind=status does NOT require dedup_key + attempt", () => {
		const result = resolveNotifyIdentity(
			{
				...baseArgs,
				kind: "status",
				execId: "e",
				issueId: "i",
				projectName: "p",
			},
			null,
		);
		expect(result.dedupKey).toBeNull();
		expect(result.attempt).toBeNull();
	});
});

describe("notify command — AC6 + ordering (GEO-151 A5)", () => {
	let tmpDir: string;
	let allowedDir: string;
	let dbPath: string;
	let pngPath: string;
	let summaryPath: string;
	let manifestPath: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `notify-${Date.now()}-${Math.random()}`);
		mkdirSync(tmpDir, { recursive: true });
		// Real files under /tmp/flywheel-screens (matches default allowlist).
		allowedDir = join("/tmp", "flywheel-screens", `notify-${Date.now()}`);
		mkdirSync(allowedDir, { recursive: true });
		pngPath = join(allowedDir, "step-00.png");
		summaryPath = join(allowedDir, "SUMMARY.md");
		writeFileSync(pngPath, "PNG-FAKE");
		writeFileSync(summaryPath, "## summary");
		manifestPath = join(allowedDir, "manifest.json");
		writeFileSync(
			manifestPath,
			JSON.stringify({
				selected: [summaryPath, pngPath],
				dropped: [],
				totalTokens: 2000,
				captureKind: "ui",
				execId: "exec-1",
				issue_id: "GEO-151",
				project_name: "GeoForge3D",
				stage: "test",
				dedup_key: "exec-1|test|ui",
				attempt: 1,
			}),
		);
		dbPath = join(tmpDir, "comm.db");
		process.env.FLYWHEEL_BRIDGE_URL = "http://127.0.0.1:8088";
	});

	afterEach(() => {
		delete process.env.FLYWHEEL_BRIDGE_URL;
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {}
		try {
			rmSync(allowedDir, { recursive: true, force: true });
		} catch {}
	});

	it("AC6 wire shape: POST body has snake_case dedup_key + attempt + paths", async () => {
		const { fetch: fetchFn, calls } = makeFetchOk();
		const result = await notify({
			kind: "artifact",
			pathsFrom: manifestPath,
			dbPath,
			fetchFn,
		});
		expect(result.posted).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("http://127.0.0.1:8088/events");
		const body = calls[0]!.body;
		expect(body.event_type).toBe("artifact_emitted");
		expect(body.execution_id).toBe("exec-1");
		expect(body.issue_id).toBe("GEO-151");
		expect(body.project_name).toBe("GeoForge3D");
		const payload = body.payload as Record<string, unknown>;
		expect(payload.kind).toBe("artifact");
		expect(payload.dedup_key).toBe("exec-1|test|ui");
		expect(payload.attempt).toBe(1);
		// On macOS, realpath resolves /tmp/x → /private/tmp/x. Paths are
		// the post-realpath form, which is what catches symlink escapes.
		expect(payload.paths).toEqual([
			realpathSync(summaryPath),
			realpathSync(pngPath),
		]);
		// snake_case in wire — NOT camelCase
		expect(payload).not.toHaveProperty("dedupKey");
	});

	it("AC6 audit: CommDB row has type='progress', content_type='artifact', attachments JSON", async () => {
		const { fetch: fetchFn } = makeFetchOk();
		const result = await notify({
			kind: "artifact",
			pathsFrom: manifestPath,
			dbPath,
			fetchFn,
		});
		expect(result.auditWritten).toBe(true);
		const db = new CommDB(dbPath, false);
		try {
			const rows = db.getUnreadInstructions("exec-1");
			// insertArtifactProgress writes type='progress' not 'instruction',
			// so getUnreadInstructions won't surface it. Query directly.
			expect(rows).toHaveLength(0);
		} finally {
			db.close();
		}
		// Direct SQL probe
		const Better = (await import("better-sqlite3")).default;
		const raw = new Better(dbPath);
		try {
			const rows = raw
				.prepare(
					"SELECT from_agent, to_agent, type, content_type, content, attachments FROM messages WHERE to_agent = ? AND type = 'progress'",
				)
				.all("exec-1") as Array<{
				from_agent: string;
				to_agent: string;
				type: string;
				content_type: string;
				content: string;
				attachments: string;
			}>;
			expect(rows).toHaveLength(1);
			expect(rows[0]?.from_agent).toBe("runner");
			expect(rows[0]?.type).toBe("progress");
			expect(rows[0]?.content_type).toBe("artifact");
			expect(rows[0]?.content).toBe("artifact_emitted: 2 file(s)");
			const attachments = JSON.parse(rows[0]!.attachments) as string[];
			expect(attachments).toEqual([
				realpathSync(summaryPath),
				realpathSync(pngPath),
			]);
		} finally {
			raw.close();
		}
	});

	it("ordering: POST fails → exit 2 + audit still attempted", async () => {
		const result = await notify({
			kind: "artifact",
			pathsFrom: manifestPath,
			dbPath,
			fetchFn: makeFetchErr(500),
		});
		expect(result.exitCode).toBe(2);
		expect(result.posted).toBe(false);
		// Audit still attempted (fail-open on POST failure).
		expect(result.auditWritten).toBe(true);
	});

	it("ordering: POST ok + DB fail → exit 0 + audit=false + stderr warn", async () => {
		const { fetch: fetchFn } = makeFetchOk();
		const result = await notify({
			kind: "artifact",
			pathsFrom: manifestPath,
			dbPath: "/nonexistent/dir/db.db", // DB path will fail
			fetchFn,
		});
		expect(result.exitCode).toBe(0); // POST primary succeeded
		expect(result.posted).toBe(true);
		expect(result.auditWritten).toBe(false);
	});

	it("explicit --path mode works without manifest", async () => {
		const { fetch: fetchFn, calls } = makeFetchOk();
		const result = await notify({
			kind: "artifact",
			paths: [summaryPath],
			execId: "exec-2",
			issueId: "GEO-151",
			projectName: "GeoForge3D",
			dedupKey: "exec-2|test|ui",
			attempt: 1,
			dbPath,
			fetchFn,
		});
		expect(result.posted).toBe(true);
		const body = calls[0]!.body;
		const payload = body.payload as Record<string, unknown>;
		expect(payload.paths).toEqual([realpathSync(summaryPath)]);
	});

	it("fail-closed: empty manifest.selected throws", async () => {
		const emptyManifestPath = join(allowedDir, "empty-manifest.json");
		writeFileSync(
			emptyManifestPath,
			JSON.stringify({
				selected: [],
				execId: "exec-1",
				issue_id: "GEO-151",
				project_name: "GeoForge3D",
				dedup_key: "x",
				attempt: 1,
			}),
		);
		const { fetch: fetchFn } = makeFetchOk();
		await expect(
			notify({
				kind: "artifact",
				pathsFrom: emptyManifestPath,
				dbPath,
				fetchFn,
			}),
		).rejects.toThrow(/no paths to notify/);
	});

	it("fail-closed: missing bridgeUrl throws", async () => {
		delete process.env.FLYWHEEL_BRIDGE_URL;
		await expect(
			notify({
				kind: "artifact",
				pathsFrom: manifestPath,
				dbPath,
				fetchFn: makeFetchOk().fetch,
			}),
		).rejects.toThrow(/FLYWHEEL_BRIDGE_URL/);
	});
});

describe("notify path allowlist (GEO-151 A5)", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `nf-allow-${Date.now()}-${Math.random()}`);
		mkdirSync(tmpDir, { recursive: true });
		dbPath = join(tmpDir, "comm.db");
		process.env.FLYWHEEL_BRIDGE_URL = "http://127.0.0.1:8088";
	});

	afterEach(() => {
		delete process.env.FLYWHEEL_BRIDGE_URL;
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {}
	});

	it("path outside allowlist throws", async () => {
		// /tmp/some-random-dir/file.png isn't in the default allowlist.
		const baddir = join(tmpdir(), `notify-bad-${Date.now()}`);
		mkdirSync(baddir);
		const badpath = join(baddir, "file.png");
		writeFileSync(badpath, "x");
		try {
			await expect(
				notify({
					kind: "artifact",
					paths: [badpath],
					execId: "e",
					issueId: "i",
					projectName: "p",
					dedupKey: "dk",
					attempt: 1,
					dbPath,
					fetchFn: makeFetchOk().fetch,
				}),
			).rejects.toThrow(/not in allowlist/);
		} finally {
			rmSync(baddir, { recursive: true, force: true });
		}
	});

	it("symlink-escape rejected: link in allowed dir → outside dir", async () => {
		const allowed = join("/tmp", "flywheel-screens", `escape-${Date.now()}`);
		mkdirSync(allowed, { recursive: true });
		const outside = join(tmpdir(), `secret-${Date.now()}`);
		mkdirSync(outside);
		const realPng = join(outside, "secret.png");
		writeFileSync(realPng, "SECRET");
		const link = join(allowed, "step.png");
		symlinkSync(realPng, link);

		try {
			await expect(
				notify({
					kind: "artifact",
					paths: [link],
					execId: "e",
					issueId: "i",
					projectName: "p",
					dedupKey: "dk",
					attempt: 1,
					dbPath,
					fetchFn: makeFetchOk().fetch,
				}),
			).rejects.toThrow(/not in allowlist/);
		} finally {
			rmSync(allowed, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("custom allowlist accepts paths it explicitly allows", async () => {
		const customDir = join(tmpDir, "custom");
		mkdirSync(customDir);
		const ok = join(customDir, "x.png");
		writeFileSync(ok, "x");
		const { fetch: fetchFn } = makeFetchOk();
		// On macOS realpath strips /private prefix; allow both forms.
		const resolvedRoot = realpathSync(tmpDir);
		const result = await notify({
			kind: "artifact",
			paths: [ok],
			execId: "e",
			issueId: "i",
			projectName: "p",
			dedupKey: "dk",
			attempt: 1,
			dbPath,
			allowlist: [`^${resolvedRoot}`, `^${tmpDir}`],
			fetchFn,
		});
		expect(result.posted).toBe(true);
	});

	it("default allowlist constants include /tmp + /private/tmp + ~/.flywheel/screens", () => {
		expect(DEFAULT_NOTIFY_PATH_ALLOWLIST).toEqual([
			"^/Users/.+/\\.flywheel/screens/",
			"^/tmp/flywheel-screens/",
			"^/private/tmp/flywheel-screens/", // macOS realpath of /tmp
		]);
	});
});
