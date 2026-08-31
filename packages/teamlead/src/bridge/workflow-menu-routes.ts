import { execFileSync } from "node:child_process";
import { Router } from "express";
import { getModelRegistryEntry } from "flywheel-config";
import {
	loadProjectMenuConfig,
	resolveLeadMenus,
	WorkflowMenuValidationError,
} from "../workflow-menu.js";
import { loopbackSelfOrigin } from "./loopback-origin.js";

interface WorkflowMenuProject {
	projectName: string;
	projectRoot: string;
}

function defaultGitHead(projectRoot: string): string {
	return execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: projectRoot,
		encoding: "utf8",
	}).trim();
}

export function createWorkflowMenuRouter(
	projects: readonly WorkflowMenuProject[],
	options: { gitHead?: (projectRoot: string) => string } = {},
): Router {
	const router = Router();
	router.use((req, res, next) => {
		if (!loopbackSelfOrigin(req.headers.host)) {
			res.status(403).json({
				success: false,
				code: "NON_LOOPBACK_HOST",
			});
			return;
		}
		next();
	});
	router.get("/menus", (req, res) => {
		const legalProjects = projects.map((project) => project.projectName);
		const rawProjectName =
			typeof req.query.projectName === "string"
				? req.query.projectName.trim()
				: "";
		if (!rawProjectName) {
			res.status(400).json({
				success: false,
				code: "PROJECT_NAME_REQUIRED",
				legal: legalProjects,
			});
			return;
		}
		const project = projects.find(
			(candidate) =>
				candidate.projectName.toLowerCase() === rawProjectName.toLowerCase(),
		);
		if (!project) {
			res.status(400).json({
				success: false,
				code: "MENU_PROJECT_NOT_FOUND",
				legal: legalProjects,
			});
			return;
		}
		const leadId =
			typeof req.query.leadId === "string" ? req.query.leadId.trim() : "";
		if (!leadId) {
			let legal: string[] = [];
			try {
				legal = Object.keys(
					loadProjectMenuConfig(project.projectRoot).adoption,
				);
			} catch {
				// The invalid project config is reported below once a Lead is present.
			}
			res.status(400).json({
				success: false,
				code: "LEAD_ID_REQUIRED",
				legal,
			});
			return;
		}
		let menuVersion: string;
		try {
			menuVersion = (options.gitHead ?? defaultGitHead)(
				project.projectRoot,
			).trim();
			if (!/^[0-9a-f]{40}$/.test(menuVersion)) {
				throw new Error("git head is not a full SHA");
			}
		} catch (error) {
			res.status(503).json({
				success: false,
				code: "MENU_VERSION_UNAVAILABLE",
				reason: (error as Error).message,
			});
			return;
		}
		try {
			const menus = resolveLeadMenus({
				projectRoot: project.projectRoot,
				leadId,
			});
			res.json({
				success: true,
				projectName: project.projectName,
				leadId,
				menuVersion,
				menus: menus.map((menu) => ({
					item: menu.shape,
					label: menu.label,
					templateId: menu.templateId,
					nodes: menu.nodes.map((node) => {
						if (node.type === "gate") {
							return { id: node.id, label: node.label, type: "gate" };
						}
						return {
							id: node.id,
							label: node.label,
							type: node.type,
							defaultModel: node.defaultModel,
							models: node.models!.map((model) => {
								const registry = getModelRegistryEntry(model.model)!;
								return {
									model: model.model,
									resolvedModel: registry.id,
									receipt: `${model.model} (= ${registry.id})`,
									allowedEfforts: model.allowedEfforts,
									defaultEffort: model.defaultEffort,
								};
							}),
						};
					}),
					edges: menu.edges,
					loops: menu.loops,
				})),
			});
		} catch (error) {
			if (error instanceof WorkflowMenuValidationError) {
				res.status(error.status).json({
					success: false,
					code: error.code,
					reason: error.message,
					legal: error.legal,
				});
				return;
			}
			res.status(400).json({
				success: false,
				code: "INVALID_MENU_CONFIG",
				reason: (error as Error).message,
				legal: [],
			});
		}
	});
	return router;
}
