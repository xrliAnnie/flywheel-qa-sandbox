import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { z } from "zod";
import { parseXhsReadRequest } from "../bridge/xhs-read-request.js";
import { parseXhsWriteRequest } from "../bridge/xhs-write-request.js";
import { authorityResponseSchemas } from "./authority-client.js";
import { parseStrictJson } from "./canonical.js";
import { artifactSchema } from "./contracts.js";

/** Claude launch references are routing claims, never founder authorization.
 * Bridge revalidates the current canonical identity/lease for each request. */
export function createClaudeXhsBridgeClient(inputEnv: NodeJS.ProcessEnv) {
	let origin: string, token: string, context: string;
	try {
		const env = { ...inputEnv };
		const url = new URL(env.BRIDGE_URL ?? "http://localhost:9876");
		if (
			url.protocol !== "http:" ||
			!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			throw Error();
		origin = url.origin;
		token = z
			.string()
			.min(1)
			.max(4096)
			.regex(/^[^\r\n]+$/)
			.parse(env.TEAMLEAD_API_TOKEN);
		const id = z.string().min(1).max(256);
		const rawGeneration = z
			.string()
			.regex(/^[1-9][0-9]*$/)
			.parse(env.FLYWHEEL_LEAD_GENERATION);
		const claim = {
			projectName: id.parse(env.FLYWHEEL_PROJECT_NAME),
			leadId: id.parse(env.FLYWHEEL_LEAD_ID),
			identityDigest: z
				.string()
				.regex(/^[a-f0-9]{64}$/)
				.parse(env.FLYWHEEL_LEAD_IDENTITY_DIGEST),
			leaseClaim: {
				leaseKey: id.parse(env.FLYWHEEL_LEAD_LEASE_KEY),
				generation: z
					.number()
					.int()
					.positive()
					.max(Number.MAX_SAFE_INTEGER)
					.parse(Number(rawGeneration)),
			},
		};
		if (claim.leaseClaim.leaseKey !== `${claim.projectName}-${claim.leadId}`)
			throw Error();
		context = Buffer.from(JSON.stringify(claim)).toString("base64");
	} catch {
		throw Error("founder_write_gate_absent");
	}
	async function send<T>(
		path: string,
		body: Buffer,
		mime: string,
		decode: (value: unknown) => T,
		signal?: AbortSignal,
		responseLimit = 65536,
	): Promise<T> {
		const stopped = signal
			? AbortSignal.any([signal, AbortSignal.timeout(180000)])
			: AbortSignal.timeout(180000);
		return await new Promise<T>((resolve, reject) => {
			const fail = () => reject(Error("xhs_result_unknown"));
			try {
				const req = httpRequest(
					`${origin}${path}`,
					{
						method: "POST",
						signal: stopped,
						headers: {
							authorization: `Bearer ${token}`,
							"x-flywheel-lead-context": context,
							"content-type": mime,
							"content-length": body.length,
						},
					},
					async (res) => {
						try {
							if (
								res.headers["content-type"]?.split(";")[0] !==
								"application/json"
							)
								throw Error();
							const chunks: Buffer[] = [];
							let size = 0;
							for await (const chunk of res) {
								size += chunk.length;
								if (size > responseLimit) throw Error();
								chunks.push(Buffer.from(chunk));
							}
							stopped.throwIfAborted();
							const value = parseStrictJson(
								new TextDecoder("utf-8", { fatal: true }).decode(
									Buffer.concat(chunks, size),
								),
							);
							if (res.statusCode !== 200) {
								const error = z
									.object({
										code: z.enum([
											"founder_write_gate_absent",
											"unauthorized",
											"xhs_request_invalid",
											"xhs_result_unknown",
										]),
									})
									.strict()
									.parse(value);
								if (
									(res.statusCode === 403 || res.statusCode === 503) &&
									error.code === "founder_write_gate_absent"
								) {
									reject(Error(error.code));
									return;
								}
								if (res.statusCode === 401 && error.code === "unauthorized") {
									reject(Error("founder_write_gate_absent"));
									return;
								}
								if (
									res.statusCode === 400 &&
									error.code === "xhs_request_invalid"
								) {
									reject(Error(error.code));
									return;
								}
								throw Error();
							}
							resolve(decode(value));
						} catch {
							res.destroy();
							fail();
						}
					},
				);
				req.once("error", fail);
				req.end(body);
			} catch {
				fail();
			}
		});
	}
	return Object.freeze({
		async read(action: string, input: unknown, signal?: AbortSignal) {
			let parsed: ReturnType<typeof parseXhsReadRequest>;
			try {
				parsed = parseXhsReadRequest(
					`/api/lead/xiaohongshu/read/${action}`,
					JSON.stringify(input),
				);
			} catch {
				throw Error("xhs_request_invalid");
			}
			try {
				return await send(
					`/api/lead/xiaohongshu/read/${parsed.action}`,
					Buffer.from(
						JSON.stringify({
							requestId: parsed.requestId,
							input: parsed.input,
						}),
					),
					"application/json",
					(value) => {
						const result = authorityResponseSchemas[parsed.action].parse(value);
						if (parsed.action === "get_login_qrcode") {
							const qr =
								authorityResponseSchemas.get_login_qrcode.parse(result);
							if (
								!qr.loggedIn &&
								(qr.expiresAt <= Date.now() ||
									qr.expiresAt > Date.now() + 240000)
							)
								throw Error();
						}
						return result;
					},
					signal,
					parsed.action === "get_login_qrcode" ? 540000 : 262144,
				);
			} catch {
				throw Error("xhs_read_unavailable");
			}
		},
		async call(action: string, input: unknown, signal?: AbortSignal) {
			let parsed: ReturnType<typeof parseXhsWriteRequest>;
			try {
				parsed = parseXhsWriteRequest(
					`/api/lead/xiaohongshu/write/${action}`,
					JSON.stringify(input),
				);
			} catch {
				throw Error("xhs_request_invalid");
			}
			const body = Buffer.from(
				JSON.stringify({ requestId: parsed.requestId, input: parsed.input }),
			);
			return await send(
				`/api/lead/xiaohongshu/write/${parsed.action}`,
				body,
				"application/json",
				(value) => authorityResponseSchemas[parsed.action].parse(value),
				signal,
			);
		},
		async importArtifact(
			input: Uint8Array,
			mime: string,
			signal?: AbortSignal,
		) {
			let body: Buffer,
				mimeType: ReturnType<typeof artifactSchema.shape.mimeType.parse>;
			try {
				if (
					!(input instanceof Uint8Array) ||
					input.byteLength === 0 ||
					input.byteLength > 10 * 1024 * 1024
				)
					throw Error();
				mimeType = artifactSchema.shape.mimeType.parse(mime);
				body = Buffer.from(input);
			} catch {
				throw Error("xhs_request_invalid");
			}
			const sha256 = createHash("sha256").update(body).digest("hex");
			return await send(
				"/api/lead/xiaohongshu/artifact",
				body,
				mimeType,
				(value) => {
					const result = z
						.object({
							handle: z.string().uuid(),
							mimeType: artifactSchema.shape.mimeType,
							size: z
								.number()
								.int()
								.positive()
								.max(10 * 1024 * 1024),
							sha256: z.string().regex(/^[a-f0-9]{64}$/),
						})
						.strict()
						.parse(value);
					if (
						result.sha256 !== sha256 ||
						result.size !== body.length ||
						result.mimeType !== mimeType
					)
						throw Error();
					return result;
				},
				signal,
			);
		},
	});
}
