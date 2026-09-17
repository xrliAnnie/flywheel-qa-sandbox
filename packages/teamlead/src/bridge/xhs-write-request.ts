import { z } from "zod";
import {
	xhsWritePrepareInput,
	xhsWriteProposalInput,
	xhsWriteReceiptInput,
} from "../lead-capabilities/xiaohongshu-write-input.js";
import { parseStrictJson } from "../xiaohongshu-write/canonical.js";
import { WRITE_OPERATIONS } from "../xiaohongshu-write/contracts.js";

const envelope = z
	.object({ requestId: z.string().uuid(), input: z.unknown() })
	.strict();
const execute = xhsWriteReceiptInput
	.extend({ operationId: z.enum(WRITE_OPERATIONS) })
	.strict();
export const xhsBridgeWriteInputs = {
	prepare: xhsWritePrepareInput,
	execute,
	status: xhsWriteProposalInput,
	cancel: xhsWriteProposalInput,
} as const;
const prefix = "/api/lead/xiaohongshu/write/";
/** Payload-only contract. The route must authenticate current parent context
 * independently; neither caller text nor these identifiers confer approval. */
export function parseXhsWriteRequest(path: string, raw: string) {
	try {
		if (typeof raw !== "string" || Buffer.byteLength(raw) > 262144)
			throw Error();
		const body = envelope.parse(parseStrictJson(raw));
		if (path === `${prefix}prepare`)
			return {
				action: "prepare" as const,
				requestId: body.requestId,
				input: xhsWritePrepareInput.parse(body.input),
			};
		if (path === `${prefix}execute`)
			return {
				action: "execute" as const,
				requestId: body.requestId,
				input: execute.parse(body.input),
			};
		if (path === `${prefix}status` || path === `${prefix}cancel`)
			return {
				action:
					path === `${prefix}status`
						? ("status" as const)
						: ("cancel" as const),
				requestId: body.requestId,
				input: xhsWriteProposalInput.parse(body.input),
			};
		throw Error();
	} catch {
		throw Error("xhs_request_invalid");
	}
}
