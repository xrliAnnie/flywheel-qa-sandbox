import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import {
	type LeadOperationRequest,
	type LeadOperationResult,
	parseLeadOperationRequest,
	requestLeadOperation,
} from "../lead-operation-client.js";

const MAX_INPUT_BYTES = 65536;
const STATUS_EXIT = {
	succeeded: 0,
	rejected: 3,
	pending: 4,
	unknown: 5,
} as const;
const TRANSPORT_ERRORS = new Set([
	"broker_connection_failed",
	"broker_response_timeout",
	"broker_response_incomplete",
	"broker_response_invalid",
	"broker_response_too_large",
]);
class InputError extends Error {}
export interface LeadOperationCommandDeps {
	env?: NodeJS.ProcessEnv;
	stdin?: AsyncIterable<Buffer | string>;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	requestClient?: typeof requestLeadOperation;
}
async function boundedInput(
	input: AsyncIterable<Buffer | string>,
): Promise<string> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of input) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += bytes.length;
		if (total > MAX_INPUT_BYTES)
			throw new InputError("request_input_too_large");
		chunks.push(bytes);
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(
			Buffer.concat(chunks),
		);
	} catch {
		throw new InputError("request_input_invalid");
	}
}
async function readRequest(
	path: string,
	stdin: AsyncIterable<Buffer | string>,
): Promise<string> {
	if (path === "-") return boundedInput(stdin);
	if (!isAbsolute(path) || path.includes("\0"))
		throw new InputError("request_path_invalid");
	// A FIFO must not block open before the regular-file check.
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw new InputError("request_input_not_file");
		if (stat.size > MAX_INPUT_BYTES)
			throw new InputError("request_input_too_large");
		// The extra byte detects growth after stat without reading an unbounded file.
		return await boundedInput(
			file.createReadStream({
				start: 0,
				end: MAX_INPUT_BYTES,
				autoClose: false,
			}),
		);
	} finally {
		await file.close();
	}
}

/** Narrow socket client: no DB/actor lookup, credentials, HTTP fallback or retry. */
export async function runLeadOperationCommand(
	args: string[],
	deps: LeadOperationCommandDeps = {},
): Promise<number> {
	const stdout = deps.stdout ?? console.log,
		stderr = deps.stderr ?? console.error;
	let requestId: string | undefined;
	try {
		const { values, tokens } = parseArgs({
			args,
			options: {
				"request-file": { type: "string" },
				help: { type: "boolean" },
			},
			allowPositionals: false,
			tokens: true,
		});
		if (values.help && args.length === 1) {
			stdout(
				"Usage: flywheel-comm lead-operation --request-file <absolute-path|->\nReads one JSON operation envelope (maximum 64 KiB). Socket: FLYWHEEL_LEAD_CAPABILITY_SOCKET only.\nKeep the same requestId after a lost reply; this command never retries. Obtain operation IDs and input schemas from the capability catalog via MCP.\nExit codes: 0 succeeded/help, 2 invalid input/configuration, 3 rejected, 4 pending, 5 unknown.",
			);
			return 0;
		}
		if (
			values.help ||
			!values["request-file"] ||
			tokens.filter((t) => t.kind === "option" && t.name === "request-file")
				.length !== 1
		)
			throw new InputError("request_arguments_invalid");
		const socket = (deps.env ?? process.env).FLYWHEEL_LEAD_CAPABILITY_SOCKET;
		if (!socket) throw new InputError("broker_socket_missing");
		let text: string;
		try {
			text = await readRequest(
				values["request-file"],
				deps.stdin ?? process.stdin,
			);
		} catch (error) {
			throw error instanceof InputError
				? error
				: new InputError("request_input_unreadable");
		}
		let request: LeadOperationRequest;
		try {
			request = parseLeadOperationRequest(JSON.parse(text));
		} catch {
			throw new InputError("request_input_invalid");
		}
		requestId = request.requestId;
		let result: LeadOperationResult;
		try {
			result = await (deps.requestClient ?? requestLeadOperation)(
				socket,
				request,
			);
		} catch (error) {
			const code = error instanceof Error ? error.message : "";
			if (
				[
					"broker_request_invalid",
					"broker_request_too_large",
					"broker_socket_invalid",
				].includes(code)
			)
				throw new InputError(code);
			result = {
				requestId,
				status: "unknown",
				resourceRefs: [],
				errorCode: TRANSPORT_ERRORS.has(code)
					? code
					: "broker_transport_failed",
			};
		}
		stdout(JSON.stringify(result));
		return STATUS_EXIT[result.status];
	} catch (error) {
		stderr(
			JSON.stringify({
				status: "rejected",
				...(requestId ? { requestId } : {}),
				errorCode:
					error instanceof InputError
						? error.message
						: "request_arguments_invalid",
			}),
		);
		return 2;
	}
}
