import { z } from "zod";

const token = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const step = z.union([z.number().int().min(1).max(6), z.literal("DWELL")]);
const prose = z.string().min(10).max(4000);
const uuid = z.string().uuid();
export const patrolFindingIdentity = {
	id: hex,
	category: z.enum(["incident", "mechanism_defect"]),
	disposition: z.enum(["existing", "created", "no_issue"]).optional(),
	repairIssue: z
		.string()
		.regex(/^(?:n\/a|FLY-[1-9][0-9]*)$/)
		.optional(),
	repairReceipt: z.union([uuid, z.literal("n/a")]).optional(),
	dispositionRef: token.optional(),
};
export const patrolMechanismInput = {
	mechanismReview: z
		.object({
			result: z.enum(["none", "findings"]),
			count: z.number().int().min(0).max(100),
		})
		.strict()
		.optional(),
	mechanismDeclarations: z
		.array(
			z
				.object({
					id: hex,
					step,
					classKey: hex,
					rootCauseRef: token,
					counterexampleRef: token,
				})
				.strict(),
		)
		.max(100)
		.optional(),
	mechanismDispositions: z
		.array(
			z
				.object({
					ref: token,
					findingId: hex,
					mode: z.enum(["existing", "created", "no_issue"]),
					reason: prose,
					rootCause: prose,
					counterexample: prose,
					issueIdentifier: z
						.string()
						.regex(/^FLY-[1-9][0-9]*$/)
						.nullable(),
					issueUuid: uuid.nullable(),
					issueUrl: z.string().url().max(2048).nullable(),
					receiptUuid: uuid.nullable(),
					verifiedAt: z.string().datetime().nullable(),
					dedupEvidence: z
						.object({
							complete: z.literal(true),
							includeArchived: z.literal(true),
							fullDescriptions: z.literal(true),
							beforeCount: z.union([z.literal(0), z.literal(1)]),
							afterCount: z.literal(1),
							markerVerified: z.literal(true),
							classKey: hex,
							findingId: hex,
							scopeVerified: z.literal(true),
						})
						.strict()
						.nullable(),
					linear_record: z.enum(["issue", "comment", "not_applicable"]),
				})
				.strict(),
		)
		.max(100)
		.optional(),
	// FLY-2914: one record per listed root-cause category (report line ROOT_CAUSE_DISPOSITION).
	rootCauseDispositions: z
		.array(
			z
				.object({
					ref: token,
					findingId: hex,
					scheduleKey: hex,
					mode: z.enum(["reported", "waiting_founder", "scheduled"]),
					askId: uuid.nullable(),
					threadId: z
						.string()
						.regex(/^[0-9]{5,25}$/)
						.nullable(),
					messageId: z
						.string()
						.regex(/^[0-9]{5,25}$/)
						.nullable(),
					reason: prose.nullable(),
					owner: z
						.string()
						.regex(/^(?:founder|agent:[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/)
						.nullable(),
					nextReviewAt: z.string().datetime().nullable(),
					sourceDigest: hex,
				})
				.strict(),
		)
		.max(100)
		.optional(),
};

/** Declarations are append-only identities; no request may hide a prior defect. */
export function mergePatrolMechanisms(
	lines: string[],
	input: Record<string, unknown>,
): string[] {
	const declarations = z
		.array(patrolMechanismInput.mechanismDeclarations.unwrap().element)
		.parse(input.mechanismDeclarations ?? []);
	const dispositions = z
		.array(patrolMechanismInput.mechanismDispositions.unwrap().element)
		.parse(input.mechanismDispositions ?? []);
	const rootCauses = z
		.array(patrolMechanismInput.rootCauseDispositions.unwrap().element)
		.parse(input.rootCauseDispositions ?? []);
	const result = [...lines];
	const fail = () => {
		throw new Error("patrol_judgment_invalid");
	};
	for (const declaration of declarations) {
		const line = `MECHANISM_DEFECT id=${declaration.id} step=${declaration.step} class_key=${declaration.classKey} root_cause_ref=${declaration.rootCauseRef} counterexample_ref=${declaration.counterexampleRef}`;
		const prior = result.filter(
			(v) =>
				v.startsWith("MECHANISM_DEFECT ") &&
				v.split(" ").includes(`id=${declaration.id}`),
		);
		if (prior.length > 1 || (prior.length === 1 && prior[0] !== line)) fail();
		if (prior.length === 0) result.push(line);
	}
	for (const disposition of dispositions) {
		const indices = result.flatMap((v, i) => {
			if (!v.startsWith("MECHANISM_DISPOSITION ")) return [];
			const prior = JSON.parse(v.slice("MECHANISM_DISPOSITION ".length));
			if (prior.ref !== disposition.ref) return [];
			if (prior.findingId !== disposition.findingId) fail();
			return [i];
		});
		if (indices.length > 1) fail();
		const line = `MECHANISM_DISPOSITION ${JSON.stringify(disposition)}`;
		if (indices.length) result[indices[0]!] = line;
		else result.push(line);
	}
	// Upsert by schedule key; the snapshot's candidate lines are never touched here.
	for (const disposition of rootCauses) {
		const indices = result.flatMap((v, i) => {
			if (!v.startsWith("ROOT_CAUSE_DISPOSITION ")) return [];
			try {
				const prior = JSON.parse(v.slice("ROOT_CAUSE_DISPOSITION ".length));
				return prior.scheduleKey === disposition.scheduleKey ? [i] : [];
			} catch {
				return fail();
			}
		});
		if (indices.length > 1) fail();
		const line = `ROOT_CAUSE_DISPOSITION ${JSON.stringify(disposition)}`;
		if (indices.length) result[indices[0]!] = line;
		else result.push(line);
	}
	const review = patrolMechanismInput.mechanismReview.parse(
		input.mechanismReview,
	);
	if (review) {
		const count = result.filter((v) =>
			v.startsWith("MECHANISM_DEFECT "),
		).length;
		if (
			review.count !== count ||
			review.result !== (count ? "findings" : "none")
		)
			fail();
		const indices = result.flatMap((v, i) =>
			v.startsWith("MECHANISM_REVIEW ") ? [i] : [],
		);
		if (indices.length !== 1) fail();
		result[indices[0]!] =
			`MECHANISM_REVIEW result=${review.result} count=${review.count}`;
	}
	return result;
}
