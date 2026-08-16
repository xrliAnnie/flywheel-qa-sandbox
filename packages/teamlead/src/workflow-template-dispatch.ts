import {
	isWorkflowClaimsReadEnabled,
	isWorkflowClaimsWriteEnabled,
} from "./workflow-claims.js";
import { isGeneralizedTemplatesEnabled } from "./workflow-template.js";

type EnvLike = Record<string, string | undefined>;

export type WorkflowTemplateDispatchBlockReason =
	| "template_dispatch_disabled"
	| "claims_write_disabled"
	| "claims_read_disabled"
	| "generalized_disabled";

export function isWorkflowTemplateDispatchEnabled(env: EnvLike): boolean {
	return env.FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH === "1";
}

/** FLY-1441: new runs freeze this flag as gate_carrier_epoch=1. */
export function isWorkflowGateCarrierEnabled(env: EnvLike): boolean {
	return env.FLYWHEEL_WORKFLOW_GATE_CARRIER === "1";
}

/**
 * One fail-closed predicate shared by selection, materialization, admission,
 * and successor consumption. Schema v1 needs dispatch + claims write/read;
 * schema v2 additionally needs generalized-template interpretation.
 */
export function workflowTemplateDispatchBlockReason(
	schemaVersion: 1 | 2,
	env: EnvLike,
): WorkflowTemplateDispatchBlockReason | undefined {
	if (!isWorkflowTemplateDispatchEnabled(env)) {
		return "template_dispatch_disabled";
	}
	if (!isWorkflowClaimsWriteEnabled(env)) return "claims_write_disabled";
	if (!isWorkflowClaimsReadEnabled(env)) return "claims_read_disabled";
	if (schemaVersion === 2 && !isGeneralizedTemplatesEnabled(env)) {
		return "generalized_disabled";
	}
	return undefined;
}

export function workflowTemplateDispatchBlockMessage(
	reason: WorkflowTemplateDispatchBlockReason,
): string {
	switch (reason) {
		case "template_dispatch_disabled":
			return "workflow template dispatch is disabled by flag";
		case "claims_write_disabled":
			return "workflow template dispatch requires workflow claims write";
		case "claims_read_disabled":
			return "workflow template dispatch requires workflow claims read";
		case "generalized_disabled":
			return "generalized workflow templates are disabled by flag";
	}
}
