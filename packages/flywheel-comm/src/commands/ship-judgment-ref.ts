import { parseArgs } from "node:util";
import {
	assertLoopbackCarrierUrl,
	authorizeLeadWrite,
	type LeadWriteAuthorization,
} from "../lead-lease.js";

interface Dependencies {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	authorize?: (
		leadId: string,
		env: NodeJS.ProcessEnv,
	) => Pick<
		LeadWriteAuthorization,
		"identityDigest" | "leaseClaim" | "carrierClaim"
	>;
	log?: (message: string) => void;
}
/** Explicit manual refetch; the Bridge alone fetches and records the explanation. */
export async function runShipJudgmentRef(
	args: string[],
	deps: Dependencies = {},
): Promise<number> {
	const log = deps.log ?? console.log;
	const fail = (error: string) => {
		log(JSON.stringify({ error }));
		return 1;
	};
	let values: Record<string, string | undefined>;
	try {
		const parsed = parseArgs({
			args,
			options: {
				"message-ref": { type: "string" },
				"clarification-id": { type: "string" },
				"bridge-url": { type: "string" },
			},
			strict: true,
			allowPositionals: false,
			tokens: true,
		});
		const names = parsed.tokens
			.filter((t) => t.kind === "option")
			.map((t) => t.name);
		if (new Set(names).size !== names.length) return fail("duplicate_option");
		values = parsed.values;
	} catch {
		return fail(
			"use --message-ref threadId/messageId --clarification-id messageId [--bridge-url url]",
		);
	}
	const ref = values["message-ref"]?.match(/^(\d{17,20})\/(\d{17,20})$/);
	if (!ref || !/^\d{17,20}$/.test(values["clarification-id"] ?? ""))
		return fail("invalid_message_reference");
	const env = deps.env ?? process.env;
	const leadId = env.FLYWHEEL_LEAD_ID ?? env.LEAD_ID,
		projectName = env.FLYWHEEL_PROJECT_NAME ?? env.PROJECT_NAME;
	if (!leadId || projectName !== "flywheel" || !env.TEAMLEAD_API_TOKEN)
		return fail("flywheel_lead_identity_and_api_token_required");
	let url: URL;
	try {
		url = assertLoopbackCarrierUrl(
			`${(values["bridge-url"] ?? env.BRIDGE_URL ?? env.FLYWHEEL_BRIDGE_URL ?? "http://localhost:9876").replace(/\/+$/, "")}/api/ship-judgment/reference`,
		);
	} catch {
		return fail("loopback_bridge_required");
	}
	let authorization: Pick<
		LeadWriteAuthorization,
		"identityDigest" | "leaseClaim" | "carrierClaim"
	>;
	try {
		authorization = deps.authorize
			? deps.authorize(leadId, env)
			: authorizeLeadWrite({ claimedLeadId: leadId, env });
	} catch {
		return fail("lead_write_unauthorized");
	}
	if (!authorization.identityDigest)
		return fail("lead_identity_digest_required");
	try {
		const response = await (deps.fetchImpl ?? fetch)(url.href, {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(20000),
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${env.TEAMLEAD_API_TOKEN}`,
			},
			body: JSON.stringify({
				threadId: ref[1],
				messageId: ref[2],
				replyToMessageId: values["clarification-id"],
				leadAuth: {
					leadId,
					projectName,
					identityDigest: authorization.identityDigest,
					...(authorization.leaseClaim
						? {
								leaseClaim: {
									leaseKey: authorization.leaseClaim.leaseKey,
									generation: authorization.leaseClaim.generation,
								},
							}
						: {}),
					...(authorization.carrierClaim
						? { carrierClaim: authorization.carrierClaim }
						: {}),
				},
			}),
		});
		if (!response.ok) {
			await response.body?.cancel();
			return fail(`bridge_http_${response.status}`);
		}
		const body = (await response.json()) as { status?: unknown };
		if (body?.status !== "recorded_or_existing")
			return fail("unexpected_bridge_receipt");
		log(JSON.stringify({ status: body.status }));
		return 0;
	} catch {
		return fail("reference_result_unknown_retry_same_reference");
	}
}
