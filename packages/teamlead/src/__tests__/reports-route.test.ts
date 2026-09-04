/**
 * FLY-203: /api/reports router tests — real ReportRegistry on tmp fs,
 * mocked private Blob + Discord post seams, real HTTP via express app.
 */

import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportRegistry } from "../bridge/report-registry.js";
import {
	buildReportMessage,
	createReportsRouter,
	MAX_OUTSTANDING_REPORT_PUBLISHES,
	type ReportsRouterOptions,
	readPreviewFile,
} from "../bridge/reports-route.js";
import type { ProjectEntry } from "../ProjectConfig.js";

const HTML =
	"<!doctype html><html><head><title>t</title></head><body>r</body></html>";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

const projects: ProjectEntry[] = [
	{
		projectName: "withGeneral",
		projectRoot: "/tmp/x",
		leads: [],
		generalChannel: "chan-general",
	} as unknown as ProjectEntry,
	{
		projectName: "noGeneral",
		projectRoot: "/tmp/y",
		leads: [],
	} as unknown as ProjectEntry,
];

describe("reports-route", () => {
	let dir: string;
	let registry: ReportRegistry;
	let server: Server | undefined;
	let baseUrl: string;
	let blobPutMock: ReturnType<typeof vi.fn>;
	let blobDeleteMock: ReturnType<typeof vi.fn>;
	let deployMock: ReturnType<typeof vi.fn>;
	let postWithFileMock: ReturnType<typeof vi.fn>;
	let postTextMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly203-route-"));
		registry = new ReportRegistry(dir, { warn: () => {} });
		writeFileSync(
			join(dir, "registry.json"),
			JSON.stringify({
				vercelProjectName: "fw-reports-a1b2c3",
				reports: [],
			}),
			"utf8",
		);
		registry.markHostingMigrated({
			provider: "vercel-blob",
			migratedAt: "2026-09-03T16:00:00.000Z",
			gatewayDeploymentId: "dpl_gateway",
		});
		blobPutMock = vi.fn().mockImplementation(async (token: string) => ({
			pathname: `r/${token}/index.html`,
			url: `https://store.private.blob.vercel-storage.com/r/${token}/index.html`,
		}));
		blobDeleteMock = vi.fn().mockResolvedValue(undefined);
		deployMock = vi.fn().mockResolvedValue({ deploymentId: "dpl_local" });
		postWithFileMock = vi
			.fn()
			.mockResolvedValue({ ok: true, messageId: "msg_file" });
		postTextMock = vi
			.fn()
			.mockResolvedValue({ ok: true, messageIds: ["msg_text"] });
	});

	afterEach(async () => {
		if (server) {
			await new Promise((r) => server?.close(r));
			server = undefined;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	async function startApp(
		overrides: Partial<ReportsRouterOptions> = {},
		credentialTier: "master" | "ingest" | null = "master",
	): Promise<void> {
		const app = express();
		app.use(express.json({ limit: "1mb" }));
		if (credentialTier) {
			app.use("/api/reports", (_req, res, next) => {
				res.locals.reportCredentialTier = credentialTier;
				next();
			});
		}
		app.use(
			"/api/reports",
			createReportsRouter({
				blobStore: {
					putReport: blobPutMock,
					deleteReports: blobDeleteMock,
				},
				vercelToken: "vt",
				discordBotToken: "bt",
				projects,
				registry,
				resolveIssueThread: () => undefined,
				deployFiles: deployMock as never,
				postWithFile: postWithFileMock as never,
				postText: postTextMock as never,
				...overrides,
			}),
		);
		await new Promise<void>((resolve) => {
			const s = app.listen(0, "127.0.0.1", () => resolve());
			server = s;
		});
		const addr = server?.address();
		baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
	}

	async function post(
		path: string,
		body: Record<string, unknown>,
	): Promise<{ status: number; json: Record<string, unknown> }> {
		const res = await fetch(`${baseUrl}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return {
			status: res.status,
			json: (await res.json()) as Record<string, unknown>,
		};
	}

	// ── publish ─────────────────────────────────────────────────────────

	it("FLY-2283: publish fails closed without private Blob storage", async () => {
		await startApp({ blobStore: undefined });
		const r = await post("/api/reports/publish", {
			projectName: "x",
			html: HTML,
		});

		expect(r.status).toBe(501);
		expect(String(r.json.error)).toContain("BLOB_READ_WRITE_TOKEN");
		expect(blobPutMock).not.toHaveBeenCalled();
	});

	it("FLY-2283: publish refuses to strand old links before the gateway migration is committed", async () => {
		rmSync(dir, { recursive: true, force: true });
		registry = new ReportRegistry(dir, { warn: () => {} });
		await startApp();

		const r = await post("/api/reports/publish", {
			projectName: "flywheel",
			html: HTML,
		});

		expect(r.status).toBe(503);
		expect(String(r.json.error)).toContain("hosting migration");
		expect(blobPutMock).not.toHaveBeenCalled();
	});

	it("FLY-1715: publish fails closed without a server-owned credential tier", async () => {
		await startApp({}, null);
		const r = await post("/api/reports/publish", {
			projectName: "withGeneral",
			html: HTML,
			reportCredentialTier: "master",
		});
		expect(r.status).toBe(401);
		expect(blobPutMock).not.toHaveBeenCalled();
	});

	it("FLY-1715: ingest publish accepts configured projects and rejects unknown projects", async () => {
		await startApp({}, "ingest");
		const denied = await post("/api/reports/publish", {
			projectName: "unknown",
			html: HTML,
		});
		expect(denied.status).toBe(403);
		expect(blobPutMock).not.toHaveBeenCalled();
		const allowed = await post("/api/reports/publish", {
			projectName: "withGeneral",
			html: HTML,
		});
		expect(allowed.status).toBe(200);
	});

	it("FLY-1715: outstanding publish cap returns 429 and releases capacity after drain", async () => {
		let releaseFirst: (() => void) | undefined;
		const firstUpload = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		blobPutMock.mockImplementation(async (token: string) => {
			await firstUpload;
			return {
				pathname: `r/${token}/index.html`,
				url: `https://store.private.blob.vercel-storage.com/r/${token}/index.html`,
			};
		});
		await startApp();
		const queued = Array.from(
			{ length: MAX_OUTSTANDING_REPORT_PUBLISHES + 1 },
			(_, index) =>
				post("/api/reports/publish", {
					projectName: "withGeneral",
					html: HTML,
					title: `queued-${index}`,
				}),
		);
		const overflow = await queued.at(-1);
		expect(overflow?.status).toBe(429);
		releaseFirst?.();
		const accepted = await Promise.all(queued.slice(0, -1));
		expect(accepted.every((result) => result.status === 200)).toBe(true);
		const recovered = await post("/api/reports/publish", {
			projectName: "withGeneral",
			html: HTML,
		});
		expect(recovered.status).toBe(200);
	});

	it("publish: validation matrix → 400", async () => {
		await startApp();
		expect((await post("/api/reports/publish", { html: HTML })).status).toBe(
			400,
		);
		expect(
			(await post("/api/reports/publish", { projectName: "p" })).status,
		).toBe(400);
		expect(
			(
				await post("/api/reports/publish", {
					projectName: "p",
					html: `<html><head></head><body>${"x".repeat(513 * 1024)}</body></html>`,
				})
			).status,
		).toBe(400);
		expect(
			(
				await post("/api/reports/publish", {
					projectName: "p",
					html: HTML,
					title: "t".repeat(201),
				})
			).status,
		).toBe(400);
		// no <head> → 400 (ReportHtmlInvalidError)
		const noHead = await post("/api/reports/publish", {
			projectName: "p",
			html: "<p>fragment</p>",
		});
		expect(noHead.status).toBe(400);
		expect(String(noHead.json.error)).toContain("<head>");
		expect(blobPutMock).not.toHaveBeenCalled();
	});

	it("publish: inline event handlers fail loud before Blob upload", async () => {
		await startApp();
		const result = await post("/api/reports/publish", {
			projectName: "withGeneral",
			html: '<html><head></head><body><button onclick="go()">Go</button></body></html>',
		});

		expect(result.status).toBe(400);
		expect(String(result.json.error)).toMatch(
			/inline event handler.*addEventListener/i,
		);
		expect(blobPutMock).not.toHaveBeenCalled();
	});

	it("FLY-2283: publish rejects gateway-unservable HTML without Blob or registry writes", async () => {
		const registryBefore = readFileSync(join(dir, "registry.json"), "utf8");
		await startApp();
		const result = await post("/api/reports/publish", {
			projectName: "flywheel",
			html: '<html><head><meta http-equiv="Content-Security-Policy"></head><body>report</body></html>',
		});

		expect(result.status).toBe(400);
		expect(String(result.json.error)).toContain(
			"non-empty Content-Security-Policy",
		);
		expect(blobPutMock).not.toHaveBeenCalled();
		expect(readFileSync(join(dir, "registry.json"), "utf8")).toBe(
			registryBefore,
		);
		expect(registry.list()).toEqual([]);
		expect(existsSync(join(dir, "files"))).toBe(false);
	});

	it("publish: happy path uploads hardened HTML and commits", async () => {
		await startApp();
		const r = await post("/api/reports/publish", {
			projectName: "flywheel",
			html: HTML,
			title: "Ship Review",
		});
		expect(r.status).toBe(200);
		const url = String(r.json.url);
		expect(url).toMatch(
			/^https:\/\/fw-reports-[0-9a-f]{6}\.vercel\.app\/r\/[0-9a-f]{32}\/$/,
		);
		expect(r.json.reportId).toMatch(/^[0-9a-f]{32}$/);
		const [token, uploadedHtml] = blobPutMock.mock.calls[0] as [string, string];
		expect(token).toBe(r.json.reportId);
		expect(uploadedHtml).toContain('name="robots" content="noindex"');
		expect(uploadedHtml).toContain("Content-Security-Policy");
		// committed
		expect(registry.list()).toHaveLength(1);
		expect(registry.vercelProjectName()).toMatch(/^fw-reports-[0-9a-f]{6}$/);
		expect(deployMock).not.toHaveBeenCalled();
	});

	it("publish: keeps the loopback report host complete without touching private Blob", async () => {
		await startApp({
			hostOverride: {
				apiBaseUrl: "http://127.0.0.1:4321",
				publicBaseUrl: "http://127.0.0.1:4321",
			},
		});
		const result = await post("/api/reports/publish", {
			projectName: "flywheel",
			html: HTML,
		});
		const next = await post("/api/reports/publish", {
			projectName: "flywheel",
			html: HTML,
		});

		expect(result.status).toBe(200);
		expect(next.status).toBe(200);
		expect(String(result.json.url)).toMatch(
			/^http:\/\/127\.0\.0\.1:4321\/fw-reports-[0-9a-f]{6}\/r\/[0-9a-f]{32}\/$/,
		);
		expect(deployMock.mock.calls[0]?.[4]).toBe("http://127.0.0.1:4321");
		const secondFiles = deployMock.mock.calls[1]?.[2] as Array<{
			file: string;
		}>;
		expect(secondFiles.map((file) => file.file)).toEqual([
			"robots.txt",
			`r/${String(result.json.reportId)}/index.html`,
			`r/${String(next.json.reportId)}/index.html`,
		]);
		expect(blobPutMock).not.toHaveBeenCalled();
	});

	it("FLY-2283: each publish uploads one private blob and the publish path has no deployment call", async () => {
		await startApp();

		const published = await Promise.all(
			["menu", "cart", "comparison"].map((title) =>
				post("/api/reports/publish", {
					projectName: "flywheel",
					html: HTML,
					title,
				}),
			),
		);

		expect(published.every((result) => result.status === 200)).toBe(true);
		expect(blobPutMock).toHaveBeenCalledTimes(3);
		expect(registry.list()).toHaveLength(3);
		expect(deployMock).not.toHaveBeenCalled();
	});

	it("publish: staging failure does not log Blob credentials", async () => {
		const blobCredential = "blob-secret";
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		vi.spyOn(registry, "stagePublish").mockImplementationOnce(() => {
			throw new Error(`staging failed with credential ${blobCredential}`);
		});
		await startApp();

		const result = await post("/api/reports/publish", {
			projectName: "p",
			html: HTML,
		});

		expect(result.status).toBe(500);
		expect(consoleError.mock.calls.flat().join(" ")).not.toContain(
			blobCredential,
		);
		consoleError.mockRestore();
	});

	it("publish: Blob upload failure → 502 and leaves the registry unchanged", async () => {
		const blobCredential = "blob-secret";
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		blobPutMock.mockRejectedValueOnce(
			new Error(`blob down with credential ${blobCredential}`),
		);
		await startApp();
		const r = await post("/api/reports/publish", {
			projectName: "p",
			html: HTML,
		});
		expect(r.status).toBe(502);
		expect(existsSync(join(dir, "registry.json"))).toBe(true);
		expect(registry.vercelProjectName()).toBe("fw-reports-a1b2c3");
		expect(registry.hosting()?.gatewayDeploymentId).toBe("dpl_gateway");
		expect(registry.list()).toEqual([]);
		expect(consoleError.mock.calls.flat().join(" ")).not.toContain(
			blobCredential,
		);
		consoleError.mockRestore();
	});

	it("publish: commit failure after successful Blob upload → 502, registry stays old", async () => {
		await startApp();
		// sabotage atomic write: registry.json.tmp as a directory
		mkdirSync(join(dir, "registry.json.tmp"), { recursive: true });
		const r = await post("/api/reports/publish", {
			projectName: "p",
			html: HTML,
		});
		expect(r.status).toBe(502);
		expect(String(r.json.error)).toContain("commit");
		expect(registry.list()).toEqual([]);
	});

	it("publish: commit failure does not log Blob credentials", async () => {
		const blobCredential = "blob-secret";
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		blobDeleteMock.mockRejectedValueOnce(
			new Error(`cleanup failed with credential ${blobCredential}`),
		);
		const stagePublish = registry.stagePublish.bind(registry);
		vi.spyOn(registry, "stagePublish").mockImplementationOnce(
			(projectName, html, title) => ({
				...stagePublish(projectName, html, title),
				commit: () => {
					throw new Error(`commit failed with credential ${blobCredential}`);
				},
			}),
		);
		await startApp();

		const result = await post("/api/reports/publish", {
			projectName: "p",
			html: HTML,
		});

		expect(result.status).toBe(502);
		expect(
			[...consoleError.mock.calls, ...consoleWarn.mock.calls].flat().join(" "),
		).not.toContain(blobCredential);
		consoleError.mockRestore();
		consoleWarn.mockRestore();
	});

	it("publish: concurrent publishes are serialized by the mutex", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		blobPutMock.mockImplementation(async (token: string) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((r) => setTimeout(r, 30));
			inFlight -= 1;
			return {
				pathname: `r/${token}/index.html`,
				url: `https://store.private.blob.vercel-storage.com/r/${token}/index.html`,
			};
		});
		await startApp();
		const [a, b] = await Promise.all([
			post("/api/reports/publish", { projectName: "p", html: HTML }),
			post("/api/reports/publish", { projectName: "p", html: HTML }),
		]);
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
		expect(maxInFlight).toBe(1);
		expect(registry.list()).toHaveLength(2);
		expect(blobPutMock).toHaveBeenCalledTimes(2);
		expect(blobPutMock.mock.calls[0]?.[0]).not.toBe(
			blobPutMock.mock.calls[1]?.[0],
		);
	});

	it("FLY-2283: a successful publish deletes objects that reached 14 days, never younger objects", async () => {
		let now = Date.parse("2026-06-04T00:00:00.000Z");
		registry = new ReportRegistry(dir, { now: () => now });
		registry.markHostingMigrated({
			provider: "vercel-blob",
			migratedAt: new Date(now).toISOString(),
			gatewayDeploymentId: "dpl_gateway",
		});
		await startApp();
		const old = await post("/api/reports/publish", {
			projectName: "p",
			html: HTML,
		});
		now += 14 * 24 * 60 * 60 * 1000;

		const next = await post("/api/reports/publish", {
			projectName: "p",
			html: HTML,
		});

		expect(old.status).toBe(200);
		expect(next.status).toBe(200);
		expect(blobDeleteMock).toHaveBeenCalledOnce();
		expect(blobDeleteMock).toHaveBeenCalledWith([old.json.reportId]);
	});

	it("publish: removes malformed registry entries from accounting without deleting their Blobs", async () => {
		const now = Date.parse("2026-06-04T00:00:00.000Z");
		registry = new ReportRegistry(dir, { now: () => now });
		registry.markHostingMigrated({
			provider: "vercel-blob",
			migratedAt: new Date(now).toISOString(),
			gatewayDeploymentId: "dpl_gateway",
		});
		await startApp();
		const old = await post("/api/reports/publish", {
			projectName: "p",
			html: HTML,
		});
		const registryPath = join(dir, "registry.json");
		const data = JSON.parse(readFileSync(registryPath, "utf8")) as {
			reports: Array<{ createdAt: string }>;
		};
		data.reports[0]!.createdAt = "not-a-date";
		writeFileSync(registryPath, JSON.stringify(data), "utf8");

		const next = await post("/api/reports/publish", {
			projectName: "p",
			html: HTML,
		});

		expect(old.status).toBe(200);
		expect(next.status).toBe(200);
		expect(registry.list().map((entry) => entry.token)).toEqual([
			next.json.reportId,
		]);
		expect(blobDeleteMock).not.toHaveBeenCalled();
	});

	it("publish: deferred expired-object cleanup does not log Blob credentials", async () => {
		const blobCredential = "blob-secret";
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let now = Date.parse("2026-06-04T00:00:00.000Z");
		registry = new ReportRegistry(dir, { now: () => now });
		registry.markHostingMigrated({
			provider: "vercel-blob",
			migratedAt: new Date(now).toISOString(),
			gatewayDeploymentId: "dpl_gateway",
		});
		await startApp();
		expect(
			(
				await post("/api/reports/publish", {
					projectName: "p",
					html: HTML,
				})
			).status,
		).toBe(200);
		now += 14 * 24 * 60 * 60 * 1000;
		blobDeleteMock.mockRejectedValueOnce(
			new Error(`cleanup failed with credential ${blobCredential}`),
		);

		const result = await post("/api/reports/publish", {
			projectName: "p",
			html: HTML,
		});

		expect(result.status).toBe(200);
		expect(consoleWarn.mock.calls.flat().join(" ")).not.toContain(
			blobCredential,
		);
		consoleWarn.mockRestore();
	});

	// ── deliver ─────────────────────────────────────────────────────────

	it("deliver: 501 without bot token", async () => {
		await startApp({ discordBotToken: undefined });
		const r = await post("/api/reports/deliver", {
			url: "https://x",
			projectName: "withGeneral",
		});
		expect(r.status).toBe(501);
	});

	it("deliver: resolves the sender token at request time", async () => {
		let token = "infra-token-1";
		const resolveDiscordBotToken = vi.fn(() => token);
		await startApp({
			discordBotToken: undefined,
			resolveDiscordBotToken,
		});

		expect(
			(
				await post("/api/reports/deliver", {
					url: "https://x/one",
					projectName: "withGeneral",
				})
			).status,
		).toBe(200);
		token = "infra-token-2";
		expect(
			(
				await post("/api/reports/deliver", {
					url: "https://x/two",
					projectName: "withGeneral",
				})
			).status,
		).toBe(200);

		expect(resolveDiscordBotToken).toHaveBeenCalledTimes(2);
		expect(postTextMock.mock.calls.map((call) => call[2])).toEqual([
			"infra-token-1",
			"infra-token-2",
		]);
	});

	it("deliver: missing url/projectName → 400", async () => {
		await startApp();
		expect(
			(await post("/api/reports/deliver", { projectName: "x" })).status,
		).toBe(400);
		expect(
			(await post("/api/reports/deliver", { url: "https://x" })).status,
		).toBe(400);
	});

	it("deliver: explicit channelId wins; generalChannel fallback; neither → 400", async () => {
		await startApp();
		await post("/api/reports/deliver", {
			url: "https://x",
			projectName: "withGeneral",
			channelId: "chan-explicit",
		});
		expect(postTextMock.mock.calls[0]?.[0]).toBe("chan-explicit");

		await post("/api/reports/deliver", {
			url: "https://x",
			projectName: "withGeneral",
		});
		expect(postTextMock.mock.calls[1]?.[0]).toBe("chan-general");

		const r = await post("/api/reports/deliver", {
			url: "https://x",
			projectName: "noGeneral",
		});
		expect(r.status).toBe(400);
		expect(String(r.json.error)).toContain("channel");
	});

	it("deliver: issueIdentifier resolves the issue thread without generalChannel fallback", async () => {
		const resolveIssueThread = vi.fn().mockResolvedValue("thread-fly-1463");
		await startApp({ resolveIssueThread } as never);
		const r = await post("/api/reports/deliver", {
			url: "https://x",
			projectName: "withGeneral",
			issueIdentifier: "FLY-1463",
		});
		expect(r.status).toBe(200);
		expect(resolveIssueThread).toHaveBeenCalledWith("FLY-1463", "withGeneral");
		expect(postTextMock.mock.calls[0]?.[0]).toBe("thread-fly-1463");
	});

	it("deliver: unresolved issueIdentifier → 404 and never posts to generalChannel", async () => {
		const resolveIssueThread = vi.fn().mockResolvedValue(undefined);
		await startApp({ resolveIssueThread } as never);
		const r = await post("/api/reports/deliver", {
			url: "https://x",
			projectName: "withGeneral",
			issueIdentifier: "FLY-404",
		});
		expect(r.status).toBe(404);
		expect(r.json.error).toBe("issue_thread_not_found");
		expect(postTextMock).not.toHaveBeenCalled();
	});

	it("deliver: channelId plus issueIdentifier → 400 before resolving or posting", async () => {
		const resolveIssueThread = vi.fn().mockResolvedValue("thread-fly-1463");
		await startApp({ resolveIssueThread } as never);
		const r = await post("/api/reports/deliver", {
			url: "https://x",
			projectName: "withGeneral",
			channelId: "chan-explicit",
			issueIdentifier: "FLY-1463",
		});
		expect(r.status).toBe(400);
		expect(String(r.json.error)).toContain("mutually exclusive");
		expect(resolveIssueThread).not.toHaveBeenCalled();
		expect(postTextMock).not.toHaveBeenCalled();
	});

	it("deliver: malformed issueIdentifier → 400 before resolving or posting", async () => {
		const resolveIssueThread = vi.fn().mockReturnValue("thread");
		await startApp({ resolveIssueThread });
		const r = await post("/api/reports/deliver", {
			url: "https://x",
			projectName: "withGeneral",
			issueIdentifier: "not-an-issue",
		});
		expect(r.status).toBe(400);
		expect(String(r.json.error)).toContain("issueIdentifier");
		expect(resolveIssueThread).not.toHaveBeenCalled();
		expect(postTextMock).not.toHaveBeenCalled();
	});

	it("deliver: link-only message uses bare URL (Discord preview allowed)", async () => {
		await startApp();
		const r = await post("/api/reports/deliver", {
			url: "https://fw.vercel.app/r/t/",
			projectName: "withGeneral",
			title: "T",
		});
		expect(r.status).toBe(200);
		expect(r.json.messageId).toBe("msg_text");
		const message = postTextMock.mock.calls[0]?.[1] as string;
		expect(message).toContain("📊 **T** · withGeneral");
		expect(message).toContain("https://fw.vercel.app/r/t/");
		expect(message).not.toContain("<https://");
	});

	it("deliver: with screenshot posts ONE file message with <url> and deletes preview", async () => {
		await startApp();
		const previews = registry.previewsDir();
		mkdirSync(previews, { recursive: true });
		const shot = join(previews, "p.png");
		writeFileSync(shot, PNG);

		const r = await post("/api/reports/deliver", {
			url: "https://fw.vercel.app/r/t/",
			projectName: "withGeneral",
			title: "T",
			screenshotPath: shot,
		});
		expect(r.status).toBe(200);
		expect(r.json.messageId).toBe("msg_file");
		expect(postTextMock).not.toHaveBeenCalled();
		const message = postWithFileMock.mock.calls[0]?.[1] as string;
		expect(message).toContain("<https://fw.vercel.app/r/t/>");
		// fd-pinned content handed to the post helper as a buffer (R1#2)
		const fileArg = postWithFileMock.mock.calls[0]?.[2] as {
			data: Buffer;
			filename: string;
		};
		expect(fileArg.filename).toBe("p.png");
		expect(Buffer.from(fileArg.data).equals(PNG)).toBe(true);
		// preview deleted after successful send
		expect(existsSync(shot)).toBe(false);
	});

	it("deliver: file post failure → 502, preview kept", async () => {
		postWithFileMock.mockResolvedValueOnce({ ok: false, error: "Discord 403" });
		await startApp();
		const previews = registry.previewsDir();
		mkdirSync(previews, { recursive: true });
		const shot = join(previews, "p.png");
		writeFileSync(shot, PNG);

		const r = await post("/api/reports/deliver", {
			url: "https://x",
			projectName: "withGeneral",
			screenshotPath: shot,
		});
		expect(r.status).toBe(502);
		expect(existsSync(shot)).toBe(true);
	});

	it("deliver: screenshot outside previews root → 400", async () => {
		await startApp();
		mkdirSync(registry.previewsDir(), { recursive: true });
		const outside = join(dir, "outside.png");
		writeFileSync(outside, PNG);
		const r = await post("/api/reports/deliver", {
			url: "https://x",
			projectName: "withGeneral",
			screenshotPath: outside,
		});
		expect(r.status).toBe(400);
	});

	// ── FLY-929 B1: deliver receipt fields (kind + expectedDate) ────────────

	it("deliver: kind=token_report + expectedDate → receipt written after a 2xx text delivery", async () => {
		const writeReceipt = vi.fn();
		await startApp({ writeReceipt: writeReceipt as never });
		const r = await post("/api/reports/deliver", {
			url: "https://x",
			projectName: "withGeneral",
			kind: "token_report",
			expectedDate: "2026-07-06",
		});
		expect(r.status).toBe(200);
		expect(writeReceipt).toHaveBeenCalledTimes(1);
		expect(writeReceipt).toHaveBeenCalledWith({
			date: "2026-07-06",
			messageId: "msg_text",
		});
	});

	it("deliver: receipt also written on the screenshot path", async () => {
		const writeReceipt = vi.fn();
		await startApp({ writeReceipt: writeReceipt as never });
		mkdirSync(registry.previewsDir(), { recursive: true });
		const shot = join(registry.previewsDir(), "p.png");
		writeFileSync(shot, PNG);
		const r = await post("/api/reports/deliver", {
			url: "https://x",
			projectName: "withGeneral",
			screenshotPath: shot,
			kind: "token_report",
			expectedDate: "2026-07-06",
		});
		expect(r.status).toBe(200);
		expect(writeReceipt).toHaveBeenCalledWith({
			date: "2026-07-06",
			messageId: "msg_file",
		});
	});

	it("deliver: NO kind/expectedDate → no receipt call (byte-compat)", async () => {
		const writeReceipt = vi.fn();
		await startApp({ writeReceipt: writeReceipt as never });
		const r = await post("/api/reports/deliver", {
			url: "https://x",
			projectName: "withGeneral",
		});
		expect(r.status).toBe(200);
		expect(writeReceipt).not.toHaveBeenCalled();
	});

	it("deliver: non-token_report kind → no receipt call", async () => {
		const writeReceipt = vi.fn();
		await startApp({ writeReceipt: writeReceipt as never });
		const r = await post("/api/reports/deliver", {
			url: "https://x",
			projectName: "withGeneral",
			kind: "some_other_report",
			expectedDate: "2026-07-06",
		});
		expect(r.status).toBe(200);
		expect(writeReceipt).not.toHaveBeenCalled();
	});

	it("deliver: delivery failure → NO receipt (a failed send must not fake a receipt)", async () => {
		const writeReceipt = vi.fn();
		postTextMock.mockResolvedValue({ ok: false, error: "403" });
		await startApp({ writeReceipt: writeReceipt as never });
		const r = await post("/api/reports/deliver", {
			url: "https://x",
			projectName: "withGeneral",
			kind: "token_report",
			expectedDate: "2026-07-06",
		});
		expect(r.status).toBe(502);
		expect(writeReceipt).not.toHaveBeenCalled();
	});

	it("deliver: malformed expectedDate / kind → 400 (boundary validation)", async () => {
		await startApp();
		expect(
			(
				await post("/api/reports/deliver", {
					url: "https://x",
					projectName: "withGeneral",
					kind: "token_report",
					expectedDate: "07/06/2026",
				})
			).status,
		).toBe(400);
		expect(
			(
				await post("/api/reports/deliver", {
					url: "https://x",
					projectName: "withGeneral",
					kind: 42,
				})
			).status,
		).toBe(400);
	});
});

