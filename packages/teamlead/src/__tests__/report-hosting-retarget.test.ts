import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { VercelBlobReportStore } from "../bridge/report-blob-store.js";
import { retargetReportHosting } from "../bridge/report-hosting-retarget.js";
import { ReportRegistry } from "../bridge/report-registry.js";
import { SecretRedactor } from "../bridge/vercel-hosting-api.js";

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
async function fixture() {
	const reportsDir = mkdtempSync(join(tmpdir(), "report-retarget-"));
	dirs.push(reportsDir);
	const now = () => Date.parse("2026-09-13T12:00:00Z");
	const registry = new ReportRegistry(reportsDir, { now });
	await registry.ensureVercelProjectName();
	await registry.markHostingMigrated(
		{
			provider: "vercel-blob",
			migratedAt: "2026-09-12T12:00:00Z",
			gatewayDeploymentId: "old",
			storeId: "old",
		},
		{ expectedHostingKey: registry.hostingBinding().hostingKey },
	);
	for (let i = 0; i < 3; i++)
		await registry
			.stagePublish(
				"p",
				`<html><head></head><body>report ${i}</body></html>`,
				undefined,
				registry.hostingBinding(),
			)
			.commit();
	const source = registry.hostingBinding();
	let connected = false;
	let created = false;
	const details = () => ({
		id: "abc",
		name: "fw-reports-abc123-blob",
		access: "private",
		size: 0,
		count: 0,
		status: "available",
		usageQuotaExceeded: false,
		projectsMetadata: connected ? [{ projectId: "prj_a" }] : [],
	});
	const api = {
		getProject: vi.fn(async () =>
			created ? { id: "prj_a", name: "fw-reports-abc123" } : null,
		),
		createProject: vi.fn(async () => {
			created = true;
			return { id: "prj_a", name: "fw-reports-abc123" };
		}),
		findProjectBlobEnv: vi.fn(async () =>
			connected
				? { envId: "env_a", type: "encrypted", storeId: "abc" }
				: undefined,
		),
		createPrivateBlobStore: vi.fn(async () => "abc"),
		getStore: vi.fn(async () => details()),
		connectStore: vi.fn(async () => {
			connected = true;
		}),
		decryptProjectEnv: vi.fn(async () => "vercel_blob_rw_abc_secret"),
	};
	const put = vi.fn(async (pathname: string) => ({
		pathname,
		url: `https://abc.private.blob.vercel-storage.com/${pathname}`,
	}));
	const blobStore = new VercelBlobReportStore(undefined, {
		put,
		del: vi.fn(),
		list: vi.fn(),
	});
	const deployGateway = vi.fn(async () => ({
		url: "https://fw-reports-abc123.vercel.app",
		deploymentId: "dpl_a",
	}));
	const request = vi.fn(
		async (url: string) =>
			new Response(null, {
				status: url.includes("0".repeat(32)) ? 404 : 200,
				headers: {
					"content-type": "text/html",
					"content-encoding": "gzip",
					"content-security-policy": "default-src 'none'",
				},
			}),
	);
	const options = {
		readEpicPublications: () => [],
		registry,
		reportsDir,
		projectName: "fw-reports-abc123",
		vercelToken: "account-secret",
		vercelTokenEnv: "ACCOUNT_NEXT",
		api,
		blobStore,
		redactor: new SecretRedactor(),
		now,
		deployGateway,
		request,
		verifyGatewayEnvironment: vi.fn(async () => {}),
		probeGateway: vi.fn(async () => {}),
		gatewayRuntimeSource: "export default function handler() {}",
		gatewayHtmlSource: "export {};",
		reportRetentionSource: "export {};",
		blobPackageVersion: "2.8.0",
		log: vi.fn(),
	};
	return { options, api, put, source, registry, reportsDir };
}
it("retargets the retained set, commits provenance and replays without upload/deploy/probe or marker changes", async () => {
	const { options, api, put, source, registry, reportsDir } = await fixture();
	const result = await retargetReportHosting(options);
	expect(result.uploaded).toBe(3);
	expect(result.passes).toBe(1);
	expect(result.verified).toHaveLength(3);
	expect(api.createPrivateBlobStore).toHaveBeenCalledWith({
		name: "fw-reports-abc123-blob",
	});
	expect(registry.hosting()).toMatchObject({
		storeId: "abc",
		gatewayFormat: "gzip-v1",
		retargetedFrom: {
			vercelProjectName: source.vercelProjectName,
			migratedAt: source.migratedAt,
		},
	});
	expect(
		readdirSync(reportsDir).filter((name) =>
			name.startsWith("registry.json.bak-"),
		),
	).toHaveLength(1);
	expect(readFileSync(result.secretsFile!, "utf8")).toBe(
		"BLOB_READ_WRITE_TOKEN=vercel_blob_rw_abc_secret\n",
	);
	const bytes = readFileSync(join(reportsDir, "registry.json"), "utf8");
	const again = await retargetReportHosting(options);
	expect(again.uploaded).toBe(0);
	expect(again.skipped).toBe(3);
	expect(put).toHaveBeenCalledTimes(3);
	expect(options.deployGateway).toHaveBeenCalledTimes(1);
	expect(options.probeGateway).toHaveBeenCalledTimes(1);
	expect(api.getStore).toHaveBeenCalledTimes(3);
	expect(readFileSync(join(reportsDir, "registry.json"), "utf8")).toBe(bytes);
	expect(
		JSON.stringify(result) + options.log.mock.calls.flat().join(" "),
	).not.toContain("account-secret");
	expect(JSON.stringify(result)).not.toContain("vercel_blob_rw_abc_secret");
});

