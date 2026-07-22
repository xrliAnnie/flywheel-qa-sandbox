export interface FrozenFounderRouteCandidatesV1 {
	v: 1;
	questionIds: string[];
	leadId: string;
	projectName: string;
	issueId: string;
	threadId: string;
}

function requiredIdPart(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${field} is required`);
	if (normalized.includes(":")) {
		throw new Error(`${field} cannot contain ':'`);
	}
	return normalized;
}

export function founderMessageRootId(leadId: string, msgId: string): string {
	return `founder_msg:${requiredIdPart(leadId, "leadId")}:${requiredIdPart(msgId, "msgId")}`;
}

export function founderRouteRowId(leadId: string, msgId: string): string {
	return `founder_route:${requiredIdPart(leadId, "leadId")}:${requiredIdPart(msgId, "msgId")}`;
}
