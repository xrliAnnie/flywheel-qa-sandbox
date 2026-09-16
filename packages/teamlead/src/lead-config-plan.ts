import { createHash } from "node:crypto";
import {
	type CompiledLeadIdentityRow,
	type CompileLeadIdentityRegistryOptions,
	compileLeadIdentityRows,
} from "flywheel-comm/lead-identity";
import {
	canonicalSubmissionDigest,
	type ModelConfigSnapshot,
} from "flywheel-config";

export interface LeadTuningFields {
	model?: string;
	effort?: string;
}
const efforts = new Set(["low", "medium", "high", "xhigh", "max"]);
function fields(value: unknown, allowEmpty: boolean): LeadTuningFields {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid_tuning_fields");
	const raw = value as Record<string, unknown>;
	if (
		Object.keys(raw).some((key) => key !== "model" && key !== "effort") ||
		(!allowEmpty && Object.keys(raw).length === 0)
	)
		throw new Error("invalid_tuning_fields");
	for (const [key, value] of Object.entries(raw)) {
		if (
			typeof value !== "string" ||
			!value.trim() ||
			value !== value.trim() ||
			value.length > 256 ||
			Array.from(value).some(
				(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
			)
		)
			throw new Error(`invalid_${key}`);
		if (key === "effort" && !efforts.has(value))
			throw new Error("invalid_effort");
	}
	return { ...raw } as LeadTuningFields;
}
function tuning(row: CompiledLeadIdentityRow): LeadTuningFields {
	return fields(
		Object.fromEntries(
			["model", "effort"]
				.filter((key) => Object.hasOwn(row.lead, key))
				.map((key) => [key, row.lead[key]]),
		),
		true,
	);
}
function sha(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

/** Pure candidate preparation. File/schema/summary-receipt validation and locking belong to the caller. */
export function planLeadConfigChange(input: {
	source: string;
	projectName: string;
	leadId: string;
	patch?: unknown;
	/** Internal rollback only: complete former field image, including absence. */
	restore?: unknown;
	/** Must come from a validated native configuration, never inferred from model ordering. */
	defaults?: { model: string; effort: string };
	modelSnapshot: ModelConfigSnapshot;
	identityOptions?: CompileLeadIdentityRegistryOptions;
}) {
	if ((input.patch === undefined) === (input.restore === undefined))
		throw new Error("exactly_one_tuning_change_required");
	const raw: unknown = JSON.parse(input.source);
	const rows = compileLeadIdentityRows(raw, input.identityOptions);
	const matches = rows.filter(
		(row) =>
			row.identity.projectName === input.projectName &&
			row.identity.leadId === input.leadId,
	);
	if (matches.length !== 1) throw new Error("lead_identity_not_found");
	const row = matches[0]!;
	if (row.identity.backend !== "codex-app-server")
		throw new Error("backend_change_not_hot");
	const preimage = tuning(row);
	const postimage =
		input.restore === undefined
			? { ...preimage, ...fields(input.patch, false) }
			: fields(input.restore, true);
	const model = postimage.model ?? input.defaults?.model;
	const effort = postimage.effort ?? input.defaults?.effort;
	if (!model || !effort) throw new Error("runtime_defaults_unavailable");
	const entry = input.modelSnapshot.getModelRegistryEntry(model);
	if (entry && entry.runtimeVendor !== "codex")
		throw new Error("backend_change_not_hot");
	if (
		!entry ||
		!efforts.has(effort) ||
		!input.modelSnapshot.isModelSelectionSupported({
			surface: "lead",
			model,
			effort,
			runtimeVendor: "codex",
		})
	)
		throw new Error("unsupported_lead_model_selection");
	const window = row.identity.modelContextWindow;
	const priorModel = preimage.model
		? input.modelSnapshot.getModelRegistryEntry(preimage.model)?.id
		: undefined;
	if (
		window !== undefined &&
		priorModel !== entry.id &&
		(entry.contextWindowTokens === undefined ||
			window > entry.contextWindowTokens)
	)
		throw new Error("context_window_incompatible");
	// Only these two assignments can touch the parsed registry; no object reconstruction loses unknown fields.
	for (const key of ["model", "effort"] as const) {
		if (postimage[key] === undefined) delete row.lead[key];
		else row.lead[key] = postimage[key];
	}
	const candidate = `${JSON.stringify(raw, null, 2)}\n`;
	const after = compileLeadIdentityRows(
		JSON.parse(candidate),
		input.identityOptions,
	);
	if (
		rows.length !== after.length ||
		rows.some(
			(prior, index) =>
				prior.identity.identityDigest !== after[index]!.identity.identityDigest,
		)
	)
		throw new Error("lead_identity_changed");
	const identity = after.find(
		(candidate) => candidate.identity.leadKey === row.identity.leadKey,
	)!.identity;
	// Verify the entire JSON structure after restoring the exact former tuning fields.
	for (const key of ["model", "effort"] as const) {
		if (preimage[key] === undefined) delete row.lead[key];
		else row.lead[key] = preimage[key];
	}
	if (
		canonicalSubmissionDigest(raw) !==
		canonicalSubmissionDigest(JSON.parse(input.source))
	)
		throw new Error("non_tuning_field_changed");
	const resolved = { model: entry.id, effort };
	return {
		candidate,
		identity,
		preimage,
		postimage,
		resolved,
		preProjectsSha: sha(input.source),
		postProjectsSha: sha(candidate),
		modelRegistryRevision: input.modelSnapshot.revision,
		configDigest: canonicalSubmissionDigest({
			leadKey: identity.leadKey,
			identityDigest: identity.identityDigest,
			postimage,
			resolved,
			modelRegistryRevision: input.modelSnapshot.revision,
		}),
	};
}