it("does not retarget untitled legacy automatic history but keeps untitled on-demand history", async () => {
	const { options, registry, put } = await fixture();
	const legacyAuto = registry.stagePublish(
		"p",
		"<!doctype html><html><head><title>机器试判历史</title></head><body><p>automatic</p></body></html>",
		undefined,
		registry.hostingBinding(),
	);
	await legacyAuto.commit();
	const manualOnDemand = registry.stagePublish(
		"p",
		"<!doctype html><html><head><title>机器试判历史（按需生成）</title></head><body><p>manual</p></body></html>",
		undefined,
		registry.hostingBinding(),
	);
	await manualOnDemand.commit();

	const result = await retargetReportHosting(options);
	const uploadedPaths = put.mock.calls.map(([path]) => path);
	expect(result.uploaded).toBe(4);
	expect(
		uploadedPaths.some((path) => path.includes(legacyAuto.entry.token)),
	).toBe(false);
	expect(
		uploadedPaths.some((path) => path.includes(manualOnDemand.entry.token)),
	).toBe(true);
});

it("converges after a concurrent publish changes the retained manifest", async () => {
	const { options, registry, put } = await fixture();
	const commit = registry.commitRetarget.bind(registry);
	let added = false;
	vi.spyOn(registry, "commitRetarget").mockImplementation(async (input) => {
		if (!added) {
			added = true;
			await registry
				.stagePublish(
					"p",
					"<html><head></head><body>late</body></html>",
					undefined,
					registry.hostingBinding(),
				)
				.commit();
		}
		return commit(input);
	});
	const result = await retargetReportHosting(options);
	expect(result.passes).toBe(2);
	expect(put).toHaveBeenCalledTimes(4);
	expect(options.deployGateway).toHaveBeenCalledTimes(2);
	expect(options.probeGateway).toHaveBeenCalledTimes(2);
	expect(registry.list()).toHaveLength(4);
});

it("stops after three continuously stale snapshots without changing hosting", async () => {
	const { options, registry } = await fixture();
	const before = registry.hosting();
	const commit = registry.commitRetarget.bind(registry);
	vi.spyOn(registry, "commitRetarget").mockImplementation(async (input) => {
		await registry
			.stagePublish(
				"p",
				"<html><head></head><body>late</body></html>",
				undefined,
				registry.hostingBinding(),
			)
			.commit();
		return commit(input);
	});
	await expect(retargetReportHosting(options)).rejects.toMatchObject({
		exitCode: 1,
		message: "registry continues changing; retry later",
	});
	expect(options.deployGateway).toHaveBeenCalledTimes(3);
	expect(registry.hosting()).toEqual(before);
});

