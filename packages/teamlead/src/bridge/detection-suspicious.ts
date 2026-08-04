/** Shared evidence shape for the retained process-liveness confirmation path. */
export interface SuspiciousReport {
	targetKind: "runner" | "lead";
	targetKey: string;
	reason: string;
	paneTail: string;
	episodeFingerprint: string;
	frames?: Array<{ text: string; capturedAtMs: number }>;
}

/** Resolved ownership used only for durable judge audit attribution. */
export interface SuspiciousOwner {
	leadId: string;
	projectName: string;
	executionId?: string;
	issueId?: string;
}

/** Bounded pane evidence for the retained liveness judge. */
export function buildPaneTail(text: string, lines = 15): string {
	return text
		.split("\n")
		.filter((line) => line.trim())
		.slice(-lines)
		.join("\n");
}
