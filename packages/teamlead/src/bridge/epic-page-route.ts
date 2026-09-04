import express from "express";
import {
	type GenerateEpicPageInput,
	generateEpicPage,
} from "../epic-page/generate.js";
import { materializeEpicPage } from "../epic-page/materialize.js";
import { type EpicPage, EpicPageSchemaError } from "../epic-page/model.js";
import {
	buildEpicPageRenderReceipt,
	type EpicPageRenderReceipt,
} from "../epic-page/receipt.js";
import { renderEpicPageHtml } from "../epic-page/render-html.js";
import { renderEpicPageMarkdown } from "../epic-page/render-markdown.js";
import type { ProjectEntry, ProjectLinearBinding } from "../ProjectConfig.js";
import { readEpicItemFacts, type StateStore } from "../StateStore.js";
import {
	ActiveScopeNotFoundError,
	EpicSnapshotTruncatedError,
	EpicTooLargeError,
	fetchLinearActiveScopeSnapshot,
} from "./linear-epic-query.js";
import { LinearUpstreamError } from "./linear-query.js";
import { resolveProjectNameParam } from "./linear-scope.js";

type EpicPageFormat = "json" | "md" | "html";

export interface EpicPageRouterDeps {
	store: StateStore;
	projects: ProjectEntry[];
	linearApiKey?: string;
	fetchSnapshot?: typeof fetchLinearActiveScopeSnapshot;
	now?: () => Date;
	generatePage?: (input: GenerateEpicPageInput) => EpicPage;
	buildReceipt?: (page: EpicPage) => EpicPageRenderReceipt;
}

function projectError(error: string): string {
	return error.startsWith("Unknown Flywheel project")
		? "unknown_project"
		: "project_unbound";
}

function resolveProject(
	projects: ProjectEntry[],
	raw: unknown,
):
	| { ok: true; projectName: string; binding: ProjectLinearBinding }
	| { ok: false; status: number; error: string } {
	if (typeof raw !== "string" || raw.trim().length === 0) {
		return { ok: false, status: 400, error: "project_required" };
	}
	const resolved = resolveProjectNameParam(projects, raw);
	if (!resolved.ok) {
		return {
			ok: false,
			status: resolved.status,
			error: projectError(resolved.error),
		};
	}
	if (!resolved.binding) {
		return { ok: false, status: 404, error: "project_unbound" };
	}
	return { ok: true, projectName: raw, binding: resolved.binding };
}

function resolveFormat(raw: unknown): EpicPageFormat | null {
	const format = raw ?? "json";
	return format === "json" || format === "md" || format === "html"
		? format
		: null;
}

function sendGenerateError(error: unknown, res: express.Response): void {
	if (error instanceof ActiveScopeNotFoundError) {
		res.status(422).json({ error: "active_scope_not_found" });
		return;
	}
	if (error instanceof EpicTooLargeError) {
		res.status(422).json({ error: "scope_too_large" });
		return;
	}
	if (error instanceof EpicSnapshotTruncatedError) {
		res.status(422).json({ error: "scope_snapshot_truncated" });
		return;
	}
	if (error instanceof LinearUpstreamError) {
		res.status(502).json({ error: "linear_unavailable" });
		return;
	}
	if (error instanceof EpicPageSchemaError) {
		res.status(422).json({
			error:
				error.code === "size" ? "epic_page_too_large" : "epic_page_invalid",
		});
		return;
	}
	console.error(
		"[EpicPage] generation failed:",
		error instanceof Error ? error.message : String(error),
	);
	res.status(500).json({ error: "internal_error" });
}

export function createEpicPageRouter(deps: EpicPageRouterDeps): express.Router {
	const router = express.Router();
	const fetchSnapshot = deps.fetchSnapshot ?? fetchLinearActiveScopeSnapshot;
	const generatePage = deps.generatePage ?? generateEpicPage;
	const buildReceipt = deps.buildReceipt ?? buildEpicPageRenderReceipt;
	const now = deps.now ?? (() => new Date());
	const generationTails = new Map<string, Promise<void>>();

	router.post("/generate", async (req, res) => {
		const project = resolveProject(deps.projects, req.body?.projectName);
		if (!project.ok) {
			res.status(project.status).json({ error: project.error });
			return;
		}
		if (
			req.body !== null &&
			typeof req.body === "object" &&
			Object.keys(req.body).some(
				(key) => key !== "projectName" && key !== "format",
			)
		) {
			res.status(400).json({ error: "unsupported_option" });
			return;
		}
		const format = resolveFormat(req.body?.format);
		if (!format) {
			res.status(400).json({ error: "invalid_format" });
			return;
		}
		if (!deps.linearApiKey) {
			res.status(501).json({ error: "linear_not_configured" });
			return;
		}

		const key = project.projectName;
		const prior = generationTails.get(key) ?? Promise.resolve();
		const operation = prior.then(async () => {
			const { page: document, receipt } = await materializeEpicPage(
				{
					fetchSnapshot,
					readItemFacts: (projectName, item) =>
						readEpicItemFacts(deps.store, projectName, item),
					generatePage,
					buildReceipt,
					now,
				},
				{
					projectName: project.projectName,
					binding: project.binding,
					apiKey: deps.linearApiKey!,
					trigger: "manual",
				},
			);
			const inserted = deps.store.insertEpicPageRenderReceipt({
				projectName: project.projectName,
				trigger: "manual",
				receipt,
			});
			return { document, inserted };
		});
		const tail = operation.then(
			() => undefined,
			() => undefined,
		);
		generationTails.set(key, tail);
		void tail.then(() => {
			if (generationTails.get(key) === tail) generationTails.delete(key);
		});
		try {
			const { document, inserted } = await operation;
			if (format === "md") {
				res.type("text/markdown").send(renderEpicPageMarkdown(document, now()));
				return;
			}
			if (format === "html") {
				res.type("text/html").send(renderEpicPageHtml(document, now()));
				return;
			}
			res.json({ receipt: inserted, document });
		} catch (error) {
			sendGenerateError(error, res);
		}
	});

	return router;
}