describe("readPreviewFile (attack matrix)", () => {
	let dir: string;
	let previews: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly203-preview-"));
		previews = join(dir, "previews");
		mkdirSync(previews, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function png(at: string): string {
		writeFileSync(at, PNG);
		return at;
	}

	it("accepts a real PNG inside previews and returns its content", () => {
		const p = png(join(previews, "ok.png"));
		const r = readPreviewFile(previews, p);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.filename).toBe("ok.png");
			expect(r.data.equals(PNG)).toBe(true);
			expect(r.realPath).toContain("previews");
		}
	});

	it("rejects a non-regular file (FIFO) without blocking", () => {
		const fifo = join(previews, "pipe.png");
		execSync(`mkfifo ${JSON.stringify(fifo)}`);
		const r = readPreviewFile(previews, fifo);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("regular file");
	});

	it("rejects relative path", () => {
		expect(readPreviewFile(previews, "previews/x.png").ok).toBe(false);
	});

	it("rejects traversal escaping the root", () => {
		const p = png(join(dir, "escape.png"));
		const r = readPreviewFile(previews, join(previews, "..", "escape.png"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("inside the previews directory");
		void p;
	});

	it("rejects previews-evil sibling directory (raw-prefix footgun)", () => {
		const evil = join(dir, "previews-evil");
		mkdirSync(evil);
		const p = png(join(evil, "x.png"));
		const r = readPreviewFile(previews, p);
		expect(r.ok).toBe(false);
	});

	it("rejects symlink at the leaf", () => {
		const target = png(join(dir, "target.png"));
		const link = join(previews, "link.png");
		symlinkSync(target, link);
		const r = readPreviewFile(previews, link);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("symlink");
	});

	it("rejects spoofed extension (non-PNG magic bytes)", () => {
		const p = join(previews, "fake.png");
		writeFileSync(p, "<html>not a png</html>");
		const r = readPreviewFile(previews, p);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("not a PNG");
	});

	it("rejects oversized file (>25MB, sparse)", () => {
		const p = png(join(previews, "big.png"));
		truncateSync(p, 26 * 1024 * 1024);
		const r = readPreviewFile(previews, p);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("exceeds");
	});

	it("rejects the previews root itself", () => {
		const r = readPreviewFile(previews, previews);
		expect(r.ok).toBe(false);
	});

	it("rejects missing file", () => {
		const r = readPreviewFile(previews, join(previews, "ghost.png"));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("does not exist");
	});
});

describe("buildReportMessage", () => {
	it("wraps url in <> only when screenshot attached", () => {
		expect(buildReportMessage("T", "p", "https://u", true)).toContain(
			"<https://u>",
		);
		expect(buildReportMessage("T", "p", "https://u", false)).not.toContain("<");
	});

	it("caps content at Discord limit", () => {
		const msg = buildReportMessage(
			"T".repeat(200),
			"p",
			`https://${"u".repeat(3000)}`,
			false,
		);
		expect(msg.length).toBeLessThanOrEqual(1900);
	});
});
