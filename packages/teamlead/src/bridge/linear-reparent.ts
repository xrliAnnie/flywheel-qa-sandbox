import type { ProjectLinearBinding } from "../ProjectConfig.js";
import {
	type LinearIssue,
	lookupLinearIssueByIdentifier,
} from "./linear-query.js";
import { issueMatchesBinding } from "./linear-scope.js";

export class LinearReparentError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "LinearReparentError";
	}
}

/** Validate the whole proposed ancestry before mutating the original issue. */
export async function prepareLinearReparent(
	apiKey: string,
	issueId: string,
	parentId: string | null,
	binding: ProjectLinearBinding,
): Promise<{ source: LinearIssue; parentId: string | null }> {
	const deadline = Date.now() + 10_000;
	const lookup = async (id: string) => {
		const remaining = deadline - Date.now();
		if (remaining <= 0)
			throw new LinearReparentError(502, "parent validation timed out");
		const issue = await lookupLinearIssueByIdentifier(apiKey, id, remaining);
		if (!issue) throw new LinearReparentError(404, "issue or parent not found");
		if (!issueMatchesBinding(issue, binding)) {
			throw new LinearReparentError(
				403,
				"issue or parent is outside the project scope",
			);
		}
		return issue;
	};
	const source = await lookup(issueId);
	if (parentId === null) return { source, parentId: null };
	let ancestor = await lookup(parentId);
	const resolvedParentId = ancestor.id;
	const seen = new Set<string>([source.id]);
	for (let depth = 0; depth < 100; depth++) {
		if (seen.has(ancestor.id))
			throw new LinearReparentError(
				400,
				"parent relationship would contain a cycle",
			);
		seen.add(ancestor.id);
		if (
			source.identifier.split("-")[0] !== ancestor.identifier.split("-")[0] ||
			source.project !== ancestor.project ||
			source.projectId !== ancestor.projectId
		) {
			throw new LinearReparentError(
				403,
				"parent must be in the same team and project",
			);
		}
		if (source.projectId === undefined || ancestor.projectId === undefined) {
			throw new LinearReparentError(
				502,
				"project identity missing from Linear response",
			);
		}
		if (ancestor.parent === null) return { source, parentId: resolvedParentId };
		if (!ancestor.parent?.id)
			throw new LinearReparentError(
				502,
				"parent ancestry missing from Linear response",
			);
		ancestor = await lookup(ancestor.parent.id);
	}
	throw new LinearReparentError(
		400,
		"parent ancestry exceeds validation limit",
	);
}
