import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { normalizeOptionalBearer } from "flywheel-config";
import {
	assertLoopbackCarrierUrl,
	authorizeLeadWrite,
	type LeadWriteAuthorization,
	postCarrierClaim,
} from "../lead-lease.js";
import { signShadowDeclarationProof } from "../shadow-declaration-proof.js";

const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLASSES = new Set([
	"pure_docs",
	"config_only",
	"single_point_change",
	"other_code",
]);

export interface ShadowDeclareOptions {
	question?: string;
	declaredClass?: string;
	/** Retained only to fail loudly for callers following the retired Discord flow. */
	messageRef?: string;
	declarationId?: string;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
	uuid?: () => string;
	authorize?: (input: {
		claimedLeadId: string;
		env: NodeJS.ProcessEnv;
	}) => LeadWriteAuthorization;
	stdout?: (message: string) => void;
	stderr?: (message: string) => void;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Exit codes: 0 = created/replayed; 1 = usage/env/auth; 2 = Bridge/network. */
export async function shadowDeclare(
	opts: ShadowDeclareOptions,
): Promise<number> {
	const stdout = opts.stdout ?? console.log;
	const stderr = opts.stderr ?? console.error;
	const declarationId =
		opts.declarationId?.trim() || (opts.uuid ?? randomUUID)();
	stdout(`declaration_id=${declarationId}`);
	const question = opts.question?.trim();
	const declaredClass = opts.declaredClass?.trim();
	if (!question || question.length > 128) {
		stderr(
			"shadow-declare: --question is required and must be at most 128 characters",
		);
		return 1;
	}
	if (!declaredClass || !CLASSES.has(declaredClass)) {
		stderr(
			"shadow-declare: --class must be pure_docs|config_only|single_point_change|other_code",
		);
		return 1;
	}
	if (opts.messageRef !== undefined) {
		stderr(
			"shadow-declare: --message-ref is retired; do not post shadow-declare evidence to Discord",
		);
		return 1;
	}
	if (!UUID_V4.test(declarationId)) {
		stderr("shadow-declare: --declaration-id must be a canonical UUID v4");
		return 1;
	}

	const env = opts.env ?? process.env;
	const bridgeUrl = (env.BRIDGE_URL ?? env.FLYWHEEL_BRIDGE_URL)
		?.trim()
		.replace(/\/+$/, "");
	const apiToken = normalizeOptionalBearer(env.TEAMLEAD_API_TOKEN);
	if (!bridgeUrl || !apiToken) {
		stderr(
			"shadow-declare: BRIDGE_URL and TEAMLEAD_API_TOKEN are required (FLYWHEEL_BRIDGE_URL is accepted for compatibility)",
		);
		return 1;
	}
	const leadId = env.FLYWHEEL_LEAD_ID?.trim();
	const projectName = env.FLYWHEEL_PROJECT_NAME?.trim();
	if (!leadId || !projectName) {
		stderr(
			"shadow-declare: FLYWHEEL_LEAD_ID and FLYWHEEL_PROJECT_NAME are required",
		);
		return 1;
	}

	let authorization: LeadWriteAuthorization;
	try {
		authorization = (opts.authorize ?? authorizeLeadWrite)({
			claimedLeadId: leadId,
			env,
		});
	} catch (error) {
		stderr(`shadow-declare: Lead authorization failed: ${errorMessage(error)}`);
		return 1;
	}
	const identityDigest = authorization.identityDigest;
	if (!identityDigest || !/^[0-9a-f]{64}$/.test(identityDigest)) {
		stderr(
			"shadow-declare: Lead authorization returned no valid identity digest",
		);
		return 1;
	}

	const requestUrl = `${bridgeUrl}/api/workflow/shadow-declaration`;
	const commonBody = {
		declaration_id: declarationId,
		question_id: question,
		declared_class: declaredClass,
		lead_id: leadId,
		project_name: projectName,
		identity_digest: identityDigest,
	};
	const headers = {
		Authorization: `Bearer ${apiToken}`,
		"Content-Type": "application/json",
	};
	let response: Response;
	let body: { ok?: boolean; status?: string; reason?: string } | undefined;
	try {
		if (authorization.disposition === "lease_validated") {
			const leaseClaim = authorization.leaseClaim;
			const botToken = env.DISCORD_BOT_TOKEN?.trim();
			if (
				!leaseClaim ||
				leaseClaim.identityDigest !== identityDigest ||
				!botToken
			) {
				stderr(
					"shadow-declare: validated lease requires a matching lease claim and Lead DISCORD_BOT_TOKEN",
				);
				return 1;
			}
			assertLoopbackCarrierUrl(requestUrl);
			response = await (opts.fetchImpl ?? fetch)(requestUrl, {
				method: "POST",
				headers,
				body: JSON.stringify({
					...commonBody,
					proof_method: "lead_hmac",
					lease_claim: {
						lease_key: leaseClaim.leaseKey,
						generation: leaseClaim.generation,
					},
					hmac_sha256: signShadowDeclarationProof(
						{
							declarationId,
							questionId: question,
							declaredClass,
							leadId,
							projectName,
						},
						botToken,
					),
				}),
			});
		} else if (authorization.disposition === "carrier_passthrough") {
			if (!authorization.carrierClaim) {
				stderr(
					"shadow-declare: carrier authorization returned no carrier capability",
				);
				return 1;
			}
			assertLoopbackCarrierUrl(requestUrl);
			response = await postCarrierClaim({
				url: requestUrl,
				carrierClaim: authorization.carrierClaim,
				body: { ...commonBody, proof_method: "carrier_passthrough" },
				headers,
				fetchImpl: opts.fetchImpl,
			});
		} else {
			stderr(
				`shadow-declare: authorization ${authorization.disposition} is too weak; require lease_validated or carrier_passthrough`,
			);
			return 1;
		}
		body = (await response.json().catch(() => undefined)) as
			| typeof body
			| undefined;
	} catch (error) {
		stderr(`shadow-declare: request failed: ${errorMessage(error)}`);
		return 2;
	}
	if (
		response.ok &&
		body?.ok === true &&
		(body.status === "created" || body.status === "replayed")
	) {
		stdout(
			`shadow-declare: status=${body.status} declaration_id=${declarationId}`,
		);
		return 0;
	}
	stderr(
		`shadow-declare: Bridge rejected (${response.status}): ${body?.reason ?? "unknown"}`,
	);
	return 2;
}

export async function runShadowDeclareCommand(args: string[]): Promise<number> {
	let values: ReturnType<typeof parseArgs>["values"];
	try {
		({ values } = parseArgs({
			args,
			options: {
				question: { type: "string" },
				class: { type: "string" },
				"message-ref": { type: "string" },
				"declaration-id": { type: "string" },
			},
			allowPositionals: false,
		}));
	} catch (error) {
		console.error(`shadow-declare: ${errorMessage(error)}`);
		return 1;
	}
	return shadowDeclare({
		question: values.question as string | undefined,
		declaredClass: values.class as string | undefined,
		messageRef: values["message-ref"] as string | undefined,
		declarationId: values["declaration-id"] as string | undefined,
	});
}
