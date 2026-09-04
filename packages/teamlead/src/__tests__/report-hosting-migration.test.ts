import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assertGatewayBlobEnvironment,
	migrateReportHosting,
} from "../bridge/report-hosting-migration.js";
import { ReportRegistry } from "../bridge/report-registry.js";

const HTML =
	"<!doctype html><html><head><title>t</title></head><body>legacy-report-body</body></html>";
const RETENTION_SOURCE =
	"export const REPORT_RETENTION_MS = 1209600000; export function isReportExpired(nowMs, createdAtMs) { return Number.isFinite(createdAtMs) && nowMs - createdAtMs >= REPORT_RETENTION_MS; }";

describe("report hosting migration", () => {
	let dir: string | undefined;

	afterEach(() => {
		vi.restoreAllMocks();
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("rejects a Blob credential that is not connected to the production target", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					envs: [
						{
							key: "BLOB_READ_WRITE_TOKEN",
							target: ["preview", "development"],
						},
					],
				}),
				{ status: 200 },
			),
		);

		await expect(
			assertGatewayBlobEnvironment("vercel-secret", "fw-reports-a1b2c3"),
		).rejects.toThrow("production");
	});

	it("accepts a Blob credential connected to the production target", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					envs: [
						{
							key: "BLOB_READ_WRITE_TOKEN",
							target: ["production", "preview"],
						},
					],
				}),
				{ status: 200 },
			),
		);

		await expect(
			assertGatewayBlobEnvironment("vercel-secret", "fw-reports-a1b2c3"),
		).resolves.toBeUndefined();
	});

	it("uploads every retained report, deploys only the fixed gateway, and atomically records the cutover", async () => {
		dir = mkdtempSync(join(tmpdir(), "fly2283-migrate-"));
		let sequence = 0;
		const registry = new ReportRegistry(dir, {
			randomHex: (bytes) => String(++sequence).padStart(bytes * 2, "0"),
		});
		registry.stagePublish("flywheel", HTML, "one").commit();
		registry.stagePublish("personal-assistant", HTML, "two").commit();
		const putMigratedReport = vi
			.fn()
			.mockImplementation(async (token: string) => ({
				pathname: `r/${token}/index.html`,
				url: `https://store.private.blob.vercel-storage.com/r/${token}/index.html`,
			}));
		const deployGateway = vi
			.fn()
			.mockResolvedValue({ deploymentId: "dpl_gateway" });

		await migrateReportHosting({
			registry,
			blobStore: { putMigratedReport },
			vercelToken: "vercel-secret",
			deployGateway,
			verifyGatewayEnvironment: vi.fn().mockResolvedValue(undefined),
			gatewayRuntimeSource:
				'export async function GET() { return new Response("gateway"); }',
			gatewayHtmlSource: "export const scanner = 'canonical-scanner';",
			reportRetentionSource: RETENTION_SOURCE,
			blobPackageVersion: "2.8.0",
			now: () => Date.parse("2026-09-03T16:00:00.000Z"),
		});

		expect(putMigratedReport).toHaveBeenCalledTimes(2);
		expect(deployGateway).toHaveBeenCalledTimes(1);
		const [, projectName, files, timeoutMs] = deployGateway.mock.calls[0] as [
			string,
			string,
			Array<{ file: string; data: string }>,
			number,
		];
		expect(projectName).toMatch(/^fw-reports-[0-9a-f]{6}$/);
		expect(files.map((file) => file.file).sort()).toEqual([
			"api/report-gateway-html.js",
			"api/report-gateway-migration-manifest.js",
			"api/report-retention.js",
			"api/report.js",
			"package.json",
			"robots.txt",
			"vercel.json",
		]);
		expect(files.some((file) => file.data.includes("legacy-report-body"))).toBe(
			false,
		);
		expect(
			files.find((file) => file.file === "api/report-gateway-html.js")?.data,
		).toContain("canonical-scanner");
		const migrationManifest = files.find(
			(file) => file.file === "api/report-gateway-migration-manifest.js",
		)?.data;
		for (const entry of registry.list()) {
			expect(migrationManifest).toContain(
				`${JSON.stringify(entry.token)}:${JSON.stringify(entry.createdAt)}`,
			);
		}
		expect(timeoutMs).toBe(5 * 60 * 1000);
		expect(registry.hosting()).toMatchObject({
			provider: "vercel-blob",
			gatewayDeploymentId: "dpl_gateway",
		});
	});

	it("bootstraps a stable gateway project when the reports directory is empty", async () => {
		dir = mkdtempSync(join(tmpdir(), "fly2283-migrate-"));
		const registry = new ReportRegistry(dir, {
			randomHex: (bytes) => "a1b2c3".slice(0, bytes * 2),
		});
		const putMigratedReport = vi.fn();
		const deployGateway = vi
			.fn()
			.mockResolvedValue({ deploymentId: "dpl_gateway" });
		const verifyGatewayEnvironment = vi.fn().mockResolvedValue(undefined);

		await migrateReportHosting({
			registry,
			blobStore: { putMigratedReport },
			vercelToken: "vercel-secret",
			deployGateway,
			verifyGatewayEnvironment,
			gatewayRuntimeSource: "export function GET() {}",
			gatewayHtmlSource: "export function scanHtmlTags() {}",
			reportRetentionSource: RETENTION_SOURCE,
			now: () => Date.parse("2026-09-03T16:00:00.000Z"),
		});

		expect(putMigratedReport).not.toHaveBeenCalled();
		expect(verifyGatewayEnvironment).toHaveBeenCalledWith(
			"vercel-secret",
			"fw-reports-a1b2c3",
		);
		expect(deployGateway.mock.calls[0]?.[1]).toBe("fw-reports-a1b2c3");
		expect(registry.vercelProjectName()).toBe("fw-reports-a1b2c3");
		expect(registry.hosting()).toMatchObject({
			provider: "vercel-blob",
			gatewayDeploymentId: "dpl_gateway",
		});
	});

	it("fails before uploads or deployment when the gateway project lacks private Blob credentials", async () => {
		dir = mkdtempSync(join(tmpdir(), "fly2283-migrate-"));
		const registry = new ReportRegistry(dir, {
			randomHex: (bytes) => "1".padStart(bytes * 2, "0"),
		});
		registry.stagePublish("flywheel", HTML).commit();
		const putMigratedReport = vi.fn();
		const deployGateway = vi.fn();

		await expect(
			migrateReportHosting({
				registry,
				blobStore: { putMigratedReport },
				vercelToken: "vercel-secret",
				deployGateway,
				verifyGatewayEnvironment: vi
					.fn()
					.mockRejectedValue(
						new Error("BLOB_READ_WRITE_TOKEN is not connected"),
					),
				gatewayRuntimeSource: "export function GET() {}",
				reportRetentionSource: RETENTION_SOURCE,
			}),
		).rejects.toThrow("BLOB_READ_WRITE_TOKEN is not connected");
		expect(putMigratedReport).not.toHaveBeenCalled();
		expect(deployGateway).not.toHaveBeenCalled();
		expect(registry.hosting()).toBeUndefined();
	});

	it("does not deploy or mark cutover when a legacy Blob upload fails", async () => {
		dir = mkdtempSync(join(tmpdir(), "fly2283-migrate-"));
		const registry = new ReportRegistry(dir, {
			randomHex: (bytes) => "1".padStart(bytes * 2, "0"),
		});
		registry.stagePublish("flywheel", HTML).commit();
		const deployGateway = vi.fn();

		await expect(
			migrateReportHosting({
				registry,
				blobStore: {
					putMigratedReport: vi
						.fn()
						.mockRejectedValue(new Error("Blob upload interrupted")),
				},
				vercelToken: "vercel-secret",
				deployGateway,
				verifyGatewayEnvironment: vi.fn().mockResolvedValue(undefined),
				gatewayRuntimeSource: "export function GET() {}",
				reportRetentionSource: RETENTION_SOURCE,
			}),
		).rejects.toThrow("Blob upload interrupted");
		expect(deployGateway).not.toHaveBeenCalled();
		expect(registry.hosting()).toBeUndefined();
	});

	it("rejects a stale shared gateway module before uploads or deployment", async () => {
		dir = mkdtempSync(join(tmpdir(), "fly2283-migrate-"));
		const registry = new ReportRegistry(dir, {
			randomHex: (bytes) => "4".padStart(bytes * 2, "0"),
		});
		registry.stagePublish("flywheel", HTML).commit();
		const putMigratedReport = vi.fn();
		const deployGateway = vi.fn();
		const verifyGatewayEnvironment = vi.fn();

		await expect(
			migrateReportHosting({
				registry,
				blobStore: { putMigratedReport },
				vercelToken: "vercel-secret",
				deployGateway,
				verifyGatewayEnvironment,
				gatewayRuntimeSource:
					'import { htmlMetaHttpEquivContent } from "./report-gateway-html.js"; export function GET() {}',
				gatewayHtmlSource: "export const staleScanner = true;",
				reportRetentionSource: RETENTION_SOURCE,
			}),
		).rejects.toThrow("htmlMetaHttpEquivContent");
		expect(verifyGatewayEnvironment).not.toHaveBeenCalled();
		expect(putMigratedReport).not.toHaveBeenCalled();
		expect(deployGateway).not.toHaveBeenCalled();
		expect(registry.hosting()).toBeUndefined();
	});

	it("fails closed instead of silently dropping a legacy link with malformed creation metadata", async () => {
		dir = mkdtempSync(join(tmpdir(), "fly2283-migrate-"));
		const registry = new ReportRegistry(dir, {
			randomHex: (bytes) => "3".padStart(bytes * 2, "0"),
		});
		registry.stagePublish("flywheel", HTML).commit();
		const registryPath = join(dir, "registry.json");
		const data = JSON.parse(readFileSync(registryPath, "utf8")) as {
			reports: Array<{ createdAt: string }>;
		};
		data.reports[0]!.createdAt = "not-a-date";
		writeFileSync(registryPath, JSON.stringify(data), "utf8");
		const putMigratedReport = vi.fn();
		const deployGateway = vi.fn();

		await expect(
			migrateReportHosting({
				registry,
				blobStore: { putMigratedReport },
				vercelToken: "vercel-secret",
				deployGateway,
				verifyGatewayEnvironment: vi.fn().mockResolvedValue(undefined),
				gatewayRuntimeSource: "export function GET() {}",
				reportRetentionSource: RETENTION_SOURCE,
			}),
		).rejects.toThrow("invalid createdAt");
		expect(putMigratedReport).not.toHaveBeenCalled();
		expect(deployGateway).not.toHaveBeenCalled();
		expect(registry.hosting()).toBeUndefined();
	});

	it("does not mark cutover when the one-time gateway deployment fails", async () => {
		dir = mkdtempSync(join(tmpdir(), "fly2283-migrate-"));
		const registry = new ReportRegistry(dir, {
			randomHex: (bytes) => "2".padStart(bytes * 2, "0"),
		});
		registry.stagePublish("flywheel", HTML).commit();

		await expect(
			migrateReportHosting({
				registry,
				blobStore: {
					putMigratedReport: vi.fn().mockResolvedValue({
						pathname: "r/00000000000000000000000000000002/index.html",
						url: "https://store.private.blob.vercel-storage.com/r/00000000000000000000000000000002/index.html",
					}),
				},
				vercelToken: "vercel-secret",
				deployGateway: vi
					.fn()
					.mockRejectedValue(new Error("Vercel deployment unavailable")),
				verifyGatewayEnvironment: vi.fn().mockResolvedValue(undefined),
				gatewayRuntimeSource: "export function GET() {}",
				gatewayHtmlSource: "export function scanHtmlTags() {}",
				reportRetentionSource: RETENTION_SOURCE,
			}),
		).rejects.toThrow("Vercel deployment unavailable");
		expect(registry.hosting()).toBeUndefined();
	});

	it("is idempotent after the durable cutover marker is committed", async () => {
		dir = mkdtempSync(join(tmpdir(), "fly2283-migrate-"));
		const registry = new ReportRegistry(dir);
		registry.stagePublish("flywheel", HTML).commit();
		registry.markHostingMigrated({
			provider: "vercel-blob",
			migratedAt: "2026-09-03T16:00:00.000Z",
			gatewayDeploymentId: "dpl_existing",
		});
		const putMigratedReport = vi.fn();
		const deployGateway = vi.fn();
		const verifyGatewayEnvironment = vi.fn();

		await migrateReportHosting({
			registry,
			blobStore: { putMigratedReport },
			vercelToken: "vercel-secret",
			deployGateway,
			verifyGatewayEnvironment,
			gatewayRuntimeSource: "export function GET() {}",
			reportRetentionSource: RETENTION_SOURCE,
		});

		expect(verifyGatewayEnvironment).not.toHaveBeenCalled();
		expect(putMigratedReport).not.toHaveBeenCalled();
		expect(deployGateway).not.toHaveBeenCalled();
	});
});
