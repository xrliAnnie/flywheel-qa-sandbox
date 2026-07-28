const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESTART_CHILD_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface LeadLaunchdTargetInput {
	agentId: string;
	kind: "lead" | "runner";
	projectName: string;
	uid: number;
}

export interface LeadLaunchdTarget {
	agentId: string;
	jobLabel: string;
	childKey: string;
}

function requireSafeId(value: string, name: string): void {
	if (!SAFE_ID.test(value)) {
		throw new TypeError(`${name} is not a safe ProjectConfig identifier`);
	}
}

export function mapLeadLaunchdTarget(
	input: LeadLaunchdTargetInput,
): LeadLaunchdTarget {
	if (input.kind !== "lead") {
		throw new TypeError("only Lead consumers map to launchd jobs");
	}
	requireSafeId(input.projectName, "projectName");
	requireSafeId(input.agentId, "agentId");
	if (!Number.isSafeInteger(input.uid) || input.uid < 0) {
		throw new TypeError("uid must be a non-negative safe integer");
	}
	const childKey = `lead.${input.projectName}-${input.agentId}`;
	if (!RESTART_CHILD_KEY.test(childKey)) {
		throw new TypeError("derived restart child key does not round-trip");
	}
	return {
		agentId: input.agentId,
		jobLabel: `gui/${input.uid}/com.flywheel.lead.${input.projectName}-${input.agentId}`,
		childKey,
	};
}
