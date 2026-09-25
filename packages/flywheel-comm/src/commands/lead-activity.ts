import { parseArgs } from "node:util";
import { assertLoopbackCarrierUrl } from "../lead-lease.js";

/**
 * FLY-2882: read-only "what is this Lead doing right now".
 *
 *   flywheel-comm lead-activity --project <p> --lead <l>
 *   flywheel-comm lead-activity --all
 *
 * Prints exactly one JSON line. Exit 0 = the Bridge answered (busy / idle /
 * unknown are all answers); non-zero = the call itself failed.
 */

const SINGLE_TIMEOUT_MS = 15_000;
const FLEET_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const IDENTITY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const USAGE =
	"use lead-activity --project <name> --lead <id> | --all [--bridge-url <loopback-url>]";

interface Dependencies {
	env?: Record<string, string | undefined>;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	log?: (message: string) => void;
}

export async function runLeadActivity(
	args: string[],
	deps: Dependencies = {},
): Promise<number> {
	const log = deps.log ?? console.log;
	const fail = (error: string) => {
		log(JSON.stringify({ ok: false, error }));
		return 1;
	};
	let values: {
		project?: string;
		lead?: string;
		all?: boolean;
		"bridge-url"?: string;
	};
	try {
		const parsed = parseArgs({
			args,
			strict: true,
			allowPositionals: false,
			tokens: true,
			options: {
				project: { type: "string" },
				lead: { type: "string" },
				all: { type: "boolean" },
				"bridge-url": { type: "string" },
			},
		});
		const names = parsed.tokens
			.filter((token) => token.kind === "option")
			.map((token) => token.name);
		if (new Set(names).size !== names.length) return fail("duplicate_option");
		values = parsed.values;
	} catch {
		return fail(USAGE);
	}
	const fleet = values.all === true;
	if (fleet) {
		if (values.project !== undefined || values.lead !== undefined)
			return fail(USAGE);
	} else if (
		values.project === undefined ||
		values.lead === undefined ||
		!IDENTITY_RE.test(values.project) ||
		!IDENTITY_RE.test(values.lead)
	) {
		return fail(USAGE);
	}
	const env = deps.env ?? process.env;
	if (!env.TEAMLEAD_API_TOKEN) return fail("api_token_required");
	let url: URL;
	try {
		url = assertLoopbackCarrierUrl(
			`${(values["bridge-url"] ?? env.BRIDGE_URL ?? env.FLYWHEEL_BRIDGE_URL ?? "http://localhost:9876").replace(/\/+$/, "")}/api/lead-activity${fleet ? "/fleet" : ""}`,
		);
	} catch {
		return fail("loopback_bridge_required");
	}
	if (!fleet) {
		url.searchParams.set("projectName", values.project!);
		url.searchParams.set("leadId", values.lead!);
	}
	const signal = AbortSignal.timeout(
		deps.timeoutMs ?? (fleet ? FLEET_TIMEOUT_MS : SINGLE_TIMEOUT_MS),
	);
	let status: number;
	let body: unknown;
	try {
		const response = await (deps.fetchImpl ?? fetch)(url, {
			method: "GET",
			redirect: "error",
			signal,
			headers: { Authorization: `Bearer ${env.TEAMLEAD_API_TOKEN}` },
		});
		status = response.status;
		const text = await response.text();
		if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
			return fail("response_too_large");
		try {
			body = JSON.parse(text);
		} catch {
			body = undefined;
		}
	} catch {
		return fail(signal.aborted ? "timed_out" : "bridge_unreachable");
	}
	if (status !== 200) {
		const reason = (body as { reason?: unknown } | undefined)?.reason;
		return fail(
			(status === 404 && reason === "unknown_lead") ||
				(status === 400 && reason === "invalid_arguments")
				? reason
				: `bridge_http_${status}`,
		);
	}
	const schema = (body as { schema?: unknown } | undefined)?.schema;
	if (schema !== (fleet ? "lead-activity-fleet.v1" : "lead-activity.v1"))
		return fail("unexpected_response");
	log(
		JSON.stringify(
			fleet ? { ok: true, fleet: body } : { ok: true, activity: body },
		),
	);
	return 0;
}
