import type { LinearActiveScopeSnapshot } from "../bridge/linear-epic-query.js";
import {
	ActiveScopeNotFoundError,
	EpicTooLargeError,
} from "../bridge/linear-epic-query.js";
import type { ProjectLinearBinding } from "../ProjectConfig.js";
import type {
	EpicItemFacts,
	EpicPageTrigger,
	LeadNoteRecord,
} from "../StateStore.js";
import type { AttentionInput } from "./attention.js";
import { applyAttentionBudget } from "./attention-budget.js";
import type {
	GenerateAttentionEpicPageInput,
	GenerateEpicPageInput,
} from "./generate.js";
import { assertEpicPage, type EpicPage } from "./model.js";
import {
	hostedBudgetHtml,
	renderEpicPageBudgetBundle,
} from "./optional-budget.js";
import type { EpicPageRenderReceipt } from "./receipt.js";
import type { EpicPageItemSignals } from "./signals.js";

export const MAX_EPIC_SCOPE_ITEMS = 500;

export interface MaterializeEpicPageDeps {
	readDeployment?: (projectName: string) => GenerateEpicPageInput["deployment"];
	readVoiceHealth?: (
		projectName: string,
	) => GenerateEpicPageInput["voiceHealth"];
	readIntakes?: (projectName: string) => GenerateEpicPageInput["intakes"];
	readChildThreads?: (
		projectName: string,
		items: LinearActiveScopeSnapshot["items"],
		now: Date,
	) => NonNullable<GenerateEpicPageInput["childThreads"]>;
	readShipJudgmentHistory?: (
		asOf: string,
	) => NonNullable<GenerateEpicPageInput["shipJudgmentHistory"]>;
	readAttention: (
		input: MaterializeEpicPageInput,
		now: Date,
		scopeSnapshot?: Promise<LinearActiveScopeSnapshot | null>,
	) => Promise<AttentionInput>;
	readLeadNotes: (
		projectName: string,
		issueUuids: string[],
	) => LeadNoteRecord[];
	fetchSnapshot: (
		apiKey: string,
		binding: ProjectLinearBinding,
	) => Promise<LinearActiveScopeSnapshot>;
	readItemFacts: (
		projectName: string,
		item: { uuid: string; identifier: string },
		generatedAt: Date,
	) => EpicItemFacts;
	readSignals: (
		projectName: string,
		items: Array<{ uuid: string; identifier: string }>,
		now: Date,
	) => EpicPageItemSignals[];
	readFreshness: (
		projectName: string,
	) => NonNullable<GenerateEpicPageInput["freshness"]>;
	generatePage: (input: GenerateAttentionEpicPageInput) => EpicPage;
	buildReceipt: (page: EpicPage) => EpicPageRenderReceipt;
	now: () => Date;
}

export interface MaterializeEpicPageInput {
	leadNoteFadeDays?: number;
	projectName: string;
	binding: ProjectLinearBinding;
	apiKey: string;
	trigger: EpicPageTrigger;
	version: number;
	reasons: GenerateEpicPageInput["reasons"];
	scanSchedule?: { leadId: string; intervalMs: number };
}

export async function materializeEpicPage(
	deps: MaterializeEpicPageDeps,
	input: MaterializeEpicPageInput,
): Promise<{
	page: EpicPage;
	snapshot: LinearActiveScopeSnapshot | null;
	receipt: EpicPageRenderReceipt;
}> {
	const generatedAt = deps.now();
	const scopeSnapshot = deps
		.fetchSnapshot(input.apiKey, input.binding)
		.catch((error) => {
			if (
				error instanceof ActiveScopeNotFoundError &&
				(error.reason === "no_active_roots" ||
					error.reason === "missing_daily_root")
			)
				return null;
			throw error;
		});
	const [snapshot, attention] = await Promise.all([
		scopeSnapshot,
		deps.readAttention(input, generatedAt, scopeSnapshot),
	]);
	if (snapshot && snapshot.items.length > MAX_EPIC_SCOPE_ITEMS) {
		throw new EpicTooLargeError(
			`Active scope exceeds ${MAX_EPIC_SCOPE_ITEMS} issues`,
		);
	}
	const itemFacts = (snapshot?.items ?? []).map((item) =>
		deps.readItemFacts(
			input.projectName,
			{
				uuid: item.id,
				identifier: item.identifier,
			},
			generatedAt,
		),
	);
	const itemSignals = deps.readSignals(
		input.projectName,
		(snapshot?.items ?? []).map((item) => ({
			uuid: item.id,
			identifier: item.identifier,
		})),
		generatedAt,
	);
	const freshness = deps.readFreshness(input.projectName);
	const leadNotes = deps.readLeadNotes(input.projectName, [
		...new Set(
			[...(snapshot?.roots ?? []), ...(snapshot?.items ?? [])].map(
				(item) => item.id,
			),
		),
	]);
	const shipJudgmentHistory =
		input.projectName === "flywheel"
			? deps.readShipJudgmentHistory?.(generatedAt.toISOString())
			: undefined;
	const candidate = deps.generatePage({
		deployment: deps.readDeployment?.(input.projectName),
		voiceHealth: deps.readVoiceHealth?.(input.projectName),
		...(shipJudgmentHistory ? { shipJudgmentHistory } : {}),
		childThreads: deps.readChildThreads?.(
			input.projectName,
			snapshot?.items ?? [],
			generatedAt,
		),
		leadNotes,
		intakes: deps.readIntakes?.(input.projectName),
		leadNoteFadeDays: input.leadNoteFadeDays,
		snapshot,
		attention,
		scopeBinding: input.binding,
		deferSizeValidation: true,
		itemFacts,
		itemSignals,
		freshness: {
			...freshness,
			...(input.scanSchedule ? { scanSchedule: input.scanSchedule } : {}),
		},
		now: generatedAt,
		projectName: input.projectName,
		trigger: input.trigger,
		version: input.version,
		reasons: input.reasons,
	});
	const page =
		candidate.schema_version === 2
			? applyAttentionBudget(candidate, (page) =>
					hostedBudgetHtml(renderEpicPageBudgetBundle(page, generatedAt)),
				)
			: candidate;
	assertEpicPage(page);
	return {
		page,
		snapshot,
		receipt: deps.buildReceipt(page),
	};
}
