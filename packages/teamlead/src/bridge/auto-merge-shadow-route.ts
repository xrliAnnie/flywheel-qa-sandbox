import express from "express";
import {
	authorizeLeadWrite,
	forwardedLeadAuthorizationEnv,
	type LeadWriteAuthorization,
} from "flywheel-comm/lead-lease";
import { verifyShadowDeclarationProof } from "flywheel-comm/shadow-declaration-proof";
import type { ProjectEntry } from "../ProjectConfig.js";
import type {
	AutoMergeShadowDeclarationRow,
	AutoMergeShadowDeclaredClass,
	AutoMergeShadowLeadAuthMethod,
	StateStore,
	WorkflowGateHolderRow,
} from "../StateStore.js";
import { resolveLeadIdentityForShadowDeclaration } from "./founder-gate-bot-token.js";
import { rejectNonLoopback } from "./workflow-decision-routes.js";

const COMMON_BODY_KEYS = [
	"declaration_id",
	"question_id",
	"declared_class",
	"lead_id",
	"project_name",
	"identity_digest",
	"proof_method",
] as const;
const ALLOWED_BODY_KEYS = new Set([
	...COMMON_BODY_KEYS,
	"lease_claim",
	"hmac_sha256",
	"carrierClaim",
]);
const DECLARATION_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECLARED_CLASSES = new Set<AutoMergeShadowDeclaredClass>([
	"pure_docs",
	"config_only",
	"single_point_change",
	"other_code",
]);
const IDENTITY_DIGEST = /^[0-9a-f]{64}$/;

type ParsedProof =
	| {
			proofMethod: "lead_hmac";
			leaseClaim: { leaseKey: string; generation: number };
			hmacSha256: string;
	  }
	| { proofMethod: "carrier_passthrough"; carrierClaim: string };

interface ParsedBody {
	declarationId: string;
	questionId: string;
	declaredClass: AutoMergeShadowDeclaredClass;
	leadId: string;
	projectName: string;
	identityDigest: string;
	proof: ParsedProof;
}

export interface ShadowLeadAuthorizationInput {
	leadId: string;
	projectName: string;
	identityDigest: string;
	proofMethod: AutoMergeShadowLeadAuthMethod;
	leaseClaim?: { leaseKey: string; generation: number };
	carrierClaim?: string;
}

export interface AutoMergeShadowRouterDeps {
	store: StateStore;
	projects: ProjectEntry[];
	env?: NodeJS.ProcessEnv;
	authorize?: (
		input: ShadowLeadAuthorizationInput,
	) => LeadWriteAuthorization | Promise<LeadWriteAuthorization>;
	now?: () => string;
}

function reject(res: express.Response, status: number, reason: string): void {
	res.status(status).json({ ok: false, reason });
}

