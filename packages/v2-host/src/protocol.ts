import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection, type Socket } from "node:net";

export const HOST_PROTOCOL_VERSION = 1;
export const MAX_HOST_FRAME_BYTES = 1_048_576;

export interface HostRequest {
	v: 1;
	id: string;
	nonce: string;
	action: string;
	payload: unknown;
	mac: string;
}

export type HostResponse =
	| { v: 1; id: string; ok: true; result: unknown }
	| {
			v: 1;
			id: string;
			ok: false;
			error: { name: string; message: string };
	  };

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function macPayload(request: Omit<HostRequest, "mac">): string {
	return [
		String(request.v),
		request.id,
		request.nonce,
		request.action,
		canonicalJson(request.payload),
	].join("\n");
}

export function signHostRequest(
	request: Omit<HostRequest, "mac">,
	secret: Buffer,
): HostRequest {
	return {
		...request,
		mac: createHmac("sha256", secret).update(macPayload(request)).digest("hex"),
	};
}

export function verifyHostRequest(request: HostRequest, secret: Buffer): void {
	if (
		request.v !== HOST_PROTOCOL_VERSION ||
		typeof request.id !== "string" ||
		request.id.length === 0 ||
		typeof request.nonce !== "string" ||
		!/^[0-9a-f]{32}$/.test(request.nonce) ||
		typeof request.action !== "string" ||
		request.action.length === 0 ||
		typeof request.mac !== "string" ||
		!/^[0-9a-f]{64}$/.test(request.mac)
	) {
		throw new TypeError("host request envelope is malformed");
	}
	const expected = signHostRequest(
		{
			v: 1,
			id: request.id,
			nonce: request.nonce,
			action: request.action,
			payload: request.payload,
		},
		secret,
	).mac;
	if (
		!timingSafeEqual(
			Buffer.from(request.mac, "hex"),
			Buffer.from(expected, "hex"),
		)
	) {
		throw new Error("host request authentication failed");
	}
}

function readOneFrame(socket: Socket, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffered = "";
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error("host IPC response timed out"));
		}, timeoutMs);
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffered += chunk;
			if (Buffer.byteLength(buffered, "utf8") > MAX_HOST_FRAME_BYTES) {
				clearTimeout(timeout);
				socket.destroy();
				reject(new Error("host IPC response exceeds frame limit"));
				return;
			}
			const newline = buffered.indexOf("\n");
			if (newline >= 0) {
				clearTimeout(timeout);
				socket.end();
				resolve(buffered.slice(0, newline));
			}
		});
		socket.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		socket.once("end", () => {
			if (!buffered.includes("\n")) {
				clearTimeout(timeout);
				reject(new Error("host IPC closed before a complete frame"));
			}
		});
	});
}

export async function sendHostRequest<Result>(options: {
	socketPath: string;
	secret: Buffer;
	action: string;
	payload: unknown;
	timeoutMs?: number;
	id?: string;
	nonce?: string;
}): Promise<Result> {
	const request = signHostRequest(
		{
			v: 1,
			id: options.id ?? randomBytes(16).toString("hex"),
			nonce: options.nonce ?? randomBytes(16).toString("hex"),
			action: options.action,
			payload: options.payload,
		},
		options.secret,
	);
	const socket = createConnection(options.socketPath);
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	socket.write(`${JSON.stringify(request)}\n`);
	const raw = await readOneFrame(socket, options.timeoutMs ?? 15_000);
	const response = JSON.parse(raw) as HostResponse;
	if (
		response.v !== 1 ||
		response.id !== request.id ||
		typeof response.ok !== "boolean"
	) {
		throw new Error("host IPC response is malformed");
	}
	if (!response.ok) {
		const error = new Error(response.error.message);
		error.name = response.error.name;
		throw error;
	}
	return response.result as Result;
}
