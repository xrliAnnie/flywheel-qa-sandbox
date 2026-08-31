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
	PROJECT_STORE_MANAGED_FLAGS,
	STORE_MANAGED_FLAGS,
} from "flywheel-config";
import { parse as parseYaml } from "yaml";
import type { FlagStoreRuntime } from "./flag-store-runtime.js";
import { isDirectToggleable } from "./flag-toggle.js";
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
	scope: string;
	op: "set" | "clear";
	rawFrom: string | null;
	rawTo: string | null;
	revision?: number;
	expectedChangeSeq?: number;
	effectiveFrom: boolean | string;
	effectiveTo: boolean | string;
	actor: "bridge-local-operator";
	reason: string;
}

export type AnyFlagCanonical = FlagCanonical | FlagStoreCanonical;

export interface FlagRouteDeps {
	readFile: (path: string) => string;
	tokens: ConfirmTokenStore;
	audit: FleetAdminAudit;
	flagStore?: FlagStoreRuntime;
	/** Current authoritative projectName roster from projects.json. */
	projectNames: () => readonly string[];
	/** Resolve the canonical config.yaml path for a rostered project. */
	projectConfigPath: (projectName: string) => string | undefined;
}

export interface RouteResult {
	code: number;
	body: unknown;
}

type ScopedFlagChange = Pick<
	FlagStoreCanonical,
	"name" | "scope" | "op" | "rawTo"
>;

type DocFlowMetadataBlocker = {
	project: string;
	configPath: string;
	reason: "missing" | "unreadable";
	detail?: string;
};

function docFlowEnabledAfterChange(
	deps: FlagRouteDeps,
	change: ScopedFlagChange,
	projectName: string,
): boolean {
	if (!deps.flagStore) return false;
	const codec = getFlagStoreCodec("doc_flow");
	if (!codec) throw new Error("missing managed flag codec: doc_flow");
	const parseRow = (raw: string | null): boolean =>
		codec.parse({ hasOverride: true, raw }) === true;
	const projectRow = deps.flagStore.store.getFlagValueRow(
		"doc_flow",
		projectName,
	);

	if (change.scope === projectName) {
		if (change.op === "set") return parseRow(change.rawTo ?? "");
		const starRow = deps.flagStore.store.getFlagValueRow("doc_flow", "*");
		return starRow ? parseRow(starRow.raw) : false;
	}
	if (change.scope !== "*") return false;
	if (projectRow) return parseRow(projectRow.raw);
	return change.op === "set" ? parseRow(change.rawTo ?? "") : false;
}

