import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ProjectEntry } from "./ProjectConfig.js";

export type CoSLeadRef = { project: string; leadId: string };

export interface CoSLead {
	ref: CoSLeadRef;
	botUserId: string;
	displayName: string;
	aliases: string[];
	projectRoot: string;
	identityPath: string;
	memoryPaths: string[];
	writableRoots: string[];
	voice?: string | { voiceId: string; rate?: string; pitch?: string };
}

export interface LeadDirectory {
	projectsDigest: string;
	leads: readonly CoSLead[];
	resolve(name: string): CoSLead | undefined;
}

function normalizedName(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/\s+/gu, "")
		.toLocaleLowerCase("en-US");
}

function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return (
		rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))
	);
}

export function compileLeadDirectory(
	projects: readonly ProjectEntry[],
	projectsDigest: string,
): LeadDirectory {
	if (!/^[a-f0-9]{64}$/u.test(projectsDigest)) {
		throw new Error(
			"projectsDigest must be a 64-character lowercase SHA-256 digest",
		);
	}
	const leads: CoSLead[] = [];
	const byName = new Map<string, CoSLead>();
	for (const project of projects) {
		for (const lead of project.leads) {
			const context = lead.cosContext;
			if (context === undefined) continue;
			if (!lead.botUserId) {
				throw new Error(
					`${project.projectName}/${lead.agentId} CoS context requires botUserId`,
				);
			}
			const root = resolve(project.projectRoot);
			const workingRoot = resolve(root, context.workingSubdirectory);
			if (!isInside(root, workingRoot)) {
				throw new Error(
					`${project.projectName}/${lead.agentId} CoS working subdirectory escapes projectRoot`,
				);
			}
			const row: CoSLead = {
				ref: { project: project.projectName, leadId: lead.agentId },
				botUserId: lead.botUserId,
				displayName: context.displayName,
				aliases: [...context.aliases],
				projectRoot: workingRoot,
				identityPath: context.identityPath,
				memoryPaths: [...context.memoryPaths],
				writableRoots: [...context.writableRoots],
				...(lead.voice !== undefined ? { voice: lead.voice } : {}),
			};
			for (const name of [
				lead.agentId,
				context.displayName,
				...context.aliases,
			]) {
				const key = normalizedName(name);
				if (!key)
					throw new Error(
						`${project.projectName}/${lead.agentId} has an empty CoS Lead name`,
					);
				const existing = byName.get(key);
				if (
					existing &&
					(existing.ref.project !== row.ref.project ||
						existing.ref.leadId !== row.ref.leadId)
				) {
					throw new Error(
						`ambiguous CoS Lead name ${key}: ${existing.ref.project}/${existing.ref.leadId}, ${row.ref.project}/${row.ref.leadId}`,
					);
				}
				byName.set(key, row);
			}
			leads.push(row);
		}
	}
	return {
		projectsDigest,
		leads,
		resolve(name: string): CoSLead | undefined {
			return byName.get(normalizedName(name));
		},
	};
}

export interface BusinessLead {
	ref: CoSLeadRef;
	displayName: string;
	aliases: string[];
	botUserId?: string;
	projectRoot?: string;
	identityPath?: string;
	memoryPaths?: string[];
	roundtableChannel?: string;
	external: boolean;
	companion: boolean;
	canSpawnRunners: boolean;
	summaryRole: LeadConfigRole;
	missing: string[];
}
type LeadConfigRole = ProjectEntry["leads"][number]["summaryRole"];
export interface BusinessDirectory {
	projectsDigest: string;
	projects: {
		projectName: string;
		projectRoot?: string;
		projectRepo?: string;
		status: "available" | "unavailable";
	}[];
	leads: BusinessLead[];
	resolve(name: string): BusinessLead | undefined;
}

/** Registry projection only. These paths never grant filesystem authority. */
export function compileBusinessDirectory(
	projects: readonly ProjectEntry[],
	projectsDigest: string,
): BusinessDirectory {
	if (!/^[a-f0-9]{64}$/u.test(projectsDigest))
		throw new Error("projectsDigest must be a lowercase SHA-256 digest");
	const rows: BusinessDirectory["projects"] = [];
	const leads: BusinessLead[] = [];
	const byName = new Map<string, BusinessLead[]>();
	for (const project of projects) {
		let root: string | undefined;
		try {
			root = realpathSync(project.projectRoot);
		} catch {
			/* Unreadable roots remain visible as unavailable. */
		}
		rows.push({
			projectName: project.projectName,
			...(root ? { projectRoot: root } : {}),
			...(project.projectRepo && /^[\w.-]+\/[\w.-]+$/.test(project.projectRepo)
				? { projectRepo: project.projectRepo }
				: {}),
			status: root ? "available" : "unavailable",
		});
		for (const lead of project.leads) {
			const context = lead.cosContext;
			const missing: string[] = [];
			if (!context) missing.push("cosContext");
			if (!lead.botUserId) missing.push("botUserId");
			let workingRoot: string | undefined;
			if (root) {
				try {
					const candidate = resolve(root, context?.workingSubdirectory ?? ".");
					const canonical = realpathSync(candidate);
					if (isInside(root, candidate) && isInside(root, canonical))
						workingRoot = canonical;
				} catch {
					/* Explicit missing field below; never publish an unverified path. */
				}
			}
			if (!workingRoot) missing.push("workingRoot");
			const row: BusinessLead = {
				ref: { project: project.projectName, leadId: lead.agentId },
				displayName: context?.displayName ?? lead.agentId,
				aliases: [...(context?.aliases ?? [])],
				...(lead.botUserId ? { botUserId: lead.botUserId } : {}),
				...(workingRoot ? { projectRoot: workingRoot } : {}),
				...(context
					? {
							identityPath: context.identityPath,
							memoryPaths: [...context.memoryPaths],
						}
					: {}),
				...(lead.roundtableChannel
					? { roundtableChannel: lead.roundtableChannel }
					: {}),
				external: lead.external === true,
				companion: lead.companion === true,
				canSpawnRunners: lead.canSpawnRunners !== false,
				summaryRole: lead.summaryRole,
				missing,
			};
			leads.push(row);
			for (const name of new Set(
				[lead.agentId, row.displayName, ...row.aliases].map(normalizedName),
			)) {
				byName.set(name, [...(byName.get(name) ?? []), row]);
			}
		}
	}
	return {
		projectsDigest,
		projects: rows,
		leads,
		resolve(name) {
			const candidates = byName.get(normalizedName(name)) ?? [];
			if (candidates.length > 1)
				throw new Error(
					`ambiguous Lead name: ${candidates.map((x) => `${x.ref.project}/${x.ref.leadId}`).join(", ")}`,
				);
			return candidates[0];
		},
	};
}
