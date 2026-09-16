import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LeadArtifactStore } from "../artifacts.js";
import type { LeadOperationContext } from "../broker.js";
import { createReportPublishHandlers } from "../handlers/report-publish.js";

const authority = vi.hoisted(() => ({ valid: true }));
vi.mock("../runtime-context.js", () => ({
	createLeadCapabilityContext: () => ({
		assertActivationCurrent: () => {
			if (!authority.valid) throw new Error("revoked");
		},
	}),
}));
const roots: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	authority.valid = true;
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const env = {
	FLYWHEEL_PROJECT_NAME: "flywheel",
	FLYWHEEL_LEAD_ID: "eng",
	FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
	FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "CLAIM_CANARY",
	FLYWHEEL_API_TOKEN: "TOKEN_CANARY",
	FLYWHEEL_BRIDGE_URL: "http://127.0.0.1:3199",
};
function fixture(fetchImpl: typeof fetch, bridgeUrl = env.FLYWHEEL_BRIDGE_URL) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "report-publish-")));
	roots.push(root);
	const artifactRoot = join(root, "artifacts");
	mkdirSync(artifactRoot, { mode: 0o700 });
	const store = new LeadArtifactStore({
		projectRoot: root,
		artifactRoot,
		assertCurrent: () => {},
	});
	const context: LeadOperationContext = {
		projectName: "flywheel",
		leadId: "eng",
		activationId: "a1",
		requestId: randomUUID(),
		signal: new AbortController().signal,
		assertCurrent: async () => {},
	};
	const handlers = createReportPublishHandlers({
		env: { ...env, FLYWHEEL_BRIDGE_URL: bridgeUrl },
		activationId: "a1",
		store,
		secrets: ["OTHER_SECRET"],
		fetchImpl,
	});
	return {
		root,
		store,
		context,
		handlers,
		handler: handlers.get("report.publish")!,
	};
}
it("publishes only verified HTML bytes through the scoped Bridge route", async () => {
	const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
	const f = fixture(
		vi.fn(async (url, init) => {
			calls.push({ url, init });
			return Response.json({
				requestId: f.context.requestId,
				reportId: "b".repeat(32),
				url: `https://fw-reports-a1b2c3.vercel.app/r/${"b".repeat(32)}/`,
			});
		}) as typeof fetch,
	);
	const artifact = await f.store.put(
		Buffer.from("<html>Report</html>"),
		"text/html",
	);
	const input = {
		artifactHandle: artifact.handle,
		title: "Report",
		issueId: "FLY-1",
	};
	await f.handler.authorize(input, f.context);
	const result = await f.handler.execute(input, f.context);
	expect(result.status).toBe("succeeded");
	expect(result.providerRef).toBe("b".repeat(32));
	expect(calls[0]!.url).toBe(
		"http://127.0.0.1:3199/api/lead-capabilities/reports/publish",
	);
	expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({
		projectName: "flywheel",
		html: "<html>Report</html>",
		capability: {
			requestId: f.context.requestId,
			operationId: "report.publish",
			carrierClaim: "CLAIM_CANARY",
			issueId: "FLY-1",
		},
	});
	expect(JSON.stringify(result)).not.toContain("CANARY");
	expect(JSON.stringify(result)).not.toContain(f.root);
	await expect(
		f.handler.authorize({ ...input, url: "https://evil.test" }, f.context),
	).rejects.toThrow();
	expect(calls).toHaveLength(1);
});
it("refuses wrong MIME, invalid UTF8, secret content and oversized artifacts before HTTP", async () => {
	const fetchImpl = vi.fn() as unknown as typeof fetch;
	const f = fixture(fetchImpl);
	for (const [bytes, mime] of [
		[Buffer.from("plain"), "text/plain"],
		[Buffer.from([0xff]), "text/html"],
		[Buffer.from("<html>OTHER_SECRET</html>"), "text/html"],
		[Buffer.alloc(512 * 1024 + 1, 97), "text/html"],
	] as const) {
		const artifact = await f.store.put(bytes, mime);
		await expect(
			f.handler.execute(
				{ artifactHandle: artifact.handle, title: "Report", issueId: "FLY-1" },
				f.context,
			),
		).rejects.toThrow();
	}
	expect(fetchImpl).not.toHaveBeenCalled();
});