it("reuploads changed content and revalidates it without redeploying an unchanged manifest", async () => {
	const { options, registry, put, reportsDir } = await fixture();
	await retargetReportHosting(options);
	const entry = registry.list()[0]!;
	const { writeFileSync } = await import("node:fs");
	writeFileSync(
		join(reportsDir, "files", `${entry.token}.html`),
		"<html><head></head><body>different bytes</body></html>",
	);
	const result = await retargetReportHosting(options);
	expect(result.reuploaded).toBe(1);
	expect(put).toHaveBeenCalledTimes(4);
	expect(options.deployGateway).toHaveBeenCalledTimes(1);
	expect(options.probeGateway).toHaveBeenCalledTimes(2);
	expect(
		options.request.mock.calls.some((call) => call[0].includes(entry.token)),
	).toBe(true);
});

it("persists uncertain creation intent, refuses another POST and supports explicit recovery", async () => {
	const { options, api, reportsDir } = await fixture();
	api.createPrivateBlobStore.mockRejectedValueOnce(
		new Error("connection lost after creation"),
	);
	await expect(retargetReportHosting(options)).rejects.toMatchObject({
		exitCode: 1,
	});
	const path = join(reportsDir, "retarget.fw-reports-abc123.json");
	expect(
		JSON.parse(readFileSync(path, "utf8")).storeCreateIntent,
	).toBeDefined();
	await expect(retargetReportHosting(options)).rejects.toMatchObject({
		exitCode: 2,
	});
	expect(api.createPrivateBlobStore).toHaveBeenCalledTimes(1);
	const recovered = await retargetReportHosting({
		...options,
		storeId: "store_abc",
	});
	expect(recovered.storeId).toBe("abc");
	expect(api.createPrivateBlobStore).toHaveBeenCalledTimes(1);
	expect(
		JSON.parse(readFileSync(path, "utf8")).storeCreateIntent,
	).toBeUndefined();
});

it("never commits a marker after a failed probe or a non-404 fake token", async () => {
	for (const kind of ["probe", "fake"]) {
		const { options, registry } = await fixture();
		const before = registry.hosting();
		if (kind === "probe")
			options.probeGateway.mockRejectedValueOnce(new Error("probe failed"));
		else
			options.request.mockImplementation(
				async () =>
					new Response(null, {
						status: 200,
						headers: {
							"content-type": "text/html",
							"content-encoding": "gzip",
							"content-security-policy": "default-src 'none'",
						},
					}),
			);
		await expect(retargetReportHosting(options)).rejects.toMatchObject({
			exitCode: 1,
		});
		expect(registry.hosting()).toEqual(before);
	}
});

it("requires an initial migration before making remote calls", async () => {
	const { options, api, reportsDir } = await fixture();
	const registry = new ReportRegistry(join(reportsDir, "unmigrated"));
	await registry.ensureVercelProjectName();
	await expect(
		retargetReportHosting({ ...options, registry }),
	).rejects.toMatchObject({ exitCode: 2 });
	expect(api.getProject).not.toHaveBeenCalled();
});

it("preserves unresolved intent when a second hosting mutation cannot acquire the lock", async () => {
	const { options, registry } = await fixture();
	const { ReportRegistryLockBusy } = await import(
		"../bridge/report-registry.js"
	);
	vi.spyOn(registry, "withHostingMutationLock").mockRejectedValueOnce(
		new ReportRegistryLockBusy(),
	);
	await expect(retargetReportHosting(options)).rejects.toMatchObject({
		exitCode: 2,
	});
});

it("archives an abandoned intent even when recovery supplies a store id", async () => {
	const { options, api, reportsDir } = await fixture();
	api.createPrivateBlobStore.mockRejectedValueOnce(new Error("lost response"));
	await expect(retargetReportHosting(options)).rejects.toMatchObject({
		exitCode: 1,
	});
	await retargetReportHosting({
		...options,
		storeId: "abc",
		abandonStoreIntent: true,
	});
	const journal = JSON.parse(
		readFileSync(join(reportsDir, "retarget.fw-reports-abc123.json"), "utf8"),
	);
	expect(journal.abandonedIntents).toHaveLength(1);
	expect(journal.abandonedIntents[0].name).toBe("fw-reports-abc123-blob");
});

