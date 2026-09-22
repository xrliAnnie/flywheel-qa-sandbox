import { createHash } from "node:crypto";
import { z } from "zod";
import { evidenceLedgerSchema } from "./evidence-ledger.js";

export const POLICY_VERSION = "ship-judgment-v1";
export const JUDGMENT_PROJECT = "flywheel";
/** Audit only: must never be consumed as a workflow transition or approval instruction. */
export const JUDGMENT_VISIBLE_EVENT = "ship_judgment_visible";
export const JUDGMENT_DELIVERY_ERROR_EVENT = "ship_judgment_delivery_error";
export const DELIVERY_ERROR_AUDIT_MIGRATION =
	"fly-2399-delivery-error-audit-v1";
export const verdictSchema = z.enum(["pass", "fail", "undetermined"]);
export const overallSchema = z.enum([
	"can",
	"cannot",
	"recommend_reject",
	"undetermined",
]);
export const POINT_LABELS = {
	pass: "通过",
	fail: "未通过",
	undetermined: "待补证",
} as const;
export type PointVerdict = z.infer<typeof verdictSchema>;
export type OverallVerdict = z.infer<typeof overallSchema>;
export const OVERALL_LABELS: Record<OverallVerdict, string> = {
	can: "可",
	cannot: "不可",
	recommend_reject: "建议拒",
	undetermined: "不可判定",
};

export function isJudgmentEnabled(project: string, mode: string): boolean {
	return (
		project === JUDGMENT_PROJECT && (mode === "dry_run" || mode === "auto")
	);
}

export function aggregateJudgment(
	alignment: PointVerdict,
	conflict: PointVerdict,
	coverage: PointVerdict,
): OverallVerdict {
	if ([alignment, conflict, coverage].includes("undetermined"))
		return "undetermined";
	if (alignment === "fail" || coverage === "fail") return "recommend_reject";
	return conflict === "fail" ? "cannot" : "can";
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value))
		return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (
		typeof value === "object" &&
		Object.getPrototypeOf(value) === Object.prototype
	) {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	throw new Error("non_json_digest_input");
}

export function canonicalDigest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export const targetSchema = z
	.object({
		repo_identity: z.string().min(1).max(200),
		pr_number: z.number().int().positive().safe(),
		head_sha: z.string().regex(/^[0-9a-f]{40}$/),
		diff_base_sha: z.string().regex(/^[0-9a-f]{40}$/),
	})
	.strict();
export type JudgmentTarget = z.infer<typeof targetSchema>;

export interface ShipJudgmentBinding {
	projectName: "flywheel";
	runId: string;
	questionId: string;
	issueId: string;
	cardMessageId: string;
	threadId: string;
	manifestRevision: number;
	targets: {
		repo_identity: string;
		repo_slug: string;
		pr_number: number;
		head_sha: string;
	}[];
}

export function targetSetDigest(
	targets: JudgmentTarget[],
	manifestRevision: number,
): string {
	const parsed = z.array(targetSchema).min(1).max(200).parse(targets);
	z.number().int().nonnegative().safe().parse(manifestRevision);
	const keys = parsed.map((t) => canonicalJson([t.repo_identity, t.pr_number]));
	if (new Set(keys).size !== keys.length) throw new Error("duplicate_target");
	parsed.sort((a, b) => {
		const left = canonicalJson(a);
		const right = canonicalJson(b);
		return left < right ? -1 : left > right ? 1 : 0;
	});
	return canonicalDigest({
		targets: parsed,
		manifest_revision: manifestRevision,
	});
}

export const citationSchema = z
	.object({
		source_id: z.string().min(1).max(200),
		quote_start: z.number().int().nonnegative().safe(),
		quote_end: z.number().int().positive().safe(),
		quote: z
			.string()
			.refine(
				(text) => Array.from(text).length > 0 && Array.from(text).length <= 500,
			),
		file_path: z.string().min(1).max(1024).optional(),
	})
	.strict();
export type Citation = z.infer<typeof citationSchema>;
export interface FrozenSource {
	source_id: string;
	text: string;
}

export function validateCitation(
	value: unknown,
	sources: FrozenSource[],
	files: string[],
): boolean {
	const parsed = citationSchema.safeParse(value);
	if (!parsed.success) return false;
	const citation = parsed.data;
	const matches = sources.filter(
		(source) => source.source_id === citation.source_id,
	);
	if (
		matches.length !== 1 ||
		(citation.file_path !== undefined && !files.includes(citation.file_path))
	)
		return false;
	const source = matches[0];
	if (!source) return false;
	const points = Array.from(source.text);
	return (
		citation.quote_end > citation.quote_start &&
		citation.quote_end <= points.length &&
		points.slice(citation.quote_start, citation.quote_end).join("") ===
			citation.quote
	);
}

export function clarificationId(
	opinionId: string,
	outcomeId: string,
	reply?: { source_id: string; revision_digest: string },
): string {
	const root = canonicalDigest(["question", opinionId, outcomeId]);
	return reply
		? canonicalDigest(["reply", root, reply.source_id, reply.revision_digest])
		: root;
}

const id = z.string().min(1).max(200);
export const repositorySlugSchema = z
	.string()
	.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
	.refine((value) =>
		value.split("/").every((part) => part !== "." && part !== ".."),
	);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const path = z
	.string()
	.min(1)
	.max(1024)
	.refine(
		(value) =>
			!value.startsWith("/") &&
			!value.includes("\\") &&
			!value.includes("\0") &&
			!value
				.split("/")
				.some((part) => part === "." || part === ".." || part === ""),
	);
