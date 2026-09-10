import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
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
	homes: CodexQuotaHomeObservation[];
	activeUnsharedAccountKeys: string[];
	canonicalChainActive: boolean;
}
export function createCodexQuotaHostCollector(
	options: CodexQuotaHostCollectorOptions,
): () => Promise<CodexQuotaHostInventory> {
	return async () => {
		const homes: CodexQuotaHomeObservation[] = [];
		const activeUnsharedAccountKeys: string[] = [];
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
			plainFile(options.approvedManifestPath);
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
			const inventory = manifest.homes
				.map(({ home, ownership }: { home: string; ownership: string }) => ({
					home,
					ownership,
				}))
				.sort((a: { home: string }, b: { home: string }) =>
					a.home.localeCompare(b.home),
				);
			if (
				manifest.inventoryDigest !==
				createHash("sha256").update(JSON.stringify(inventory)).digest("hex")
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
				const db = new Database(path, {
					readonly: true,
					fileMustExist: true,
					timeout: 1000,
				});
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
						await execFileAsync("/bin/ps", ["eww", "-axo", "pid=,command="], {
							timeout: 3000,
							maxBuffer: 16 * 1024 * 1024,
							encoding: "utf8",
						})
					).stdout;
			if (
				typeof output !== "string" ||
				!output.trim() ||
				output.length > 16 * 1024 * 1024
			)
				throw new Error("process_authority_invalid");
			const active = new Map<string, Set<string>>();
			for (const line of output.split("\n")) {
				if (!line.trim()) continue;
				if (!/^\s*\d+\s+/.test(line))
					throw new Error("process_authority_invalid");
				const isCodex = /(?:^|\s)(?:\S*\/)?codex(?:\s|$)/.test(line);
				const homeMatch = [...line.matchAll(/(?:^|\s)CODEX_HOME=([^\s]+)/g)];
				if (!isCodex) continue;
				if (homeMatch.length !== 1 || !isAbsolute(homeMatch[0]![1]!))
					throw new Error("process_home_unknown");
				const home = homeMatch[0]![1]!;
				if (home !== options.canonicalHome && !approved.has(home))
					throw new Error("unapproved_live_home");
				const ids = [
					...line.matchAll(/(?:^|\s)FLYWHEEL_EXEC_ID=([A-Za-z0-9_.-]+)/g),
				];
				if (ids.length > 1) throw new Error("process_execution_ambiguous");
				const set = active.get(home) ?? new Set<string>();
				if (ids[0]) set.add(ids[0][1]!);
				active.set(home, set);
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
				if (processes) {
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
						if (
							!leases.length &&
							dirname(home) === options.homesRoot &&
							processes.size === 1 &&
							processes.has(basename(home)) &&
							comm.has(basename(home))
						)
							matched.add(basename(home));
						else if (
							!leases.length ||
							processes.size !== leases.length ||
							leases.some((id) => !comm.has(id) || !processes.has(id))
						)
							activity = "unknown";
						else for (const id of leases) matched.add(id);
					}
				} else if (leases.length) activity = "unknown";
				homes.push({ home, ownership, activity });
			}
			for (const id of comm)
				if (!matched.has(id))
					return {
						complete: false,
						homes,
						activeUnsharedAccountKeys,
						canonicalChainActive: true,
					};
			return {
				complete: homes.every((home) => home.activity !== "unknown"),
				homes,
				activeUnsharedAccountKeys,
				canonicalChainActive:
					active.has(options.canonicalHome) ||
					homes.some(
						(home) =>
							home.ownership === "managed" && home.activity === "active",
					),
			};
		} catch {
			return {
				complete: false,
				homes,
				activeUnsharedAccountKeys,
				canonicalChainActive: true,
			};
		}
	};
}