function parseBody(
	value: unknown,
): { ok: true; body: ParsedBody } | { ok: false; reason: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { ok: false, reason: "body_shape" };
	}
	const body = value as Record<string, unknown>;
	const keys = Object.keys(body);
	if (keys.some((key) => !ALLOWED_BODY_KEYS.has(key))) {
		return { ok: false, reason: "unexpected_key" };
	}
	if (!COMMON_BODY_KEYS.every((key) => Object.hasOwn(body, key))) {
		return { ok: false, reason: "body_shape" };
	}
	if (
		typeof body.declaration_id !== "string" ||
		!DECLARATION_ID.test(body.declaration_id)
	) {
		return { ok: false, reason: "declaration_id_invalid" };
	}
	if (
		typeof body.question_id !== "string" ||
		body.question_id.length === 0 ||
		body.question_id.length > 128
	) {
		return { ok: false, reason: "question_id_invalid" };
	}
	if (
		typeof body.declared_class !== "string" ||
		!DECLARED_CLASSES.has(body.declared_class as AutoMergeShadowDeclaredClass)
	) {
		return { ok: false, reason: "declared_class_invalid" };
	}
	if (
		typeof body.lead_id !== "string" ||
		!/^[-A-Za-z0-9._]{1,64}$/.test(body.lead_id)
	) {
		return { ok: false, reason: "lead_id_invalid" };
	}
	if (
		typeof body.project_name !== "string" ||
		body.project_name.length === 0 ||
		body.project_name.length > 128
	) {
		return { ok: false, reason: "project_name_invalid" };
	}
	if (
		typeof body.identity_digest !== "string" ||
		!IDENTITY_DIGEST.test(body.identity_digest)
	) {
		return { ok: false, reason: "identity_digest_invalid" };
	}

	let proof: ParsedProof;
	if (body.proof_method === "lead_hmac") {
		if (
			keys.length !== COMMON_BODY_KEYS.length + 2 ||
			!Object.hasOwn(body, "lease_claim") ||
			!Object.hasOwn(body, "hmac_sha256") ||
			!body.lease_claim ||
			typeof body.lease_claim !== "object" ||
			Array.isArray(body.lease_claim)
		) {
			return { ok: false, reason: "proof_shape" };
		}
		const lease = body.lease_claim as Record<string, unknown>;
		if (
			Object.keys(lease).length !== 2 ||
			!Object.hasOwn(lease, "lease_key") ||
			!Object.hasOwn(lease, "generation") ||
			typeof lease.lease_key !== "string" ||
			lease.lease_key.length === 0 ||
			lease.lease_key.length > 256 ||
			typeof lease.generation !== "number" ||
			!Number.isSafeInteger(lease.generation) ||
			lease.generation <= 0 ||
			typeof body.hmac_sha256 !== "string" ||
			!IDENTITY_DIGEST.test(body.hmac_sha256)
		) {
			return { ok: false, reason: "proof_shape" };
		}
		proof = {
			proofMethod: "lead_hmac",
			leaseClaim: {
				leaseKey: lease.lease_key,
				generation: lease.generation,
			},
			hmacSha256: body.hmac_sha256,
		};
	} else if (body.proof_method === "carrier_passthrough") {
		if (
			keys.length !== COMMON_BODY_KEYS.length + 1 ||
			!Object.hasOwn(body, "carrierClaim") ||
			typeof body.carrierClaim !== "string" ||
			body.carrierClaim.length === 0 ||
			body.carrierClaim.length > 4096
		) {
			return { ok: false, reason: "proof_shape" };
		}
		proof = {
			proofMethod: "carrier_passthrough",
			carrierClaim: body.carrierClaim,
		};
	} else {
		return { ok: false, reason: "proof_method_invalid" };
	}

	return {
		ok: true,
		body: {
			declarationId: body.declaration_id,
			questionId: body.question_id,
			declaredClass: body.declared_class as AutoMergeShadowDeclaredClass,
			leadId: body.lead_id,
			projectName: body.project_name,
			identityDigest: body.identity_digest,
			proof,
		},
	};
}

function isShipGate(holder: WorkflowGateHolderRow): boolean {
	return (
		holder.gate_node_id === "founder_gate" &&
		holder.authority_mode === "land" &&
		holder.subject_kind === "git_head"
	);
}

function canonicalReplay(
	row: AutoMergeShadowDeclarationRow,
	body: ParsedBody,
): boolean {
	return (
		row.question_id === body.questionId &&
		row.declared_class === body.declaredClass &&
		row.declared_by === body.leadId &&
		row.evidence_kind === "lead_authenticated" &&
		row.lead_identity_digest === body.identityDigest &&
		row.lead_auth_method === body.proof.proofMethod
	);
}

function sameHolder(
	left: WorkflowGateHolderRow,
	right: WorkflowGateHolderRow,
): boolean {
	return (
		left.run_id === right.run_id &&
		left.gate_node_id === right.gate_node_id &&
		left.source_execution_id === right.source_execution_id &&
		left.question_id === right.question_id &&
		left.authority_mode === right.authority_mode &&
		left.subject_kind === right.subject_kind &&
		left.created_at === right.created_at
	);
}

function defaultAuthorize(
	input: ShadowLeadAuthorizationInput,
	env: NodeJS.ProcessEnv,
): LeadWriteAuthorization {
	const authorizationEnv = forwardedLeadAuthorizationEnv(
		{
			claimedLeadId: input.leadId,
			projectName: input.projectName,
			identityDigest: input.identityDigest,
			leaseClaim: input.leaseClaim,
			carrierClaim: input.carrierClaim,
		},
		env,
	);
	return authorizeLeadWrite({
		claimedLeadId: input.leadId,
		env: authorizationEnv,
	});
}

