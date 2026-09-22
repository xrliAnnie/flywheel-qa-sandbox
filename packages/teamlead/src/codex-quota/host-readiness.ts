import { execFile } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { computeCodexHomeInventoryDigest } from "flywheel-claude-runner";
import { installSqlTiming } from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { CodexQuotaManualReason } from "./availability.js";
import { findRegisteredCodexCredentialLeadTargets } from "./credential-home-roster.js";
import type { CodexQuotaHomeObservation } from "./readiness.js";

const execFileAsync = promisify(execFile);
export interface CodexQuotaHostCollectorOptions {
	homesRoot: string;
	canonicalHome: string;
	commRoot: string;
	projectNames: readonly string[];
	approvedManifestPath: string;
	leadTargets: readonly { projectName: string; leadId: string }[];
	leadAuthorityScript: string;
	processSnapshot?: () => Promise<string>;
	credentialIdentity?: (
		home: string,
	) => Promise<{ accountKey: string; chainKey: string }>;
	residentEvidence?: (input: {
		executionId: string;
		home: string;
		project: string;
		role: string;
		process: { pid: number; startIdentity: string };
		commPresent: boolean;
	}) => Promise<{ verified: boolean; reason: string }>;
}

export function createRegisteredCodexQuotaHostCollectorOptions(
	projects: ReadonlyArray<ProjectEntry>,
	options: Omit<CodexQuotaHostCollectorOptions, "leadTargets">,
): CodexQuotaHostCollectorOptions {
	return {
		...options,
		leadTargets: findRegisteredCodexCredentialLeadTargets(projects),
	};
}
function plainFile(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink())
		throw new Error("authority_not_plain_file");
}
function plainDirectory(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error("authority_not_plain_directory");
}
const safeId = (value: unknown): value is string =>
	typeof value === "string" &&
	/^[A-Za-z0-9_.-]{1,160}$/.test(value) &&
	value !== "." &&
	value !== "..";
/** Collect freshly on every call. A lease or registration alone is never liveness. */
export interface CodexQuotaHostInventory {
	complete: boolean;
	registeredComplete: boolean;
	inventoryDigest?: string;
	buildSha?: string;
	homes: CodexQuotaHomeObservation[];
	activeUnsharedAccountKeys: string[];
	canonicalChainActive: boolean;
	diagnostics: CodexQuotaHostDiagnostic[];
	unattributedReaders: CodexQuotaUnattributedReader[];
	failureReasons?: CodexQuotaManualReason[];
}

export interface CodexQuotaHostDiagnostic {
	reason: string;
	scope: "global" | "registered" | "all";
	home?: string;
	executionId?: string;
}

export interface CodexQuotaUnattributedReader {
	pid: number;
	startIdentity: string | null;
	executable: string;
	reason: "process_home_unknown" | "process_execution_ambiguous";
}

interface ProcessObservation {
	pid: number;
	startIdentity: string | null;
	executable: string;
	executionId?: string;
}

const LSTART_RE =
	/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