function readDocFlowMetadataBlocker(
	deps: FlagRouteDeps,
	projectName: string,
): DocFlowMetadataBlocker | undefined {
	const configPath =
		deps.projectConfigPath(projectName) ??
		`<project:${projectName}>/.flywheel/config.yaml`;
	let parsed: unknown;
	try {
		parsed = parseYaml(deps.readFile(configPath));
	} catch (error) {
		return {
			project: projectName,
			configPath,
			reason: "unreadable",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { project: projectName, configPath, reason: "missing" };
	}
	const docFlow = (parsed as Record<string, unknown>).doc_flow;
	if (!docFlow || typeof docFlow !== "object" || Array.isArray(docFlow)) {
		return { project: projectName, configPath, reason: "missing" };
	}
	const department = (docFlow as Record<string, unknown>).default_department;
	if (typeof department !== "string" || !department.trim()) {
		return { project: projectName, configPath, reason: "missing" };
	}
	return undefined;
}

/**
 * FLY-2103: enablement moved to SQLite while its required path metadata stayed
 * in config.yaml. Reject any scoped write whose resulting doc_flow value would
 * turn a project on without that metadata. This is re-run at apply time so a
 * stage token cannot race a config edit.
 */
function enforceDocFlowEnablementInvariant(
	deps: FlagRouteDeps,
	change: ScopedFlagChange,
): RouteResult | undefined {
	if (change.name !== "doc_flow") return undefined;
	const enabledProjects = deps
		.projectNames()
		.filter((projectName) =>
			docFlowEnabledAfterChange(deps, change, projectName),
		);
	const blockers = enabledProjects
		.map((projectName) => readDocFlowMetadataBlocker(deps, projectName))
		.filter((blocker): blocker is DocFlowMetadataBlocker => Boolean(blocker));
	const [first] = blockers;
	if (!first) return undefined;
	const detail = first.detail ? ` (${first.detail})` : "";
	return {
		code: 409,
		body: {
			error: "doc_flow_enablement_requires_default_department",
			message: `Cannot enable doc_flow for project "${first.project}": doc_flow.default_department is ${first.reason === "missing" ? "missing from" : "not readable in"} ${first.configPath}${detail}. Add a valid doc_flow.default_department to that config.yaml before retrying.`,
			project: first.project,
			configPath: first.configPath,
			blockers,
		},
	};
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
	if (spec.valueKind === "enum" || spec.valueKind === "value")
		return String(to);
	if (spec.polarity === "default_on") return to ? null : "0";
	return to ? "1" : null;
}

export function handleFlagStage(
	deps: FlagRouteDeps,
	input: {
		name: string;
		to?: boolean | string;
		project?: string;
		op?: "set" | "clear";
		reason?: string;
		actor?: string;
	},
	origin: string,
): RouteResult {
	if (typeof input?.name !== "string") {
		return {
			code: 400,
			body: { error: "name (string) is required" },
		};
	}
	const op = input.op ?? "set";
	if (op !== "set" && op !== "clear") {
		return { code: 400, body: { error: "op must be set or clear" } };
	}
	if (
		input.project !== undefined &&
		(typeof input.project !== "string" || !input.project.trim())
	) {
		return { code: 400, body: { error: "project must be a non-empty string" } };
	}
	const scope = input.project?.trim() || "*";
	if (
		op === "set" &&
		typeof input.to !== "boolean" &&
		typeof input.to !== "string"
	) {
		return {
			code: 400,
			body: { error: "set requires to (boolean|string)" },
		};
	}
	const spec = FEATURE_FLAGS.find((f) => f.name === input.name);
	if (!spec) {
		return {
			code: 400,
			body: { error: `unknown feature flag: ${input.name}` },
		};
	}
	if (spec.scope === "bridge_global" && scope !== "*") {
		return {
			code: 400,
			body: { error: `${spec.name} is bridge_global and rejects project rows` },
		};
	}

	if (spec.scope === "project") {
		if (!PROJECT_STORE_MANAGED_FLAGS.has(spec.name)) {
			return {
				code: 400,
				body: { error: `${spec.name} is not project-store-managed` },
			};
		}
		const projectNames = [...deps.projectNames()];
		if (scope !== "*" && !projectNames.includes(scope)) {
			return {
				code: 400,
				body: {
					error: `unknown project scope: ${scope}`,
					allowed: ["*", ...projectNames],
				},
			};
		}
		if (op === "set" && typeof input.to !== "boolean") {
			return {
				code: 400,
				body: { error: `${spec.name} takes a boolean target` },
			};
		}
		if (typeof input.reason !== "string" || !input.reason.trim()) {
			return {
				code: 400,
				body: { error: `${spec.name} requires a non-empty reason` },
			};
		}
		if (!deps.flagStore) {
			return { code: 500, body: { error: "flag store unavailable" } };
		}
		const row = deps.flagStore.store.getFlagValueRow(spec.name, scope);
		const codec = getFlagStoreCodec(spec.name);
		if (!codec) throw new Error(`missing managed flag codec: ${spec.name}`);
		if (op === "clear" && !row) {
			return { code: 409, body: { error: "missing_row" } };
		}
		const rawTo = op === "clear" ? null : input.to ? "1" : "0";
		const invariantFailure = enforceDocFlowEnablementInvariant(deps, {
			name: spec.name,
			scope,
			op,
			rawTo,
		});
		if (invariantFailure) return invariantFailure;
		const canonical: FlagStoreCanonical = {
			kind: "flag_store",
			batchId: newBatchId(),
			name: spec.name,
			scope,
			op,
			rawFrom: row?.raw ?? null,
			rawTo,
			expectedChangeSeq: deps.flagStore.store.getFlagValueChangeSeq(
				spec.name,
				scope,
			),
			effectiveFrom: row
				? codec.parse({ hasOverride: true, raw: row.raw })
				: "inherit",
			effectiveTo: op === "clear" ? "inherit" : (input.to as boolean),
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

	if (op === "clear" && !STORE_MANAGED_FLAGS.has(spec.name)) {
		return {
			code: 400,
			body: { error: "clear is supported only for store-managed flags" },
		};
	}
	if (!spec.envVar || !isDirectToggleable(spec)) {
		return {
			code: 400,
			body: { error: `${input.name} is not direct-toggleable` },
		};
	}
	if (op === "set" && spec.valueKind === "enum") {
		if (typeof input.to !== "string" || !spec.enumValues?.includes(input.to)) {
			return {
				code: 400,
				body: {
					error: `invalid target value for ${spec.name}`,
					allowed: spec.enumValues ?? [],
				},
			};
		}
	} else if (op === "set" && spec.valueKind === "value") {
		if (typeof input.to !== "string") {
			return {
				code: 400,
				body: { error: `${spec.name} takes a string target` },
			};
		}
		try {
			getFlagStoreCodec(spec.name)?.parse({ hasOverride: true, raw: input.to });
		} catch (error) {
			return {
				code: 400,
				body: { error: error instanceof Error ? error.message : String(error) },
			};
		}
	} else if (op === "set" && typeof input.to !== "boolean") {
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
		const row = deps.flagStore.store.getFlagValueRow(spec.name);
		const codec = getFlagStoreCodec(spec.name);
		if (!row || !codec) {
			throw new Error(`missing managed flag row or codec: ${spec.name}`);
		}
		const effectiveTo = op === "clear" ? spec.default : input.to;
		const canonical: FlagStoreCanonical = {
			kind: "flag_store",
			batchId: newBatchId(),
			name: spec.name,
			scope: "*",
			op,
			rawFrom: row.raw,
			rawTo: op === "clear" ? null : computeRawTo(spec, input.to as never),
			revision: row.revision,
			effectiveFrom: codec.parse({
				hasOverride: row.hasOverride,
				raw: row.raw,
			}),
			effectiveTo: effectiveTo as boolean | string,
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
	return {
		code: 500,
		body: { error: `${spec.name}: registry/store invariant violated` },
	};
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
		const spec = FEATURE_FLAGS.find(
			(candidate) => candidate.name === canonical.name,
		);
		if (
			!spec ||
			canonical.actor !== "bridge-local-operator" ||
			typeof canonical.reason !== "string" ||
			!canonical.reason.trim() ||
			typeof canonical.scope !== "string" ||
			!canonical.scope.trim() ||
			(canonical.op !== "set" && canonical.op !== "clear")
		) {
			return { code: 400, body: { error: "invalid managed flag canonical" } };
		}
		if (spec.scope === "project") {
			const projectNames = [...deps.projectNames()];
			if (
				!PROJECT_STORE_MANAGED_FLAGS.has(canonical.name) ||
				(canonical.scope !== "*" && !projectNames.includes(canonical.scope)) ||
				!Number.isInteger(canonical.expectedChangeSeq) ||
				(canonical.expectedChangeSeq ?? -1) < 0 ||
				(canonical.op === "set" &&
					canonical.rawTo !== "0" &&
					canonical.rawTo !== "1") ||
				(canonical.op === "clear" && canonical.rawTo !== null)
			) {
				return {
					code: 400,
					body: {
						error: "invalid project flag canonical",
						allowed: ["*", ...projectNames],
					},
				};
			}
		} else if (
			!STORE_MANAGED_FLAGS.has(canonical.name) ||
			canonical.scope !== "*" ||
			!Number.isInteger(canonical.revision) ||
			(canonical.revision ?? 0) < 1
		) {
			return { code: 400, body: { error: "invalid global flag canonical" } };
		}
		if (!deps.flagStore) {
			return { code: 500, body: { error: "flag store unavailable" } };
		}
		const invariantFailure = enforceDocFlowEnablementInvariant(deps, canonical);
		if (invariantFailure) {
			deps.audit.record({
				batchId: canonical.batchId,
				event: "denied",
				attemptId,
				reason: "doc_flow_enablement_requires_default_department",
				origin,
			});
			return invariantFailure;
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
		const result =
			spec.scope === "project"
				? deps.flagStore.store.applyScopedFlagValueChange({
						name: canonical.name,
						scope: canonical.scope,
						op: canonical.op,
						rawTo: canonical.rawTo,
						expectedChangeSeq: canonical.expectedChangeSeq as number,
						actor: canonical.actor,
						reason: canonical.reason,
					})
				: deps.flagStore.store.applyFlagValueChange({
						name: canonical.name,
						rawTo: canonical.rawTo,
						expectedRevision: canonical.revision as number,
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
	deps.audit.record({
		batchId: canonical.batchId,
		event: "denied",
		attemptId,
		reason: "legacy env flag canonical is retired",
		origin,
	});
	return {
		code: 409,
		body: {
			error: `${canonical.name}: legacy env flag canonical is retired; use flag store`,
		},
	};
}
