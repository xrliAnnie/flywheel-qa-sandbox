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
import {
	type ProjectEntry,
	resolveProjectLinearBinding,
} from "../ProjectConfig.js";
import { readEpicItemFacts, type StateStore } from "../StateStore.js";
import {
	ActiveScopeNotFoundError,
	EpicSnapshotTruncatedError,
	EpicTooLargeError,
	fetchLinearActiveScopeSnapshot,
	type LinearActiveScopeSnapshot,
} from "./linear-epic-query.js";
import { LinearUpstreamError } from "./linear-query.js";

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
	generatePage?: (input: GenerateEpicPageInput) => EpicPage;
	buildReceipt?: (page: EpicPage) => EpicPageRenderReceipt;
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
			let materialized: Awaited<ReturnType<typeof materializeEpicPage>>;
			try {
				materialized = await materializeEpicPage(
					{
						fetchSnapshot: deps.fetchSnapshot ?? fetchLinearActiveScopeSnapshot,
						readItemFacts: (projectName, item) =>
							readEpicItemFacts(deps.store, projectName, item),
						generatePage: deps.generatePage ?? generateEpicPage,
						buildReceipt: deps.buildReceipt ?? buildEpicPageRenderReceipt,
						now: deps.now ?? (() => new Date()),
					},
					{
						projectName: project.projectName,
						binding,
						apiKey: deps.linearApiKey,
						trigger: "scan",
					},
				);
			} catch (error) {
				const token =
					error instanceof LinearUpstreamError
						? "transient: linear_unavailable"
						: error instanceof ActiveScopeNotFoundError
							? "structural: active_scope_not_found"
							: error instanceof EpicTooLargeError
								? "structural: scope_too_large"
								: error instanceof EpicSnapshotTruncatedError
									? "structural: scope_snapshot_truncated"
									: error instanceof EpicPageSchemaError
										? "structural: epic_page_invalid"
										: "transient: epic_scan_failed";
				(deps.log ?? console.warn)(
					`[patrol_tick] epic scan project=${project.projectName} unavailable=${token}: ${error instanceof Error ? error.message : String(error)}`,
				);
				return {
					kind: "unavailable",
					token,
				};
			}
			const { page, snapshot, receipt } = materialized;
			try {
				deps.store.insertEpicPageRenderReceipt({
					projectName: project.projectName,
					trigger: "scan",
					receipt,
				});
			} catch (error) {
				(deps.log ?? console.warn)(
					`[patrol_tick] epic scan project=${project.projectName} receipt_write_failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
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
