import type { LinearActiveScopeSnapshot } from "../bridge/linear-epic-query.js";
import { EpicTooLargeError } from "../bridge/linear-epic-query.js";
import type { ProjectLinearBinding } from "../ProjectConfig.js";
import type { EpicItemFacts, EpicPageTrigger } from "../StateStore.js";
import type { GenerateEpicPageInput } from "./generate.js";
import { assertEpicPage, type EpicPage } from "./model.js";
import type { EpicPageRenderReceipt } from "./receipt.js";

export const MAX_EPIC_SCOPE_ITEMS = 500;

export interface MaterializeEpicPageDeps {
	fetchSnapshot: (
		apiKey: string,
		binding: ProjectLinearBinding,
	) => Promise<LinearActiveScopeSnapshot>;
	readItemFacts: (
		projectName: string,
		item: { uuid: string; identifier: string },
	) => EpicItemFacts;
	generatePage: (input: GenerateEpicPageInput) => EpicPage;
	buildReceipt: (page: EpicPage) => EpicPageRenderReceipt;
	now: () => Date;
}

export interface MaterializeEpicPageInput {
	projectName: string;
	binding: ProjectLinearBinding;
	apiKey: string;
	trigger: EpicPageTrigger;
}

export async function materializeEpicPage(
	deps: MaterializeEpicPageDeps,
	input: MaterializeEpicPageInput,
): Promise<{
	page: EpicPage;
	snapshot: LinearActiveScopeSnapshot;
	receipt: EpicPageRenderReceipt;
}> {
	const snapshot = await deps.fetchSnapshot(input.apiKey, input.binding);
	if (snapshot.items.length > MAX_EPIC_SCOPE_ITEMS) {
		throw new EpicTooLargeError(
			`Active scope exceeds ${MAX_EPIC_SCOPE_ITEMS} issues`,
		);
	}
	const itemFacts = snapshot.items.map((item) =>
		deps.readItemFacts(input.projectName, {
			uuid: item.id,
			identifier: item.identifier,
		}),
	);
	const page = deps.generatePage({
		snapshot,
		itemFacts,
		now: deps.now(),
		projectName: input.projectName,
		trigger: input.trigger,
	});
	assertEpicPage(page);
	return {
		page,
		snapshot,
		receipt: deps.buildReceipt(page),
	};
}
