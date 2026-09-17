import {
	createPrivateKey,
	createPublicKey,
	sign as cryptoSign,
	verify as cryptoVerify,
} from "node:crypto";
import { canonicalJsonString } from "flywheel-config";

export interface LandMergeTicketEnvelopePayload {
	version: 1;
	ticketId: string;
	repoIdentity: string;
	prNumber: number;
	rootGateId: string;
	headSha: string;
	operationGeneration: number;
	nonce: string;
	issuedAt: string;
	expiresAt: string;
}

export interface LandMergeTicketEnvelope
	extends LandMergeTicketEnvelopePayload {
	signature: string;
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function validPayload(payload: LandMergeTicketEnvelopePayload): boolean {
	return (
		payload.version === 1 &&
		payload.ticketId.startsWith("land-merge-ticket:") &&
		payload.repoIdentity.length > 0 &&
		Number.isInteger(payload.prNumber) &&
		payload.prNumber > 0 &&
		payload.rootGateId.length > 0 &&
		FULL_SHA.test(payload.headSha) &&
		Number.isInteger(payload.operationGeneration) &&
		payload.operationGeneration >= 0 &&
		DIGEST.test(payload.nonce) &&
		Number.isFinite(Date.parse(payload.issuedAt)) &&
		Number.isFinite(Date.parse(payload.expiresAt)) &&
		Date.parse(payload.expiresAt) > Date.parse(payload.issuedAt)
	);
}

export function landMergeTicketPayload(
	payload: LandMergeTicketEnvelopePayload,
): string {
	if (!validPayload(payload))
		throw new Error("invalid_land_merge_ticket_payload");
	return canonicalJsonString(payload);
}

export function signLandMergeTicket(input: {
	payload: LandMergeTicketEnvelopePayload;
	privateKeyPem: string;
}): LandMergeTicketEnvelope {
	const message = Buffer.from(landMergeTicketPayload(input.payload), "utf8");
	const signature = cryptoSign(
		null,
		message,
		createPrivateKey(input.privateKeyPem),
	).toString("base64url");
	return { ...input.payload, signature };
}

export function verifyLandMergeTicket(input: {
	envelope: LandMergeTicketEnvelope;
	publicKeyPem: string;
	now: string;
}): boolean {
	if (!input.envelope.signature || !Number.isFinite(Date.parse(input.now)))
		return false;
	const { signature, ...payload } = input.envelope;
	if (
		!validPayload(payload) ||
		Date.parse(input.now) > Date.parse(payload.expiresAt)
	)
		return false;
	try {
		return cryptoVerify(
			null,
			Buffer.from(landMergeTicketPayload(payload), "utf8"),
			createPublicKey(input.publicKeyPem),
			Buffer.from(signature, "base64url"),
		);
	} catch {
		return false;
	}
}

export function renderLandMergeTicketComment(
	envelope: LandMergeTicketEnvelope,
): string {
	const encoded = Buffer.from(canonicalJsonString(envelope), "utf8").toString(
		"base64url",
	);
	return `:cool:\n<!-- flywheel-land-ticket-v1 ${encoded} -->`;
}

export function parseLandMergeTicketComment(
	body: string,
): LandMergeTicketEnvelope | undefined {
	const match = body.match(
		/^:cool:\r?\n<!-- flywheel-land-ticket-v1 ([A-Za-z0-9_-]+) -->$/,
	);
	if (!match) return undefined;
	try {
		const envelope = JSON.parse(
			Buffer.from(match[1]!, "base64url").toString("utf8"),
		) as LandMergeTicketEnvelope;
		const { signature, ...payload } = envelope;
		return typeof signature === "string" && validPayload(payload)
			? envelope
			: undefined;
	} catch {
		return undefined;
	}
}
