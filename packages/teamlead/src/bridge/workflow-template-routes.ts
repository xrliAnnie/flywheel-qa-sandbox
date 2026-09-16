import express from "express";
import type { StateStore } from "../StateStore.js";
import {
	WorkflowPublicationError,
	type WorkflowTemplatePublicationService,
} from "../workflow-template-publication.js";
import { isSameOrigin, loopbackSelfOrigin } from "./loopback-origin.js";

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

/** Existing read model plus explicitly configured managed publication. */
export function createWorkflowTemplateRouter(
	store: StateStore,
	publication?: WorkflowTemplatePublicationService,
): express.Router {
	const router = express.Router();
	router.use((req, res, next) => {
		if (rejectNonLoopback(req, res)) return;
		next();
	});
	if (publication) {
		const managementAuth: express.RequestHandler = (req, res, next) => {
			const origin = loopbackSelfOrigin(req.headers.host);
			const peer = req.socket.remoteAddress;
			if (
				!origin ||
				!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "") ||
				!isSameOrigin(
					{ origin: req.get("origin"), referer: req.get("referer") },
					origin,
				)
			) {
				res
					.status(403)
					.json({ ok: false, reason: "local_same_origin_required" });
				return;
			}
			next();
		};
		const execute = (res: express.Response, action: () => unknown) => {
			try {
				res.json(action());
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "publication_failed";
				const conflict =
					message === "template_retired" ||
					message.startsWith("active_run_not_pinned:");
				const status =
					error instanceof WorkflowPublicationError
						? error.status
						: conflict
							? 409
							: 500;
				res.status(status).json({
					ok: false,
					reason: status === 500 ? "publication_failed" : message,
				});
			}
		};
		const body = express.json({ limit: "512kb" });
		router.post(
			"/templates/:templateId/publish/stage",
			managementAuth,
			body,
			(req, res) =>
				execute(res, () => {
					if (
						!req.body ||
						typeof req.body !== "object" ||
						Array.isArray(req.body) ||
						"templateId" in req.body
					)
						throw new WorkflowPublicationError("invalid_request");
					return publication.stage({
						...req.body,
						templateId: req.params.templateId,
					});
				}),
		);
		router.post(
			"/templates/:templateId/publish/apply",
			managementAuth,
			body,
			(req, res) =>
				execute(res, () => {
					if (req.body?.canonical?.templateId !== req.params.templateId)
						throw new WorkflowPublicationError("template_path_mismatch");
					return publication.apply(req.body);
				}),
		);
		router.get("/publications/:operationId", managementAuth, (req, res) =>
			execute(res, () => {
				const receipt = publication.status(req.params.operationId);
				if (!receipt)
					throw new WorkflowPublicationError("operation_not_found", 404);
				return receipt;
			}),
		);
	}

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

/** Read-only compatibility alias; dispatch internally to the same catalog handlers. */
export function createWorkflowTemplateAliasRouter(
	store: StateStore,
): express.Router {
	const router = express.Router();
	const readModel = createWorkflowTemplateRouter(store);
	for (const path of ["/:templateId", "/:templateId/revisions"]) {
		router.get(path, (req, res, next) => {
			const originalUrl = req.url;
			req.url = `/templates${originalUrl}`;
			readModel(req, res, (error?: unknown) => {
				req.url = originalUrl;
				next(error);
			});
		});
	}
	return router;
}
