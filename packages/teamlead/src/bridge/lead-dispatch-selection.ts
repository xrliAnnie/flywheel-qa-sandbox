import { getModelRegistryEntry } from "flywheel-config";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { ModelSelection } from "./management-console-contract.js";

/** Registry-backed dispatch value; a missing model stays unpinned. */
export function leadDispatchSelection(
	lead: ProjectEntry["leads"][number],
): ModelSelection | null {
	if (!lead.model) return null;
	const entry = getModelRegistryEntry(lead.model);
	return {
		provider:
			entry?.provider ??
			(lead.backend === "codex-app-server" ? "openai" : "anthropic"),
		model: entry?.id ?? lead.model,
		effort: lead.effort ?? null,
	};
}
