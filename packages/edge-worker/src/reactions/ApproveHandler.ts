import type { ActionHandler, ActionResult } from "../ReactionsEngine.js";
import type { SlackAction } from "../SlackInteractionServer.js";
import { postSlackResponse } from "./postSlackResponse.js";

type ExecFn = (
	cmd: string,
	args: string[],
	cwd: string,
) => Promise<{ stdout: string }>;

export class ApproveHandler implements ActionHandler {
	constructor(
		private execFile: ExecFn,
		private projectRoot: string,
		private projectRepo?: string,
	) {}

	async execute(action: SlackAction): Promise<ActionResult> {
		try {
			// Find PR for the issue's branch
			const repoFlag = this.projectRepo
				? ["-R", this.projectRepo]
				: [];
			const listResult = await this.execFile(
				"gh",
				[
					"pr",
					"list",
					...repoFlag,
					"--head",
					`flywheel-${action.issueId}`,
					"--json",
					"number,url",
					"--limit",
					"1",
				],
				this.projectRoot,
			);

			const prs = JSON.parse(listResult.stdout);
			if (!Array.isArray(prs) || prs.length === 0) {
				await postSlackResponse(
					action.responseUrl,
					`No PR found for branch flywheel-${action.issueId}`,
				);
				return {
					success: false,
					message: `No PR found for branch flywheel-${action.issueId}`,
				};
			}

			const pr = prs[0];
			const prNumber = pr.number;

			// Merge with squash
			await this.execFile(
				"gh",
				[
					"pr",
					"merge",
					String(prNumber),
					...repoFlag,
					"--squash",
					"--delete-branch",
				],
				this.projectRoot,
			);

			const msg = `PR #${prNumber} merged (squash) by <@${action.userId}>`;
			await postSlackResponse(action.responseUrl, msg);

			return { success: true, message: msg };
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			await postSlackResponse(
				action.responseUrl,
				`Approve failed: ${errMsg}`,
			);
			return { success: false, message: `Approve failed: ${errMsg}` };
		}
	}
}
