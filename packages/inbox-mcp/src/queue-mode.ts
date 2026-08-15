import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mailboxQueueEnabled, readEnvValueFromContent } from "flywheel-config";

const MAILBOX_QUEUE_KEY = "FLYWHEEL_MAILBOX_QUEUE";

/**
 * The MCP process is long-lived, so its inherited environment becomes stale.
 * A readable shared dotenv is authoritative, including key absence (default ON).
 */
export function resolveLiveMailboxQueueEnabled(input?: {
	dotenvPath?: string;
	processEnv?: NodeJS.ProcessEnv;
}): boolean {
	const processEnv = input?.processEnv ?? process.env;
	const dotenvPath = input?.dotenvPath ?? join(homedir(), ".flywheel", ".env");
	try {
		const value = readEnvValueFromContent(
			readFileSync(dotenvPath, "utf8"),
			MAILBOX_QUEUE_KEY,
		);
		return mailboxQueueEnabled({ [MAILBOX_QUEUE_KEY]: value });
	} catch {
		return mailboxQueueEnabled(processEnv);
	}
}
