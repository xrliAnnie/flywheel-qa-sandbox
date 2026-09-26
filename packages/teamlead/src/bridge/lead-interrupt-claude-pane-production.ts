/**
 * FLY-2883: production wiring of the Claude Lead interrupt pane, using the
 * same locator, UTF-8 tmux client, identity-checked capture and Claude
 * process check as the FLY-2882 lead-activity reader. Kept apart from
 * lead-inbox-runtime.ts so that module never imports the activity service.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readV2LeadClaudePid } from "../LeadWindowLocator.js";
import { locateConfiguredLeadWindow } from "./fleet-lead-locator.js";
import {
	claudeLeadLocatorOptions,
	utf8TmuxExec,
} from "./lead-activity/lead-activity-service.js";
import { defaultLeadPaneCapture } from "./lead-alert-helpers.js";
import { createClaudeInterruptPane } from "./lead-interrupt-claude-pane.js";
import { LEAD_INTERRUPT_PHRASE } from "./lead-interrupt-contract.js";
import type { ClaudeInterruptPane } from "./lead-interrupt-delivery.js";
import { sendLiteralLineToLeadPane } from "./tmux-lookup.js";

export function createProductionClaudeInterruptPane(args: {
	projectName: string;
	leadId: string;
	env?: NodeJS.ProcessEnv;
}): ClaudeInterruptPane {
	const env = args.env ?? process.env;
	const stateDir =
		env.FLYWHEEL_STATE_DIR?.trim() || join(homedir(), ".flywheel");
	const locatorOptions = {
		...claudeLeadLocatorOptions(env, stateDir),
		execFn: utf8TmuxExec,
	};
	const capture = defaultLeadPaneCapture(
		undefined,
		utf8TmuxExec as unknown as Parameters<typeof defaultLeadPaneCapture>[1],
	);
	return createClaudeInterruptPane({
		leadId: args.leadId,
		locate: () =>
			locateConfiguredLeadWindow(args.projectName, args.leadId, locatorOptions),
		capture: (window, lines) => capture(window, lines),
		claudeProcess: (window) => readV2LeadClaudePid(window, utf8TmuxExec),
		sendPhrase: (window, expectedClaudePid) =>
			sendLiteralLineToLeadPane(window, LEAD_INTERRUPT_PHRASE, {
				expectedClaudePid,
				execFn: utf8TmuxExec,
			}),
	});
}
