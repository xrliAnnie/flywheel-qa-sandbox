import { execFile } from "node:child_process";
import {
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { computeCodexHomeInventoryDigest } from "flywheel-claude-runner";
import { installSqlTiming } from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { CodexQuotaManualReason } from "./availability.js";
import { findRegisteredCodexCredentialLeadTargets } from "./credential-home-roster.js";
import {
	createDesktopCodexVerifier,
	DESKTOP_CODEX_PATH,
} from "./desktop-codex-identity.js";
import {
	type CodexProcessSnapshot,
	captureCodexProcessSnapshot,
	parseCodexProcessSnapshot,
} from "./host-process-snapshot.js";
import type { CodexQuotaHomeObservation } from "./readiness.js";
import {
	parseSqliteUtcTimestamp,
	StaleRunningTracker,
} from "./stale-running-tracker.js";

const execFileAsync = promisify(execFile);
export interface CodexQuotaHostCollectorOptions {
	homesRoot: string;
	canonicalHome: string;
	commRoot: string;
	projectNames: readonly string[];
	approvedManifestPath: string;
	leadTargets: readonly { projectName: string; leadId: string }[];
	leadAuthorityScript: string;
	/** FLY-2869: args + authoritative (ucomm/argv/env) + args snapshots. */
	processSnapshot?: () => Promise<CodexProcessSnapshot>;
	/** FLY-2869: verifiable ChatGPT desktop codex identity (founder ruling). */
	verifyDesktopCodex?: (pid: number, argv0: string) => Promise<boolean>;
	/** FLY-2869: where 529 test slots live; defaults to /private/tmp. */
	testSlotRoot?: string;
	now?: () => number;
	monotonicNow?: () => number;
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
	/**
	 * FLY-2869: "info" records a verified exclusion (desktop codex, test slot,
	 * archive dir, pending pre-registration, terminal residue, stale running
	 * row). It never blocks readiness; it keeps the exclusion visible.
	 */
	scope: "global" | "registered" | "all" | "info";
	home?: string;
	executionId?: string;
	pid?: number;
	startedAt?: string;
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

function realpathOrNull(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}
/**
 * Where a symlink points once resolved. A slot being rebuilt leaves the link
 * dangling for a moment; its target is then the realpath of the deepest
 * existing ancestor joined with the missing rest (symlinks in the existing
 * part are still resolved, so an escape through them is still seen).
 */
function linkTarget(link: string): string | null {
	const resolved = realpathOrNull(link);
	if (resolved !== null) return resolved;
	let missing: string[] = [];
	let cursor: string;
	try {
		cursor = resolve(dirname(link), readlinkSync(link));
	} catch {
		return null;
	}
	for (;;) {
		const existing = realpathOrNull(cursor);
		if (existing !== null) return join(existing, ...missing);
		const parent = dirname(cursor);
		if (parent === cursor) return null;
		missing = [basename(cursor), ...missing];
		cursor = parent;
	}
}
/** FLY-2869: a 529 QA slot's private state never counts for production. */
export function isTestSlotPath(
	realPath: string | null,
	slotRoot: string,
): boolean {
	if (realPath === null) return false;
	const prefix = `${slotRoot.replace(/\/+$/, "")}/flywheel-test-slot-`;
	if (!realPath.startsWith(prefix)) return false;
	return /^\d+(\/|$)/.test(realPath.slice(prefix.length));
}
const STALE_RUNNING_MIN_AGE_MS = 15 * 60_000;
/** CommDB's terminal statuses; anything else (NULL, unknown) stays live. */
const TERMINAL_SESSION_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"timeout",
	"blocked",
	"failed",
]);

