import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { canonical, parseStrictJson } from "./canonical.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const statementSchema = z
	.object({
		schemaVersion: z.literal(1),
		configDigest: digest,
		providerBinarySha256: digest,
		toolSchemaDigest: digest,
		probeSha256: digest,
		manifestSha256: digest,
		bootstrapSha256: digest,
		probeKind: z.literal("fixture_harness"),
		passed: z.literal(true),
		hostAcceptance: z.literal(false),
		notCovered: z.tuple([
			z.literal("real_claude_context"),
			z.literal("real_codex_context"),
			z.literal("real_runner_context"),
			z.literal("real_login_context"),
			z.literal("process_authority"),
			z.literal("privilege_paths"),
			z.literal("private_transport"),
			z.literal("headless_service"),
			z.literal("legacy_cutover"),
		]),
	})
	.strict();
const envelope = z
	.object({ statement: statementSchema, signature: z.string() })
	.strict();
const expectedSchema = z
	.object({
		publicKey: z.string(),
		configDigest: digest,
		providerBinarySha256: digest,
		toolSchemaDigest: digest,
		probeSha256: digest,
		manifestSha256: digest,
		bootstrapSha256: digest,
	})
	.strict();

/** Verification only. The public key and expected measurements must come from
 * root-owned policy and the trusted loader, never from an ingress request. */
export function verifyBoundaryAcceptance(
	raw: string,
	input: z.infer<typeof expectedSchema>,
): void {
	try {
		if (Buffer.byteLength(raw) > 4096) throw Error();
		const expected = expectedSchema.parse(input);
		const { statement, signature } = envelope.parse(parseStrictJson(raw));
		const key = Buffer.from(expected.publicKey, "base64");
		const sig = Buffer.from(signature, "base64");
		if (
			key.length !== 32 ||
			key.toString("base64") !== expected.publicKey ||
			sig.length !== 64 ||
			sig.toString("base64") !== signature ||
			statement.configDigest !== expected.configDigest ||
			statement.providerBinarySha256 !== expected.providerBinarySha256 ||
			statement.toolSchemaDigest !== expected.toolSchemaDigest ||
			statement.probeSha256 !== expected.probeSha256 ||
			statement.manifestSha256 !== expected.manifestSha256 ||
			statement.bootstrapSha256 !== expected.bootstrapSha256
		)
			throw Error();
		const publicKey = createPublicKey({
			key: { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") },
			format: "jwk",
		});
		if (
			!verify(
				null,
				Buffer.from(`flywheel:xhs-boundary:v1\n${canonical(statement)}`),
				publicKey,
				sig,
			)
		)
			throw Error();
	} catch {
		throw Error("boundary_unproven");
	}
}