export const frozenPacketSchema = z
	.object({
		questionId: id,
		channelId: id,
		bindingDigest: digest,
		targets: z.array(targetSchema).min(1).max(200),
		sources: z
			.array(
				z
					.object({
						source_id: id,
						kind: z.enum([
							"issue",
							"plan",
							"prd",
							"qa",
							"diff",
							"files",
							"revision",
						]),
						revision: z.string().min(1).max(2000),
						text: z.string(),
					})
					.strict(),
			)
			.max(200),
		files: z
			.array(
				z
					.object({ repo_identity: id, path, previous_path: path.optional() })
					.strict(),
			)
			.max(1000),
		requirements: z
			.array(
				z
					.object({
						requirement_id: id,
						source_id: id,
						quote_start: z.number().int().nonnegative(),
						quote_end: z.number().int().positive(),
					})
					.strict(),
			)
			.max(100),
		prompt: z.string().min(1),
		model: z
			.object({ model: id, effort: id, configuration_digest: digest })
			.strict(),
	})
	.strict();
export type FrozenPacket = z.infer<typeof frozenPacketSchema>;

export const opinionCandidateSchema = z
	.object({
		questionId: id,
		channelId: id,
		bindingDigest: digest,
		inputId: id.nullable(),
		evidence: z.lazy(() => evidenceLedgerSchema).optional(),
		reason: z.string().min(1).max(2000),
		mechanical: z
			.object({
				verdict: verdictSchema,
				reason: z.string().min(1).max(2000),
				digest,
				checkedAt: z.string().datetime(),
				scope: z.string().min(1).max(2000),
				checkedRepos: z.number().int().nonnegative().max(200),
				openPrCount: z.number().int().nonnegative().max(200).nullable(),
				overlaps: z
					.array(
						z
							.object({
								repo_identity: id,
								pr_number: z.number().int().positive(),
								path,
							})
							.strict(),
					)
					.max(1000),
			})
			.strict(),
	})
	.strict();
export type OpinionCandidate = z.infer<typeof opinionCandidateSchema>;

export const prFileInventorySchema = z
	.object({
		repo_identity: id,
		pr_number: z.number().int().positive().safe(),
		head_sha: z.string().regex(/^[0-9a-f]{40}$/),
		filesComplete: z.boolean(),
		files: z
			.array(z.object({ path, previous_path: path.optional() }).strict())
			.max(1000),
	})
	.strict();
export type PrFileInventory = z.infer<typeof prFileInventorySchema>;

export const projectSnapshotSchema = z
	.object({
		configurationDigest: digest,
		repositories: z
			.array(
				z
					.object({
						repo_identity: id,
						repo_slug: id,
						main_sha: z.string().regex(/^[0-9a-f]{40}$/),
					})
					.strict(),
			)
			.min(1)
			.max(200),
		prs: z
			.array(
				prFileInventorySchema.extend({
					filesError: z.string().min(1).max(64).optional(),
					base_ref: id,
					base_sha: z.string().regex(/^[0-9a-f]{40}$/),
				}),
			)
			.max(200),
	})
	.strict()
	.refine(
		(snapshot) =>
			snapshot.prs.every(
				(pr) =>
					(pr.filesComplete
						? pr.filesError === undefined
						: pr.files.length === 0 && !!pr.filesError) &&
					snapshot.repositories.some(
						(repo) => repo.repo_identity === pr.repo_identity,
					),
			) &&
			new Set(snapshot.repositories.map((repo) => repo.repo_identity)).size ===
				snapshot.repositories.length &&
			new Set(
				snapshot.prs.map((pr) =>
					canonicalDigest([pr.repo_identity, pr.pr_number]),
				),
			).size === snapshot.prs.length,
		"incomplete_or_duplicate_snapshot",
	);
export type ProjectSnapshot = z.infer<typeof projectSnapshotSchema>;

export const refreshConfigSchema = z
	.object({
		projectName: z.string(),
		repositories: z
			.array(
				z
					.object({
						repo_identity: id,
						repo_slug: repositorySlugSchema,
					})
					.strict(),
			)
			.min(1)
			.max(200),
	})
	.strict();
export const openPrPageSchema = z
	.object({
		items: z
			.array(
				z
					.object({
						pr_number: z.number().int().positive(),
						head_sha: z.string().regex(/^[0-9a-f]{40}$/),
						base_ref: id,
						base_sha: z.string().regex(/^[0-9a-f]{40}$/),
						draft: z.boolean(),
						state: z.literal("open"),
					})
					.strict(),
			)
			.max(100),
		nextPage: z.number().int().positive().nullable(),
	})
	.strict();
export const filePageSchema = z
	.object({
		items: z.array(prFileInventorySchema.shape.files.element).max(100),
		nextPage: z.number().int().positive().nullable(),
	})
	.strict();

export const prIdentitySchema = z
	.object({
		head_sha: z.string().regex(/^[0-9a-f]{40}$/),
		base_ref: id,
		base_sha: z.string().regex(/^[0-9a-f]{40}$/),
		draft: z.boolean(),
		state: z.enum(["open", "closed"]),
		changed_files: z.number().int().nonnegative().max(1000),
	})
	.strict();
