import { z } from "zod";
import { lookupLinearIssueByIdentifier } from "../bridge/linear-query.js";
import type { SourceBody } from "./collect.js";

const issueSchema = z.object({
	id: z.string().uuid(),
	identifier: z.string().regex(/^FLY-[1-9][0-9]*$/),
	title: z.string().min(1),
	description: z.string().nullable(),
	updatedAt: z.string().datetime({ offset: true }),
});

/** Reuses the project Linear adapter, restricted to the exact Flywheel issue. */
export async function readJudgmentIssueSource(
	identifier: string,
	apiKey: string,
	signal: AbortSignal,
	lookup: typeof lookupLinearIssueByIdentifier = lookupLinearIssueByIdentifier,
): Promise<SourceBody | null> {
	try {
		signal.throwIfAborted();
		if (!issueSchema.shape.identifier.safeParse(identifier).success)
			return null;
		const parsed = issueSchema.safeParse(
			await lookup(apiKey, identifier, 20_000),
		);
		signal.throwIfAborted();
		if (!parsed.success || parsed.data.identifier !== identifier) return null;
		const issue = parsed.data;
		const body = `# ${issue.title}\n\n${issue.description ?? ""}`;
		if (Buffer.byteLength(body) > 262_144) return null;
		return {
			body,
			format: "text",
			revision: JSON.stringify({
				id: issue.id,
				identifier,
				updatedAt: issue.updatedAt,
			}),
		};
	} catch {
		return null;
	}
}
