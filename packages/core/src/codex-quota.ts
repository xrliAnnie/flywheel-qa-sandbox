import { z } from "zod";

const identity = z
	.string()
	.min(1)
	.max(512)
	.regex(/^[^\s\p{Cc}]+$/u);

/** Wire contract. Account identity comes exclusively from a registered binding. */
export const codexQuotaSignalV1Schema = z.strictObject({
	version: z.literal(1),
	vendor: z.literal("codex"),
	source: z.enum(["goal_ended", "review_exec"]),
	sourceEventId: identity,
	bindingId: identity,
	evidence: z.enum(["usageLimited", "usageLimitExceeded"]),
	observedAt: z
		.string()
		.max(40)
		.pipe(z.iso.datetime({ offset: true })),
});
export type CodexQuotaSignalV1 = z.infer<typeof codexQuotaSignalV1Schema>;

export const codexQuotaBindingV1Schema = z.strictObject({
	bindingId: identity,
	executionId: identity,
	runId: identity.nullable(),
	accountKey: identity,
	profile: identity,
	generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	credentialRootKey: identity,
	purpose: z.enum(["runner", "review"]),
});
export type CodexQuotaBindingV1 = z.infer<typeof codexQuotaBindingV1Schema>;

export function parseCodexQuotaSignalV1(
	value: unknown,
): CodexQuotaSignalV1 | undefined {
	const result = codexQuotaSignalV1Schema.safeParse(value);
	return result.success ? result.data : undefined;
}
export function parseCodexQuotaBindingV1(
	value: unknown,
): CodexQuotaBindingV1 | undefined {
	const result = codexQuotaBindingV1Schema.safeParse(value);
	return result.success ? result.data : undefined;
}

export const CODEX_QUOTA_FAILURE_REASON =
	"goal ended non-complete: usageLimited";
