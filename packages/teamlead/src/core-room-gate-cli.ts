#!/usr/bin/env node

/**
 * FLY-898 — thin CLI wrapper around `resolveCoreRoomGate` over projects.json,
 * so the SAME decision drives the bash launchers/fleet script and the Codex
 * runtimes (no drift). Reads projects via `loadProjects()` (honors
 * FLYWHEEL_PROJECTS / ~/.flywheel/projects.json identically to the Bridge).
 *
 * Three modes:
 *   --lead-id <id> --project <name>
 *       Print ONE gate as JSON `{coreChannelId,projectHasCoS,isCoS,gateNonCoS}`
 *       and exit 0. Unknown project/lead → stderr + exit 3 (caller treats
 *       non-zero as "don't gate" — fail-open safe).
 *   --all
 *       Print JSONL — one line per NON-CoS lead that should be gated:
 *       `{projectName,leadId,coreChannelId,backend}`. `backend` lets the caller
 *       filter (the Claude fleet apply skips codex leads → they gate via runtime
 *       env, not access.json). Exit 0.
 *   --all-leads
 *       FLY-944 — print JSONL, one line per lead across the WHOLE fleet with
 *       role flags: `{projectName,leadId,coreChannelId,isCoS,gateNonCoS,backend}`.
 *       Drives the role-aware shared-channel allowFrom sweep. Exit 0.
 */

import {
	type CoreRoomGate,
	type CoreRoomGateLead,
	type CoreRoomGateProject,
	resolveCoreRoomGate,
} from "./core-room-gate.js";
import { loadProjects, type ProjectEntry } from "./ProjectConfig.js";

export interface GateEntry {
	projectName: string;
	leadId: string;
	coreChannelId: string;
	backend: "claude-code" | "codex-app-server";
}

type ProjectLike = CoreRoomGateProject & {
	projectName: string;
	leads: Array<CoreRoomGateLead & { backend?: string }>;
};

function backendOf(lead: { backend?: string }): GateEntry["backend"] {
	// A missing / unknown backend is the default claude-code (only the exact
	// "codex-app-server" marks a Codex lead — mirrors normalizeLeadBackend).
	return lead.backend === "codex-app-server"
		? "codex-app-server"
		: "claude-code";
}

/** Every gated (non-CoS) lead across the fleet, both backends, in roster order. */
export function computeAllGates(projects: ProjectLike[]): GateEntry[] {
	const out: GateEntry[] = [];
	for (const p of projects) {
		for (const lead of p.leads ?? []) {
			const g = resolveCoreRoomGate(p, lead);
			if (g.gateNonCoS && g.coreChannelId) {
				out.push({
					projectName: p.projectName,
					leadId: lead.agentId,
					coreChannelId: g.coreChannelId,
					backend: backendOf(lead),
				});
			}
		}
	}
	return out;
}

export interface LeadEntry {
	projectName: string;
	leadId: string;
	coreChannelId: string | undefined;
	isCoS: boolean;
	gateNonCoS: boolean;
	backend: GateEntry["backend"];
}

/** FLY-944 — one entry per lead across the fleet with role flags. Drives the
 * shared-channel allowFrom sweep (apply-core-room-mention-gate.sh --all-shared):
 * a NON-CoS core may only lose allowFrom via the main transform that also flips
 * requireMention (pile-on guard), while a CoS core / roundtable group is safe
 * for --allowfrom-only. The sweep needs isCoS/gateNonCoS per lead, not just the
 * channel set. */
export function computeAllLeadEntries(projects: ProjectLike[]): LeadEntry[] {
	const out: LeadEntry[] = [];
	for (const p of projects) {
		for (const lead of p.leads ?? []) {
			const g = resolveCoreRoomGate(p, lead);
			out.push({
				projectName: p.projectName,
				leadId: lead.agentId,
				coreChannelId: g.coreChannelId,
				isCoS: g.isCoS,
				gateNonCoS: g.gateNonCoS,
				backend: backendOf(lead),
			});
		}
	}
	return out;
}

/** The gate for one (project, lead), or undefined when either is unknown. */
export function resolveOneGate(
	projects: ProjectLike[],
	projectName: string,
	leadId: string,
): CoreRoomGate | undefined {
	const p = projects.find((e) => e.projectName === projectName);
	if (!p) return undefined;
	const lead = (p.leads ?? []).find((l) => l.agentId === leadId);
	if (!lead) return undefined;
	return resolveCoreRoomGate(p, lead);
}

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && i + 1 < process.argv.length
		? process.argv[i + 1]
		: undefined;
}

function main(): void {
	const projects = loadProjects() as unknown as ProjectLike[];

	if (process.argv.includes("--all-leads")) {
		for (const e of computeAllLeadEntries(projects)) {
			process.stdout.write(`${JSON.stringify(e)}\n`);
		}
		return;
	}

	if (process.argv.includes("--all")) {
		for (const e of computeAllGates(projects)) {
			process.stdout.write(`${JSON.stringify(e)}\n`);
		}
		return;
	}

	const leadId = arg("lead-id");
	const project = arg("project");
	if (!leadId || !project) {
		process.stderr.write(
			"[core-room-gate] usage: --lead-id <id> --project <name>  |  --all\n",
		);
		process.exit(2);
	}
	const gate = resolveOneGate(projects, project, leadId);
	if (!gate) {
		process.stderr.write(
			`[core-room-gate] no such project/lead: ${project}/${leadId}\n`,
		);
		process.exit(3);
	}
	process.stdout.write(`${JSON.stringify(gate)}\n`);
}

// Only run when invoked directly (not when imported by tests).
const invokedPath = process.argv[1] ?? "";
if (
	invokedPath.endsWith("core-room-gate-cli.js") ||
	invokedPath.endsWith("core-room-gate-cli.ts")
) {
	main();
}

// Keep the ProjectEntry type reachable for callers that pass real config.
export type { ProjectEntry };
