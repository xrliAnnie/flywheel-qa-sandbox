import { z } from "zod";
import {
	WRITE_OPERATIONS,
	xhsDraftPayloadSchema,
} from "../xiaohongshu-write/contracts.js";

const handle = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const xhsWritePrepareInput = z
	.object({
		operationId: z.enum(WRITE_OPERATIONS),
		accountSelector: handle,
		payload: xhsDraftPayloadSchema,
		artifactHandles: z.array(handle).max(18),
		resourceHandle: handle.optional(),
	})
	.strict();
export const xhsWriteProposalInput = z
	.object({ proposalId: z.string().uuid() })
	.strict();

/** Receipt references select a frozen proposal; they never carry mutable content. */
export const xhsWriteReceiptInput = z
	.object({
		proposalId: z.string().uuid(),
		receiptId: z.string().uuid(),
		expectedContentDigest: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
