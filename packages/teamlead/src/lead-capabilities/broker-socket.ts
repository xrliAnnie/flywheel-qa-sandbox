import { chmodSync, existsSync, lstatSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join, normalize } from "node:path";
import {
	leadOperationRequestBytes,
	leadOperationServerSocketTimeoutMs,
	MAX_LEAD_OPERATION_FRAME_BYTES,
} from "flywheel-comm/lead-operation-client";

export interface LeadCapabilitySocketOptions {
	socketPath: string;
	/** Only a trusted typed broker engine may be supplied here. */
	dispatch(request: unknown): Promise<unknown>;
}
/** A Unix socket path above this does not bind reliably on macOS (sun_path 104). */
export const LEAD_BROKER_SOCKET_MAX_BYTES = 100;
/** Bytes of the socket a parent binds under this root: `<root>/run-XXXXXX/broker.sock`. */
export function leadBrokerSocketBytes(activationRoot: string): number {
	return Buffer.byteLength(join(activationRoot, "run-XXXXXX", "broker.sock"));
}
const rejection = (errorCode: string, status = "rejected") => ({
	requestId: null,
	status,
	resourceRefs: [],
	errorCode,
});
/** One bounded JSON request per connection. Connecting never returns credentials. */
export class LeadCapabilitySocket {
	private server?: Server;
	private readonly connections = new Set<Socket>();
	constructor(private readonly options: LeadCapabilitySocketOptions) {}
	async listen(): Promise<void> {
		if (this.server) return;
		const { socketPath } = this.options;
		if (
			!isAbsolute(socketPath) ||
			normalize(socketPath) !== socketPath ||
			Buffer.byteLength(socketPath) > LEAD_BROKER_SOCKET_MAX_BYTES
		)
			throw new Error("invalid_broker_socket_path");
		const directory = lstatSync(dirname(socketPath));
		if (
			!directory.isDirectory() ||
			directory.isSymbolicLink() ||
			(directory.mode & 0o077) !== 0 ||
			directory.uid !== process.getuid?.()
		)
			throw new Error("broker_directory_not_private");
		if (existsSync(socketPath)) throw new Error("broker_socket_path_exists");
		const server = createServer((connection) => this.accept(connection));
		server.maxConnections = 32;
		// A connection error is isolated to that connection. No raw error text crosses the protocol.
		server.on("error", () => {});
		await new Promise<void>((resolve, reject) => {
			const fail = () => reject(new Error("broker_socket_listen_failed"));
			server.once("error", fail);
			server.listen(socketPath, () => {
				server.removeListener("error", fail);
				resolve();
			});
		});
		this.server = server;
		try {
			chmodSync(socketPath, 0o600);
		} catch {
			await this.close();
			throw new Error("broker_socket_mode_failed");
		}
	}
	private accept(connection: Socket): void {
		this.connections.add(connection);
		connection.on("close", () => this.connections.delete(connection));
		connection.on("error", () => connection.destroy());
		let buffer = Buffer.alloc(0),
			started = false,
			replied = false;
		const reply = (result: unknown) => {
			if (connection.destroyed || replied) return;
			replied = true;
			let text: string;
			try {
				text = JSON.stringify(result);
			} catch {
				text = JSON.stringify(rejection("broker_result_invalid", "unknown"));
			}
			if (typeof text !== "string" || Buffer.byteLength(text) > 256 * 1024)
				text = JSON.stringify(rejection("broker_result_too_large", "unknown"));
			// A peer may deliberately keep its write side open after receiving the
			// result. Bound the flush and destroy our side so half-open peers cannot
			// retain one of the broker's limited connection slots.
			connection.setTimeout(1000);
			connection.end(`${text}\n`, () => connection.destroy());
		};
		connection.setTimeout(16000, () => {
			if (replied) {
				connection.destroy();
				return;
			}
			reply(
				rejection(
					"broker_connection_timeout",
					started ? "unknown" : "rejected",
				),
			);
		});
		connection.on("data", (chunk: Buffer) => {
			if (started) return;
			if (buffer.length + chunk.length > MAX_LEAD_OPERATION_FRAME_BYTES) {
				started = true;
				reply(rejection("request_too_large"));
				return;
			}
			buffer = Buffer.concat([buffer, chunk]);
			const newline = buffer.indexOf(10);
			if (newline < 0) return;
			started = true;
			if (
				buffer
					.subarray(newline + 1)
					.toString("utf8")
					.trim()
			) {
				reply(rejection("multiple_requests"));
				return;
			}
			let request: unknown;
			try {
				request = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
			} catch {
				reply(rejection("request_invalid"));
				return;
			}
			const frameBytes = buffer.length;
			buffer = Buffer.alloc(0);
			const operationId =
				request && typeof request === "object" && "operationId" in request
					? String(request.operationId)
					: "";
			if (frameBytes > leadOperationRequestBytes(operationId)) {
				reply(rejection("request_too_large"));
				return;
			}
			connection.setTimeout(leadOperationServerSocketTimeoutMs(operationId));
			void Promise.resolve()
				.then(() => this.options.dispatch(request))
				.then(reply, () =>
					reply(rejection("broker_dispatch_failed", "unknown")),
				);
		});
	}
	async close(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		for (const socket of this.connections) socket.destroy();
		this.connections.clear();
		if (server)
			await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}
