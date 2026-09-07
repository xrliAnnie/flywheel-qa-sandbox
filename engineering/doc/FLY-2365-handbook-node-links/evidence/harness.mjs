import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const port = Number(process.env.FLY2365_EVIDENCE_PORT || 18865);
const baselinePath = process.env.FLY2365_BASELINE_PATH;
const teamleadDist = process.env.FLY2365_TEAMLEAD_DIST;
if (!baselinePath || !teamleadDist) {
	throw new Error("FLY2365_BASELINE_PATH and FLY2365_TEAMLEAD_DIST are required");
}

const expectedProjects = [
	"flywheel",
	"geoforge3d",
	"growth",
	"joycon-typeless",
	"personal-assistant",
	"tidal-echo",
];
const expectedTemplates = [
	"tpl_design",
	"tpl_prd",
	"tpl_prototype",
	"tpl_code",
	"tpl_simple_code",
	"tpl_generic_menu",
];

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

function importDist(relativePath) {
	return import(pathToFileURL(join(teamleadDist, relativePath)).href);
}

const [
	{ loadProjects },
	{ loadFeatureFlagProjectConfigs },
	{ buildTopologyView },
	{ readManagementDags },
	{ composeManagementSnapshot },
	{ loadWorkflowMenuSeeds, workflowMenuBindings },
	{ getFleetConsoleHtml },
] = await Promise.all([
	importDist("ProjectConfig.js"),
	importDist("bridge/feature-flag-config-source.js"),
	importDist("bridge/management-topology-source.js"),
	importDist("bridge/management-dag-source.js"),
	importDist("bridge/management-console-snapshot.js"),
	importDist("workflow-menu.js"),
	importDist("bridge/fleet-console-html.js"),
]);

const allProjects = loadProjects();
const projectsByName = new Map(
	allProjects.map((project) => [project.projectName, project]),
);
const projects = expectedProjects.map((name) => {
	const project = projectsByName.get(name);
	if (!project) throw new Error(`production project missing: ${name}`);
	return project;
});
const configs = await loadFeatureFlagProjectConfigs(projects);
const topology = buildTopologyView({
	projects,
	configs,
	projectsRevision: "fly2365:evidence:projects",
});

const createdAt = "2026-09-06T00:00:00.000Z";
const seeds = loadWorkflowMenuSeeds();
const seedsById = new Map(seeds.map((seed) => [seed.templateId, seed]));
const bindingRows = expectedProjects.flatMap((project) =>
	workflowMenuBindings().map((binding) => ({
		project,
		task_category: binding.taskCategory,
		template_id: binding.templateId,
		updated_by: "fly2365-evidence",
		updated_at: createdAt,
	})),
);
const workflowReader = {
	listWorkflowCategoryBindings(project) {
		return bindingRows.filter((binding) => binding.project === project);
	},
	getWorkflowTemplate(templateId) {
		const seed = seedsById.get(templateId);
		return seed
			? {
					template_id: seed.templateId,
					name: seed.name,
					project_scope: seed.projectScope,
					current_published_revision: 1,
					created_by: "fly2365-evidence",
					created_at: createdAt,
					seed_owner: "system",
					seed_content_hash: seed.contentHash,
					retired_at: null,
				}
			: undefined;
	},
	getWorkflowTemplateRevision(templateId, revision) {
		const seed = seedsById.get(templateId);
		return seed && revision === 1
			? {
					template_id: seed.templateId,
					revision,
					manifest: JSON.stringify(seed.manifest),
					manifest_digest: seed.contentHash,
					schema_version: seed.manifest.schema_version,
					created_by: "fly2365-evidence",
					created_at: createdAt,
				}
			: undefined;
	},
};
const dagProjection = readManagementDags({
	reader: workflowReader,
	projectNames: expectedProjects,
});
const fixture = composeManagementSnapshot({
	now: () => new Date(createdAt),
	providers: [
		{
			id: "production-baseline",
			sourceKind: "projects_json",
			read: () => ({
				revision: "fly2365:evidence:baseline",
				fragment: {
					projects: topology.projects,
					presentationGroups: topology.presentationGroups,
					flags: baseline.flags,
					extensions: baseline.extensions,
					modelCatalog: baseline.modelCatalog,
					projectCrons: baseline.projects.map((project) => ({
						projectName: project.name,
						crons: project.crons,
					})),
					projectRunnerDefaults: baseline.projects
						.filter((project) => project.runnerDefault)
						.map((project) => ({
							projectName: project.name,
							runnerDefault: project.runnerDefault,
						})),
					unassignedCrons: baseline.unassignedCrons,
				},
			}),
		},
		{
			id: "workflow-catalog",
			sourceKind: "workflow_catalog",
			read: () => ({
				revision: dagProjection.revision,
				fragment: { projectDags: dagProjection.projectDags },
			}),
		},
	],
});

const projectNames = fixture.projects.map((project) => project.name);
if (JSON.stringify(projectNames) !== JSON.stringify(expectedProjects)) {
	throw new Error(
		`production project invariant mismatch: ${JSON.stringify(projectNames)}`,
	);
}
for (const project of fixture.projects) {
	const templates = project.dags
		.map((dag) => dag.templateId)
		.sort((left, right) => left.localeCompare(right));
	const expected = [...expectedTemplates].sort((left, right) =>
		left.localeCompare(right),
	);
	if (JSON.stringify(templates) !== JSON.stringify(expected)) {
		throw new Error(
			`production DAG invariant mismatch for ${project.name}: ${JSON.stringify(templates)}`,
		);
	}
}

const html = getFleetConsoleHtml();
const htmlHash = createHash("sha256").update(html).digest("hex");

function snapshotFor(request) {
	const referer = String(request.headers.referer || "");
	const value = structuredClone(fixture);
	if (referer.includes("/self-check")) {
		const flywheel = value.projects.find((project) => project.name === "flywheel");
		const role = flywheel.roles.find((candidate) =>
			candidate.handbookRefs.includes("general"),
		);
		role.handbookRefs = role.handbookRefs.filter((ref) => ref !== "general");
	}
	if (referer.includes("/schema2")) {
		const flywheel = value.projects.find((project) => project.name === "flywheel");
		const generic = flywheel.dags.find(
			(dag) => dag.templateId === "tpl_generic_menu",
		);
		generic.graph.nodes.find((node) => node.execution === "agent").handbookRef =
			null;
	}
	return value;
}

const server = createServer((request, response) => {
	if (request.method !== "GET") {
		response.writeHead(405).end("read only");
		return;
	}
	const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
	if (url.pathname === "/__fixture") {
		response
			.writeHead(200, { "Content-Type": "application/json" })
			.end(
				JSON.stringify({
					issue: "FLY-2365",
					pid: process.pid,
					htmlHash,
					projects: expectedProjects,
					templates: expectedTemplates,
				}),
			);
		return;
	}
	if (url.pathname === "/api/fleet/snapshot") {
		response
			.writeHead(200, { "Content-Type": "application/json" })
			.end(JSON.stringify(snapshotFor(request)));
		return;
	}
	response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	response.end(html);
});

server.listen(port, "127.0.0.1", () => {
	console.log(
		JSON.stringify({ ready: true, port, pid: process.pid, htmlHash }),
	);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => server.close(() => process.exit(0)));
}