it("keeps an uncertain upload unknown across the real broker journal restart", async () => {
	const { SqliteJournalStore } = await import(
		"../../lead-backends/codex/SqliteJournalStore.js"
	);
	const { LeadCapabilityBroker } = await import("../broker.js");
	const fetchImpl = vi.fn(async () => {
		throw new Error("response lost");
	}) as typeof fetch;
	const f = fixture(fetchImpl),
		artifact = await f.store.put(
			Buffer.from("<html>Report</html>"),
			"text/html",
		);
	const path = join(f.root, "journal.db");
	let journal = new SqliteJournalStore(path);
	const make = () =>
		new LeadCapabilityBroker({
			projectName: "flywheel",
			leadId: "eng",
			activationId: "a1",
			receipts: journal.operationReceipts,
			allowedOperationIds: () => new Set(["report.publish"]),
			assertCurrent: async () => {},
			handlers: f.handlers,
			secrets: [],
		});
	let broker = make();
	const request = {
		schemaVersion: 1,
		operationId: "report.publish",
		requestId: f.context.requestId,
		input: {
			artifactHandle: artifact.handle,
			title: "Report",
			issueId: "FLY-1",
		},
	};
	try {
		expect((await broker.execute(request)).status).toBe("unknown");
		await broker.close();
		journal.close();
		journal = new SqliteJournalStore(path);
		broker = make();
		expect((await broker.execute(request)).status).toBe("unknown");
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(
			vi.mocked(fetchImpl).mock.calls.map((call) => String(call[0])),
		).toEqual([
			"http://127.0.0.1:3199/api/lead-capabilities/reports/publish",
			"http://127.0.0.1:3199/api/lead-capabilities/reports/publish-receipt",
		]);
	} finally {
		await broker.close();
		journal.close();
	}
});
it("bounds an abort-ignoring upload without retrying", async () => {
	const fetchImpl = vi.fn(
		() => new Promise<Response>(() => {}),
	) as typeof fetch;
	const f = fixture(fetchImpl),
		artifact = await f.store.put(
			Buffer.from("<html>Report</html>"),
			"text/html",
		);
	vi.useFakeTimers();
	const result = f.handler.execute(
		{ artifactHandle: artifact.handle, title: "Report", issueId: "FLY-1" },
		f.context,
	);
	await vi.advanceTimersByTimeAsync(15001);
	expect((await result).status).toBe("unknown");
	expect(fetchImpl).toHaveBeenCalledOnce();
});
it("sanitizes invalid trusted endpoint failures", () => {
	const f = fixture(vi.fn() as unknown as typeof fetch);
	expect(() =>
		createReportPublishHandlers({
			env: { ...env, FLYWHEEL_BRIDGE_URL: "invalid TOKEN_CANARY" },
			activationId: "a1",
			store: f.store,
			secrets: [],
		}),
	).toThrow("report_publish_denied");
});

