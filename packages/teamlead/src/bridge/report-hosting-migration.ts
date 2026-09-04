import { readFileSync } from "node:fs";
import type { ReportBlobUpload } from "./report-blob-store.js";
import type { ReportRegistry } from "./report-registry.js";
import { isReportExpired } from "./report-retention.js";
import { deployFilesToVercel, type VercelDeployFile } from "./vercel-deploy.js";

const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";
const REPORT_GATEWAY_DEPLOY_TIMEOUT_MS = 5 * 60 * 1000;

export interface ReportHostingMigrationOptions {
	registry: ReportRegistry;
	blobStore: {
		putMigratedReport(token: string, html: string): Promise<ReportBlobUpload>;
	};
	vercelToken: string;
	deployGateway?: typeof deployFilesToVercel;
	verifyGatewayEnvironment?: (
		vercelToken: string,
		projectName: string,
	) => Promise<void>;
	gatewayRuntimeSource?: string;
	gatewayHtmlSource?: string;
	reportRetentionSource?: string;
	blobPackageVersion?: string;
	now?: () => number;
}

export async function assertGatewayBlobEnvironment(
	vercelToken: string,
	projectName: string,
): Promise<void> {
	const response = await fetch(
		`https://api.vercel.com/v9/projects/${encodeURIComponent(projectName)}/env`,
		{ headers: { Authorization: `Bearer ${vercelToken}` } },
	);
	if (!response.ok) {
		throw new Error(
			`unable to verify gateway environment (${response.status})`,
		);
	}
	const body = (await response.json()) as {
		envs?: Array<{ key?: string; target?: string | string[] }>;
		data?: Array<{ key?: string; target?: string | string[] }>;
	};
	const variables = body.envs ?? body.data ?? [];
	if (
		!variables.some((variable) => {
			if (variable.key !== "BLOB_READ_WRITE_TOKEN") return false;
			return Array.isArray(variable.target)
				? variable.target.includes("production")
				: variable.target === "production";
		})
	) {
		throw new Error(
			"BLOB_READ_WRITE_TOKEN is not connected to the report gateway production target",
		);
	}
}

export function buildReportGatewayFiles(
	migratedCreatedAt: Readonly<Record<string, string>>,
	gatewayRuntimeSource: string,
	gatewayHtmlSource: string,
	reportRetentionSource: string,
	blobPackageVersion: string,
): VercelDeployFile[] {
	const migrationManifestSource = `export const MIGRATED_REPORT_CREATED_AT = Object.freeze(${JSON.stringify(migratedCreatedAt)});\n`;
	assertGatewayLocalImportsResolve(gatewayRuntimeSource, {
		"./report-gateway-html.js": gatewayHtmlSource,
		"./report-gateway-migration-manifest.js": migrationManifestSource,
		"./report-retention.js": reportRetentionSource,
	});
	return [
		{
			file: "api/report.js",
			data: gatewayRuntimeSource,
		},
		{
			file: "api/report-gateway-html.js",
			data: gatewayHtmlSource,
		},
		{
			file: "api/report-gateway-migration-manifest.js",
			data: migrationManifestSource,
		},
		{
			file: "api/report-retention.js",
			data: reportRetentionSource,
		},
		{
			file: "package.json",
			data: `${JSON.stringify(
				{
					type: "module",
					dependencies: { "@vercel/blob": blobPackageVersion },
				},
				null,
				2,
			)}\n`,
		},
		{
			file: "vercel.json",
			data: `${JSON.stringify(
				{
					rewrites: [
						{
							source: "/r/:token/",
							destination: "/api/report?token=:token",
						},
					],
				},
				null,
				2,
			)}\n`,
		},
		{ file: "robots.txt", data: ROBOTS_TXT },
	];
}

function assertGatewayLocalImportsResolve(
	runtimeSource: string,
	moduleSources: Readonly<Record<string, string>>,
): void {
	const imports = runtimeSource.matchAll(
		/import\s*\{([^}]*)\}\s*from\s*["'](\.\/[^"']+)["']/g,
	);
	for (const match of imports) {
		const modulePath = match[2] ?? "";
		const moduleSource = moduleSources[modulePath];
		if (moduleSource === undefined) {
			throw new Error(
				`report gateway runtime imports undeployed local module ${modulePath}`,
			);
		}
		for (const item of (match[1] ?? "").split(",")) {
			const importedName = item
				.trim()
				.split(/\s+as\s+/)[0]
				?.trim();
			if (!importedName) continue;
			const escapedName = importedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const declaration = new RegExp(
				`\\bexport\\s+(?:const|let|var|function|class)\\s+${escapedName}\\b`,
			);
			const exportedList = [...moduleSource.matchAll(/\bexport\s*\{([^}]*)\}/g)]
				.flatMap((exportMatch) => (exportMatch[1] ?? "").split(","))
				.some((exported) => {
					const [original, alias] = exported.trim().split(/\s+as\s+/);
					return (alias ?? original)?.trim() === importedName;
				});
			if (!declaration.test(moduleSource) && !exportedList) {
				throw new Error(
					`deployed gateway module ${modulePath} does not export ${importedName}`,
				);
			}
		}
	}
}

export async function migrateReportHosting(
	options: ReportHostingMigrationOptions,
): Promise<void> {
	if (options.registry.hosting()?.provider === "vercel-blob") return;
	const now = options.now?.() ?? Date.now();
	const retained = options.registry.list().filter((entry) => {
		const createdAt = Date.parse(entry.createdAt);
		if (!Number.isFinite(createdAt)) {
			throw new Error(
				`report hosting migration found invalid createdAt for token=${entry.token}`,
			);
		}
		return !isReportExpired(now, createdAt);
	});
	const migratedCreatedAt = Object.fromEntries(
		retained.map((entry) => [entry.token, entry.createdAt]),
	);
	const gatewayRuntimeSource =
		options.gatewayRuntimeSource ??
		readFileSync(
			new URL("./report-gateway-runtime.js", import.meta.url),
			"utf8",
		);
	const gatewayHtmlSource =
		options.gatewayHtmlSource ??
		readFileSync(
			new URL("../../../flywheel-comm/dist/report-html.js", import.meta.url),
			"utf8",
		);
	const reportRetentionSource =
		options.reportRetentionSource ??
		readFileSync(new URL("./report-retention.js", import.meta.url), "utf8");
	const files = buildReportGatewayFiles(
		migratedCreatedAt,
		gatewayRuntimeSource,
		gatewayHtmlSource,
		reportRetentionSource,
		options.blobPackageVersion ?? "2.8.0",
	);
	const projectName = options.registry.ensureVercelProjectName();
	await (options.verifyGatewayEnvironment ?? assertGatewayBlobEnvironment)(
		options.vercelToken,
		projectName,
	);
	for (const entry of retained) {
		await options.blobStore.putMigratedReport(
			entry.token,
			options.registry.readReportHtml(entry.token),
		);
	}
	const deployGateway = options.deployGateway ?? deployFilesToVercel;
	const result = await deployGateway(
		options.vercelToken,
		projectName,
		files,
		REPORT_GATEWAY_DEPLOY_TIMEOUT_MS,
	);
	options.registry.markHostingMigrated({
		provider: "vercel-blob",
		migratedAt: new Date(now).toISOString(),
		gatewayDeploymentId: result.deploymentId,
	});
}
