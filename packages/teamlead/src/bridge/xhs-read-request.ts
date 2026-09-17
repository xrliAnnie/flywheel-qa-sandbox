import { z } from "zod";
import { parseStrictJson } from "../xiaohongshu-write/canonical.js";
import { loginReadOperation } from "../xiaohongshu-write/login-contract.js";
import {
	publicReadInputs,
	publicReadOperation,
} from "../xiaohongshu-write/provider-read-contract.js";
export const xhsBridgeReadOperation = z.enum([
	...publicReadOperation.options,
	...loginReadOperation.options,
]);
export const xhsBridgeReadInputs = {
	...publicReadInputs,
	check_login_status: z.object({}).strict(),
	get_login_qrcode: z.object({}).strict(),
};
export const xhsBridgeReadPaths = xhsBridgeReadOperation.options.map(
	(action) => `/api/lead/xiaohongshu/read/${action}`,
);
export function parseXhsReadRequest(path: string, raw: string) {
	try {
		if (!xhsBridgeReadPaths.includes(path) || Buffer.byteLength(raw) > 262144)
			throw Error();
		const action = xhsBridgeReadOperation.parse(
			path.slice("/api/lead/xiaohongshu/read/".length),
		);
		const body = z
			.object({ requestId: z.string().uuid(), input: z.unknown() })
			.strict()
			.parse(parseStrictJson(raw));
		return {
			action,
			requestId: body.requestId,
			input: xhsBridgeReadInputs[action].parse(body.input),
		};
	} catch {
		throw Error("xhs_request_invalid");
	}
}
