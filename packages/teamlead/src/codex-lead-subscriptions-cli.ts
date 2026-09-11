#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolveCodexLeadStateDir } from "./bridge/lead-inbox-runtime.js";
import {
	resolveCodexLeadInboxSocketPath,
	unsubscribeCodexLeadThread,
} from "./lead-backends/codex/CodexLeadInboxSocket.js";
import {
	ledgerPath,
	parseLedgerFile,
} from "./lead-backends/codex/roundtable-subscription-ledger.js";
import { loadProjects } from "./ProjectConfig.js";

interface CliDeps {
	loadProjects?: () => Array<{
		projectName: string;
		leads: Array<{ agentId: string; botToken?: string }>;
	}>;
	resolveStateDir?: (project: string, lead: string) => string;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
}

/** Read-only list; all mutations are authenticated requests to the owning runtime. */
export async function runSubscriptionsCli(
	argv: string[],
	deps: CliDeps = {},
): Promise<number> {
	const out = deps.stdout ?? ((text: string) => console.log(text));
	const err = deps.stderr ?? ((text: string) => console.error(text));
	try {
		const { values, positionals } = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				project: { type: "string" },
				lead: { type: "string" },
				thread: { type: "string" },
				reason: { type: "string" },
				json: { type: "boolean", default: false },
			},
		});
		const command = positionals[0];
		if (
			positionals.length !== 1 ||
			(command !== "list" && command !== "unsubscribe") ||
			!values.project?.trim() ||
			!values.lead?.trim()
		) {
			err(
				"usage: codex-lead-subscriptions-cli list|unsubscribe --project <p> --lead <id> [--thread <id>] [--reason <text>] [--json]",
			);
			return 2;
		}
		if (
			command === "unsubscribe" &&
			(!values.thread || !/^\d{17,20}$/.test(values.thread))
		) {
			err("--thread must be a Discord snowflake");
			return 2;
		}
		const project = (deps.loadProjects ?? loadProjects)().find(
			(p) => p.projectName === values.project,
		);
		const lead = project?.leads.find((l) => l.agentId === values.lead);
		if (!project || !lead) {
			err("unknown project/lead");
			return 2;
		}
		const secret = lead.botToken ?? (deps.env ?? process.env).DISCORD_BOT_TOKEN;
		if (!secret?.trim()) {
			err(
				"Lead bot token is required (configured bot token or DISCORD_BOT_TOKEN)",
			);
			return 2;
		}
		const stateDir = (deps.resolveStateDir ?? resolveCodexLeadStateDir)(
			project.projectName,
			lead.agentId,
		);
		if (command === "list") {
			const ledger = parseLedgerFile(ledgerPath(stateDir));
			if (!ledger.ok && ledger.reason === "corrupt") {
				err("subscription ledger is corrupt; list left the file unchanged");
				return 4;
			}
			const now = (deps.now ?? Date.now)();
			const entries = (ledger.ok ? ledger.snapshot.entries : []).map(
				(entry) => ({
					...entry,
					status: Date.parse(entry.expiresAt) > now ? "active" : "expired",
				}),
			);
			const dropped = ledger.ok ? ledger.dropped.length : 0;
			if (values.json)
				out(
					JSON.stringify({
						project: project.projectName,
						lead: lead.agentId,
						entries,
						invalid_entries: dropped,
					}),
				);
			else {
				out(
					entries.length
						? entries
								.map(
									(e) =>
										`${e.threadId}\t${e.status}\texpires=${e.expiresAt}\tparent=${e.parentChannelId}`,
								)
								.join("\n")
						: "No subscriptions.",
				);
				if (dropped)
					err(`${dropped} invalid ledger entries omitted; file unchanged`);
			}
			return 0;
		}
		const reason = values.reason?.trim() ?? "operator unsubscribe";
		if (!reason) {
			err("--reason must not be blank");
			return 2;
		}
		const removed = await unsubscribeCodexLeadThread({
			socketPath: resolveCodexLeadInboxSocketPath(stateDir),
			leadId: lead.agentId,
			authSecret: secret,
			threadId: values.thread!,
			reason,
		});
		out(
			values.json
				? JSON.stringify({ thread_id: values.thread, removed })
				: `${values.thread}: ${removed ? "unsubscribed" : "not subscribed"}`,
		);
		return 0;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ECONNREFUSED") {
			err("Codex Lead runtime is not running; no subscription was changed");
			return 3;
		}
		err(error instanceof Error ? error.message : String(error));
		return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")
			? 2
			: 1;
	}
}

if (/codex-lead-subscriptions-cli\.(js|ts)$/.test(process.argv[1] ?? "")) {
	void runSubscriptionsCli(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
