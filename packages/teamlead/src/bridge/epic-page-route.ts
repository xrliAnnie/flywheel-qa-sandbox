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
import { readSignals } from "../epic-page/signals.js";
import type { ProjectEntry, ProjectLinearBinding } from "../ProjectConfig.js";
import {
	type EpicPageFreshnessRead,
	readEpicItemFacts,
	type StateStore,
} from "../StateStore.js";
import type { EpicPagePublisher } from "./epic-page-publisher.js";
import {
	createEpicPageSerializer,
	type EpicPageSerializer,
	runEpicPageAttempt,
} from "./epic-page-refresher.js";
import {
	ActiveScopeNotFoundError,
	EpicSnapshotTruncatedError,
	EpicTooLargeError,
	fetchLinearActiveScopeSnapshot,
} from "./linear-epic-query.js";
import { LinearUpstreamError } from "./linear-query.js";
import { resolveProjectNameParam } from "./linear-scope.js";
import { scheduledAtOrBefore } from "./patrol-tick.js";
import type { ReportHostOverride } from "./report-host-override.js";
import type { ReportRegistry } from "./report-registry.js";
import { reportUrlForToken } from "./report-url.js";

type EpicPageFormat = "json" | "md" | "html";

export interface EpicPageRouterDeps {
	store: StateStore;
	projects: ProjectEntry[];
	linearApiKey?: string;
	fetchSnapshot?: typeof fetchLinearActiveScopeSnapshot;
	now?: () => Date;
	generatePage?: (input: GenerateEpicPageInput) => EpicPage;
	buildReceipt?: (page: EpicPage) => EpicPageRenderReceipt;
	serializer?: EpicPageSerializer;
	publisher?: EpicPagePublisher;
	scanSchedule?: (
		projectName: string,
	) => { leadId: string; intervalMs: number } | undefined;
}

export interface EpicPageStatusRouterDeps {
	store: Pick<StateStore, "getEpicPageFreshness" | "getEpicPagePublication">;
	projects: ProjectEntry[];
	registry: Pick<ReportRegistry, "hosting" | "vercelProjectName">;
	hostOverride?: ReportHostOverride;
	now?: () => Date;
	scanSchedule?: (
		projectName: string,
	) => { leadId: string; intervalMs: number } | undefined;
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

function sendGenerateError(
	error: unknown,
	res: express.Response,
	freshness: Pick<EpicPageFreshnessRead, "last_generated" | "last_published">,
): void {
	const body = (errorCode: string) => ({ error: errorCode, ...freshness });
	if (error instanceof ActiveScopeNotFoundError) {
		res.status(422).json(body("active_scope_not_found"));
		return;
	}
	if (error instanceof EpicTooLargeError) {
		res.status(422).json(body("scope_too_large"));
		return;
	}
	if (error instanceof EpicSnapshotTruncatedError) {
		res.status(422).json(body("scope_snapshot_truncated"));
		return;
	}
	if (error instanceof LinearUpstreamError) {
		res.status(502).json(body("linear_unavailable"));
		return;
	}
	if (error instanceof EpicPageSchemaError) {
		res
			.status(422)
			.json(
				body(
					error.code === "size" ? "epic_page_too_large" : "epic_page_invalid",
				),
			);
		return;
	}
	console.error(
		"[EpicPage] generation failed:",
		error instanceof Error ? error.message : String(error),
	);
	res.status(500).json({ error: "internal_error" });
}

export function createEpicPageStatusRouter(
	deps: EpicPageStatusRouterDeps,
): express.Router {
	const router = express.Router();
	const now = deps.now ?? (() => new Date());
	router.get("/", (req, res) => {
		const project = resolveProject(deps.projects, req.query.projectName);
		if (!project.ok) {
			res.status(project.status).json({ error: project.error });
			return;
		}
		try {
			const freshness = deps.store.getEpicPageFreshness(project.projectName);
			const row = deps.store.getEpicPagePublication(project.projectName);
			const schedule = deps.scanSchedule?.(project.projectName);
			const nowMs = now().getTime();
			const published = row?.published === true && !deps.hostOverride;
			const nextScanExpectedAt = schedule
				? new Date(
						scheduledAtOrBefore(nowMs, schedule.leadId, schedule.intervalMs) +
							schedule.intervalMs,
					).toISOString()
				: null;
			res.json({
				freshness,
				publication: row
					? {
							token8: row.token.slice(0, 8),
							published,
							url: published
								? reportUrlForToken(deps.registry, row.token)
								: null,
							last_published_at: row.last_published_at ?? null,
							last_version: row.last_version ?? null,
						}
					: null,
				next_scan_expected_at: nextScanExpectedAt,
			});
		} catch (error) {
			console.error(
				"[EpicPage] status read failed:",
				error instanceof Error ? error.message : String(error),
			);
			res.status(500).json({ error: "internal_error" });
		}
	});
	return router;
}

export function createEpicPageRouter(deps: EpicPageRouterDeps): express.Router {
	const router = express.Router();
	const fetchSnapshot = deps.fetchSnapshot ?? fetchLinearActiveScopeSnapshot;
	const generatePage = deps.generatePage ?? generateEpicPage;
	const buildReceipt = deps.buildReceipt ?? buildEpicPageRenderReceipt;
	const now = deps.now ?? (() => new Date());
	const serializer = deps.serializer ?? createEpicPageSerializer();

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

		try {
			const result = await runEpicPageAttempt(
				{
					store: deps.store,
					serializer,
					publisher: deps.publisher,
					now,
					materialize: (input) =>
						materializeEpicPage(
							{
								fetchSnapshot,
								readItemFacts: (projectName, item) =>
									readEpicItemFacts(deps.store, projectName, item),
								readSignals: (projectName, items, generatedAt) =>
									readSignals(
										{ stateStore: deps.store },
										{ projectName, items, now: generatedAt },
									),
								readLeadNotes: (projectName, ids) =>
									deps.store.getLeadNotes(projectName, ids),
								readFreshness: (projectName) => ({
									history: deps.store.getEpicPageFreshness(projectName),
									publication: deps.store.getEpicPagePublication(projectName),
								}),
								generatePage,
								buildReceipt,
								now,
							},
							{
								...input,
								leadNoteFadeDays: deps.projects.find(
									(project) => project.projectName === input.projectName,
								)?.epicPage?.leadNoteFadeDays,
							},
						),
				},
				{
					projectName: project.projectName,
					binding: project.binding,
					apiKey: deps.linearApiKey!,
					trigger: "manual",
					reasons: ["manual"],
					scanSchedule: deps.scanSchedule?.(project.projectName),
				},
			);
			if (result.kind === "unavailable") throw result.error;
			const document = result.materialized.page;
			const inserted = result.inserted;
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
			const freshness = deps.store.getEpicPageFreshness(project.projectName);
			sendGenerateError(error, res, {
				last_generated: freshness.last_generated,
				last_published: freshness.last_published,
			});
		}
	});

	return router;
}