it("treats mismatched, oversized, secret or stale responses as unknown", async () => {
	let response: () => Response = () => Response.json({});
	const fetchImpl = vi.fn(async () => response()) as typeof fetch;
	const f = fixture(fetchImpl),
		artifact = await f.store.put(
			Buffer.from("<html>Report</html>"),
			"text/html",
		);
	const input = {
		artifactHandle: artifact.handle,
		title: "Report",
		issueId: "FLY-1",
	};
	const good = {
		requestId: f.context.requestId,
		reportId: "b".repeat(32),
		url: `https://fw-reports-a1b2c3.vercel.app/r/${"b".repeat(32)}/`,
	};
	for (const value of [
		{ ...good, requestId: randomUUID() },
		{ ...good, url: "https://example.test/r/foreign/" },
		{ ...good, secret: "OTHER_SECRET" },
	]) {
		response = () => Response.json(value);
		expect((await f.handler.execute(input, f.context)).status).toBe("unknown");
	}
	response = () => new Response("x".repeat(8193));
	expect((await f.handler.execute(input, f.context)).status).toBe("unknown");
	response = () => {
		authority.valid = false;
		return Response.json(good);
	};
	expect((await f.handler.execute(input, f.context)).status).toBe("unknown");
	const count = vi.mocked(fetchImpl).mock.calls.length;
	await expect(f.handler.execute(input, f.context)).rejects.toThrow();
	expect(fetchImpl).toHaveBeenCalledTimes(count);
});
it("publishes through a real HTTP report router and validates its scoped receipt", async () => {
	const { default: express } = await import("express");
	const { ReportRegistry } = await import("../../bridge/report-registry.js");
	const { createReportsRouter } = await import("../../bridge/reports-route.js");
	const root = realpathSync(mkdtempSync(join(tmpdir(), "report-http-")));
	roots.push(root);
	const registry = new ReportRegistry(root);
	await registry.ensureVercelProjectName();
	await registry.markHostingMigrated(
		{
			provider: "vercel-blob",
			migratedAt: "2026-09-03T16:00:00.000Z",
			gatewayDeploymentId: "test",
		},
		{ expectedHostingKey: registry.hostingBinding().hostingKey },
	);
	const putReport = vi.fn(async () => ({ pathname: "", url: "" }));
	const app = express();
	app.use(express.json());
	app.use((req, res, next) => {
		expect(req.headers.authorization).toBe("Bearer TOKEN_CANARY");
		res.locals.reportCredentialTier = "master";
		next();
	});
	app.use(
		"/api/lead-capabilities/reports",
		createReportsRouter({
			registry,
			projects: [],
			discordBotToken: undefined,
			resolveIssueThread: () => undefined,
			blobStore: { putReport, deleteReports: vi.fn() },
			authorizePublish: async (body) => {
				expect(body.capability).toMatchObject({
					operationId: "report.publish",
					leadId: "eng",
					issueId: "FLY-1",
					carrierClaim: "CLAIM_CANARY",
				});
				return () => {};
			},
		}),
	);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	try {
		const f = fixture(
				fetch,
				`http://127.0.0.1:${(server.address() as { port: number }).port}`,
			),
			artifact = await f.store.put(
				Buffer.from(
					"<!doctype html><html><head></head><body>Report</body></html>",
				),
				"text/html",
			);
		const result = await f.handler.execute(
			{ artifactHandle: artifact.handle, title: "Report", issueId: "FLY-1" },
			f.context,
		);
		expect(result.status).toBe("succeeded");
		expect(result.providerRef).toBe(registry.list()[0]!.token);
		expect(registry.list()[0]!.capabilityOwner).toEqual({
			leadId: "eng",
			identityDigest: "a".repeat(64),
			issueId: "FLY-1",
			requestId: f.context.requestId,
		});
		expect(putReport).toHaveBeenCalledOnce();
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});

it("reconciles a committed upload without re-reading the prior activation artifact or uploading again", async () => {
	const { SqliteJournalStore } = await import(
		"../../lead-backends/codex/SqliteJournalStore.js"
	);
	const { LeadCapabilityBroker } = await import("../broker.js");
	const urls: string[] = [];
	const fetchImpl = vi.fn(async (url) => {
		urls.push(String(url));
		if (String(url).endsWith("/publish"))
			throw new Error("lost upload response");
		return Response.json({
			requestId: f.context.requestId,
			reportId: "b".repeat(32),
			url: `https://fw-reports-a1b2c3.vercel.app/r/${"b".repeat(32)}/`,
		});
	}) as typeof fetch;
	const f = fixture(fetchImpl);
	const artifact = await f.store.put(
		Buffer.from("<html>Report</html>"),
		"text/html",
	);
	const path = join(f.root, "journal.db");
	let journal = new SqliteJournalStore(path);
	const make = () =>
		new LeadCapabilityBroker({
			projectName: "flywheel",
			leadId: "eng",
			activationId: "a1",
			receipts: journal.operationReceipts,
			allowedOperationIds: () => new Set(["report.publish"]),
			assertCurrent: async () => {},
			handlers: f.handlers,
			secrets: [],
		});
	let broker = make();
	const request = {
		schemaVersion: 1,
		operationId: "report.publish",
		requestId: f.context.requestId,
		input: {
			artifactHandle: artifact.handle,
			title: "Report",
			issueId: "FLY-1",
		},
	};
	try {
		expect((await broker.execute(request)).status).toBe("unknown");
		await broker.close();
		journal.close();
		vi.spyOn(f.store, "read").mockRejectedValue(
			new Error("prior artifact unavailable"),
		);
		journal = new SqliteJournalStore(path);
		broker = make();
		expect((await broker.execute(request)).status).toBe("succeeded");
		expect(urls).toEqual([
			"http://127.0.0.1:3199/api/lead-capabilities/reports/publish",
			"http://127.0.0.1:3199/api/lead-capabilities/reports/publish-receipt",
		]);
		expect(f.store.read).not.toHaveBeenCalled();
	} finally {
		await broker.close();
		journal.close();
	}
});
