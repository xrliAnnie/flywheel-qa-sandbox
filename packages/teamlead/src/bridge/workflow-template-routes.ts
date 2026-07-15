import express from "express";
import type { StateStore } from "../StateStore.js";
import { loopbackSelfOrigin } from "./loopback-origin.js";

function rejectNonLoopback(
	req: express.Request,
	res: express.Response,
): boolean {
	if (loopbackSelfOrigin(req.headers.host)) return false;
	res.status(403).json({ ok: false, reason: "non_loopback_host" });
	return true;
}

function revisionView(row: {
	template_id: string;
	revision: number;
	manifest: string;
	manifest_digest: string;
	schema_version: number;
	created_by: string;
	created_at: string;
}): Record<string, unknown> {
	return { ...row, manifest: JSON.parse(row.manifest) };
}

/** FLY-1244: local read model only. Mutation endpoints are deliberately absent. */
export function createWorkflowTemplateRouter(
	store: StateStore,
): express.Router {
	const router = express.Router();
	router.use((req, res, next) => {
		if (rejectNonLoopback(req, res)) return;
		next();
	});

	router.get("/templates", (_req, res) => {
		res.json({ ok: true, templates: store.listWorkflowTemplates() });
	});

	router.get("/templates/:templateId/revisions", (req, res) => {
		const template = store.getWorkflowTemplate(req.params.templateId);
		if (!template) {
			res.status(404).json({ ok: false, reason: "template_not_found" });
			return;
		}
		res.json({
			ok: true,
			template,
			revisions: store
				.listWorkflowTemplateRevisions(template.template_id)
				.map(revisionView),
			publications: store.listWorkflowTemplatePublications(
				template.template_id,
			),
		});
	});

	router.get("/templates/:templateId", (req, res) => {
		const template = store.getWorkflowTemplate(req.params.templateId);
		if (!template) {
			res.status(404).json({ ok: false, reason: "template_not_found" });
			return;
		}
		const current = template.current_published_revision
			? store.getWorkflowTemplateRevision(
					template.template_id,
					template.current_published_revision,
				)
			: undefined;
		res.json({
			ok: true,
			template,
			current_revision: current ? revisionView(current) : null,
		});
	});

	router.get("/template-binding", (req, res) => {
		const project =
			typeof req.query.project === "string" ? req.query.project.trim() : "";
		const category =
			typeof req.query.category === "string" ? req.query.category.trim() : "";
		if (!project || !category) {
			res
				.status(400)
				.json({ ok: false, reason: "project_and_category_required" });
			return;
		}
		const binding = store.getWorkflowCategoryBinding(project, category);
		if (!binding) {
			res.status(404).json({ ok: false, reason: "binding_not_found" });
			return;
		}
		res.json({ ok: true, binding });
	});

	return router;
}
