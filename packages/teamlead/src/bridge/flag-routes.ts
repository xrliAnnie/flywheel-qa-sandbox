/**
 * FLY-709 P2 — flag stage/apply route handlers (dep-injected, testable).
 *
 * Mirrors the FLY-247 fleet stage→confirmToken→apply pattern for feature-flag
 * toggles. Both toggle entry points (localhost console + the CLI the Lead runs
 * from a phone copy-paste) converge here; the Bridge mounts these behind the
 * same auth as the fleet routes (loopback + same-origin + confirmToken for the
 * console; Bearer for the CLI).
 *
 *  - stage: server computes the canonical change from the CURRENT state (raw
 *    write policy per polarity), records a `staged` audit row with a flag-kind
 *    canonical, and issues a SHA-bound single-use confirmToken.
 *  - apply: verifyAndConsume the token vs the apply-time canonical SHA, then run
 *    the apply core (re-verify fileSha + live rawFrom, persist-first, in-proc
 *    mutate). Records `apply-result` / `denied`.
 *
 * Only `direct`-toggleable flags reach here — the server allow-set is authority,
 * the client's request is not (governance gates + restart-type flags are refused).
 */

import { createHash } from "node:crypto";
import {
	FEATURE_FLAGS,
	type FeatureFlagSpec,
	getFlagStoreCodec,
	STORE_MANAGED_FLAGS,
} from "flywheel-config";
import { computeEnvSha } from "./env-file-writer.js";
import type { FlagStoreRuntime } from "./flag-store-runtime.js";
import { applyFlagToggle, isDirectToggleable } from "./flag-toggle.js";
import type { ConfirmTokenStore } from "./fleet-admin.js";
import { newBatchId } from "./fleet-admin.js";
import type { FleetAdminAudit } from "./fleet-admin-audit.js";

/**
 * The full re-verifiable flag change (raw env values + effective values).
 * FLY-1356: effective values widened to `boolean | string` — enum direct flags
 * (skill_framework_mode) stage a string target from enumValues.
 */
export interface FlagCanonical {
	kind: "flag";
	batchId: string;
	name: string;
	envVar: string;
	rawFrom: string | null;
	rawTo: string | null;
	fileSha: string;
	effectiveFrom: boolean | string;
	effectiveTo: boolean | string;
}

export interface FlagStoreCanonical {
	kind: "flag_store";
	batchId: string;
	name: string;
	rawFrom: string | null;
	rawTo: string | null;
	revision: number;
	effectiveFrom: boolean | string;
	effectiveTo: boolean | string;
	actor: "bridge-local-operator";
	reason: string;
}

export type AnyFlagCanonical = FlagCanonical | FlagStoreCanonical;

export interface FlagRouteDeps {
	envPath: string;
	readFile: (path: string) => string;
	writeFile?: (path: string, content: string) => void;
	env?: Record<string, string | undefined>;
	tokens: ConfirmTokenStore;
	audit: FleetAdminAudit;
	flagStore?: FlagStoreRuntime;
	/** Critical-section lock (plan §4.3); defaults to the real .env file lock. */
	lock?: <T>(fn: () => T) => T;
}

export interface RouteResult {
	code: number;
	body: unknown;
}

/** Stable SHA the confirmToken binds to (canonical, sans nothing volatile). */
export function flagCanonicalSha(c: AnyFlagCanonical): string {
	return createHash("sha256").update(JSON.stringify(c)).digest("hex");
}

/**
 * Raw write policy (plan §4.2): the non-default state is written explicitly, the
 * default state deletes the line. default_on → off writes "0", on deletes;
 * opt_in → on writes "1", off deletes.
 * FLY-1356 enum policy: rawTo = the target value ITSELF, always explicit —
 * target === default writes the default value, never deletes the key (the
 * explicit line is the kill-switch audit trail Annie reads in .env).
 */
function computeRawTo(
	spec: FeatureFlagSpec,
	to: boolean | string,
): string | null {
	if (spec.valueKind === "enum") return String(to);
	if (spec.polarity === "default_on") return to ? null : "0";
	return to ? "1" : null;
}

