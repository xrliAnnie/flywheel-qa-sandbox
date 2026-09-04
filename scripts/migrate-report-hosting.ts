#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VercelBlobReportStore } from "../packages/teamlead/src/bridge/report-blob-store.js";
import { migrateReportHosting } from "../packages/teamlead/src/bridge/report-hosting-migration.js";
import { ReportRegistry } from "../packages/teamlead/src/bridge/report-registry.js";

async function main(): Promise<void> {
	const vercelToken = process.env.VERCEL_TOKEN?.trim();
	const blobToken = process.env.BLOB_READ_WRITE_TOKEN?.trim();
	if (!vercelToken) throw new Error("VERCEL_TOKEN is required");
	if (!blobToken) throw new Error("BLOB_READ_WRITE_TOKEN is required");

	const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const reportsDir =
		process.env.FLYWHEEL_REPORTS_DIR?.trim() ||
		resolve(homedir(), ".flywheel", "reports");
	const gatewayRuntimePath = resolve(
		repositoryRoot,
		"packages/teamlead/dist/bridge/report-gateway-runtime.js",
	);
	const gatewayHtmlPath = resolve(
		repositoryRoot,
		"packages/flywheel-comm/dist/report-html.js",
	);
	const reportRetentionPath = resolve(
		repositoryRoot,
		"packages/teamlead/dist/bridge/report-retention.js",
	);
	if (
		!existsSync(gatewayRuntimePath) ||
		!existsSync(gatewayHtmlPath) ||
		!existsSync(reportRetentionPath)
	) {
		throw new Error(
			"compiled report gateway, retention predicate, or shared HTML scanner is missing; run pnpm --filter flywheel-comm build && pnpm --filter flywheel-teamlead build first",
		);
	}
	const packageJson = JSON.parse(
		readFileSync(
			resolve(repositoryRoot, "packages/teamlead/package.json"),
			"utf8",
		),
	) as { dependencies?: Record<string, string> };
	const blobPackageVersion = packageJson.dependencies?.["@vercel/blob"];
	if (!blobPackageVersion) {
		throw new Error(
			"@vercel/blob dependency is missing from flywheel-teamlead",
		);
	}

	const registry = new ReportRegistry(reportsDir);
	await migrateReportHosting({
		registry,
		blobStore: new VercelBlobReportStore(blobToken),
		vercelToken,
		gatewayRuntimeSource: readFileSync(gatewayRuntimePath, "utf8"),
		gatewayHtmlSource: readFileSync(gatewayHtmlPath, "utf8"),
		reportRetentionSource: readFileSync(reportRetentionPath, "utf8"),
		blobPackageVersion,
	});
	console.log(
		`Report hosting migration complete for ${registry.vercelProjectName() ?? "unknown project"}`,
	);
}

main().catch(() => {
	console.error("Report hosting migration failed");
	process.exitCode = 1;
});
