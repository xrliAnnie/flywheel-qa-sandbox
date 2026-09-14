import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ReportBlobStore,
	VercelBlobReportStore,
} from "./report-blob-store.js";
import {
	type EpicReportPublication,
	readEpicReportPublications,
} from "./report-epic-publications.js";
import {
	type GatewayRequest,
	probeGatewayFormats,
	requestGateway,
} from "./report-gateway-probe.js";
import { blobStoreIdFromToken } from "./report-hosting-credentials.js";
import {
	assertGatewayBlobEnvironment,
	buildReportGatewayFiles,
	type ReportHostingMigrationOptions,
} from "./report-hosting-migration.js";
import { writeReportHostingSecrets } from "./report-hosting-secrets.js";
import {
	ReportHostingBindingConflict,
	ReportRegistryLockBusy,
	ReportRetargetManifestStale,
} from "./report-registry.js";
import { deployFilesToVercel } from "./vercel-deploy.js";
import {
	apiStoreId,
	EnvNotDecryptable,
	normalizeStoreId,
	SecretRedactor,
	VercelApiError,
	VercelHostingApi,
} from "./vercel-hosting-api.js";

export class ReportRetargetError extends Error {
	constructor(
		readonly exitCode: 1 | 2 | 3,
		message: string,
	) {
		super(message);
		this.name = "ReportRetargetError";
	}
}
type Provenance = { vercelProjectName: string; migratedAt: string };
type UploadProof = { createdAt: string; bytes: number; sha256: string };
interface RetargetJournal {
	schema: 2;
	projectName: string;
	projectId?: string;
	storeId?: string;
	storeApiId?: string;
	storeName: string;
	blobHost?: string;
	storeCreateIntent?: { name: string; at: string };
	abandonedIntents?: Array<{ name: string; at: string }>;
	connected?: boolean;
	cutoverAt?: string;
	retargetedFrom?: Provenance;
	uploaded: Record<string, UploadProof>;
	manifestDigest?: string;
	contentDigest?: string;
	gatewayDeploymentId?: string;
	verified?: {
		manifestDigest: string;
		contentDigest: string;
		deploymentId: string;
		tokens: string[];
		at: string;
	};
	updatedAt: string;
}
type HostingApi = Pick<
	VercelHostingApi,
	| "getProject"
	| "createProject"
	| "createPrivateBlobStore"
	| "findProjectBlobEnv"
	| "getStore"
	| "connectStore"
	| "decryptProjectEnv"
