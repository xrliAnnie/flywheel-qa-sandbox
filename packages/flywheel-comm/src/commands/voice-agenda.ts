import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { normalizeOptionalBearer } from "flywheel-config";

/**
 * FLY-2863 plan §3.2: the Lead answers a voice agenda request with structured
 * commands — never parsed out of natural language.
 *
 *   voice agenda say    --request <id> --item <itemKey|none> [--order k1,k2] --text "<words>"
 *   voice agenda close  --request <id> --item <itemKey> --disposition resolved|decision_recorded|deferred [--evidence <ref>] --reason "<one line>"
 *   voice agenda urgent --channel <id> --message <id> --reason production_down|data_loss_risk|security|deadline_within_1h|founder_requested
 */

export interface VoiceAgendaCommandDeps {
	env?: Readonly<Record<string, string | undefined>>;
	fetchImpl?: typeof fetch;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	nextId?: () => string;
}

const DISPOSITIONS = ["resolved", "decision_recorded", "deferred"] as const;
const URGENT_REASONS = [
	"production_down",
	"data_loss_risk",
	"security",
	"deadline_within_1h",
	"founder_requested",
] as const;
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEY = /^[A-Za-z0-9_.:@+-]{1,256}$/u;
const SNOWFLAKE = /^\d{17,20}$/u;

class UsageError extends Error {}

function usage(): string {
	return [
		"usage:",
		"  flywheel-comm voice agenda say --request <id> --item <itemKey|none> [--order k1,k2] --text <words> [--lead <id>]",
		"  flywheel-comm voice agenda close --request <id> --item <itemKey> --disposition resolved|decision_recorded|deferred [--evidence <ref>] --reason <line> [--lead <id>]",
		"  flywheel-comm voice agenda urgent --channel <id> --message <id> --reason <enum> [--lead <id>]",
	].join("\n");
}

export async function runVoiceAgendaCommand(
	args: string[],
	deps: VoiceAgendaCommandDeps = {},
): Promise<number> {
	const stdout = deps.stdout ?? console.log;
	const stderr = deps.stderr ?? console.error;
	const env = deps.env ?? process.env;
	try {
		if (args[0] !== "agenda") throw new UsageError("unknown voice command");
		const action = args[1];
		const { values } = parseArgs({
			args: args.slice(2),
			options: {
				request: { type: "string" },
				item: { type: "string" },
				order: { type: "string" },
				text: { type: "string" },
				disposition: { type: "string" },
				evidence: { type: "string" },
				reason: { type: "string" },
				channel: { type: "string" },
				message: { type: "string" },
				lead: { type: "string" },
			},
			allowPositionals: false,
		});
		const leadId = (values.lead ?? env.FLYWHEEL_LEAD_ID ?? env.LEAD_ID)?.trim();
		if (!leadId) throw new UsageError("--lead or FLYWHEEL_LEAD_ID is required");
		let path: string;
		let body: Record<string, unknown>;
		if (action === "say" || action === "close") {
			const requestId = values.request?.trim();
			if (!requestId || !UUID.test(requestId))
				throw new UsageError("--request must be the request id from the brief");
			const item = values.item?.trim();
			if (!item)
				throw new UsageError("--item is required (use none for no item)");
			if (action === "say") {
				if (!values.text?.trim()) throw new UsageError("--text is required");
				if (values.disposition || values.evidence || values.reason)
					throw new UsageError(
						"say takes no --disposition/--evidence/--reason",
					);
				const order = values.order
					?.split(",")
					.map((key) => key.trim())
					.filter(Boolean);
				if (item !== "none" && !KEY.test(item))
					throw new UsageError("--item is not an agenda item key");
				if (order?.some((key) => !KEY.test(key)))
					throw new UsageError("--order must be agenda item keys");
				body = {
					requestId,
					leadId,
					clientResultId: (deps.nextId ?? randomUUID)(),
					kind: "say",
					itemKey: item === "none" ? null : item,
					...(order ? { order } : {}),
					text: values.text,
				};
			} else {
				const disposition = values.disposition as (typeof DISPOSITIONS)[number];
				if (!DISPOSITIONS.includes(disposition))
					throw new UsageError(
						"--disposition must be resolved, decision_recorded or deferred",
					);
				if (item === "none" || !KEY.test(item))
					throw new UsageError("close needs the --item it closes");
				if (!values.reason?.trim())
					throw new UsageError("--reason is required");
				if (disposition === "resolved" && !values.evidence?.trim())
					throw new UsageError(
						"resolved needs --evidence (what proves it was done)",
					);
				if (values.text || values.order)
					throw new UsageError("close takes no --text/--order");
				body = {
					requestId,
					leadId,
					clientResultId: (deps.nextId ?? randomUUID)(),
					kind: "close",
					itemKey: item,
					disposition,
					...(values.evidence?.trim()
						? { evidence: values.evidence.trim() }
						: {}),
					reason: values.reason.trim(),
				};
			}
			path = "/api/voice/agenda/lead/results";
		} else if (action === "urgent") {
			const reason = values.reason as (typeof URGENT_REASONS)[number];
			if (!URGENT_REASONS.includes(reason))
				throw new UsageError(
					`--reason must be one of ${URGENT_REASONS.join(", ")}`,
				);
			if (
				!SNOWFLAKE.test(values.channel ?? "") ||
				!SNOWFLAKE.test(values.message ?? "")
			)
				throw new UsageError("--channel and --message must be Discord ids");
			body = {
				leadId,
				channelId: values.channel,
				messageId: values.message,
				reason,
			};
			path = "/api/voice/agenda/lead/urgent";
		} else {
			throw new UsageError("unknown voice agenda action");
		}
		const bridgeUrl = (env.FLYWHEEL_BRIDGE_URL ?? env.BRIDGE_URL)?.trim();
		const token =
			normalizeOptionalBearer(env.TEAMLEAD_API_TOKEN) ??
			normalizeOptionalBearer(env.FLYWHEEL_INGEST_TOKEN);
		if (!bridgeUrl || !token)
			throw new Error(
				"FLYWHEEL_BRIDGE_URL and TEAMLEAD_API_TOKEN or FLYWHEEL_INGEST_TOKEN are required",
			);
		const response = await (deps.fetchImpl ?? fetch)(
			`${bridgeUrl.replace(/\/+$/u, "")}${path}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			},
		);
		const payload = (await response.json().catch(() => ({}))) as unknown;
		stdout(JSON.stringify(payload));
		if (response.ok) return 0;
		stderr(`voice agenda: Bridge rejected (HTTP ${response.status})`);
		return 2;
	} catch (error) {
		if (error instanceof UsageError) {
			stderr(`voice agenda: ${error.message}\n${usage()}`);
			return 64;
		}
		stderr(
			`voice agenda: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 1;
	}
}