export function createAutoMergeShadowRouter(
	deps: AutoMergeShadowRouterDeps,
): express.Router {
	const router = express.Router();
	router.post("/shadow-declaration", async (req, res) => {
		if (rejectNonLoopback(req, res)) return;
		const parsed = parseBody(req.body);
		if (!parsed.ok) {
			reject(res, 400, parsed.reason);
			return;
		}
		const body = parsed.body;
		const holder = deps.store.getWorkflowGateHolderByQuestionId(
			body.questionId,
		);
		if (!holder) {
			reject(res, 404, "question_unknown");
			return;
		}
		if (!isShipGate(holder)) {
			reject(res, 422, "not_a_ship_gate");
			return;
		}
		const run = deps.store.getWorkflowRun(holder.run_id);
		if (!run) {
			reject(res, 503, "lead_identity_unavailable");
			return;
		}
		if (run.project_name !== body.projectName) {
			reject(res, 403, "project_mismatch");
			return;
		}
		const lead = resolveLeadIdentityForShadowDeclaration({
			store: deps.store,
			projects: deps.projects,
			holder,
		});
		if (!lead.ok) {
			reject(res, 503, lead.reason);
			return;
		}
		if (body.leadId !== lead.agentId) {
			reject(res, 403, "lead_mismatch");
			return;
		}
		if (body.proof.proofMethod === "lead_hmac") {
			if (!lead.botToken) {
				reject(res, 503, "lead_hmac_secret_unavailable");
				return;
			}
			if (
				!verifyShadowDeclarationProof(
					{
						declarationId: body.declarationId,
						questionId: body.questionId,
						declaredClass: body.declaredClass,
						leadId: body.leadId,
						projectName: body.projectName,
					},
					lead.botToken,
					body.proof.hmacSha256,
				)
			) {
				reject(res, 403, "lead_hmac_invalid");
				return;
			}
		}

		const authorizationInput: ShadowLeadAuthorizationInput = {
			leadId: body.leadId,
			projectName: body.projectName,
			identityDigest: body.identityDigest,
			proofMethod: body.proof.proofMethod,
			...(body.proof.proofMethod === "lead_hmac"
				? { leaseClaim: body.proof.leaseClaim }
				: { carrierClaim: body.proof.carrierClaim }),
		};
		let authorization: LeadWriteAuthorization;
		try {
			authorization = await (deps.authorize
				? deps.authorize(authorizationInput)
				: defaultAuthorize(authorizationInput, deps.env ?? process.env));
		} catch {
			reject(res, 403, "lead_authorization_invalid");
			return;
		}
		const expectedDisposition =
			body.proof.proofMethod === "lead_hmac"
				? "lease_validated"
				: "carrier_passthrough";
		if (
			authorization.disposition !== expectedDisposition ||
			authorization.identityDigest !== body.identityDigest
		) {
			reject(res, 403, "lead_authorization_invalid");
			return;
		}

		const declaredAt = deps.now?.() ?? new Date().toISOString();
		const declaredAtMs = Date.parse(declaredAt);
		const holderCreatedAtMs = Date.parse(holder.created_at);
		if (
			!Number.isFinite(declaredAtMs) ||
			!Number.isFinite(holderCreatedAtMs) ||
			new Date(declaredAtMs).toISOString() !== declaredAt
		) {
			reject(res, 503, "server_time_invalid");
			return;
		}
		if (declaredAtMs < holderCreatedAtMs) {
			reject(res, 503, "server_time_predates_card");
			return;
		}

		const existing = deps.store
			.listAutoMergeShadowDeclarations(body.questionId)
			.find((row) => row.declaration_id === body.declarationId);
		if (existing) {
			if (!canonicalReplay(existing, body)) {
				reject(res, 409, "declaration_conflict");
				return;
			}
			res.json({ ok: true, status: "replayed", declaration: existing });
			return;
		}
		const refreshedHolder = deps.store.getWorkflowGateHolderByQuestionId(
			body.questionId,
		);
		if (!refreshedHolder || !sameHolder(holder, refreshedHolder)) {
			reject(res, 409, "holder_changed");
			return;
		}
		const result = deps.store.recordAutoMergeShadowDeclaration({
			declarationId: body.declarationId,
			questionId: body.questionId,
			runId: holder.run_id,
			declaredClass: body.declaredClass,
			declaredBy: lead.agentId,
			evidenceKind: "lead_authenticated",
			leadIdentityDigest: body.identityDigest,
			leadAuthMethod: body.proof.proofMethod,
			declaredAt,
		});
		if (!result.ok) {
			const status =
				result.reason === "question_unknown"
					? 404
					: result.reason === "invalid_declaration"
						? 400
						: 409;
			reject(res, status, result.reason);
			return;
		}
		res.status(result.status === "created" ? 201 : 200).json({
			ok: true,
			status: result.status,
			declaration: result.row,
		});
	});
	return router;
}
