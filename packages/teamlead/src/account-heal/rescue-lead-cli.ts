/**
 * FLY-871 R3/C9 — `flywheel-rescue-lead`: the Codex Infra Bot's lead-rescue
 * consumer. A THIN client of the Bridge `POST /api/rescue` route — it does NOT
 * read the DB or run launchctl itself; the Bridge owns the live StateStore, the
 * structural guard (still-pending confirmed `login_expired` alert), the kickstart
 * + resume-menu unstick, the audit, and the Alerts-thread evidence post. Keeping
 * the rescue server-side means the CLI can never restart a healthy Lead and the
 * one source of truth (the live alert table) is never read stale.
 *
 * Usage: flywheel-rescue-lead --project <p> --lead <id> [--alert-id <a>]
 *   [--bridge-url <url>] [--token <t>]
 * Env fallbacks: BRIDGE_URL / TEAMLEAD_API_TOKEN (both already present in Lead
 * panes). The bot runs this locally against the loopback Bridge.
 *
 * Exit codes: 0 = rescued; 1 = a valid "not rescued" outcome (no pending alert,
 * recovered, or escalated); 2 = usage error; 3 = transport / auth / HTTP error.
 * Never throws.
 */

import { fileURLToPath } from "node:url";

export interface RescueLeadCliDeps {
	env?: Record<string, string | undefined>;
	/** Injectable fetch (tests stub it); defaults to the global fetch. */
	fetchImpl?: typeof fetch;
	/** stdout sink. */
	log?: (msg: string) => void;
	/** stderr sink. */
	errLog?: (msg: string) => void;
}

interface ParsedArgs {
	project?: string;
	lead?: string;
	alertId?: string;
	bridgeUrl?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
	const out: ParsedArgs = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === "--project") out.project = next();
		else if (a === "--lead") out.lead = next();
		else if (a === "--alert-id") out.alertId = next();
		else if (a === "--bridge-url") out.bridgeUrl = next();
	}
	return out;
}

export async function runRescueLeadCli(
	argv: string[],
	deps: RescueLeadCliDeps = {},
): Promise<number> {
	const env = deps.env ?? process.env;
	const log = deps.log ?? console.log;
	const errLog = deps.errLog ?? console.error;
	const fetchImpl = deps.fetchImpl ?? fetch;

	const args = parseArgs(argv);
	if (!args.project || !args.lead) {
		errLog(
			"usage: flywheel-rescue-lead --project <p> --lead <id> [--alert-id <a>] [--bridge-url <url>]",
		);
		return 2;
	}

	const bridgeUrl = (args.bridgeUrl ?? env.BRIDGE_URL ?? "").replace(
		/\/+$/,
		"",
	);
	// The bearer token is read ONLY from the environment — never a CLI flag — so it
	// can't leak into shell history / the process argv (Codex R1 MEDIUM).
	const token = env.TEAMLEAD_API_TOKEN;
	if (!bridgeUrl) {
		errLog("no bridge URL — set --bridge-url or BRIDGE_URL");
		return 3;
	}
	if (!token) {
		errLog("no API token — set TEAMLEAD_API_TOKEN");
		return 3;
	}

	const body: Record<string, unknown> = {
		route: "lead",
		projectName: args.project,
		leadId: args.lead,
	};
	if (args.alertId) body.alertId = args.alertId;

	let res: Response;
	try {
		res = await fetchImpl(`${bridgeUrl}/api/rescue`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
		});
	} catch (err) {
		errLog(
			`rescue request failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 3;
	}

	let json: Record<string, unknown> = {};
	try {
		json = (await res.json()) as Record<string, unknown>;
	} catch {
		// non-JSON body — fall through to status handling
	}

	if (res.status === 200) {
		if (json.ok === true) {
			log(`✅ Lead ${args.lead} rescued (${json.target ?? "kickstart"}).`);
			return 0;
		}
		log(
			`⚠️ Lead ${args.lead} not rescued: ${json.reason ?? "unknown"}${
				json.escalated ? " (escalated to @Annie)" : ""
			}.`,
		);
		return 1;
	}

	if (res.status === 409) {
		errLog(
			`rescue not performed: ${json.detail ?? json.reason ?? "self-heal disabled"}`,
		);
		return 3;
	}

	errLog(
		`rescue HTTP ${res.status}: ${json.error ?? json.detail ?? "request failed"}`,
	);
	return 3;
}

// Direct-exec guard (matches freshness-cli / account-summary-cli).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	runRescueLeadCli(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch(() => process.exit(3));
}
