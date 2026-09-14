import type { SourceBody } from "./collect.js";
import { prFileInventorySchema } from "./contract.js";
import type { FrozenGitReader } from "./git-input.js";

export interface ReviewedPlanReference {
	requestId: string;
	path: string;
	expectedBlobSha?: string;
}

/** Resolve the reviewed path in the target tree, never in a mutable worktree. */
export async function readReviewedPlanSource(
	reference: ReviewedPlanReference | undefined,
	headSha: string,
	reader: Pick<FrozenGitReader, "readText">,
): Promise<SourceBody | null> {
	if (
		!reference ||
		!/^[a-f0-9]{40}$/.test(headSha) ||
		!prFileInventorySchema.shape.files.element.shape.path.safeParse(
			reference.path,
		).success
	)
		return null;
	try {
		const blob = await reader.readText(headSha, reference.path);
		if (reference.expectedBlobSha && reference.expectedBlobSha !== blob.blobSha)
			return null;
		return {
			body: blob.text,
			format: reference.path.endsWith(".html") ? "html" : "text",
			revision: JSON.stringify({
				review: reference.requestId,
				path: reference.path,
				blob: blob.blobSha,
			}),
		};
	} catch {
		return null;
	}
}