export function createCodexQuotaHostCollector(
	options: CodexQuotaHostCollectorOptions,
): () => Promise<CodexQuotaHostInventory> {
	const staleRunning = new StaleRunningTracker();
	const verifyDesktopCodex =
		options.verifyDesktopCodex ?? createDesktopCodexVerifier();
	const now = options.now ?? Date.now;
	const monotonicNow = options.monotonicNow ?? (() => performance.now());
	const slotRoot = options.testSlotRoot ?? "/private/tmp";
	return async () => {
		const round = staleRunning.begin(monotonicNow());
		let committed = false;
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
			const registeredProjects = new Set(options.projectNames);
			const projects = new Set(options.projectNames);
			for (const entry of readdirSync(options.commRoot, {
				withFileTypes: true,
			})) {
				if (entry.isSymbolicLink()) {
					// FLY-2869 ①: a 529 slot links its private comm shard here.
					if (
						isTestSlotPath(
							linkTarget(join(options.commRoot, entry.name)),
							slotRoot,
						)
					) {
						diagnostics.push({
							reason: "test_slot_comm_shard_skipped",
							scope: "info",
						});
						continue;
					}
					throw new Error("comm_shard_unsafe");
				}
				if (entry.isDirectory()) projects.add(entry.name);
			}
			if (!projects.size) throw new Error("comm_authority_missing");
			type CommRow = {
				id: string;
				status: string;
				startedAt: string | null;
				database: string;
			};
			const commRows: CommRow[] = [];
			const databases: string[] = [];
			for (const project of projects) {
				if (!safeId(project)) throw new Error("project_invalid");
				const path = join(options.commRoot, project, "comm.db");
				if (!registeredProjects.has(project)) {
					// FLY-2869 ②: an unregistered directory without a database (an
					// archive) holds no sessions; a registered project must have one.
					try {
						lstatSync(path);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") {
							diagnostics.push({
								reason: "unregistered_comm_dir_skipped",
								scope: "info",
								home: join(options.commRoot, project),
							});
							continue;
						}
						throw error;
					}
				}
				databases.push(path);
			}
			const legacyRoot = join(dirname(options.commRoot), "comm.db");
			try {
				plainFile(legacyRoot);
				databases.push(legacyRoot);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			for (const path of databases) {
				plainFile(path);
				const database = realpathSync(path);
				const db = installSqlTiming(
					new Database(path, {
						readonly: true,
						fileMustExist: true,
						timeout: 1000,
					}),
					"teamlead",
				);
				try {
					// FLY-2869: the legacy root comm.db predates phase_keep_alive (and a
					// database may predate tmux_window/started_at); read what exists
					// rather than failing the whole census. Identity columns are required.
					const columns = new Set(
						(
							db.prepare("PRAGMA table_info(sessions)").all() as {
								name: string;
							}[]
						).map((column) => column.name),
					);
					if (
						!["execution_id", "vendor", "status"].every((c) => columns.has(c))
					)
						throw new Error("comm_identity_unknown");
					const optional = (name: "tmux_window" | "started_at") =>
						columns.has(name) ? name : `NULL AS ${name}`;
					const rows = db
						.prepare(
							`SELECT execution_id,vendor,status,${optional("tmux_window")},${optional("started_at")} FROM sessions WHERE ${
								columns.has("phase_keep_alive")
									? "status='running' OR phase_keep_alive=1"
									: "status='running'"
							}`,
						)
						.all() as {
						execution_id: string;
						vendor: string | null;
						status: string | null;
						tmux_window: string | null;
						started_at: string | null;
					}[];
					for (const row of rows) {
						if (!safeId(row.execution_id))
							throw new Error("comm_identity_unknown");
						if (!row.vendor) {
							// FLY-2869 ③: a Bridge pre-registration the runner never took
							// over (vendor is written by the runner's own registration).
							if (
								typeof row.tmux_window === "string" &&
								row.tmux_window.endsWith(":pending")
							) {
								diagnostics.push({
									reason: "pending_preregistration_skipped",
									scope: "info",
									executionId: row.execution_id,
								});
								continue;
							}
							throw new Error("comm_identity_unknown");
						}
						if (row.vendor === "codex")
							commRows.push({
								id: row.execution_id,
								status: String(row.status),
								startedAt: row.started_at,
								database,
							});
					}
				} finally {
					db.close();
				}
			}
			const processes = parseCodexProcessSnapshot(
				await (options.processSnapshot ?? captureCodexProcessSnapshot)(),
			);
			for (const reader of processes.unattributed) {
				unattributedReaders.push(reader);
				diagnostics.push({ reason: "process_home_unknown", scope: "global" });
			}
			const active = new Map<string, ProcessObservation[]>();
			const liveExecutionIds = new Set<string>();
			const canonicalReal = realpathOrNull(options.canonicalHome);
			for (const process of processes.codex) {
				if (process.executionId) liveExecutionIds.add(process.executionId);
				const unknown = () => {
					unattributedReaders.push({
						pid: process.pid,
						startIdentity: process.startIdentity,
						executable: process.argv0,
						reason: "process_home_unknown",
					});
					diagnostics.push({ reason: "process_home_unknown", scope: "global" });
				};
				let home = process.codexHome;
				if (home === null) {
					// FLY-2869 ⑤: the ChatGPT desktop app's own codex, by verified identity.
					if (
						process.argv0 === DESKTOP_CODEX_PATH &&
						(await verifyDesktopCodex(process.pid, process.argv0))
					) {
						diagnostics.push({
							reason: "desktop_codex_excluded",
							scope: "info",
							pid: process.pid,
						});
						continue;
					}
					// A codex without CODEX_HOME reads $HOME/.codex; it counts as the
					// canonical reader only when that resolves to canonical exactly.
					if (
						process.home !== null &&
						isAbsolute(process.home) &&
						canonicalReal !== null &&
						realpathOrNull(join(process.home, ".codex")) === canonicalReal
					)
						home = options.canonicalHome;
					else {
						unknown();
						continue;
					}
				}
				if (!isAbsolute(home)) {
					unknown();
					continue;
				}
				// FLY-2869 ⑥: a 529 slot's Codex home is not production.
				const homeReal = realpathOrNull(home);
				if (isTestSlotPath(homeReal, slotRoot)) {
					diagnostics.push({
						reason: "test_slot_home_excluded",
						scope: "info",
						home: homeReal!,
					});
					continue;
				}
				if (home !== options.canonicalHome && !approved.has(home)) {
					diagnostics.push({
						reason: "unapproved_live_home",
						scope: "registered",
						home,
					});
					continue;
				}
				const observations = active.get(home) ?? [];
				observations.push({
					pid: process.pid,
					startIdentity: process.startIdentity,
					executable: process.argv0,
					...(process.executionId ? { executionId: process.executionId } : {}),
				});
				active.set(home, observations);
			}
			const leasesByHome = new Map<string, string[]>();
			const leaseIds = new Set<string>();
			for (const [home] of approved) {
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
				leasesByHome.set(home, leases);
				for (const id of leases) leaseIds.add(id);
			}
			// FLY-2869 ④: a terminal row is a live execution only while a process or
			// a lease still backs it (a parked holder); otherwise it is residue.
			// Only the four CommDB terminal statuses can be residue; NULL or any
			// other status is a live execution that can never be exempted. Every
			// row that makes an id live is kept (the same id may appear in several
			// databases), so one old row cannot stand in for a newer one.
			const comm = new Set<string>();
			const liveRows = new Map<string, CommRow[]>();
			for (const row of commRows) {
				const live =
					row.status === "running" ||
					!TERMINAL_SESSION_STATUSES.has(row.status) ||
					liveExecutionIds.has(row.id) ||
					leaseIds.has(row.id);
				if (!live) {
					diagnostics.push({
						reason: "terminal_session_residue",
						scope: "info",
						executionId: row.id,
					});
					continue;
				}
				comm.add(row.id);
				liveRows.set(row.id, [...(liveRows.get(row.id) ?? []), row]);
			}
			const matched = new Set<string>();
			for (const [home, ownership] of approved) {
				const leases = leasesByHome.get(home) ?? [];
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
						// FLY-2869 ⑨: a Codex execution is its daemon plus its client
						// (`codex resume --remote`), so identity is the execution id carried
						// by every process, not the process count.
						const everyProcessKeyed = processes.every(
							(process) => !!process.executionId,
						);
						if (
							!leases.length &&
							dirname(home) === options.homesRoot &&
							everyProcessKeyed &&
							processExecutions.size === 1 &&
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
							!everyProcessKeyed ||
							processExecutions.size !== new Set(leases).size ||
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
			// FLY-2869 Q3: a running row with no process and no lease anywhere, old
			// enough, and absent across consecutive complete collections for 60 s.
			const staleKey = (row: CommRow) =>
				`${row.database}\0${row.id}\0${row.startedAt}`;
			const nowMs = now();
			const candidates = new Set<string>();
			for (const id of comm) {
				if (matched.has(id)) continue;
				for (const row of liveRows.get(id) ?? []) {
					const startedMs = parseSqliteUtcTimestamp(row.startedAt);
					if (
						row.status === "running" &&
						startedMs !== null &&
						startedMs < nowMs - STALE_RUNNING_MIN_AGE_MS &&
						!liveExecutionIds.has(id) &&
						!leaseIds.has(id)
					)
						candidates.add(staleKey(row));
				}
			}
			const matured = staleRunning.commit(round, candidates, monotonicNow());
			committed = true;
			for (const id of comm) {
				if (matched.has(id)) continue;
				const rows = liveRows.get(id) ?? [];
				if (
					rows.length > 0 &&
					rows.every(
						(row) => row.status === "running" && matured.has(staleKey(row)),
					)
				) {
					for (const row of rows)
						diagnostics.push({
							reason: "comm_stale_running",
							scope: "info",
							executionId: id,
							...(row.startedAt ? { startedAt: row.startedAt } : {}),
						});
					continue;
				}
				diagnostics.push({
					reason: "comm_orphan",
					scope: "registered",
					executionId: id,
				});
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
			if (!committed) staleRunning.fail(round);
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
