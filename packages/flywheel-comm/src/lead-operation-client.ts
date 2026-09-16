import { createConnection } from "node:net";
import { isAbsolute, normalize } from "node:path";

/** Parent-owned execution policy; model inputs cannot extend a deadline. */
export function leadOperationTimeoutMs(operationId: string): number {
	return operationId === "git.feature.push" ? 180000 : 15000;
}

/** Text ingress permits 512 KiB of UTF-8 plus worst-case JSON escaping and envelope. */
export const MAX_LEAD_OPERATION_FRAME_BYTES = 6 * 512 * 1024 + 65536;
export function leadOperationRequestBytes(operationId: string): number {
	return operationId === "artifact.text.create"
		? MAX_LEAD_OPERATION_FRAME_BYTES
		: 65536;
}

export interface LeadOperationRequest {
	schemaVersion: 1;
	operationId: string;
	requestId: string;
	input: unknown;
}
export interface LeadOperationResult {
	requestId: string;
	status: "succeeded" | "rejected" | "pending" | "unknown";
	resourceRefs: string[];
	data?: unknown;
	errorCode?: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const uuid =
	/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function parseLeadOperationRequest(raw: unknown): LeadOperationRequest {
	if (
		!object(raw) ||
		Object.keys(raw).some(
			(key) =>
				!["schemaVersion", "operationId", "requestId", "input"].includes(key),
		) ||
		raw.schemaVersion !== 1 ||
		typeof raw.operationId !== "string" ||
		!/^[a-z][a-z0-9_.]{1,255}$/.test(raw.operationId) ||
		typeof raw.requestId !== "string" ||
		!uuid.test(raw.requestId) ||
		!Object.hasOwn(raw, "input")
	)
		throw new Error("broker_request_invalid");
	return raw as unknown as LeadOperationRequest;
}
function result(raw: unknown, requestId: string): LeadOperationResult {
	// A single-request socket can reject a frame before parsing its UUID.
	// Never correlate unbound outcomes that could represent a dispatched effect.
	if (
		object(raw) &&
		raw.requestId === null &&
		raw.status === "rejected" &&
		!Object.hasOwn(raw, "data") &&
		Array.isArray(raw.resourceRefs) &&
		raw.resourceRefs.length === 0 &&
		[
			"request_too_large",
			"multiple_requests",
			"request_invalid",
			"broker_connection_timeout",
		].includes(String(raw.errorCode))
	)
		raw = { ...raw, requestId };
	if (
		!object(raw) ||
		Object.keys(raw).some(
			(key) =>
				!["requestId", "status", "resourceRefs", "data", "errorCode"].includes(
					key,
				),
		) ||
		raw.requestId !== requestId ||
		!["succeeded", "rejected", "pending", "unknown"].includes(
			String(raw.status),
		) ||
		!Array.isArray(raw.resourceRefs) ||
		raw.resourceRefs.length > 100 ||
		raw.resourceRefs.some(
			(ref) => typeof ref !== "string" || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(ref),
		) ||
		(raw.errorCode !== undefined &&
			(typeof raw.errorCode !== "string" ||
				!/^[a-z][a-z0-9_]{0,95}$/.test(raw.errorCode)))
	)
		throw new Error("broker_response_invalid");
	return raw as unknown as LeadOperationResult;
}
/** No credentials, HTTP fallback, or automatic retries. Retain requestId after any lost response. */
export async function requestLeadOperation(
	socketPath: string,
	raw: LeadOperationRequest,
): Promise<LeadOperationResult> {
	const request = parseLeadOperationRequest(raw);
	let frame: string;
	try {
		frame = JSON.stringify(request);
	} catch {
		throw new Error("broker_request_invalid");
	}
	if (
		Buffer.byteLength(frame) + 1 >
		leadOperationRequestBytes(request.operationId)
	)
		throw new Error("broker_request_too_large");
	if (
		!isAbsolute(socketPath) ||
		normalize(socketPath) !== socketPath ||
		Buffer.byteLength(socketPath) > 100 ||
		socketPath.includes("\0")
	)
		throw new Error("broker_socket_invalid");
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let bytes = Buffer.alloc(0),
			settled = false;
		const fail = (code: string) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			reject(new Error(code));
		};
		const timer = setTimeout(
			() => fail("broker_response_timeout"),
			leadOperationTimeoutMs(request.operationId) + 1000,
		);
		socket.on("connect", () => socket.write(`${frame}\n`));
		socket.on("error", () => fail("broker_connection_failed"));
		socket.on("close", () => {
			clearTimeout(timer);
			if (!settled) fail("broker_response_incomplete");
		});
		socket.on("data", (chunk: Buffer) => {
			if (bytes.length + chunk.length > 262145) {
				fail("broker_response_too_large");
				return;
			}
			bytes = Buffer.concat([bytes, chunk]);
		});
		socket.on("end", () => {
			if (settled) return;
			try {
				const newline = bytes.indexOf(10);
				if (newline < 0) {
					fail("broker_response_incomplete");
					return;
				}
				if (
					bytes
						.subarray(newline + 1)
						.toString("utf8")
						.trim()
				) {
					fail("broker_response_invalid");
					return;
				}
				const parsed = result(
					JSON.parse(bytes.subarray(0, newline).toString("utf8")),
					request.requestId,
				);
				settled = true;
				clearTimeout(timer);
				socket.destroy();
				resolve(parsed);
			} catch {
				fail("broker_response_invalid");
			}
		});
	});
}
