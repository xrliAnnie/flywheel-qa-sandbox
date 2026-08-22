import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface WorkflowPrProbeResult {
	state: string;
	isDraft: boolean;
	isCrossRepository: boolean;
	headRefName: string;
	headRefOid: string;
}

export async function probeWorkflowPr(input: {
	prNumber: number;
	probeRepoSlug: string;
}): Promise<WorkflowPrProbeResult> {
	const { stdout } = await execFileP(
		"gh",
		[
			"pr",
			"view",
			String(input.prNumber),
			"-R",
			input.probeRepoSlug,
			"--json",
			"state,isDraft,isCrossRepository,headRefName,headRefOid",
		],
		{ encoding: "utf8", timeout: 15_000 },
	);
	return JSON.parse(stdout) as WorkflowPrProbeResult;
}
