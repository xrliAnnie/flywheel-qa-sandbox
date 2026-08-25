#!/usr/bin/env -S pnpm exec tsx

import { isDeepStrictEqual } from "node:util";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseAndValidateProjects } from "../../../../packages/teamlead/src/ProjectConfig.ts";

const TARGET_PROJECT = "personal-assistant";
const TARGET_LEAD = "belle-lead";
const TARGET_REPO = "xrliAnnie/belle-workspace";
const TARGET_MEMORY_USERS = ["annie", "belle-lead", "personal-assistant"];
const TARGET_LINEAR_LABEL = "personal-assistant";

function fail(message: string): never {
	throw new Error(`FLY-2034 projects cutover verification failed: ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) fail(message);
}

function readProjects(path: string): Array<Record<string, unknown>> {
	const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
	assert(Array.isArray(raw), `${path} must contain a projects array`);
	parseAndValidateProjects(structuredClone(raw));
	return raw as Array<Record<string, unknown>>;
}

function targetProject(projects: Array<Record<string, unknown>>): Record<string, unknown> {
	const matches = projects.filter((project) => project.projectName === TARGET_PROJECT);
	assert(matches.length === 1, `expected exactly one ${TARGET_PROJECT} project`);
	return matches[0]!;
}

function targetLead(project: Record<string, unknown>): Record<string, unknown> {
	assert(Array.isArray(project.leads), `${TARGET_PROJECT}.leads must be an array`);
	const matches = (project.leads as Array<Record<string, unknown>>).filter(
		(lead) => lead.agentId === TARGET_LEAD,
	);
	assert(matches.length === 1, `expected exactly one ${TARGET_LEAD} lead`);
	return matches[0]!;
}

function main(): void {
	const [beforeArgument, candidateArgument] = process.argv.slice(2);
	if (!beforeArgument || !candidateArgument) {
		fail(
			`usage: ${basename(process.argv[1] ?? "verify-belle-projects-cutover.ts")} <before-projects.json> <candidate-projects.json>`,
		);
	}
	const beforePath = resolve(beforeArgument);
	const candidatePath = resolve(candidateArgument);
	assert(
		(statSync(candidatePath).mode & 0o777) === 0o600,
		"candidate projects.json mode must be 0600 before rename",
	);
	const before = readProjects(beforePath);
	const candidate = readProjects(candidatePath);
	const beforeProject = targetProject(before);
	const beforeLead = targetLead(beforeProject);
	assert(beforeLead.companion === true, "baseline Belle companion must be true");
	assert(
		beforeLead.canSpawnRunners === false,
		"baseline Belle canSpawnRunners must be false",
	);
	assert(beforeProject.projectRepo == null, "baseline personal-assistant projectRepo must be absent");
	assert(
		beforeProject.memoryAllowedUsers == null,
		"baseline personal-assistant memoryAllowedUsers must be absent",
	);
	assert(
		isDeepStrictEqual(beforeLead.match, { labels: ["life"] }),
		'baseline belle-lead matcher must be labels=["life"]',
	);
	assert(beforeLead.department === "life", "baseline Belle department must be life");

	const expected = structuredClone(before);
	const expectedProject = targetProject(expected);
	expectedProject.projectRepo = TARGET_REPO;
	expectedProject.memoryAllowedUsers = TARGET_MEMORY_USERS;
	const expectedLead = targetLead(expectedProject);
	delete expectedLead.companion;
	expectedLead.canSpawnRunners = true;
	expectedLead.match = { labels: [TARGET_LINEAR_LABEL] };
	expectedLead.department = "life";

	assert(
		isDeepStrictEqual(candidate, expected),
		"candidate must contain only the approved projectRepo, memoryAllowedUsers, label matcher, companion removal, and canSpawnRunners changes while preserving department=life",
	);
	process.stdout.write(
		`${JSON.stringify({
			ok: true,
			project: TARGET_PROJECT,
			lead: TARGET_LEAD,
			projectRepo: TARGET_REPO,
			memoryAllowedUsers: TARGET_MEMORY_USERS,
			linearLabel: TARGET_LINEAR_LABEL,
			department: "life",
			companionRemoved: true,
			canSpawnRunners: true,
		})}\n`,
	);
}

main();
