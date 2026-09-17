import { createHmac } from "node:crypto";
import { z } from "zod";
import { canonical } from "./canonical.js";

const identifier = z.string().min(1).max(256);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const inputSchema = z
	.object({
		audience: identifier,
		proposalId: identifier,
		receiptId: identifier,
		attemptId: identifier,
		contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
		accountUserId: identifier,
		accountEpoch: time,
		providerGeneration: identifier,
		leaseId: identifier,
		keyId: identifier,
		approvalExpiresAt: time,
		leaseExpiresAt: time,
	})
	.strict();
export type DispatchPermitInput = z.infer<typeof inputSchema>;
/** Authority-private result. Never expose permitJson or signature through model-facing status. */
export function signDispatchPermit(
	input: DispatchPermitInput,
	key: Buffer,
	now: number,
): { permitJson: string; signature: string } {
	try {
		if (!Buffer.isBuffer(key) || key.length !== 32) throw Error();
		time.parse(now);
		const { approvalExpiresAt, leaseExpiresAt, ...identity } =
			inputSchema.parse(input);
		const expiresAt = Math.min(approvalExpiresAt, leaseExpiresAt, now + 60000);
		if (expiresAt <= now) throw Error();
		const permitJson = canonical({
			...identity,
			purpose: "flywheel:xhs-dispatch:v1",
			issuer: "xhs-authority",
			issuedAt: now,
			expiresAt,
		});
		const signature = createHmac("sha256", key)
			.update("flywheel:xhs-permit:v1\n")
			.update(permitJson, "utf8")
			.digest("hex");
		return { permitJson, signature };
	} catch {
		throw Error("write_permit_invalid");
	}
}

/** Exact private provider wire shape; independent of model-facing input schemas. */
export const dispatchPermitSchema = z
	.object({
		purpose: z.literal("flywheel:xhs-dispatch:v1"),
		issuer: z.literal("xhs-authority"),
		audience: identifier,
		proposalId: identifier,
		receiptId: identifier,
		attemptId: identifier,
		contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
		accountUserId: identifier,
		accountEpoch: time.min(1),
		providerGeneration: identifier,
		leaseId: identifier,
		keyId: identifier,
		issuedAt: time,
		expiresAt: time,
	})
	.strict()
	.refine((p) => p.expiresAt > p.issuedAt && p.expiresAt - p.issuedAt <= 60000);
export type DispatchPermit = z.infer<typeof dispatchPermitSchema>;
