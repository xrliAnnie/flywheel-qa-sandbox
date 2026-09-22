import type { CompiledLeadIdentityRow } from "flywheel-comm/lead-identity";
import { resolveCodexLeadCapabilities } from "flywheel-config";
import { RUNNER_ACTION_TOOL_NAMES } from "../lead-backends/codex/runner-action-names.js";
import { getLeadCapability, LEAD_CAPABILITY_CATALOG } from "./catalog.js";

const VOICE_OPERATION_IDS = new Set([
	"voice.session.start",
	"voice.session.status",
	"voice.session.stop",
]);

/** Trusted configuration inputs, never fields accepted from a model operation. */
export interface LeadCapabilityResolutionInput {
	row: CompiledLeadIdentityRow;
	integrationIds: readonly string[];
	handlerOperationIds: readonly string[];
	adoptedMenuShapes: readonly string[];
}

/**
 * Configuration projection only. The broker must re-read current registry/lease
 * before dispatch and each handler must enforce target scope (including excludes).
 * Missing providers stay visible as gaps rather than becoming enabled tools.
 */
export function resolveLeadCapabilities(input: LeadCapabilityResolutionInput) {
	const { row } = input;
	if (row.lead.codexCapabilityBundleVersion === undefined) return null;
	const capability = resolveCodexLeadCapabilities(row.lead);
	if (!capability.eligible || capability.capabilityBundleVersion !== 2)
		throw new Error("invalid current Lead capability bundle");
	if (row.identity.role !== "dept")
		throw new Error("capability bundle requires department identity");
	if (
		row.identity.leadId !== row.lead.agentId ||
		row.identity.projectName !== row.project.projectName ||
		row.identity.backend !== row.lead.backend
	)
		throw new Error("capability identity mismatch");
	const integrations = new Set(input.integrationIds);
	const handlers = new Set(input.handlerOperationIds);
	for (const operationId of handlers) {
		const operation = getLeadCapability(operationId);
		if (!operation) throw new Error("unknown capability handler");
		if (operation.classification === "reserved")
			throw new Error("reserved capability cannot have a handler");
	}
	const runnerEnabled =
		capability.runnerActionsEnabled &&
		integrations.has("bridge") &&
		input.adoptedMenuShapes.length > 0 &&
		RUNNER_ACTION_TOOL_NAMES.every((name) => handlers.has(name));
	const operations = LEAD_CAPABILITY_CATALOG.filter(
		(op) =>
			op.classification !== "reserved" &&
			(!VOICE_OPERATION_IDS.has(op.operationId) ||
				row.lead.codexVoiceActions === true) &&
			(op.parityId !== "P01" || runnerEnabled) &&
			(!!op.unconditionalDenial ||
				(handlers.has(op.operationId) &&
					(op.credentialConsumer === "none" ||
						integrations.has(op.credentialConsumer)))),
	);
	const available = new Set(operations.map((op) => op.operationId));

	return {
		bundleVersion: 2 as const,
		operations,
		deniedOperations: LEAD_CAPABILITY_CATALOG.filter(
			(op) => op.classification === "reserved",
		),
		missingOperationIds: LEAD_CAPABILITY_CATALOG.filter(
			(op) =>
				op.classification !== "reserved" &&
				(!VOICE_OPERATION_IDS.has(op.operationId) ||
					row.lead.codexVoiceActions === true) &&
				!available.has(op.operationId),
		).map((op) => op.operationId),
		runnerActionToolNames: runnerEnabled ? [...RUNNER_ACTION_TOOL_NAMES] : [],
		adoptedMenuShapes: runnerEnabled
			? [...new Set(input.adoptedMenuShapes)]
			: [],
	};
}