>;
export interface RetargetReportHostingOptions
	extends Omit<ReportHostingMigrationOptions, "blobStore"> {
	reportsDir: string;
	readEpicPublications?: () => readonly EpicReportPublication[];
	projectName: string;
	vercelTokenEnv: string;
	blobToken?: string;
	blobTokenEnv?: string;
	storeName?: string;
	storeId?: string;
	abandonStoreIntent?: boolean;
	region?: string;
	blobStore?: Pick<ReportBlobStore, "bind">;
	api?: HostingApi;
	redactor?: SecretRedactor;
	request?: GatewayRequest;
	probeGateway?: typeof probeGatewayFormats;
	log?: (line: string) => void;
}
export interface RetargetReportHostingResult {
	project: string;
	projectId: string;
	storeId: string;
	blobHost: string;
	gatewayDeploymentId: string;
	manifestDigest: string;
	contentDigest: string;
	passes: number;
	uploaded: number;
	reuploaded: number;
	skipped: number;
	verified: string[];
	secretsFile: string | null;
	envHint: string[];
}
export async function retargetReportHosting(
	options: RetargetReportHostingOptions,
): Promise<RetargetReportHostingResult> {
	const redactor = options.redactor ?? new SecretRedactor();
	redactor.add(options.vercelToken, "account");
	redactor.add(options.blobToken, "blob");
	let step = "preflight";
	let pass = 0;
	const log = (status: "done" | "skipped" | "failed", detail = "") =>
		options.log?.(
			redactor.redact(
				`[retarget] step=${step} status=${status} pass=${pass} detail=${detail}`,
			),
		);
	try {
		return await options.registry.withHostingMutationLock(async () => {
			const { registry, projectName } = options;
			const now = options.now ?? Date.now;
			const timestamp = () => new Date(now()).toISOString();
			if (!/^fw-reports-[0-9a-f]{6}$/.test(projectName))
				throw new ReportRetargetError(
					2,
					"project name must match fw-reports-<6 lowercase hex>",
				);
			if (!options.vercelToken.trim())
				throw new ReportRetargetError(2, "account credential missing");
			if (options.abandonStoreIntent && !options.storeName && !options.storeId)
				throw new ReportRetargetError(
					2,
					"abandon-store-intent requires a new store-name or store-id",
				);
			const source = await registry.withLock(async () =>
				registry.hostingBinding(),
			);
			if (source.vercelProjectName && !source.migratedAt)
				throw new ReportRetargetError(
					2,
					"source registry has no hosting marker; run the initial migrate command first",
				);
			if (source.vercelProjectName === projectName && !source.storeId)
				throw new ReportRetargetError(
					2,
					"record the current store with --usage-check --store-id before retrying",
				);
			if (registry.list().some((entry) => !entry.mutable)) {
				try {
					await registry.markMutableReports(
						(options.readEpicPublications ?? readEpicReportPublications)(),
					);
				} catch (error) {
					throw new ReportRetargetError(
						2,
						error instanceof Error
							? error.message
							: "Epic publication metadata unavailable",
					);
				}
			}
			const runtime =
				options.gatewayRuntimeSource ??
				readFileSync(
					new URL("./report-gateway-runtime.js", import.meta.url),
					"utf8",
				);
			const htmlSource =
				options.gatewayHtmlSource ??
				readFileSync(
					new URL(
						"../../../flywheel-comm/dist/report-html.js",
						import.meta.url,
					),
					"utf8",
				);
			const retention =
				options.reportRetentionSource ??
				readFileSync(new URL("./report-retention.js", import.meta.url), "utf8");
			const files = (manifest: Record<string, string>) =>
				buildReportGatewayFiles(
					manifest,
					runtime,
					htmlSource,
					retention,
					options.blobPackageVersion ?? "2.8.0",
				);
			files({});
			const journalPath = join(
				options.reportsDir,
				`retarget.${projectName}.json`,
			);
			let journal: RetargetJournal;
			try {
				journal = JSON.parse(
					readFileSync(journalPath, "utf8"),
				) as RetargetJournal;
				if (
					journal.schema !== 2 ||
					journal.projectName !== projectName ||
					!journal.uploaded ||
					typeof journal.uploaded !== "object" ||
					Array.isArray(journal.uploaded) ||
					typeof journal.storeName !== "string"
				)
					throw new Error("invalid journal");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT")
					throw new ReportRetargetError(
						2,
						"retarget journal is invalid; inspect it before retrying",
					);
				journal = {
					schema: 2,
					projectName,
					storeName: options.storeName ?? `${projectName}-blob`,
					uploaded: {},
					updatedAt: timestamp(),
				};
			}
			const save = () => {
				journal.updatedAt = timestamp();
				writeFileSync(
					`${journalPath}.tmp`,
					`${JSON.stringify(journal, null, 2)}\n`,
				);
				renameSync(`${journalPath}.tmp`, journalPath);
			};
			if (
				!journal.retargetedFrom &&
				source.vercelProjectName &&
				source.vercelProjectName !== projectName &&
				source.migratedAt
			)
				journal.retargetedFrom = {
					vercelProjectName: source.vercelProjectName,
					migratedAt: source.migratedAt,
				};
			const api =
				options.api ??
				new VercelHostingApi({ token: options.vercelToken, redactor });
			log("done");
			step = "project";
			const found = await api.getProject(projectName);
			const project = found ?? (await api.createProject(projectName));
			if (
				project.name !== projectName ||
				(journal.projectId && journal.projectId !== project.id)
			)
				throw new ReportRetargetError(
					2,
					"project identity differs from the retarget journal",
				);
			journal.projectId = project.id;
			save();
			log(found ? "skipped" : "done");
			step = "store";
			let env = await api.findProjectBlobEnv(project.id);
			let storeId =
				options.storeId ??
				env?.storeApiId ??
				env?.storeId ??
				journal.storeApiId ??
				journal.storeId;
			if (storeId && options.abandonStoreIntent && journal.storeCreateIntent) {
				journal.abandonedIntents = [
					...(journal.abandonedIntents ?? []),
					journal.storeCreateIntent,
				];
				delete journal.storeCreateIntent;
				save();
			}
			if (!storeId) {
				if (journal.storeCreateIntent) {
					if (!options.abandonStoreIntent)
						throw new ReportRetargetError(
							2,
							`previous store creation result is unknown; inspect ${journal.storeCreateIntent.name} in Vercel and retry with --store-id, or --abandon-store-intent --store-name <new-name>`,
						);
					if (options.storeName === journal.storeCreateIntent.name)
						throw new ReportRetargetError(
							2,
							"abandoning an uncertain store creation requires a new store name",
						);
					journal.abandonedIntents = [
						...(journal.abandonedIntents ?? []),
						journal.storeCreateIntent,
					];
					delete journal.storeCreateIntent;
				}
				journal.storeName = options.storeName ?? journal.storeName;
				journal.storeCreateIntent = {
					name: journal.storeName,
					at: timestamp(),
				};
				save();
				try {
					storeId = await api.createPrivateBlobStore({
						name: journal.storeName,
						...(options.region ? { region: options.region } : {}),
					});
				} catch (error) {
					if (
						error instanceof VercelApiError &&
						[400, 402, 403, 409].includes(error.status) &&
						!error.storeIdPresent
					) {
						delete journal.storeCreateIntent;
						save();
					}
					throw error;
				}
			}
			const storeApiId = apiStoreId(storeId);
			storeId = normalizeStoreId(storeId);
			if (journal.storeId && normalizeStoreId(journal.storeId) !== storeId)
				throw new ReportRetargetError(
					2,
					"store identity differs from the retarget journal; use a new target project",
				);
			journal.storeId = storeId;
			journal.storeApiId = storeApiId;
			delete journal.storeCreateIntent;
			save();
			let details = await api.getStore(storeApiId);
			const validateStore = () => {
				if (
					details.id !== storeId ||
					details.access !== "private" ||
					details.status !== "available" ||
					details.usageQuotaExceeded ||
					!Number.isSafeInteger(details.count) ||
					details.count < 0
				)
					throw new Error(
						"target store must be private, available and below quota",
					);
				if (
					!options.storeId &&
					details.name !== (options.storeName ?? journal.storeName)
				)
					throw new Error(
						"target store name does not match the requested store",
					);
			};
			validateStore();
			journal.storeName = details.name;
			journal.blobHost = `${storeId}.private.blob.vercel-storage.com`;
			save();
			log("done", `store=${storeId}`);
			step = "connect";
			let connected =
				env?.storeId === storeId &&
				details.projectsMetadata.some((item) => item.projectId === project.id);
			if (!connected) {
				await api.connectStore({ storeId: storeApiId, projectId: project.id });
				env = await api.findProjectBlobEnv(project.id);
				details = await api.getStore(storeApiId);
				validateStore();
				connected =
					env?.storeId === storeId &&
					details.projectsMetadata.some(
						(item) => item.projectId === project.id,
					);
				if (!connected)
					throw new Error("store connection could not be verified");
				log("done");
			} else log("skipped");
			journal.connected = true;
			save();
			step = "token";
			const token =
				options.blobToken ??
				(await api.decryptProjectEnv(project.id, env!.envId));
			redactor.add(token, "blob");
			if (blobStoreIdFromToken(token) !== storeId)
				throw new Error("Blob credential does not match target store");
			const bound = (options.blobStore ?? new VercelBlobReportStore()).bind({
				key: "BLOB_READ_WRITE_TOKEN",
				value: token,
				source: "process",
				generation: 0,
			});
			log("done");
			step = "handoff";
			const secretsFile =
				options.blobToken === undefined
					? writeReportHostingSecrets({
							reportsDir: options.reportsDir,
							projectName,
							storeId,
							token,
							redactor,
						})
					: null;
			log(
				secretsFile ? "done" : "skipped",
				secretsFile ?? "operator environment",
			);
			step = "gateway-env";
			await (options.verifyGatewayEnvironment ?? assertGatewayBlobEnvironment)(
				options.vercelToken,
				projectName,
			);
			log("done");
			let uploaded = 0;
			let reuploaded = 0;
			let skipped = 0;
			for (pass = 1; pass <= 3; pass++) {
				step = "upload";
				const snapshot = await registry.withLock(async () =>
					registry.retainedSnapshot(),
				);
				const changed: typeof snapshot.reports = [];
				for (const entry of snapshot.reports) {
					const previous = journal.uploaded[entry.token];
					if (
						previous?.createdAt === entry.createdAt &&
						previous.bytes === entry.bytes &&
						previous.sha256 === entry.sha256
					) {
						skipped++;
						continue;
					}
					const result = await bound.putMigratedReport(
						entry.token,
						entry.html,
						{ gzip: true },
					);
					const url = new URL(result.url);
					if (url.protocol !== "https:" || url.hostname !== journal.blobHost)
						throw new Error("uploaded report store identity mismatch");
					if (previous) reuploaded++;
					else uploaded++;
					journal.uploaded[entry.token] = {
						createdAt: entry.createdAt,
						bytes: entry.bytes,
						sha256: entry.sha256,
					};
					changed.push(entry);
					if ((uploaded + reuploaded) % 25 === 0) save();
				}
				save();
				log(changed.length ? "done" : "skipped", `changed=${changed.length}`);
				step = "gateway";
				if (
					!journal.gatewayDeploymentId ||
					journal.manifestDigest !== snapshot.manifestDigest
				) {
					const deployment = await (
						options.deployGateway ?? deployFilesToVercel
					)(
						options.vercelToken,
						projectName,
						files(
							Object.fromEntries(
								snapshot.reports
									.filter((entry) => !entry.mutable)
									.map((entry) => [entry.token, entry.createdAt]),
							),
						),
						5 * 60 * 1000,
					);
					journal.gatewayDeploymentId = deployment.deploymentId;
					journal.manifestDigest = snapshot.manifestDigest;
					save();
					log("done");
				} else log("skipped");
				step = "verify";
				const deploymentId = journal.gatewayDeploymentId;
				if (
					journal.verified?.manifestDigest !== snapshot.manifestDigest ||
					journal.verified.contentDigest !== snapshot.contentDigest ||
					journal.verified.deploymentId !== deploymentId
				) {
					await (options.probeGateway ?? probeGatewayFormats)({
						bound,
						projectName,
						request: options.request,
					});
					const newest = (entries: typeof snapshot.reports, n: number) =>
						[...entries]
							.sort(
								(a, b) =>
									b.createdAt.localeCompare(a.createdAt) ||
									a.token.localeCompare(b.token),
							)
							.slice(0, n);
					const tokens = [
						...new Set(
							[...newest(changed, 10), ...newest(snapshot.reports, 3)].map(
								(entry) => entry.token,
							),
						),
					];
					const request = options.request ?? requestGateway;
					for (const reportToken of tokens) {
						const response = await request(
							`https://${projectName}.vercel.app/r/${reportToken}/`,
							{ headers: { "Accept-Encoding": "gzip" } },
						);
						if (
							response.status !== 200 ||
							!response.headers.get("content-security-policy") ||
							!response.headers.get("content-type")?.startsWith("text/html") ||
							response.headers.get("content-encoding") !== "gzip"
						)
							throw new Error(
								`retained report verification failed token=${reportToken.slice(0, 8)}`,
							);
					}
					if (
						(
							await request(
								`https://${projectName}.vercel.app/r/${"0".repeat(32)}/`,
							)
						).status !== 404
					)
						throw new Error("fake report token did not return 404");
					journal.verified = {
						manifestDigest: snapshot.manifestDigest,
						contentDigest: snapshot.contentDigest,
						deploymentId,
						tokens,
						at: timestamp(),
					};
					save();
					log("done", `verified=${tokens.length} changed=${changed.length}`);
				} else log("skipped");
				step = "marker";
				try {
					const committed = await registry.commitRetarget({
						expectedSourceHostingKey: source.hostingKey,
						expectedManifestDigest: snapshot.manifestDigest,
						expectedContentDigest: snapshot.contentDigest,
						vercelProjectName: projectName,
						hosting: {
							provider: "vercel-blob",
							gatewayDeploymentId: deploymentId,
							storeId,
							storeApiId,
							blobHost: journal.blobHost,
							gatewayFormat: "gzip-v1",
							manifestDigest: snapshot.manifestDigest,
							contentDigest: snapshot.contentDigest,
							retargetedFrom: journal.retargetedFrom,
						},
						now,
					});
					journal.cutoverAt = committed.cutoverAt;
					journal.contentDigest = snapshot.contentDigest;
					save();
					log(committed.written ? "done" : "skipped");
					return {
						project: projectName,
						projectId: project.id,
						storeId,
						blobHost: journal.blobHost!,
						gatewayDeploymentId: deploymentId,
						manifestDigest: snapshot.manifestDigest,
						contentDigest: snapshot.contentDigest,
						passes: pass,
						uploaded,
						reuploaded,
						skipped,
						verified: journal.verified!.tokens.map((value) =>
							value.slice(0, 8),
						),
						secretsFile,
						envHint: [
							`REPORT_HOSTING_VERCEL_TOKEN ← $${options.vercelTokenEnv}`,
							`BLOB_READ_WRITE_TOKEN ← ${secretsFile ?? `$${options.blobTokenEnv ?? "BLOB_READ_WRITE_TOKEN_NEXT"}`}`,
						],
					};
				} catch (error) {
					if (error instanceof ReportRetargetManifestStale) {
						if (pass < 3) {
							log("failed", "registry changed; retrying retained snapshot");
							continue;
						}
						throw new ReportRetargetError(
							1,
							"registry continues changing; retry later",
						);
					}
					if (error instanceof ReportHostingBindingConflict)
						throw new ReportRetargetError(
							1,
							"source hosting was changed by another mutation",
						);
					throw error;
				}
			}
			throw new ReportRetargetError(1, "retarget did not converge");
		});
	} catch (error) {
		log("failed", error instanceof Error ? error.message : "unknown failure");
		if (error instanceof EnvNotDecryptable)
			throw new ReportRetargetError(
				3,
				"copy the production BLOB_READ_WRITE_TOKEN from the Vercel dashboard, export BLOB_READ_WRITE_TOKEN_NEXT, then retry with --blob-token-env BLOB_READ_WRITE_TOKEN_NEXT",
			);
		throw new ReportRetargetError(
			error instanceof ReportRetargetError
				? error.exitCode
				: error instanceof ReportRegistryLockBusy
					? 2
					: 1,
			redactor.redact(
				error instanceof Error ? error.message : "retarget failed",
			),
		);
	}
}