function parseProcessLine(line: string): {
	pid: number;
	startIdentity: string | null;
	command: string;
} | null {
	const match = /^\s*(\d+)\s+(.+)$/.exec(line);
	if (!match) return null;
	const pid = Number(match[1]);
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	const remainder = match[2]!;
	const tokens = remainder.split(/\s+/);
	const possibleStart = tokens.slice(0, 5).join(" ");
	if (tokens.length > 5 && LSTART_RE.test(possibleStart)) {
		return {
			pid,
			startIdentity: possibleStart,
			command: tokens.slice(5).join(" "),
		};
	}
	return { pid, startIdentity: null, command: remainder };
}
export function createCodexQuotaHostCollector(
	options: CodexQuotaHostCollectorOptions,
): () => Promise<CodexQuotaHostInventory> {
	return async () => {
		const homes: CodexQuotaHomeObservation[] = [];
		const activeUnsharedAccountKeys: string[] = [];
		const diagnostics: CodexQuotaHostDiagnostic[] = [];
		const unattributedReaders: CodexQuotaUnattributedReader[] = [];
		let inventoryDigest: string | undefined;
		let buildSha: string | undefined;
		try {
			for (const path of [
				options.homesRoot,
				options.canonicalHome,
				options.commRoot,
				options.approvedManifestPath,
				options.leadAuthorityScript,
			])
				if (!isAbsolute(path))
					throw new Error("authority_absolute_paths_required");
			plainDirectory(options.homesRoot);
			plainDirectory(options.commRoot);
			try {
				plainFile(options.approvedManifestPath);
			} catch (error) {
				if (
					(error as NodeJS.ErrnoException).code === "ENOENT" &&
					(error as NodeJS.ErrnoException).path === options.approvedManifestPath
				)
					throw new Error("readiness_receipt_missing");
				throw new Error("readiness_receipt_invalid");
			}
			if (lstatSync(options.approvedManifestPath).size > 1024 * 1024)
				throw new Error("manifest_too_large");
			const manifest = JSON.parse(
				readFileSync(options.approvedManifestPath, "utf8"),
			);
			if (
				manifest?.schemaVersion !== 1 ||
				!/^[a-f0-9]{40}$/.test(manifest.buildSha) ||
				!Array.isArray(manifest.homes) ||
				!manifest.homes.length ||
				manifest.homes.length > 5000
			)
				throw new Error("manifest_invalid");
			inventoryDigest = manifest.inventoryDigest;
			buildSha = manifest.buildSha;
			const inventory = manifest.homes.map(
				({ home, ownership }: { home: string; ownership: string }) => ({
					home,
					ownership,
				}),
			) as Array<{
				home: string;
				ownership: "managed" | "independent";
			}>;
			if (
				manifest.inventoryDigest !== computeCodexHomeInventoryDigest(inventory)
			)
				throw new Error("manifest_digest_invalid");
			const approved = new Map<string, "managed" | "independent">();
			for (const entry of manifest.homes) {
				if (
					typeof entry?.home !== "string" ||
					!isAbsolute(entry.home) ||
					resolve(entry.home) !== entry.home ||
					!["managed", "independent"].includes(entry.ownership) ||
					approved.has(entry.home)
				)
					throw new Error("manifest_invalid");
				if (
					!Number.isFinite(Date.parse(entry.checkedAt)) ||
					entry.credentialShared !== (entry.ownership === "managed")
				)
					throw new Error("home_receipt_invalid");
				approved.set(entry.home, entry.ownership);
				plainDirectory(entry.home);
			}
			let scanned = 0;
			const scan = (directory: string, depth: number): void => {
				if (++scanned > 20000 || depth > 5)
					throw new Error("home_inventory_unbounded");
				plainDirectory(directory);
				const entries = readdirSync(directory, { withFileTypes: true });
				const leases = entries.find(
					(entry) => entry.name === ".flywheel-leases",
				);
				if (leases) {
					plainDirectory(join(directory, leases.name));
					if (
						!approved.has(directory) &&
						readdirSync(join(directory, leases.name)).length
					)
						throw new Error("unapproved_lease_home");
				}
				if (
					approved.has(directory) ||
					entries.some(
						(entry) =>
							entry.name === "auth.json" ||
							entry.name === ".flywheel-agent-home.json",
					) ||
					leases
				)
					return;
				for (const entry of entries) {
					if (entry.isSymbolicLink()) throw new Error("home_inventory_symlink");
					if (entry.isDirectory() && !entry.name.startsWith("."))
						scan(join(directory, entry.name), depth + 1);
				}
			};
			scan(options.homesRoot, 0);
			const leadHomes = new Set<string>();
			for (const target of options.leadTargets) {
				if (!safeId(target.projectName) || !safeId(target.leadId))
					throw new Error("lead_identity_invalid");
				const { stdout } = await execFileAsync(
					options.leadAuthorityScript,
					[
						"--project",
						target.projectName,
						"--lead",
						target.leadId,
						"--authority",
					],
					{ timeout: 10000, maxBuffer: 65536, encoding: "utf8" },
				);
				const lead = JSON.parse(stdout);
				if (!approved.has(lead.codexHome))
					throw new Error("lead_home_not_approved");
				leadHomes.add(lead.codexHome);
			}
			const projects = new Set(options.projectNames);
			for (const entry of readdirSync(options.commRoot, {
				withFileTypes: true,
			})) {
				if (entry.isSymbolicLink()) throw new Error("comm_shard_unsafe");
				if (entry.isDirectory()) projects.add(entry.name);
			}
			if (!projects.size) throw new Error("comm_authority_missing");
			const comm = new Set<string>();
			const databases = [...projects].map((project) => {
				if (!safeId(project)) throw new Error("project_invalid");
				return join(options.commRoot, project, "comm.db");
			});
			const legacyRoot = join(dirname(options.commRoot), "comm.db");
			try {
				plainFile(legacyRoot);
				databases.push(legacyRoot);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			for (const path of databases) {
				plainFile(path);
				const db = installSqlTiming(
					new Database(path, {
						readonly: true,
						fileMustExist: true,
						timeout: 1000,
					}),
					"teamlead",
				);
				try {
					const rows = db
						.prepare(
							"SELECT execution_id,vendor FROM sessions WHERE status='running' OR phase_keep_alive=1",
						)
						.all() as { execution_id: string; vendor: string | null }[];
					for (const row of rows) {
						if (!safeId(row.execution_id) || !row.vendor)
							throw new Error("comm_identity_unknown");
						if (row.vendor === "codex") comm.add(row.execution_id);
					}
				} finally {
					db.close();
				}
			}
			const output = options.processSnapshot
				? await options.processSnapshot()
				: (
						await execFileAsync(
							"/bin/ps",
							["eww", "-axo", "pid=,lstart=,command="],
							{
								timeout: 3000,
								maxBuffer: 16 * 1024 * 1024,
								encoding: "utf8",
							},
						)
					).stdout;
			if (
				typeof output !== "string" ||
				!output.trim() ||
				output.length > 16 * 1024 * 1024
			)
				throw new Error("process_authority_invalid");
			const active = new Map<string, ProcessObservation[]>();
			for (const line of output.split("\n")) {
				if (!line.trim()) continue;
				const parsed = parseProcessLine(line);
				if (!parsed) throw new Error("process_authority_invalid");
				const isCodex = /(?:^|\s)(?:\S*\/)?codex(?:\s|$)/.test(parsed.command);
				if (!isCodex) continue;
				const executable =
					/(?:^|\s)((?:\S*\/)?codex)(?:\s|$)/.exec(parsed.command)?.[1] ??
					"codex";
				const homeMatch = [
					...parsed.command.matchAll(/(?:^|\s)CODEX_HOME=([^\s]+)/g),
				];
				if (homeMatch.length !== 1 || !isAbsolute(homeMatch[0]![1]!)) {
					unattributedReaders.push({
						pid: parsed.pid,
						startIdentity: parsed.startIdentity,
						executable,
						reason: "process_home_unknown",
					});
					diagnostics.push({ reason: "process_home_unknown", scope: "global" });
					continue;
				}
				const home = homeMatch[0]![1]!;
				if (home !== options.canonicalHome && !approved.has(home)) {
					diagnostics.push({
						reason: "unapproved_live_home",
						scope: "registered",
						home,
					});
					continue;
				}
				const ids = [
					...parsed.command.matchAll(
						/(?:^|\s)FLYWHEEL_EXEC_ID=([A-Za-z0-9_.-]+)/g,
					),
				];
				if (ids.length > 1) {
					unattributedReaders.push({
						pid: parsed.pid,
						startIdentity: parsed.startIdentity,
						executable,
						reason: "process_execution_ambiguous",
					});
					diagnostics.push({
						reason: "process_execution_ambiguous",
						scope: "registered",
						home,
					});
					continue;
				}
				const observations = active.get(home) ?? [];
				observations.push({
					pid: parsed.pid,
					startIdentity: parsed.startIdentity,
					executable,
					...(ids[0] ? { executionId: ids[0][1]! } : {}),
				});
				active.set(home, observations);
			}
			const matched = new Set<string>();
			for (const [home, ownership] of approved) {
				let leases: string[] = [];
				const leaseRoot = join(home, ".flywheel-leases");
				try {
					plainDirectory(leaseRoot);
					leases = readdirSync(leaseRoot);
					for (const id of leases) {
						if (!safeId(id)) throw new Error("lease_unknown");
						plainFile(join(leaseRoot, id));
						if (
							!/^[a-f0-9]{32}\s*$/.test(
								readFileSync(join(leaseRoot, id), "utf8"),
							)
						)
							throw new Error("lease_invalid");
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				const processes = active.get(home);
				let activity: CodexQuotaHomeObservation["activity"] = "drained";
				if (processes?.length) {
					activity = "active";
					if (ownership === "independent") {
						if (!options.credentialIdentity)
							throw new Error("independent_identity_unknown");
						const canonical = await options.credentialIdentity(
							options.canonicalHome,
						);
						const identity = await options.credentialIdentity(home);
						if (
							!safeId(canonical.accountKey) ||
							!safeId(canonical.chainKey) ||
							!safeId(identity.accountKey) ||
							!safeId(identity.chainKey)
						)
							throw new Error("independent_identity_unknown");
						if (identity.chainKey === canonical.chainKey) activity = "unknown";
						activeUnsharedAccountKeys.push(identity.accountKey);
					}
					if (
						ownership === "managed" &&
						!leadHomes.has(home) &&
						home !== options.canonicalHome
					) {
						const processExecutions = new Set(
							processes.flatMap((process) =>
								process.executionId ? [process.executionId] : [],
							),
						);
						if (
							!leases.length &&
							dirname(home) === options.homesRoot &&
							processes.length === 1 &&
							processExecutions.has(basename(home)) &&
							comm.has(basename(home))
						)
							matched.add(basename(home));
						else if (!leases.length && options.residentEvidence) {
							let marker: { project: string; role: string } | null = null;
							try {
								const markerPath = join(home, ".flywheel-agent-home.json");
								plainFile(markerPath);
								const parsed = JSON.parse(readFileSync(markerPath, "utf8"));
								if (!safeId(parsed?.project) || !safeId(parsed?.role)) {
									throw new Error("resident_marker_invalid");
								}
								marker = { project: parsed.project, role: parsed.role };
							} catch {
								marker = null;
							}
							let verified = marker !== null;
							const verifiedExecutions = new Set<string>();
							if (marker) {
								for (const process of processes) {
									if (
										!process.executionId ||
										!process.startIdentity ||
										!comm.has(process.executionId)
									) {
										verified = false;
										break;
									}
									const evidence = await options.residentEvidence({
										executionId: process.executionId,
										home,
										project: marker.project,
										role: marker.role,
										process: {
											pid: process.pid,
											startIdentity: process.startIdentity,
										},
										commPresent: true,
									});
									if (!evidence.verified) {
										verified = false;
										diagnostics.push({
											reason: evidence.reason,
											scope: "registered",
											home,
											executionId: process.executionId,
										});
										break;
									}
									verifiedExecutions.add(process.executionId);
								}
							}
							if (verified) {
								for (const id of verifiedExecutions) matched.add(id);
							} else {
								activity = "unknown";
								diagnostics.push({
									reason: "resident_evidence_incomplete",
									scope: "registered",
									home,
								});
							}
						} else if (
							!leases.length ||
							processes.length !== leases.length ||
							leases.some((id) => !comm.has(id) || !processExecutions.has(id))
						)
							activity = "unknown";
						else for (const id of leases) matched.add(id);
					}
				} else if (leases.length) {
					activity = "unknown";
					diagnostics.push({
						reason: "lease_without_process",
						scope: "registered",
						home,
					});
				}
				homes.push({ home, ownership, activity });
			}
			for (const id of comm) {
				if (!matched.has(id)) {
					diagnostics.push({
						reason: "comm_orphan",
						scope: "registered",
						executionId: id,
					});
				}
			}
			const registeredComplete =
				homes.every((home) => home.activity !== "unknown") &&
				!diagnostics.some(
					(diagnostic) =>
						diagnostic.scope === "registered" || diagnostic.scope === "all",
				);
			return {
				complete:
					registeredComplete &&
					!diagnostics.some(
						(diagnostic) =>
							diagnostic.scope === "global" || diagnostic.scope === "all",
					),
				registeredComplete,
				inventoryDigest,
				buildSha,
				homes,
				activeUnsharedAccountKeys,
				diagnostics,
				unattributedReaders,
				canonicalChainActive:
					active.has(options.canonicalHome) ||
					homes.some(
						(home) =>
							home.ownership === "managed" && home.activity === "active",
					),
			};
		} catch (error) {
			const reason =
				error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
					? error.message
					: "collector_failed";
			diagnostics.push({ reason, scope: "all" });
			const message = error instanceof Error ? error.message : "";
			const receiptInvalid = new Set([
				"manifest_too_large",
				"manifest_invalid",
				"manifest_digest_invalid",
				"home_receipt_invalid",
				"readiness_receipt_invalid",
			]);
			return {
				complete: false,
				registeredComplete: false,
				...(inventoryDigest ? { inventoryDigest } : {}),
				...(buildSha ? { buildSha } : {}),
				homes,
				activeUnsharedAccountKeys,
				canonicalChainActive: true,
				diagnostics,
				unattributedReaders,
				failureReasons: [
					message === "readiness_receipt_missing"
						? "readiness_receipt_missing"
						: receiptInvalid.has(message)
							? "readiness_receipt_invalid"
							: "authority_unavailable",
				],
			};
		}
	};
}
