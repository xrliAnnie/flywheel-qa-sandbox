import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectEntry } from "../ProjectConfig.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

export interface CodexCredentialRunnerHomePolicy {
	id: string;
	project: string;
	role: string;
	relativeHome: string;
	pendingAt?: string;
}

export interface CodexCredentialLeadTarget {
	projectName: string;
	leadId: string;
}

export interface CodexCredentialHomeRosterEntry {
	id: string;
	home: string;
	ownership: "managed";
	project?: string;
	role?: string;
	leadTuple?: string;
	pendingAt?: string;
}

export interface ResolveCodexCredentialHomeRosterOptions {
	homeDir: string;
	runnerHomes: readonly CodexCredentialRunnerHomePolicy[];
	resolveLeadAuthority: (
		target: CodexCredentialLeadTarget,
	) => Promise<{ codexHome: string }>;
}

function safeIdentity(value: string): boolean {
	return SAFE_ID.test(value) && value !== "." && value !== "..";
}

function assertPlainDirectoryWithin(homeDir: string, path: string): void {
	if (!isAbsolute(path) || resolve(path) !== path) {
		throw new Error(`credential home is not normalized: ${path}`);
	}
	const rel = relative(homeDir, path);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error(`credential home is outside user home: ${path}`);
	}
	let cursor = homeDir;
	for (const component of rel.split(sep)) {
		cursor = join(cursor, component);
		const stat = lstatSync(cursor);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error(`credential home is unavailable: ${path}`);
		}
	}
}

function assertRunnerMarker(
	home: string,
	policy: CodexCredentialRunnerHomePolicy,
): void {
	const markerPath = join(home, ".flywheel-agent-home.json");
	const stat = lstatSync(markerPath);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
		throw new Error(`runner marker is unsafe: ${policy.id}`);
	}
	const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
		project?: unknown;
		role?: unknown;
	};
	if (marker.project !== policy.project || marker.role !== policy.role) {
		throw new Error(`runner marker identity mismatch: ${policy.id}`);
	}
}

export function findRegisteredCodexCredentialLeadTargets(
	projects: ReadonlyArray<ProjectEntry>,
): CodexCredentialLeadTarget[] {
	const seen = new Set<string>();
	const targets: CodexCredentialLeadTarget[] = [];
	for (const project of projects) {
		if (!safeIdentity(project.projectName)) {
			throw new Error(`invalid project identity: ${project.projectName}`);
		}
		for (const lead of project.leads) {
			if (lead.backend !== "codex-app-server") continue;
			if (!safeIdentity(lead.agentId)) {
				throw new Error(`invalid Lead identity: ${lead.agentId}`);
			}
			const id = `${project.projectName}/${lead.agentId}`;
			if (seen.has(id)) throw new Error(`duplicate Codex Lead identity: ${id}`);
			seen.add(id);
			targets.push({ projectName: project.projectName, leadId: lead.agentId });
		}
	}
	return targets;
}

export async function resolveCodexCredentialHomeRoster(
	projects: ReadonlyArray<ProjectEntry>,
	options: ResolveCodexCredentialHomeRosterOptions,
): Promise<CodexCredentialHomeRosterEntry[]> {
	if (
		!isAbsolute(options.homeDir) ||
		resolve(options.homeDir) !== options.homeDir
	) {
		throw new Error("user home must be a normalized absolute path");
	}
	const entries: CodexCredentialHomeRosterEntry[] = [];
	const identities = new Set<string>();
	const homes = new Set<string>();
	const add = (entry: CodexCredentialHomeRosterEntry): void => {
		if (identities.has(entry.id))
			throw new Error(`duplicate credential home identity: ${entry.id}`);
		if (homes.has(entry.home))
			throw new Error(`duplicate credential home path: ${entry.home}`);
		identities.add(entry.id);
		homes.add(entry.home);
		entries.push(entry);
	};

	for (const policy of options.runnerHomes) {
		if (
			!safeIdentity(policy.project) ||
			!safeIdentity(policy.role) ||
			policy.id !== `${policy.project}/${policy.role}` ||
			isAbsolute(policy.relativeHome) ||
			resolve(options.homeDir, policy.relativeHome) === options.homeDir ||
			policy.relativeHome.split(/[\\/]/).includes("..")
		) {
			throw new Error(`invalid runner home policy: ${policy.id}`);
		}
		const home = resolve(options.homeDir, policy.relativeHome);
		try {
			assertPlainDirectoryWithin(options.homeDir, home);
			assertRunnerMarker(home, policy);
		} catch (error) {
			throw new Error(
				`${policy.id} runner credential home unavailable: ${String(error)}`,
			);
		}
		add({
			id: policy.id,
			home,
			ownership: "managed",
			project: policy.project,
			role: policy.role,
			...(policy.pendingAt ? { pendingAt: policy.pendingAt } : {}),
		});
	}

	for (const target of findRegisteredCodexCredentialLeadTargets(projects)) {
		const id = `${target.projectName}/${target.leadId}`;
		let codexHome: string;
		try {
			const authority = await options.resolveLeadAuthority(target);
			codexHome = authority.codexHome;
			assertPlainDirectoryWithin(options.homeDir, codexHome);
		} catch (error) {
			throw new Error(`${id} credential home unavailable: ${String(error)}`);
		}
		add({
			id,
			home: codexHome,
			ownership: "managed",
			leadTuple: id,
		});
	}
	return entries;
}