it("archives an abandoned intent before creating under a fresh store name", async () => {
	const { options, api, reportsDir } = await fixture();
	api.createPrivateBlobStore.mockRejectedValueOnce(new Error("lost response"));
	await expect(retargetReportHosting(options)).rejects.toMatchObject({
		exitCode: 1,
	});
	const original = api.getStore.getMockImplementation()!;
	api.getStore.mockImplementation(async () => ({
		...(await original()),
		name: "fresh-name",
	}));
	await retargetReportHosting({
		...options,
		abandonStoreIntent: true,
		storeName: "fresh-name",
	});
	expect(api.createPrivateBlobStore).toHaveBeenLastCalledWith({
		name: "fresh-name",
	});
	expect(
		JSON.parse(
			readFileSync(join(reportsDir, "retarget.fw-reports-abc123.json"), "utf8"),
		).abandonedIntents,
	).toHaveLength(1);
});

it("clears only definitely uncreated 4xx intents and redacts failed-step output", async () => {
	const { VercelApiError } = await import("../bridge/vercel-hosting-api.js");
	for (const status of [400, 402, 403, 409, 429]) {
		const { options, api, reportsDir } = await fixture();
		api.createPrivateBlobStore.mockRejectedValueOnce(
			new VercelApiError(status, "/create", "account-secret"),
		);
		await expect(retargetReportHosting(options)).rejects.toMatchObject({
			exitCode: 1,
		});
		const journal = JSON.parse(
			readFileSync(join(reportsDir, "retarget.fw-reports-abc123.json"), "utf8"),
		);
		expect(Boolean(journal.storeCreateIntent)).toBe(status === 429);
		expect(options.log.mock.calls.flat().join(" ")).not.toContain(
			"account-secret",
		);
	}
});

it("stops before upload on a wrong-store token or an undecryptable environment", async () => {
	const { EnvNotDecryptable } = await import("../bridge/vercel-hosting-api.js");
	for (const kind of ["mismatch", "sensitive"]) {
		const { options, api, put, registry } = await fixture();
		const before = registry.hosting();
		if (kind === "mismatch")
			api.decryptProjectEnv.mockResolvedValueOnce(
				"vercel_blob_rw_other_secret",
			);
		else
			api.decryptProjectEnv.mockRejectedValueOnce(
				new EnvNotDecryptable(200, "env_a"),
			);
		await expect(retargetReportHosting(options)).rejects.toMatchObject({
			exitCode: kind === "mismatch" ? 1 : 3,
		});
		expect(put).not.toHaveBeenCalled();
		expect(registry.hosting()).toEqual(before);
	}
});

it("resumes an interrupted upload from durable journal proofs", async () => {
	const { options, put, registry } = await fixture();
	for (let i = 0; i < 24; i++)
		await registry
			.stagePublish(
				"p",
				`<html><head></head><body>extra ${i}</body></html>`,
				undefined,
				registry.hostingBinding(),
			)
			.commit();
	const original = put.getMockImplementation()!;
	let calls = 0;
	put.mockImplementation(async (pathname) => {
		calls++;
		if (calls === 26) throw new Error("upload interrupted");
		return original(pathname);
	});
	await expect(retargetReportHosting(options)).rejects.toMatchObject({
		exitCode: 1,
	});
	const result = await retargetReportHosting(options);
	expect(result.skipped).toBe(25);
	expect(result.uploaded).toBe(2);
	expect(put).toHaveBeenCalledTimes(28);
});

it("breaks a dead hosting-mutation lock and completes in the same invocation", async () => {
	const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
	const { options, reportsDir } = await fixture();
	const lock = join(reportsDir, "hosting-mutation.lock.d");
	mkdirSync(lock);
	writeFileSync(
		join(lock, "holder"),
		JSON.stringify({ pid: 2147483646, at: Date.now() }),
	);
	expect((await retargetReportHosting(options)).passes).toBe(1);
	expect(existsSync(lock)).toBe(false);
});

