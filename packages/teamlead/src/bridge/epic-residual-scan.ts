import { readAttentionSources } from "../epic-page/attention-sources.js";
import {
	type GenerateAttentionEpicPageInput,
	generateAttentionEpicPage,
} from "../epic-page/generate.js";
import { materializeEpicPage } from "../epic-page/materialize.js";
import type { EpicPage } from "../epic-page/model.js";
import {
	buildEpicPageRenderReceipt,
	type EpicPageRenderReceipt,
} from "../epic-page/receipt.js";
import type {
	EpicResidualFact,
	EpicResidualOwner,
	EpicResidualTrigger,
	MaterializedEpicScope,
} from "../epic-page/residual.js";
import {
	assertEpicResidualFact,
	EpicResidualFactError,
	EpicResidualSessionUnreadableError,
	summarizeEpicResidual,
} from "../epic-page/residual.js";
import { readSignals } from "../epic-page/signals.js";
import {
	type ProjectEntry,
	resolveProjectLinearBinding,
} from "../ProjectConfig.js";
import { readEpicItemFacts, type StateStore } from "../StateStore.js";
import {
	createEpicPageSerializer,
	type EpicPageAttemptInput,
	type EpicPageAttemptResult,
	runEpicPageAttempt,
} from "./epic-page-refresher.js";
import {
	fetchLinearActiveScopeSnapshot,
	type LinearActiveScopeSnapshot,
} from "./linear-epic-query.js";

export type EpicScanMaterialized =
	| { kind: "ok"; materialized: MaterializedEpicScope }
	| { kind: "unavailable"; token: string }
	| undefined;

export interface EpicResidualScanDeps {
	store: StateStore;
	projects: ProjectEntry[];
	linearApiKey?: string;
	resolveOwner: (projectName: string, labels: string[]) => EpicResidualOwner;
	fetchSnapshot?: (
		apiKey: string,
		binding: NonNullable<ProjectEntry["linear"]>,
	) => Promise<LinearActiveScopeSnapshot>;
	generatePage?: (input: GenerateAttentionEpicPageInput) => EpicPage;
	buildReceipt?: (page: EpicPage) => EpicPageRenderReceipt;
	runAttempt?: (input: EpicPageAttemptInput) => Promise<EpicPageAttemptResult>;
	now?: () => Date;
	log?: (message: string) => void;
}

export function epicResidualBootWarnings(
	projects: ProjectEntry[],
	hasLinearApiKey: boolean,
): string[] {
	if (!hasLinearApiKey) {
		return [
			"[patrol_tick] epic residual scan disabled fleet-wide: LINEAR_API_KEY not configured",
		];
	}
	return projects
		.filter(
			(project) =>
				resolveProjectLinearBinding(projects, project.projectName) ===
				undefined,
		)
		.map(
			(project) =>
				`[patrol_tick] epic residual scan disabled for project=${project.projectName}: no linear binding in projects.json`,
		);
}

export function createEpicResidualScan(deps: EpicResidualScanDeps): {
	materializeForScan(project: ProjectEntry): Promise<EpicScanMaterialized>;
	summarizeForLead(
		materialized: EpicScanMaterialized,
		leadId: string,
		trigger: EpicResidualTrigger,
	): EpicResidualFact | undefined;
} {
	const now = deps.now ?? (() => new Date());
	const fallbackSerializer = createEpicPageSerializer();
	const runAttempt =
		deps.runAttempt ??
		((input: EpicPageAttemptInput) =>
			runEpicPageAttempt(
				{
					store: deps.store,
					serializer: fallbackSerializer,
					publisher: {
						publishHosted: async (page) =>
							`ok_unpublished:${page.freshness.current.value!.version}:skipped_hosting_not_configured`,
					},
					materialize: (attempt) =>
						materializeEpicPage(
							{
								fetchSnapshot:
									deps.fetchSnapshot ?? fetchLinearActiveScopeSnapshot,
								readAttention: (request, generatedAt) =>
									readAttentionSources(
										{ stateStore: deps.store },
										{
											...request,
											now: generatedAt,
											channelIds:
												deps.projects
													.find((p) => p.projectName === request.projectName)
													?.leads.map((l) => l.chatChannel) ?? [],
										},
									),
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
								generatePage: deps.generatePage ?? generateAttentionEpicPage,
								buildReceipt: deps.buildReceipt ?? buildEpicPageRenderReceipt,
								now,
							},
							{
								...attempt,
								leadNoteFadeDays: deps.projects.find(
									(project) => project.projectName === attempt.projectName,
								)?.epicPage?.leadNoteFadeDays,
							},
						),
					now,
				},
				input,
			));
	return {
		async materializeForScan(project) {
			const binding = resolveProjectLinearBinding(
				deps.projects,
				project.projectName,
			);
			if (!deps.linearApiKey || !binding) {
				return undefined;
			}
			const startedAt = Date.now();
			let result: EpicPageAttemptResult;
			try {
				result = await runAttempt({
					projectName: project.projectName,
					binding,
					apiKey: deps.linearApiKey,
					trigger: "scan",
					reasons: ["scan"],
				});
			} catch (error) {
				const token = "transient: epic_scan_failed";
				(deps.log ?? console.warn)(
					`[patrol_tick] epic scan project=${project.projectName} unavailable=${token}: ${error instanceof Error ? error.message : String(error)}`,
				);
				return {
					kind: "unavailable",
					token,
				};
			}
			if (result.kind === "unavailable") {
				(deps.log ?? console.warn)(
					`[patrol_tick] epic scan project=${project.projectName} unavailable=${result.token}: ${result.error instanceof Error ? result.error.message : String(result.error)}`,
				);
				return { kind: "unavailable", token: result.token };
			}
			const { page, snapshot } = result.materialized;
			if (!snapshot)
				return {
					kind: "unavailable",
					token: "structural: active_scope_not_found",
				};
			(deps.log ?? console.log)(
				`[patrol_tick] epic scan project=${project.projectName} items=${snapshot.items.length} ms=${Math.max(0, Date.now() - startedAt)}`,
			);
			return { kind: "ok", materialized: { page, snapshot } };
		},
		summarizeForLead(materialized, leadId, trigger) {
			if (!materialized) return undefined;
			if (materialized.kind === "unavailable") {
				const fact: EpicResidualFact = {
					schemaVersion: 1,
					kind: "unavailable",
					token: materialized.token,
					trigger,
					generatedAt: null,
					linearObservedAt: null,
				};
				assertEpicResidualFact(fact);
				return fact;
			}
			try {
				return summarizeEpicResidual({
					materialized: materialized.materialized,
					leadId,
					resolveOwner: (labels) =>
						deps.resolveOwner(
							materialized.materialized.page.key.project_name,
							labels,
						),
					trigger,
				});
			} catch (error) {
				const token =
					error instanceof EpicResidualSessionUnreadableError
						? "transient: session_ledger_unreadable"
						: error instanceof EpicResidualFactError
							? "structural: epic_residual_invalid"
							: undefined;
				if (!token) throw error;
				(deps.log ?? console.warn)(
					`[patrol_tick] epic residual project=${materialized.materialized.page.key.project_name} lead=${leadId} unavailable=${token}`,
				);
				const fact: EpicResidualFact = {
					schemaVersion: 1,
					kind: "unavailable",
					token,
					trigger,
					generatedAt: materialized.materialized.page.generated_at,
					linearObservedAt: materialized.materialized.snapshot.fetchedAt,
				};
				assertEpicResidualFact(fact);
				return fact;
			}
		},
	};
}
