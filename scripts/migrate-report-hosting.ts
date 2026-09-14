#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VercelBlobReportStore } from "../packages/teamlead/src/bridge/report-blob-store.js";
import { parseReportHostingCommand } from "../packages/teamlead/src/bridge/report-hosting-command.js";
import { assertReportHostingCredentialBinding } from "../packages/teamlead/src/bridge/report-hosting-credentials.js";
import {
	deployReportGatewayOnly,
	migrateReportHosting,
} from "../packages/teamlead/src/bridge/report-hosting-migration.js";
import {
	ReportRetargetError,
	retargetReportHosting,
} from "../packages/teamlead/src/bridge/report-hosting-retarget.js";
import { checkReportHostingUsage } from "../packages/teamlead/src/bridge/report-hosting-usage.js";
import {
	ReportRegistry,
	ReportRegistryLockBusy,
} from "../packages/teamlead/src/bridge/report-registry.js";
import { SecretRedactor } from "../packages/teamlead/src/bridge/vercel-hosting-api.js";

async function legacyMain(): Promise<void> {
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

const redactor = new SecretRedactor();
export async function main(args = process.argv.slice(2)): Promise<void> {
	const command = parseReportHostingCommand(args);
	if (command.mode === "legacy") return legacyMain();
	redactor.add(command.vercelToken, "account");
	redactor.add(command.blobToken, "blob");
	const reportsDir =
		command.reportsDir ??
		(process.env.FLYWHEEL_REPORTS_DIR?.trim() || undefined) ??
		resolve(homedir(), ".flywheel", "reports");
	const registry = new ReportRegistry(reportsDir);
	const print = (value: unknown) =>
		console.log(
			redactor.redact(
				typeof value === "string" ? value : JSON.stringify(value),
			),
		);
	if (command.mode === "usage-check") {
		print(await checkReportHostingUsage({ ...command, registry, reportsDir }));
		return;
	}
	const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const readArtifact = (path: string) => {
		const absolute = resolve(repositoryRoot, path);
		if (!existsSync(absolute))
			throw new ReportRetargetError(
				2,
				"compiled report gateway artifacts missing; build flywheel-comm and flywheel-teamlead first",
			);
		return readFileSync(absolute, "utf8");
	};
	const blobPackageVersion = (
		JSON.parse(
			readFileSync(
				resolve(repositoryRoot, "packages/teamlead/package.json"),
				"utf8",
			),
		) as { dependencies?: Record<string, string> }
	).dependencies?.["@vercel/blob"];
	if (!blobPackageVersion)
		throw new ReportRetargetError(2, "@vercel/blob dependency missing");
	const sources = {
		gatewayRuntimeSource: readArtifact(
			"packages/teamlead/dist/bridge/report-gateway-runtime.js",
		),
		gatewayHtmlSource: readArtifact(
			"packages/flywheel-comm/dist/report-html.js",
		),
		reportRetentionSource: readArtifact(
			"packages/teamlead/dist/bridge/report-retention.js",
		),
		blobPackageVersion,
	};
	if (command.mode === "retarget") {
		const result = await retargetReportHosting({
			...command,
			...sources,
			registry,
			reportsDir,
			projectName: command.projectName!,
			redactor,
			log: print,
		});
		print(
			"Epic audit 下一次刷新补齐。按 envHint 更新凭据后删除 secretsFile；无需重启 Bridge。",
		);
		print(result);
		return;
	}
	const snapshot = {
		key: "BLOB_READ_WRITE_TOKEN" as const,
		value: command.blobToken,
		source: "process" as const,
		generation: 0,
	};
	const binding = await registry.withLock(async () =>
		registry.hostingBinding(),
	);
	assertReportHostingCredentialBinding(binding.storeId, snapshot);
	const bound = new VercelBlobReportStore().bind(snapshot);
	print(
		await deployReportGatewayOnly({
			...sources,
			registry,
			vercelToken: command.vercelToken,
			bound,
		}),
	);
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	main().catch((error) => {
		if (process.argv.length <= 2)
			console.error("Report hosting migration failed");
		else
			console.error(
				redactor.redact(
					error instanceof Error
						? error.message
						: "Report hosting command failed",
				),
			);
		process.exitCode =
			error instanceof ReportRetargetError
				? error.exitCode
				: error instanceof ReportRegistryLockBusy
					? 2
					: 1;
	});