it("preserves mixed-case API identity through creation, journal, registry and replay", async () => {
	const { options, api, registry, reportsDir } = await fixture();
	api.createPrivateBlobStore.mockResolvedValue("store_AbC");
	const details = api.getStore.getMockImplementation()!;
	api.getStore.mockImplementation(async (id) => {
		expect(id).toBe("store_AbC");
		return { ...(await details()), apiId: "store_AbC" };
	});
	const env = api.findProjectBlobEnv.getMockImplementation()!;
	api.findProjectBlobEnv.mockImplementation(async () => {
		const value = await env();
		return value ? { ...value, storeApiId: "store_AbC" } : value;
	});
	api.decryptProjectEnv.mockResolvedValue("vercel_blob_rw_AbC_secret");
	await retargetReportHosting(options);
	expect(api.connectStore).toHaveBeenCalledWith({
		storeId: "store_AbC",
		projectId: "prj_a",
	});
	expect(registry.hostingBinding()).toMatchObject({
		storeId: "abc",
		storeApiId: "store_AbC",
	});
	expect(
		JSON.parse(
			readFileSync(join(reportsDir, "retarget.fw-reports-abc123.json"), "utf8"),
		),
	).toMatchObject({ storeId: "abc", storeApiId: "store_AbC" });
	const reloaded = new ReportRegistry(reportsDir, { now: options.now });
	expect(reloaded.hostingBinding().storeApiId).toBe("store_AbC");
	await retargetReportHosting({ ...options, registry: reloaded });
});

it("keeps a refreshed Epic token live on day 15 while ordinary migrated tokens expire", async () => {
	const { createReportGatewayHandler } = await import(
		"../bridge/report-gateway-runtime.js"
	);
	const { gunzipSync } = await import("node:zlib");
	const { options, registry: initial, put, reportsDir } = await fixture();
	let now = options.now();
	const day = 24 * 60 * 60_000;
	const registry = new ReportRegistry(reportsDir, { now: () => now });
	const ordinary = initial.list()[0]!.token;
	const epic = "e".repeat(32);
	const html =
		'<html><head></head><body><script nonce="__CSP_NONCE__">ok()</script></body></html>';
	await registry
		.stageEpicPageRepublish(
			"p",
			html,
			epic,
			undefined,
			registry.hostingBinding(),
		)
		.commit();
	const objects = new Map<string, { bytes: Buffer; uploadedAt: Date }>();
	put.mockImplementation(async (pathname: string, body: unknown) => {
		objects.set(pathname, {
			bytes: Buffer.from(body as string | Buffer),
			uploadedAt: new Date(now),
		});
		return {
			pathname,
			url: `https://abc.private.blob.vercel-storage.com/${pathname}`,
		};
	});
	await retargetReportHosting({ ...options, registry, now: () => now });
	const manifestSource = options.deployGateway.mock.calls[0]![2].find(
		(file: { file: string }) =>
			file.file === "api/report-gateway-migration-manifest.js",
	)!.data;
	const manifest = JSON.parse(
		/Object.freeze\((.*)\)/.exec(manifestSource)![1]!,
	);
	expect(manifest[epic]).toBeUndefined();
	expect(manifest[ordinary]).toBeDefined();
	const { deployReportGatewayOnly } = await import(
		"../bridge/report-hosting-migration.js"
	);
	await deployReportGatewayOnly({
		...options,
		registry,
		bound: options.blobStore.bind({
			key: "BLOB_READ_WRITE_TOKEN",
			value: "vercel_blob_rw_abc_secret",
			source: "process",
			generation: 0,
		}),
	});
	const redeployedManifest = options.deployGateway.mock.calls[1]![2].find(
		(file: { file: string }) =>
			file.file === "api/report-gateway-migration-manifest.js",
	)!.data;
	expect(
		JSON.parse(/Object.freeze\((.*)\)/.exec(redeployedManifest)![1]!)[epic],
	).toBeUndefined();
	now += 14 * day;
	const staged = registry.stageEpicPageRepublish(
		"p",
		html,
		epic,
		undefined,
		registry.hostingBinding(),
	);
	const bound = options.blobStore.bind({
		key: "BLOB_READ_WRITE_TOKEN",
		value: "vercel_blob_rw_abc_secret",
		source: "process",
		generation: 0,
	});
	await bound.putEpicPage(epic, staged.html, undefined, { gzip: true });
	await staged.commit();
	now += day;
	const handler = createReportGatewayHandler({
		now: () => now,
		blobToken: () => "vercel_blob_rw_abc_secret",
		migratedCreatedAt: manifest,
		get: async (pathname) => {
			const item = objects.get(pathname);
			return item
				? {
						statusCode: 200,
						stream: new Blob([item.bytes]).stream(),
						headers: new Headers(),
						blob: { uploadedAt: item.uploadedAt, etag: '"etag"' },
					}
				: null;
		},
	});
	const response = await handler(
		new Request(`https://gateway/api/report?token=${epic}`, {
			headers: { "Accept-Encoding": "gzip" },
		}),
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("content-security-policy")).toContain("nonce-");
	expect(
		gunzipSync(Buffer.from(await response.arrayBuffer())).toString(),
	).toContain('<script nonce="');
	expect(
		(await handler(new Request(`https://gateway/api/report?token=${ordinary}`)))
			.status,
	).toBe(404);
});

