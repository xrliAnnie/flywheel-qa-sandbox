/**
 * FLY-222: prune-gate FINAL response validator (plan §2.3 ①).
 *
 * This is the ALL-PATHS fail-close invariant — the REAL product-safety gate,
 * independent of `gate`/`respond` release semantics. The blocking prune gate
 * (`xiaohongshu_prune`) resolves on the FIRST response and `respond` writes ANY
 * text (gate.ts/respond.ts — only `approve_to_ship` is hard-gated), so a stray
 * Lead thread message can mis-release the gate. Therefore, BEFORE any Linear or
 * memory side-effect, the Runner MUST validate that the response it got is a
 * well-formed FINAL envelope BOUND to this run's key. Anything else —
 * malformed, non-FINAL, a casual follow-up, a replayed/stale FINAL for another
 * run — is rejected, and the Runner does zero side-effects + leaves state
 * recoverable (does NOT advance) + alerts.
 *
 * Envelope (plan §2.3): {"final": true, "runKey": "<K>", "keep": [...],
 * "edits": {...}, "learnings": [...]}. `runKey` binds the decision to exactly
 * this run (the gate question carried it; the Lead echoes it in the FINAL).
 */

export interface FinalEnvelope {
	final: true;
	/** Echoes the run key the gate was opened with — binds the decision to THIS run. */
	runKey: string;
	/** Candidate ids of the issue drafts Annie kept (→ create as Linear issues). */
	keep: string[];
	/** Optional per-candidate edits (skill interprets the inner shape). */
	edits?: Record<string, unknown>;
	/** Optional learning ids to record to memory (path B, gated behind FINAL too). */
	learnings?: string[];
}

export type FinalValidation =
	| { valid: true; final: FinalEnvelope }
	| { valid: false; reason: string };

/** Optional candidate manifests to bind the FINAL to what was actually presented. */
export interface FinalValidateOpts {
	/** If provided, every `keep` id (and `edits` key) MUST be one of these. */
	candidateIds?: string[];
	/** If provided, every `learnings` id MUST be one of these. */
	learningIds?: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Validate an id list: array of NON-empty, UNIQUE strings; and — when an
 * `allowed` manifest is given — every id must be one presented at the gate (no
 * fabricated/unknown ids slip through the authority boundary).
 */
function validateIdList(
	v: unknown,
	field: string,
	allowed?: string[],
): { ok: true; ids: string[] } | { ok: false; reason: string } {
	if (!isStringArray(v)) {
		return { ok: false, reason: `\`${field}\` must be an array of strings` };
	}
	const allow = allowed ? new Set(allowed) : null;
	const seen = new Set<string>();
	for (const id of v) {
		if (id.trim() === "") {
			return { ok: false, reason: `\`${field}\` contains an empty id` };
		}
		if (seen.has(id)) {
			return {
				ok: false,
				reason: `\`${field}\` contains a duplicate id ${JSON.stringify(id)}`,
			};
		}
		seen.add(id);
		if (allow && !allow.has(id)) {
			return {
				ok: false,
				reason: `\`${field}\` id ${JSON.stringify(id)} was not a presented candidate`,
			};
		}
	}
	return { ok: true, ids: v };
}

/**
 * Validate a raw prune-gate response string against the FINAL envelope schema +
 * the expected run key. Pure + total: never throws, returns a discriminated
 * result. Fail-close: ANYTHING that is not a perfectly-formed, run-key-bound
 * FINAL is `{ valid: false }`.
 */
export function validateFinalResponse(
	raw: string,
	expectedRunKey: string,
	opts: FinalValidateOpts = {},
): FinalValidation {
	if (typeof expectedRunKey !== "string" || expectedRunKey.trim() === "") {
		return { valid: false, reason: "expected run key is empty" };
	}
	if (typeof raw !== "string" || raw.trim() === "") {
		return { valid: false, reason: "empty response" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// A casual Lead thread message (not JSON) lands here → fail-close.
		return { valid: false, reason: "response is not valid JSON" };
	}

	if (!isPlainObject(parsed)) {
		return { valid: false, reason: "response is not a JSON object" };
	}

	// `final` must be the boolean literal true — not 1, "true", or truthy.
	if (parsed.final !== true) {
		return { valid: false, reason: "missing or non-true `final` flag" };
	}

	if (typeof parsed.runKey !== "string" || parsed.runKey.trim() === "") {
		return { valid: false, reason: "missing `runKey`" };
	}
	if (parsed.runKey !== expectedRunKey) {
		// Stale/replayed FINAL for a different run → fail-close (no side-effects).
		return {
			valid: false,
			reason: `run key mismatch (expected ${expectedRunKey})`,
		};
	}

	const keepRes = validateIdList(parsed.keep, "keep", opts.candidateIds);
	if (!keepRes.ok) return { valid: false, reason: keepRes.reason };
	const keepSet = new Set(keepRes.ids);

	// `edits` (optional): a mapping of candidate id → edit object. Each key must be
	// a KEPT candidate (you cannot edit a draft you did not keep), each value must
	// be an object, and any title/body/summary it carries must be a non-empty
	// string (reject null / non-string — they would corrupt the created issue).
	if (parsed.edits !== undefined) {
		if (!isPlainObject(parsed.edits)) {
			return { valid: false, reason: "`edits` must be an object when present" };
		}
		for (const [k, v] of Object.entries(parsed.edits)) {
			if (!keepSet.has(k)) {
				return {
					valid: false,
					reason: `\`edits\` key ${JSON.stringify(k)} is not in \`keep\``,
				};
			}
			if (!isPlainObject(v)) {
				return {
					valid: false,
					reason: `\`edits.${k}\` must be an object`,
				};
			}
			for (const f of ["title", "body", "summary"] as const) {
				if (
					f in v &&
					(typeof v[f] !== "string" || (v[f] as string).trim() === "")
				) {
					return {
						valid: false,
						reason: `\`edits.${k}.${f}\` must be a non-empty string when present`,
					};
				}
			}
		}
	}

	let learnings: string[] | undefined;
	if (parsed.learnings !== undefined) {
		const lRes = validateIdList(
			parsed.learnings,
			"learnings",
			opts.learningIds,
		);
		if (!lRes.ok) return { valid: false, reason: lRes.reason };
		learnings = lRes.ids;
	}

	const final: FinalEnvelope = {
		final: true,
		runKey: parsed.runKey,
		keep: keepRes.ids,
		...(parsed.edits !== undefined
			? { edits: parsed.edits as Record<string, unknown> }
			: {}),
		...(learnings !== undefined ? { learnings } : {}),
	};
	return { valid: true, final };
}