function effectiveOf(
	spec: FeatureFlagSpec,
	raw: string | null,
): boolean | string {
	if (spec.valueKind === "enum") {
		// Garbage / empty raw displays as the default (the owning resolver fails
		// closed the same way — R1#8 display honesty).
		if (raw !== null && raw !== "" && spec.enumValues?.includes(raw)) {
			return raw;
		}
		return String(spec.default);
	}
	return spec.polarity === "default_on" ? raw !== "0" : raw === "1";
}

export function handleFlagStage(
	deps: FlagRouteDeps,
	input: {
		name: string;
		to: boolean | string;
		reason?: string;
		actor?: string;
	},
	origin: string,
): RouteResult {
	// Validate the JSON boundary — `input` is untyped `req.body`. A non-boolean
	// `to` (e.g. the string "off", which is truthy) would otherwise stage the
	// WRONG target via `computeRawTo`'s truthiness. Reject fail-closed.
	// FLY-1356: enum flags take a STRING `to` that must be one of enumValues.
	if (
		typeof input?.name !== "string" ||
		(typeof input?.to !== "boolean" && typeof input?.to !== "string")
	) {
		return {
			code: 400,
			body: { error: "name (string) and to (boolean|string) are required" },
		};
	}
	const spec = FEATURE_FLAGS.find((f) => f.name === input.name);
	if (!spec || !spec.envVar || !isDirectToggleable(spec)) {
		return {
			code: 400,
			body: { error: `${input.name} is not direct-toggleable` },
		};
	}
	if (spec.valueKind === "enum") {
		if (typeof input.to !== "string" || !spec.enumValues?.includes(input.to)) {
			return {
				code: 400,
				body: {
					error: `invalid target value for ${spec.name}`,
					allowed: spec.enumValues ?? [],
				},
			};
		}
	} else if (typeof input.to !== "boolean") {
		return {
			code: 400,
			body: { error: `${spec.name} takes a boolean target` },
		};
	}
	if (STORE_MANAGED_FLAGS.has(spec.name)) {
		if (typeof input.reason !== "string" || !input.reason.trim()) {
			return {
				code: 400,
				body: { error: `${spec.name} requires a non-empty reason` },
			};
		}
		if (!deps.flagStore) {
			return { code: 500, body: { error: "flag store unavailable" } };
		}
		if (deps.flagStore.mode === "bypass") {
			return {
				code: 409,
				body: {
					error: "managed flag changes are disabled during store bypass",
				},
			};
		}
		const row = deps.flagStore.store.getFlagValueRow(spec.name);
		const codec = getFlagStoreCodec(spec.name);
		if (!row || !codec) {
			throw new Error(`missing managed flag row or codec: ${spec.name}`);
		}
		const canonical: FlagStoreCanonical = {
			kind: "flag_store",
			batchId: newBatchId(),
			name: spec.name,
			rawFrom: row.raw,
			rawTo: computeRawTo(spec, input.to),
			revision: row.revision,
			effectiveFrom: codec.parse({
				hasOverride: row.hasOverride,
				raw: row.raw,
			}),
			effectiveTo: input.to,
			actor: "bridge-local-operator",
			reason: input.reason.trim(),
		};
		if (
			!deps.audit.record({
				batchId: canonical.batchId,
				event: "staged",
				canonicalRequest: JSON.stringify(canonical),
				origin,
			})
		) {
			return {
				code: 500,
				body: { error: "could not record staged flag change" },
			};
		}
		const confirmToken = deps.tokens.issue(flagCanonicalSha(canonical));
		return { code: 200, body: { canonical, confirmToken } };
	}
	const env = deps.env ?? process.env;
	let content: string;
	try {
		content = deps.readFile(deps.envPath);
	} catch (err) {
		return {
			code: 500,
			body: { error: `read .env: ${(err as Error).message}` },
		};
	}
	const rawFrom = env[spec.envVar] ?? null;
	const rawTo = computeRawTo(spec, input.to);
	const canonical: FlagCanonical = {
		kind: "flag",
		batchId: newBatchId(),
		name: spec.name,
		envVar: spec.envVar,
		rawFrom,
		rawTo,
		fileSha: computeEnvSha(content),
		effectiveFrom: effectiveOf(spec, rawFrom),
		effectiveTo: input.to,
	};
	deps.audit.record({
		batchId: canonical.batchId,
		event: "staged",
		canonicalRequest: JSON.stringify(canonical),
		origin,
	});
	const confirmToken = deps.tokens.issue(flagCanonicalSha(canonical));
	return { code: 200, body: { canonical, confirmToken } };
}