it("recovers legacy Epic identities from publication metadata and persists only matching mutable flags", async () => {
	const { writeFileSync } = await import("node:fs");
	const { readEpicReportPublications } = await import(
		"../bridge/report-epic-publications.js"
	);
	const Database = (await import("better-sqlite3")).default;
	const { options, registry, reportsDir } = await fixture();
	const epic = "d".repeat(32);
	await registry
		.stageEpicPageRepublish(
			"p",
			"<html><head></head><body>epic</body></html>",
			epic,
			undefined,
			registry.hostingBinding(),
		)
		.commit();
	const registryPath = join(reportsDir, "registry.json");
	const data = JSON.parse(readFileSync(registryPath, "utf8"));
	for (const entry of data.reports) delete entry.mutable;
	writeFileSync(registryPath, JSON.stringify(data));
	const dbPath = join(reportsDir, "teamlead.db");
	const db = new Database(dbPath);
	db.exec(
		"CREATE TABLE epic_page_publication (project_name TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE)",
	);
	db.prepare("INSERT INTO epic_page_publication VALUES (?,?)").run("p", epic);
	db.close();
	const read = vi.fn(() => readEpicReportPublications(dbPath));
	await retargetReportHosting({ ...options, readEpicPublications: read });
	expect(read).toHaveBeenCalledOnce();
	expect(
		new ReportRegistry(reportsDir, { now: options.now })
			.list()
			.find((entry) => entry.token === epic)?.mutable,
	).toBe(true);
	expect(
		registry
			.list()
			.filter((entry) => entry.token !== epic)
			.every((entry) => !entry.mutable),
	).toBe(true);
	const manifestSource = options.deployGateway.mock.calls[0]![2].find(
		(file: { file: string }) =>
			file.file === "api/report-gateway-migration-manifest.js",
	)!.data;
	const manifest = JSON.parse(
		/Object.freeze\((.*)\)/.exec(manifestSource)![1]!,
	);
	expect(manifest[epic]).toBeUndefined();
	expect(Object.keys(manifest)).toHaveLength(3);
});

it("fails before remote mutations when old Epic identity authority is unavailable or conflicts", async () => {
	for (const kind of ["unavailable", "conflict"]) {
		const { options, api, registry, reportsDir } = await fixture();
		const before = readFileSync(join(reportsDir, "registry.json"), "utf8");
		const readEpicPublications = () => {
			if (kind === "unavailable")
				throw new Error("Epic publication metadata unavailable");
			return [
				{ projectName: "different-project", token: registry.list()[0]!.token },
			];
		};
		await expect(
			retargetReportHosting({ ...options, readEpicPublications }),
		).rejects.toMatchObject({ exitCode: 2 });
		expect(api.getProject).not.toHaveBeenCalled();
		expect(readFileSync(join(reportsDir, "registry.json"), "utf8")).toBe(
			before,
		);
	}
});
