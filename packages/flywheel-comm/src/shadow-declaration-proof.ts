import { createHmac, timingSafeEqual } from "node:crypto";

export const SHADOW_DECLARATION_PROOF_VERSION =
	"flywheel-shadow-declare-v1" as const;

export interface ShadowDeclarationProofInput {
	declarationId: string;
	questionId: string;
	declaredClass: string;
	leadId: string;
	projectName: string;
}

export function canonicalShadowDeclarationProof(
	input: ShadowDeclarationProofInput,
): string {
	return JSON.stringify([
		SHADOW_DECLARATION_PROOF_VERSION,
		input.declarationId,
		input.questionId,
		input.declaredClass,
		input.leadId,
		input.projectName,
	]);
}

export function signShadowDeclarationProof(
	input: ShadowDeclarationProofInput,
	secret: string,
): string {
	return createHmac("sha256", secret)
		.update(canonicalShadowDeclarationProof(input))
		.digest("hex");
}

export function verifyShadowDeclarationProof(
	input: ShadowDeclarationProofInput,
	secret: string,
	candidate: string,
): boolean {
	if (!/^[0-9a-f]{64}$/.test(candidate)) return false;
	const expected = Buffer.from(
		signShadowDeclarationProof(input, secret),
		"hex",
	);
	const actual = Buffer.from(candidate, "hex");
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}