export function handleFlagApply(
	deps: FlagRouteDeps,
	canonical: AnyFlagCanonical,
	confirmToken: string,
	origin: string,
): RouteResult {
	const sha = flagCanonicalSha(canonical);
	const attemptId = confirmToken.slice(0, 16);
	const verdict = deps.tokens.verifyAndConsume(confirmToken, sha);
	if (!verdict.ok) {
		deps.audit.record({
			batchId: canonical.batchId,
			event: "denied",
			attemptId,
			reason: verdict.reason,
			origin,
		});
		return { code: 401, body: { error: verdict.reason } };
	}
	if (canonical.kind === "flag_store") {
		if (
			!STORE_MANAGED_FLAGS.has(canonical.name) ||
			canonical.actor !== "bridge-local-operator" ||
			!canonical.reason.trim()
		) {
			return { code: 400, body: { error: "invalid managed flag canonical" } };
		}
		if (!deps.flagStore) {
			return { code: 500, body: { error: "flag store unavailable" } };
		}
		if (deps.flagStore.mode === "bypass") {
			return {
				code: 409,
				body: {
					error: "managed flag changes are disabled during store bypass",
				},
			};
		}
		if (
			!deps.audit.record({
				batchId: canonical.batchId,
				event: "apply-requested",
				canonicalRequest: JSON.stringify(canonical),
				origin,
			})
		) {
			return {
				code: 500,
				body: { error: "could not record apply-requested flag change" },
			};
		}
		const result = deps.flagStore.store.applyFlagValueChange({
			name: canonical.name,
			rawTo: canonical.rawTo,
			expectedRevision: canonical.revision,
			actor: canonical.actor,
			reason: canonical.reason,
		});
		if (!result.ok) {
			deps.audit.record({
				batchId: canonical.batchId,
				event: "denied",
				attemptId,
				reason: result.reason,
				origin,
			});
			return { code: 409, body: { error: result.reason } };
		}
		const audited = deps.audit.record({
			batchId: canonical.batchId,
			event: "apply-result",
			result: "applied",
			origin,
		});
		const warn = audited ? undefined : "apply-result audit write failed";
		if (warn) console.warn(`[flag-store] ${warn}: ${canonical.batchId}`);
		return { code: 200, body: { ok: true, warn } };
	}
	if (STORE_MANAGED_FLAGS.has(canonical.name)) {
		return {
			code: 409,
			body: { error: `${canonical.name} must use the flag store route` },
		};
	}
	const result = applyFlagToggle(
		{
			envPath: deps.envPath,
			readFile: deps.readFile,
			writeFile: deps.writeFile,
			env: deps.env,
			lock: deps.lock,
		},
		{
			name: canonical.name,
			rawFrom: canonical.rawFrom,
			rawTo: canonical.rawTo,
			fileSha: canonical.fileSha,
		},
	);
	if (!result.ok) {
		deps.audit.record({
			batchId: canonical.batchId,
			event: "denied",
			attemptId,
			reason: result.reason,
			origin,
		});
		return { code: result.code, body: { error: result.reason } };
	}
	deps.audit.record({
		batchId: canonical.batchId,
		event: "apply-result",
		result: result.warn ? `applied-with-warning` : "applied",
		reason: result.warn,
		origin,
	});
	return { code: 200, body: { ok: true, warn: result.warn } };
}
